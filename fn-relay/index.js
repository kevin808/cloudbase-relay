"use strict";

/**
 * fn-relay —— 部署为云函数的 AI 中转
 *
 * 调用通道：wx-server-sdk 的 cloud.ai() → 服务端 SDK（免费额度允许的来源）
 * 支持两种入站方式：
 *   1. 小程序 wx.cloud.callFunction({ name: 'relay', data: {...} })
 *   2. 云函数 HTTP 访问服务（绑定路径后从公网调用，返回 OpenAI 兼容 JSON）
 *
 * 注意：HTTP 访问服务无法稳定输出 SSE，所以这里统一走非流式；
 * 需要流式请用上一层的云托管版本（cloudbase-relay/server.js）。
 */

const cloud = require("wx-server-sdk");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
  timeout: 90000, // AI 生成较慢，别用默认 3s/20s
});

/** 成长计划当前可抵扣的模型 */
const DEFAULT_MODELS = [
  "hy4",
  "hy4-preview",
  "hy3",
  "deepseek-v4.1-flash",
  "deepseek-v4.1-flash-1017",
];

/**
 * 这些配置在每次调用时惰性读取，而不是模块加载时固化：
 * 云函数会复用热实例，改环境变量后不必等冷启动；本地测试也能改。
 */
function splitEnv(name, fallback) {
  return (process.env[name] || fallback)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function allowedModels() {
  return splitEnv("ALLOWED_MODELS", DEFAULT_MODELS.join(","));
}

/** HTTP 访问服务用的共享密钥；留空则只允许小程序 callFunction 直调 */
function relayKeys() {
  return splitEnv("RELAY_KEYS", "");
}

const MAX_MESSAGES = 100;

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function newId() {
  return (
    "chatcmpl-" +
    Math.random().toString(36).slice(2, 10) +
    Date.now().toString(36)
  );
}

function normalizeUsage(u) {
  if (!u) return undefined;
  const prompt = u.prompt_tokens ?? u.input_tokens ?? u.inputTokens;
  const completion = u.completion_tokens ?? u.output_tokens ?? u.outputTokens;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens:
      u.total_tokens ?? u.totalTokens ?? (prompt || 0) + (completion || 0),
  };
}

function timingSafeEqualStr(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * 拆解事件：HTTP 访问服务给的是 httpMethod/headers/body，
 * wx.cloud.callFunction 给的是纯对象。
 */
function parseEvent(event) {
  const isHttp = Boolean(event && (event.httpMethod || event.requestContext));

  if (!isHttp) {
    return { isHttp: false, headers: {}, body: event || {} };
  }

  let body = event.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body || "{}");
    } catch {
      body = {};
    }
  }
  return {
    isHttp: true,
    headers: event.headers || {},
    // 兼容 GET 查询参数（HTTP 访问服务会放在 queryStringParameters 里）
    body: { ...(event.queryStringParameters || {}), ...(body || {}) },
  };
}

function headerValue(headers, name) {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers || {})) {
    if (k.toLowerCase() === lower) return Array.isArray(v) ? v[0] : v;
  }
  return undefined;
}

function requireKey(ctx) {
  if (!ctx.isHttp) return null; // 小程序同环境直调，不需要共享密钥

  const keys = relayKeys();
  if (keys.length === 0) {
    return "HTTP 访问未配置 RELAY_KEYS，为避免公网裸奔已拒绝请求";
  }

  const raw = headerValue(ctx.headers, "authorization") || "";
  const token = raw.startsWith("Bearer ")
    ? raw.slice(7)
    : headerValue(ctx.headers, "x-api-key");

  const ok = keys.some((k) => timingSafeEqualStr(token || "", k));
  return ok ? null : "invalid api key";
}

function pickParams(body) {
  const params = { model: body.model, messages: body.messages };
  for (const k of ["temperature", "top_p", "max_tokens", "stop"]) {
    if (body[k] !== undefined) params[k] = body[k];
  }
  return params;
}

function validate(body) {
  if (!body.model) return "缺少 model";
  const models = allowedModels();
  if (!models.includes(body.model)) {
    return `model "${body.model}" 不在允许列表内，可选：${models.join(", ")}`;
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return "messages 不能为空";
  }
  if (body.messages.length > MAX_MESSAGES) {
    return `messages 最多 ${MAX_MESSAGES} 条`;
  }
  return null;
}

function openaiBody({ model, text, usage }) {
  return {
    id: newId(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text || "" },
        finish_reason: "stop",
      },
    ],
    usage: usage || undefined,
  };
}

/** 兼容不同版本 SDK：优先 generateText，缺失时退回 invoke */
async function callModel(modelHandle, params) {
  if (typeof modelHandle.generateText === "function") {
    return await modelHandle.generateText(params);
  }
  if (typeof modelHandle.invoke === "function") {
    return await modelHandle.invoke(params);
  }
  throw new Error("当前 wx-server-sdk 不提供 generateText/invoke，请升级到 3.0.5-beta.1+");
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

exports.main = async (event, context) => {
  const ctx = parseEvent(event);
  const body = ctx.body;

  const respond = (statusCode, payload) => {
    if (ctx.isHttp) {
      return {
        statusCode,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        },
        body: JSON.stringify(payload),
      };
    }
    return payload;
  };

  const fail = (statusCode, type, message, code) =>
    respond(statusCode, { error: { type, message, code } });

  // 健康检查
  const action = body.action || (ctx.isHttp ? undefined : undefined);
  if (action === "health" || body.health === true) {
    return respond(200, {
      ok: true,
      models: allowedModels(),
      http: ctx.isHttp,
      keyRequired: ctx.isHttp,
    });
  }

  const authError = requireKey(ctx);
  if (authError) {
    return fail(401, "invalid_request_error", authError);
  }

  const invalid = validate(body);
  if (invalid) {
    return fail(400, "invalid_request_error", invalid);
  }

  try {
    const ai = cloud.ai();
    const modelHandle = ai.createModel("cloudbase");
    const result = await callModel(modelHandle, pickParams(body));
    const payload = openaiBody({
      model: body.model,
      text: result.text,
      usage: normalizeUsage(result.usage),
    });

    if (ctx.isHttp) return respond(200, payload);
    return { success: true, ...payload };
  } catch (err) {
    const message = String((err && err.message) || err);
    console.error("[relay] failed:", message);

    if (/EXCEED_CONCURRENT_REQUEST_LIMIT/i.test(message)) {
      return fail(
        429,
        "rate_limit_error",
        message,
        "EXCEED_CONCURRENT_REQUEST_LIMIT"
      );
    }
    return fail(500, "upstream_error", message);
  }
};
