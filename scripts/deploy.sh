#!/usr/bin/env bash
# 用官方 CLI 部署到云托管。
# 前置：安装并登录官方 CLI
# 用法：UPSTREAM_URL=https://host/v1/ai/<provider> RELAY_KEYS=sk-x SECRET_ID=... SECRET_KEY=... ./scripts/deploy.sh
set -euo pipefail

: "${UPSTREAM_URL:?需要 UPSTREAM_URL}"
: "${RELAY_KEYS:?需要 RELAY_KEYS}"
: "${SECRET_ID:?需要 SECRET_ID}"
: "${SECRET_KEY:?需要 SECRET_KEY}"
: "${ENV_ID:?需要 ENV_ID（仅 CLI 指定环境用，不传给服务）}"

SERVICE="${SERVICE_NAME:-ai-relay}"
PORT="${SERVICE_PORT:-8080}"

if ! command -v tcb >/dev/null 2>&1; then
  echo "未安装官方 CLI，请先安装并登录" >&2
  exit 1
fi

echo "==> 部署 $SERVICE (port $PORT)"

tcb run deploy \
  --envId "$ENV_ID" \
  --name "$SERVICE" \
  --port "$PORT" \
  --env "UPSTREAM_URL=$UPSTREAM_URL" \
  --env "RELAY_KEYS=$RELAY_KEYS" \
  --env "SECRET_ID=$SECRET_ID" \
  --env "SECRET_KEY=$SECRET_KEY" \
  --env "RELAY_LOG=1"

echo "==> 部署完成，验证："
echo "    curl https://<你的域名>/healthz"
