/**
 * 录一段演示视频（竖屏，可直接发微信）
 *
 *   ./start.sh &                                  # 先把服务跑起来
 *   npm i playwright                              # 一次性，用系统已装的 Chrome
 *   node tools/record_demo.mjs --out out/demo
 *
 * 做三件事：
 *   1. 用真实 Chrome 按下面的分镜操作学生端并录屏（Playwright 录屏不带声音）
 *   2. 记录每次触发发音的时刻，事后用 ffmpeg 把课文音频按这些时刻混回去
 *   3. 开头闪一帧纯黑作同步标记，用 blackdetect 校准零点，再转 H.264 + AAC
 *
 * 选项：
 *   --url        默认 http://localhost:3000/（完整版）
 *   --out        输出前缀，默认 out/demo
 *   --audio/--timings    第一套课文音频与时间轴（默认 server/assets 里的演示讲义）
 *   --audio2/--timings2  第二套（比如导入的教材）。不给就跳过教材那一段分镜
 *   --book-page  教材要展示的页面 id
 *   --book-offset 该页第一个热区在第二套时间轴里的下标
 *
 * 录制过程中会用老师身份调接口批改作业，这样"老师批改 → 学生看到评语"是真实链路，
 * 不是演出来的。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = arg('url', 'http://localhost:3000/').replace(/\/$/, '');
const OUT = arg('out', 'out/demo');
const WORK = OUT + '_work';
fs.mkdirSync(WORK, { recursive: true });

const SRC = {
  demo: {
    json: arg('timings', path.join(HERE, '../server/assets/demo_lesson1.json')),
    mp3: arg('audio', path.join(HERE, '../server/assets/demo_lesson1.mp3')),
  },
};
const book2 = arg('timings2', null);
if (book2) SRC.book = { json: book2, mp3: arg('audio2', book2.replace(/\.json$/, '.mp3')) };
for (const k of Object.keys(SRC)) SRC[k].T = JSON.parse(fs.readFileSync(SRC[k].json, 'utf8'));

const BOOK_A = arg('book-a', '自编讲义');          // 第一段展示的教材（按书名匹配）
const BOOK_B = arg('book-b', '');                  // 第二段展示的教材
const BOOK_PAGE_NO = Number(arg('book-page-no', 0));  // 展示该教材的第几页
const BOOK_OFFSET = Number(arg('book-offset', 0));    // 该页首个热区在第二套时间轴里的下标
const showBook = !!(SRC.book && BOOK_B && BOOK_PAGE_NO);

const audioEvents = [];      // { atMs, src, idx }
let t0 = 0;
const now = () => Date.now() - t0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dur = (src, idx) => SRC[src].T[idx].endMs - SRC[src].T[idx].startMs;

/* ---------- 后台接口（准备数据 + 录制中让老师批改） ---------- */
const api = async (m, p, b, tk) => {
  const r = await fetch(BASE + p, {
    method: m,
    headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) },
    body: m === 'GET' ? undefined : JSON.stringify(b || {}),
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error(p + ' -> ' + j.msg);
  return j.data;
};

/* ---------- 字幕 ---------- */
const CAPTION_CSS = `
#demo-cap{position:fixed;left:14px;right:14px;top:14px;z-index:99999;pointer-events:none;
  background:#0F172A;color:#fff;border-radius:14px;padding:11px 15px;
  font:600 14.5px/1.5 system-ui,"PingFang SC","Noto Sans CJK SC",sans-serif;
  letter-spacing:.01em;box-shadow:0 8px 28px rgba(0,0,0,.28);
  opacity:0;transform:translateY(-6px);transition:opacity .28s,transform .28s;}
#demo-cap.on{opacity:1;transform:translateY(0)}
#demo-cap b{color:#7DD3FC;font-weight:700}
`;
const cap = (page, html) => page.evaluate((h) => {
  const d = document.getElementById('demo-cap');
  if (!h) { d.classList.remove('on'); return; }
  d.innerHTML = h; d.classList.add('on');
}, html);

