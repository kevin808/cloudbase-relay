# cloudbase-relay

架在腾讯云开发 **CloudBase AI** 前面的 OpenAI 兼容中转站，部署在**云托管（CloudBase Run）**上：对外暴露 `/v1/chat/completions`（含 SSE 流式），内部一律通过 **`@cloudbase/node-sdk`** 调用模型。

## 为什么必须走 SDK

成长计划资源包只认两个通道：小程序基础库、云开发 SDK。用 API Key **裸 HTTP** 打
`https://<env>.api.tcloudbasegateway.com/v1/ai/cloudbase` 会被判成第三方通道：

```json
{"code":"AI_CHANNEL_NOT_ALLOWED","message":"小程序成长计划仅支持小程序 SDK 和云开发 SDK 调用"}
```

而经 SDK 发出的请求，形态是这样的（本地抓包实测）：

```
POST /v1/ai/cloudbase/chat/completions
x-sdk-version: tcb-node-sdk/3.18.7
user-agent:    tcb-node-sdk/3.18.7
authorization: TC3-HMAC-SHA256 Credential=<SecretId>/...
```

**结论：不要自己拼 HTTP 调网关，让 SDK 去发。**

## 三个部署形态

| 目录 | 部署为 | 通道 | 流式 |
| --- | --- | --- | --- |
| 仓库根目录（`server.js`） | 云托管 / 自有服务器 | `@cloudbase/node-sdk` | ✅ |
| `cloudbase-fn-relay/` | 微信云函数 | `wx-server-sdk` 的 `cloud.ai()` | ❌ |

两者都属于"云开发 SDK"通道，差别只在部署位置和是否支持流式。

---

## 鉴权方式

自动探测，优先级从高到低：

| 顺序 | 环境变量 | 调用方式 | 说明 |
| --- | --- | --- | --- |
| 1 | `CLOUDBASE_SECRET_ID` + `CLOUDBASE_SECRET_KEY` | TC3 签名 | **推荐**。腾讯云子账号密钥 |
| 2 | `TENCENTCLOUD_SECRETID` + `TENCENTCLOUD_SECRETKEY` | TC3 签名 | 云函数运行时自带；云托管一般没有 |
| 3 | `CLOUDBASE_APIKEY` | `Bearer` | 云开发控制台 API Key，免 AK/SK |
| 4 | 请求头 `x-cloudbase-context` | 临时凭证 | 兜底，容器若下发该头则自动解析 |

> 云托管容器**不会**自动注入腾讯云临时密钥，SDK 在 CBR 环境也禁用了自动获取，
> 所以至少要配 1 或 3 其中之一，否则会报
> `missing secretId or secretKey of tencent cloud`。

## 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `TCB_ENV` | ✅ | 云开发环境 ID |
| `RELAY_KEYS` | ✅ | 客户端密钥，逗号分隔；为空拒绝启动 |
| `CLOUDBASE_SECRET_ID` / `CLOUDBASE_SECRET_KEY` | 推荐 | 子账号密钥 |
| `CLOUDBASE_APIKEY` | 可选 | 与 AK/SK 二选一 |
| `CLOUDBASE_SERVICE_URL` | ❌ | 自定义网关主机名，**只填主机名**，不要 `https://` 和 `/v1` |
| `TCB_REGION` | ❌ | 默认 `ap-shanghai` |
| `ALLOWED_MODELS` | ❌ | 覆盖模型白名单 |
| `PORT` | ❌ | 云托管会注入；本地默认 `8080` |
| `RELAY_LOG` | ❌ | 设 `0` 关闭请求日志 |

默认白名单：`hy4`、`hy4-preview`、`hy3`、`deepseek-v4.1-flash`、`deepseek-v4.1-flash-1017`。

---

## 部署到云托管

### 方式 A：代码包部署（无需本地 Docker）

```bash
./scripts/pack.sh
# -> dist/cloudbase-relay.zip
```

