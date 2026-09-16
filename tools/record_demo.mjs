/**
 * 录一段体验版的演示视频（竖屏，可直接发微信）
 *
 *   cd static-demo/public && python3 -m http.server 8080 &   # 先把体验版跑起来
 *   npm i playwright                                          # 一次性，会用系统已装的 Chrome
 *   node tools/record_demo.mjs --url http://localhost:8080/ --out out/demo
 *
 * 做三件事：
 *   1. 用真实 Chrome 按下面的分镜操作体验版并录屏（Playwright 录屏不带声音）
 *   2. 记录每次触发发音的时刻，事后把课文音频按这些时刻混进去
 *   3. 开头闪一帧纯黑作同步标记，用 ffmpeg 的 blackdetect 校准零点，再转 H.264 + AAC
 *
 * 换了演示内容就改下面的分镜和 --timings / --audio。
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const HERE = path.dirname(fileURLToPath(import.meta.url));
const URL = arg('url', 'http://localhost:8080/');
const OUT = arg('out', 'out/demo');
const WORK = OUT + '_work';
fs.mkdirSync(WORK, { recursive: true });

// 课文时间轴（与 static-demo 的 mock-api.js 一致）
const TIMINGS = arg('timings', path.join(HERE, '../server/assets/demo_lesson1.json'));
const AUDIO = arg('audio', path.join(HERE, '../server/assets/demo_lesson1.mp3'));
const T = JSON.parse(fs.readFileSync(TIMINGS, 'utf8'));

const audioEvents = [];          // { atMs, idx }  视频第 atMs 毫秒响起第 idx 句
let t0 = 0;
const now = () => Date.now() - t0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CAPTION_CSS = `
#demo-cap{position:fixed;left:14px;right:14px;top:14px;z-index:99999;pointer-events:none;
  background:rgba(15,23,42,.90);color:#fff;border-radius:14px;padding:11px 15px;
  font:600 14.5px/1.5 system-ui,"PingFang SC","Noto Sans CJK SC",sans-serif;
  letter-spacing:.01em;box-shadow:0 8px 28px rgba(0,0,0,.28);
  opacity:0;transform:translateY(-6px);transition:opacity .28s,transform .28s;}
#demo-cap.on{opacity:1;transform:translateY(0)}
#demo-cap b{color:#7DD3FC;font-weight:700}
`;

async function setup(page) {
  await page.addStyleTag({ content: CAPTION_CSS });
  await page.evaluate(() => {
    const d = document.createElement('div');
    d.id = 'demo-cap';
    document.body.appendChild(d);
  });
}
const cap = (page, html) => page.evaluate((h) => {
  const d = document.getElementById('demo-cap');
  if (!h) { d.classList.remove('on'); return; }
  d.innerHTML = h; d.classList.add('on');
}, html);

/** 点一个热区，并登记这一句要在视频里响起来 */
async function tapSentence(page, hotspotIdx, sentenceIdx) {
  await page.click(`.hs[data-i="${hotspotIdx}"]`);
  audioEvents.push({ atMs: now() + 120, idx: sentenceIdx });
}

