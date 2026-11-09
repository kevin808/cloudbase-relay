# cloudbase-relay

架在腾讯云开发 **CloudBase AI** 前面的 OpenAI 兼容中转站：对外暴露 `/v1/chat/completions`（含 SSE 流式），内部一律通过 **`@cloudbase/node-sdk`** 调用模型。

## 为什么必须走 SDK

成长计划资源包只认两个通道：小程序基础库、云开发 SDK。用 API Key **裸 HTTP** 打
`https://<env>.api.tcloudbasegateway.com/v1/ai/cloudbase` 会被判成第三方通道：

```json
{"code":"AI_CHANNEL_NOT_ALLOWED","message":"小程序成长计划仅支持小程序 SDK 和云开发 SDK 调用"}
```

而同样的 API Key 交给 SDK，请求会多带三个标记头，通道判定就变成"云开发 SDK"：

```
X-SDK-Version: tcb-node-sdk/3.18.7
User-Agent:    tcb-node-sdk/3.18.7
X-TCB-Source:  ...
Authorization: Bearer <CLOUDBASE_APIKEY>
POST /v1/ai/cloudbase/chat/completions
```

以下是本地抓包实测到的请求（假网关），可作为对照：

```
POST /v1/ai/cloudbase/chat/completions
x-sdk-version: tcb-node-sdk/3.18.7
authorization: Bearer <api-key>
body: {"model":"deepseek-v4.1-flash","messages":[...],"stream":true}
```

**结论：不要自己拼 HTTP 调网关，让 SDK 去发。**

---

## 鉴权方式（二选一）

| 方式 | 环境变量 | 适合 | 说明 |
| --- | --- | --- | --- |
| **API Key**（推荐） | `CLOUDBASE_APIKEY` | 云托管 / 自有服务器 | 控制台 → 环境 → [API Key](https://tcb.cloud.tencent.com/dev#/env/apikey)，不用碰 AK/SK |
| 子账号 AK/SK | `CLOUDBASE_SECRET_ID` + `CLOUDBASE_SECRET_KEY` | 需要按 CAM 权限细粒度控制 | 长期密钥，注意保管 |

还有一条兜底：若容器请求里带 `x-cloudbase-context` 头，会自动解析其中的临时凭证。

## 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `TCB_ENV` | ✅ | 云开发环境 ID |
| `RELAY_KEYS` | ✅ | 客户端密钥，逗号分隔；为空拒绝启动 |
| `CLOUDBASE_APIKEY` | 推荐 | 云开发控制台 API Key |
| `CLOUDBASE_SECRET_ID` / `CLOUDBASE_SECRET_KEY` | 可选 | 子账号密钥，与 API Key 二选一 |
| `CLOUDBASE_SERVICE_URL` | ❌ | 自定义网关主机名，默认 `<TCB_ENV>.api.tcloudbasegateway.com`；**只填主机名，不带 https:// 和路径** |
| `TCB_REGION` | ❌ | 默认 `ap-shanghai` |
| `ALLOWED_MODELS` | ❌ | 覆盖模型白名单 |
| `PORT` | ❌ | 默认 `8080` |

默认白名单：`hy4`、`hy4-preview`、`hy3`、`deepseek-v4.1-flash`、`deepseek-v4.1-flash-1017`。

## 部署（云托管）

环境变量：

```
TCB_ENV=<你的环境ID>
CLOUDBASE_APIKEY=<云开发 API Key>
RELAY_KEYS=sk-xxxx,sk-yyyy
```

端口 `8080`，重新部署。**不需要 `@cloudbase/node-sdk` 之外的任何密钥。**

## 自检

```bash
curl https://<你的域名>/diag -H "Authorization: Bearer sk-xxxx"
```

正常通过：

```json
{
  "env": "xxx-123",
  "serviceUrl": "xxx-123.api.tcloudbasegateway.com(default)",
  "creds": { "found": true, "kind": "accessKey", "source": "env:CLOUDBASE_APIKEY" },
  "probe": { "ok": true, "model": "hy4", "ms": 1200, "textLength": 3 }
}
```

`probe.ok=true` 表示真的打通了一次模型调用，可以开始用客户端接入了。

## 本地跑

```bash
npm install
TCB_ENV=your-env-id CLOUDBASE_APIKEY=your-key RELAY_KEYS=sk-dev PORT=8080 npm start

curl http://127.0.0.1:8080/v1/chat/completions \
  -H "Authorization: Bearer sk-dev" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4.1-flash","messages":[{"role":"user","content":"你好"}]}'

# 流式
curl -N http://127.0.0.1:8080/v1/chat/completions \
  -H "Authorization: Bearer sk-dev" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4.1-flash","stream":true,"messages":[{"role":"user","content":"写首短诗"}]}'
```

## 客户端接入

```
Base URL: https://<你的域名>/v1
API Key : <RELAY_KEYS 里的任意一个>
Model   : deepseek-v4.1-flash
```

## 排障

| 现象 | 原因 / 处理 |
| --- | --- |
| `AI_CHANNEL_NOT_ALLOWED` | 请求没经过 SDK（例如自己拼的 HTTP）。确认 `server.js` 走的是 SDK 路径 |
| `missing secretId or secretKey of tencent cloud` | 两种凭证都没拿到，且 SDK 在 CBR 不会自动取临时密钥 → 配 `CLOUDBASE_APIKEY` |
| 上游 401 / `INVALID_ENV` | API Key 或 `TCB_ENV` 不对 |
| 模型未开启 | 去 AI 控制台打开对应模型开关 |
| `EXCEED_CONCURRENT_REQUEST_LIMIT` | 上游并发超限，官方不支持提升；加重试或换模型 |
| `CLOUDBASE_SERVICE_URL` 配错 | 只能填主机名，如 `xxx.api.tcloudbasegateway.com`，不能带 `https://` 或 `/v1` |

**验证是否真在抵扣免费额度**：调几次后看 [AI 模型用量](https://tcb.cloud.tencent.com/dev#/ai?tab=model-usage)，确认扣的是"免费额度"而不是"套餐资源点"。

## 合规提示

成长计划免费额度仅限小程序与云开发服务端（云函数 / 云托管）使用。官方治理公告把"第三方 API、直接 HTTP 调用"列为违规，处置手段包括暂停该环境的 AI 资源包权限。对外共享给第三方属于风险行为，后果自负。

## License

MIT
