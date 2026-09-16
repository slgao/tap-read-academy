/**
 * 用本地 TTS 给自编讲义配音，并自动生成点读时间轴
 *
 *   node tools/tts_lesson.mjs <句子文件> --out out/lesson1 [选项]
 *
 * 句子文件：一行一句，可选中文用 | 分隔
 *   Hello! My name is Li Ming. | 你好！我叫李明。
 *   What is your name? | 你叫什么名字？
 *
 * 选项：
 *   --out <前缀>        输出 <前缀>.mp3 和 <前缀>.json（时间轴），默认 out/lesson
 *   --piper <可执行>    piper 命令路径（默认取 PIPER 环境变量或 `piper`）
 *   --model <onnx>      语音模型路径（默认取 PIPER_MODEL 环境变量）
 *   --gap 500           句间静音毫秒
 *   --lead 300          开头静音毫秒
 *   --rate 1.0          语速，>1 更慢（piper 的 length-scale）
 *   --page <pageId>     把音频挂到该页所属的课，并按顺序写回这一页热区的起止时间
 *   --lesson <lessonId> 同上，但按页面顺序把时间轴依次分发给整课的所有热区
 *   --teacher 王老师     写库时用的老师姓名
 *
 * 安装 piper（一次性，约 60MB 模型）：
 *   python3 -m venv .ttsenv && ./.ttsenv/bin/pip install piper-tts
 *   ./.ttsenv/bin/python -m piper.download_voices en_US-amy-medium
 *   export PIPER=$PWD/.ttsenv/bin/piper PIPER_MODEL=$PWD/en_US-amy-medium.onnx
 *
 * 产出的 mp3 是单声道 48kbps，约 0.36MB/分钟 —— 和 README 里的流量测算一致。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const src = argv[0];
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i > 0 ? argv[i + 1] : d; };

if (!src || !fs.existsSync(src)) {
  console.error('用法: node tools/tts_lesson.mjs <句子文件> --out out/lesson1');
  process.exit(1);
}
const OUT = opt('out', 'out/lesson');
const PIPER = opt('piper', process.env.PIPER || 'piper');
const MODEL = opt('model', process.env.PIPER_MODEL || '');
const GAP = Number(opt('gap', 500));
const LEAD = Number(opt('lead', 300));
const RATE = Number(opt('rate', 1.0));
const PAGE_ID = opt('page', null);
const TEACHER = opt('teacher', '王老师');
const BASE = process.env.BASE || 'http://localhost:3000';

if (!MODEL) { console.error('缺少语音模型：--model 或设置 PIPER_MODEL'); process.exit(1); }

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
const durationMs = (f) =>
  Math.round(parseFloat(sh('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1', f]).trim()) * 1000);

const lines = fs.readFileSync(src, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean)
  .map((l) => { const [en, cn] = l.split('|').map((x) => (x || '').trim()); return { en, cn: cn || '' }; });
if (!lines.length) { console.error('句子文件是空的'); process.exit(1); }

fs.mkdirSync(path.dirname(OUT) || '.', { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-'));

console.log(`用 ${path.basename(MODEL)} 合成 ${lines.length} 句 ...`);
const silence = (sec, name) => {
  const f = path.join(tmp, name);
  sh('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=22050:cl=mono', '-t', String(sec), f]);
  return f;
};
const lead = silence(LEAD / 1000, 'lead.wav');
const gap = silence(GAP / 1000, 'gap.wav');

const entries = [lead];
const timings = [];
let t = LEAD;
lines.forEach((ln, i) => {
  const raw = path.join(tmp, `s${i}.wav`);
  // piper 从 stdin 读文本
  execFileSync(PIPER, ['-m', MODEL, '-f', raw, '--length-scale', String(RATE)], { input: ln.en });
  const norm = path.join(tmp, `n${i}.wav`);
  sh('ffmpeg', ['-y', '-v', 'error', '-i', raw, '-ac', '1', '-ar', '22050', norm]);
  const d = durationMs(norm);
  timings.push({ index: i + 1, en: ln.en, cn: ln.cn, startMs: t, endMs: t + d });
  t += d + GAP;
  entries.push(norm, gap);
  process.stdout.write(`  ${String(i + 1).padStart(2)}. ${(d / 1000).toFixed(2)}s  ${ln.en}\n`);
});

const listFile = path.join(tmp, 'list.txt');
fs.writeFileSync(listFile, entries.map((f) => `file '${f}'`).join('\n'));
const mp3 = OUT + '.mp3';
sh('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', listFile,
  '-c:a', 'libmp3lame', '-b:a', '48k', '-ac', '1', '-ar', '22050', mp3]);
fs.writeFileSync(OUT + '.json', JSON.stringify(timings, null, 2));
fs.rmSync(tmp, { recursive: true, force: true });

const size = (fs.statSync(mp3).size / 1024).toFixed(0);
console.log(`\n${mp3}  ${(t / 1000).toFixed(1)}s  ${size}KB`);
console.log(`${OUT}.json  ${timings.length} 条时间轴`);

/* ---------- 可选：直接写库 ---------- */
const LESSON_ID = opt('lesson', null);
if (PAGE_ID || LESSON_ID) {
  const call = async (m, p, b, tk) => {
    const r = await fetch(BASE + p, {
      method: m,
      headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) },
      body: m === 'GET' ? undefined : JSON.stringify(b || {}),
    });
    const j = await r.json();
    if (j.code !== 0) throw new Error(p + ' -> ' + j.msg);
    return j.data;
  };
  const { token } = await call('POST', '/api/auth/dev-login', { role: 'teacher', name: TEACHER });

  // 要写的页面列表：给了 --lesson 就取整课，否则就这一页
  let pageIds;
  let lessonId = LESSON_ID;
  if (LESSON_ID) {
    const books = await call('GET', '/api/books', null, token);
    let found = null;
    for (const b of books) {
      const cat = await call('GET', `/api/books/${b.id}/catalog`, null, token);
      const l = cat.lessons.find((x) => String(x.id) === String(LESSON_ID));
      if (l) { found = l; break; }
    }
    if (!found) { console.error(`找不到 lesson ${LESSON_ID}`); process.exit(1); }
    pageIds = found.pages.map((p) => p.id);
  } else {
    const page = await call('GET', `/api/pages/${PAGE_ID}`, null, token);
    lessonId = page.lesson.id;
    pageIds = [Number(PAGE_ID)];
  }

  await call('POST', `/api/admin/lessons/${lessonId}/audio`,
    { base64: fs.readFileSync(mp3).toString('base64'), ext: 'mp3' }, token);
  console.log(`\n课文音频已挂到 lesson ${lessonId}`);

  // 时间轴按「页面顺序 + 页内热区顺序」依次分发
  let k = 0, total = 0;
  for (const pid of pageIds) {
    const page = await call('GET', `/api/pages/${pid}`, null, token);
    const merged = page.hotspots.map((h) => {
      const t = timings[k++];
      return {
        x: h.x, y: h.y, w: h.w, h: h.h, type: h.type,
        en: t ? t.en : h.en,
        cn: t && t.cn ? t.cn : h.cn,
        startMs: t ? t.startMs : 0,
        endMs: t ? t.endMs : 0,
      };
    });
    const r = await call('PUT', `/api/admin/pages/${pid}/hotspots`, { hotspots: merged }, token);
    total += r.count;
    console.log(`  第 ${page.page.pageNo} 页  ${r.count} 个热区  ${merged[0] ? (merged[0].startMs / 1000).toFixed(1) : 0}s~${merged[merged.length - 1] ? (merged[merged.length - 1].endMs / 1000).toFixed(1) : 0}s`);
  }
  if (k !== timings.length) {
    console.log(`\n注意：句子 ${timings.length} 条，热区 ${k} 个，多出来的一方被忽略`);
  }
  console.log(`共写入 ${total} 个热区的时间轴  →  ${BASE}/admin.html`);
}
