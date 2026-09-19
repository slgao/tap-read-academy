'use strict';
/**
 * 业务接口层 —— 这里没有一句 SQL，也不碰文件系统。
 * 数据走 repo.js，文件走 storage.js。迁移到微信云开发时本文件不需要改动。
 */
const repo = require('./repo');
const store = require('./storage');
const { ok, fail, readBody, rid, sha256, staffCode, encryptSecret, decryptSecret, today, dayKey, now, inviteCode } = require('./util');
const grading = require('./grading');
const schedule = require('./schedule');

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

/* 作业班的评分栏：四项打星 + 作业时长 + 一句话 */
const RUBRIC_ITEMS = [
  { key: 'write', name: '书写' }, { key: 'posture', name: '坐姿' },
  { key: 'attitude', name: '学习态度' }, { key: 'efficiency', name: '作业效率' },
];
function cleanRubric(x) {
  if (!x || typeof x !== 'object') return null;
  const out = {};
  for (const it of RUBRIC_ITEMS) {
    const v = Number(x[it.key]);
    if (v >= 1 && v <= 5) out[it.key] = Math.round(v);
  }
  const min = Number(x.minutes);
  if (min > 0 && min <= 600) out.minutes = Math.round(min);
  const other = String(x.other || '').trim().slice(0, 100);
  if (other) out.other = other;
  return Object.keys(out).length ? out : null;
}

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
  let joinState = null;
  if (role === 'student') {
    const device = String(ctx.body.device || '').slice(0, 40);
    user = await repo.users.byNameRole(nm, 'student');
    if (!user) {
      // 同一台手机一天里最多建三个新账号，挡住"换个名字再来一次"
      const since = new Date(Date.now() - 86400e3).toISOString().replace('T', ' ').slice(0, 19);
      if (device && await repo.users.countByDevice(device, since) >= 3) {
        return fail(ctx.res, 3019, '这台手机今天新建的账号太多了，请让老师把你加进班里');
      }
      user = await repo.users.create({ openid: 'dev_' + rid().slice(0, 12), role: 'student', name: nm });
    }
    if (device && !user.device) await repo.users.bindDevice(user.id, device);
    if (code) {
      const cls = await repo.classes.byInviteCode(String(code).toUpperCase().trim());
      if (!cls) return fail(ctx.res, 3001, '班级邀请码不存在');
      joinState = await joinClass(cls, user, device);
    }
  } else {
    // 本机直连（没有经过反向代理）不限流：线上请求都带 X-Forwarded-For，这里只放过服务器自己和本地开发
    const direct = !ctx.req.headers['x-forwarded-for'] && /^(127\.|::1|::ffff:127\.)/.test(ip || '');
    if (!direct && loginBlocked(ip)) return fail(ctx.res, 429, '尝试太多次了，请过十分钟再试');
    const given = String(ctx.body.teacherCode || '').trim();
    if (!given) return fail(ctx.res, 1001, '请输入口令');
    const master = process.env.TEACHER_CODE;
    user = await repo.users.staffByName(nm);
    if (master && given === master) {
      // 主口令：负责人入口，账号不存在就建一个
      if (!user) user = await repo.users.create({ openid: 'dev_' + rid().slice(0, 12), role: 'admin', name: nm });
      else if (user.role !== 'admin') { if (!direct) noteLoginFail(ip); return fail(ctx.res, 2001, '这是老师账号，请用负责人给你的口令登录'); }
    } else {
      if (!user || !user.loginCode || sha256(given) !== user.loginCode) {
        if (!direct) noteLoginFail(ip);
        return fail(ctx.res, 2001, '姓名或口令不对');
      }
      if (!user.active) return fail(ctx.res, 2001, '这个账号已经停用，请找负责人');
    }
  }
  const token = rid() + rid();
  await repo.sessions.create(token, user.id);
  ok(ctx.res, { token, user: publicUser(user), ...(joinState ? { join: joinState } : {}) });
}

/**
 * 学生进班：名单上已有这个名字（老师建过档）就直接进；
 * 自己新报的名字先挂起，等老师在「待入班」里确认，防止一个学生用不同名字把班刷满。
 */
