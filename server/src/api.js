'use strict';
/**
 * 业务接口层 —— 这里没有一句 SQL，也不碰文件系统。
 * 数据走 repo.js，文件走 storage.js。迁移到微信云开发时本文件不需要改动。
 */
const repo = require('./repo');
const store = require('./storage');
const { ok, fail, readBody, rid, today, inviteCode } = require('./util');

const CHECKIN_SECONDS = 60;   // 当日有效点读满 60 秒即算打卡（PRD 正式值为 5 分钟，demo 调小便于体验）

/* ---------- 视图辅助 ---------- */
async function assetView(id) {
  const a = await repo.assets.byId(id);
  return a ? { id: a.id, url: store.urlOf(a.relPath), durationMs: a.durationMs, placeholder: a.placeholder } : null;
}

/** 落盘 + 建资产记录，返回资产视图用的 id */
async function putAsset(kind, base64, ext, opts = {}) {
  const { relPath, size } = await store.save(kind, base64, ext);
  const durationMs = opts.durationMs != null ? opts.durationMs
    : (kind === 'image' ? 0 : await store.probeDurationMs(relPath));
  const asset = await repo.assets.create({
    kind, relPath, mime: opts.mime || '', durationMs, sizeBytes: size, placeholder: opts.placeholder,
  });
  return { asset, relPath };
}

async function userFromToken(req) {
  const h = req.headers['authorization'] || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : (h || '');
  return token ? repo.users.byToken(token) : null;
}

const publicUser = (u) => ({ id: u.id, role: u.role, name: u.name, stars: u.stars, streak: u.streak, lastCheckin: u.lastCheckin });

/* ---------- 路由表 ---------- */
const routes = [];
const on = (method, pattern, handler, opts = {}) =>
  routes.push({ method, parts: pattern.split('/').filter(Boolean), handler, auth: opts.auth !== false, roles: opts.roles });

/* auth */
on('POST', '/api/auth/dev-login', async (ctx) => {
  const { role = 'student', name, inviteCode: code } = ctx.body;
  if (!name || !String(name).trim()) return fail(ctx.res, 1001, '请填写姓名');
  const r = ['student', 'teacher', 'admin'].includes(role) ? role : 'student';
  // 设置了 TEACHER_CODE 时，老师和管理员登录必须带口令 —— 否则公网上任何人输入老师姓名就能进后台
  const need = process.env.TEACHER_CODE;
  if (need && r !== 'student' && String(ctx.body.teacherCode || '') !== need) {
    return fail(ctx.res, 2001, '老师口令不正确');
  }
  const nm = String(name).trim();

  let user = await repo.users.byNameRole(nm, r);
  if (!user) user = await repo.users.create({ openid: 'dev_' + rid().slice(0, 12), role: r, name: nm });

  if (code) {
    const cls = await repo.classes.byInviteCode(String(code).toUpperCase().trim());
    if (!cls) return fail(ctx.res, 3001, '班级邀请码不存在');
    if (r === 'student') await repo.classes.addMember(cls.id, user.id);
  }
  const token = rid() + rid();
  await repo.sessions.create(token, user.id);
  ok(ctx.res, { token, user: publicUser(user) });
}, { auth: false });

on('GET', '/api/me', async (ctx) => {
  const ids = await repo.classes.idsForUser(ctx.user);
  const classes = [];
  for (const id of ids) {
    const c = await repo.classes.byId(id);
    if (c) classes.push({ id: c.id, name: c.name, inviteCode: c.inviteCode });
  }
  ok(ctx.res, { user: publicUser(ctx.user), classes });
});

/* 班级 */
on('GET', '/api/classes', async (ctx) => {
  const ids = await repo.classes.idsForUser(ctx.user);
  const rows = [];
  for (const id of ids) {
    const c = await repo.classes.byId(id);
    if (!c) continue;
    rows.push({ id: c.id, name: c.name, inviteCode: c.inviteCode, teacherId: c.teacherId,
      studentCount: await repo.classes.memberCount(id) });
  }
  ok(ctx.res, rows);
});

