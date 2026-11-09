"use strict";

/**
 * cloudbase-relay
 *
 * 把腾讯云开发 CloudBase 的 AI 能力包成 OpenAI 兼容接口。
 *
 * 两种上游模式：
 *   MODE=sdk      (默认) 走 @cloudbase/node-sdk —— 只有这个通道能被"小程序成长计划"资源包抵扣
 *   MODE=gateway 走 API Key + 公网网关 —— 通道被成长计划拒绝(AI_CHANNEL_NOT_ALLOWED)，仅适合非成长计划环境
 *
 * 云托管不会自动注入 TENCENTCLOUD_SECRETID/KEY（SDK 在 CBR 环境下也禁用了自动获取），
 * 因此凭证按下面的顺序解析，见 resolveCreds()。
 */

const crypto = require("crypto");
const { Readable } = require("stream");
const express = require("express");

const PORT = parseInt(process.env.PORT || "8080", 10);
const ENV_ID = process.env.TCB_ENV || "";
const MODE = (process.env.MODE || "sdk").toLowerCase();

const UPSTREAM_BASE = (
  process.env.UPSTREAM_BASE ||
  (ENV_ID ? `https://${ENV_ID}.api.tcloudbasegateway.com/v1/ai/cloudbase` : "")
).replace(/\/+$/, "");
const API_KEY =
  process.env.CLOUDBASE_APIKEY || process.env.CLOUDBASE_API_KEY || "";

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

if (!ENV_ID && !UPSTREAM_BASE) {
  console.error("[fatal] 缺少 TCB_ENV");
  process.exit(1);
}
if (MODE === "gateway" && !API_KEY) {
  console.error("[fatal] MODE=gateway 需要 CLOUDBASE_APIKEY");
  process.exit(1);
}
if (MODE === "sdk" && !hasStaticCreds()) {
  console.warn(
    "[warn] 未配置 CLOUDBASE_SECRET_ID/KEY 或 TENCENTCLOUD_SECRETID/KEY，" +
      "将尝试从每个请求的 x-cloudbase-context 头里取临时凭证；若容器没有该头，请求会失败。"
  );
}
if (RELAY_KEYS.length === 0) {
  console.error("[fatal] 缺少 RELAY_KEYS（逗号分隔的访问密钥）");
  process.exit(1);
}

function hasStaticCreds() {
  return Boolean(
    (process.env.CLOUDBASE_SECRET_ID && process.env.CLOUDBASE_SECRET_KEY) ||
      (process.env.TENCENTCLOUD_SECRETID && process.env.TENCENTCLOUD_SECRETKEY)
  );
}

/* ------------------------------------------------------------------ */
/* 凭证解析                                                            */
/* ------------------------------------------------------------------ */

function fromEnv() {
  if (process.env.CLOUDBASE_SECRET_ID && process.env.CLOUDBASE_SECRET_KEY) {
    return {
      secretId: process.env.CLOUDBASE_SECRET_ID,
      secretKey: process.env.CLOUDBASE_SECRET_KEY,
      sessionToken: process.env.CLOUDBASE_SESSION_TOKEN || undefined,
      source: "env:CLOUDBASE_SECRET_ID",
    };
  }
  if (process.env.TENCENTCLOUD_SECRETID && process.env.TENCENTCLOUD_SECRETKEY) {
    return {
      secretId: process.env.TENCENTCLOUD_SECRETID,
      secretKey: process.env.TENCENTCLOUD_SECRETKEY,
      sessionToken: process.env.TENCENTCLOUD_SESSIONTOKEN || undefined,
      source: "env:TENCENTCLOUD_SECRETID",
    };
  }
  return null;
}

/** 云托管会把上下文放在 x-cloudbase-context 头里，格式是 base64(JSON) */
function decodeCtxHeader(value) {
  if (!value) return null;
  try {
    const json = JSON.parse(Buffer.from(value, "base64").toString("utf8"));
    return json;
  } catch {
    return null;
  }
}

