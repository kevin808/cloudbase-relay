# cloudbase-fn-relay

微信云函数版的 CloudBase AI 中转。走 **`wx-server-sdk` 的 `cloud.ai()`**，也就是成长计划允许的"云开发服务端"通道。

同一个包支持两种入站方式：

| 入站 | 鉴权 | 返回 |
| --- | --- | --- |
| 小程序 `wx.cloud.callFunction` | 不需要（同环境） | `{success:true, ...openai}` |
| 云函数 HTTP 访问服务 | `Authorization: Bearer <RELAY_KEYS>` | OpenAI 兼容 JSON |

## 文件说明

```
cloudbase-fn-relay/
├── index.js        # 云函数入口（exports.main）
├── package.json    # 依赖 wx-server-sdk 3.0.5-beta.1
├── config.json     # 云函数配置
├── test-local.js   # 本地桩测试，不连云环境
└── README.md
```

## 本地测试

```bash
node test-local.js
```

用假的 `wx-server-sdk` 替换真模块，覆盖事件拆解、鉴权、模型白名单、OpenAI 响应结构、并发错误映射和参数透传，共 13 项。

```
PASS  http health
PASS  http ok
PASS  openai shape
...
13/13 passed
```

## 部署

### 1. 放到小程序项目的云函数目录

把整个 `cloudbase-fn-relay/` 重命名为你想用的函数名（例如 `relay`），放进项目根的 `cloudfunctions/`：

```
cloudfunctions/relay/
├── index.js
├── package.json
└── config.json
```

### 2. 在开发者工具里设置

- 右键 `cloudfunctions/relay` → **上传并部署：云端安装依赖**
- 云函数配置里把**超时时间改成 60 秒或更长**（AI 生成很慢，默认会超时）
- 需要 HTTP 调用时：云开发控制台 → 云函数 → HTTP 访问服务 → 添加路径 `/relay` → 绑定这个函数

### 3. 环境变量

在云开发控制台 → 云函数 → `relay` → 配置里加：

| 变量 | 说明 |
| --- | --- |
| `RELAY_KEYS` | 逗号分隔的共享密钥。**不配的话 HTTP 访问一律 401** |
| `ALLOWED_MODELS` | 可选，覆盖默认白名单 |

默认白名单：`hy4`、`hy4-preview`、`hy3`、`deepseek-v4.1-flash`、`deepseek-v4.1-flash-1017`。

## 调用

### 小程序内直调

```js
const res = await wx.cloud.callFunction({
  name: "relay",
  data: {
    model: "deepseek-v4.1-flash",
    messages: [{ role: "user", content: "你好" }],
  },
});
console.log(res.result.choices[0].message.content);
```

### HTTP 访问服务（OpenAI 兼容）

```bash
# 健康检查（不需要密钥）
curl "https://<你的环境ID>.service.tcloudbase.com/relay?action=health"

curl https://<你的环境ID>.service.tcloudbase.com/relay/v1/chat/completions \
  -H "Authorization: Bearer sk-xxxx" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4.1-flash","messages":[{"role":"user","content":"你好"}]}'
```

> HTTP 访问服务的实际路径取决于你绑定的路径前缀；上面按"绑定 `/relay`、函数内再判断子路径"来写，如果你的绑定方式不同，路径跟着调。

## 已知限制

- **不支持流式**：云函数 HTTP 访问服务无法稳定输出 SSE，这里统一非流式返回。要流式请用仓库根目录的云托管版本。
- **并发**：上游报 `EXCEED_CONCURRENT_REQUEST_LIMIT` 时返回 429，官方说明大盘并发不支持提升。
- **超时**：云函数最长执行时间受限，长文本生成可能被截断，建议 `max_tokens` 别设太大。
- **冷启动**：首次调用会慢几秒。

## 合规提示

成长计划免费额度仅限小程序与云开发服务端使用；官方公告把"第三方 API、直接 HTTP 调用"列为违规，处置手段包括暂停该环境的 AI 资源包权限。对外开放 HTTP 访问共享给他人属于风险行为，后果自负。
