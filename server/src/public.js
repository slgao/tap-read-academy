'use strict';
/**
 * 对外公开的宣传页（不需要登录），服务端直接渲染 HTML：
 *   /s/<token>  单个喜报或作品，底部带预约试听
 *   /gallery    书法作品展：被评为优秀、且仍在分享中的书法作品
 *   /trial      预约试听
 *
 * 为什么服务端渲染：微信取分享卡片的标题、说明、缩略图时，读的是页面里的 meta 标签，
 * 每个分享都要带上自己的标题和图片，必须在页面源码里就写好。
 */
const crypto = require('node:crypto');
const repo = require('./repo');
const store = require('./storage');

const SCHOOL = '福斯特培训学校';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function originOf(req) {
  const proto = String(req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http')).split(',')[0].trim();
  return `${proto}://${req.headers.host}`;
}

function visitorId(req, res) {
  const m = /(?:^|;\s*)trv=([a-f0-9]{24})/.exec(req.headers.cookie || '');
  if (m) return m[1];
  const id = crypto.randomBytes(12).toString('hex');
  const secure = originOf(req).startsWith('https') ? '; Secure' : '';
  res.setHeader('Set-Cookie', `trv=${id}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly${secure}`);
  return id;
}

function page(req, { title, description, image, body, bodyClass = '' }) {
  const origin = originOf(req);
  const img = image ? (image.startsWith('http') ? image : origin + image) : origin + '/brand/share-500.jpg';
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${SCHOOL}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${esc(img)}">
<meta itemprop="name" content="${esc(title)}">
<meta itemprop="description" content="${esc(description)}">
<meta itemprop="image" content="${esc(img)}">
<meta name="twitter:card" content="summary">
<meta name="twitter:image" content="${esc(img)}">
<link rel="icon" type="image/png" href="/brand/favicon-48.png">
<link rel="stylesheet" href="/styles.css">
</head>
<body class="pub ${bodyClass}">
<div hidden aria-hidden="true"><img src="${esc(img)}" alt="" width="500" height="500"></div>
<div id="app" class="pub-app">
  <header class="pub-head">
    <img src="/brand/logo-96.png" alt="" width="36" height="36">
    <div><div class="pub-school">${SCHOOL}</div><div class="pub-en">FIRST TRAINING SCHOOL</div></div>
  </header>
  <main class="pub-main">${body}</main>
</div>
<div id="toast"></div>
<script src="/public-page.js"></script>
</body>
</html>`;
}

/** 科目 + 科目下面的具体课程；勾了科目才展开它的课程 */
async function subjectChips(selected) {
  const subs = await repo.subjects.all();
  const cs = await repo.courses.publicList();      // 只放负责人勾选过的课程
  return subs.map((x) => {
    const on = selected.includes(x.code);
    const list = cs.filter((c) => c.subjectId === x.id);
    return `<div class="subj-block">
      <label class="chip ${x.color}"><input type="checkbox" name="subjects" value="${esc(x.code)}" data-subject="${esc(x.code)}"${on ? ' checked' : ''}><span>${esc(x.name)}</span></label>
      ${list.length ? `<div class="course-chips" data-for="${esc(x.code)}"${on ? '' : ' hidden'}>
        ${list.map((c) => `<label class="chip sm"><input type="checkbox" name="courses" value="${c.id}"><span>${esc(c.name)}</span></label>`).join('')}
      </div>` : ''}
    </div>`;
  }).join('');
}

/** 页脚的联系方式：电话、地址、微信二维码 */
async function contactBlock() {
  const c = (await repo.settings.get('contact', null)) || {};
  const qr = c.qrId ? await repo.assets.byId(c.qrId) : null;
  if (!c.phone && !c.address && !qr) return '';
  return `<section class="card pub-contact">
    <h2 class="section-title">联系我们</h2>
    ${c.phone ? `<p class="contact-line"><b>电话</b><a href="tel:${esc(c.phone)}">${esc(c.phone)}</a></p>` : ''}
    ${c.address ? `<p class="contact-line"><b>地址</b><span>${esc(c.address)}</span></p>` : ''}
    ${c.hours ? `<p class="contact-line"><b>时间</b><span>${esc(c.hours)}</span></p>` : ''}
    ${qr ? `<div class="contact-qr"><img src="${esc(store.urlOf(qr.relPath))}" alt="微信二维码" loading="lazy">
      <span class="muted">长按二维码加微信</span></div>` : ''}
    ${c.note ? `<p class="muted">${esc(c.note)}</p>` : ''}
  </section>`;
}

async function leadForm({ token = '', source = 'share', subjectCode = '' }) {
  const sub = subjectCode ? await repo.subjects.byCode(subjectCode) : null;
  const grades = ['一年级', '二年级', '三年级', '四年级', '五年级', '六年级', '初一', '初二', '初三', '其他'];
  return `
  <section class="card pub-form" id="trial">
    <h2 class="section-title">${sub ? `想让孩子也来学${esc(sub.name)}？` : '想让孩子也来试试？'}</h2>
    <p class="muted">留下联系方式，${SCHOOL}的老师会联系您安排一节试听课。</p>
    <form id="lead-form" data-token="${esc(token)}" data-source="${esc(source)}" novalidate>
      <label class="field"><span>孩子年级</span>
        <select name="grade" required><option value="">请选择</option>${grades.map((g) => `<option>${g}</option>`).join('')}</select></label>
      <div class="field"><span>想了解的科目</span><div class="subj-picker">${await subjectChips(subjectCode ? [subjectCode] : [])}</div></div>
      <label class="field"><span>家长手机号</span><input name="phone" type="tel" inputmode="numeric" maxlength="13" placeholder="11 位手机号" autocomplete="tel"></label>
      <label class="field"><span>方便联系的时间</span>
        <select name="contactTime"><option>都可以</option><option>工作日白天</option><option>工作日晚上</option><option>周末</option></select></label>
      <label class="field"><span>想告诉老师的话（可不填）</span>
        <textarea name="message" rows="2" maxlength="300" placeholder="比如：孩子几年级、哪里想提高、方便试听的时间"></textarea></label>
      <label class="agree"><input type="checkbox" name="agree"> <span>同意${SCHOOL}的老师通过电话联系我。手机号只用于预约试听，不会给其他人。</span></label>
      <button class="btn block" type="submit">预约试听</button>
    </form>
    <div class="pub-done" hidden><b>已收到预约</b><p class="muted">老师会尽快联系您，请留意来电。</p></div>
    <p class="pub-slogan">成为孩子期待的一堂课</p>
  </section>`;
}

function notFound(req, res, msg) {
  const html = page(req, {
    title: `${SCHOOL}`, description: '点读课文、英语听力、各科作业、每日打卡',
    body: `<section class="card center"><h2 class="section-title">${esc(msg)}</h2>
      <p class="muted">可以看看其他同学的作品，或者预约一节试听课。</p>
      <p><a class="btn ghost" href="/gallery">书法作品展</a> <a class="btn" href="/trial">预约试听</a></p></section>`,
  });
  send(res, 404, html);
}

function send(res, code, html) {
  const buf = Buffer.from(html);
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': buf.length, 'Cache-Control': 'no-cache' });
  res.end(buf);
}

async function sharePage(req, res, url, token) {
  const share = await repo.shares.byToken(token);
  if (!share) return notFound(req, res, '没有找到这个分享');
  if (share.status !== 'active') return notFound(req, res, '这个分享已经被家长撤回了');

  const guide = url.searchParams.get('guide') === '1';
  if (!guide) {
    const v = visitorId(req, res);
    await repo.shares.addView(share.id, v);                 // 分享者自己第一次打开（带 guide）不计入浏览
  }
  const subject = share.subjectId ? await repo.subjects.byId(share.subjectId) : null;
  const img = store.urlOf(share.imagePath);
  const assets = await repo.assets.byIds(share.photoIds);
  const photos = share.photoIds.map((id) => assets.get(Number(id))).filter(Boolean).map((a) => store.urlOf(a.relPath));

  const isWork = share.type === 'work';
  const desc = share.comment ? `老师评语：${share.comment}` : (isWork ? '来看看孩子的书法作品' : '孩子的作业被评为优秀');
  const body = `
    <section class="pub-hero">
      <img class="pub-poster" src="${esc(img)}" alt="${esc(share.title)}">
    </section>
    ${isWork && photos.length ? `<section class="card">
      <h2 class="section-title">作品原图</h2>
      <div class="pub-photos">${photos.map((u) => `<button class="pub-photo" data-src="${esc(u)}"><img src="${esc(u)}" alt="作品照片" loading="lazy"></button>`).join('')}</div>
    </section>` : ''}
    ${share.comment ? `<section class="card"><h2 class="section-title">老师评语</h2>
      <p class="pub-comment">${esc(share.comment)}</p>
      ${share.stars ? `<div class="stars">${'★'.repeat(share.stars)}<span class="off">${'★'.repeat(5 - share.stars)}</span></div>` : ''}</section>` : ''}
    ${subject && subject.code === 'calli' ? `<section class="card pub-links">
      <a class="btn ghost block" href="/gallery">看看更多书法作品</a>
    </section>` : ''}
    ${await leadForm({ token: share.token, source: 'share', subjectCode: subject ? subject.code : '' })}
    ${await contactBlock()}
    ${guide ? `<div class="share-guide" id="share-guide" role="dialog" aria-label="分享方法">
        <div class="arrow"></div>
        <div class="tip"><b>点右上角「···」</b><br>选「发送给朋友」或「分享到朋友圈」</div>
        <button class="btn star" data-close-guide>知道了</button>
      </div>` : ''}`;
  send(res, 200, page(req, { title: `${share.title} · ${SCHOOL}`, description: desc, image: img, body }));
}

async function galleryPage(req, res) {
  const calli = await repo.subjects.byCode('calli');
  // 「在分享中 + 被评为优秀」由一条 SQL 过滤，图片一次取完
  const rows = calli ? await repo.shares.galleryRows(calli.id) : [];
  const assets = await repo.assets.byIds(rows.map((s) => s.photoIds[0]));
  const works = [];
  for (const s of rows) {
    const a = assets.get(Number(s.photoIds[0]));
    if (!a) continue;
    works.push({ token: s.token, title: s.title, photo: store.urlOf(a.relPath), comment: s.comment });
  }
  const body = `
    <section class="pub-intro">
      <h1>书法作品展</h1>
      <p class="muted">${SCHOOL}同学们的优秀书法作品，每一幅都经过老师点评。</p>
    </section>
    ${works.length ? `<section class="pub-grid">${works.map((w) => `
      <a class="pub-work" href="/s/${esc(w.token)}">
        <img src="${esc(w.photo)}" alt="${esc(w.title)}" loading="lazy">
        <b>${esc(w.title.replace(/的书法作品$/, ''))}</b>
        ${w.comment ? `<span>${esc(w.comment.slice(0, 26))}${w.comment.length > 26 ? '…' : ''}</span>` : ''}
      </a>`).join('')}</section>`
    : `<section class="card center"><p class="muted">作品正在陆续上墙，过几天再来看看。</p></section>`}
    ${await leadForm({ source: 'gallery', subjectCode: 'calli' })}
    ${await contactBlock()}`;
  send(res, 200, page(req, {
    title: `书法作品展 · ${SCHOOL}`, description: `${SCHOOL}同学们的优秀书法作品`,
    image: works[0] ? works[0].photo : null, body,
  }));
}

async function aboutPage(req, res) {
  const a = (await repo.settings.get('about', null)) || {};
  const images = [];
  for (const id of a.imageIds || []) { const x = await repo.assets.byId(id); if (x) images.push(store.urlOf(x.relPath)); }
  const title = a.title || SCHOOL;
  const text = String(a.text || '').trim();
  const body = `
    <section class="pub-intro">
      <h1>${esc(title)}</h1>
      <p class="muted">成为孩子期待的一堂课</p>
    </section>
    ${images.length ? `<section class="pub-photos about-photos">${images.map((u) => `<button class="pub-photo wide" data-src="${esc(u)}"><img src="${esc(u)}" alt="学校照片" loading="lazy"></button>`).join('')}</section>` : ''}
    ${text ? `<section class="card"><div class="about-text">${text.split(/\n+/).map((line) => `<p>${esc(line)}</p>`).join('')}</div></section>`
      : '<section class="card center"><p class="muted">简介整理中，欢迎先预约一节试听课。</p></section>'}
    ${await contactBlock()}
    ${await leadForm({ source: 'trial' })}`;
  send(res, 200, page(req, { title: `${title} · 学校简介`, description: text.slice(0, 60) || `${SCHOOL}，成为孩子期待的一堂课`,
    image: images[0] || null, body }));
}

async function trialPage(req, res) {
  const body = `
    <section class="pub-intro">
      <h1>预约试听</h1>
      <p class="muted">英语、语文、数学、书法、作业班，留下联系方式，老师为孩子安排一节试听课。</p>
    </section>
    ${await leadForm({ source: 'trial' })}
    ${await contactBlock()}`;
  send(res, 200, page(req, { title: `预约试听 · ${SCHOOL}`, description: '英语、语文、数学、书法、作业班，预约一节试听课', body }));
}

/** 返回 true 表示已处理 */
async function handlePublic(req, res, url) {
  const p = url.pathname;
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  try {
    const m = /^\/s\/([a-f0-9]{20})\/?$/.exec(p);
    if (m) { await sharePage(req, res, url, m[1]); return true; }
    if (p === '/s' || p.startsWith('/s/')) { notFound(req, res, '没有找到这个分享'); return true; }
    if (p === '/gallery') { await galleryPage(req, res); return true; }
    if (p === '/trial') { await trialPage(req, res); return true; }
    if (p === '/about') { await aboutPage(req, res); return true; }
  } catch (e) {
    console.error('[public error]', p, e);
    send(res, 500, '<p>页面暂时打不开，请稍后再试</p>');
    return true;
  }
  return false;
}

module.exports = { handlePublic, esc };
