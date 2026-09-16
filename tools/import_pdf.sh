#!/usr/bin/env bash
# PDF → 点读页面图（WebP）
# 用法: ./tools/import_pdf.sh <PDF文件> <起始页> <结束页> [输出目录] [宽度]
#   例: ./tools/import_pdf.sh ../text_books/我的讲义.pdf 1 20 out/handout 1080
#
# 版权提醒：请只导入机构自编讲义，或已获授权的素材。
#    出版社教材扫描件对外分发有侵权风险：出版社对内容与配套音频享有著作权，
#    未经授权分发可能被投诉下架甚至索赔。教材 PDF 建议只作为提取文本的内部参考。
set -euo pipefail

PDF="${1:?用法: import_pdf.sh <PDF> <起始页> <结束页> [输出目录] [宽度]}"
FROM="${2:-1}"; TO="${3:-5}"; OUT="${4:-out/pages}"; WIDTH="${5:-1080}"

mkdir -p "$OUT"
echo "▶ 转图 (150dpi) 第 $FROM–$TO 页 ..."
pdftoppm -r 150 -f "$FROM" -l "$TO" -png "$PDF" "$OUT/p"

echo "▶ 压缩为 WebP (宽 ${WIDTH}px, q75) ..."
for f in "$OUT"/p-*.png; do
  [ -e "$f" ] || continue
  cwebp -quiet -q 75 -resize "$WIDTH" 0 "$f" -o "${f%.png}.webp"
  rm "$f"
done

echo "▶ 顺便提取文本（省去手打课文）→ $OUT/text.txt"
pdftotext -layout -f "$FROM" -l "$TO" "$PDF" "$OUT/text.txt" || true

echo
echo "完成：$(ls -1 "$OUT"/*.webp 2>/dev/null | wc -l) 张图 → $OUT"
du -sh "$OUT"
echo
echo "下一步：打开内容后台 http://localhost:3000/admin.html"
echo "        新建教材 → +课 → +页（逐张上传）→ 上传课文音频 → 拖拽画热区 → 保存"
echo "或批量上传： node tools/upload_pages.mjs <lessonId> $OUT"