async function joinClass(cls, user, device) {
  const cur = await repo.classes.memberStatus(cls.id, user.id);
  if (cur === 'active') return { status: 'active', className: cls.name };
  if (cur === 'pending') return { status: 'pending', className: cls.name };
  // 老师建过档的学生：名单里有他，直接放行
  const known = (await repo.classes.members(cls.id)).some((m) => m.id === user.id);
  if (known) return { status: 'active', className: cls.name };
  await repo.classes.addMember(cls.id, user.id, { status: 'pending', device });
  return { status: 'pending', className: cls.name };
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
/* 年级/层次只是给班级贴个标签，机构的分法五花八门（按年级、按程度、按考级），
 * 所以这里不做固定选项，只给点常用的建议，老师想怎么写就怎么写，也可以不写。 */
const GRADE_SUGGEST = [
  { group: '常用', items: ['一二年级', '三四年级', '五六年级', '初中', '不分年级'] },
  { group: '按年级', items: ['幼小衔接', '一年级', '二年级', '三年级', '四年级', '五年级', '六年级', '初一', '初二', '初三'] },
  { group: '按程度', items: ['启蒙班', '基础班', '提高班', '冲刺班', '考级班'] },
];
const GRADE_BANDS = GRADE_SUGGEST.flatMap((g) => g.items);

/** 老师只能看自己带的班，学生只能看自己在的班；admin 不限 */
async function canTouchClass(user, classId) {
  if (user.role === 'admin') return true;
  return (await repo.classes.idsForUser(user)).includes(Number(classId));
}

async function classView(c) {
  const course = c.courseId ? await repo.courses.byId(c.courseId) : null;
  return { id: c.id, name: c.name, inviteCode: c.inviteCode, teacherId: c.teacherId,
    subject: subjectView(await repo.subjects.byId(c.subjectId)), gradeBand: c.gradeBand,
    course: course ? { id: course.id, name: course.name } : null,
    schedule: c.schedule, scheduleText: schedule.text(c.schedule),
    meetsToday: schedule.meetsOn(c.schedule, today()), nextClassAt: schedule.nextMeeting(c.schedule, today()),
    studentCount: await repo.classes.memberCount(c.id) };
}

on('GET', '/api/classes', async (ctx) => {
  const subs = await repo.subjects.all();
  const allCourses = await repo.courses.all();
  const ids = await repo.classes.idsForUser(ctx.user);
  const [byId, counts] = [await repo.classes.byIds(ids), await repo.classes.memberCounts(ids)];
  // withMembers=1：把各班名单一起带回去，省得前端一个班一个请求
  const members = ctx.query.withMembers ? await repo.classes.membersOfMany(ids) : null;
  const rows = [];
  for (const id of ids) {
    const c = byId.get(id);
    if (!c) continue;
    const t = ctx.user.role === 'admin' ? await repo.users.byId(c.teacherId) : null;
    const course = c.courseId ? allCourses.find((x) => x.id === c.courseId) : null;
    rows.push({ id: c.id, name: c.name, inviteCode: c.inviteCode, teacherId: c.teacherId,
      teacherName: t ? t.name : (c.teacherId === ctx.user.id ? ctx.user.name : ''),
      subject: subjectView(subs.find((x) => x.id === c.subjectId)), gradeBand: c.gradeBand,
      course: course ? { id: course.id, name: course.name } : null,
      schedule: c.schedule, scheduleText: schedule.text(c.schedule),
      meetsToday: schedule.meetsOn(c.schedule, today()), nextClassAt: schedule.nextMeeting(c.schedule, today()),
      studentCount: counts.get(c.id) || 0,
      ...(members ? { members: members.get(c.id) || [] } : {}) });
  }
  // 按科目、年级段排好，界面直接分组显示
  const sortOf = (r) => (subs.find((x) => r.subject && x.id === r.subject.id) || { sort: 99 }).sort;
  const band = (r) => { const i = GRADE_BANDS.indexOf(r.gradeBand); return i < 0 ? 99 : i; };   // 认识的排前面，自定义的排后面
  rows.sort((a, b) => sortOf(a) - sortOf(b) || band(a) - band(b) || a.id - b.id);
  ok(ctx.res, rows);
});

on('GET', '/api/grade-bands', async (ctx) => ok(ctx.res, GRADE_BANDS), { auth: false });

/** 基本不变的数据合到一个接口：科目、课程、年级段。前端缓存着用，少几次往返 */
on('GET', '/api/meta', async (ctx) => {
  const cs = await repo.courses.all();
  const subjects = (await repo.subjects.all()).map((x) => ({ ...subjectView(x),
    courses: cs.filter((c) => c.subjectId === x.id).map((c) => ({ id: c.id, name: c.name })) }));
  const mine = ctx.user.role === 'student' ? [] : await repo.subjects.idsForTeacher(ctx.user.id);
  ok(ctx.res, { subjects, mine, gradeBands: GRADE_BANDS, gradeSuggest: GRADE_SUGGEST });
});

/** 校验班级表单；班名不填时按「年级段 + 科目 + 班」自动起名 */
async function classForm(body, user) {
  const subject = await repo.subjects.byId(body.subjectId);
  if (!subject) return { error: '请选择科目' };
  let courseId = null;
  if (body.courseId) {
    const course = await repo.courses.byId(body.courseId);
    if (!course || course.subjectId !== subject.id) return { error: '这门课程不属于所选科目' };
    courseId = course.id;
  }
  // 老师只能开自己教的科目；负责人不限。没给老师设科目时不拦（老账号照常用）
  if (user && user.role === 'teacher') {
    const mine = await repo.subjects.idsForTeacher(user.id);
    if (mine.length && !mine.includes(subject.id)) return { error: `你教的科目里没有「${subject.name}」，请让负责人先加上` };
  }
  const gradeBand = String(body.gradeBand || '').trim().slice(0, 12);   // 自己随便写，不写也行
  const sched = schedule.clean(body.schedule);
  const course = courseId ? await repo.courses.byId(courseId) : null;
  // 不填班名就按「年级段 + 课程（或科目）+ 班」自动起，比如「三四年级新概念英语班」
  const label = (gradeBand && gradeBand !== '不分年级') ? gradeBand : '';
  const name = String(body.name || '').trim().slice(0, 30) || `${label}${course ? course.name : subject.name}班`;
  return { subject, gradeBand, name, courseId, schedule: sched };
}

on('POST', '/api/classes', async (ctx) => {
  const f = await classForm(ctx.body, ctx.user);
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
  const cls = await repo.classes.create({ name: f.name, inviteCode: code, teacherId, subjectId: f.subject.id,
    gradeBand: f.gradeBand, courseId: f.courseId, schedule: f.schedule });
  // 新班级默认可见全部教材（MVP 简化）
  for (const b of await repo.books.all()) await repo.books.grantToClass(b.id, cls.id);
  ok(ctx.res, await classView(cls));
}, { roles: ['teacher', 'admin'] });

on('PUT', '/api/classes/:id', async (ctx) => {
  const cls = await repo.classes.byId(ctx.params.id);
  if (!cls) return fail(ctx.res, 3001, '班级不存在');
  if (ctx.user.role === 'teacher' && cls.teacherId !== ctx.user.id) return fail(ctx.res, 403, '只能修改自己带的班');
  const f = await classForm(ctx.body, ctx.user);
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
  await repo.classes.update(cls.id, { name: f.name, subjectId: f.subject.id, gradeBand: f.gradeBand,
    courseId: f.courseId, schedule: f.schedule });
  ok(ctx.res, await classView(await repo.classes.byId(cls.id)));
}, { roles: ['teacher', 'admin'] });

on('DELETE', '/api/classes/:id', async (ctx) => {
  const cls = await repo.classes.byId(ctx.params.id);
  if (!cls) return fail(ctx.res, 3001, '班级不存在');
  if (ctx.user.role === 'teacher' && cls.teacherId !== ctx.user.id) return fail(ctx.res, 403, '只能删除自己带的班');
  if (await repo.homeworks.countByClass(cls.id)) return fail(ctx.res, 3009, '这个班布置过作业，不能删除');
  if (await repo.classes.attendanceCount(cls.id)) return fail(ctx.res, 3009, '这个班点过名，课时记录要留底，不能删除');
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

/** 输入邀请码后先看到：这是哪个班、名单上还有哪些名字没人认领 */
on('POST', '/api/classes/preview', async (ctx) => {
  const cls = await repo.classes.byInviteCode(String(ctx.body.inviteCode || '').toUpperCase().trim());
  if (!cls) return fail(ctx.res, 3001, '邀请码不对，问一下老师');
  const subject = await repo.subjects.byId(cls.subjectId);
  ok(ctx.res, { classId: cls.id, className: cls.name, subject: subjectView(subject),
    names: await repo.classes.unclaimed(cls.id) });
}, { auth: false });

/** 点名单上的名字进班：把这个名字和这台手机绑定，别人再点就点不动了 */
on('POST', '/api/auth/claim', async (ctx) => {
  const cls = await repo.classes.byInviteCode(String(ctx.body.inviteCode || '').toUpperCase().trim());
  if (!cls) return fail(ctx.res, 3001, '邀请码不对，问一下老师');
  const device = String(ctx.body.device || '').slice(0, 40);
  const u = await repo.users.byId(ctx.body.studentId);
  if (!u || u.role !== 'student') return fail(ctx.res, 3015, '名单上没有这个人');
  const members = await repo.classes.members(cls.id);
  if (!members.some((m) => m.id === u.id)) return fail(ctx.res, 3015, '这个名字不在这个班的名单里');
  if (u.device && device && u.device !== device) {
    return fail(ctx.res, 3019, '这个名字已经有人在用了，如果是你本人，请让老师重新确认');
  }
  if (device && !u.device) await repo.users.bindDevice(u.id, device);
  const token = rid() + rid();
  await repo.sessions.create(token, u.id);
  ok(ctx.res, { token, user: publicUser(u), join: { status: 'active', className: cls.name } });
}, { auth: false });

on('POST', '/api/classes/join', async (ctx) => {
  const cls = await repo.classes.byInviteCode(String(ctx.body.inviteCode || '').toUpperCase().trim());
  if (!cls) return fail(ctx.res, 3001, '班级邀请码不存在');
  const state = await joinClass(cls, ctx.user, String(ctx.body.device || '').slice(0, 40));
  ok(ctx.res, { ...(await classView(cls)), join: state });
}, { roles: ['student'] });

/* ---------- 待入班：老师确认后学生才进班 ---------- */
on('GET', '/api/admin/join-requests', async (ctx) => {
  const ids = await repo.classes.idsForUser(ctx.user);
  const list = await repo.classes.pendingJoins(ids);
  // 同一台手机提交了好几次，多半是同一个孩子换名字反复进
  const byDevice = {};
  for (const r of list) if (r.device) byDevice[r.device] = (byDevice[r.device] || 0) + 1;
  ok(ctx.res, list.map((r) => ({ ...r, device: undefined, sameDevice: r.device ? byDevice[r.device] : 1 })));
}, { roles: ['teacher', 'admin'] });

on('POST', '/api/admin/join-requests/:classId/:studentId/:action', async (ctx) => {
  const cls = await repo.classes.byId(ctx.params.classId);
  if (!cls) return fail(ctx.res, 3001, '班级不存在');
  if (!await canTouchClass(ctx.user, cls.id)) return fail(ctx.res, 403, '这不是你带的班');
  const sid = Number(ctx.params.studentId);
  if (await repo.classes.memberStatus(cls.id, sid) !== 'pending') return fail(ctx.res, 3019, '这条申请已经处理过了');
  if (ctx.params.action === 'approve') {
    await repo.classes.setMemberStatus(cls.id, sid, 'active');
    return ok(ctx.res, { ok: true, status: 'active' });
  }
  if (ctx.params.action === 'reject') {
    await repo.classes.removeMember(cls.id, sid);
    // 顺手清掉这个“查无此人”的空账号：没进任何班、也没交过作业才删
    const u = await repo.users.byId(sid);
    if (u && u.role === 'student' && !(await repo.classes.forStudent(sid)).length
      && !(await repo.submissions.countByStudent(sid))) await repo.users.remove(sid);
    return ok(ctx.res, { ok: true, status: 'rejected' });
  }
  fail(ctx.res, 1001, '操作不对');
}, { roles: ['teacher', 'admin'] });

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
  if (user.role !== 'student') out.pending = Math.max(0, (out.submitted || 0) - (out.reviewed || 0));   // 还等着批改的份数
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
      out.mySubmission = { id: sub.id, status: sub.status, stars: sub.stars, rubric: sub.rubric,
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
        stars: sub ? sub.stars : null, reviewText: sub ? sub.reviewText : null, excellent: sub ? sub.excellent : false,
        rubric: sub ? sub.rubric : null, answers });
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
      rubric: sub ? sub.rubric : null,
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
  if ('rubric' in ctx.body) await repo.submissions.setRubric(sub.id, cleanRubric(ctx.body.rubric));
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
  const staff = await repo.users.staff();
  const mineSubjects = await repo.subjects.byTeachers(staff.map((u) => u.id));
  const classCounts = await repo.classes.countsByTeacher();
  const out = [];
  for (const u of staff) {
    out.push({ id: u.id, name: u.name, role: u.role, roleName: ROLE_NAME[u.role] || u.role,
      active: !!u.active, hasCode: !!u.loginCode, canShowCode: !!u.loginCodeEnc, isMe: u.id === ctx.user.id,
      subjectIds: mineSubjects.get(u.id) || [],
      classCount: classCounts.get(u.id) || 0, createdAt: u.createdAt });
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
  await repo.users.setLoginCode(user.id, sha256(code), encryptSecret(code));
  ok(ctx.res, { id: user.id, name, code });
}, { roles: ['admin'] });

/** 查看某位老师当前的口令（负责人忘了发给谁时用） */
on('GET', '/api/admin/teachers/:id/code', async (ctx) => {
  const u = await repo.users.byId(ctx.params.id);
  if (!u || u.role === 'student') return fail(ctx.res, 3013, '账号不存在');
  if (u.role === 'admin') return fail(ctx.res, 3013, '负责人用部署时设置的主口令登录，系统里不保存');
  const code = u.loginCodeEnc ? decryptSecret(u.loginCodeEnc) : null;
  if (!code) return fail(ctx.res, 3013, '这个口令是早先设置的，看不回来了，点「重置口令」生成一个新的');
  ok(ctx.res, { id: u.id, name: u.name, code });
}, { roles: ['admin'] });

/** 重置口令：老师忘了口令时用，旧口令立刻失效 */
on('POST', '/api/admin/teachers/:id/code', async (ctx) => {
  const u = await repo.users.byId(ctx.params.id);
  if (!u || u.role === 'student') return fail(ctx.res, 3013, '账号不存在');
  const code = staffCode();
  await repo.users.setLoginCode(u.id, sha256(code), encryptSecret(code));
  ok(ctx.res, { id: u.id, name: u.name, code });
}, { roles: ['admin'] });

/** 负责人给老师分科目：定了科目，这位老师就只能开这些科目的班 */
on('PUT', '/api/admin/teachers/:id/subjects', async (ctx) => {
  const u = await repo.users.byId(ctx.params.id);
  if (!u || u.role === 'student') return fail(ctx.res, 3013, '账号不存在');
  const all = await repo.subjects.all();
  const ids = (Array.isArray(ctx.body.subjectIds) ? ctx.body.subjectIds : []).map(Number).filter((id) => all.some((x) => x.id === id));
  await repo.subjects.setForTeacher(u.id, ids);
  ok(ctx.res, { subjectIds: ids });
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

/** 某位老师名下的班（转班时用来一个班一个班地分） */
on('GET', '/api/admin/teachers/:id/classes', async (ctx) => {
  const u = await repo.users.byId(ctx.params.id);
  if (!u || u.role === 'student') return fail(ctx.res, 3013, '账号不存在');
  const subs = await repo.subjects.all();
  const rows = await repo.classes.byTeacher(u.id);
  const counts = await repo.classes.memberCounts(rows.map((c) => c.id));
  ok(ctx.res, rows.map((c) => ({ id: c.id, name: c.name, gradeBand: c.gradeBand,
    subject: subjectView(subs.find((x) => x.id === c.subjectId)), studentCount: counts.get(c.id) || 0 })));
}, { roles: ['admin'] });

/** 按班转：可以把不同的班分给不同的老师，一次提交 */
on('POST', '/api/admin/classes/transfer', async (ctx) => {
  const moves = (Array.isArray(ctx.body.moves) ? ctx.body.moves : []).slice(0, 50);
  if (!moves.length) return fail(ctx.res, 1001, '请先选好每个班要转给谁');
  const checked = [];
  for (const m of moves) {
    const cls = await repo.classes.byId(m.classId);
    if (!cls) return fail(ctx.res, 3001, '班级不存在');
    const to = await repo.users.byId(m.toId);
    if (!to || to.role === 'student') return fail(ctx.res, 3013, '请选择要转给哪位老师');
    if (!to.active) return fail(ctx.res, 3013, `${to.name} 的账号已停用，不能接班`);
    // 老师只带自己教的科目：科目对不上先让负责人去加科目，免得他接了课却开不了班
    if (to.role === 'teacher') {
      const mine = await repo.subjects.idsForTeacher(to.id);
      if (mine.length && cls.subjectId && !mine.includes(cls.subjectId)) {
        const sub = await repo.subjects.byId(cls.subjectId);
        return fail(ctx.res, 3013, `${to.name} 教的科目里没有「${sub ? sub.name : ''}」，先在账号里加上这个科目`);
      }
    }
    checked.push({ cls, to });
  }
  for (const { cls, to } of checked) await repo.classes.setTeacher(cls.id, to.id);
  ok(ctx.res, { moved: checked.length, detail: checked.map((x) => `${x.cls.name} → ${x.to.name}`) });
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

/* ---------- 子科目（课程）：老师自己维护 ---------- */
/** 老师只能管自己教的科目下的课程；负责人不限 */
async function canTouchSubject(user, subjectId) {
  if (user.role === 'admin') return true;
  const mine = await repo.subjects.idsForTeacher(user.id);
  return !mine.length || mine.includes(Number(subjectId));
}

on('GET', '/api/courses', async (ctx) => {
  const subs = await repo.subjects.all();
  const list = await repo.courses.all();
  const out = [];
  for (const c of list) {
    const usage = ctx.user.role === 'student' ? null : await repo.courses.usage(c.id);
    out.push({ id: c.id, subjectId: c.subjectId, name: c.name, sort: c.sort, public: c.public,
      subject: subjectView(subs.find((x) => x.id === c.subjectId)),
      ...(usage ? { classCount: usage.classes, canDelete: usage.classes + usage.packages === 0 } : {}) });
  }
  ok(ctx.res, out);
});

on('POST', '/api/courses', async (ctx) => {
  const subject = await repo.subjects.byId(ctx.body.subjectId);
  if (!subject) return fail(ctx.res, 1001, '请选择科目');
  if (!await canTouchSubject(ctx.user, subject.id)) return fail(ctx.res, 403, `你教的科目里没有「${subject.name}」`);
  const name = String(ctx.body.name || '').trim().slice(0, 20);
  if (!name) return fail(ctx.res, 1001, '请填写课程名称，比如「新概念英语」');
  if (await repo.courses.byName(subject.id, name)) return fail(ctx.res, 3018, `${subject.name}下面已经有「${name}」了`);
  const c = await repo.courses.create({ subjectId: subject.id, name, sort: Number(ctx.body.sort) || 99 });
  ok(ctx.res, { id: c.id, subjectId: c.subjectId, name: c.name });
}, { roles: ['teacher', 'admin'] });

on('PUT', '/api/courses/:id', async (ctx) => {
  const c = await repo.courses.byId(ctx.params.id);
  if (!c) return fail(ctx.res, 3018, '课程不存在');
  if (!await canTouchSubject(ctx.user, c.subjectId)) return fail(ctx.res, 403, '这不是你教的科目');
  const name = String(ctx.body.name == null ? c.name : ctx.body.name).trim().slice(0, 20);
  if (!name) return fail(ctx.res, 1001, '课程名称不能为空');
  const dup = await repo.courses.byName(c.subjectId, name);
  if (dup && dup.id !== c.id) return fail(ctx.res, 3018, `已经有「${name}」了`);
  // 是否显示在家长预约页上，只有负责人能改
  const isPublic = (ctx.user.role === 'admin' && ctx.body.public !== undefined) ? ctx.body.public : undefined;
  ok(ctx.res, await repo.courses.update(c.id, { name, sort: ctx.body.sort, active: ctx.body.active, isPublic }));
}, { roles: ['teacher', 'admin'] });

on('DELETE', '/api/courses/:id', async (ctx) => {
  const c = await repo.courses.byId(ctx.params.id);
  if (!c) return fail(ctx.res, 3018, '课程不存在');
  if (!await canTouchSubject(ctx.user, c.subjectId)) return fail(ctx.res, 403, '这不是你教的科目');
  const usage = await repo.courses.usage(c.id);
  if (usage.classes + usage.packages) {
    return fail(ctx.res, 3018, `还有 ${usage.classes} 个班、${usage.packages} 个课包在用这门课程，改名就行，别删`);
  }
  await repo.courses.remove(c.id);
  ok(ctx.res, { ok: true });
}, { roles: ['teacher', 'admin'] });

/* ---------- 机构联系方式：电话、地址、微信二维码 ---------- */
const CONTACT_KEY = 'contact';
async function contactView() {
  const c = (await repo.settings.get(CONTACT_KEY, null)) || {};
  return { phone: c.phone || '', address: c.address || '', hours: c.hours || '',
    qr: c.qrId ? (await assetView(c.qrId) || {}).url || '' : '', note: c.note || '' };
}

on('GET', '/api/contact', async (ctx) => ok(ctx.res, await contactView()), { auth: false });

on('PUT', '/api/admin/contact', async (ctx) => {
  const cur = (await repo.settings.get(CONTACT_KEY, null)) || {};
  let qrId = cur.qrId || null;
  if (ctx.body.qrSvg) {
    // 矢量二维码：放大不糊，海报上也能用。只接受 <svg>，并去掉脚本和事件属性
    const raw = String(ctx.body.qrSvg).trim();
    if (!raw.startsWith('<svg') || raw.length > 200000) return fail(ctx.res, 1001, '二维码 SVG 格式不对');
    const safe = raw.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/\son\w+\s*=\s*"[^"]*"/gi, '');
    const { asset } = await putAssetBuf('photo', Buffer.from(safe, 'utf8'), 'svg', { mime: 'image/svg+xml' });
    qrId = asset.id;
  } else if (ctx.body.qrBase64) {
    const img = decodeImage(ctx.body.qrBase64, 5 * 1024 * 1024);
    if (img.error) return fail(ctx.res, 1001, '二维码图片：' + img.error);
    const { asset } = await putAssetBuf('photo', img.buf, img.ext, { mime: 'image/' + img.ext });
    qrId = asset.id;
  }
  if (ctx.body.removeQr) qrId = null;
  await repo.settings.set(CONTACT_KEY, {
    phone: String(ctx.body.phone == null ? cur.phone || '' : ctx.body.phone).trim().slice(0, 30),
    address: String(ctx.body.address == null ? cur.address || '' : ctx.body.address).trim().slice(0, 120),
    hours: String(ctx.body.hours == null ? cur.hours || '' : ctx.body.hours).trim().slice(0, 60),
    note: String(ctx.body.note == null ? cur.note || '' : ctx.body.note).trim().slice(0, 100),
    qrId,
  });
  ok(ctx.res, await contactView());
}, { roles: ['admin'] });

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
    reviewText: sub.reviewText, excellent: sub.excellent, rubric: sub.rubric, submittedAt: sub.submittedAt };
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
  if ('rubric' in ctx.body) await repo.submissions.setRubric(sub.id, cleanRubric(ctx.body.rubric));
  if (first) await repo.users.addStars(sub.studentId, stars * 2 + (ctx.body.excellent ? 10 : 0));
  ok(ctx.res, { score, maxScore, stars });
}, { roles: ['teacher', 'admin'] });

/* ================= 教务档案：学员档案、课时包、点名、请假 =================
 * 课时即金钱：点名才扣课时，每一笔都写流水，老师能看剩余、负责人才能看金额。
 */
const YUAN = (fen) => Math.round((Number(fen) || 0)) / 100;
const toFen = (yuan) => Math.round((Number(yuan) || 0) * 100);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

/** 老师只能看自己班里的学生，负责人看全校 */
async function visibleStudentIds(user) {
  if (user.role === 'admin') return null;                      // null = 不限
  return repo.classes.studentIdsOfClasses(await repo.classes.idsForUser(user));
}

/** 学员 -> 他所在的班（名字和 id）。一次查完，不再按班循环 */
async function classesByStudent(user) {
  const ids = await repo.classes.idsForUser(user);
  const [byId, members] = [await repo.classes.byIds(ids), await repo.classes.membersOfMany(ids)];
  const out = new Map();
  for (const [cid, list] of members) {
    const c = byId.get(cid);
    if (!c) continue;
    for (const m of list) {
      const arr = out.get(m.id) || out.set(m.id, []).get(m.id);
      arr.push(c);
    }
  }
  return out;
}

const pkgView = (p, subjects, withMoney) => {
  const total = (p.totalHours || 0) + (p.giftHours || 0);
  const expired = !!(p.expiresAt && p.expiresAt < today() && p.status === 'active');
  const v = {
    expired,
    id: p.id, subject: subjectView(subjects.find((x) => x.id === p.subjectId)),
    totalHours: p.totalHours, giftHours: p.giftHours, sumHours: total,
    usedHours: p.usedHours, leftHours: Math.round((total - p.usedHours) * 100) / 100,
    purchasedAt: p.purchasedAt, expiresAt: p.expiresAt, pausedAt: p.pausedAt,
    status: p.status, note: p.note,
  };
  if (withMoney) { v.priceOriginal = YUAN(p.priceOriginal); v.pricePaid = YUAN(p.pricePaid); }
  return v;
};

/** 汇总一个学生的课时：剩余、最近到期日 */
function hoursOf(list) {
  let left = 0, expires = null;
  for (const p of list) {
    if (p.status === 'finished') continue;
    left += (p.totalHours || 0) + (p.giftHours || 0) - (p.usedHours || 0);
    if (p.status === 'active' && p.expiresAt && (!expires || p.expiresAt < expires)) expires = p.expiresAt;
  }
  return { leftHours: Math.round(left * 100) / 100, expiresAt: expires };
}

on('GET', '/api/admin/students', async (ctx) => {
  const only = await visibleStudentIds(ctx.user);
  const kw = String(ctx.query.q || '').trim();
  let list = await repo.users.listByRole('student');
  if (only) list = list.filter((u) => only.includes(u.id));
  if (kw) list = list.filter((u) => u.name.includes(kw));
  const ids = list.map((u) => u.id);
  const [profiles, pkgs] = [await repo.profiles.byUsers(ids), await repo.packages.byStudents(ids)];
  const classesOf = await classesByStudent(ctx.user);
  const out = list.map((u) => {
    const p = profiles.get(u.id) || {};
    return { id: u.id, name: u.name, gender: p.gender || '', school: p.school || '', grade: p.grade || '',
      phone: ctx.user.role === 'admin' ? (p.phone || '') : '', parentName: p.parentName || '',
      status: p.status || 'active',
      classes: (classesOf.get(u.id) || []).map((c) => c.name),
      classIds: (classesOf.get(u.id) || []).map((c) => c.id),
      ...hoursOf(pkgs.get(u.id) || []), stars: u.stars };
  });
  out.sort((a, b) => (a.status === b.status ? a.name.localeCompare(b.name, 'zh') : a.status === 'active' ? -1 : 1));
  ok(ctx.res, out);
}, { roles: ['teacher', 'admin'] });

on('POST', '/api/admin/students', async (ctx) => {
  const name = String(ctx.body.name || '').trim().slice(0, 20);
  if (!name) return fail(ctx.res, 1001, '请填写学员姓名');
  let user = await repo.users.byNameRole(name, 'student');
  const existed = !!user;
  if (!user) user = await repo.users.create({ openid: 'dev_' + rid().slice(0, 12), role: 'student', name });
  else if (!ctx.body.force) {
    // 同名的已经有档案：不要悄悄并成一个人，先让负责人确认
    const old = await repo.profiles.byUser(user.id);
    const inClasses = await repo.classes.forStudent(user.id);
    if (old || inClasses.length) {
      return fail(ctx.res, 3015, `已经有一个叫「${name}」的学员${inClasses.length ? `（在${inClasses.map((c) => c.name).join('、')}）` : ''}。`
        + '如果是同一个孩子，直接打开他的档案改；如果是两个孩子，名字里加点区分，比如「李明(三年级)」');
    }
  }
  await repo.profiles.save(user.id, ctx.body);
  if (ctx.body.classId) {
    if (!await canTouchClass(ctx.user, ctx.body.classId)) return fail(ctx.res, 403, '不能把学生加到别人的班');
    await repo.classes.addMember(ctx.body.classId, user.id);
  }
  ok(ctx.res, { id: user.id, name: user.name, existed });
}, { roles: ['admin'] });

on('GET', '/api/admin/students/:id', async (ctx) => {
  const u = await repo.users.byId(ctx.params.id);
  if (!u || u.role !== 'student') return fail(ctx.res, 3015, '学员不存在');
  const only = await visibleStudentIds(ctx.user);
  if (only && !only.includes(u.id)) return fail(ctx.res, 403, '这不是你班上的学生');
  const subjects = await repo.subjects.all();
  const admin = ctx.user.role === 'admin';
  const pkgs = await repo.packages.byStudent(u.id);
  const classes = (await repo.classes.forStudent(u.id))
    .map((c) => ({ id: c.id, name: c.name, subject: subjectView(subjects.find((x) => x.id === c.subjectId)) }));
  ok(ctx.res, {
    id: u.id, name: u.name, stars: u.stars, streak: u.streak,
    profile: (await repo.profiles.byUser(u.id)) || { status: 'active' },
    classes,
    packages: pkgs.map((p) => pkgView(p, subjects, admin)),
    hours: hoursOf(pkgs),
    logs: (await repo.hourLogs.byStudent(u.id, 30)),
    attendance: await repo.attendance.byStudent(u.id, 20),
    leaves: await repo.leaves.byStudent(u.id, 10),
  });
}, { roles: ['teacher', 'admin'] });

on('PUT', '/api/admin/students/:id', async (ctx) => {
  const u = await repo.users.byId(ctx.params.id);
  if (!u || u.role !== 'student') return fail(ctx.res, 3015, '学员不存在');
  if (ctx.body.name && String(ctx.body.name).trim()) await repo.users.rename(u.id, String(ctx.body.name).trim().slice(0, 20));
  ok(ctx.res, await repo.profiles.save(u.id, ctx.body));
}, { roles: ['admin'] });

on('POST', '/api/admin/students/:id/classes', async (ctx) => {
  if (!await canTouchClass(ctx.user, ctx.body.classId)) return fail(ctx.res, 403, '不能加到别人的班');
  await repo.classes.addMember(ctx.body.classId, ctx.params.id);
  ok(ctx.res, { ok: true });
}, { roles: ['teacher', 'admin'] });

/* ---------- 课时包 ---------- */
on('POST', '/api/admin/packages', async (ctx) => {
  const b = ctx.body;
  const u = await repo.users.byId(b.studentId);
  if (!u || u.role !== 'student') return fail(ctx.res, 3015, '学员不存在');
  if (!(Number(b.totalHours) > 0 || Number(b.giftHours) > 0)) return fail(ctx.res, 1001, '请填写课时数');
  if (b.purchasedAt && !isDate(b.purchasedAt)) return fail(ctx.res, 1001, '购买日期格式不对');
  if (b.expiresAt && !isDate(b.expiresAt)) return fail(ctx.res, 1001, '到期日期格式不对');
  const p = await repo.packages.create({
    studentId: u.id, subjectId: b.subjectId, courseId: b.courseId,
    totalHours: Number(b.totalHours) || 0, giftHours: Number(b.giftHours) || 0,
    priceOriginal: toFen(b.priceOriginal), pricePaid: toFen(b.pricePaid),
    purchasedAt: b.purchasedAt || today(), expiresAt: b.expiresAt || '', note: String(b.note || '').slice(0, 200),
  });
  ok(ctx.res, pkgView(p, await repo.subjects.all(), true));
}, { roles: ['admin'] });

on('PUT', '/api/admin/packages/:id', async (ctx) => {
  const cur = await repo.packages.byId(ctx.params.id);
  if (!cur) return fail(ctx.res, 3016, '课包不存在');
  const b = ctx.body;
  const patch = { note: b.note, subjectId: b.subjectId };
  if (b.totalHours != null) patch.totalHours = Number(b.totalHours);
  if (b.giftHours != null) patch.giftHours = Number(b.giftHours);
  if (b.priceOriginal != null) patch.priceOriginal = toFen(b.priceOriginal);
  if (b.pricePaid != null) patch.pricePaid = toFen(b.pricePaid);
  if (b.purchasedAt != null) patch.purchasedAt = b.purchasedAt;
  if (b.expiresAt != null) patch.expiresAt = b.expiresAt;
  if (b.status && ['active', 'finished'].includes(b.status)) patch.status = b.status;
  ok(ctx.res, pkgView(await repo.packages.update(cur.id, patch), await repo.subjects.all(), true));
}, { roles: ['admin'] });

/** 停课：到期日按停课天数顺延，恢复时自动补上 */
on('POST', '/api/admin/packages/:id/pause', async (ctx) => {
  const p = await repo.packages.byId(ctx.params.id);
  if (!p) return fail(ctx.res, 3016, '课包不存在');
  if (p.status !== 'active') return fail(ctx.res, 3016, '只有在用的课包才能暂停');
  await repo.packages.update(p.id, { status: 'paused', pausedAt: today() });
  ok(ctx.res, { ok: true, pausedAt: today() });
}, { roles: ['admin'] });

on('POST', '/api/admin/packages/:id/resume', async (ctx) => {
  const p = await repo.packages.byId(ctx.params.id);
  if (!p) return fail(ctx.res, 3016, '课包不存在');
  if (p.status !== 'paused') return fail(ctx.res, 3016, '这个课包没有在暂停');
  let expiresAt = p.expiresAt;
  if (p.pausedAt && isDate(p.pausedAt) && isDate(expiresAt || '')) {
    const days = Math.max(0, Math.round((Date.parse(today()) - Date.parse(p.pausedAt)) / 86400000));
    expiresAt = new Date(Date.parse(expiresAt) + days * 86400000).toISOString().slice(0, 10);   // 停了几天就顺延几天
  }
  await repo.packages.update(p.id, { status: 'active', pausedAt: null, expiresAt });
  ok(ctx.res, { ok: true, expiresAt });
}, { roles: ['admin'] });

/** 手工加减课时（补课、退课、录错了） */
on('POST', '/api/admin/packages/:id/adjust', async (ctx) => {
  const p = await repo.packages.byId(ctx.params.id);
  if (!p) return fail(ctx.res, 3016, '课包不存在');
  const hours = Number(ctx.body.hours);
  if (!hours || Math.abs(hours) > 1000) return fail(ctx.res, 1001, '请填写要加减的课时数');
  const left = (p.totalHours || 0) + (p.giftHours || 0) - (p.usedHours || 0);
  if (hours < 0 && left + hours < 0 && !ctx.body.force) {
    return fail(ctx.res, 3016, `这个课包只剩 ${Math.round(left * 100) / 100} 课时，扣不了 ${Math.abs(hours)}`);
  }
  await repo.packages.addUsed(p.id, -hours);                   // 加课时 = 少用了
  await repo.hourLogs.add({ packageId: p.id, studentId: p.studentId, hours, reason: 'adjust',
    date: today(), note: String(ctx.body.note || '').slice(0, 100), createdBy: ctx.user.id });
  ok(ctx.res, pkgView(await repo.packages.byId(p.id), await repo.subjects.all(), true));
}, { roles: ['admin'] });

on('DELETE', '/api/admin/packages/:id', async (ctx) => {
  const p = await repo.packages.byId(ctx.params.id);
  if (!p) return fail(ctx.res, 3016, '课包不存在');
  if (p.usedHours > 0) return fail(ctx.res, 3016, '这个课包已经上过课，不能删除，可以改成「已结束」');
  await repo.packages.remove(p.id);
  ok(ctx.res, { ok: true });
}, { roles: ['admin'] });

/* ---------- 点名：到课扣课时，已批准的请假不扣 ---------- */
const ATT_STATUS = ['present', 'leave', 'absent', 'clear'];   // clear = 删掉这次记录并退回课时

on('GET', '/api/classes/:id/attendance', async (ctx) => {
  const cls = await repo.classes.byId(ctx.params.id);
  if (!cls) return fail(ctx.res, 3001, '班级不存在');
  if (!await canTouchClass(ctx.user, cls.id)) return fail(ctx.res, 403, '这不是你带的班');
  const date = isDate(ctx.query.date) ? ctx.query.date : today();
  const members = await repo.classes.members(cls.id);
  const ids = members.map((m) => m.id);
  const [pkgs, done] = [await repo.packages.byStudents(ids), await repo.attendance.byClassDate(cls.id, date)];
  const onLeave = await repo.leaves.approvedOn(cls.id, date);
  const students = members.map((m) => {
    const rec = done.find((a) => a.studentId === m.id);
    return { id: m.id, name: m.name, ...hoursOf(pkgs.get(m.id) || []),
      status: rec ? rec.status : (onLeave.includes(m.id) ? 'leave' : ''),
      hours: rec ? rec.hours : null, approvedLeave: onLeave.includes(m.id) };
  });
  ok(ctx.res, { date, className: cls.name, subject: subjectView(await repo.subjects.byId(cls.subjectId)),
    defaultHours: await repo.settings.get('hours_class_' + cls.id, 1),
    scheduleText: schedule.text(cls.schedule), meetsOn: schedule.meetsOn(cls.schedule, date),
    hasSchedule: !!schedule.clean(cls.schedule),
    students, dates: await repo.attendance.datesOfClass(cls.id, 10) });
}, { roles: ['teacher', 'admin'] });

on('POST', '/api/classes/:id/attendance', async (ctx) => {
  const cls = await repo.classes.byId(ctx.params.id);
  if (!cls) return fail(ctx.res, 3001, '班级不存在');
  if (!await canTouchClass(ctx.user, cls.id)) return fail(ctx.res, 403, '这不是你带的班');
  const date = isDate(ctx.body.date) ? ctx.body.date : today();
  const per = Math.min(10, Math.max(0.5, Number(ctx.body.hours) || 1));
  const records = Array.isArray(ctx.body.records) ? ctx.body.records : [];
  if (!records.length) return fail(ctx.res, 1001, '还没有点名');

  const members = await repo.classes.members(cls.id);
  const memberIds = new Set(members.map((m) => m.id));
  const prevRows = new Map((await repo.attendance.byClassDate(cls.id, date)).map((a) => [a.studentId, a]));
  const seen = new Set();
  const noPackage = [], overdrawn = [];
  let marked = 0, used = 0;
  for (const r of records) {
    const sid = Number(r.studentId);
    if (!memberIds.has(sid) || seen.has(sid)) continue;         // 不是本班的、或同一人重复提交的，跳过
    if (!ATT_STATUS.includes(r.status)) continue;
    seen.add(sid);
    const prev = prevRows.get(sid);
    const wantHours = r.status === 'leave' ? 0 : (Number(r.hours) > 0 ? Number(r.hours) : per);
    // 和上次点的一模一样就不动：既省事，也免得流水被重复点名刷满
    if (prev && prev.status === r.status && Math.abs((prev.hours || 0) - (prev.packageId ? wantHours : 0)) < 1e-9) {
      marked++;
      used += prev.hours || 0;
      continue;
    }
    // 改点名结果：先把上次扣的课时退回去，再按新的扣
    if (prev && prev.hours && prev.packageId) {
      await repo.packages.addUsed(prev.packageId, -prev.hours);
      await repo.hourLogs.add({ packageId: prev.packageId, studentId: prev.studentId, hours: prev.hours,
        reason: 'revert', refId: prev.id, date, note: '修改点名，退回课时', createdBy: ctx.user.id });
    }
    if (r.status === 'clear') {                        // 点错了：记录删掉，课时上面已经退回
      if (prev) await repo.attendance.remove(prev.id);
      marked++;
      continue;
    }
    const hours = wantHours;
    let pkg = null;
    if (hours > 0) {
      pkg = await repo.packages.pickForConsume(r.studentId, cls.subjectId, date);
      if (!pkg) noPackage.push((members.find((m) => m.id === sid) || {}).name);
    }
    const att = await repo.attendance.upsert({ classId: cls.id, studentId: r.studentId, date, status: r.status,
      hours: pkg ? hours : 0, packageId: pkg ? pkg.id : null, note: String(r.note || '').slice(0, 100), createdBy: ctx.user.id });
    if (pkg && hours > 0) {
      await repo.packages.addUsed(pkg.id, hours);
      await repo.hourLogs.add({ packageId: pkg.id, studentId: sid, hours: -hours, reason: r.status,
        refId: att.id, date, createdBy: ctx.user.id });
      used += hours;
      // 扣完变成负数：课时已经用超了，提醒老师联系家长续费
      const after = (pkg.totalHours || 0) + (pkg.giftHours || 0) - (pkg.usedHours || 0) - hours;
      if (after < 0) overdrawn.push((members.find((m) => m.id === sid) || {}).name);
    }
    marked++;
  }
  await repo.settings.set('hours_class_' + cls.id, per);
  ok(ctx.res, { date, marked, usedHours: Math.round(used * 100) / 100,
    noPackage: [...new Set(noPackage)], overdrawn: [...new Set(overdrawn.filter(Boolean))] });
}, { roles: ['teacher', 'admin'] });

/* ---------- 请假：家长在学生端提交，老师审批 ---------- */
on('POST', '/api/leaves', async (ctx) => {
  const date = isDate(ctx.body.date) ? ctx.body.date : null;
  if (!date) return fail(ctx.res, 1001, '请选择请假日期');
  if (date < today()) return fail(ctx.res, 1001, '只能给今天或以后请假');
  const classIds = await repo.classes.idsForUser(ctx.user);
  const classId = classIds.includes(Number(ctx.body.classId)) ? Number(ctx.body.classId) : null;
  const dup = (await repo.leaves.byStudent(ctx.user.id, 30)).find((l) => l.date === date && l.status !== 'rejected' && l.classId === classId);
  if (dup) return fail(ctx.res, 3017, '这一天已经请过假了');
  const l = await repo.leaves.create({ studentId: ctx.user.id, classId, date, reason: String(ctx.body.reason || '').slice(0, 100) });
  ok(ctx.res, l);
}, { roles: ['student'] });

on('GET', '/api/admin/leaves', async (ctx) => {
  const only = await visibleStudentIds(ctx.user);
  ok(ctx.res, { list: await repo.leaves.list(ctx.query.status || null, only), pending: await repo.leaves.countPending(only) });
}, { roles: ['teacher', 'admin'] });

on('POST', '/api/admin/leaves/:id/:action', async (ctx) => {
  const l = await repo.leaves.byId(ctx.params.id);
  if (!l) return fail(ctx.res, 3017, '请假记录不存在');
  const only = await visibleStudentIds(ctx.user);
  if (only && !only.includes(l.studentId)) return fail(ctx.res, 403, '这不是你班上的学生');
  const map = { approve: 'approved', reject: 'rejected' };
  const st = map[ctx.params.action];
  if (!st) return fail(ctx.res, 1001, '操作不对');
  await repo.leaves.setStatus(l.id, st, ctx.user.id);

  // 这天如果已经按到课/旷课扣过课时，准假后自动退回，免得白扣
  let refunded = 0;
  if (st === 'approved' && l.classId) {
    const rec = (await repo.attendance.byClassDate(l.classId, l.date)).find((a) => a.studentId === l.studentId);
    if (rec && rec.status !== 'leave') {
      if (rec.hours && rec.packageId) {
        await repo.packages.addUsed(rec.packageId, -rec.hours);
        await repo.hourLogs.add({ packageId: rec.packageId, studentId: l.studentId, hours: rec.hours,
          reason: 'revert', refId: rec.id, date: l.date, note: '事后准假，退回课时', createdBy: ctx.user.id });
        refunded = rec.hours;
      }
      await repo.attendance.upsert({ classId: l.classId, studentId: l.studentId, date: l.date,
        status: 'leave', hours: 0, packageId: null, note: rec.note, createdBy: ctx.user.id });
    }
  }
  ok(ctx.res, { ok: true, status: st, refunded });
}, { roles: ['teacher', 'admin'] });

/* ---------- 学生端：我的课时、请假 ---------- */
on('GET', '/api/me/archive', async (ctx) => {
  const subjects = await repo.subjects.all();
  const pkgs = await repo.packages.byStudent(ctx.user.id);
  ok(ctx.res, {
    hours: hoursOf(pkgs),
    packages: pkgs.filter((p) => p.status !== 'finished').map((p) => pkgView(p, subjects, false)),
    attendance: await repo.attendance.byStudent(ctx.user.id, 10),
    leaves: await repo.leaves.byStudent(ctx.user.id, 10),
  });
}, { roles: ['student'] });

/* ---------- 教务台：今天要办的事 ---------- */
on('GET', '/api/admin/dashboard', async (ctx) => {
  const admin = ctx.user.role === 'admin';
  const date = today();
  const classIds = await repo.classes.idsForUser(ctx.user);
  const marked = await repo.attendance.markedClassIds(date, classIds);
  const subs = await repo.subjects.all();
  const counts = await repo.classes.memberCounts(classIds);

  const byId = await repo.classes.byIds(classIds);
  const classes = [];
  for (const id of classIds) {
    const c = byId.get(id);
    if (!c) continue;
    classes.push({ id: c.id, name: c.name, subject: subjectView(subs.find((x) => x.id === c.subjectId)),
      studentCount: counts.get(c.id) || 0, marked: marked.has(c.id),
      scheduleText: schedule.text(c.schedule), meetsToday: schedule.meetsOn(c.schedule, date),
      nextClassAt: schedule.nextMeeting(c.schedule, date) });
  }
  // 今天有课的排前面，其次是没排期的，最后是今天没课的
  classes.sort((a, b) => (b.meetsToday - a.meetsToday) || ((a.scheduleText ? 1 : 0) - (b.scheduleText ? 1 : 0)));

  // 课时预警：剩 4 课时以内，或 30 天内到期
  const onlyIds = await visibleStudentIds(ctx.user);
  const students = (await repo.users.listByRole('student')).filter((u) => !onlyIds || onlyIds.includes(u.id));
  const pkgs = await repo.packages.byStudents(students.map((u) => u.id));
  const soon = new Date(Date.parse(date) + 30 * 86400000).toISOString().slice(0, 10);
  const lowHours = [], expiring = [];
  for (const u of students) {
    const list = pkgs.get(u.id) || [];
    if (!list.length) continue;
    const h = hoursOf(list);
    if (h.leftHours > 0 && h.leftHours <= 4) lowHours.push({ id: u.id, name: u.name, leftHours: h.leftHours });
    if (h.expiresAt && h.expiresAt <= soon && h.leftHours > 0) expiring.push({ id: u.id, name: u.name, expiresAt: h.expiresAt, leftHours: h.leftHours });
  }
  expiring.sort((a, b) => a.expiresAt.localeCompare(b.expiresAt));

  const out = {
    date, name: ctx.user.name, role: ctx.user.role,
    classes, toReview: await repo.submissions.countToReview(classIds),
    pendingLeaves: await repo.leaves.countPending(onlyIds),
    pendingJoins: await repo.classes.countPendingJoins(classIds),
    lowHours: lowHours.slice(0, 8), expiring: expiring.slice(0, 8),
    pendingRewards: await repo.redemptions.countPending(),
  };
  if (admin) {
    const monthStart = date.slice(0, 8) + '01';
    const m = await repo.packages.statsBetween(monthStart, date);
    out.newLeads = await repo.leads.countNew();
    out.month = { income: YUAN(m.paid), packages: m.count,
      newStudents: await repo.users.countStudentsSince(monthStart), lessons: await repo.attendance.countSince(monthStart) };
  }
  ok(ctx.res, out);
}, { roles: ['teacher', 'admin'] });

/* ---------- 报表与导出（电脑端教务后台用） ---------- */
const monthStart = (m) => `${m}-01`;
const monthEnd = (m) => {
  const [y, mm] = m.split('-').map(Number);
  return new Date(Date.UTC(y, mm, 0)).toISOString().slice(0, 10);
};

/** 近 n 个月的月份列表，比如 ['2026-07','2026-08','2026-09'] */
function lastMonths(n, end) {
  const [y, m] = end.split('-').map(Number);
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(d.toISOString().slice(0, 7));
  }
  return out;
}