/** 在任意层级里找 secretId/secretKey，兼容 environ 字符串形式 */
function pickCreds(obj, depth = 0) {
  if (!obj || depth > 4) return null;

  if (typeof obj === "string") {
    // "k1=v1;k2=v2" 形式
    const map = {};
    for (const seg of obj.split(";")) {
      const i = seg.indexOf("=");
      if (i > 0) map[seg.slice(0, i).trim()] = seg.slice(i + 1).trim();
    }
    return pickCreds(map, depth + 1);
  }
  if (typeof obj !== "object") return null;

  const id =
    obj.secretId ?? obj.secret_id ?? obj.TENCENTCLOUD_SECRETID;
  const key =
    obj.secretKey ?? obj.SecretKey ?? obj.secret_key ?? obj.TENCENTCLOUD_SECRETKEY;
  if (id && key) {
    return {
      secretId: id,
      secretKey: key,
      sessionToken:
        obj.sessionToken ??
        obj.token ??
        obj.TENCENTCLOUD_SESSIONTOKEN ??
        undefined,
      source: "header:x-cloudbase-context",
    };
  }

  for (const v of Object.values(obj)) {
    const hit = pickCreds(v, depth + 1);
    if (hit) return hit;
  }
  return null;
}

function resolveCreds(req) {
  return (
    fromEnv() ||
    pickCreds(decodeCtxHeader(req.headers["x-cloudbase-context"]))
  );
}

/* ------------------------------------------------------------------ */
/* SDK 实例缓存（按凭证指纹）                                           */
/* ------------------------------------------------------------------ */

let tcb = null;
function sdk() {
  if (!tcb) tcb = require("@cloudbase/node-sdk");
  return tcb;
}

const appCache = new Map();
const APP_TTL_MS = 10 * 60 * 1000;

function getApp(creds) {
  const fp = `${creds.secretId}:${creds.sessionToken || ""}`;
  const now = Date.now();
  const hit = appCache.get(fp);
  if (hit && now - hit.at < APP_TTL_MS) return hit.app;

  const app = sdk().init({
    env: ENV_ID,
    secretId: creds.secretId,
    secretKey: creds.secretKey,
    sessionToken: creds.sessionToken,
    timeout: 120000,
  });
  appCache.set(fp, { app, at: now });
  if (appCache.size > 32) {
    for (const [k, v] of appCache) {
      if (now - v.at > APP_TTL_MS) appCache.delete(k);
    }
  }
  return app;
}

/* ------------------------------------------------------------------ */
/* HTTP                                                               */
/* ------------------------------------------------------------------ */

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "8mb" }));

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

function sseHeaders(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();
}

