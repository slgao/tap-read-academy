/**
 * 从 PDF 自动生成点读页面和热区
 *
 *   node tools/auto_annotate.mjs <PDF> <lessonId> --pages 7-10 [选项]
 *
 * 选项：
 *   --pages 7-10            要导入的 PDF 页码范围（1 起）
 *   --crop-bottom 6.8       裁掉页面底部百分之几（用于切掉页脚水印），默认 0
 *   --width 1080            输出图片宽度
 *   --quality 75            WebP 质量
 *   --teacher 王老师         登录用的老师姓名
 *   --dry                   只打印结果，不写库
 *
 * 做三件事：
 *   1. 渲染页面图并按需裁掉底部（去页脚水印），转 WebP
 *   2. 用 pdftotext -bbox-layout 拿到每行文字的精确坐标
 *   3. 把断开的行合并成句子，生成归一化坐标的热区，写入数据库
 *
 * 只对「文字可选中」的 PDF 有效；纯图片扫描件拿不到坐标，需要人工在后台画框。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const BASE = process.env.BASE || 'http://localhost:3000';
const argv = process.argv.slice(2);
const pdf = argv[0];
const lessonId = Number(argv[1]);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i > 0 ? argv[i + 1] : d; };
const flag = (k) => argv.includes('--' + k);

if (!pdf || !lessonId) {
  console.error('用法: node tools/auto_annotate.mjs <PDF> <lessonId> --pages 7-10 [--crop-bottom 6.8]');
  process.exit(1);
}
const [from, to] = String(opt('pages', '1-1')).split('-').map(Number);
const cropPct = Number(opt('crop-bottom', 0));
const WIDTH = Number(opt('width', 1080));
const QUALITY = Number(opt('quality', 75));
const TEACHER = opt('teacher', '王老师');
const DRY = flag('dry');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'annot-'));
const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' });

/* ---------- 1. 取文字坐标 ---------- */
const xmlPath = path.join(tmp, 'bbox.xml');
sh('pdftotext', ['-bbox-layout', '-f', String(from), '-l', String(to), pdf, xmlPath]);
const xml = fs.readFileSync(xmlPath, 'utf8');

const pageRe = /<page width="([\d.]+)" height="([\d.]+)">([\s\S]*?)<\/page>/g;
const lineRe = /<line xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([\s\S]*?)<\/line>/g;
const wordRe = /<word[^>]*>([^<]*)<\/word>/g;

const pages = [];
let m;
while ((m = pageRe.exec(xml))) pages.push({ w: +m[1], h: +m[2], body: m[3] });

const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"');

function linesOf(page) {
  const out = [];
  let l;
  const re = new RegExp(lineRe.source, 'g');
  while ((l = re.exec(page.body))) {
    const words = [];
    let wm;
    const wre = new RegExp(wordRe.source, 'g');
    while ((wm = wre.exec(l[5]))) words.push(decode(wm[1]));
    const text = words.join(' ').replace(/\s+/g, ' ').trim();
    out.push({ x0: +l[1], y0: +l[2], x1: +l[3], y1: +l[4], text });
  }
  return out;
}

/** 过滤掉页码、单个字符、纯中文、页脚 */
function usable(ln, page, cropY) {
  if (ln.y1 > cropY) return false;                       // 落在被裁掉的区域
  const t = ln.text;
  if (!t || t.length < 3) return false;
  if (!/[A-Za-z]{2,}/.test(t)) return false;             // 必须含英文
  const letters = (t.match(/[A-Za-z]/g) || []).length;
  if (letters / t.length < 0.45) return false;           // 英文占比太低（多为中文注释）
  if (/^\d+$/.test(t.replace(/\s/g, ''))) return false;
  if ((ln.y1 - ln.y0) > page.h * 0.12) return false;     // 异常高的块
  return true;
}

/** 先按「横向重叠 + 纵向相邻 + 字号相近」把行聚成文本块（对应一个气泡/一段），
 *  再在块内把被换行拆断的句子接回去。并排的气泡因此不会互相串行。 */
function buildBlocks(lines) {
  const sorted = lines.slice().sort((a, b) => (a.y0 - b.y0) || (a.x0 - b.x0));
  const blocks = [];
  for (const ln of sorted) {
    const lh = ln.y1 - ln.y0;
    let best = null, bestScore = 0;
    for (const b of blocks) {
      const last = b.lines[b.lines.length - 1];
      const lastH = last.y1 - last.y0;
      const gap = ln.y0 - last.y1;
      if (gap < -lastH * 0.3 || gap > lastH * 1.0) continue;               // 纵向不相邻
      const ov = Math.min(last.x1, ln.x1) - Math.max(last.x0, ln.x0);
      const minW = Math.min(last.x1 - last.x0, ln.x1 - ln.x0);
      if (minW <= 0 || ov <= minW * 0.55) continue;                        // 横向重叠不够
      if (Math.abs(lh - lastH) / Math.max(lh, lastH) > 0.35) continue;     // 字号差太多（标题 vs 正文）
      const score = ov / minW;
      if (score > bestScore) { bestScore = score; best = b; }
    }
    if (best) {
      best.lines.push(ln);
      best.x0 = Math.min(best.x0, ln.x0); best.x1 = Math.max(best.x1, ln.x1);
      best.y1 = Math.max(best.y1, ln.y1);
    } else {
      blocks.push({ x0: ln.x0, y0: ln.y0, x1: ln.x1, y1: ln.y1, lines: [ln] });
    }
  }
  return blocks;
}