on('GET', '/api/admin/report', async (ctx) => {
  const end = /^\d{4}-\d{2}$/.test(ctx.query.month || '') ? ctx.query.month : today().slice(0, 7);
  const months = lastMonths(Number(ctx.query.months) || 6, end);
  const from = monthStart(months[0]), to = monthEnd(months[months.length - 1]);
  const paid = await repo.packages.monthlyPaid(from, to);
  const used = await repo.hourLogs.monthlyUsed(from, to);
  const att = await repo.attendance.monthlyCount(from, to);
  const rows = months.map((m) => {
    const p = paid.find((x) => x.m === m) || { n: 0, paid: 0 };
    const u = used.find((x) => x.m === m) || { hours: 0 };
    const a = att.find((x) => x.m === m) || { n: 0, present: 0 };
    return { month: m, income: YUAN(p.paid), packages: p.n, usedHours: Math.round(u.hours * 10) / 10,
      lessons: a.n, present: a.present, attendRate: a.n ? Math.round((a.present / a.n) * 100) : null };
  });
  // 课时结余：所有在用课包还剩多少（等于以后要上的课，也是欠着的服务）
  const students = await repo.users.listByRole('student');
  const pkgs = await repo.packages.byStudents(students.map((u) => u.id));
  let owedHours = 0, activeStudents = 0;
  for (const u of students) {
    const h = hoursOf(pkgs.get(u.id) || []);
    if (h.leftHours > 0) { owedHours += h.leftHours; activeStudents++; }
  }
  ok(ctx.res, { months: rows, owedHours: Math.round(owedHours * 10) / 10, activeStudents,
    totalStudents: students.length });
}, { roles: ['admin'] });