(async () => {
  const browser = await chromium.launch({
    channel: 'chrome',
    args: ['--use-fake-ui-for-media-capture', '--use-fake-device-for-media-stream', '--hide-scrollbars'],
  });
  const context = await browser.newContext({
    // Playwright 的录屏按 CSS 像素取帧，deviceScaleFactor 不会提高录制分辨率，
    // 所以直接用 app 的最大宽度 430 作为视口，导出时再放大。
    viewport: { width: 430, height: 932 },
    deviceScaleFactor: 1,
    recordVideo: { dir: WORK, size: { width: 430, height: 932 } },
    permissions: ['microphone'],
    locale: 'zh-CN',
  });
  const page = await context.newPage();
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
  await page.reload({ waitUntil: 'networkidle' });
  await setup(page);

  // 同步标记：录像从创建上下文就开始了，包含 t0 之前的加载过程。
  // 闪一帧纯黑，事后用 ffmpeg 的 blackdetect 找到它，作为视频里的零点。
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

  /* ---- 登录 ---- */
  await cap(page, '英语教材点读 + 作业跟读打卡 · <b>体验版</b>');
  await sleep(2200);
  await cap(page, '学生输入姓名和班级邀请码即可进入');
  await page.fill('#i-name', '李小明');
  await sleep(900);
  await page.click('[data-act="login"]');
  await page.waitForSelector('.hero', { timeout: 8000 });
  await sleep(400);

  /* ---- 首页 ---- */
  await cap(page, '首页：<b>今日作业</b>、连续打卡、教材');
  await sleep(3200);
  await cap(page, '');
  await sleep(300);

  /* ---- 进教材 ---- */
  await page.click('.booktile');
  await page.waitForSelector('.listitem[data-go="reader"]');
  await sleep(700);
  await page.click('.listitem[data-go="reader"]');
  await page.waitForSelector('.hs', { timeout: 8000 });
  await sleep(600);

  /* ---- 点读 ---- */
  await cap(page, '点课文里<b>任意一句</b>，就出真人发音');
  await sleep(900);
  await tapSentence(page, 0, 0);
  await sleep(3100);
  await tapSentence(page, 2, 2);
  await sleep(3400);
  await cap(page, '');
  await sleep(200);

  /* ---- 连播 ---- */
  await cap(page, '<b>整页连读</b>，当前句自动高亮');
  const playAllAt = now() + 150;
  await page.click('[data-act="playAll"]');
  // 播放器按顺序播，句间间隔 400ms
  let acc = playAllAt;
  for (let i = 0; i < 3; i++) {
    audioEvents.push({ atMs: acc, idx: i });
    acc += (T[i].endMs - T[i].startMs) + 400;
  }
  await sleep(acc - now() + 200);
  await page.click('[data-act="playAll"]');       // 停止
  await sleep(500);

  /* ---- 控件 ---- */
  await cap(page, '可显示热区框、切语速、开关中文');
  await page.click('[data-act="toggleHs"]');
  await sleep(1100);
  await page.click('[data-act="cycleRate"]');
  await sleep(1100);
  await page.click('[data-act="toggleHs"]');
  await sleep(600);
  await cap(page, '');
  await sleep(200);

  /* ---- 作业 ---- */
  await page.click('.back');                       // 点读页 -> 目录
  await page.waitForSelector('.listitem[data-go="reader"]', { timeout: 6000 });
  await sleep(500);
  await page.click('.back');                       // 目录 -> 书架（这一层才有底部导航）
  await page.waitForSelector('.tabbar button', { state: 'visible', timeout: 6000 });
  await sleep(400);
  await page.click('[data-go="hwlist"]');
  await page.waitForSelector('.hwitem', { timeout: 6000 });
  await cap(page, '老师布置的<b>跟读作业</b>');
  await sleep(1800);
  await page.click('.hwitem');
  await page.waitForSelector('.sentence', { timeout: 6000 });
  await sleep(600);

  await cap(page, '逐句听原音，再自己<b>跟读录音</b>');
  await page.click('[data-act="hwPlay"]');
  audioEvents.push({ atMs: now() + 120, idx: 0 });
  await sleep(3100);

  try {
    await page.click('[data-act="hwRec"]');
    await sleep(2200);
    await page.click('[data-act="hwRec"]');
    await sleep(1200);
  } catch (e) { console.log('录音步骤跳过:', e.message); }

  await cap(page, '提交给老师');
  await page.click('[data-act="hwSubmit"]').catch(() => {});
  await page.waitForSelector('.hwitem', { timeout: 6000 }).catch(() => {});
  await sleep(1500);

  /* ---- 批改回来 ---- */
  await cap(page, '老师批改后，<b>学生和家长都看得到</b>');
  await sleep(3200);
  await page.click('.hwitem').catch(() => {});
  await page.waitForSelector('.sentence', { timeout: 6000 }).catch(() => {});
  await sleep(2800);

  /* ---- 打卡 ---- */
  await page.click('.back').catch(() => {});       // 作业详情 -> 作业列表
  await page.waitForSelector('.tabbar button', { state: 'visible', timeout: 6000 }).catch(() => {});
  await sleep(400);
  await page.click('[data-go="me"]').catch(() => {});
  await page.waitForSelector('.calendar', { timeout: 6000 }).catch(() => {});
  await cap(page, '每天读满就<b>自动打卡</b>，连续天数一目了然');
  await sleep(3800);

  await cap(page, '全部记录只存在自己手机上 · 不上传');
  await sleep(2600);
  await cap(page, '');
  await sleep(600);

  const totalMs = now();
  await context.close();
  await browser.close();

  const webm = fs.readdirSync(WORK).filter((f) => f.endsWith('.webm')).map((f) => path.join(WORK, f))[0];
  console.log(`录制完成 ${(totalMs / 1000).toFixed(1)}s，发音事件 ${audioEvents.length} 次`);

  /* ---- 用黑帧标记校准视频零点 ---- */
  // blackdetect 的结果只出现在 stderr，且 ffmpeg 正常退出，所以要用 spawnSync 取
  const det = spawnSync('ffmpeg', ['-v', 'info', '-i', webm, '-vf', 'blackdetect=d=0.15:pix_th=0.05',
    '-an', '-f', 'null', '-'], { encoding: 'utf8' }).stderr || '';
  const mk = /black_end:([\d.]+)/.exec(det);
  const offset = mk ? parseFloat(mk[1]) : 1.3;
  console.log(`视频零点 = ${offset.toFixed(2)}s${mk ? '' : '（未检测到同步帧，用默认值）'}`);

  /* ---- 按事件时刻拼出音轨 ---- */
  const segDir = path.join(WORK, 'seg');
  fs.mkdirSync(segDir, { recursive: true });
  const inputs = [], filters = [], labels = [];
  audioEvents.forEach((e, i) => {
    const t = T[e.idx];
    const at = Math.round(e.atMs + offset * 1000);
    const f = path.join(segDir, `s${i}.wav`);
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-ss', (t.startMs / 1000).toFixed(3),
      '-to', (t.endMs / 1000).toFixed(3), '-i', AUDIO, '-ac', '1', '-ar', '44100', f]);
    inputs.push('-i', f);
    filters.push(`[${i}:a]adelay=${at}|${at}[a${i}]`);
    labels.push(`[a${i}]`);
    console.log(`  ${(at / 1000).toFixed(2)}s  ${t.en}`);
  });
  const wav = path.join(WORK, 'audio.wav');
  execFileSync('ffmpeg', ['-y', '-v', 'error', ...inputs, '-filter_complex',
    filters.join(';') + ';' + labels.join('') + `amix=inputs=${audioEvents.length}:normalize=0,volume=1.6[out]`,
    '-map', '[out]', '-t', String(totalMs / 1000 + offset + 0.6), wav]);

  /* ---- 剪掉开头的加载过程，转成 mp4 ---- */
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
})();
