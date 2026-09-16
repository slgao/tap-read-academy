/**
 * 把本地服务里的教材内容导出成静态体验版用的 content.json + 资源文件
 *
 *   ./start.sh &
 *   node tools/export_static_demo.mjs
 *
 * 体验版没有后端，内容全部内联在 static-demo/public/content.json，
 * 学习记录存在访问者自己手机的 localStorage 里。
 *
 * 选项：
 *   --url      服务地址，默认 http://localhost:3000
 *   --out      输出目录，默认 static-demo/public
 *   --teacher  登录用的老师姓名
 *   --books    只导出书名包含这些关键字的教材，逗号分隔；不给就全导
 *   --no-webp  不把页面图转成 WebP（默认转，能省一半体积）
 *   --hw-page  演示作业用哪一页（pageId），默认第一本书的第一页
 *   --hw-from  从该页第几个热区开始取，默认 0
 *   --hw-count 取几句，默认 4
 *   --hw-note  给学生的话
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = arg('url', 'http://localhost:3000').replace(/\/$/, '');
const OUT = path.resolve(arg('out', path.join(HERE, '../static-demo/public')));
const ASSETS = path.join(OUT, 'assets');
const TEACHER = arg('teacher', '王老师');
const ONLY = (arg('books', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const NO_WEBP = process.argv.includes('--no-webp');

const call = async (m, p, b, t) => {
  const r = await fetch(BASE + p, {
    method: m,
    headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) },
    body: m === 'GET' ? undefined : JSON.stringify(b || {}),
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error(p + ' -> ' + j.msg);
  return j.data;
};
const grab = async (url, dest) => {
  const r = await fetch(BASE + url);
  if (!r.ok) throw new Error('下载失败 ' + url);
  fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
  return fs.statSync(dest).size;
};

fs.mkdirSync(ASSETS, { recursive: true });
const { token } = await call('POST', '/api/auth/dev-login', { role: 'teacher', name: TEACHER });

let books = await call('GET', '/api/books', null, token);
if (ONLY.length) books = books.filter((b) => ONLY.some((k) => b.title.includes(k)));
if (!books.length) { console.error('没有匹配的教材'); process.exit(1); }

const out = { books: [], homework: null };
let bytes = 0;

for (const b of books) {
  const cat = await call('GET', `/api/books/${b.id}/catalog`, null, token);
  const book = { id: b.id, title: b.title, subtitle: b.subtitle, grade: b.grade, lessons: [] };
  for (const l of cat.lessons) {
    const lesson = { id: l.id, title: l.title, audio: null, pages: [] };
    for (const p of l.pages) {
      const d = await call('GET', `/api/pages/${p.id}`, null, token);
      if (!lesson.audio && d.lesson.audio) {
        const name = `b${b.id}_l${l.id}.mp3`;
        bytes += await grab(d.lesson.audio.url, path.join(ASSETS, name));
        lesson.audio = { url: 'assets/' + name, durationMs: d.lesson.audio.durationMs };
      }
      let img = `b${b.id}_p${d.page.pageNo}${path.extname(d.page.img.url) || '.webp'}`;
      let size = await grab(d.page.img.url, path.join(ASSETS, img));
      // 页面图统一转 WebP —— 体积大约减半，流量和加载都省
      if (!NO_WEBP && !/\.webp$/i.test(img)) {
        const webp = img.replace(/\.[^.]+$/, '.webp');
        try {
          execFileSync('cwebp', ['-quiet', '-q', '80', path.join(ASSETS, img), '-o', path.join(ASSETS, webp)]);
          fs.unlinkSync(path.join(ASSETS, img));
          img = webp;
          size = fs.statSync(path.join(ASSETS, webp)).size;
        } catch (e) { /* 没装 cwebp 就保持原样 */ }
      }
      bytes += size;
      lesson.pages.push({
        id: d.page.id, pageNo: d.page.pageNo, img: 'assets/' + img,
        imgW: d.page.imgW, imgH: d.page.imgH,
        hotspots: d.hotspots.map((h) => ({
          id: h.id, x: h.x, y: h.y, w: h.w, h: h.h,
          startMs: h.startMs, endMs: h.endMs, en: h.en, cn: h.cn,
        })),
      });
    }
    book.lessons.push(lesson);
  }
  out.books.push(book);
  const pages = book.lessons.reduce((n, l) => n + l.pages.length, 0);
  const hs = book.lessons.reduce((n, l) => n + l.pages.reduce((m, p) => m + p.hotspots.length, 0), 0);
  console.log(`  ${b.title}  ${pages} 页 / ${hs} 热区${book.lessons[0].audio ? '' : '（无音频）'}`);
}

/* ---------- 演示作业 ---------- */
const HW_PAGE = Number(arg('hw-page', 0));
const HW_FROM = Number(arg('hw-from', 0));
const HW_COUNT = Number(arg('hw-count', 4));
let hwPage = null, hwBook = null;
for (const b of out.books) for (const l of b.lessons) for (const pg of l.pages) {
  if (HW_PAGE ? pg.id === HW_PAGE : !hwPage) { hwPage = hwPage && !HW_PAGE ? hwPage : pg; hwBook = hwBook && !HW_PAGE ? hwBook : b; }
}
if (!hwPage) { console.error(`找不到 pageId=${HW_PAGE}`); process.exit(1); }
const picked = hwPage.hotspots.slice(HW_FROM, HW_FROM + HW_COUNT);
out.homework = {
  id: 1, title: arg('hw-title', '跟读作业'), className: '六年级 A 班', classId: 1,
  bookId: hwBook.id, pageId: hwPage.id,
  hotspotIds: picked.map((h) => h.id),
  note: arg('hw-note', '先听两遍原音，再逐句跟读。'),
};
console.log(`\n演示作业（第 ${hwPage.pageNo} 页）：`);
picked.forEach((h, i) => console.log(`  ${i + 1}. ${h.en}`));

fs.writeFileSync(path.join(OUT, 'content.json'), JSON.stringify(out));
const jsonKB = (fs.statSync(path.join(OUT, 'content.json')).size / 1024).toFixed(0);
console.log(`\ncontent.json ${jsonKB}KB + 资源 ${(bytes / 1048576).toFixed(2)}MB  ->  ${OUT}`);
