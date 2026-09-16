#!/usr/bin/env bash
# 课文音频规范化：单声道 / 16kHz / 48kbps —— 约 0.36MB/分钟，流量成本最低
# 用法: ./tools/audio_norm.sh <输入音频> [输出.mp3]
set -euo pipefail
IN="${1:?用法: audio_norm.sh <输入音频> [输出.mp3]}"
OUT="${2:-${IN%.*}_norm.mp3}"
ffmpeg -y -v error -i "$IN" -ac 1 -ar 16000 -b:a 48k "$OUT"
DUR=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$OUT")
printf "%s  时长 %.1fs  大小 %s\n" "$OUT" "$DUR" "$(du -h "$OUT" | cut -f1)"