on('POST', '/api/classes', async (ctx) => {
  const name = String(ctx.body.name || '').trim();
  if (!name) return fail(ctx.res, 1001, '请填写班级名');
  let code; let guard = 0;
  do { code = inviteCode(); guard++; } while (await repo.classes.inviteCodeTaken(code) && guard < 20);

  const cls = await repo.classes.create({ name, inviteCode: code, teacherId: ctx.user.id });
  // 新班级默认可见全部教材（MVP 简化）
  for (const b of await repo.books.all()) await repo.books.grantToClass(b.id, cls.id);
  ok(ctx.res, { id: cls.id, name: cls.name, inviteCode: cls.inviteCode });
}, { roles: ['teacher', 'admin'] });

on('POST', '/api/classes/join', async (ctx) => {
  const cls = await repo.classes.byInviteCode(String(ctx.body.inviteCode || '').toUpperCase().trim());
  if (!cls) return fail(ctx.res, 3001, '班级邀请码不存在');
  await repo.classes.addMember(cls.id, ctx.user.id);
  ok(ctx.res, { id: cls.id, name: cls.name });
});

on('GET', '/api/classes/:id/students', async (ctx) => {
  ok(ctx.res, await repo.classes.members(ctx.params.id));
});

/* 内容：书架 / 目录 / 页面 */
on('GET', '/api/books', async (ctx) => {
  const out = [];
  for (const b of await repo.books.listActive()) {
    out.push({ id: b.id, title: b.title, subtitle: b.subtitle, grade: b.grade, cover: b.cover,
      lessonCount: await repo.books.lessonCount(b.id), pageCount: await repo.books.pageCount(b.id) });
  }
  ok(ctx.res, out);
});

on('GET', '/api/books/:id/catalog', async (ctx) => {
  const book = await repo.books.byId(ctx.params.id);
  if (!book) return fail(ctx.res, 3002, '教材不存在');
  const lessons = [];
  for (const l of await repo.lessons.byBook(book.id)) {
    const pages = [];
    for (const p of await repo.pages.byLesson(l.id)) {
      pages.push({ id: p.id, pageNo: p.pageNo, hotspotCount: await repo.hotspots.countByPage(p.id) });
    }
    lessons.push({ id: l.id, title: l.title, sort: l.sort, pages });
  }
  ok(ctx.res, { book: { id: book.id, title: book.title, subtitle: book.subtitle, grade: book.grade }, lessons });
});

on('GET', '/api/pages/:id', async (ctx) => {
  const page = await repo.pages.byId(ctx.params.id);
  if (!page) return fail(ctx.res, 3003, '页面不存在');
  const lesson = await repo.lessons.byId(page.lessonId);
  const book = await repo.books.byId(lesson.bookId);
  const siblings = await repo.pages.idsByLesson(page.lessonId);
  const idx = siblings.indexOf(page.id);

  const hotspots = [];
  for (const h of await repo.hotspots.byPage(page.id)) {
    hotspots.push({ id: h.id, x: h.x, y: h.y, w: h.w, h: h.h,
      startMs: h.startMs, endMs: h.endMs, en: h.en, cn: h.cn, type: h.type,
      audio: await assetView(h.audioId) });
  }
  ok(ctx.res, {
    page: { id: page.id, pageNo: page.pageNo, imgW: page.imgW, imgH: page.imgH, img: await assetView(page.imgId) },
    lesson: { id: lesson.id, title: lesson.title, audio: await assetView(lesson.audioId) },
    book: { id: book.id, title: book.title },
    prevPageId: idx > 0 ? siblings[idx - 1] : null,
    nextPageId: idx >= 0 && idx < siblings.length - 1 ? siblings[idx + 1] : null,
    hotspots,
  });
});

/* 听力：只列出有课文音频的课；整课连续播放，靠时间轴判断当前在哪一句 */
on('GET', '/api/listening', async (ctx) => {
  const out = [];
  for (const b of await repo.books.listActive()) {
    const lessons = [];
    for (const l of await repo.lessons.byBook(b.id)) {
      const audio = await assetView(l.audioId);
      if (!audio) continue;
      let count = 0;
      for (const p of await repo.pages.byLesson(l.id)) {
        count += (await repo.hotspots.byPage(p.id)).filter((h) => h.endMs > h.startMs).length;
      }
      if (count) lessons.push({ id: l.id, title: l.title, durationMs: audio.durationMs, sentenceCount: count });
    }
    if (lessons.length) out.push({ bookId: b.id, bookTitle: b.title, lessons });
  }
  ok(ctx.res, out);
});

