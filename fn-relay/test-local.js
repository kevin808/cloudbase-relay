/**
 * 本地桩测试：用假的 wx-server-sdk 替换真模块，验证事件拆解、鉴权、模型白名单、
 * OpenAI 响应格式和错误映射——不需要连云上环境。
 *
 * 运行：node test-local.js
 */
"use strict";

const Module = require("module");

const calls = [];
let nextError = null;
let nextText = "pong";

const fakeModel = {
  generateText: async (params) => {
    calls.push({ kind: "generateText", params });
    if (nextError) throw new Error(nextError);
    return {
      text: nextText,
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    };
  },
  // 故意不提供 invoke，验证 generateText 优先
};

const fakeCloud = {
  DYNAMIC_CURRENT_ENV: Symbol("DYNAMIC_CURRENT_ENV"),
  init: () => {},
  ai: () => ({ createModel: () => fakeModel }),
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "wx-server-sdk") return fakeCloud;
  return originalLoad.call(this, request, parent, isMain);
};

const { main } = require("./index.js");

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: Boolean(cond), detail });
}

(async () => {
  // 1. HTTP 健康检查（不需要密钥）
  let r = await main({ httpMethod: "GET", headers: {}, queryStringParameters: { action: "health" } }, {});
  check("http health", r.statusCode === 200 && JSON.parse(r.body).ok === true, r.body);

  // 2. HTTP 聊天但没配 RELAY_KEYS → 拒绝
  delete process.env.RELAY_KEYS;
  r = await main(
    {
      httpMethod: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "deepseek-v4.1-flash",
        messages: [{ role: "user", content: "hi" }],
      }),
    },
    {}
  );
  check("http without keys rejected", r.statusCode === 401, r.body);

  // 3. HTTP 配了密钥但请求没带 → 401
  process.env.RELAY_KEYS = "sk-test,sk-b";
  r = await main(
    {
      httpMethod: "POST",
      headers: {},
      body: JSON.stringify({
        model: "deepseek-v4.1-flash",
        messages: [{ role: "user", content: "hi" }],
      }),
    },
    {}
  );
  check("http missing key rejected", r.statusCode === 401, r.body);

  // 4. 带正确密钥 → 200，OpenAI 结构
  calls.length = 0;
  r = await main(
    {
      httpMethod: "POST",
      headers: { authorization: "Bearer sk-test" },
      body: JSON.stringify({
        model: "deepseek-v4.1-flash",
        messages: [{ role: "user", content: "hi" }],
      }),
    },
    {}
  );
  const parsed = JSON.parse(r.body);
  check("http ok", r.statusCode === 200, r.body);
  check("openai shape", parsed.object === "chat.completion" && parsed.choices[0].message.content === "pong", r.body);
  check("usage mapped", parsed.usage.total_tokens === 5, parsed.usage);
  check("url path not used", calls.length === 1, calls);

  // 5. 白名单外模型 → 400
  r = await main(
    {
      httpMethod: "POST",
      headers: { authorization: "Bearer sk-test" },
      body: JSON.stringify({ model: "gpt-4", messages: [{ role: "user", content: "x" }] }),
    },
    {}
  );
  check("bad model 400", r.statusCode === 400, r.body);

  // 6. messages 为空 → 400
  r = await main(
    {
      httpMethod: "POST",
      headers: { authorization: "Bearer sk-test" },
      body: JSON.stringify({ model: "deepseek-v4.1-flash", messages: [] }),
    },
    {}
  );
  check("empty messages 400", r.statusCode === 400, r.body);

  // 7. 小程序 callFunction 直调（非 HTTP）不需要密钥
  calls.length = 0;
  r = await main(
    { model: "deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }] },
    {}
  );
  check("callFunction no key needed", r.success === true && r.choices[0].message.content === "pong", r);

  // 8. 上游并发错误 → 429
  nextError = "EXCEED_CONCURRENT_REQUEST_LIMIT";
  r = await main(
    {
      httpMethod: "POST",
      headers: { authorization: "Bearer sk-test" },
      body: JSON.stringify({
        model: "deepseek-v4.1-flash",
        messages: [{ role: "user", content: "hi" }],
      }),
    },
    {}
  );
  check("concurrency 429", r.statusCode === 429, r.body);

  // 9. 其它上游错误 → 500
  nextError = "model not enabled";
  r = await main(
    {
      httpMethod: "POST",
      headers: { authorization: "Bearer sk-test" },
      body: JSON.stringify({
        model: "deepseek-v4.1-flash",
        messages: [{ role: "user", content: "hi" }],
      }),
    },
    {}
  );
  check("other error 500", r.statusCode === 500, r.body);

  // 10. 参数透传（temperature / max_tokens）
  nextError = null;
  calls.length = 0;
  await main(
    {
      httpMethod: "POST",
      headers: { authorization: "Bearer sk-test" },
      body: JSON.stringify({
        model: "deepseek-v4.1-flash",
        messages: [{ role: "user", content: "hi" }],
        temperature: 0.3,
        max_tokens: 64,
      }),
    },
    {}
  );
  check(
    "params passthrough",
    calls[0].params.temperature === 0.3 && calls[0].params.max_tokens === 64,
    calls[0]
  );

  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : "\n      " + JSON.stringify(r.detail)}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
