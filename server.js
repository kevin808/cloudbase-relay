"use strict";

/**
 * cloudbase-relay —— 云托管（CloudBase Run）版
 *
 * 把腾讯云开发 CloudBase 的 AI 能力包成 OpenAI 兼容接口。
 * 上游一律通过 @cloudbase/node-sdk 调用 —— 这条通道才会被"小程序成长计划"资源包抵扣。
 * 裸 HTTP 直连网关会被判定为第三方通道并返回 AI_CHANNEL_NOT_ALLOWED。
 *
 * 鉴权优先级（自动探测）：
 *   1. CLOUDBASE_SECRET_ID / CLOUDBASE_SECRET_KEY   腾讯云子账号密钥（推荐，签名调用）
 *   2. TENCENTCLOUD_SECRETID / TENCENTCLOUD_SECRETKEY 运行时注入的临时密钥
 *   3. CLOUDBASE_APIKEY                              云开发控制台 API Key
 *   4. 请求头 x-cloudbase-context 中的临时凭证        兜底
 */

const crypto = require("crypto");
const express = require("express");

const PORT = parseInt(process.env.PORT || "8080", 10);
const ENV_ID = process.env.TCB_ENV || "";
const REGION = process.env.TCB_REGION || "";
const LOG_REQUESTS = process.env.RELAY_LOG !== "0";

/* ------------------------------------------------------------------ */
/* 上游地址                                                            */
/* ------------------------------------------------------------------ */

/**
 * SDK 的 serviceUrl 只接受主机名（形如 xxx.api.tcloudbasegateway.com），
 * 协议和 /v1 路径由 SDK 自己拼。这里把各种写法归一化。
 */
