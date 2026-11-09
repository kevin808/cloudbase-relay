"use strict";

/**
 * cloudbase-relay
 *
 * 把腾讯云开发 CloudBase 的 AI 能力包装成 OpenAI 兼容接口。
 * 设计运行环境：CloudBase 云托管（容器）。云托管内部 tcb.init({ env }) 免密，
 * 因此不需要把 secretId / secretKey 放到环境变量里。
 */

const crypto = require("crypto");
const express = require("express");
const tcb = require("@cloudbase/node-sdk");

const PORT = parseInt(process.env.PORT || "8080", 10);
const ENV_ID = process.env.TCB_ENV;

// 成长计划当前可抵扣的模型，其他模型调用不会消耗免费额度
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

if (!ENV_ID) {
  console.error("[fatal] 缺少环境变量 TCB_ENV（云开发环境 ID）");
  process.exit(1);
}
if (RELAY_KEYS.length === 0) {
  console.error(
    "[fatal] 缺少环境变量 RELAY_KEYS（逗号分隔的访问密钥）。网关不要匿名对公网开放。"
  );
  process.exit(1);
}

const tcbApp = tcb.init({ env: ENV_ID, timeout: 120000 });
const ai = tcbApp.ai();
const model = ai.createModel("cloudbase"); // 必须用 cloudbase 分组，hunyuan-v3 已废弃

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "8mb" }));

/** 恒定时间比较，避免逐字节试探 */
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

function genId() {
  return "chatcmpl-" + crypto.randomBytes(12).toString("hex");
}

/** 归一化不同版本的 usage 字段 */
function normalizeUsage(u) {
  if (!u) return undefined;
  const prompt = u.prompt_tokens ?? u.input_tokens ?? u.inputTokens;
  const completion = u.completion_tokens ?? u.output_tokens ?? u.outputTokens;
  const total = u.total_tokens ?? u.totalTokens ?? (prompt || 0) + (completion || 0);
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
    raw: u,
  };
}

/** 上游错误 → 合理的 HTTP 状态码 */
function upstreamError(err, res) {
  const msg = String((err && err.message) || err);
  const isConcurrency = /EXCEED_CONCURRENT_REQUEST_LIMIT/i.test(msg);
  const isQuota = /quota|exceed|额度|resource/i.test(msg) && !isConcurrency;
  const status = isConcurrency || isQuota ? 429 : 502;
  if (!res.headersSent) {
    res.status(status).json({
      error: {
        type: isConcurrency ? "rate_limit_error" : "upstream_error",
        code: isConcurrency ? "EXCEED_CONCURRENT_REQUEST_LIMIT" : "UPSTREAM_ERROR",
        message: msg,
      },
    });
  } else {
    res.end();
  }
}

app.get("/healthz", (_req, res) => res.json({ ok: true, env: ENV_ID }));

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
  const { model: modelName, messages, stream, temperature, max_tokens, top_p } = req.body || {};

  if (!ALLOWED_MODELS.includes(modelName)) {
    return res.status(400).json({
      error: {
        type: "invalid_request_error",
        message: `model "${modelName}" 不在允许列表内，可选：${ALLOWED_MODELS.join(", ")}`,
      },
    });
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({
      error: { type: "invalid_request_error", message: "messages 不能为空" },
    });
  }

  const params = { model: modelName, messages };
  if (typeof temperature === "number") params.temperature = temperature;
  if (typeof top_p === "number") params.top_p = top_p;
  if (typeof max_tokens === "number") params.max_tokens = max_tokens;

  const id = genId();
  const created = Math.floor(Date.now() / 1000);

  try {
    if (stream) {
      const r = await model.streamText(params);

      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders?.();

      let aborted = false;
      req.on("close", () => {
        aborted = true;
      });

      const chunk = (delta, finish = null) =>
        `data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created,
          model: modelName,
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;

      res.write(chunk({ role: "assistant" }));

      for await (const text of r.textStream) {
        if (aborted) break;
        if (text) res.write(chunk({ content: text }));
      }

      if (!aborted) {
        res.write(chunk({}, "stop"));
        res.write("data: [DONE]\n\n");
        res.end();
      } else {
        res.end();
      }
      return;
    }

    const r = await model.generateText(params);
    res.json({
      id,
      object: "chat.completion",
      created,
      model: modelName,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: r.text || "" },
          finish_reason: "stop",
        },
      ],
      usage: normalizeUsage(r.usage),
    });
  } catch (err) {
    console.error("[upstream]", err && err.message);
    upstreamError(err, res);
  }
});

app.use((_req, res) =>
  res.status(404).json({ error: { message: "only /v1/chat/completions and /v1/models" } })
);

const server = app.listen(PORT, () => {
  console.log(`[cloudbase-relay] listen :${PORT} env=${ENV_ID} models=${ALLOWED_MODELS.length}`);
});

// 流式响应可能持续很久，关闭 Node 默认的请求超时
server.requestTimeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = 120000;