function sseChunk({ id, created, model, delta, finish }) {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finish ?? null }],
  })}\n\n`;
}

function normalizeUsage(u) {
  if (!u) return undefined;
  const prompt = u.prompt_tokens ?? u.input_tokens ?? u.inputTokens;
  const completion = u.completion_tokens ?? u.output_tokens ?? u.outputTokens;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: u.total_tokens ?? u.totalTokens ?? (prompt || 0) + (completion || 0),
  };
}

app.get("/healthz", (_req, res) =>
  res.json({
    ok: true,
    mode: MODE,
    env: ENV_ID || null,
    upstream: MODE === "gateway" ? UPSTREAM_BASE : "sdk:@cloudbase/node-sdk",
    staticCreds: hasStaticCreds(),
  })
);

/**
 * 诊断接口：不打印任何密钥内容，只报告"凭证从哪来"和"SDK 调用能不能通"。
 * 部署后先打这个，比直接调 chat 更容易定位。
 */
app.get("/diag", requireKey, async (req, res) => {
  const raw = req.headers["x-cloudbase-context"];
  const decoded = decodeCtxHeader(raw);
  const creds = resolveCreds(req);

  const report = {
    mode: MODE,
    env: ENV_ID || null,
    header: {
      present: Boolean(raw),
      decodable: Boolean(decoded),
      topKeys:
        decoded && typeof decoded === "object" ? Object.keys(decoded) : [],
    },
    creds: creds
      ? { found: true, source: creds.source, hasToken: Boolean(creds.sessionToken) }
      : { found: false, source: null, hasToken: false },
  };

  if (!creds || MODE !== "sdk") {
    report.probe = { ok: false, skipped: true, error: creds ? "mode is not sdk" : "no credentials" };
    return res.json(report);
  }

  try {
    const start = Date.now();
    const r = await getApp(creds)
      .ai()
      .createModel("cloudbase")
      .generateText({
        model: ALLOWED_MODELS[0],
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 8,
      });
    report.probe = {
      ok: true,
      model: ALLOWED_MODELS[0],
      ms: Date.now() - start,
      textLength: (r.text || "").length,
      usage: normalizeUsage(r.usage),
    };
  } catch (err) {
    report.probe = { ok: false, error: String((err && err.message) || err) };
  }
  res.json(report);
});

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

/* --------------------------- SDK 模式 ------------------------------ */

async function handleSdk(req, res, body) {
  const creds = resolveCreds(req);
  if (!creds) {
    return res.status(500).json({
      error: {
        type: "config_error",
        message:
          "拿不到腾讯云凭证：请配置 CLOUDBASE_SECRET_ID/CLOUDBASE_SECRET_KEY，" +
          "或确认容器收到 x-cloudbase-context 头。",
      },
    });
  }

  const params = {
    model: body.model,
    messages: body.messages,
  };
  for (const k of ["temperature", "top_p", "max_tokens", "stop"]) {
    if (body[k] !== undefined) params[k] = body[k];
  }

  const model = getApp(creds).ai().createModel("cloudbase");
  const id = "chatcmpl-" + crypto.randomBytes(12).toString("hex");
  const created = Math.floor(Date.now() / 1000);

  if (body.stream) {
    const r = await model.streamText(params);
    sseHeaders(res);
    let aborted = false;
    req.on("close", () => {
      aborted = true;
    });
    res.write(sseChunk({ id, created, model: body.model, delta: { role: "assistant" } }));
    for await (const text of r.textStream) {
      if (aborted) break;
      if (text) res.write(sseChunk({ id, created, model: body.model, delta: { content: text } }));
    }
    if (!aborted) {
      res.write(sseChunk({ id, created, model: body.model, delta: {}, finish: "stop" }));
      res.write("data: [DONE]\n\n");
    }
    res.end();
    return;
  }

  const r = await model.generateText(params);
  res.json({
    id,
    object: "chat.completion",
    created,
    model: body.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: r.text || "" },
        finish_reason: "stop",
      },
    ],
    usage: normalizeUsage(r.usage),
  });
}

/* ------------------------- Gateway 模式 ---------------------------- */

async function handleGateway(req, res, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  const payload = {
    model: body.model,
    messages: body.messages,
  };
  for (const k of [
    "stream",
    "temperature",
    "top_p",
    "max_tokens",
    "presence_penalty",
    "frequency_penalty",
    "stop",
    "tools",
    "tool_choice",
    "response_format",
  ]) {
    if (body[k] !== undefined) payload[k] = body[k];
  }

  let upstream;
  try {
    upstream = await fetch(`${UPSTREAM_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
        Accept: body.stream ? "text/event-stream" : "application/json",
      },
      body: JSON.stringify(payload),
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
    sseHeaders(res);
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
  } catch {
    clearTimeout(timer);
    res.status(502).json({
      error: { type: "upstream_error", message: "上游返回了非 JSON 响应" },
    });
  }
}

/* ---------------------------- 路由 -------------------------------- */

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

  try {
    if (MODE === "gateway") await handleGateway(req, res, body);
    else await handleSdk(req, res, body);
  } catch (err) {
    const msg = String((err && err.message) || err);
    console.error("[failed]", msg);
    if (res.headersSent) return res.end();
    if (/EXCEED_CONCURRENT_REQUEST_LIMIT/i.test(msg)) {
      return res.status(429).json({
        error: {
          type: "rate_limit_error",
          code: "EXCEED_CONCURRENT_REQUEST_LIMIT",
          message: msg,
        },
      });
    }
    res.status(502).json({
      error: { type: "upstream_error", message: msg },
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
    `[cloudbase-relay] listen :${PORT} mode=${MODE} env=${ENV_ID || "-"} models=${ALLOWED_MODELS.length}`
  );
});

server.requestTimeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = 120000;