function normalizeServiceUrl(input) {
  if (!input) return "";
  return String(input)
    .trim()
    .replace(/^https?:\/\//i, "")
    .split("/")[0];
}

const SERVICE_URL = normalizeServiceUrl(
  process.env.CLOUDBASE_SERVICE_URL || process.env.UPSTREAM_BASE || ""
);

const API_KEY =
  process.env.CLOUDBASE_APIKEY || process.env.CLOUDBASE_API_KEY || "";

/* ------------------------------------------------------------------ */
/* 模型白名单                                                          */
/* ------------------------------------------------------------------ */

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
  console.error("[fatal] 缺少 RELAY_KEYS（逗号分隔的访问密钥）");
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* 凭证                                                                */
/* ------------------------------------------------------------------ */

function credsFromEnv() {
  // 1. 显式子账号密钥
  if (process.env.CLOUDBASE_SECRET_ID && process.env.CLOUDBASE_SECRET_KEY) {
    return {
      kind: "ak",
      secretId: process.env.CLOUDBASE_SECRET_ID,
      secretKey: process.env.CLOUDBASE_SECRET_KEY,
      sessionToken: process.env.CLOUDBASE_SESSION_TOKEN || undefined,
      source: "env:CLOUDBASE_SECRET_ID",
    };
  }
  // 2. 运行时注入的临时密钥（云函数常见，云托管一般没有）
  if (process.env.TENCENTCLOUD_SECRETID && process.env.TENCENTCLOUD_SECRETKEY) {
    return {
      kind: "ak",
      secretId: process.env.TENCENTCLOUD_SECRETID,
      secretKey: process.env.TENCENTCLOUD_SECRETKEY,
      sessionToken: process.env.TENCENTCLOUD_SESSIONTOKEN || undefined,
      source: "env:TENCENTCLOUD_SECRETID",
    };
  }
  // 3. 云开发 API Key
  if (API_KEY) {
    return { kind: "accessKey", accessKey: API_KEY, source: "env:CLOUDBASE_APIKEY" };
  }
  return null;
}

function decodeCtxHeader(value) {
  if (!value) return null;
  try {
    return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

/** 在任意层级里找凭证，兼容 environ 的 "k=v;k=v" 字符串形式 */
function pickCreds(obj, depth = 0) {
  if (!obj || depth > 4) return null;

  if (typeof obj === "string") {
    const map = {};
    for (const seg of obj.split(";")) {
      const i = seg.indexOf("=");
      if (i > 0) map[seg.slice(0, i).trim()] = seg.slice(i + 1).trim();
    }
    return pickCreds(map, depth + 1);
  }
  if (typeof obj !== "object") return null;

  const id = obj.secretId ?? obj.secret_id ?? obj.TENCENTCLOUD_SECRETID;
  const key =
    obj.secretKey ?? obj.secret_key ?? obj.SecretKey ?? obj.TENCENTCLOUD_SECRETKEY;
  if (id && key) {
    return {
      kind: "ak",
      secretId: id,
      secretKey: key,
      sessionToken:
        obj.sessionToken ?? obj.token ?? obj.TENCENTCLOUD_SESSIONTOKEN ?? undefined,
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
  return credsFromEnv() || pickCreds(decodeCtxHeader(req.headers["x-cloudbase-context"]));
}

/* ------------------------------------------------------------------ */
/* SDK                                                                 */
/* ------------------------------------------------------------------ */

let tcb = null;
function sdk() {
  if (!tcb) tcb = require("@cloudbase/node-sdk");
  return tcb;
}

let sdkVersion = "unknown";
try {
  sdkVersion = require("@cloudbase/node-sdk/package.json").version;
} catch {
  /* ignore */
}

function buildConfig(creds) {
  const cfg = { env: ENV_ID, timeout: 120000 };
  if (creds.accessKey) cfg.accessKey = creds.accessKey;
  if (creds.secretId) {
    cfg.secretId = creds.secretId;
    cfg.secretKey = creds.secretKey;
    if (creds.sessionToken) cfg.sessionToken = creds.sessionToken;
  }
  if (SERVICE_URL) cfg.serviceUrl = SERVICE_URL;
  if (REGION) cfg.region = REGION;
  return cfg;
}

const appCache = new Map();
const APP_TTL_MS = 10 * 60 * 1000;

function getApp(creds) {
  const fp = `${creds.kind}:${creds.accessKey || creds.secretId}:${creds.sessionToken || ""}`;
  const now = Date.now();
  const hit = appCache.get(fp);
  if (hit && now - hit.at < APP_TTL_MS) return hit.app;

  const app = sdk().init(buildConfig(creds));
  appCache.set(fp, { app, at: now });
  if (appCache.size > 32) {
    for (const [k, v] of appCache) if (now - v.at > APP_TTL_MS) appCache.delete(k);
  }
  return app;
}

/* ------------------------------------------------------------------ */
/* HTTP 工具                                                           */
/* ------------------------------------------------------------------ */

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);
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

/** 上游异常映射：并发超限 → 429，其余 → 502 */
function sendUpstreamError(res, err) {
  const msg = String((err && err.message) || err);
  const code = (err && err.code) || "";
  console.error("[upstream]", code, msg);
  if (res.headersSent) return res.end();

  if (/EXCEED_CONCURRENT/i.test(msg) || /EXCEED_CONCURRENT/i.test(code)) {
    return res.status(429).json({
      error: {
        type: "rate_limit_error",
        code: "EXCEED_CONCURRENT_REQUEST_LIMIT",
        message: msg,
      },
    });
  }
  if (/AI_CHANNEL_NOT_ALLOWED/i.test(code) || /AI_CHANNEL_NOT_ALLOWED/i.test(msg)) {
    return res.status(403).json({
      error: {
        type: "channel_error",
        code: "AI_CHANNEL_NOT_ALLOWED",
        message: msg,
      },
    });
  }
  res.status(502).json({
    error: { type: "upstream_error", code: code || "UPSTREAM_ERROR", message: msg },
  });
}

/* ------------------------------------------------------------------ */
/* 路由                                                                */
/* ------------------------------------------------------------------ */

/**
 * 云托管的默认健康检查常常打 "/"，返回 200 才能通过。
 * 这里不暴露任何密钥信息。
 */
const rootHandler = (_req, res) =>
  res.status(200).json({
    ok: true,
    service: "cloudbase-relay",
    endpoints: ["/v1/models", "/v1/chat/completions", "/healthz", "/diag"],
  });
app.get("/", rootHandler);
app.head("/", rootHandler);

app.get("/healthz", (_req, res) =>
  res.json({
    ok: true,
    env: ENV_ID || null,
    serviceUrl: SERVICE_URL || `${ENV_ID}.api.tcloudbasegateway.com(default)`,
    sdk: sdkVersion,
    auth: credsFromEnv() ? credsFromEnv().kind : "header-only",
    models: ALLOWED_MODELS.length,
  })
);

/** 自检：不输出密钥值，只报告来源，并真跑一次最小模型调用 */
app.get("/diag", requireKey, async (req, res) => {
  const raw = req.headers["x-cloudbase-context"];
  const decoded = decodeCtxHeader(raw);
  const creds = resolveCreds(req);

  const report = {
    env: ENV_ID || null,
    serviceUrl: SERVICE_URL || `${ENV_ID}.api.tcloudbasegateway.com(default)`,
    sdk: sdkVersion,
    header: {
      present: Boolean(raw),
      decodable: Boolean(decoded),
      topKeys: decoded && typeof decoded === "object" ? Object.keys(decoded) : [],
    },
    creds: creds
      ? { found: true, kind: creds.kind, source: creds.source }
      : { found: false, kind: null, source: null },
  };

  if (!creds) {
    report.probe = { ok: false, error: "no credentials" };
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
    report.probe = {
      ok: false,
      error: String((err && err.message) || err),
      code: (err && err.code) || null,
    };
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

app.post("/v1/chat/completions", requireKey, async (req, res) => {
  const startedAt = Date.now();
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

  const creds = resolveCreds(req);
  if (!creds) {
    return res.status(500).json({
      error: {
        type: "config_error",
        message:
          "拿不到凭证：配置 CLOUDBASE_SECRET_ID/CLOUDBASE_SECRET_KEY（推荐）或 CLOUDBASE_APIKEY。",
      },
    });
  }

  const params = { model: body.model, messages: body.messages };
  for (const k of ["temperature", "top_p", "max_tokens", "stop"]) {
    if (body[k] !== undefined) params[k] = body[k];
  }

  const id = "chatcmpl-" + crypto.randomBytes(12).toString("hex");
  const created = Math.floor(Date.now() / 1000);
  const model = getApp(creds).ai().createModel("cloudbase");

  try {
    if (body.stream) {
      const r = await model.streamText(params);
      if (LOG_REQUESTS) {
        console.log(
          `[chat] stream model=${body.model} auth=${creds.kind} ttfb=${Date.now() - startedAt}ms`
        );
      }
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
      if (LOG_REQUESTS) {
        console.log(`[chat] stream done abort=${aborted} total=${Date.now() - startedAt}ms`);
      }
      return;
    }

    const r = await model.generateText(params);
    if (LOG_REQUESTS) {
      console.log(
        `[chat] model=${body.model} auth=${creds.kind} total=${Date.now() - startedAt}ms`
      );
    }
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
  } catch (err) {
    sendUpstreamError(res, err);
  }
});

app.use((_req, res) =>
  res.status(404).json({
    error: { message: "only /v1/chat/completions and /v1/models" },
  })
);

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

const server = app.listen(PORT, () => {
  const auth = credsFromEnv();
  console.log(
    `[cloudbase-relay] listen :${PORT} env=${ENV_ID} sdk=${sdkVersion} ` +
      `serviceUrl=${SERVICE_URL || "default"} auth=${auth ? auth.kind : "header-only"} ` +
      `models=${ALLOWED_MODELS.length}`
  );
  if (!auth) {
    console.warn(
      "[warn] 未配置 CLOUDBASE_SECRET_ID/KEY 或 CLOUDBASE_APIKEY，" +
        "只能依赖请求头 x-cloudbase-context 里的临时凭证。"
    );
  }
});

// 流式响应可能持续很久，关掉 Node 默认超时
server.requestTimeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = 120000;

function shutdown(signal) {
  console.log(`[cloudbase-relay] ${signal} received, closing server`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