on('GET', '/api/lessons/:id/transcript', async (ctx) => {
  const lesson = await repo.lessons.byId(ctx.params.id);
  if (!lesson) return fail(ctx.res, 3007, '课不存在');
  const audio = await assetView(lesson.audioId);
  if (!audio) return fail(ctx.res, 3010, '这一课还没有音频');
  const book = await repo.books.byId(lesson.bookId);
  const sentences = [];
  for (const p of await repo.pages.byLesson(lesson.id)) {
    for (const h of await repo.hotspots.byPage(p.id)) {
      if (h.endMs > h.startMs) {
        sentences.push({ id: h.id, pageNo: p.pageNo, en: h.en, cn: h.cn, startMs: h.startMs, endMs: h.endMs });
      }
    }
  }
  sentences.sort((a, b) => a.startMs - b.startMs);
  ok(ctx.res, {
    lesson: { id: lesson.id, title: lesson.title, audio },
    book: { id: book.id, title: book.title },
    sentences,
  });
});

/* 学习时长 / 打卡 */
on('POST', '/api/study/heartbeat', async (ctx) => {
  const sec = Math.max(0, Math.min(120, Number(ctx.body.seconds) || 0));
  const d = today();
  const row = await repo.checkins.addSeconds(ctx.user.id, d, sec);

  let justChecked = false;
  if (row.seconds >= CHECKIN_SECONDS && ctx.user.lastCheckin !== d) {
    const yest = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const streak = ctx.user.lastCheckin === yest ? (ctx.user.streak || 0) + 1 : 1;
    const gainedStars = Math.max(1, Math.round(row.seconds / 60));
    await repo.users.markCheckin(ctx.user.id, { date: d, streak, gainedStars });
    await repo.checkins.setStars(ctx.user.id, d, gainedStars);
    justChecked = true;
  }
  const u = await repo.users.byId(ctx.user.id);
  ok(ctx.res, { todaySeconds: row.seconds, needSeconds: CHECKIN_SECONDS,
    checkedInToday: u.lastCheckin === d, justChecked, streak: u.streak, stars: u.stars });
});

on('GET', '/api/study/summary', async (ctx) => {
  const days = await repo.checkins.recent(ctx.user.id, 30);
  const u = await repo.users.byId(ctx.user.id);
  ok(ctx.res, {
    streak: u.streak, stars: u.stars, checkedInToday: u.lastCheckin === today(),
    totalMinutes: Math.round(days.reduce((s, d) => s + d.seconds, 0) / 60),
    days, needSeconds: CHECKIN_SECONDS,
  });
});

/* 作业 */
on('POST', '/api/homeworks', async (ctx) => {
  const { classId, title, pageId, hotspotIds, note, deadline } = ctx.body;
  if (!classId || !title || !pageId || !Array.isArray(hotspotIds) || !hotspotIds.length) {
    return fail(ctx.res, 1001, '缺少参数：班级 / 标题 / 页面 / 句子');
  }
  const page = await repo.pages.byId(pageId);
  if (!page) return fail(ctx.res, 3003, '页面不存在');
  const lesson = await repo.lessons.byId(page.lessonId);
  const hw = await repo.homeworks.create({
    classId, teacherId: ctx.user.id, title: String(title), type: 'follow_read',
    bookId: lesson.bookId, pageId: page.id, hotspotIds, note, deadline,
  });
  ok(ctx.res, { id: hw.id });
}, { roles: ['teacher', 'admin'] });

