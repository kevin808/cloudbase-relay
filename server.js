"use strict";

/**
 * cloudbase-relay
 *
 * 把腾讯云开发 CloudBase 的 AI 网关（OpenAI 兼容协议）包装成自己的中转站：
 *   浏览器/客户端  ->  本服务(RELAY_KEYS 鉴权)  ->  CloudBase 网关(CLOUDBASE_APIKEY)
 *
 * 上游: https://<ENV_ID>.api.tcloudbasegateway.com/v1/ai/cloudbase
 * 不需要 secretId/secretKey，也不需要 @cloudbase/node-sdk。
 */

const crypto = require("crypto");
const { Readable } = require("stream");
const express = require("express");

const PORT = parseInt(process.env.PORT || "8080", 10);
const ENV_ID = process.env.TCB_ENV || "";

// 上游 API Key：云开发控制台 -> 环境 -> API Key
const API_KEY =
  process.env.CLOUDBASE_APIKEY || process.env.CLOUDBASE_API_KEY || "";

// 可显式覆盖；否则由 TCB_ENV 拼出来
const UPSTREAM_BASE = (
  process.env.UPSTREAM_BASE ||
  (ENV_ID ? `https://${ENV_ID}.api.tcloudbasegateway.com/v1/ai/cloudbase` : "")
).replace(/\/+$/, "");

// 成长计划当前可抵扣的模型
const DEFAULT_MODELS = [
  "hy4",
  "hy4-preview",
  "hy3",
  "deepseek-v4.1-flash",
  "deepseek-v4.1-flash-1017",
];

const ALLOWED_MODELS = (process.env.ALLOWED_MODELS || DEFAULT_MODELS.join(","))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const RELAY_KEYS = (process.env.RELAY_KEYS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const UPSTREAM_TIMEOUT_MS = parseInt(
  process.env.UPSTREAM_TIMEOUT_MS || "600000",
  10
);

if (!UPSTREAM_BASE) {
  console.error(
    "[fatal] 缺少 TCB_ENV 或 UPSTREAM_BASE，无法确定上游地址"
  );
  process.exit(1);
}
if (!API_KEY) {
  console.error("[fatal] 缺少 CLOUDBASE_APIKEY（云开发控制台 -> API Key）");
  process.exit(1);
}
if (RELAY_KEYS.length === 0) {
  console.error("[fatal] 缺少 RELAY_KEYS（逗号分隔的访问密钥）");
  process.exit(1);
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "8mb" }));

/** 恒定时间比较 */
function keyMatches(candidate) {
  const a = Buffer.from(String(candidate || ""));
  return RELAY_KEYS.some((k) => {
    const b = Buffer.from(k);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
}

function requireKey(req, res, next) {
  const raw = req.headers.authorization || "";
  const token = raw.startsWith("Bearer ") ? raw.slice(7) : req.headers["x-api-key"];
  if (!keyMatches(token)) {
    return res.status(401).json({
      error: { type: "invalid_request_error", message: "invalid api key" },
    });
  }
  next();
}

/** 只转发上游认识的字段，避免把我们的私有字段漏过去 */
function buildPayload(body) {
  const allowed = [
    "model",
    "messages",
    "stream",
    "temperature",
    "top_p",
    "max_tokens",
    "presence_penalty",
    "frequency_penalty",
    "tools",
    "tool_choice",
    "stop",
    "response_format",
  ];
  const out = {};
  for (const k of allowed) {
    if (body[k] !== undefined) out[k] = body[k];
  }
  return out;
}

app.get("/healthz", (_req, res) =>
  res.json({ ok: true, upstream: UPSTREAM_BASE, env: ENV_ID || null })
);

app.get("/v1/models", requireKey, (_req, res) => {
  res.json({
    object: "list",
    data: ALLOWED_MODELS.map((id) => ({
      id,
      object: "model",
      created: 0,
      owned_by: "cloudbase",
    })),
  });
});

app.post("/v1/chat/completions", requireKey, async (req, res) => {
  const body = req.body || {};

  if (!ALLOWED_MODELS.includes(body.model)) {
    return res.status(400).json({
      error: {
        type: "invalid_request_error",
        message: `model "${body.model}" 不在允许列表内，可选：${ALLOWED_MODELS.join(", ")}`,
      },
    });
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return res.status(400).json({
      error: { type: "invalid_request_error", message: "messages 不能为空" },
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  let upstream;
  try {
    upstream = await fetch(`${UPSTREAM_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
        Accept: body.stream ? "text/event-stream" : "application/json",
      },
      body: JSON.stringify(buildPayload(body)),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const aborted = err && err.name === "AbortError";
    console.error("[upstream]", err && err.message);
    return res.status(aborted ? 504 : 502).json({
      error: {
        type: "upstream_error",
        message: aborted ? "上游超时" : `上游请求失败: ${err.message}`,
      },
    });
  }

  // 把上游的错误原样透传，方便定位是 Key 无效 / 额度不足 / 模型未开启
  if (!upstream.ok) {
    clearTimeout(timer);
    const text = await upstream.text().catch(() => "");
    console.error("[upstream]", upstream.status, text.slice(0, 500));
    res.status(upstream.status);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.send(text || JSON.stringify({ error: { message: "upstream error" } }));
    return;
  }

  if (body.stream) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();

    const src = Readable.fromWeb(upstream.body);
    src.on("data", (c) => res.write(c));
    src.on("end", () => {
      clearTimeout(timer);
      res.end();
    });
    src.on("error", (e) => {
      clearTimeout(timer);
      console.error("[stream]", e.message);
      res.end();
    });
    req.on("close", () => {
      clearTimeout(timer);
      src.destroy();
    });
    return;
  }

  try {
    const data = await upstream.json();
    clearTimeout(timer);
    res.json(data);
  } catch (err) {
    clearTimeout(timer);
    res.status(502).json({
      error: { type: "upstream_error", message: "上游返回了非 JSON 响应" },
    });
  }
});

app.use((_req, res) =>
  res.status(404).json({
    error: { message: "only /v1/chat/completions and /v1/models" },
  })
);

const server = app.listen(PORT, () => {
  console.log(
    `[cloudbase-relay] listen :${PORT} upstream=${UPSTREAM_BASE} models=${ALLOWED_MODELS.length}`
  );
});

server.requestTimeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = 120000;