/** 某个班某个月的考勤网格：一行一个学生，一列一天 */
on('GET', '/api/admin/attendance-grid', async (ctx) => {
  const cls = await repo.classes.byId(ctx.query.classId);
  if (!cls) return fail(ctx.res, 3001, '班级不存在');
  if (!await canTouchClass(ctx.user, cls.id)) return fail(ctx.res, 403, '这不是你带的班');
  const month = /^\d{4}-\d{2}$/.test(ctx.query.month || '') ? ctx.query.month : today().slice(0, 7);
  const rows = await repo.attendance.list({ from: monthStart(month), to: monthEnd(month), classIds: [cls.id] });
  const dates = [...new Set(rows.map((r) => r.date))].sort();
  const members = await repo.classes.members(cls.id);
  ok(ctx.res, {
    month, classId: cls.id, className: cls.name, dates,
    defaultHours: await repo.settings.get('hours_class_' + cls.id, 1),
    students: members.map((m) => ({ id: m.id, name: m.name,
      marks: dates.map((d) => { const r = rows.find((x) => x.studentId === m.id && x.date === d); return r ? { status: r.status, hours: r.hours } : null; }),
      used: rows.filter((x) => x.studentId === m.id).reduce((a, b) => a + (b.hours || 0), 0) })),
  });
}, { roles: ['teacher', 'admin'] });

