# cloudbase-relay

一个架在 **腾讯云开发 CloudBase AI 网关** 前面的轻量中转站：对外暴露 OpenAI 兼容接口，内部把请求转发到

```
https://<ENV_ID>.api.tcloudbasegateway.com/v1/ai/cloudbase
```

所以**不需要 secretId/secretKey，不需要 `@cloudbase/node-sdk`**，也不需要腾讯云 AK/SK。只认一个 CloudBase API Key。

> 用途是把自己的多台设备 / 多个客户端收敛到一个地址、一套密钥，而不是对外售卖额度。

---

## ⚠️ 合规与计费边界（先读）

腾讯云开发《关于"小程序成长计划 AI 资源包"使用范围的专项治理公告》规定：

| 允许的来源 | 说明 |
| --- | --- |
| 小程序基础库 | `wx.cloud.extend.AI` |
| 云开发服务端 | **云函数、云托管**中的 `wx-server-sdk` / `@cloudbase/node-sdk` / `@cloudbase/js-sdk` |
| 云开发控制台 | 控制台内直接使用 |

活动细则另有一句："**AI 资源包仅限小程序和云函数中使用，其他来源均不可使用**"，并把"第三方 API、直接 HTTP 调用"列为违规类型。处理方式是：非允许来源的调用不再抵扣免费额度、改为扣套餐额度；违规环境会被**暂停 AI 资源包使用权限**。

**这对本项目意味着什么：**

- 本项目走的是 **API Key + 公网网关**，和 Cursor / Claude Code / CodeBuddy 等 AI 工具的接入方式完全一样。
- 按公告口径，这类调用**很可能不计入成长计划免费额度，而是从云开发套餐额度里扣**。判断方法：调用几次后去 [AI 模型用量](https://tcb.cloud.tencent.com/dev#/ai?tab=model-usage) 看扣的是"免费额度"还是"套餐资源点"。
- 若你的环境不是**资源点套餐**，套餐也扣不动，调用会直接失败。
- 想真正吃到那 10 亿免费 token，只有一条路：把逻辑放进**云函数 / 云托管并用 SDK 调用**（详见下文"免费额度路径"）。

本项目仅为技术示例，使用后果由使用者承担。

---

## 两条上游路径怎么选

| 上游模式 | 认证方式 | 适合 | 免费额度 |
| --- | --- | --- | --- |
| **API Key 网关**（本仓库默认） | `CLOUDBASE_APIKEY` | 任何环境，部署最简单，流式正常 | 大概率扣套餐 |
| SDK 调用（云函数内 `@cloudbase/node-sdk`） | 云函数运行时自动注入临时密钥 | 云函数 / 云托管，需自己写 SDK 调用 | ✅ 计入 |

> 注意：**云托管容器不会自动注入腾讯云临时密钥**，在云托管里直接 `tcb.init({ env })` 会报
> `missing secretId or secretKey of tencent cloud`。这就是本仓库改用 API Key 网关的原因。

---

## 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `CLOUDBASE_APIKEY` | ✅ | 云开发控制台 → 环境 → [API Key](https://tcb.cloud.tencent.com/dev#/env/apikey) |
| `RELAY_KEYS` | ✅ | 你自己定的客户端密钥，逗号分隔，例如 `sk-a1,sk-b2`。为空拒绝启动 |
| `TCB_ENV` | ⚠️ | 云开发环境 ID，用来拼上游地址。与 `UPSTREAM_BASE` 二选一 |
| `UPSTREAM_BASE` | ⚠️ | 直接指定上游地址，覆盖 `TCB_ENV` 拼接结果 |
| `ALLOWED_MODELS` | ❌ | 覆盖默认模型白名单 |
| `UPSTREAM_TIMEOUT_MS` | ❌ | 上游超时，默认 `600000` |
| `PORT` | ❌ | 默认 `8080` |

默认白名单：`hy4`、`hy4-preview`、`hy3`、`deepseek-v4.1-flash`、`deepseek-v4.1-flash-1017`。

## 本地跑

```bash
npm install
TCB_ENV=your-env-id \
CLOUDBASE_APIKEY=your-cloudbase-api-key \
RELAY_KEYS=sk-dev PORT=8080 npm start
```

```bash
curl http://127.0.0.1:8080/v1/chat/completions \
  -H "Authorization: Bearer sk-dev" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4.1-flash","messages":[{"role":"user","content":"你好"}]}'
```

自检：

```bash
curl http://127.0.0.1:8080/healthz
# {"ok":true,"upstream":"https://<env>.api.tcloudbasegateway.com/v1/ai/cloudbase","env":"<env>"}
```

## 部署

### 云托管

1. 云开发控制台 → 云托管 → 新建服务，选"代码包"或"镜像"，端口 `8080`。
2. 环境变量填 `TCB_ENV`、`CLOUDBASE_APIKEY`、`RELAY_KEYS`。
3. 打开公网访问，访问 `/healthz` 验证。

```bash
tcb run deploy --name cloudbase-relay --port 8080
```

### 自己的服务器

```bash
docker build -t cloudbase-relay .
docker run -d --name cloudbase-relay -p 8080:8080 \
  -e TCB_ENV=your-env-id \
  -e CLOUDBASE_APIKEY=your-key \
  -e RELAY_KEYS=sk-a1,sk-b2 \
  cloudbase-relay
```

## 客户端接入

```
Base URL: https://<你的域名>/v1
API Key : <RELAY_KEYS 里的任意一个>
Model   : deepseek-v4.1-flash
```

```python
from openai import OpenAI
client = OpenAI(base_url="https://<你的域名>/v1", api_key="sk-a1")
print(client.chat.completions.create(
    model="deepseek-v4.1-flash",
    messages=[{"role": "user", "content": "你好"}],
).choices[0].message.content)
```

## 排障对照表

| 现象 | 原因 |
| --- | --- |
| `missing secretId or secretKey of tencent cloud` | 用的是 SDK 模式且跑在云托管里；改用 API Key 网关 |
| `INVALID_ENV` | `TCB_ENV` 写错，或该环境未开通 API 网关 |
| 上游 401 | `CLOUDBASE_APIKEY` 无效 / 已删除 |
| 上游 403 / 额度相关报错 | 模型未在 AI 控制台开启，或套餐不是资源点套餐 |
| `EXCEED_CONCURRENT_REQUEST_LIMIT` | 上游并发超限，官方不支持提升，只能重试或换模型 |

## 免费额度路径（可选）

如果目标是**消耗成长计划的免费 token**，把调用逻辑写进云函数：

```js
const tcb = require("@cloudbase/node-sdk");
const app = tcb.init({ env: process.env.TCB_ENV }); // 云函数内免密
const model = app.ai().createModel("cloudbase");
const res = await model.generateText({ model: "deepseek-v4.1-flash", messages });
```

云函数里 `tcb.init({ env })` 能拿到运行时注入的临时密钥；云托管不能。代价是流式支持弱，只能走非流式。

## License

MIT
