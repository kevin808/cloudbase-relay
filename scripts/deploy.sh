#!/usr/bin/env bash
# 用 CloudBase CLI 部署到云托管。
# 前置：npm i -g @cloudbase/cli && tcb login
# 用法：TCB_ENV=xxx RELAY_KEYS=sk-x CLOUDBASE_SECRET_ID=AKID... CLOUDBASE_SECRET_KEY=... ./scripts/deploy.sh
set -euo pipefail

: "${TCB_ENV:?需要 TCB_ENV}"
: "${RELAY_KEYS:?需要 RELAY_KEYS}"
: "${CLOUDBASE_SECRET_ID:?需要 CLOUDBASE_SECRET_ID}"
: "${CLOUDBASE_SECRET_KEY:?需要 CLOUDBASE_SECRET_KEY}"

SERVICE="${SERVICE_NAME:-cloudbase-relay}"
PORT="${SERVICE_PORT:-8080}"

if ! command -v tcb >/dev/null 2>&1; then
  echo "未安装 CloudBase CLI，先执行：npm i -g @cloudbase/cli && tcb login" >&2
  exit 1
fi

echo "==> 部署 $SERVICE 到 $TCB_ENV (port $PORT)"

# 环境变量通过 --env 传入；tcb run deploy 会把当前目录作为构建上下文
tcb run deploy \
  --envId "$TCB_ENV" \
  --name "$SERVICE" \
  --port "$PORT" \
  --env "TCB_ENV=$TCB_ENV" \
  --env "RELAY_KEYS=$RELAY_KEYS" \
  --env "CLOUDBASE_SECRET_ID=$CLOUDBASE_SECRET_ID" \
  --env "CLOUDBASE_SECRET_KEY=$CLOUDBASE_SECRET_KEY" \
  --env "RELAY_LOG=1"

echo "==> 部署完成，验证："
echo "    curl https://<你的域名>/healthz"