/** 批量建档：一行一个名字，可直接进班、可统一发一个课包 */
on('POST', '/api/admin/students/bulk', async (ctx) => {
  const names = String(ctx.body.names || '').split(/[\n,，、]+/).map((x) => x.trim()).filter(Boolean).slice(0, 200);
  if (!names.length) return fail(ctx.res, 1001, '请填写学员姓名，一行一个');
  if (ctx.body.classId && !await canTouchClass(ctx.user, ctx.body.classId)) return fail(ctx.res, 403, '不能加到别人的班');
  const pk = ctx.body.package || null;
  const created = [], existed = [];
  for (const name of names) {
    let u = await repo.users.byNameRole(name, 'student');
    if (u) existed.push(name);
    else { u = await repo.users.create({ openid: 'dev_' + rid().slice(0, 12), role: 'student', name }); created.push(name); }
    await repo.profiles.save(u.id, { ...(await repo.profiles.byUser(u.id) || {}), grade: ctx.body.grade || (await repo.profiles.byUser(u.id) || {}).grade || '' });
    if (ctx.body.classId) await repo.classes.addMember(ctx.body.classId, u.id);
    if (pk && Number(pk.totalHours) > 0) {
      await repo.packages.create({ studentId: u.id, subjectId: pk.subjectId || null,
        totalHours: Number(pk.totalHours) || 0, giftHours: Number(pk.giftHours) || 0,
        priceOriginal: toFen(pk.priceOriginal), pricePaid: toFen(pk.pricePaid),
        purchasedAt: pk.purchasedAt || today(), expiresAt: pk.expiresAt || '', note: String(pk.note || '').slice(0, 200) });
    }
  }
  ok(ctx.res, { created, existed });
}, { roles: ['admin'] });