function sentencesOf(block) {
  const out = [];
  for (const ln of block.lines) {
    const prev = out[out.length - 1];
    if (prev && !/[.!?:;][")\]]?\s*$/.test(prev.text) && prev.parts < 4) {
      prev.text += ' ' + ln.text;
      prev.x0 = Math.min(prev.x0, ln.x0); prev.x1 = Math.max(prev.x1, ln.x1); prev.y1 = ln.y1;
      prev.parts++;
    } else {
      out.push({ ...ln, parts: 1 });
    }
  }
  return out;
}

const toSentences = (lines) =>
  buildBlocks(lines).flatMap(sentencesOf).sort((a, b) => (a.y0 - b.y0) || (a.x0 - b.x0));

/* ---------- 2. 渲染页面图 ---------- */
function renderPage(pdfPageNo, page) {
  sh('pdftoppm', ['-r', '150', '-f', String(pdfPageNo), '-l', String(pdfPageNo), '-png',
    pdf, path.join(tmp, 'pg')]);
  const src = fs.readdirSync(tmp).filter((f) => f.startsWith('pg') && f.endsWith('.png'))
    .map((f) => path.join(tmp, f))[0];
  const dst = path.join(tmp, `out_${pdfPageNo}.webp`);
  const [w0, h0] = sh('identify', ['-format', '%w %h', src]).trim().split(/\s+/).map(Number);
  const h1 = Math.round(h0 * (1 - cropPct / 100));
  sh('convert', [src, '-crop', `${w0}x${h1}+0+0`, '+repage',
    '-resize', `${WIDTH}x`, '-quality', String(QUALITY), dst]);
  fs.unlinkSync(src);
  return dst;
}

/* ---------- 3. 写库 ---------- */
const call = async (method, p, body, token) => {
  const r = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: method === 'GET' ? undefined : JSON.stringify(body || {}),
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error(p + ' -> ' + j.msg);
  return j.data;
};

const token = DRY ? null : (await call('POST', '/api/auth/dev-login', { role: 'teacher', name: TEACHER })).token;
const keepRatio = 1 - cropPct / 100;
let pageNo = 0, totalHs = 0;

for (let i = 0; i < pages.length; i++) {
  const pdfPageNo = from + i;
  const page = pages[i];
  const cropY = page.h * keepRatio;

  const raw = linesOf(page).filter((ln) => usable(ln, page, cropY));
  const merged = toSentences(raw);
  if (!merged.length) { console.log(`  跳过 PDF 第 ${pdfPageNo} 页：没有可用的英文行`); continue; }

  pageNo++;
  const hotspots = merged.map((ln, k) => {
    const padX = page.w * 0.008, padY = page.h * 0.004;
    const x = Math.max(0, (ln.x0 - padX) / page.w);
    const y = Math.max(0, (ln.y0 - padY) / cropY);
    const w = Math.min(1 - x, (ln.x1 - ln.x0 + padX * 2) / page.w);
    const h = Math.min(1 - y, (ln.y1 - ln.y0 + padY * 2) / cropY);
    return { x: +x.toFixed(5), y: +y.toFixed(5), w: +w.toFixed(5), h: +h.toFixed(5),
      startMs: 0, endMs: 0, en: ln.text, cn: '', type: 'sentence', sort: k + 1 };
  });

  console.log(`\n  PDF 第 ${pdfPageNo} 页 -> 第 ${pageNo} 页，${hotspots.length} 个热区`);
  hotspots.forEach((h, k) => console.log(`    ${String(k + 1).padStart(2)}. [${h.y.toFixed(3)}] ${h.en.slice(0, 62)}`));
  totalHs += hotspots.length;
  if (DRY) continue;

  const img = renderPage(pdfPageNo, page);
  const r = await call('POST', '/api/admin/pages', {
    lessonId, pageNo,
    imageBase64: fs.readFileSync(img).toString('base64'), ext: 'webp',
  }, token);
  await call('PUT', `/api/admin/pages/${r.id}/hotspots`, { hotspots }, token);
  console.log(`    已写入 page ${r.id} (${r.imgW}x${r.imgH})`);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n完成：${pageNo} 页 / ${totalHs} 个热区${DRY ? '（dry-run，未写库）' : ''}`);
if (!DRY) console.log(`去后台核对与补中文释义：${BASE}/admin.html`);