/** 点一个热区，并登记这一句要在视频里响起来 */
async function tap(page, hotspotIdx, src, sentenceIdx) {
  await page.click(`.hs[data-i="${hotspotIdx}"]`);
  audioEvents.push({ atMs: now() + 120, src, idx: sentenceIdx });
}

(async () => {
  /* ---------- 录制前：造一条干净的作业（不依赖库里现有数据） ---------- */
  const T = await api('POST', '/api/auth/dev-login', { role: 'teacher', name: '王老师', teacherCode: process.env.TEACHER_CODE || '' });
  const cls = (await api('GET', '/api/classes', null, T.token))[0];

  // 取第一套教材第一课第一页的前 4 句 —— 它们对应第一套时间轴的第 0~3 条
  const books = await api('GET', '/api/books', null, T.token);
  const bookA = books.find((b) => b.title.includes(BOOK_A));
  if (!bookA) { console.error(`书架里找不到「${BOOK_A}」`); process.exit(1); }
  const catA = await api('GET', `/api/books/${bookA.id}/catalog`, null, T.token);
  const pageA = catA.lessons[0].pages[0];
  const pageDetail = await api('GET', `/api/pages/${pageA.id}`, null, T.token);
  const hwItems = pageDetail.hotspots.slice(0, 4);

  for (const h of await api('GET', '/api/homeworks', null, T.token)) {
    await api('DELETE', `/api/homeworks/${h.id}`, null, T.token);
  }
  const hw = await api('POST', '/api/homeworks', {
    classId: cls.id, pageId: pageA.id, title: 'Lesson 1 前四句 跟读',
    note: '注意 name 的发音，录之前先听两遍原音。',
    hotspotIds: hwItems.map((h) => h.id),
  }, T.token);
  console.log(`作业已重建 (id=${hw.id})：${hwItems.map((h) => h.en).join(' / ')}`);

  /* ---------- 开录 ---------- */
  const browser = await chromium.launch({
    channel: 'chrome',
    args: ['--use-fake-ui-for-media-capture', '--use-fake-device-for-media-stream', '--hide-scrollbars'],
  });
  const context = await browser.newContext({
    viewport: { width: 430, height: 932 },
    deviceScaleFactor: 1,
    recordVideo: { dir: WORK, size: { width: 430, height: 932 } },
    permissions: ['microphone'],
    locale: 'zh-CN',
  });
  const page = await context.newPage();
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
  await page.reload({ waitUntil: 'networkidle' });
  await page.addStyleTag({ content: CAPTION_CSS });
  await page.evaluate(() => {
    const d = document.createElement('div'); d.id = 'demo-cap'; document.body.appendChild(d);
  });

  // 同步标记：录像从创建上下文就开始，包含加载过程。闪一帧纯黑，事后用 blackdetect 找零点。
  await page.evaluate(() => {
    const m = document.createElement('div');
    m.id = 'sync-marker';
    m.style.cssText = 'position:fixed;inset:0;background:#000;z-index:2147483647';
    document.body.appendChild(m);
  });
  await sleep(320);
  t0 = Date.now();
  await page.evaluate(() => document.getElementById('sync-marker').remove());
  await sleep(150);

  /* ===== 分镜 ===== */

  await cap(page, '英语教材点读 + 作业跟读打卡');
  await sleep(2000);
  await cap(page, '学生输入姓名和班级邀请码即可进入');
  await page.fill('#i-name', '李小明');
  await sleep(800);
  await page.click('[data-act="login"]');
  await page.waitForSelector('.hero', { timeout: 8000 });
  await sleep(300);

  await cap(page, '首页：<b>今日作业</b>、连续打卡、教材');
  await sleep(2800);
  await cap(page, '');
  await sleep(250);

  /* ---- 自编讲义点读 ---- */
  await page.click(`.booktile:has-text("${BOOK_A}")`);
  await page.waitForSelector('.listitem[data-go="reader"]');
  await sleep(600);
  await page.click('.listitem[data-go="reader"]');
  await page.waitForSelector('.hs', { timeout: 8000 });
  // 播放器默认就放课文音频，不需要切换
  await sleep(2300);                                    // 等提示条淡出，别压着字幕

  await cap(page, '点课文里<b>任意一句</b>，就出真人发音');
  await sleep(800);
  await tap(page, 0, 'demo', 0);
  await sleep(dur('demo', 0) + 700);
  await tap(page, 2, 'demo', 2);
  await sleep(dur('demo', 2) + 900);
  await cap(page, '');
  await sleep(250);

  /* ---- 教材页 ---- */
  if (showBook) {
    await page.click('.back');                          // -> 目录
    await page.waitForSelector('.listitem[data-go="reader"]', { timeout: 6000 });
    await sleep(350);
    await page.click('.back');                          // -> 书架
    await page.waitForSelector('.booktile', { timeout: 6000 });
    await cap(page, '机构自己的教材也能导进来');
    await sleep(1600);
    await page.click(`.booktile:has-text("${BOOK_B}")`);
    await page.waitForSelector('.listitem[data-go="reader"]', { timeout: 6000 });
    await sleep(900);
    await page.click(`.listitem:has-text("第 ${BOOK_PAGE_NO} 页")`);
    await page.waitForSelector('.hs', { timeout: 8000 });
    await sleep(700);

    await cap(page, 'PDF 自动切图 + <b>自动标注热区</b>，40 句全自动');
    await sleep(2200);
    await cap(page, '课本原页，点哪句读哪句');
    for (const [hsIdx, off] of [[2, 2], [4, 4], [6, 6]]) {
      await tap(page, hsIdx, 'book', BOOK_OFFSET + off);
      await sleep(dur('book', BOOK_OFFSET + off) + 800);
    }
    await cap(page, '<b>整页连读</b>，当前句自动高亮');
    const startAt = now() + 150;
    await page.click('[data-act="playAll"]');
    let acc = startAt;
    for (let i = 0; i < 3; i++) {
      audioEvents.push({ atMs: acc, src: 'book', idx: BOOK_OFFSET + i });
      acc += dur('book', BOOK_OFFSET + i) + 400;
    }
    await sleep(acc - now() + 200);
    await page.click('[data-act="playAll"]');
    await sleep(600);
    await cap(page, '');
    await sleep(250);

    await page.click('.back');
    await page.waitForSelector('.listitem[data-go="reader"]', { timeout: 6000 });
    await sleep(300);
    await page.click('.back');
    await page.waitForSelector('.tabbar button', { state: 'visible', timeout: 6000 });
  } else {
    await page.click('.back');
    await page.waitForSelector('.listitem[data-go="reader"]', { timeout: 6000 });
    await sleep(400);
    await page.click('.back');
    await page.waitForSelector('.tabbar button', { state: 'visible', timeout: 6000 });
  }
  await sleep(400);

  /* ---- 作业 ---- */
  await page.click('[data-go="hwlist"]');
  await page.waitForSelector('.hwitem', { timeout: 6000 });
  await cap(page, '老师布置的<b>跟读作业</b>');
  await sleep(1600);
  await page.click('.hwitem');
  await page.waitForSelector('.sentence', { timeout: 6000 });
  await sleep(500);

  await cap(page, '逐句听原音，再自己<b>跟读录音</b>');
  await page.click('[data-act="hwPlay"]');
  audioEvents.push({ atMs: now() + 120, src: 'demo', idx: 0 });
  await sleep(dur('demo', 0) + 600);

  try {
    await page.click('[data-act="hwRec"]');
    await sleep(2000);
    await page.click('[data-act="hwRec"]');
    await sleep(1100);
  } catch (e) { console.log('录音步骤跳过:', e.message); }

  await cap(page, '提交给老师');
  await page.click('[data-act="hwSubmit"]').catch(() => {});
  await page.waitForSelector('.hwitem', { timeout: 8000 }).catch(() => {});
  await sleep(1400);

  /* ---- 老师真的去批改（走接口，不是演的） ---- */
  const subs = await api('GET', `/api/homeworks/${hw.id}/submissions`, null, T.token);
  const row = subs.rows.find((r) => r.submissionId);
  if (row) {
    await api('POST', `/api/submissions/${row.submissionId}/review`,
      { stars: 4, reviewText: '读得不错，name 的 [eɪ] 再拉长一点。' }, T.token);
    console.log(`老师已批改 ${row.studentName} 的提交`);
  }
  await cap(page, '老师批改后，<b>学生和家长都看得到</b>');
  await page.click('[data-go="hwlist"]').catch(() => {});
  await sleep(1400);
  await page.click('.hwitem').catch(() => {});
  await page.waitForSelector('.sentence', { timeout: 6000 }).catch(() => {});
  await sleep(2800);

  /* ---- 打卡 ---- */
  await page.click('.back').catch(() => {});
  await page.waitForSelector('.tabbar button', { state: 'visible', timeout: 6000 }).catch(() => {});
  await sleep(300);
  await page.click('[data-go="me"]').catch(() => {});
  await page.waitForSelector('.calendar', { timeout: 6000 }).catch(() => {});
  await cap(page, '每天读满就<b>自动打卡</b>，连续天数一目了然');
  await sleep(3400);
  await cap(page, '');
  await sleep(700);

  const totalMs = now();
  await context.close();
  await browser.close();

  /* ---------- 合成音轨并转码 ---------- */
  const webm = fs.readdirSync(WORK).filter((f) => f.endsWith('.webm')).map((f) => path.join(WORK, f))[0];
  console.log(`录制完成 ${(totalMs / 1000).toFixed(1)}s，发音事件 ${audioEvents.length} 次`);

  const det = spawnSync('ffmpeg', ['-v', 'info', '-i', webm, '-vf', 'blackdetect=d=0.15:pix_th=0.05',
    '-an', '-f', 'null', '-'], { encoding: 'utf8' }).stderr || '';
  const mk = /black_end:([\d.]+)/.exec(det);
  const offset = mk ? parseFloat(mk[1]) : 1.3;
  console.log(`视频零点 = ${offset.toFixed(2)}s${mk ? '' : '（未检测到同步帧，用默认值）'}`);

  const segDir = path.join(WORK, 'seg');
  fs.mkdirSync(segDir, { recursive: true });
  const inputs = [], filters = [], labels = [];
  audioEvents.forEach((e, i) => {
    const t = SRC[e.src].T[e.idx];
    const at = Math.round(e.atMs + offset * 1000);
    const f = path.join(segDir, `s${i}.wav`);
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-ss', (t.startMs / 1000).toFixed(3),
      '-to', (t.endMs / 1000).toFixed(3), '-i', SRC[e.src].mp3, '-ac', '1', '-ar', '44100', f]);
    inputs.push('-i', f);
    filters.push(`[${i}:a]adelay=${at}|${at}[a${i}]`);
    labels.push(`[a${i}]`);
    console.log(`  ${(at / 1000).toFixed(2)}s  [${e.src}] ${t.en}`);
  });
  const wav = path.join(WORK, 'audio.wav');
  execFileSync('ffmpeg', ['-y', '-v', 'error', ...inputs, '-filter_complex',
    filters.join(';') + ';' + labels.join('') + `amix=inputs=${audioEvents.length}:normalize=0,volume=1.6[out]`,
    '-map', '[out]', '-t', String(totalMs / 1000 + offset + 0.6), wav]);

  const start = offset + 0.15;
  const mp4 = OUT + '.mp4';
  fs.mkdirSync(path.dirname(mp4), { recursive: true });
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-ss', String(start), '-i', webm,
    '-ss', String(start), '-i', wav,
    '-vf', 'scale=860:1864:flags=lanczos,fps=30',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '22', '-pix_fmt', 'yuv420p',
    '-profile:v', 'high', '-level', '4.0',
    '-c:a', 'aac', '-b:a', '96k', '-ar', '44100', '-movflags', '+faststart',
    '-t', String(totalMs / 1000 + 0.4), mp4]);
  fs.rmSync(WORK, { recursive: true, force: true });
  console.log(`\n成片 ${mp4}  ${(totalMs / 1000 + 0.4).toFixed(1)}s  ` +
    `${(fs.statSync(mp4).size / 1048576).toFixed(1)}MB  860x1864 H.264+AAC`);
})().catch((e) => { console.error('录制失败:', e.message); process.exit(1); });