/* ---------- 导出 CSV ----------
 * 用 UTF-8 BOM，Excel 和 WPS 双击就能正确显示中文。
 */
function csv(rows) {
  const esc = (v) => {
    let t = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;          // 防止 Excel 把单元格当公式执行
    return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  };
  return '﻿' + rows.map((r) => r.map(esc).join(',')).join('\r\n');
}
function sendCsv(res, name, rows) {
  const buf = Buffer.from(csv(rows), 'utf8');
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Length': buf.length,
    'Content-Disposition': `attachment; filename="${encodeURIComponent(name)}.csv"`,
    'Access-Control-Allow-Origin': '*',
  });
  res.end(buf);
}

const ATT_CN = { present: '到课', leave: '请假', absent: '旷课' };
const REASON_CN = { present: '上课', absent: '旷课', leave: '请假', adjust: '手工调整', revert: '退回' };

on('GET', '/api/admin/export/:kind', async (ctx) => {
  const admin = ctx.user.role === 'admin';
  const onlyIds = await visibleStudentIds(ctx.user);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(ctx.query.from || '') ? ctx.query.from : '';
  const to = /^\d{4}-\d{2}-\d{2}$/.test(ctx.query.to || '') ? ctx.query.to : '';
  const stamp = today();

  if (ctx.params.kind === 'students') {
    const subs = await repo.subjects.all();
    let list = await repo.users.listByRole('student');
    if (onlyIds) list = list.filter((u) => onlyIds.includes(u.id));
    const ids = list.map((u) => u.id);
    const [profiles, pkgs] = [await repo.profiles.byUsers(ids), await repo.packages.byStudents(ids)];
    const classNames = await classesByStudent(ctx.user);
    const rows = [['姓名', '性别', '年级', '就读学校', '家长', '手机号', '状态', '班级', '剩余课时', '到期日', '累计星星']];
    for (const u of list) {
      const p = profiles.get(u.id) || {};
      const h = hoursOf(pkgs.get(u.id) || []);
      rows.push([u.name, p.gender || '', p.grade || '', p.school || '', p.parentName || '',
        admin ? (p.phone || '') : '***', { active: '在读', paused: '停课', left: '已结业' }[p.status || 'active'],
        (classNames.get(u.id) || []).map((c) => c.name).join(' / '), h.leftHours, h.expiresAt || '', u.stars]);
    }
    return sendCsv(ctx.res, `学员名单_${stamp}`, rows);
  }

  if (ctx.params.kind === 'hours') {
    const list = await repo.hourLogs.list({ from, to, studentIds: onlyIds });
    const rows = [['日期', '学员', '类型', '课时变动', '说明', '操作人']];
    for (const l of list) rows.push([l.date, l.studentName, REASON_CN[l.reason] || l.reason, l.hours, l.note, l.byName]);
    return sendCsv(ctx.res, `课时台账_${stamp}`, rows);
  }

  if (ctx.params.kind === 'payments') {
    if (!admin) return fail(ctx.res, 403, '只有负责人能导出收款');
    const subs = await repo.subjects.all();
    const list = await repo.packages.list({ from, to });
    const rows = [['购买日期', '学员', '科目', '购买课时', '赠送课时', '共计', '已用', '剩余', '原价(元)', '实收(元)', '到期日', '状态', '备注']];
    for (const p of list) {
      const sum = (p.totalHours || 0) + (p.giftHours || 0);
      rows.push([p.purchasedAt, p.studentName, (subs.find((x) => x.id === p.subjectId) || {}).name || '不限',
        p.totalHours, p.giftHours, sum, p.usedHours, Math.round((sum - p.usedHours) * 100) / 100,
        YUAN(p.priceOriginal), YUAN(p.pricePaid), p.expiresAt || '',
        { active: '在用', paused: '停课中', finished: '已结束' }[p.status] || p.status, p.note]);
    }
    return sendCsv(ctx.res, `收款流水_${stamp}`, rows);
  }

  if (ctx.params.kind === 'attendance') {
    const classIds = await repo.classes.idsForUser(ctx.user);
    const list = await repo.attendance.list({ from, to, classIds });
    const rows = [['日期', '班级', '学员', '出勤', '扣课时']];
    for (const a of list) rows.push([a.date, a.className, a.studentName, ATT_CN[a.status] || a.status, a.hours || 0]);
    return sendCsv(ctx.res, `考勤记录_${stamp}`, rows);
  }

  if (ctx.params.kind === 'leads') {
    if (!admin) return fail(ctx.res, 403, '只有负责人能导出咨询');
    const subs = await repo.subjects.all();
    const cs = await repo.courses.all();
    const list = await repo.leads.list(500);
    const rows = [['时间', '手机号', '年级', '科目', '想上的课', '家长留言', '来源', '状态', '下次跟进', '试听日期', '最近联系', '跟进备注']];
    for (const l of list) {
      rows.push([l.createdAt, l.phone, l.grade,
        l.subjects.map((c) => (subs.find((x) => x.code === c) || {}).name).filter(Boolean).join(' '),
        l.courses.map((id) => (cs.find((x) => x.id === id) || {}).name).filter(Boolean).join(' '),
        l.message, l.source === 'share' ? `分享页${l.refName ? '（' + l.refName + '）' : ''}` : l.source === 'gallery' ? '作品展' : '预约页',
        { new: '待联系', contacted: '跟进中', trial: '已约试听', enrolled: '已报名', invalid: '无效' }[l.status] || l.status,
        l.followAt, l.trialAt, l.lastContactAt, l.note]);
    }
    return sendCsv(ctx.res, `家长咨询_${stamp}`, rows);
  }
  fail(ctx.res, 1001, '不支持的导出类型');
}, { roles: ['teacher', 'admin'] });

