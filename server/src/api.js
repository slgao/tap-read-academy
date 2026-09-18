'use strict';
/**
 * 业务接口层 —— 这里没有一句 SQL，也不碰文件系统。
 * 数据走 repo.js，文件走 storage.js。迁移到微信云开发时本文件不需要改动。
 */
const repo = require('./repo');
const store = require('./storage');
const { ok, fail, readBody, rid, sha256, staffCode, today, dayKey, inviteCode } = require('./util');
const grading = require('./grading');

const CHECKIN_SECONDS = Number(process.env.CHECKIN_SECONDS) || 300;   // 当天学习满 5 分钟算打卡

/* ---------- 视图辅助 ---------- */
const assetOut = (a) => (a ? { id: a.id, url: store.urlOf(a.relPath), durationMs: a.durationMs, placeholder: a.placeholder } : null);

async function assetView(id) {
  return assetOut(await repo.assets.byId(id));
}

/** 一次把要用到的资产查出来，循环里从 Map 取，不再一条条查库 */
async function assetMap(ids) {
  const out = new Map();
  for (const [id, a] of await repo.assets.byIds(ids)) out.set(id, assetOut(a));
  return out;
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

/** 落盘 + 建资产记录（内容已经是二进制，不再走 base64） */
async function putAssetBuf(kind, buf, ext, opts = {}) {
  const { relPath, size } = await store.saveBuf(kind, buf, ext);
  const asset = await repo.assets.create({ kind, relPath, mime: opts.mime || '', durationMs: opts.durationMs || 0, sizeBytes: size });
  return { asset, relPath };
}

/** 重交作业时清掉上一次的照片/录音：文件和资产记录一起删，正在分享的作品图不动 */
async function dropAssets(ids) {
  const list = [...new Set(ids.filter(Boolean))];
  if (!list.length) return;
  const keep = await repo.shares.activeAssetIds();
  const assets = await repo.assets.byIds(list.filter((id) => !keep.has(Number(id))));
  for (const a of assets.values()) await store.remove(a.relPath);
  await repo.assets.remove([...assets.keys()]);
}

async function userFromToken(req) {
  const h = req.headers['authorization'] || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : (h || '');
  return token ? repo.users.byToken(token) : null;
}

/** 分享页上的名字：默认只显示姓和最后一个字 */
function maskName(name) {
  const n = String(name || '').trim();
  if (n.length <= 1) return n || '同学';
  if (n.length === 2) return n[0] + '*';
  return n[0] + '*'.repeat(n.length - 2) + n[n.length - 1];
}

/** base64 图片解码并校验（JPG/PNG、大小上限） */
function decodeImage(base64, maxBytes = 3 * 1024 * 1024) {
  const buf = Buffer.from(String(base64 || '').replace(/^data:[^;]+;base64,/, ''), 'base64');
  if (!buf.length) return { error: '图片为空' };
  if (buf.length > maxBytes) return { error: '图片太大，请重新拍一张' };
  const jpg = buf[0] === 0xFF && buf[1] === 0xD8;
  const png = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47;
  if (!jpg && !png) return { error: '只支持 JPG 或 PNG 图片' };
  return { buf, ext: jpg ? 'jpg' : 'png' };
}

const subjectView = (x) => x && { id: x.id, code: x.code, name: x.name, color: x.color };

const publicUser = (u) => ({ id: u.id, role: u.role, name: u.name, stars: u.stars, streak: u.streak, lastCheckin: u.lastCheckin });

const ROLE_NAME = { admin: '负责人', teacher: '老师' };

/* ---------- 路由表 ---------- */
const routes = [];
const on = (method, pattern, handler, opts = {}) =>
  routes.push({ method, parts: pattern.split('/').filter(Boolean), handler, auth: opts.auth !== false, roles: opts.roles });

/* ================= 登录 =================
 * 学生：姓名 + 班级邀请码。
 * 老师：姓名 + 本人口令（口令由负责人在后台生成）。
 * 负责人：姓名 + 主口令（部署时设的 TEACHER_CODE）。主口令只给负责人一个人，
 *        第一次用它登录会建立负责人账号，之后由负责人给每位老师发各自的口令。
 * 以前是所有老师共用一个口令，任何人输个新名字就能建老师账号，这里把它收掉了。
 */
const loginFails = new Map();                           // IP -> 最近的失败时间，防止有人慢慢猜口令
// 口令是 6 位数字，挡住高频尝试就够了；老师自己输错几次不该被锁在门外
const LOGIN_FAILS_PER_10MIN = Number(process.env.LOGIN_FAILS_PER_10MIN) || 20;

function loginBlocked(ip) {
  const nowMs = Date.now();
  for (const [k, v] of loginFails) if (!v.some((t) => nowMs - t < 600e3)) loginFails.delete(k);
  return (loginFails.get(ip) || []).filter((t) => nowMs - t < 600e3).length >= LOGIN_FAILS_PER_10MIN;
}
function noteLoginFail(ip) {
  const list = (loginFails.get(ip) || []).filter((t) => Date.now() - t < 600e3);
  list.push(Date.now());
  loginFails.set(ip, list);
}

async function login(ctx) {
  const { role = 'student', name, inviteCode: code } = ctx.body;
  if (!name || !String(name).trim()) return fail(ctx.res, 1001, '请填写姓名');
  const nm = String(name).trim().slice(0, 20);
  const ip = String(ctx.req.headers['x-forwarded-for'] || ctx.req.socket.remoteAddress || '').split(',')[0].trim();

  let user;
  if (role === 'student') {
    user = await repo.users.byNameRole(nm, 'student');
    if (!user) user = await repo.users.create({ openid: 'dev_' + rid().slice(0, 12), role: 'student', name: nm });
    if (code) {
      const cls = await repo.classes.byInviteCode(String(code).toUpperCase().trim());
      if (!cls) return fail(ctx.res, 3001, '班级邀请码不存在');
      await repo.classes.addMember(cls.id, user.id);
    }
  } else {
    if (loginBlocked(ip)) return fail(ctx.res, 429, '尝试太多次了，请过十分钟再试');
    const given = String(ctx.body.teacherCode || '').trim();
    if (!given) return fail(ctx.res, 1001, '请输入口令');
    const master = process.env.TEACHER_CODE;
    user = await repo.users.staffByName(nm);
    if (master && given === master) {
      // 主口令：负责人入口，账号不存在就建一个
      if (!user) user = await repo.users.create({ openid: 'dev_' + rid().slice(0, 12), role: 'admin', name: nm });
      else if (user.role !== 'admin') { noteLoginFail(ip); return fail(ctx.res, 2001, '这是老师账号，请用负责人给你的口令登录'); }
    } else {
      if (!user || !user.loginCode || sha256(given) !== user.loginCode) {
        noteLoginFail(ip);
        return fail(ctx.res, 2001, '姓名或口令不对');
      }
      if (!user.active) return fail(ctx.res, 2001, '这个账号已经停用，请找负责人');
    }
  }
  const token = rid() + rid();
  await repo.sessions.create(token, user.id);
  ok(ctx.res, { token, user: publicUser(user) });
}

on('POST', '/api/auth/login', login, { auth: false });
on('POST', '/api/auth/dev-login', login, { auth: false });      // 旧地址，小程序端还在用

on('GET', '/api/me', async (ctx) => {
  const ids = await repo.classes.idsForUser(ctx.user);
  const classes = [];
  for (const id of ids) {
    const c = await repo.classes.byId(id);
    if (c) classes.push(await classView(c));
  }
  ok(ctx.res, { user: publicUser(ctx.user), classes });
});

/* 班级 */
/** 年级段：同一科目按年级段分班 */
const GRADE_BANDS = ['一二年级', '三四年级', '五六年级', '初中', '不分年级'];

/** 老师只能看自己带的班，学生只能看自己在的班；admin 不限 */
async function canTouchClass(user, classId) {
  if (user.role === 'admin') return true;
  return (await repo.classes.idsForUser(user)).includes(Number(classId));
}

async function classView(c) {
  return { id: c.id, name: c.name, inviteCode: c.inviteCode, teacherId: c.teacherId,
    subject: subjectView(await repo.subjects.byId(c.subjectId)), gradeBand: c.gradeBand,
    studentCount: await repo.classes.memberCount(c.id) };
}

on('GET', '/api/classes', async (ctx) => {
  const subs = await repo.subjects.all();
  const ids = await repo.classes.idsForUser(ctx.user);
  const [byId, counts] = [await repo.classes.byIds(ids), await repo.classes.memberCounts(ids)];
  const rows = [];
  for (const id of ids) {
    const c = byId.get(id);
    if (!c) continue;
    const t = ctx.user.role === 'admin' ? await repo.users.byId(c.teacherId) : null;
    rows.push({ id: c.id, name: c.name, inviteCode: c.inviteCode, teacherId: c.teacherId,
      teacherName: t ? t.name : (c.teacherId === ctx.user.id ? ctx.user.name : ''),
      subject: subjectView(subs.find((x) => x.id === c.subjectId)), gradeBand: c.gradeBand, studentCount: counts.get(c.id) || 0 });
  }
  // 按科目、年级段排好，界面直接分组显示
  const sortOf = (r) => (subs.find((x) => r.subject && x.id === r.subject.id) || { sort: 99 }).sort;
  const band = (r) => { const i = GRADE_BANDS.indexOf(r.gradeBand); return i < 0 ? 99 : i; };
  rows.sort((a, b) => sortOf(a) - sortOf(b) || band(a) - band(b) || a.id - b.id);
  ok(ctx.res, rows);
});

on('GET', '/api/grade-bands', async (ctx) => ok(ctx.res, GRADE_BANDS), { auth: false });

/** 校验班级表单；班名不填时按「年级段 + 科目 + 班」自动起名 */
async function classForm(body) {
  const subject = await repo.subjects.byId(body.subjectId);
  if (!subject) return { error: '请选择科目' };
  const gradeBand = String(body.gradeBand || '');
  if (!GRADE_BANDS.includes(gradeBand)) return { error: '请选择年级段' };
  const name = String(body.name || '').trim().slice(0, 30) || `${gradeBand === '不分年级' ? '' : gradeBand}${subject.name}班`;
  return { subject, gradeBand, name };
}

on('POST', '/api/classes', async (ctx) => {
  const f = await classForm(ctx.body);
  if (f.error) return fail(ctx.res, 1001, f.error);
  let code; let guard = 0;
  do { code = inviteCode(); guard++; } while (await repo.classes.inviteCodeTaken(code) && guard < 20);

  // 负责人可以直接把新班开在某位老师名下
  let teacherId = ctx.user.id;
  if (ctx.user.role === 'admin' && ctx.body.teacherId) {
    const t = await repo.users.byId(ctx.body.teacherId);
    if (!t || t.role === 'student' || !t.active) return fail(ctx.res, 3013, '请选择一位在职的老师');
    teacherId = t.id;
  }
  const cls = await repo.classes.create({ name: f.name, inviteCode: code, teacherId, subjectId: f.subject.id, gradeBand: f.gradeBand });
  // 新班级默认可见全部教材（MVP 简化）
  for (const b of await repo.books.all()) await repo.books.grantToClass(b.id, cls.id);
  ok(ctx.res, await classView(cls));
}, { roles: ['teacher', 'admin'] });

on('PUT', '/api/classes/:id', async (ctx) => {
  const cls = await repo.classes.byId(ctx.params.id);
  if (!cls) return fail(ctx.res, 3001, '班级不存在');
  if (ctx.user.role === 'teacher' && cls.teacherId !== ctx.user.id) return fail(ctx.res, 403, '只能修改自己带的班');
  const f = await classForm(ctx.body);
  if (f.error) return fail(ctx.res, 1001, f.error);
  if (f.subject.id !== cls.subjectId && await repo.homeworks.countByClass(cls.id)) {
    return fail(ctx.res, 3009, '这个班已经布置过作业，不能再改科目');
  }
  // 换任课老师只有负责人能做；作业、学生、批改记录都跟着班走
  if (ctx.body.teacherId != null && Number(ctx.body.teacherId) !== cls.teacherId) {
    if (ctx.user.role !== 'admin') return fail(ctx.res, 403, '只有负责人能把班转给别的老师');
    const t = await repo.users.byId(ctx.body.teacherId);
    if (!t || t.role === 'student') return fail(ctx.res, 3013, '找不到这位老师');
    if (!t.active) return fail(ctx.res, 3013, '这位老师的账号已停用');
    await repo.classes.setTeacher(cls.id, t.id);
  }
  await repo.classes.update(cls.id, { name: f.name, subjectId: f.subject.id, gradeBand: f.gradeBand });
  ok(ctx.res, await classView(await repo.classes.byId(cls.id)));
}, { roles: ['teacher', 'admin'] });

on('DELETE', '/api/classes/:id', async (ctx) => {
  const cls = await repo.classes.byId(ctx.params.id);
  if (!cls) return fail(ctx.res, 3001, '班级不存在');
  if (ctx.user.role === 'teacher' && cls.teacherId !== ctx.user.id) return fail(ctx.res, 403, '只能删除自己带的班');
  if (await repo.homeworks.countByClass(cls.id)) return fail(ctx.res, 3009, '这个班布置过作业，不能删除');
  await repo.classes.remove(cls.id);
  ok(ctx.res, { ok: true });
}, { roles: ['teacher', 'admin'] });

on('DELETE', '/api/classes/:id/students/:sid', async (ctx) => {
  const cls = await repo.classes.byId(ctx.params.id);
  if (!cls) return fail(ctx.res, 3001, '班级不存在');
  if (ctx.user.role === 'teacher' && cls.teacherId !== ctx.user.id) return fail(ctx.res, 403, '只能管理自己带的班');
  await repo.classes.removeMember(cls.id, ctx.params.sid);
  ok(ctx.res, { ok: true });
}, { roles: ['teacher', 'admin'] });

on('POST', '/api/classes/join', async (ctx) => {
  const cls = await repo.classes.byInviteCode(String(ctx.body.inviteCode || '').toUpperCase().trim());
  if (!cls) return fail(ctx.res, 3001, '班级邀请码不存在');
  await repo.classes.addMember(cls.id, ctx.user.id);
  ok(ctx.res, await classView(cls));
}, { roles: ['student'] });

on('GET', '/api/classes/:id/students', async (ctx) => {
  if (!await canTouchClass(ctx.user, ctx.params.id)) return fail(ctx.res, 403, '看不了别的班的名单');
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
  // 整本书按「课顺序 + 页顺序」连续翻页，翻到一课的最后一页能接着翻到下一课
  const siblings = await repo.pages.idsByBook(lesson.bookId);
  const idx = siblings.indexOf(page.id);

  const rows = await repo.hotspots.byPage(page.id);
  const audios = await assetMap(rows.map((h) => h.audioId));
  const hotspots = rows.map((h) => ({ id: h.id, x: h.x, y: h.y, w: h.w, h: h.h,
    startMs: h.startMs, endMs: h.endMs, en: h.en, cn: h.cn, type: h.type,
    audio: audios.get(h.audioId) || null }));
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
    const rows = await repo.lessons.byBook(b.id);
    const audios = await assetMap(rows.map((l) => l.audioId));
    const counts = await repo.hotspots.listenCountsByBook(b.id);
    const lessons = [];
    for (const l of rows) {
      const audio = audios.get(l.audioId);
      const count = counts.get(l.id) || 0;
      if (audio && count) lessons.push({ id: l.id, title: l.title, durationMs: audio.durationMs, sentenceCount: count });
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
  const sentences = (await repo.hotspots.byLessonTimeline(lesson.id))
    .map((h) => ({ id: h.id, pageNo: h.pageNo, en: h.en, cn: h.cn, startMs: h.startMs, endMs: h.endMs }));
  ok(ctx.res, {
    lesson: { id: lesson.id, title: lesson.title, audio },
    book: { id: book.id, title: book.title },
    sentences,
  });
});

/* 学习海报：浏览器里画好后传上来，换成真实图片地址。
 * 微信内置浏览器不支持下载，对 base64 内嵌图片长按也常常无法保存；真实 https 图片可以长按保存、识别二维码。
 * 每个学生只保留最新一张，覆盖保存，不会越存越多。 */
on('POST', '/api/posters', async (ctx) => {
  const raw = String(ctx.body.imageBase64 || '').replace(/^data:[^;]+;base64,/, '');
  const buf = Buffer.from(raw, 'base64');
  if (!buf.length) return fail(ctx.res, 1001, '海报图片为空');
  if (buf.length > 3 * 1024 * 1024) return fail(ctx.res, 1001, '海报图片过大');
  const isJpg = buf[0] === 0xFF && buf[1] === 0xD8;
  const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47;
  if (!isJpg && !isPng) return fail(ctx.res, 1001, '海报必须是 JPG 或 PNG 图片');
  const relPath = `posters/u${ctx.user.id}.${isJpg ? 'jpg' : 'png'}`;
  await store.saveAs(relPath, buf);
  ok(ctx.res, { url: store.urlOf(relPath) + '?v=' + Date.now() });
});

/* 学习时长 / 打卡 */
on('POST', '/api/study/heartbeat', async (ctx) => {
  const sec = Math.max(0, Math.min(120, Number(ctx.body.seconds) || 0));
  const d = today();
  const row = await repo.checkins.addSeconds(ctx.user.id, d, sec);

  let justChecked = false;
  if (row.seconds >= CHECKIN_SECONDS && ctx.user.lastCheckin !== d) {
    const yest = dayKey(Date.now() - 86400000);
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
  const cls = await repo.classes.byId(classId);
  if (!cls) return fail(ctx.res, 3001, '班级不存在');
  if (!await canTouchClass(ctx.user, cls.id)) return fail(ctx.res, 403, '只能给自己带的班布置作业');
  const subject = await repo.subjects.byId(cls.subjectId) || await repo.subjects.byCode('en');   // 作业科目跟班级走
  const hw = await repo.homeworks.create({
    classId, teacherId: ctx.user.id, title: String(title), type: 'follow_read',
    bookId: lesson.bookId, pageId: page.id, hotspotIds, note, deadline, subjectId: subject ? subject.id : null,
  });
  ok(ctx.res, { id: hw.id });
}, { roles: ['teacher', 'admin'] });

/**
 * 作业列表/详情共用的摘要。
 * pre 是列表页预先批量查好的数据（班级、科目、题数、提交），传了就直接用，
 * 不传（单份作业）才回退到单条查询。
 */
async function hwBrief(hw, user, pre) {
  const cls = pre ? pre.classes.get(hw.classId) : await repo.classes.byId(hw.classId);
  const itemCount = hw.kind !== 'questions' ? hw.hotspotIds.length
    : (pre ? (pre.questionCounts.get(hw.id) || 0) : (await repo.questions.byHomework(hw.id)).length);
  const out = {
    id: hw.id, title: hw.title, className: cls ? cls.name : '', classId: hw.classId,
    pageId: hw.pageId, itemCount, note: hw.note,
    deadline: hw.deadline, createdAt: hw.createdAt,
    kind: hw.kind, subject: subjectView(pre ? pre.subjects.get(hw.subjectId) : await repo.subjects.byId(hw.subjectId)),
  };
  if (user.role === 'student') {
    const sub = pre ? pre.mySubs.get(hw.id) : await repo.submissions.byHomeworkAndStudent(hw.id, user.id);
    out.status = sub ? sub.status : 'todo';
    out.stars = sub ? sub.stars : null;
    out.reviewText = sub ? sub.reviewText : null;
    out.submissionId = sub ? sub.id : null;
    out.score = sub ? sub.score : null;
    out.maxScore = sub ? sub.maxScore : null;
    out.excellent = sub ? sub.excellent : false;
  } else if (pre) {
    const st = pre.subStats.get(hw.id) || { submitted: 0, reviewed: 0 };
    out.submitted = st.submitted;
    out.reviewed = st.reviewed;
    out.total = pre.memberCounts.get(hw.classId) || 0;
  } else {
    out.submitted = await repo.submissions.countByHomework(hw.id);
    out.reviewed = await repo.submissions.countReviewed(hw.id);
    out.total = await repo.classes.memberCount(hw.classId);
  }
  return out;
}

/** 作业列表用：班级、科目、题数、提交情况各查一次，避免每份作业都查五六次 */
async function preloadForList(rows, user) {
  const ids = rows.map((h) => h.id);
  const classIds = [...new Set(rows.map((h) => h.classId))];
  const pre = {
    subjects: new Map((await repo.subjects.all()).map((x) => [x.id, x])),
    classes: await repo.classes.byIds(classIds),
    questionCounts: await repo.questions.countsByHomeworks(rows.filter((h) => h.kind === 'questions').map((h) => h.id)),
    mySubs: new Map(), subStats: new Map(), memberCounts: new Map(),
  };
  if (user.role === 'student') pre.mySubs = await repo.submissions.byStudentForHomeworks(user.id, ids);
  else {
    pre.subStats = await repo.submissions.statsByHomeworks(ids);
    pre.memberCounts = await repo.classes.memberCounts(classIds);
  }
  return pre;
}

on('GET', '/api/homeworks', async (ctx) => {
  const ids = await repo.classes.idsForUser(ctx.user);
  let rows = await repo.homeworks.byClassIds(ids);
  if (ctx.query.subject) {
    const sub = await repo.subjects.byCode(ctx.query.subject);
    rows = sub ? rows.filter((h) => h.subjectId === sub.id) : [];
  }
  const pre = await preloadForList(rows, ctx.user);
  const out = [];
  for (const hw of rows) out.push(await hwBrief(hw, ctx.user, pre));
  ok(ctx.res, out);
});

on('GET', '/api/homeworks/:id', async (ctx) => {
  const hw = await repo.homeworks.byId(ctx.params.id);
  if (!hw) return fail(ctx.res, 3004, '作业不存在');
  if (!await canTouchClass(ctx.user, hw.classId)) return fail(ctx.res, 403, '这不是你班级的作业');
  if (hw.kind === 'questions') return ok(ctx.res, await questionHomeworkDetail(hw, ctx.user));

  const hsRows = [];
  for (const hid of hw.hotspotIds) { const h = await repo.hotspots.byId(hid); if (h) hsRows.push(h); }
  const hsAudio = await assetMap(hsRows.map((h) => h.audioId));
  const items = hsRows.map((h) => ({ hotspotId: h.id, en: h.en, cn: h.cn, startMs: h.startMs, endMs: h.endMs,
    audio: hsAudio.get(h.audioId) || null }));

  const page = await repo.pages.byId(hw.pageId);
  const lesson = page ? await repo.lessons.byId(page.lessonId) : null;
  const lessonAudio = lesson ? await assetView(lesson.audioId) : null;

  const out = { ...(await hwBrief(hw, ctx.user)), items, lessonAudio };
  if (ctx.user.role === 'student') {
    const sub = await repo.submissions.byHomeworkAndStudent(hw.id, ctx.user.id);
    if (sub) {
      const its = await repo.submissionItems.bySubmission(sub.id);
      const recs = await assetMap(its.map((it) => it.assetId));
      const subItems = its.map((it) => ({ hotspotId: it.hotspotId, audio: recs.get(it.assetId) || null }));
      out.mySubmission = { id: sub.id, status: sub.status, stars: sub.stars,
        reviewText: sub.reviewText, submittedAt: sub.submittedAt, items: subItems };
    }
  }
  ok(ctx.res, out);
});

on('POST', '/api/homeworks/:id/submit', async (ctx) => {
  const hw = await repo.homeworks.byId(ctx.params.id);
  if (!hw) return fail(ctx.res, 3004, '作业不存在');
  if (!await canTouchClass(ctx.user, hw.classId)) return fail(ctx.res, 403, '这不是你班级的作业');
  const items = (Array.isArray(ctx.body.items) ? ctx.body.items : []).filter((it) => it && it.audioBase64);
  // 一段录音都没收到就拒绝，不能静默记成"已提交"（曾因字段名不一致丢过所有网页端录音）
  if (!items.length) return fail(ctx.res, 1001, '没有收到录音，请重新录一次再提交');

  let sub = await repo.submissions.byHomeworkAndStudent(hw.id, ctx.user.id);
  if (sub && sub.status === 'reviewed') return fail(ctx.res, 3005, '作业已批改，如需重交请让老师打回');
  if (!sub) {
    sub = await repo.submissions.create({ homeworkId: hw.id, studentId: ctx.user.id, elapsedSec: ctx.body.elapsedSec });
  } else {
    await repo.submissions.markResubmitted(sub.id, ctx.body.elapsedSec);
    const old = await repo.submissionItems.bySubmission(sub.id);
    await repo.submissionItems.clear(sub.id);
    await dropAssets(old.map((it) => it.assetId));
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
  const cls = await repo.classes.byId(hw.classId);
  if (ctx.user.role === 'teacher' && cls && cls.teacherId !== ctx.user.id) return fail(ctx.res, 403, '只能删除自己班的作业');
  await repo.homeworks.remove(hw.id);
  ok(ctx.res, { ok: true });
}, { roles: ['teacher', 'admin'] });

on('GET', '/api/homeworks/:id/submissions', async (ctx) => {
  const hw = await repo.homeworks.byId(ctx.params.id);
  if (!hw) return fail(ctx.res, 3004, '作业不存在');
  if (!await canTouchClass(ctx.user, hw.classId)) return fail(ctx.res, 403, '这不是你带的班');
  // 全班的提交、作答、资产各查一次，班级人数多时不会随人数一条条查
  const members = await repo.classes.members(hw.classId);
  const subsByStudent = await repo.submissions.byHomeworkForStudents(hw.id);
  const subIds = [...subsByStudent.values()].map((s) => s.id);

  if (hw.kind === 'questions') {
    const qs = await repo.questions.byHomework(hw.id);
    const answersBySub = await repo.answers.bySubmissions(subIds);
    const allAnswers = [...answersBySub.values()].flat();
    const assets = await assetMap([...qs.map((q) => q.stemImageId), ...allAnswers.flatMap((a) => a.assetIds)]);
    const questions = qs.map((q) => ({ id: q.id, sort: q.sort, type: q.type, stem: q.stem, stemImage: assets.get(q.stemImageId) || null,
      options: q.options, answer: q.answer, score: q.score, auto: grading.AUTO_TYPES.includes(q.type) }));
    const rows = [];
    for (const m of members) {
      const sub = subsByStudent.get(m.id);
      const answers = (sub ? answersBySub.get(sub.id) || [] : []).map((a) => answerView(a, assets));
      rows.push({ studentId: m.id, studentName: m.name, status: sub ? sub.status : 'todo', submissionId: sub ? sub.id : null,
        submittedAt: sub ? sub.submittedAt : null, score: sub ? sub.score : null, maxScore: sub ? sub.maxScore : null,
        stars: sub ? sub.stars : null, reviewText: sub ? sub.reviewText : null, excellent: sub ? sub.excellent : false, answers });
    }
    return ok(ctx.res, { homework: await hwBrief(hw, ctx.user), questions, rows });
  }

  const hotspots = new Map();
  for (const hid of hw.hotspotIds) { const h = await repo.hotspots.byId(hid); if (h) hotspots.set(h.id, h); }
  const rows = [];
  for (const m of members) {
    const sub = subsByStudent.get(m.id);
    const items = [];
    if (sub) {
      const its = await repo.submissionItems.bySubmission(sub.id);
      const audios = await assetMap(its.map((it) => it.assetId));
      for (const it of its) {
        const h = hotspots.get(it.hotspotId);
        items.push({ hotspotId: it.hotspotId, en: h ? h.en : '', cn: h ? h.cn : '', audio: audios.get(it.assetId) || null });
      }
    }
    rows.push({
      studentId: m.id, studentName: m.name,
      status: sub ? sub.status : 'todo',
      submissionId: sub ? sub.id : null,
      submittedAt: sub ? sub.submittedAt : null,
      stars: sub ? sub.stars : null,
      reviewText: sub ? sub.reviewText : null,
      excellent: sub ? sub.excellent : false,
      items,
    });
  }
  ok(ctx.res, { homework: await hwBrief(hw, ctx.user), rows });
}, { roles: ['teacher', 'admin'] });

on('POST', '/api/submissions/:id/review', async (ctx) => {
  const sub = await repo.submissions.byId(ctx.params.id);
  if (!sub) return fail(ctx.res, 3006, '提交记录不存在');
  const subHw = await repo.homeworks.byId(sub.homeworkId);
  if (!subHw || !await canTouchClass(ctx.user, subHw.classId)) return fail(ctx.res, 403, '这不是你带的班');
  const stars = Math.max(1, Math.min(5, Number(ctx.body.stars) || 5));
  const first = sub.status !== 'reviewed';
  await repo.submissions.review(sub.id, { stars, reviewText: String(ctx.body.reviewText || '') });
  await repo.submissions.setExcellent(sub.id, !!ctx.body.excellent);
  if (first) await repo.users.addStars(sub.studentId, stars * 2 + (ctx.body.excellent ? 10 : 0));   // 重复批改不重复加星
  ok(ctx.res, { ok: true });
}, { roles: ['teacher', 'admin'] });

on('POST', '/api/submissions/:id/reject', async (ctx) => {
  const sub = await repo.submissions.byId(ctx.params.id);
  if (!sub) return fail(ctx.res, 3006, '提交记录不存在');
  const subHw = await repo.homeworks.byId(sub.homeworkId);
  if (!subHw || !await canTouchClass(ctx.user, subHw.classId)) return fail(ctx.res, 403, '这不是你带的班');
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
}, { roles: ['admin'] });

on('POST', '/api/admin/lessons', async (ctx) => {
  const { bookId, title } = ctx.body;
  if (!bookId || !title) return fail(ctx.res, 1001, '缺少参数');
  const sort = (await repo.lessons.countByBook(bookId)) + 1;
  const lesson = await repo.lessons.create({ bookId, title: String(title), sort });
  ok(ctx.res, { id: lesson.id });
}, { roles: ['admin'] });

on('POST', '/api/admin/lessons/:id/audio', async (ctx) => {
  const lesson = await repo.lessons.byId(ctx.params.id);
  if (!lesson) return fail(ctx.res, 3007, '课不存在');
  const { asset } = await putAsset('audio', ctx.body.base64, ctx.body.ext || 'mp3',
    { mime: ctx.body.mime || 'audio/mpeg' });
  await repo.lessons.setAudio(lesson.id, asset.id);
  ok(ctx.res, { asset: await assetView(asset.id) });
}, { roles: ['admin'] });

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
}, { roles: ['admin'] });

on('PUT', '/api/admin/pages/:id/hotspots', async (ctx) => {
  const page = await repo.pages.byId(ctx.params.id);
  if (!page) return fail(ctx.res, 3003, '页面不存在');
  const lesson = await repo.lessons.byId(page.lessonId);
  const list = Array.isArray(ctx.body.hotspots) ? ctx.body.hotspots : [];
  const count = await repo.hotspots.replaceForPage(page.id, list, lesson ? lesson.audioId : null);
  ok(ctx.res, { count });
}, { roles: ['admin'] });

on('DELETE', '/api/admin/pages/:id', async (ctx) => {
  if (await repo.homeworks.countByPage(ctx.params.id)) {
    return fail(ctx.res, 3008, '这一页上还有作业，先删掉作业再删页面');
  }
  await repo.pages.remove(ctx.params.id);
  ok(ctx.res, { ok: true });
}, { roles: ['admin'] });

on('DELETE', '/api/admin/lessons/:id', async (ctx) => {
  const lesson = await repo.lessons.byId(ctx.params.id);
  if (!lesson) return fail(ctx.res, 3007, '课不存在');
  for (const p of await repo.pages.byLesson(lesson.id)) {
    if (await repo.homeworks.countByPage(p.id)) return fail(ctx.res, 3008, '这一课下还有作业，先删掉作业');
  }
  await repo.lessons.remove(lesson.id);
  ok(ctx.res, { ok: true });
}, { roles: ['admin'] });

on('DELETE', '/api/admin/books/:id', async (ctx) => {
  const book = await repo.books.byId(ctx.params.id);
  if (!book) return fail(ctx.res, 3002, '教材不存在');
  if (await repo.homeworks.countByBook(book.id)) {
    return fail(ctx.res, 3008, '这本教材上还有作业，删不了');
  }
  await repo.books.remove(book.id);
  ok(ctx.res, { ok: true });
}, { roles: ['admin'] });

on('GET', '/api/admin/stats', async (ctx) => {
  const base = { books: await repo.books.count(), pages: await repo.pages.count(), hotspots: await repo.hotspots.count() };
  if (ctx.user.role === 'admin') {
    return ok(ctx.res, { ...base, scope: 'school',
      students: await repo.users.countByRole('student'),
      homeworks: await repo.homeworks.count(),
      submissions: await repo.submissions.count(),
      teachers: (await repo.users.staff()).length });
  }
  // 老师只看自己带的班的数字
  const ids = await repo.classes.idsForUser(ctx.user);
  const counts = await repo.classes.memberCounts(ids);
  const hws = await repo.homeworks.byClassIds(ids, 500);
  const stats = await repo.submissions.statsByHomeworks(hws.map((h) => h.id));
  ok(ctx.res, { ...base, scope: 'mine',
    students: [...counts.values()].reduce((a, b) => a + b, 0),
    homeworks: hws.length,
    submissions: [...stats.values()].reduce((a, b) => a + b.submitted, 0),
    classes: ids.length });
}, { roles: ['teacher', 'admin'] });

/* ================= 教职工账号（负责人管理） ================= */
on('GET', '/api/admin/teachers', async (ctx) => {
  const out = [];
  for (const u of await repo.users.staff()) {
    out.push({ id: u.id, name: u.name, role: u.role, roleName: ROLE_NAME[u.role] || u.role,
      active: !!u.active, hasCode: !!u.loginCode, isMe: u.id === ctx.user.id,
      classCount: await repo.classes.countByTeacher(u.id), createdAt: u.createdAt });
  }
  ok(ctx.res, out);
}, { roles: ['admin'] });

/** 建老师账号，返回一次性口令：负责人把它发给这位老师 */
on('POST', '/api/admin/teachers', async (ctx) => {
  const name = String(ctx.body.name || '').trim().slice(0, 20);
  if (!name) return fail(ctx.res, 1001, '请填写老师姓名');
  const dup = await repo.users.staffByName(name);
  if (dup) {
    return fail(ctx.res, 3013, dup.active
      ? `已经有一个叫「${name}」的账号了。要么给这位老师换个写法（比如「${name}（语文）」），要么直接用原账号并重置口令`
      : `有一个已停用的「${name}」账号占着这个名字。可以把它恢复后重置口令，或者给它改名/删除后再新建`);
  }
  const code = staffCode();
  const user = await repo.users.create({ openid: 'dev_' + rid().slice(0, 12), role: 'teacher', name });
  await repo.users.setLoginCode(user.id, sha256(code));
  ok(ctx.res, { id: user.id, name, code });
}, { roles: ['admin'] });

/** 重置口令：老师忘了口令时用，旧口令立刻失效 */
on('POST', '/api/admin/teachers/:id/code', async (ctx) => {
  const u = await repo.users.byId(ctx.params.id);
  if (!u || u.role === 'student') return fail(ctx.res, 3013, '账号不存在');
  const code = staffCode();
  await repo.users.setLoginCode(u.id, sha256(code));
  ok(ctx.res, { id: u.id, name: u.name, code });
}, { roles: ['admin'] });

on('PUT', '/api/admin/teachers/:id', async (ctx) => {
  const u = await repo.users.byId(ctx.params.id);
  if (!u || u.role === 'student') return fail(ctx.res, 3013, '账号不存在');
  if (u.id === ctx.user.id && ctx.body.active === false) return fail(ctx.res, 1001, '不能停用自己');
  if (ctx.body.role && ctx.body.role !== u.role) {
    if (!['teacher', 'admin'].includes(ctx.body.role)) return fail(ctx.res, 1001, '身份不对');
    if (u.id === ctx.user.id) return fail(ctx.res, 1001, '不能改自己的身份，请让另一位负责人来改');
    if (ctx.body.role === 'teacher') {
      const admins = (await repo.users.staff()).filter((x) => x.role === 'admin' && x.active);
      if (admins.length <= 1) return fail(ctx.res, 3013, '至少要留一位负责人');
      if (!u.loginCode) return fail(ctx.res, 3013, '这个账号还没有口令，先点「重置口令」再改成老师');
    }
    await repo.users.setRole(u.id, ctx.body.role);
  }
  if (ctx.body.name != null) {
    const name = String(ctx.body.name).trim().slice(0, 20);
    const other = await repo.users.staffByName(name);
    if (!name) return fail(ctx.res, 1001, '姓名不能为空');
    if (other && other.id !== u.id) return fail(ctx.res, 3013, '已经有同名的老师');
    await repo.users.rename(u.id, name);
  }
  if (ctx.body.active != null) await repo.users.setActive(u.id, !!ctx.body.active);
  ok(ctx.res, { ok: true });
}, { roles: ['admin'] });

/** 把一位老师名下的班全部转给另一位：换人带班、离职交接时用 */
on('POST', '/api/admin/teachers/:id/transfer', async (ctx) => {
  const from = await repo.users.byId(ctx.params.id);
  const to = await repo.users.byId(ctx.body.toId);
  if (!from || from.role === 'student') return fail(ctx.res, 3013, '账号不存在');
  if (!to || to.role === 'student') return fail(ctx.res, 3013, '请选择要转给哪位老师');
  if (from.id === to.id) return fail(ctx.res, 1001, '不能转给自己');
  if (!to.active) return fail(ctx.res, 3013, '这位老师的账号已停用');
  const moved = await repo.classes.moveAll(from.id, to.id);
  ok(ctx.res, { moved, to: to.name });
}, { roles: ['admin'] });

on('DELETE', '/api/admin/teachers/:id', async (ctx) => {
  const u = await repo.users.byId(ctx.params.id);
  if (!u || u.role === 'student') return fail(ctx.res, 3013, '账号不存在');
  if (u.id === ctx.user.id) return fail(ctx.res, 1001, '不能删自己');
  if (await repo.classes.countByTeacher(u.id)) return fail(ctx.res, 3013, '这位老师名下还有班级，先用「转出班级」把班转给别人');
  await repo.users.remove(u.id);
  ok(ctx.res, { ok: true });
}, { roles: ['admin'] });


/* ================= 多科目：科目 ================= */
on('GET', '/api/subjects', async (ctx) => {
  const cs = await repo.courses.all();
  const all = (await repo.subjects.all()).map((x) => ({ ...subjectView(x),
    courses: cs.filter((c) => c.subjectId === x.id).map((c) => ({ id: c.id, name: c.name })) }));
  const mine = ctx.user.role === 'student' ? [] : await repo.subjects.idsForTeacher(ctx.user.id);
  ok(ctx.res, { subjects: all, mine });
});

on('PUT', '/api/me/subjects', async (ctx) => {
  const all = await repo.subjects.all();
  const ids = (Array.isArray(ctx.body.subjectIds) ? ctx.body.subjectIds : []).map(Number).filter((id) => all.some((x) => x.id === id));
  await repo.subjects.setForTeacher(ctx.user.id, ids);
  ok(ctx.res, { mine: ids });
}, { roles: ['teacher', 'admin'] });

/* ================= 多科目：题目作业 ================= */
on('POST', '/api/homeworks/questions', async (ctx) => {
  const { classId, subjectId, title, note, deadline } = ctx.body;
  const list = Array.isArray(ctx.body.questions) ? ctx.body.questions : [];
  if (!classId || !String(title || '').trim()) return fail(ctx.res, 1001, '请选择班级并填写作业标题');
  const cls = await repo.classes.byId(classId);
  if (!cls) return fail(ctx.res, 3001, '班级不存在');
  if (!await canTouchClass(ctx.user, cls.id)) return fail(ctx.res, 403, '只能给自己带的班布置作业');
  const subject = await repo.subjects.byId(cls.subjectId) || await repo.subjects.byId(subjectId);   // 作业科目跟班级走
  if (!subject) return fail(ctx.res, 1001, '这个班还没设置科目');
  if (!list.length) return fail(ctx.res, 1001, '至少出一道题');
  if (list.length > 50) return fail(ctx.res, 1001, '一份作业最多 50 道题');
  for (let i = 0; i < list.length; i++) {
    const err = grading.validateQuestion(list[i], i);
    if (err) return fail(ctx.res, 1001, err);
  }
  const prepared = [];
  for (const [i, x] of list.entries()) {
    let stemImageId = null;
    if (x.stemImageBase64) {
      const img = decodeImage(x.stemImageBase64, 5 * 1024 * 1024);
      if (img.error) return fail(ctx.res, 1001, `第 ${i + 1} 题图片：${img.error}`);
      const { asset } = await putAssetBuf('stem', img.buf, img.ext, { mime: 'image/' + img.ext });
      stemImageId = asset.id;
    }
    const answer = x.type === 'single' ? Number(x.answer)
      : x.type === 'multi' ? x.answer.map(Number)
      : x.type === 'judge' ? Boolean(x.answer)
      : x.type === 'blank' ? { blanks: x.answer.blanks.map((b) => b.map((v) => String(v).trim()).filter(Boolean)), tolerance: Number(x.answer.tolerance) || 0 }
      : null;
    prepared.push({ type: x.type, stem: String(x.stem || '').trim(), stemImageId, options: (x.options || []).map((o) => String(o).trim()),
      answer, score: Number(x.score), analysis: String(x.analysis || '').trim() });
  }
  const hw = await repo.homeworks.createWithQuestions({
    classId, teacherId: ctx.user.id, subjectId: subject.id, title: String(title).trim(), note, deadline, questions: prepared,
  });
  ok(ctx.res, { id: hw.id });
}, { roles: ['teacher', 'admin'] });

function answerView(a, assetsById) {
  const assets = a.assetIds.map((id) => assetsById.get(id)).filter(Boolean);
  return { id: a.id, questionId: a.questionId, value: a.value, assets, autoCorrect: a.autoCorrect, score: a.score, comment: a.comment };
}

/** 题目作业详情。标准答案和解析：老师随时可见；学生在批改完成后才可见 */
async function questionHomeworkDetail(hw, user) {
  const qs = await repo.questions.byHomework(hw.id);
  const out = { ...(await hwBrief(hw, user)), questions: [] };
  let sub = null, answers = [];
  if (user.role === 'student') {
    sub = await repo.submissions.byHomeworkAndStudent(hw.id, user.id);
    if (sub) answers = await repo.answers.bySubmission(sub.id);
  }
  const reveal = user.role !== 'student' || (sub && sub.status === 'reviewed');
  const assets = await assetMap([...qs.map((q) => q.stemImageId), ...answers.flatMap((a) => a.assetIds)]);
  for (const q of qs) {
    const view = { id: q.id, type: q.type, stem: q.stem, stemImage: assets.get(q.stemImageId) || null,
      options: q.options, score: q.score, auto: grading.AUTO_TYPES.includes(q.type) };
    if (q.type === 'blank') view.blankCount = (q.answer && q.answer.blanks || []).length;
    if (reveal) { view.answer = q.answer; view.analysis = q.analysis; }
    const a = answers.find((x) => x.questionId === q.id);
    if (a) view.myAnswer = answerView(a, assets);
    out.questions.push(view);
  }
  if (sub) out.mySubmission = { id: sub.id, status: sub.status, score: sub.score, maxScore: sub.maxScore, stars: sub.stars,
    reviewText: sub.reviewText, excellent: sub.excellent, submittedAt: sub.submittedAt };
  return out;
}

on('POST', '/api/homeworks/:id/answers', async (ctx) => {
  const hw = await repo.homeworks.byId(ctx.params.id);
  if (!hw || hw.kind !== 'questions') return fail(ctx.res, 3004, '作业不存在');
  const classIds = await repo.classes.idsForUser(ctx.user);
  if (!classIds.includes(hw.classId)) return fail(ctx.res, 403, '这不是你班级的作业');
  let sub = await repo.submissions.byHomeworkAndStudent(hw.id, ctx.user.id);
  if (sub && sub.status === 'reviewed') return fail(ctx.res, 3005, '作业已批改，如需重交请让老师打回');

  const qs = await repo.questions.byHomework(hw.id);
  const given = Array.isArray(ctx.body.answers) ? ctx.body.answers : [];
  const byQ = new Map(given.map((a) => [Number(a.questionId), a]));
  const photos = new Map();                // questionId -> 解码后的照片

  // 先校验：需要老师批改的题必须真的交了东西，避免"提交成功"却什么都没收到
  for (const [i, q] of qs.entries()) {
    const a = byQ.get(q.id) || {};
    if (q.type === 'photo' && !(Array.isArray(a.photos) && a.photos.length)) return fail(ctx.res, 1001, `第 ${i + 1} 题还没有拍照`);
    if (q.type === 'audio' && !a.audioBase64) return fail(ctx.res, 1001, `第 ${i + 1} 题还没有录音`);
    if (q.type === 'text' && !String(a.value || '').trim()) return fail(ctx.res, 1001, `第 ${i + 1} 题还没有作答`);
    if (q.type === 'photo' && a.photos.length > 6) return fail(ctx.res, 1001, `第 ${i + 1} 题最多 6 张照片`);
    if (q.type === 'photo') {
      const imgs = [];
      for (const ph of a.photos) {
        const d = decodeImage(ph);
        if (d.error) return fail(ctx.res, 1001, `第 ${i + 1} 题照片：${d.error}`);
        imgs.push(d);                      // 解码一次留着用，后面不再从 base64 解第二遍
      }
      photos.set(q.id, imgs);
    }
  }

  let oldAssetIds = [];
  if (!sub) sub = await repo.submissions.create({ homeworkId: hw.id, studentId: ctx.user.id, elapsedSec: ctx.body.elapsedSec });
  else {
    await repo.submissions.markResubmitted(sub.id, ctx.body.elapsedSec);
    oldAssetIds = (await repo.answers.bySubmission(sub.id)).flatMap((x) => x.assetIds);
  }

  const rows = [];
  let score = 0, maxScore = 0, manual = 0;
  const results = [];
  for (const q of qs) {
    const a = byQ.get(q.id) || {};
    maxScore += Number(q.score) || 0;
    const row = { questionId: q.id, value: null, assetIds: [], autoCorrect: null, score: null };
    if (grading.AUTO_TYPES.includes(q.type)) {
      row.value = a.value === undefined ? null : a.value;
      const r = grading.gradeQuestion(q, row.value);
      row.autoCorrect = r.correct; row.score = r.score; score += r.score;
    } else {
      manual++;
      if (q.type === 'text') row.value = String(a.value).slice(0, 5000);
      if (q.type === 'photo') {
        for (const d of photos.get(q.id) || []) {
          const { asset } = await putAssetBuf('photo', d.buf, d.ext, { mime: 'image/' + d.ext });
          row.assetIds.push(asset.id);
        }
      }
      if (q.type === 'audio') {
        const { asset } = await putAsset('rec', a.audioBase64, a.ext || 'webm', { durationMs: Number(a.durationMs) || null });
        row.assetIds.push(asset.id);
      }
    }
    rows.push(row);
    results.push({ questionId: q.id, correct: row.autoCorrect, score: row.score });
  }
  await repo.answers.replaceAll(sub.id, rows);
  await dropAssets(oldAssetIds);           // 重交后旧照片、旧录音不再留在磁盘上

  // 全是客观题：系统直接批改完成；有主观题：等老师
  const allAuto = manual === 0;
  const stars = allAuto ? Math.max(1, Math.min(5, Math.round((maxScore ? score / maxScore : 0) * 5))) : null;
  await repo.submissions.setScore(sub.id, { score, maxScore, status: allAuto ? 'reviewed' : 'submitted', stars });
  await repo.users.addStars(ctx.user.id, 5 + (allAuto ? stars * 2 : 0));
  ok(ctx.res, { submissionId: sub.id, status: allAuto ? 'reviewed' : 'submitted', score, maxScore, pending: manual, results });
});

/** 老师批改题目作业：给主观题打分，勾选优秀 */
on('POST', '/api/submissions/:id/grade', async (ctx) => {
  const sub = await repo.submissions.byId(ctx.params.id);
  if (!sub) return fail(ctx.res, 3006, '提交记录不存在');
  const hw = await repo.homeworks.byId(sub.homeworkId);
  if (!hw || !await canTouchClass(ctx.user, hw.classId)) return fail(ctx.res, 403, '这不是你带的班');
  if (hw.kind !== 'questions') return fail(ctx.res, 1001, '这不是题目作业');
  const qs = await repo.questions.byHomework(hw.id);
  const ans = await repo.answers.bySubmission(sub.id);
  const given = new Map((Array.isArray(ctx.body.scores) ? ctx.body.scores : []).map((x) => [Number(x.answerId), x]));

  let score = 0, maxScore = 0;
  for (const q of qs) {
    maxScore += Number(q.score) || 0;
    const a = ans.find((x) => x.questionId === q.id);
    if (!a) continue;
    if (grading.AUTO_TYPES.includes(q.type)) { score += Number(a.score) || 0; continue; }
    const g = given.get(a.id);
    const v = g ? Number(g.score) : (a.score == null ? NaN : Number(a.score));
    if (!(v >= 0 && v <= Number(q.score))) return fail(ctx.res, 1001, `第 ${q.sort} 题要打 0–${q.score} 分`);
    await repo.answers.setManual(a.id, { score: v, comment: g ? String(g.comment || '').slice(0, 500) : a.comment });
    score += v;
  }
  const first = sub.status !== 'reviewed';
  const stars = Math.max(1, Math.min(5, Math.round((maxScore ? score / maxScore : 0) * 5)));
  await repo.submissions.setScore(sub.id, { score, maxScore, status: 'reviewed', stars });
  await repo.submissions.review(sub.id, { stars, reviewText: String(ctx.body.reviewText || '').slice(0, 500) });
  await repo.submissions.setExcellent(sub.id, !!ctx.body.excellent);
  if (first) await repo.users.addStars(sub.studentId, stars * 2 + (ctx.body.excellent ? 10 : 0));
  ok(ctx.res, { score, maxScore, stars });
}, { roles: ['teacher', 'admin'] });

/* ================= 宣传：喜报、作品、预约试听 ================= */
on('POST', '/api/shares', async (ctx) => {
  const type = ctx.body.type;
  if (!['praise', 'work'].includes(type)) return fail(ctx.res, 1001, '分享类型不对');
  const sub = await repo.submissions.byId(ctx.body.submissionId);
  if (!sub || sub.studentId !== ctx.user.id) return fail(ctx.res, 403, '只能分享自己的作业');
  if (sub.status !== 'reviewed') return fail(ctx.res, 3011, '老师批改后才能分享');
  const hw = await repo.homeworks.byId(sub.homeworkId);
  const subject = await repo.subjects.byId(hw.subjectId);
  if (type === 'praise' && !sub.excellent) return fail(ctx.res, 3011, '被评为优秀作业才有喜报');

  let photoIds = [];
  if (type === 'work') {
    if (!subject || subject.code !== 'calli') return fail(ctx.res, 3011, '作品展目前只收书法作品');
    for (const a of await repo.answers.bySubmission(sub.id)) photoIds.push(...a.assetIds);
    const imgs = [];
    for (const id of photoIds) { const x = await repo.assets.byId(id); if (x && x.kind === 'photo') imgs.push(id); }
    photoIds = imgs;
    if (!photoIds.length) return fail(ctx.res, 3011, '这份作业没有作品照片');
  }
  const img = decodeImage(ctx.body.imageBase64);
  if (img.error) return fail(ctx.res, 1001, '分享图：' + img.error);

  const token = rid().slice(0, 20);
  const imagePath = `shares/${token}.${img.ext}`;
  await store.saveAs(imagePath, img.buf);
  const showFullName = !!ctx.body.showFullName;
  const shown = showFullName ? ctx.user.name : maskName(ctx.user.name);
  const share = await repo.shares.create({
    token, type, studentId: ctx.user.id, submissionId: sub.id, subjectId: subject ? subject.id : null,
    title: type === 'praise' ? `${shown}的优秀作业喜报` : `${shown}的书法作品`,
    imagePath, photoIds, comment: sub.reviewText, stars: sub.stars, showFullName,
  });
  ok(ctx.res, { id: share.id, token, url: '/s/' + token });
});

on('GET', '/api/shares/mine', async (ctx) => {
  const list = await repo.shares.byStudent(ctx.user.id);
  ok(ctx.res, list.map((x) => ({ id: x.id, type: x.type, title: x.title, url: '/s/' + x.token, status: x.status,
    views: x.views, createdAt: x.createdAt, image: x.status === 'active' ? store.urlOf(x.imagePath) : null })));
});

on('POST', '/api/shares/:id/revoke', async (ctx) => {
  const share = await repo.shares.byId(ctx.params.id);
  if (!share) return fail(ctx.res, 3012, '分享不存在');
  if (ctx.user.role === 'student' && share.studentId !== ctx.user.id) return fail(ctx.res, 403, '只能撤回自己的分享');
  await repo.shares.revoke(share.id);
  await store.remove(share.imagePath);                 // 撤回后分享图一并删除
  ok(ctx.res, { ok: true });
});

const GRADES = ['一年级', '二年级', '三年级', '四年级', '五年级', '六年级', '初一', '初二', '初三', '其他'];
const leadHits = new Map();
// 按 IP 限流。同一个 Wi-Fi 下几位家长一起报名很常见，上限不能太小；
// 真正防重复提交的是下面"同一手机号 10 分钟内只记一条"。
const LEADS_PER_HOUR = Number(process.env.LEADS_PER_HOUR) || 20;

on('POST', '/api/public/leads', async (ctx) => {
  const b = ctx.body;
  const phone = String(b.phone || '').replace(/\s|-/g, '');
  if (!/^1[3-9]\d{9}$/.test(phone)) return fail(ctx.res, 1001, '请填写正确的 11 位手机号');
  if (!GRADES.includes(b.grade)) return fail(ctx.res, 1001, '请选择孩子年级');
  if (!b.agree) return fail(ctx.res, 1001, '请勾选同意机构老师联系您');
  const codes = (await repo.subjects.all()).map((x) => x.code);
  const subjects = (Array.isArray(b.subjects) ? b.subjects : []).filter((c) => codes.includes(c));
  const allCourses = await repo.courses.all();
  const courses = (Array.isArray(b.courses) ? b.courses : [])
    .map(Number).filter((id) => allCourses.some((c) => c.id === id)).slice(0, 10);
  const message = String(b.message || '').trim().slice(0, 300);      // 家长自己写的备注

  const ip = String(ctx.req.headers['x-forwarded-for'] || ctx.req.socket.remoteAddress || '').split(',')[0].trim();
  const nowMs = Date.now();
  // 顺手清掉过期的 IP，免得这张表一直涨
  for (const [k, v] of leadHits) if (!v.some((t) => nowMs - t < 3600e3)) leadHits.delete(k);
  const hits = (leadHits.get(ip) || []).filter((t) => nowMs - t < 3600e3);
  if (hits.length >= LEADS_PER_HOUR) return fail(ctx.res, 429, '提交太频繁了，请稍后再试');
  hits.push(nowMs); leadHits.set(ip, hits);

  const tenMinAgo = new Date(nowMs - 600e3).toISOString().replace('T', ' ').slice(0, 19);
  if (await repo.leads.recentByPhone(phone, tenMinAgo)) return ok(ctx.res, { ok: true, duplicate: true });  // 连点提交不重复记录

  let share = null;
  if (b.token) { share = await repo.shares.byToken(b.token); if (share && share.status !== 'active') share = null; }
  await repo.leads.create({
    shareId: share ? share.id : null, refStudentId: share ? share.studentId : null,
    source: share ? 'share' : (b.source === 'gallery' ? 'gallery' : 'trial'),
    phone, grade: b.grade, subjects, courses, message, contactTime: String(b.contactTime || '').slice(0, 50), ip,
  });
  ok(ctx.res, { ok: true });
}, { auth: false });

on('GET', '/api/admin/leads', async (ctx) => {
  const subs = await repo.subjects.all();
  const cs = await repo.courses.all();
  const list = await repo.leads.list();
  ok(ctx.res, list.map((l) => ({ ...l,
    subjectNames: l.subjects.map((c) => (subs.find((x) => x.code === c) || {}).name).filter(Boolean),
    courseNames: l.courses.map((id) => (cs.find((x) => x.id === id) || {}).name).filter(Boolean) })));
}, { roles: ['admin'] });

on('PUT', '/api/admin/leads/:id', async (ctx) => {
  const status = ctx.body.status;
  if (status && !['new', 'contacted', 'enrolled', 'invalid'].includes(status)) return fail(ctx.res, 1001, '状态不对');
  await repo.leads.update(ctx.params.id, { status, note: ctx.body.note });
  ok(ctx.res, { ok: true });
}, { roles: ['admin'] });

on('DELETE', '/api/admin/leads/:id', async (ctx) => {
  await repo.leads.remove(ctx.params.id);
  ok(ctx.res, { ok: true });
}, { roles: ['admin'] });

on('GET', '/api/admin/promo-stats', async (ctx) => {
  const since = new Date(Date.now() - 7 * 86400e3).toISOString().replace('T', ' ').slice(0, 19);
  const s = await repo.shares.stats(since);
  ok(ctx.res, { last7: { shares: s.recentShares, views: s.recentViews, leads: await repo.leads.countSince(since) },
    activeShares: s.activeShares, newLeads: await repo.leads.countNew(), top: s.top });
}, { roles: ['admin'] });

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
    const query = Object.fromEntries(new URL(req.url, 'http://x').searchParams);
    await route.handler({ req, res, user, params, body, query });
  } catch (e) {
    // repo 抛出的业务异常带 code，按业务错误返回；其余才算服务端错误
    if (Number.isInteger(e.code) && e.code >= 1000 && e.code < 6000) return fail(res, e.code, e.message);
    console.error('[api error]', pathname, e);
    fail(res, 500, '服务端错误: ' + e.message);
  }
}

module.exports = { handleApi, CHECKIN_SECONDS, maskName };
