# cloudbase-relay

把腾讯云开发 **CloudBase AI** 包装成 **OpenAI 兼容接口**，部署在 **CloudBase 云托管**上，用一个地址同时给多台设备 / 多个客户端使用。

> 只做协议转换，不做账号池、不做额度转售。

---

## ⚠️ 先读这段：合规边界

腾讯云开发《关于"小程序成长计划 AI 资源包"使用范围的专项治理公告》对免费额度有明确限制：

| 允许的来源 | 说明 |
| --- | --- |
| 小程序基础库 | `wx.cloud.extend.AI` |
| 云开发服务端 | **云函数、云托管**中的 `wx-server-sdk` / `@cloudbase/node-sdk` / `@cloudbase/js-sdk` |
| 云开发控制台 | 控制台内直接使用 |

原文还写明："**AI 资源包仅限小程序和云函数中使用，其他来源均不可使用**"，并把"第三方 API、直接 HTTP 调用"列为违规类型。治理手段是：非允许来源的调用不再抵扣免费额度、改为扣套餐额度，并对违规环境**暂停 AI 资源包使用权限**。

因此：

- ✅ 把本项目部署在**云托管**里，属于"云开发服务端"，是最接近合规的形态。
- ❌ 部署在自己的 CVM 或腾讯云 SCF 上（用 secretId/secretKey 直连），大概率被判定为非允许来源：**消耗不到免费额度**，还可能被判违规。
- ❌ 对外公开、按量卖给别人共享，本质上就是公告里的"第三方 API"，风险自负。

本项目仅为技术示例，使用后果由使用者承担。

---

## 为什么是云托管，不是云函数 / 你自己的服务器

| 部署位置 | 抵扣免费额度 | 流式输出 | 备注 |
| --- | --- | --- | --- |
| **云托管**（本项目） | ✅ | ✅ 原生 SSE | 容器常驻，无冷启动 |
| 云函数 HTTP 访问 | ✅ | ⚠️ 长连接 / 执行时长限制多 | 适合非流式 |
| 自有 CVM | ❌ | ✅ | 被识别为外部来源，改为扣套餐 |
| 腾讯云 SCF | ❌ | ⚠️ 需 API 网关配合 | 同上，且配置更绕 |

---

## 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `TCB_ENV` | ✅ | 云开发环境 ID，例如 `prod-1g2h3j4k` |
| `RELAY_KEYS` | ✅ | 访问密钥，逗号分隔，例如 `sk-abc,sk-def`。为空会拒绝启动 |
| `ALLOWED_MODELS` | ❌ | 覆盖默认模型列表 |
| `PORT` | ❌ | 默认 `8080` |

默认放行：`hy4`、`hy4-preview`、`hy3`、`deepseek-v4.1-flash`、`deepseek-v4.1-flash-1017`（成长计划当前可抵扣的五款）。

---

## 本地跑

```bash
npm install
TCB_ENV=your-env-id RELAY_KEYS=sk-dev PORT=8080 npm start
```

```bash
curl http://127.0.0.1:8080/v1/chat/completions \
  -H "Authorization: Bearer sk-dev" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4.1-flash","messages":[{"role":"user","content":"你好"}]}'
```

> 本地运行时 `@cloudbase/node-sdk` 需要 secretId/secretKey 或已登录的 CLI 凭据；容器在云托管内运行才是免密的。

## 部署到云托管

1. 云开发控制台 → **云托管** → 新建服务（选择"上传代码包"或"镜像"，本仓库根目录可直接构建）。
2. 端口填 `8080`，实例规格选最小档即可（网关本身不吃 CPU）。
3. 在服务配置里添加环境变量 `TCB_ENV`、`RELAY_KEYS`。
4. 打开**公网访问**，拿到默认域名（建议再挂自定义域名 + HTTPS）。
5. 部署完成后访问 `/healthz` 确认返回 `{"ok":true}`。

用 CLI 的话：

```bash
tcb run deploy --name cloudbase-relay --port 8080
```

## 客户端接入

任何支持自定义 OpenAI Base URL 的客户端都可以：

```
Base URL: https://<你的域名>/v1
API Key : <RELAY_KEYS 里的任意一个>
Model   : deepseek-v4.1-flash
```

```python
from openai import OpenAI
client = OpenAI(base_url="https://<你的域名>/v1", api_key="sk-abc")
print(client.chat.completions.create(
    model="deepseek-v4.1-flash",
    messages=[{"role": "user", "content": "你好"}],
).choices[0].message.content)
```

## 已知限制

- **并发**：上游报 `EXCEED_CONCURRENT_REQUEST_LIMIT` 时本网关返回 429。官方说明"大盘资源有限，暂不支持提升并发"，多人共享很容易撞上。
- **模型**：只有 flash 级模型；调用列表外的模型不会消耗免费额度。
- **生图**：未实现。且 `HY-Image-3.0-Plus-4090-Tob-v1.0` / `HY-Image-v3.0-I2I-ToB-v1.0.1` 将于 2026-12-01 下线。
- **有效期**：成长计划资源包 6 个月，过期后转为从套餐额度抵扣（非资源点套餐会直接报错）。
- **流式**：依赖容器常驻；若部署到云函数，SSE 可能被网关缓冲或截断。

## License

MIT
