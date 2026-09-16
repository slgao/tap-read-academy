#!/usr/bin/env bash
# 一键启动
set -euo pipefail
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "需要 Node.js 22.5+"; exit 1; }
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
[ "$NODE_MAJOR" -ge 22 ] || { echo "Node 版本过低（需 22.5+，当前 $(node -v)）"; exit 1; }
[ -f data/app.db ] || { echo "首次运行，初始化演示数据 ..."; (cd server && node src/seed.js); }
exec node server/src/index.js