async function hwBrief(hw, user) {
  const cls = await repo.classes.byId(hw.classId);
  const out = {
    id: hw.id, title: hw.title, className: cls ? cls.name : '', classId: hw.classId,
    pageId: hw.pageId, itemCount: hw.hotspotIds.length, note: hw.note,
    deadline: hw.deadline, createdAt: hw.createdAt,
  };
  if (user.role === 'student') {
    const sub = await repo.submissions.byHomeworkAndStudent(hw.id, user.id);
    out.status = sub ? sub.status : 'todo';
    out.stars = sub ? sub.stars : null;
    out.reviewText = sub ? sub.reviewText : null;
    out.submissionId = sub ? sub.id : null;
  } else {
    out.submitted = await repo.submissions.countByHomework(hw.id);
    out.reviewed = await repo.submissions.countReviewed(hw.id);
    out.total = await repo.classes.memberCount(hw.classId);
  }
  return out;
}

on('GET', '/api/homeworks', async (ctx) => {
  const ids = await repo.classes.idsForUser(ctx.user);
  const rows = await repo.homeworks.byClassIds(ids);
  const out = [];
  for (const hw of rows) out.push(await hwBrief(hw, ctx.user));
  ok(ctx.res, out);
});

on('GET', '/api/homeworks/:id', async (ctx) => {
  const hw = await repo.homeworks.byId(ctx.params.id);
  if (!hw) return fail(ctx.res, 3004, '作业不存在');

  const items = [];
  for (const hid of hw.hotspotIds) {
    const h = await repo.hotspots.byId(hid);
    if (!h) continue;
    items.push({ hotspotId: h.id, en: h.en, cn: h.cn, startMs: h.startMs, endMs: h.endMs, audio: await assetView(h.audioId) });
  }

  const page = await repo.pages.byId(hw.pageId);
  const lesson = page ? await repo.lessons.byId(page.lessonId) : null;
  const lessonAudio = lesson ? await assetView(lesson.audioId) : null;

  const out = { ...(await hwBrief(hw, ctx.user)), items, lessonAudio };
  if (ctx.user.role === 'student') {
    const sub = await repo.submissions.byHomeworkAndStudent(hw.id, ctx.user.id);
    if (sub) {
      const subItems = [];
      for (const it of await repo.submissionItems.bySubmission(sub.id)) {
        subItems.push({ hotspotId: it.hotspotId, audio: await assetView(it.assetId) });
      }
      out.mySubmission = { id: sub.id, status: sub.status, stars: sub.stars,
        reviewText: sub.reviewText, submittedAt: sub.submittedAt, items: subItems };
    }
  }
  ok(ctx.res, out);
});

on('POST', '/api/homeworks/:id/submit', async (ctx) => {
  const hw = await repo.homeworks.byId(ctx.params.id);
  if (!hw) return fail(ctx.res, 3004, '作业不存在');
  const items = Array.isArray(ctx.body.items) ? ctx.body.items : [];
  if (!items.length) return fail(ctx.res, 1001, '没有录音内容');

  let sub = await repo.submissions.byHomeworkAndStudent(hw.id, ctx.user.id);
  if (sub && sub.status === 'reviewed') return fail(ctx.res, 3005, '作业已批改，如需重交请让老师打回');
  if (!sub) {
    sub = await repo.submissions.create({ homeworkId: hw.id, studentId: ctx.user.id, elapsedSec: ctx.body.elapsedSec });
  } else {
    await repo.submissions.markResubmitted(sub.id, ctx.body.elapsedSec);
    await repo.submissionItems.clear(sub.id);
  }
  for (const it of items) {
    if (!it.audioBase64) continue;
    const { asset } = await putAsset('rec', it.audioBase64, it.ext || 'webm', { durationMs: Number(it.durationMs) || null });
    await repo.submissionItems.add({ submissionId: sub.id, hotspotId: it.hotspotId,
      assetId: asset.id, durationMs: it.durationMs });
  }
  await repo.users.addStars(ctx.user.id, 5);
  ok(ctx.res, { submissionId: sub.id });
});

on('DELETE', '/api/homeworks/:id', async (ctx) => {
  const hw = await repo.homeworks.byId(ctx.params.id);
  if (!hw) return fail(ctx.res, 3004, '作业不存在');
  await repo.homeworks.remove(hw.id);
  ok(ctx.res, { ok: true });
}, { roles: ['teacher', 'admin'] });