/* ---------- 学校简介 ---------- */
const ABOUT_KEY = 'about';
on('GET', '/api/about', async (ctx) => {
  const a = await repo.settings.get(ABOUT_KEY, null);
  if (!a) return ok(ctx.res, { title: '', text: '', images: [] });
  const images = [];
  for (const id of a.imageIds || []) { const v = await assetView(id); if (v) images.push(v.url); }
  ok(ctx.res, { title: a.title || '', text: a.text || '', images, updatedAt: a.updatedAt || '' });
}, { auth: false });

on('PUT', '/api/admin/about', async (ctx) => {
  const cur = (await repo.settings.get(ABOUT_KEY, null)) || {};
  const imageIds = Array.isArray(cur.imageIds) ? [...cur.imageIds] : [];
  for (const b64 of (Array.isArray(ctx.body.images) ? ctx.body.images : []).slice(0, 6)) {
    const img = decodeImage(b64, 5 * 1024 * 1024);
    if (img.error) return fail(ctx.res, 1001, '简介图片：' + img.error);
    const { asset } = await putAssetBuf('photo', img.buf, img.ext, { mime: 'image/' + img.ext });
    imageIds.push(asset.id);
  }
  const keep = Array.isArray(ctx.body.keepImages) ? ctx.body.keepImages.map(Number) : null;
  const finalIds = (keep ? imageIds.filter((id) => keep.includes(id)) : imageIds).slice(-6);
  await repo.settings.set(ABOUT_KEY, {
    title: String(ctx.body.title == null ? cur.title || '' : ctx.body.title).slice(0, 60),
    text: String(ctx.body.text == null ? cur.text || '' : ctx.body.text).slice(0, 4000),
    imageIds: finalIds, updatedAt: today(),
  });
  const a = await repo.settings.get(ABOUT_KEY, {});
  const images = [];
  for (const id of a.imageIds || []) { const v = await assetView(id); if (v) images.push({ id, url: v.url }); }
  ok(ctx.res, { title: a.title, text: a.text, images });
}, { roles: ['admin'] });

