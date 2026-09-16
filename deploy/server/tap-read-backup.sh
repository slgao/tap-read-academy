#!/usr/bin/env bash
# Tap Read 每日备份：数据库在线快照 + content（学生录音、页面图、课文音频）
# 由 systemd 定时器 tap-read-backup.timer 触发，也可手动执行：sudo tap-read-backup
set -euo pipefail

APP=${APP:-/opt/tap-read}
DEST=${DEST:-/var/backups/tap-read}
KEEP_DAYS=${KEEP_DAYS:-14}

mkdir -p "$DEST"
chmod 700 "$DEST"
ts=$(date -u +%Y%m%d-%H%M%S)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# 用 SQLite 在线备份 API，服务运行中也能得到一致的快照（直接拷文件会漏掉 WAL 里的数据）
sqlite3 "$APP/data/app.db" ".backup '$tmp/app.db'"
if [ "$(sqlite3 "$tmp/app.db" 'PRAGMA integrity_check')" != "ok" ]; then
  echo "备份失败：快照完整性检查未通过" >&2
  exit 1
fi

out="$DEST/tap-read-$ts.tar.gz"
tar -czf "$out" -C "$tmp" app.db -C "$APP" content
chmod 600 "$out"

# 只清理本脚本产生的旧备份
find "$DEST" -maxdepth 1 -name 'tap-read-*.tar.gz' -mtime +"$KEEP_DAYS" -delete

echo "备份完成 $out ($(du -h "$out" | cut -f1))，共保留 $(ls -1 "$DEST"/tap-read-*.tar.gz | wc -l) 份"