on('GET', '/api/homeworks/:id/submissions', async (ctx) => {
  const hw = await repo.homeworks.byId(ctx.params.id);
  if (!hw) return fail(ctx.res, 3004, '作业不存在');
  const rows = [];
  for (const m of await repo.classes.members(hw.classId)) {
    const sub = await repo.submissions.byHomeworkAndStudent(hw.id, m.id);
    const items = [];
    if (sub) {
      for (const it of await repo.submissionItems.bySubmission(sub.id)) {
        const h = await repo.hotspots.byId(it.hotspotId);
        items.push({ hotspotId: it.hotspotId, en: h ? h.en : '', cn: h ? h.cn : '', audio: await assetView(it.assetId) });
      }
    }
    rows.push({
      studentId: m.id, studentName: m.name,
      status: sub ? sub.status : 'todo',
      submissionId: sub ? sub.id : null,
      submittedAt: sub ? sub.submittedAt : null,
      stars: sub ? sub.stars : null,
      reviewText: sub ? sub.reviewText : null,
      items,
    });
  }
  ok(ctx.res, { homework: await hwBrief(hw, ctx.user), rows });
}, { roles: ['teacher', 'admin'] });

on('POST', '/api/submissions/:id/review', async (ctx) => {
  const sub = await repo.submissions.byId(ctx.params.id);
  if (!sub) return fail(ctx.res, 3006, '提交记录不存在');
  const stars = Math.max(1, Math.min(5, Number(ctx.body.stars) || 5));
  await repo.submissions.review(sub.id, { stars, reviewText: String(ctx.body.reviewText || '') });
  await repo.users.addStars(sub.studentId, stars * 2);
  ok(ctx.res, { ok: true });
}, { roles: ['teacher', 'admin'] });

on('POST', '/api/submissions/:id/reject', async (ctx) => {
  const sub = await repo.submissions.byId(ctx.params.id);
  if (!sub) return fail(ctx.res, 3006, '提交记录不存在');
  await repo.submissions.reject(sub.id, String(ctx.body.reviewText || '请重新录一次'));
  ok(ctx.res, { ok: true });
}, { roles: ['teacher', 'admin'] });

/* ---------- 内容后台 ---------- */
on('POST', '/api/admin/books', async (ctx) => {
  const { title, subtitle, grade } = ctx.body;
  if (!title) return fail(ctx.res, 1001, '缺少教材名');
  const book = await repo.books.create({ title: String(title), subtitle, grade });
  for (const c of await repo.classes.all()) await repo.books.grantToClass(book.id, c.id);
  ok(ctx.res, { id: book.id });
}, { roles: ['teacher', 'admin'] });

on('POST', '/api/admin/lessons', async (ctx) => {
  const { bookId, title } = ctx.body;
  if (!bookId || !title) return fail(ctx.res, 1001, '缺少参数');
  const sort = (await repo.lessons.countByBook(bookId)) + 1;
  const lesson = await repo.lessons.create({ bookId, title: String(title), sort });
  ok(ctx.res, { id: lesson.id });
}, { roles: ['teacher', 'admin'] });

on('POST', '/api/admin/lessons/:id/audio', async (ctx) => {
  const lesson = await repo.lessons.byId(ctx.params.id);
  if (!lesson) return fail(ctx.res, 3007, '课不存在');
  const { asset } = await putAsset('audio', ctx.body.base64, ctx.body.ext || 'mp3',
    { mime: ctx.body.mime || 'audio/mpeg' });
  await repo.lessons.setAudio(lesson.id, asset.id);
  ok(ctx.res, { asset: await assetView(asset.id) });
}, { roles: ['teacher', 'admin'] });

on('POST', '/api/admin/pages', async (ctx) => {
  const { lessonId, pageNo } = ctx.body;
  if (!lessonId || !ctx.body.imageBase64) return fail(ctx.res, 1001, '缺少课 ID 或图片');
  const { asset, relPath } = await putAsset('image', ctx.body.imageBase64, ctx.body.ext || 'png', { durationMs: 0 });
  const { w, h } = await store.imageSize(relPath);
  const sort = (await repo.pages.countByLesson(lessonId)) + 1;
  const page = await repo.pages.create({
    lessonId, pageNo: Number(pageNo) || sort, imgId: asset.id, imgW: w, imgH: h, sort,
  });
  ok(ctx.res, { id: page.id, imgW: w, imgH: h, img: await assetView(asset.id) });
}, { roles: ['teacher', 'admin'] });

