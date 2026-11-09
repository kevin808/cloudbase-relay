# cloudbase-relay

架在腾讯云开发 **CloudBase AI** 前面的 OpenAI 兼容中转站：对外暴露 `/v1/chat/completions`，内部通过 **`@cloudbase/node-sdk`** 调用模型。

关键点：**"小程序成长计划"的免费额度只认 SDK 调用通道**。用 API Key + 公网网关调用会直接被拒：

```
{"code":"AI_CHANNEL_NOT_ALLOWED","message":"小程序成长计划仅支持小程序 SDK 和云开发 SDK 调用"}
```

所以本项目默认走 SDK 模式，并支持从环境变量或容器请求头里解析腾讯云凭证。

---

## 两种上游模式

| 模式 | 通道 | 成长计划免费额度 | 适用 |
| --- | --- | --- | --- |
| `MODE=sdk`（默认） | `@cloudbase/node-sdk` | ✅ 可抵扣 | 云托管 / 云函数 / 自有服务器 |
| `MODE=gateway` | API Key + `api.tcloudbasegateway.com` | ❌ 直接 403 `AI_CHANNEL_NOT_ALLOWED` | 非成长计划环境，或自费套餐 |

`MODE=gateway` 保留是为了兼容非成长计划环境，**成长计划环境不要用它**。

---

## 凭证怎么来（这是最容易踩的坑）

`@cloudbase/node-sdk` 在 **CBR（云托管）环境里主动禁用了临时密钥自动获取**，容器也不会自动注入 `TENCENTCLOUD_SECRETID/KEY`。所以本服务按以下顺序找凭证：

1. `CLOUDBASE_SECRET_ID` + `CLOUDBASE_SECRET_KEY`（推荐，显式配置）
2. `TENCENTCLOUD_SECRETID` + `TENCENTCLOUD_SECRETKEY`（云函数运行时自带）
3. 每个请求头 `x-cloudbase-context` 里的临时凭证（云托管网关可能下发，自动解析）

### 推荐做法：用子账号 AK/SK

不要用主账号密钥。建一个子账号，只授予云开发所需的最小权限，然后把密钥填进云托管的环境变量：

```
CLOUDBASE_SECRET_ID=AKIDxxxxxxxxxxxxxxxx
CLOUDBASE_SECRET_KEY=xxxxxxxxxxxxxxxxxxxxxxxx
```

> 密钥是长期有效的，别提交进仓库，也别在日志里打印。

---

## 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `TCB_ENV` | ✅ | 云开发环境 ID |
| `RELAY_KEYS` | ✅ | 客户端密钥，逗号分隔。为空拒绝启动 |
| `MODE` | ❌ | `sdk`（默认）/ `gateway` |
| `CLOUDBASE_SECRET_ID` / `CLOUDBASE_SECRET_KEY` | sdk 模式 ✅ | 腾讯云子账号密钥 |
| `CLOUDBASE_APIKEY` | gateway 模式 ✅ | 云开发控制台 API Key |
| `UPSTREAM_BASE` | ❌ | 只用 gateway 模式时覆盖上游地址 |
| `ALLOWED_MODELS` | ❌ | 覆盖默认模型白名单 |
| `PORT` | ❌ | 默认 `8080` |

默认白名单：`hy4`、`hy4-preview`、`hy3`、`deepseek-v4.1-flash`、`deepseek-v4.1-flash-1017`。

## 本地跑

```bash
npm install
TCB_ENV=your-env-id \
CLOUDBASE_SECRET_ID=your-ak \
CLOUDBASE_SECRET_KEY=your-sk \
RELAY_KEYS=sk-dev PORT=8080 npm start
```

```bash
curl http://127.0.0.1:8080/healthz
# {"ok":true,"mode":"sdk","env":"...","upstream":"sdk:@cloudbase/node-sdk","staticCreds":true}

curl http://127.0.0.1:8080/v1/chat/completions \
  -H "Authorization: Bearer sk-dev" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4.1-flash","messages":[{"role":"user","content":"你好"}]}'
```

流式：

```bash
curl -N http://127.0.0.1:8080/v1/chat/completions \
  -H "Authorization: Bearer sk-dev" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4.1-flash","stream":true,"messages":[{"role":"user","content":"写首短诗"}]}'
```

## 部署

```bash
# 云托管
tcb run deploy --name cloudbase-relay --port 8080

# 自有服务器
docker build -t cloudbase-relay .
docker run -d -p 8080:8080 \
  -e TCB_ENV=your-env-id \
  -e CLOUDBASE_SECRET_ID=your-ak \
  -e CLOUDBASE_SECRET_KEY=your-sk \
  -e RELAY_KEYS=sk-a1,sk-b2 \
  cloudbase-relay
```

云托管控制台里把上面几个环境变量配上，端口填 `8080`，开公网访问即可。

## 客户端

```
Base URL: https://<你的域名>/v1
API Key : <RELAY_KEYS 里的任意一个>
Model   : deepseek-v4.1-flash
```

## 排障对照表

| 现象 | 原因 / 处理 |
| --- | --- |
| `AI_CHANNEL_NOT_ALLOWED` | 用了 API Key / 公网网关通道。切回 `MODE=sdk` |
| `missing secretId or secretKey of tencent cloud` | 云托管里没配 `CLOUDBASE_SECRET_ID/KEY`，SDK 在 CBR 不会自动取 |
| `拿不到腾讯云凭证` | 同上，且请求头里也没有 `x-cloudbase-context` |
| 上游 403 且提示模型未开通 | 去 AI 控制台打开对应模型开关 |
| `EXCEED_CONCURRENT_REQUEST_LIMIT` | 上游并发超限，官方不支持提升；加重试或换模型 |
| 扣的是套餐资源点而非免费额度 | 说明调用没走 SDK 通道，或被判定为 AI 工具来源 |

**验证是否真的吃免费额度**：调几次后看 [AI 模型用量](https://tcb.cloud.tencent.com/dev#/ai?tab=model-usage)，确认扣减的是"免费额度"。

## 合规提示

成长计划免费额度仅限小程序与云开发服务端（云函数 / 云托管）使用，官方治理公告明确把"第三方 API、直接 HTTP 调用"列为违规，处置手段包括暂停该环境的 AI 资源包权限。对外共享给第三方属于风险行为，后果自负。

## License

MIT
