# AI 中转网关

把上游 AI 服务包成 OpenAI 兼容接口，部署在容器服务上。对外提供 `/v1/chat/completions`（含 SSE 流式），内部统一通过官方 SDK 发起调用。

## 为什么必须走 SDK

上游对免费额度有来源限制，只认两类调用：应用端 SDK、服务端 SDK。**用 API Key 直接拼 HTTP 打网关会被判成第三方通道**：

```json
{"code":"AI_CHANNEL_NOT_ALLOWED","message":"仅支持 SDK 调用"}
```

而经 SDK 发出的请求形态是这样的（本地抓包实测）：

```
POST /v1/ai/<provider>/chat/completions
x-sdk-version: <sdk name>/<version>
user-agent:    <sdk name>/<version>
authorization: TC3-HMAC-SHA256 Credential=<SECRET_ID>/...
```

**结论：不要自己拼 HTTP 调网关，让 SDK 去发。**

## 两种部署形态

| 目录 | 部署为 | 通道 | 流式 |
| --- | --- | --- | --- |
| 根目录（`server.js`） | 容器服务 / 自有服务器 | 服务端 SDK | ✅ |
| `fn-relay/` | 云函数 | 函数运行时 SDK | ❌ |

两者都属于"服务端 SDK"通道，差别只在部署位置和是否支持流式。

---

## 鉴权

自动探测，优先级从高到低：

| 顺序 | 环境变量 | 调用方式 | 说明 |
| --- | --- | --- | --- |
| 1 | `SECRET_ID` + `SECRET_KEY` | 签名 | **推荐**。密钥对 |
| 2 | 运行时注入的临时密钥 | 签名 | 函数运行时自带；容器服务一般没有 |
| 3 | `API_KEY` | `Bearer` | 免密钥对的备选 |
| 4 | 请求头里的临时凭证 | 临时凭证 | 兜底，容器若下发则自动解析 |

> 容器**不会**自动注入临时密钥，SDK 在容器环境也禁用了自动获取，
> 所以至少要配 1 或 3 其中之一，否则会报
> `missing secretId or secretKey`。

## 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `UPSTREAM_URL` | ✅ | 上游地址。**可直接填完整 URL**（如 `https://host/v1/ai/<provider>`），协议/主机/provider 会自动解析；只填主机名也兼容 |
| `RELAY_KEYS` | ✅ | 客户端密钥，逗号分隔；为空拒绝启动 |
| `SECRET_ID` / `SECRET_KEY` | 推荐 | 密钥对 |
| `API_KEY` | 可选 | 与密钥对二选一 |
| `REGION` | ❌ | 默认 `ap-shanghai` |
| `ALLOWED_MODELS` | ❌ | 覆盖模型白名单 |
| `PORT` | ❌ | 容器会注入；本地默认 `8080` |
| `RELAY_LOG` | ❌ | 设 `0` 关闭请求日志 |
| `RELAY_HEALTH_DETAIL` | ❌ | 设 `1` 让 `/healthz` 额外返回上游地址、鉴权方式、模型数；默认只回 `{"ok":true}` |

> 环境 ID 不用单独填：它已经包含在上游地址里。SDK 会在该地址后自己追加 `/chat/completions`，所以照抄上游给到 `/v1/ai/<provider>` 这一层即可（`<provider>` 用上游实际给的路径段），不要连带把 `/chat/completions` 也写进去。

默认白名单：`hy4`、`hy4-preview`、`hy3`、`deepseek-v4.1-flash`、`deepseek-v4.1-flash-1017`。

---

## 部署

### 方式 A：代码包部署（无需本地 Docker）

```bash
./scripts/pack.sh
# -> dist/ai-relay.zip
```

控制台 → 容器服务 → 版本 → **代码包上传**，选择这个 zip。
构建时读取包里的 `Dockerfile`，自动安装依赖后启动 `node server.js`。

### 方式 B：Git 部署（备选）

容器服务 → 设置 → 绑定代码仓库，分支 `main`，根目录 `/`，端口 `8080`。
之后推代码即自动部署。

### 部署后必配

环境变量填 `UPSTREAM_URL`、`RELAY_KEYS`、`SECRET_ID`、`SECRET_KEY`，
监听端口填 `8080`，然后打开公网访问。

> 健康检查：服务对 `/`、`/healthz` 都返回 200，默认健康检查可直接用。

## 自检

```bash
curl https://<你的域名>/healthz
# {"ok":true}            ← 默认不暴露上游地址

# 需要看细节时（仅建议在排查阶段临时开启）：
# RELAY_HEALTH_DETAIL=1 后返回 upstream / sdk / auth / models

curl https://<你的域名>/diag -H "Authorization: Bearer sk-xxx"
```

正常通过的样子：

```json
{
  "creds": { "found": true, "kind": "ak", "source": "env:SECRET_ID" },
  "probe": { "ok": true, "model": "hy4", "ms": 1200, "textLength": 3 }
}
```

`probe.ok=true` 表示真的打通了一次模型调用，可以接客户端了。
部署前也可以先在本地跑同一套检查：

```bash
cp .env.example .env   # 填 UPSTREAM_URL / RELAY_KEYS / SECRET_ID / SECRET_KEY
./scripts/verify.sh
```

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
cp .env.example .env    # 填好上游地址、访问密钥、密钥对
npm install
npm start

# 或者用容器
cp .env.example .env
docker compose up --build
```

## Token 统计

`usage` 会尽量如实透传，规则：

- **非流式**：返回 `usage.prompt_tokens / completion_tokens / total_tokens`
- **流式**：在 `[DONE]` 之前补一帧 `choices: []` 且带 `usage` 的 chunk（OpenAI 的 `include_usage` 约定），客户端据此显示用量
- 请求上游时会自动带上 `stream_options: {include_usage: true}`，因为 SDK 默认不会要 usage
- 若上游不认这个参数（返回 400），自动降级重试一次，此时拿不到统计
- **拿不到真实数值时宁可不返回 `usage`，也不返回全 0**，避免客户端显示成 0

## 接口

| 路径 | 鉴权 | 说明 |
| --- | --- | --- |
| `GET /` | 无 | 健康检查，返回 200 |
| `GET /healthz` | 无 | 存活检查，默认只返回 `{"ok":true}`；`RELAY_HEALTH_DETAIL=1` 才带细节 |
| `GET /diag` | 需要 | 自检：凭证来源 + 真实最小调用 |
| `GET /v1/models` | 需要 | 模型列表 |
| `POST /v1/chat/completions` | 需要 | 对话，支持 `stream: true` |

## 排障

| 现象 | 原因 / 处理 |
| --- | --- |
| `AI_CHANNEL_NOT_ALLOWED` | 请求没经过 SDK；确认走的是 `server.js` |
| `missing secretId or secretKey` | 没配密钥对或 API Key，且容器没下发临时凭证 |
| 上游 401 / `INVALID_ENV` | `UPSTREAM_URL` 写错，或密钥无权访问该上游 |
| 模型未开启 | 去上游控制台打开对应模型开关 |
| `EXCEED_CONCURRENT_REQUEST_LIMIT` | 上游并发超限，不支持提升；加重试或换模型 |
| 容器启动即 unhealthy | 健康检查路径不是 `/` 或 `/healthz`，或必填变量缺失导致进程退出 |
| 扣的是套餐额度而非免费额度 | 说明调用未被判定为服务端来源，或被识别成第三方工具 |

## 许可

MIT
