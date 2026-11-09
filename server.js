"use strict";

/**
 * cloudbase-relay
 *
 * 把腾讯云开发 CloudBase 的 AI 能力包成 OpenAI 兼容接口。
 *
 * 上游一律通过 @cloudbase/node-sdk 调用（通道合法：云开发 SDK），
 * 鉴权支持两种方式：
 *   A. accessKey（= 云开发控制台的 API Key）+ serviceUrl  —— 推荐，不需要 AK/SK
 *   B. secretId/secretKey（腾讯云子账号密钥）              —— 云函数环境可不配
 *
 * 注意：直接裸 HTTP 打网关会被判成"第三方 API"通道并返回 AI_CHANNEL_NOT_ALLOWED，
 * 必须经由 SDK（它会给请求带上 X-SDK-Version 等标记头）。
 */

const crypto = require("crypto");
const express = require("express");

const PORT = parseInt(process.env.PORT || "8080", 10);
const ENV_ID = process.env.TCB_ENV || "";
const REGION = process.env.TCB_REGION || "";

/* ------------------------------------------------------------------ */
/* 上游地址                                                            */
/* ------------------------------------------------------------------ */

/**
 * SDK 的 serviceUrl 只接受"主机名"，形如：
 *   my-env-id.api.tcloudbasegateway.com
 * 协议、/v1 都由 SDK 自己拼。这里把各种写法都归一化成主机名。
 */
function normalizeServiceUrl(input) {
  if (!input) return "";
  let s = String(input).trim().replace(/^https?:\/\//i, "");
  s = s.split("/")[0]; // 去掉 path
  return s;
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
  if (API_KEY) {
    return { kind: "accessKey", accessKey: API_KEY, source: "env:CLOUDBASE_APIKEY" };
  }
  if (process.env.CLOUDBASE_SECRET_ID && process.env.CLOUDBASE_SECRET_KEY) {
    return {
      kind: "ak",
      secretId: process.env.CLOUDBASE_SECRET_ID,
      secretKey: process.env.CLOUDBASE_SECRET_KEY,
      sessionToken: process.env.CLOUDBASE_SESSION_TOKEN || undefined,
      source: "env:CLOUDBASE_SECRET_ID",
    };
  }
  if (process.env.TENCENTCLOUD_SECRETID && process.env.TENCENTCLOUD_SECRETKEY) {
    return {
      kind: "ak",
      secretId: process.env.TENCENTCLOUD_SECRETID,
      secretKey: process.env.TENCENTCLOUD_SECRETKEY,
      sessionToken: process.env.TENCENTCLOUD_SESSIONTOKEN || undefined,
      source: "env:TENCENTCLOUD_SECRETID",
    };
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
/* SDK 实例                                                            */
/* ------------------------------------------------------------------ */

let tcb = null;
function sdk() {
  if (!tcb) tcb = require("@cloudbase/node-sdk");
  return tcb;
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
    env: ENV_ID || null,
    serviceUrl: SERVICE_URL || `${ENV_ID}.api.tcloudbasegateway.com(default)`,
    credsFromEnv: Boolean(credsFromEnv()),
  })
);

app.get("/diag", requireKey, async (req, res) => {
  const raw = req.headers["x-cloudbase-context"];
  const decoded = decodeCtxHeader(raw);
  const creds = resolveCreds(req);

  const report = {
    env: ENV_ID || null,
    serviceUrl: SERVICE_URL || `${ENV_ID}.api.tcloudbasegateway.com(default)`,
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
          "拿不到凭证：配置 CLOUDBASE_APIKEY（推荐）或 CLOUDBASE_SECRET_ID/KEY，" +
          "或确认容器收到 x-cloudbase-context 头。",
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
  } catch (err) {
    const msg = String((err && err.message) || err);
    const code = (err && err.code) || "";
    console.error("[failed]", code, msg);
    if (res.headersSent) return res.end();
    if (/EXCEED_CONCURRENT_REQUEST_LIMIT/i.test(msg) || /EXCEED_CONCURRENT/.test(code)) {
      return res.status(429).json({
        error: {
          type: "rate_limit_error",
          code: "EXCEED_CONCURRENT_REQUEST_LIMIT",
          message: msg,
        },
      });
    }
    res.status(502).json({
      error: { type: "upstream_error", code: code || "UPSTREAM_ERROR", message: msg },
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
    `[cloudbase-relay] listen :${PORT} env=${ENV_ID} serviceUrl=${
      SERVICE_URL || `${ENV_ID}.api.tcloudbasegateway.com(default)`
    } auth=${API_KEY ? "accessKey" : credsFromEnv() ? "ak" : "header"}`
  );
});

server.requestTimeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = 120000;
