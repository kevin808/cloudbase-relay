#!/usr/bin/env bash
# 打包成可直接在云托管「代码包部署」上传的 zip。
# 只打包运行必需的文件，避免把 .env / node_modules 带上去。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-$ROOT/dist/cloudbase-relay.zip}"

cd "$ROOT"
mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"

FILES=(
  server.js
  package.json
  package-lock.json
  Dockerfile
  .dockerignore
  README.md
  LICENSE
)

missing=0
for f in "${FILES[@]}"; do
  [[ -e "$f" ]] || { echo "missing: $f" >&2; missing=1; }
done
[[ $missing -eq 0 ]] || exit 1

zip -q -X "$OUT" "${FILES[@]}"

echo "packed -> $OUT"
unzip -l "$OUT"
