"use strict";

/**
 * 容器版 OpenAI 兼容中转网关
 *
 * 上游通过官方 SDK 调用，走 SDK 通道（该通道才会被上游的免费额度抵扣）。
 * 裸 HTTP 直连网关会被判定为第三方通道并返回 AI_CHANNEL_NOT_ALLOWED。
 *
 * 鉴权优先级（自动探测）：
 *   1. SECRET_ID / SECRET_KEY          签名调用（推荐）
 *   2. 运行时注入的临时密钥              自动探测
 *   3. API_KEY                          无需密钥对时的备选
 *   4. 请求头里携带的临时凭证            兜底
 */

const crypto = require("crypto");
const express = require("express");

const PORT = parseInt(process.env.PORT || "8080", 10);
const LOG_REQUESTS = process.env.RELAY_LOG !== "0";
const HEALTH_DETAIL = process.env.RELAY_HEALTH_DETAIL || "0";

// 环境标识：可选，仅透传给 SDK，不填也能正常工作
const ENV_ID = process.env.ENV_ID || process.env.TCB_ENV || "";
const REGION = process.env.REGION || process.env.TCB_REGION || "";

/* ------------------------------------------------------------------ */
/* 上游地址                                                            */
/* ------------------------------------------------------------------ */

/**
 * SDK 内部会把 serviceUrl 拼成 "<protocol>://<serviceUrl>/v1"，
 * 再自己加上 "/ai/<provider>" 和 "/chat/completions"。
 * 所以 serviceUrl 只接受主机名，多带路径就会拼错。
 *
 * 这里允许直接填完整 URL（例如 https://host/v1/ai/cloudbase），
 * 自动拆出协议、主机名和 provider，也兼容只填主机名的写法。
 */