/* ================= 星星奖品：攒够星星换礼物 ================= */
async function rewardView(r) {
  return { id: r.id, name: r.name, stars: r.stars, note: r.note, active: r.active, image: await assetView(r.imageId) };
}

/** 学生看到的奖品墙：自己有多少星、还差多少、已经换过什么 */
on('GET', '/api/rewards', async (ctx) => {
  const list = ctx.user.role === 'student' ? await repo.rewards.listActive() : await repo.rewards.all();
  const out = [];
  for (const r of list) {
    const v = await rewardView(r);
    if (ctx.user.role === 'student') { v.need = Math.max(0, r.stars - ctx.user.stars); v.canRedeem = v.need === 0; }
    else v.redeemed = await repo.rewards.countRedemptions(r.id);
    out.push(v);
  }
  ok(ctx.res, { stars: ctx.user.stars, rewards: out, mine: ctx.user.role === 'student' ? await repo.redemptions.byStudent(ctx.user.id) : [] });
});

on('POST', '/api/rewards/:id/redeem', async (ctx) => {
  const r = await repo.rewards.byId(ctx.params.id);
  if (!r || !r.active) return fail(ctx.res, 3014, '这个奖品已经下架了');
  const me = await repo.users.byId(ctx.user.id);              // 重新读一次，避免用旧的星数
  if (me.stars < r.stars) return fail(ctx.res, 3014, `还差 ${r.stars - me.stars} 颗星`);
  await repo.users.addStars(me.id, -r.stars);                 // 先扣星，老师取消时会退回
  const red = await repo.redemptions.create({ rewardId: r.id, studentId: me.id, rewardName: r.name, stars: r.stars });
  ok(ctx.res, { id: red.id, left: me.stars - r.stars, name: r.name });
}, { roles: ['student'] });

on('POST', '/api/admin/rewards', async (ctx) => {
  const name = String(ctx.body.name || '').trim().slice(0, 30);
  const stars = Number(ctx.body.stars);
  if (!name) return fail(ctx.res, 1001, '请填写奖品名称');
  if (!(stars > 0 && stars <= 100000)) return fail(ctx.res, 1001, '请填写需要多少颗星');
  let imageId = null;
  if (ctx.body.imageBase64) {
    const img = decodeImage(ctx.body.imageBase64);
    if (img.error) return fail(ctx.res, 1001, '奖品照片：' + img.error);
    const { asset } = await putAssetBuf('photo', img.buf, img.ext, { mime: 'image/' + img.ext });
    imageId = asset.id;
  }
  const r = await repo.rewards.create({ name, stars, imageId, note: String(ctx.body.note || '').slice(0, 100), sort: Number(ctx.body.sort) || 0 });
  ok(ctx.res, await rewardView(r));
}, { roles: ['admin'] });

on('PUT', '/api/admin/rewards/:id', async (ctx) => {
  const cur = await repo.rewards.byId(ctx.params.id);
  if (!cur) return fail(ctx.res, 3014, '奖品不存在');
  if (ctx.body.stars != null && !(Number(ctx.body.stars) > 0)) return fail(ctx.res, 1001, '星数不对');
  let imageId;
  if (ctx.body.imageBase64) {
    const img = decodeImage(ctx.body.imageBase64);
    if (img.error) return fail(ctx.res, 1001, '奖品照片：' + img.error);
    const { asset } = await putAssetBuf('photo', img.buf, img.ext, { mime: 'image/' + img.ext });
    imageId = asset.id;
  }
  const r = await repo.rewards.update(cur.id, { name: ctx.body.name, stars: ctx.body.stars,
    note: ctx.body.note, active: ctx.body.active, imageId });
  ok(ctx.res, await rewardView(r));
}, { roles: ['admin'] });

on('DELETE', '/api/admin/rewards/:id', async (ctx) => {
  const cur = await repo.rewards.byId(ctx.params.id);
  if (!cur) return fail(ctx.res, 3014, '奖品不存在');
  if (await repo.rewards.countRedemptions(cur.id)) return fail(ctx.res, 3014, '已经有学生换过这个奖品，改成下架就好');
  await repo.rewards.remove(cur.id);
  ok(ctx.res, { ok: true });
}, { roles: ['admin'] });

/** 待发放的兑换：老师在前台把礼物给孩子后点「已发放」 */
on('GET', '/api/admin/redemptions', async (ctx) => {
  ok(ctx.res, { list: await repo.redemptions.list(ctx.query.status || null), pending: await repo.redemptions.countPending() });
}, { roles: ['teacher', 'admin'] });

on('POST', '/api/admin/redemptions/:id/done', async (ctx) => {
  const r = await repo.redemptions.byId(ctx.params.id);
  if (!r || r.status !== 'pending') return fail(ctx.res, 3014, '这条兑换已经处理过了');
  await repo.redemptions.setStatus(r.id, 'done');
  ok(ctx.res, { ok: true });
}, { roles: ['teacher', 'admin'] });

/** 取消兑换：星星退回给学生 */
on('POST', '/api/admin/redemptions/:id/cancel', async (ctx) => {
  const r = await repo.redemptions.byId(ctx.params.id);
  if (!r || r.status !== 'pending') return fail(ctx.res, 3014, '这条兑换已经处理过了');
  await repo.redemptions.setStatus(r.id, 'canceled');
  await repo.users.addStars(r.studentId, r.stars);
  ok(ctx.res, { ok: true, refunded: r.stars });
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
  const nowMs = Date.now();
  const t = today();
  const rows = list.map((l) => {
    const created = Date.parse((l.createdAt || '').replace(' ', 'T') + '+08:00');
    return { ...l,
      subjectNames: l.subjects.map((c) => (subs.find((x) => x.code === c) || {}).name).filter(Boolean),
      courseNames: l.courses.map((id) => (cs.find((x) => x.id === id) || {}).name).filter(Boolean),
      waitingHours: Number.isNaN(created) ? null : Math.max(0, Math.round((nowMs - created) / 36e5)),
      overdue: !!(l.followAt && l.followAt < t),                 // 约好的跟进日已经过了
      dueToday: !!(l.followAt && l.followAt === t),
      trialSoon: !!(l.trialAt && l.trialAt >= t),
    };
  });
  const since30 = new Date(Date.now() - 30 * 86400e3).toISOString().replace('T', ' ').slice(0, 19);
  ok(ctx.res, { list: rows, funnel: await repo.leads.funnel(since30) });
}, { roles: ['admin'] });

const LEAD_STATUS = ['new', 'contacted', 'trial', 'enrolled', 'invalid'];

on('PUT', '/api/admin/leads/:id', async (ctx) => {
  const status = ctx.body.status;
  if (status && !LEAD_STATUS.includes(status)) return fail(ctx.res, 1001, '状态不对');
  const patch = { status, note: ctx.body.note };
  const date = (v) => (v === '' ? '' : (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null));
  if (ctx.body.followAt !== undefined) patch.followAt = date(ctx.body.followAt);
  if (ctx.body.trialAt !== undefined) patch.trialAt = date(ctx.body.trialAt);
  // 一标成「已联系 / 已约试听 / 已报名」就记下联系时间，等待时长从这里算
  if (status && status !== 'new') patch.lastContactAt = now();
  await repo.leads.update(ctx.params.id, patch);
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

module.exports = { handleApi, CHECKIN_SECONDS, maskName, RUBRIC_ITEMS };