on('PUT', '/api/admin/pages/:id/hotspots', async (ctx) => {
  const page = await repo.pages.byId(ctx.params.id);
  if (!page) return fail(ctx.res, 3003, '页面不存在');
  const lesson = await repo.lessons.byId(page.lessonId);
  const list = Array.isArray(ctx.body.hotspots) ? ctx.body.hotspots : [];
  const count = await repo.hotspots.replaceForPage(page.id, list, lesson ? lesson.audioId : null);
  ok(ctx.res, { count });
}, { roles: ['teacher', 'admin'] });

on('DELETE', '/api/admin/pages/:id', async (ctx) => {
  if (await repo.homeworks.countByPage(ctx.params.id)) {
    return fail(ctx.res, 3008, '这一页上还有作业，先删掉作业再删页面');
  }
  await repo.pages.remove(ctx.params.id);
  ok(ctx.res, { ok: true });
}, { roles: ['teacher', 'admin'] });

on('DELETE', '/api/admin/lessons/:id', async (ctx) => {
  const lesson = await repo.lessons.byId(ctx.params.id);
  if (!lesson) return fail(ctx.res, 3007, '课不存在');
  for (const p of await repo.pages.byLesson(lesson.id)) {
    if (await repo.homeworks.countByPage(p.id)) return fail(ctx.res, 3008, '这一课下还有作业，先删掉作业');
  }
  await repo.lessons.remove(lesson.id);
  ok(ctx.res, { ok: true });
}, { roles: ['teacher', 'admin'] });

on('DELETE', '/api/admin/books/:id', async (ctx) => {
  const book = await repo.books.byId(ctx.params.id);
  if (!book) return fail(ctx.res, 3002, '教材不存在');
  if (await repo.homeworks.countByBook(book.id)) {
    return fail(ctx.res, 3008, '这本教材上还有作业，删不了');
  }
  await repo.books.remove(book.id);
  ok(ctx.res, { ok: true });
}, { roles: ['teacher', 'admin'] });

on('GET', '/api/admin/stats', async (ctx) => {
  ok(ctx.res, {
    books: await repo.books.count(),
    pages: await repo.pages.count(),
    hotspots: await repo.hotspots.count(),
    students: await repo.users.countByRole('student'),
    homeworks: await repo.homeworks.count(),
    submissions: await repo.submissions.count(),
  });
}, { roles: ['teacher', 'admin'] });

/* ---------- 分发 ---------- */
function match(method, parts) {
  for (const r of routes) {
    if (r.method !== method || r.parts.length !== parts.length) continue;
    const params = {};
    let hit = true;
    for (let i = 0; i < r.parts.length; i++) {
      const a = r.parts[i];
      if (a.startsWith(':')) params[a.slice(1)] = decodeURIComponent(parts[i]);
      else if (a !== parts[i]) { hit = false; break; }
    }
    if (hit) return { route: r, params };
  }
  return null;
}

async function handleApi(req, res, pathname) {
  const parts = pathname.split('/').filter(Boolean);
  const m = match(req.method, parts);
  if (!m) return fail(res, 404, '接口不存在: ' + req.method + ' ' + pathname);
  const { route, params } = m;

  let user = null;
  if (route.auth) {
    user = await userFromToken(req);
    if (!user) return fail(res, 401, '未登录或登录已过期');
    if (route.roles && !route.roles.includes(user.role)) return fail(res, 403, '当前身份无权限');
  }
  let body = {};
  if (req.method !== 'GET') {
    try { body = await readBody(req); } catch (e) { return fail(res, 1002, '请求体错误: ' + e.message); }
  }
  try {
    await route.handler({ req, res, user, params, body });
  } catch (e) {
    // repo 抛出的业务异常带 code，按业务错误返回；其余才算服务端错误
    if (Number.isInteger(e.code) && e.code >= 1000 && e.code < 6000) return fail(res, e.code, e.message);
    console.error('[api error]', pathname, e);
    fail(res, 500, '服务端错误: ' + e.message);
  }
}

module.exports = { handleApi, CHECKIN_SECONDS };