function parseUpstream(input) {
  if (!input) return null;
  let s = String(input).trim();
  if (!s) return null;

  let protocol = "https";
  const pm = s.match(/^(https?):\/\//i);
  if (pm) {
    protocol = pm[1].toLowerCase();
    s = s.slice(pm[0].length);
  }

  const parts = s.split("/");
  const host = (parts.shift() || "").trim();
  if (!host) return null;
  const path = "/" + parts.join("/");

  // 从 /v1/ai/<provider> 里取 provider，取不到就用默认值
  let provider = "cloudbase";
  const providerMatch = path.match(/\/v1\/ai\/([a-z0-9_.-]+)/i);
  if (providerMatch) provider = providerMatch[1];

  return { protocol, host, path, provider };
}

// 唯一必填的连接项：上游地址。完整 URL 或主机名都可以。
const UPSTREAM = parseUpstream(
  process.env.UPSTREAM_URL ||
    process.env.UPSTREAM_HOST ||
    process.env.CLOUDBASE_SERVICE_URL ||
    process.env.UPSTREAM_BASE ||
    ""
);
const SERVICE_URL = UPSTREAM ? UPSTREAM.host : "";
const PROVIDER = UPSTREAM ? UPSTREAM.provider : "cloudbase";
const PROTOCOL = UPSTREAM ? UPSTREAM.protocol : "https";

/** 规范化后的上游地址，仅用于展示，不含任何密钥 */
function upstreamDisplay() {
  return `${PROTOCOL}://${SERVICE_URL}/v1/ai/${PROVIDER}`;
}

const API_KEY =
  process.env.API_KEY ||
  process.env.CLOUDBASE_APIKEY ||
  process.env.CLOUDBASE_API_KEY ||
  "";

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

if (!SERVICE_URL) {
  console.error(
    "[fatal] 缺少 UPSTREAM_URL：填完整地址（例如 https://host/v1/ai/cloudbase）或只填主机名"
  );
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
  // 1. 显式密钥对（推荐）
  const sid = process.env.SECRET_ID || process.env.CLOUDBASE_SECRET_ID;
  const skey = process.env.SECRET_KEY || process.env.CLOUDBASE_SECRET_KEY;
  if (sid && skey) {
    return {
      kind: "ak",
      secretId: sid,
      secretKey: skey,
      sessionToken: process.env.SESSION_TOKEN || process.env.CLOUDBASE_SESSION_TOKEN || undefined,
      source: "env:SECRET_ID",
    };
  }
  // 2. 运行时注入的临时密钥（云函数常见，云托管一般没有）
  if (process.env.TENCENTCLOUD_SECRETID && process.env.TENCENTCLOUD_SECRETKEY) {
    return {
      kind: "ak",
      secretId: process.env.TENCENTCLOUD_SECRETID,
      secretKey: process.env.TENCENTCLOUD_SECRETKEY,
      sessionToken: process.env.TENCENTCLOUD_SESSIONTOKEN || undefined,
      source: "env:runtime",
    };
  }
  // 3. 云开发 API Key
  if (API_KEY) {
    return { kind: "accessKey", accessKey: API_KEY, source: "env:API_KEY" };
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
  const cfg = { timeout: 120000 };
  if (ENV_ID) cfg.env = ENV_ID;
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

const USAGE_KEYS = [
  "prompt_tokens",
  "completion_tokens",
  "total_tokens",
  "input_tokens",
  "output_tokens",
];

function normalizeUsage(u) {
  if (!u || typeof u !== "object") return undefined;
  const prompt = u.prompt_tokens ?? u.input_tokens ?? u.inputTokens;
  const completion = u.completion_tokens ?? u.output_tokens ?? u.outputTokens;
  const total = u.total_tokens ?? u.totalTokens ?? (prompt || 0) + (completion || 0);
  if (prompt == null && completion == null && total == null) return undefined;
  return {
    prompt_tokens: prompt ?? 0,
    completion_tokens: completion ?? 0,
    total_tokens: total ?? 0,
  };
}

function isZeroUsage(u) {
  return !u || (!u.prompt_tokens && !u.completion_tokens && !u.total_tokens);
}

/** 从 SDK 的 rawResponses 里兜底翻出 usage（上游字段名可能不统一） */
function usageFromRaw(list) {
  const seen = new Set();
  const walk = (o, depth) => {
    if (!o || typeof o !== "object" || depth > 5) return null;
    if (seen.has(o)) return null;
    seen.add(o);
    if (USAGE_KEYS.some((k) => typeof o[k] === "number")) return o;
    for (const v of Object.values(o)) {
      const hit = walk(v, depth + 1);
      if (hit) return hit;
    }
    return null;
  };
  for (const r of Array.isArray(list) ? list : [list]) {
    const hit = walk(r, 0);
    if (hit) return hit;
  }
  return null;
}

/** 依次尝试多个来源，取第一个非零的 usage */
function resolveUsage(candidates) {
  let fallback;
  for (const c of candidates) {
    const u = normalizeUsage(c);
    if (!u) continue;
    if (!isZeroUsage(u)) return u;
    fallback = fallback || u;
  }
  return fallback;
}

/**
 * DSML 兜底过滤：DeepSeek 偶发把原生工具调用格式写进 content。
 * 同时覆盖单竖线 ｜ 与双竖线 ‖ 两种变体（两者视觉几乎一致，必须按字节匹配）。
 * 命中后截断到标记之前，返回 {text, leaked}。
 */
const DSML_PATTERN = /<\/?[｜|‖]{1,2}(?:DSML[｜|‖]{1,2})?(?:tool[｜|‖]{1,2}calls|tool_calls|invoke|parameter)[^>]*>?/;

function stripDsml(text) {
  if (typeof text !== "string" || !text) return { text: text || "", leaked: false };
  const m = text.match(DSML_PATTERN);
  if (!m) return { text, leaked: false };
  if (LOG_REQUESTS) console.warn("[dsml] 检测到工具格式泄漏到 content，已截断");
  return { text: text.slice(0, m.index).replace(/\s+$/, ""), leaked: true };
}

/**
 * 流式 DSML 过滤器（跨 chunk）。
 * 标记可能被 chunk 边界切开（例如 "<" 在上一帧，"‖DSML‖…" 在下一帧），
 * 所以不能逐帧独立匹配。这里维护一个缓冲区：
 *   - 缓冲区里可能是标记开头的尾部，先扣住，等下一帧再判定；
 *   - 一旦确认命中 DSML，之后的所有 content 都屏蔽。
 * push(text) 返回本次可以安全输出的文本；flush() 在流结束时取回剩余安全文本。
 */
function createDsmlStreamFilter() {
  let buf = "";
  let blocked = false;
  let leaked = false;

  // 一个以 "<" 开头、尚未闭合的片段，可能是某个标记的前缀
  const HOLD_RE = /<\/?[｜|‖]{0,2}(?:D(?:S(?:M(?:L)?)?)?)?[^>]*$/;

  return {
    get leaked() {
      return leaked;
    },
    push(text) {
      if (blocked || !text) return "";
      buf += text;

      const m = buf.match(DSML_PATTERN);
      if (m) {
        blocked = true;
        leaked = true;
        const safe = buf.slice(0, m.index).replace(/\s+$/, "");
        buf = "";
        if (LOG_REQUESTS) console.warn("[dsml] 流式检测到工具格式泄漏，已截断后续 content");
        return safe;
      }

      // 末尾若像标记的前缀，扣住这部分，其余可以输出
      const hold = buf.match(HOLD_RE);
      if (hold) {
        const safe = buf.slice(0, hold.index);
        buf = buf.slice(hold.index);
        return safe;
      }
      const out = buf;
      buf = "";
      return out;
    },
    flush() {
      if (blocked) return "";
      const rest = buf;
      buf = "";
      // 流结束时仍扣住的内容：若完整匹配则截断，否则原样放行
      const m = rest.match(DSML_PATTERN);
      if (m) {
        leaked = true;
        return rest.slice(0, m.index).replace(/\s+$/, "");
      }
      return rest;
    },
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

/**
 * 健康检查：默认只回 {"ok":true}，不在公网暴露上游域名。
 * 需要看详细信息（上游地址、鉴权方式、模型数）时设 RELAY_HEALTH_DETAIL=1。
 */
app.get("/healthz", (_req, res) => {
  if (HEALTH_DETAIL !== "1") return res.json({ ok: true });

  const auth = credsFromEnv();
  res.json({
    ok: true,
    upstream: upstreamDisplay(),
    sdk: sdkVersion,
    auth: auth ? auth.kind : "header-only",
    models: ALLOWED_MODELS.length,
  });
});

/** 自检：不输出密钥值，只报告来源，并真跑一次最小模型调用 */
app.get("/diag", requireKey, async (req, res) => {
  const raw = req.headers["x-cloudbase-context"];
  const decoded = decodeCtxHeader(raw);
  const creds = resolveCreds(req);

  const report = {
    upstream: upstreamDisplay(),
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
      .createModel(PROVIDER)
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
      usage: resolveUsage([r.usage, usageFromRaw(r.rawResponses)]),
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
          "拿不到凭证：配置 SECRET_ID/SECRET_KEY（推荐）或 API_KEY。",
      },
    });
  }

  const params = { model: body.model, messages: body.messages };
  for (const k of ["temperature", "top_p", "max_tokens", "stop"]) {
    if (body[k] !== undefined) params[k] = body[k];
  }
  // 工具定义必须透传：否则上游不知道有工具，模型会把原生工具格式（DSML）写进 content
  for (const k of ["tools", "tool_choice", "parallel_tool_calls"]) {
    if (body[k] !== undefined) params[k] = body[k];
  }
  // SDK 不会主动要 usage，这里透传给上游，最后一帧才会带 token 统计
  if (body.stream) {
    params.stream_options = body.stream_options || { include_usage: true };
  }

  const id = "chatcmpl-" + crypto.randomBytes(12).toString("hex");
  const created = Math.floor(Date.now() / 1000);
  const model = getApp(creds).ai().createModel(PROVIDER);

  try {
    if (body.stream) {
      // 走底层 doStream，不经过 ReactModel：ReactModel 会自动执行工具循环，
      // 且只暴露 textStream，会丢掉 delta.tool_calls。这里直接读原始 chunk。
      const simple = getApp(creds).ai().createModel(PROVIDER).model;
      let upstream;
      try {
        upstream = await simple.doStream(params);
      } catch (e) {
        // 个别上游不认 stream_options，退回不带 usage 的请求，别为此整条链路失败
        const msg = String((e && e.message) || e);
        if (params.stream_options && /stream_options|400|invalid/i.test(msg)) {
          console.warn("[warn] 上游拒绝了 stream_options，改用不带 usage 的流式请求");
          delete params.stream_options;
          upstream = await simple.doStream(params);
        } else {
          throw e;
        }
      }
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

      const dsml = createDsmlStreamFilter();
      const emit = (delta, finish) => {
        if (aborted) return;
        res.write(sseChunk({ id, created, model: body.model, delta, finish }));
      };

      emit({ role: "assistant" });

      let sawToolCalls = false;
      let chunkCount = 0;
      let finishReason = null;
      let lastUsage;

      for await (const chunk of upstream) {  // doStream 直接返回异步流
        if (aborted) break;
        chunkCount++;
        const choice = (chunk && chunk.choices && chunk.choices[0]) || {};
        const delta = choice.delta || {};

        // 文本：经过跨 chunk 的 DSML 过滤
        if (typeof delta.content === "string" && delta.content) {
          const safe = dsml.push(delta.content);
          if (safe) emit({ content: safe });
        }

        // 工具调用：结构化字段，原样转发，不做过滤
        if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) {
          sawToolCalls = true;
          emit({ tool_calls: delta.tool_calls });
        }

        if (choice.finish_reason) finishReason = choice.finish_reason;
        if (chunk && chunk.usage) lastUsage = chunk.usage;
      }

      if (!aborted && chunkCount === 0) {
        // 上游给了流却一个 chunk 都没有：这是异常，不能伪装成正常的空回复
        console.error("[stream] 上游流为空（0 个 chunk）");
        res.write(`data: ${JSON.stringify({ error: { message: "upstream stream empty" } })}\n\n`);
        res.end();
        return;
      }

      // 流结束：把过滤器里扣住的尾部放行
      const tail = dsml.flush();
      if (tail && !aborted) emit({ content: tail });

      if (!aborted) {
        const reason = sawToolCalls ? "tool_calls" : finishReason || "stop";
        emit({}, reason);

        const usage = resolveUsage([lastUsage, usageFromRaw(lastUsage)]);
        if (usage && !isZeroUsage(usage)) {
          res.write(
            `data: ${JSON.stringify({
              id,
              object: "chat.completion.chunk",
              created,
              model: body.model,
              choices: [],
              usage,
            })}\n\n`
          );
        }
        res.write("data: [DONE]\n\n");
      }
      res.end();
      if (LOG_REQUESTS) {
        console.log(
          `[chat] stream done abort=${aborted} tools=${sawToolCalls ? "yes" : "no"} ` +
            `leak=${dsml.leaked} total=${Date.now() - startedAt}ms`
        );
      }
      return;
    }

    // 直接走底层 doGenerate，不经过 SDK 的 ReactModel：后者会自动执行工具循环，
    // 而工具应由客户端执行。这里保留上游原始 choices，tool_calls 原样回传。
    const raw = await getApp(creds).ai().createModel(PROVIDER).model.doGenerate(params);
    const upstreamChoice = (raw.choices && raw.choices[0]) || {};
    const upstreamMsg = upstreamChoice.message || {};

    const hasToolCalls = Array.isArray(upstreamMsg.tool_calls) && upstreamMsg.tool_calls.length > 0;
    const cleaned = stripDsml(upstreamMsg.content || "");

    if (LOG_REQUESTS) {
      console.log(
        `[chat] model=${body.model} auth=${creds.kind} tools=${hasToolCalls ? "yes" : "no"} ` +
          `total=${Date.now() - startedAt}ms`
      );
    }

    const message = { role: "assistant", content: cleaned.text || null };
    if (hasToolCalls) message.tool_calls = upstreamMsg.tool_calls;

    const usage = resolveUsage([raw.usage, usageFromRaw(raw.rawResponse)]);
    const payload = {
      id,
      object: "chat.completion",
      created,
      model: body.model,
      choices: [
        {
          index: 0,
          message,
          finish_reason: hasToolCalls ? "tool_calls" : upstreamChoice.finish_reason || "stop",
        },
      ],
    };
    // 拿不到真实统计时宁可不返回，也不要给客户端一个假的 0
    if (usage && !isZeroUsage(usage)) payload.usage = usage;
    res.json(payload);
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
    `[relay] listen :${PORT} upstream=${
      HEALTH_DETAIL === "1" ? upstreamDisplay() : SERVICE_URL
    } sdk=${sdkVersion} ` +
      `auth=${auth ? auth.kind : "header-only"} ` +
      `models=${ALLOWED_MODELS.length}`
  );
  if (PROTOCOL === "http") {
    console.warn("[warn] 上游协议为 http，但 SDK 固定使用 https，请改用 https 地址");
  }
  if (!auth) {
    console.warn(
      "[warn] 未配置 SECRET_ID/SECRET_KEY 或 API_KEY，" +
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
