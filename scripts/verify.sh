#!/usr/bin/env bash
# 用 .env 里的真实配置跑一次端到端自检：启动服务 -> /healthz -> /diag 真实模型调用 -> 退出。
# 不打印任何密钥内容。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

[[ -f .env ]] || { echo "缺少 .env，先 cp .env.example .env 并填好" >&2; exit 1; }

set -a
# shellcheck disable=SC1091
source ./.env
set +a

: "${TCB_ENV:?请先在 .env 里填 TCB_ENV}"
: "${RELAY_KEYS:?请先在 .env 里填 RELAY_KEYS}"

PORT="${PORT:-18099}"
BASE="http://127.0.0.1:${PORT}"
FIRST_KEY="${RELAY_KEYS%%,*}"

if [[ ! -d node_modules ]]; then
  echo "==> npm install"
  npm install --omit=dev --no-audit --no-fund --cache ./.npm-cache
fi

echo "==> 启动服务 (port $PORT)"
PORT="$PORT" node server.js > /tmp/relay-verify.log 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
  if curl -fsS "$BASE/healthz" >/dev/null 2>&1; then break; fi
  sleep 0.25
done

echo "==> /healthz"
curl -sS "$BASE/healthz" || { echo; echo "服务未起来，日志："; cat /tmp/relay-verify.log; exit 1; }
echo

echo "==> /diag (真实模型调用，最多等 60s)"
DIAG="$(curl -sS -m 60 "$BASE/diag" -H "Authorization: Bearer $FIRST_KEY")"
echo "$DIAG" | python3 -m json.tool 2>/dev/null || echo "$DIAG"

echo "$DIAG" | grep -q '"ok": true' && {
  echo
  echo "✅ 自检通过：SDK 通道可用，可以部署上线"
  exit 0
}

echo
echo "❌ 自检未通过，日志尾部："
tail -20 /tmp/relay-verify.log
exit 1