云开发控制台 → 云托管 → 服务 → 版本 → **代码包上传**，选择这个 zip。
构建时会读到包里的 `Dockerfile`，自动 `npm install --omit=dev` 后启动 `node server.js`。

### 方式 B：Git 部署

云托管服务 → 设置 → 绑定 GitHub 仓库 `kevin808/cloudbase-relay`，分支 `main`，
根目录 `/`，端口 `8080`。之后推代码即自动部署。

### 方式 C：CLI 部署

```bash
npm i -g @cloudbase/cli && tcb login

TCB_ENV=your-env-id \
RELAY_KEYS=sk-xxx \
CLOUDBASE_SECRET_ID=AKIDxxxx \
CLOUDBASE_SECRET_KEY=xxxx \
./scripts/deploy.sh
```

### 部署后必配

在服务的环境变量里填 `TCB_ENV`、`RELAY_KEYS`、`CLOUDBASE_SECRET_ID`、`CLOUDBASE_SECRET_KEY`，
监听端口填 `8080`，然后打开公网访问。

> 健康检查路径：服务对 `/`、`/healthz` 都返回 200，云托管默认健康检查可以直接用。

## 自检

```bash
curl https://<你的域名>/healthz
# {"ok":true,"env":"...","serviceUrl":"...","sdk":"3.18.7","auth":"ak","models":5}

curl https://<你的域名>/diag -H "Authorization: Bearer sk-xxx"
```

正常通过的样子：

```json
{
  "creds": { "found": true, "kind": "ak", "source": "env:CLOUDBASE_SECRET_ID" },
  "probe": { "ok": true, "model": "hy4", "ms": 1200, "textLength": 3 }
}
```

`probe.ok=true` 表示真的打通了一次模型调用，可以接客户端了。

## 客户端接入

```
Base URL: https://<你的域名>/v1
API Key : <RELAY_KEYS 里的任意一个>
Model   : deepseek-v4.1-flash
```

```bash
curl https://<你的域名>/v1/chat/completions \
  -H "Authorization: Bearer sk-xxx" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4.1-flash","messages":[{"role":"user","content":"你好"}]}'

# 流式
curl -N https://<你的域名>/v1/chat/completions \
  -H "Authorization: Bearer sk-xxx" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4.1-flash","stream":true,"messages":[{"role":"user","content":"写首短诗"}]}'
```

## 本地跑

```bash
cp .env.example .env    # 填好 TCB_ENV / RELAY_KEYS / AK/SK
npm install
npm start

# 或者用容器
cp .env.example .env
docker compose up --build
```

## 排障

| 现象 | 原因 / 处理 |
| --- | --- |
| `AI_CHANNEL_NOT_ALLOWED` | 请求没经过 SDK；确认走的是 `server.js` |
| `missing secretId or secretKey of tencent cloud` | 没配 AK/SK 或 API Key，且容器没下发 `x-cloudbase-context` |
| 上游 401 / `INVALID_ENV` | `TCB_ENV` 不对，或密钥无权访问该环境 |
| 模型未开启 | 去 AI 控制台打开对应模型开关 |
| `EXCEED_CONCURRENT_REQUEST_LIMIT` | 上游并发超限，官方不支持提升；加重试或换模型 |
| 云托管启动即 unhealthy | 健康检查路径用了 `/healthz` 以外的旧路径，或环境变量缺失导致进程退出 |
| 扣的是套餐资源点而非免费额度 | 说明调用没被判定为云开发服务端来源，或被识别成 AI 工具 |

**验证是否真在抵扣免费额度**：调几次后看 [AI 模型用量](https://tcb.cloud.tencent.com/dev#/ai?tab=model-usage)，确认扣的是"免费额度"而不是"套餐资源点"。

## 合规提示

成长计划免费额度仅限小程序与云开发服务端（云函数 / 云托管）使用。官方治理公告把"第三方 API、直接 HTTP 调用"列为违规，处置手段包括暂停该环境的 AI 资源包权限。对外共享给第三方属于风险行为，后果自负。

## License

MIT
