/**
 * 端到端回归测试 —— 服务要先跑起来（./start.sh），然后 `npm test`
 *
 * 换掉 repo.js / storage.js 的实现后（比如迁到微信云开发），跑这个脚本
 * 全绿就说明业务行为没变。测试用完会把自己造的数据删干净。
 */
const BASE = process.env.BASE || 'http://localhost:3000';

let pass = 0, fail = 0;
const log = (s) => console.log(s);
function check(name, cond, extra = '') {
  if (cond) { pass++; log(`  [ok]   ${name}${extra ? '  ' + extra : ''}`); }
  else { fail++; log(`  [FAIL] ${name}${extra ? '  ' + extra : ''}`); }
}

async function call(method, path, body, token) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: method === 'GET' ? undefined : JSON.stringify(body || {}),
  });
  const j = await r.json().catch(() => ({ code: -1, msg: 'bad json' }));
  if (j.code !== 0) throw new Error(`${method} ${path} -> ${j.msg}`);
  return j.data;
}
const expectFail = async (method, path, body, token) => {
  try { await call(method, path, body, token); return null; }
  catch (e) { return e.message; }
};

/* 一小段真实 mp3，用于模拟学生录音 */
const TINY_MP3 = 'SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjYwLjE2LjEwMAAAAAAAAAAAAAAA//tQxAAD'
  + 'wAABpAAAACAAADSAAAAETEFNRTMuMTAwVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV';

const TAG = '__e2e_' + Date.now();

(async () => {
  log('\n[1] 登录与身份');
  const T = await call('POST', '/api/auth/login', { role: 'teacher', name: '王老师', teacherCode: process.env.TEACHER_CODE || '' });
  check('负责人用主口令登录', T.user.role === 'admin', `${T.user.name} / ${T.user.role}`);
  const me = await call('GET', '/api/me', null, T.token);
  check('老师有班级', me.classes.length > 0, me.classes[0] && me.classes[0].name);
  const noAuth = await expectFail('GET', '/api/me');
  check('未登录被拒', /未登录/.test(noAuth || ''), noAuth);

  const allCls = await call('GET', '/api/classes', null, T.token);
  const cls = allCls.find((c) => c.inviteCode === 'DEMO88') || allCls[0];   // 固定用演示班，别被测试留下的班顶掉
  check('班级学生数', cls.studentCount >= 1, cls.studentCount + ' 人');

  log('\n[2] 内容后台：建教材 → 建课 → 传音频 → 传页面 → 存热区');
  const book = await call('POST', '/api/admin/books', { title: TAG + ' 教材', subtitle: '回归测试' }, T.token);
  const lesson = await call('POST', '/api/admin/lessons', { bookId: book.id, title: TAG + ' Lesson' }, T.token);
  check('建教材/课', !!book.id && !!lesson.id, `book=${book.id} lesson=${lesson.id}`);

  const aud = await call('POST', `/api/admin/lessons/${lesson.id}/audio`, { base64: TINY_MP3, ext: 'mp3' }, T.token);
  check('传课文音频', !!aud.asset.url, aud.asset.url);

  const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const page = await call('POST', '/api/admin/pages', { lessonId: lesson.id, pageNo: 1, imageBase64: PNG_1x1, ext: 'png' }, T.token);
  check('传页面图', page.imgW === 1 && page.imgH === 1, `${page.imgW}x${page.imgH}（尺寸由 ImageMagick 识别）`);

  const HS = [
    { x: 0.05, y: 0.10, w: 0.90, h: 0.06, startMs: 300, endMs: 2820, en: 'Hello there.', cn: '你好。' },
    { x: 0.05, y: 0.20, w: 0.90, h: 0.06, startMs: 3320, endMs: 5000, en: 'How are you?', cn: '你好吗？' },
  ];
  const saved = await call('PUT', `/api/admin/pages/${page.id}/hotspots`, { hotspots: HS }, T.token);
  check('存热区', saved.count === 2, saved.count + ' 个');

  log('\n[3] 学生端读取');
  const detail = await call('GET', `/api/pages/${page.id}`, null, T.token);
  check('热区回读一致',
    detail.hotspots.length === 2
    && detail.hotspots[0].en === 'Hello there.'
    && detail.hotspots[0].startMs === 300
    && Math.abs(detail.hotspots[0].x - 0.05) < 1e-6,
    `"${detail.hotspots[0].en}" @${detail.hotspots[0].startMs}ms x=${detail.hotspots[0].x}`);
  check('热区继承课文音频', detail.hotspots[0].audio && detail.hotspots[0].audio.url === aud.asset.url);
  const cat = await call('GET', `/api/books/${book.id}/catalog`, null, T.token);
  check('目录统计', cat.lessons[0].pages[0].hotspotCount === 2);

  // 重存标注不能换掉热区 id —— 作业和学生录音都按 id 引用它们
  const idsBefore = detail.hotspots.map((h) => h.id);
  await call('PUT', `/api/admin/pages/${page.id}/hotspots`, {
    hotspots: detail.hotspots.map((h) => ({ ...h, cn: h.cn + '(改过)' })),
  }, T.token);
  const resaved = await call('GET', `/api/pages/${page.id}`, null, T.token);
  check('重存标注保留热区 id',
    JSON.stringify(resaved.hotspots.map((h) => h.id)) === JSON.stringify(idsBefore)
    && resaved.hotspots[0].cn.endsWith('(改过)'),
    'id ' + idsBefore.join(',') + ' 不变');

  // 翻页：整本书连续翻，跨课也能翻过去
  const lesson2 = await call('POST', '/api/admin/lessons', { bookId: book.id, title: TAG + ' Lesson 2' }, T.token);
  const page2 = await call('POST', '/api/admin/pages', { lessonId: lesson2.id, pageNo: 2, imageBase64: PNG_1x1, ext: 'png' }, T.token);
  const p1 = await call('GET', `/api/pages/${page.id}`, null, T.token);
  const p2 = await call('GET', `/api/pages/${page2.id}`, null, T.token);
  check('跨课翻页：第一课最后一页能翻到下一课', p1.nextPageId === page2.id && p1.prevPageId === null,
    `第1课页 next=${p1.nextPageId}`);
  check('跨课翻页：下一课第一页能翻回上一课', p2.prevPageId === page.id && p2.nextPageId === null,
    `第2课页 prev=${p2.prevPageId}`);

  log('\n[3b] 听力');
  const listen = await call('GET', '/api/listening', null, T.token);
  const lb = listen.find((x) => x.bookId === book.id);
  check('听力列表包含有音频的课', !!lb && lb.lessons[0].id === lesson.id && lb.lessons[0].sentenceCount === 2,
    lb ? `${lb.lessons[0].title} ${lb.lessons[0].sentenceCount} 句` : '没找到');
  const tr = await call('GET', `/api/lessons/${lesson.id}/transcript`, null, T.token);
  check('整课时间轴按时间排序', tr.sentences.length === 2 && tr.sentences[0].startMs < tr.sentences[1].startMs
    && tr.lesson.audio.url === aud.asset.url, tr.sentences.map((x) => `${x.en}@${x.startMs}`).join(' / '));

  log('\n[4] 作业：布置 → 提交 → 批改');
  const hw = await call('POST', '/api/homeworks', {
    classId: cls.id, pageId: page.id, title: TAG + ' 作业',
    hotspotIds: detail.hotspots.map((h) => h.id), note: '回归测试',
  }, T.token);

  const S = await call('POST', '/api/auth/dev-login', { role: 'student', name: '李小明', inviteCode: cls.inviteCode });
  const sHw = await call('GET', `/api/homeworks/${hw.id}`, null, S.token);
  check('学生看到待完成', sHw.status === 'todo' && sHw.items.length === 2, sHw.title);

  // 字段名写错（没有 audioBase64）时必须被拒绝，而不是静默成功
  const noAudio = await expectFail('POST', `/api/homeworks/${hw.id}/submit`, {
    items: sHw.items.map((it) => ({ hotspotId: it.hotspotId, base64: TINY_MP3, ext: 'mp3' })),
  }, S.token);
  check('没有录音数据的提交被拒绝', /没有收到录音/.test(noAudio || ''), noAudio);

  const sub = await call('POST', `/api/homeworks/${hw.id}/submit`, {
    items: sHw.items.map((it) => ({ hotspotId: it.hotspotId, audioBase64: TINY_MP3, ext: 'mp3', durationMs: 1200 })),
    elapsedSec: 60,
  }, S.token);
  check('提交录音', !!sub.submissionId);

  const list = await call('GET', `/api/homeworks/${hw.id}/submissions`, null, T.token);
  const row = list.rows.find((r) => r.studentName === '李小明');
  check('老师看到提交', row.status === 'submitted' && row.items.length === 2, row.items[0].audio.url);
  check('录音带回原文', row.items[0].en === 'Hello there.');

  await call('POST', `/api/submissions/${row.submissionId}/review`, { stars: 4, reviewText: '不错' }, T.token);
  const after = await call('GET', `/api/homeworks/${hw.id}`, null, S.token);
  check('学生看到批改', after.status === 'reviewed' && after.stars === 4, '★'.repeat(after.stars) + ' ' + after.reviewText);

  const dup = await expectFail('POST', `/api/homeworks/${hw.id}/submit`,
    { items: [{ hotspotId: sHw.items[0].hotspotId, audioBase64: TINY_MP3, ext: 'mp3' }] }, S.token);
  check('已批改后不可重交', /已批改/.test(dup || ''), dup);

  log('\n[5] 打卡');
  let hb = await call('POST', '/api/study/heartbeat', { seconds: 30 }, S.token);
  // 只有"今天从没打过卡"时这条才成立（同一天重复跑测试，学生早就打过了）
  if (hb.todaySeconds < hb.needSeconds && !S.user.lastCheckin) {
    check('没到时长不算打卡', hb.checkedInToday === false, `今日 ${hb.todaySeconds}s / 需 ${hb.needSeconds}s`);
  }
  // 单次心跳最多记 120 秒，按需要的时长补几次
  while (hb.todaySeconds < hb.needSeconds) hb = await call('POST', '/api/study/heartbeat', { seconds: 120 }, S.token);
  check('满时长即打卡', hb.checkedInToday === true, `今日 ${hb.todaySeconds}s / 需 ${hb.needSeconds}s，连续 ${hb.streak} 天`);
  const sum = await call('GET', '/api/study/summary', null, S.token);
  check('学情汇总', sum.days.length > 0 && sum.stars > 0, `${sum.stars} 星 / ${sum.totalMinutes} 分钟`);

  log('\n[5b] 学习海报');
  const poster = await call('POST', '/api/posters', { imageBase64: PNG_1x1 }, S.token);
  const pr = await fetch(BASE + poster.url);
  check('海报上传后是可访问的图片地址', pr.status === 200 && /image\/png/.test(pr.headers.get('content-type') || ''),
    `${poster.url.split('?')[0]} ${pr.status} ${pr.headers.get('content-type')}`);
  const notImg = await expectFail('POST', '/api/posters', { imageBase64: Buffer.from('hello').toString('base64') }, S.token);
  check('非图片内容被拒绝', /JPG 或 PNG/.test(notImg || ''), notImg);

  log('\n[6] 权限与账号');
  const badPw = await expectFail('POST', '/api/auth/login', { role: 'teacher', name: '王老师', teacherCode: '000000wrong' });
  check('口令错误不能登录', /口令/.test(badPw || ''), badPw);

  // 负责人给老师建账号，老师用自己的口令登录
  const staff = await call('POST', '/api/admin/teachers', { name: TAG + '赵老师' }, T.token);
  check('建老师账号返回一次性口令', /^\d{6}$/.test(staff.code || ''), `${staff.name} ${String(staff.code).replace(/\d/g, '#')}`);
  const other = await call('POST', '/api/auth/login', { role: 'teacher', name: staff.name, teacherCode: staff.code });
  check('老师用自己的口令登录，身份是老师', other.user.role === 'teacher', other.user.role);
  const wrongPw = await expectFail('POST', '/api/auth/login', { role: 'teacher', name: staff.name, teacherCode: '000000' });
  check('别人猜错口令进不来', /口令/.test(wrongPw || ''), wrongPw);
  if (process.env.TEACHER_CODE) {
    const masterOnTeacher = await expectFail('POST', '/api/auth/login', { role: 'teacher', name: staff.name, teacherCode: process.env.TEACHER_CODE });
    check('老师账号不能用负责人主口令登录', /负责人给你的口令/.test(masterOnTeacher || ''), masterOnTeacher);
  }
  // 负责人可以回头查老师当前的口令
  const shown = await call('GET', `/api/admin/teachers/${staff.id}/code`, null, T.token);
  check('负责人能查看老师当前口令', shown.code === staff.code, shown.code === staff.code ? '与创建时一致' : '不一致');
  const selfCode = await expectFail('GET', `/api/admin/teachers/${T.user.id}/code`, null, T.token);
  check('负责人自己的主口令不保存在系统里', /主口令/.test(selfCode || ''), selfCode);
  const teacherPeek = await expectFail('GET', `/api/admin/teachers/${staff.id}/code`, null, other.token);
  check('老师看不了别人的口令', /无权限/.test(teacherPeek || ''), teacherPeek);

  const leadPeek = await expectFail('GET', '/api/admin/leads', null, other.token);
  check('老师看不到家长手机号', /无权限/.test(leadPeek || ''), leadPeek);
  const staffPeek = await expectFail('GET', '/api/admin/teachers', null, other.token);
  check('老师管不了账号', /无权限/.test(staffPeek || ''), staffPeek);
  const bookPeek = await expectFail('POST', '/api/admin/books', { title: 'x' }, other.token);
  check('老师改不了教材内容', /无权限/.test(bookPeek || ''), bookPeek);

  // 负责人看得到别的老师的班
  const zhSub = (await call('GET', '/api/subjects', null, T.token)).subjects.find((x) => x.code === 'zh');
  const otherCls = await call('POST', '/api/classes', { subjectId: zhSub.id, gradeBand: '初中', name: TAG + ' 赵老师语文班' }, other.token);
  const adminSees = (await call('GET', '/api/classes', null, T.token)).find((c) => c.id === otherCls.id);
  check('负责人能看到全校的班，并知道是谁带的', !!adminSees && adminSees.teacherName === staff.name, adminSees && `${adminSees.name} / ${adminSees.teacherName}`);
  const mineOnly = (await call('GET', '/api/classes', null, other.token)).length;
  check('老师只看到自己的班', mineOnly === 1, `${mineOnly} 个班`);

  // 停用后立刻登录不了
  await call('PUT', `/api/admin/teachers/${staff.id}`, { active: false }, T.token);
  const stopped = await expectFail('POST', '/api/auth/login', { role: 'teacher', name: staff.name, teacherCode: staff.code });
  check('停用的账号登录不了', /停用/.test(stopped || ''), stopped);
  const busy = await expectFail('DELETE', `/api/admin/teachers/${staff.id}`, null, T.token);
  check('名下还有班的老师不能直接删', /还有班级/.test(busy || ''), busy);

  // 同名提示要说清楚怎么办
  const dupName = await expectFail('POST', '/api/admin/teachers', { name: staff.name }, T.token);
  check('同名账号给出可操作的提示', /停用|重置口令/.test(dupName || ''), dupName);

  // 按班转：不同的班可以分给不同的老师
  const splitA = await call('POST', '/api/admin/teachers', { name: TAG + '甲老师' }, T.token);
  const splitB = await call('POST', '/api/admin/teachers', { name: TAG + '乙老师' }, T.token);
  const enSubj = (await call('GET', '/api/subjects', null, T.token)).subjects.find((x) => x.code === 'en');
  const splitFrom = await call('POST', '/api/admin/teachers', { name: TAG + '丙老师' }, T.token);
  const c1 = await call('POST', '/api/classes', { subjectId: enSubj.id, gradeBand: '一二年级', name: TAG + ' 分转一班', teacherId: splitFrom.id }, T.token);
  const c2 = await call('POST', '/api/classes', { subjectId: enSubj.id, gradeBand: '三四年级', name: TAG + ' 分转二班', teacherId: splitFrom.id }, T.token);
  const ownList = await call('GET', `/api/admin/teachers/${splitFrom.id}/classes`, null, T.token);
  check('能列出某位老师名下的班', ownList.length >= 2 && ownList.every((c) => 'studentCount' in c), `${ownList.length} 个班`);
  const split = await call('POST', '/api/admin/classes/transfer', { moves: [
    { classId: c1.id, toId: splitA.id }, { classId: c2.id, toId: splitB.id }] }, T.token);
  check('两个班分别转给两位老师', split.moved === 2, split.detail.join('；'));
  const afterSplit = await call('GET', '/api/classes', null, T.token);
  check('转出后各归各家', afterSplit.find((c) => c.id === c1.id).teacherName === splitA.name
    && afterSplit.find((c) => c.id === c2.id).teacherName === splitB.name, '');
  const calliSubj = (await call('GET', '/api/subjects', null, T.token)).subjects.find((x) => x.code === 'calli');
  await call('PUT', `/api/admin/teachers/${splitA.id}/subjects`, { subjectIds: [calliSubj.id] }, T.token);
  const wrongMove = await expectFail('POST', '/api/admin/classes/transfer', { moves: [{ classId: c2.id, toId: splitA.id }] }, T.token);
  check('接手老师没教这个科目时拦住', /教的科目里没有/.test(wrongMove || ''), wrongMove);
  for (const c of [c1, c2]) await call('DELETE', `/api/classes/${c.id}`, null, T.token);
  for (const u of [splitA, splitB, splitFrom]) await call('DELETE', `/api/admin/teachers/${u.id}`, null, T.token);

  // 换人带班：班连同学生、作业一起转走
  const helper2 = await call('POST', '/api/admin/teachers', { name: TAG + '孙老师' }, T.token);
  const moved = await call('POST', `/api/admin/teachers/${staff.id}/transfer`, { toId: helper2.id }, T.token);
  check('一键把某位老师的班全部转走', moved.moved === 1 && moved.to === helper2.name, `${moved.moved} 个班 → ${moved.to}`);
  const nowHis = (await call('GET', '/api/classes', null, T.token)).find((c) => c.id === otherCls.id);
  check('转班后任课老师变了', nowHis.teacherName === helper2.name, nowHis.teacherName);

  // 身份互换：老师升负责人、负责人降回老师
  await call('PUT', `/api/admin/teachers/${helper2.id}`, { role: 'admin' }, T.token);
  const asAdmin = await call('POST', '/api/auth/login', { role: 'teacher', name: helper2.name, teacherCode: helper2.code });
  check('升为负责人后能看家长预约', asAdmin.user.role === 'admin' && Array.isArray((await call('GET', '/api/admin/leads', null, asAdmin.token)).list), asAdmin.user.role);
  const selfDemote = await expectFail('PUT', `/api/admin/teachers/${asAdmin.user.id}`, { role: 'teacher' }, asAdmin.token);
  check('不能改自己的身份', /不能改自己/.test(selfDemote || ''), selfDemote);
  await call('PUT', `/api/admin/teachers/${helper2.id}`, { role: 'teacher' }, T.token);
  const backTeacher = await call('POST', '/api/auth/login', { role: 'teacher', name: helper2.name, teacherCode: helper2.code });
  check('降回老师后看不到家长预约', backTeacher.user.role === 'teacher'
    && /无权限/.test(await expectFail('GET', '/api/admin/leads', null, backTeacher.token) || ''), backTeacher.user.role);

  // 单个班改任课老师（停用的账号不能接班，先恢复）
  const toStopped = await expectFail('PUT', `/api/classes/${otherCls.id}`,
    { subjectId: zhSub.id, gradeBand: '初中', name: otherCls.name, teacherId: staff.id }, T.token);
  check('不能把班转给已停用的账号', /已停用/.test(toStopped || ''), toStopped);
  await call('PUT', `/api/admin/teachers/${staff.id}`, { active: true }, T.token);
  await call('PUT', `/api/classes/${otherCls.id}`, { subjectId: zhSub.id, gradeBand: '初中', name: otherCls.name, teacherId: staff.id }, T.token);
  const backToStaff = (await call('GET', '/api/classes', null, T.token)).find((c) => c.id === otherCls.id);
  check('单个班也能换老师', backToStaff.teacherName === staff.name, backToStaff.teacherName);

  await call('DELETE', `/api/classes/${otherCls.id}`, null, T.token);
  await call('DELETE', `/api/admin/teachers/${staff.id}`, null, T.token);
  await call('DELETE', `/api/admin/teachers/${helper2.id}`, null, T.token);
  check('班转走后可以删账号', !(await call('GET', '/api/admin/teachers', null, T.token)).some((u) => u.id === staff.id), '');

  const forbid = await expectFail('POST', '/api/admin/books', { title: 'x' }, S.token);
  check('学生不能建教材', /无权限/.test(forbid || ''), forbid);

  log('\n[8] 多科目题目作业');
  const JPG = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
  const subj = await call('GET', '/api/subjects', null, T.token);
  const math = subj.subjects.find((x) => x.code === 'math');
  const calli = subj.subjects.find((x) => x.code === 'calli');
  check('四个科目', ['en', 'zh', 'math', 'calli'].every((c) => subj.subjects.some((x) => x.code === c)), subj.subjects.map((x) => x.name).join('、'));

  // 机构按科目开班、同科目按年级段分班；学生可以同时在几个科目的班里
  const freeBand = await call('POST', '/api/classes', { subjectId: math.id, gradeBand: '三到五年级', name: TAG + ' 自定义年级班' }, T.token);
  check('年级段可以自己写', freeBand.gradeBand === '三到五年级', freeBand.gradeBand);
  const noBand = await call('POST', '/api/classes', { subjectId: math.id, name: TAG + ' 不填年级班' }, T.token);
  check('年级段可以不填', noBand.gradeBand === '', `「${noBand.gradeBand}」`);
  for (const c of [freeBand, noBand]) await call('DELETE', `/api/classes/${c.id}`, null, T.token);
  const mathCls = await call('POST', '/api/classes', { subjectId: math.id, gradeBand: '三四年级' }, T.token);
  const calliCls = await call('POST', '/api/classes', { subjectId: calli.id, gradeBand: '不分年级', name: TAG + ' 书法周六班' }, T.token);
  check('建班：不填班名自动起名', mathCls.name === '三四年级数学班' && mathCls.subject.code === 'math', mathCls.name);
  // 学生自己用邀请码进班要老师确认；这里走老师直接加人的路径做准备
  const joined = await call('POST', '/api/classes/join', { inviteCode: mathCls.inviteCode }, S.token);
  check('学生自己进班先挂起，等老师确认', joined.join.status === 'pending', joined.join.status);
  await call('POST', `/api/admin/join-requests/${mathCls.id}/${S.user.id}/approve`, {}, T.token);
  await call('POST', `/api/admin/students/${S.user.id}/classes`, { classId: calliCls.id }, T.token);
  const sMe = await call('GET', '/api/me', null, S.token);
  check('学生同时在英语、数学、书法班', joined.subject.code === 'math' && ['en', 'math', 'calli'].every((c) => sMe.classes.some((x) => x.subject && x.subject.code === c)),
    sMe.classes.map((x) => x.name).join('、'));
  const tCls = await call('GET', '/api/classes', null, T.token);
  const order = tCls.map((x) => x.subject.code).filter((c, i, a) => a.indexOf(c) === i);
  check('老师的班按科目排序', order.indexOf('en') < order.indexOf('math') && order.indexOf('math') < order.indexOf('calli'), order.join(' > '));

  const badQ = await expectFail('POST', '/api/homeworks/questions', { classId: mathCls.id, title: TAG + ' 坏题',
    questions: [{ type: 'single', score: 2, stem: '1+1', options: ['1', '2'] }] }, T.token);
  check('出题校验：没标正确选项被拒', /正确选项/.test(badQ || ''), badQ);

  const qhw = await call('POST', '/api/homeworks/questions', { classId: mathCls.id, subjectId: calli.id, title: TAG + ' 数学练习', note: '认真写过程',
    questions: [
      { type: 'single', score: 2, stem: '1+1=?', options: ['1', '2', '3'], answer: 1, analysis: '一加一等于二' },
      { type: 'multi', score: 2, stem: '哪些是偶数', options: ['2', '3', '4'], answer: [0, 2] },
      { type: 'judge', score: 1, stem: '0 是自然数', answer: true },
      { type: 'blank', score: 2, stem: '圆周率约等于 ___，3×4=___', answer: { blanks: [['3.14'], ['12']], tolerance: 0.01 } },
      { type: 'photo', score: 3, stem: '写出计算过程并拍照', stemImageBase64: JPG },
    ] }, T.token);
  const sView = await call('GET', `/api/homeworks/${qhw.id}`, null, S.token);
  check('学生看到题目但看不到答案', sView.questions.length === 5 && sView.questions.every((x) => x.answer === undefined)
    && sView.subject.code === 'math' && !!sView.questions[4].stemImage, `${sView.subject.name} ${sView.questions.length} 题（科目跟班级走）`);
  const chg = await expectFail('PUT', `/api/classes/${mathCls.id}`, { subjectId: calli.id, gradeBand: '三四年级' }, T.token);
  check('布置过作业的班不能改科目', /不能再改科目/.test(chg || ''), chg);
  const helper = await call('POST', '/api/admin/teachers', { name: TAG + '钱老师' }, T.token);
  const helperLogin = await call('POST', '/api/auth/login', { role: 'teacher', name: helper.name, teacherCode: helper.code });
  const otherDel = await expectFail('DELETE', `/api/homeworks/${qhw.id}`, null, helperLogin.token);
  check('别的老师不能删这个班的作业', /只能删除自己班/.test(otherDel || ''), otherDel);
  const otherSee = await expectFail('GET', `/api/homeworks/${qhw.id}/submissions`, null, helperLogin.token);
  check('别的老师看不到这个班的批改页', /不是你带的班/.test(otherSee || ''), otherSee);
  const otherGrade = await expectFail('POST', `/api/submissions/${1}/grade`, { scores: [] }, helperLogin.token);
  check('别的老师不能打分', /不是你带的班|提交记录不存在/.test(otherGrade || ''), otherGrade);
  const otherRoster = await expectFail('GET', `/api/classes/${mathCls.id}/students`, null, helperLogin.token);
  check('别的老师看不到这个班的名单', /别的班/.test(otherRoster || ''), otherRoster);
  const otherPost = await expectFail('POST', '/api/homeworks/questions', { classId: mathCls.id, title: TAG + ' 蹭班',
    questions: [{ type: 'judge', score: 1, stem: 'x', answer: true }] }, helperLogin.token);
  check('别的老师不能给这个班布置作业', /自己带的班/.test(otherPost || ''), otherPost);
  const delHw = await expectFail('DELETE', `/api/classes/${mathCls.id}`, null, T.token);
  check('布置过作业的班不能删', /不能删除/.test(delHw || ''), delHw);

  const noPhoto = await expectFail('POST', `/api/homeworks/${qhw.id}/answers`, { answers: [
    { questionId: sView.questions[0].id, value: 1 } ] }, S.token);
  check('拍照题没交照片被拒绝', /还没有拍照/.test(noPhoto || ''), noPhoto);

  const ids = sView.questions.map((x) => x.id);
  const res1 = await call('POST', `/api/homeworks/${qhw.id}/answers`, { answers: [
    { questionId: ids[0], value: 1 }, { questionId: ids[1], value: [0] }, { questionId: ids[2], value: true },
    { questionId: ids[3], value: ['3.1416', '１２'] }, { questionId: ids[4], photos: [JPG] } ] }, S.token);
  check('客观题自动评分：单选对 2 + 多选少选 0 + 判断对 1 + 填空全对 2 = 5 分', res1.score === 5 && res1.maxScore === 10 && res1.status === 'submitted' && res1.pending === 1,
    `${res1.score}/${res1.maxScore} 待批改 ${res1.pending} 题`);

  const tSubs = await call('GET', `/api/homeworks/${qhw.id}/submissions`, null, T.token);
  const qRow = tSubs.rows.find((r) => r.submissionId);
  const photoAns = qRow.answers.find((a) => a.questionId === ids[4]);
  check('老师看到学生照片', photoAns && photoAns.assets.length === 1 && /\/files\/photos\//.test(photoAns.assets[0].url), photoAns && photoAns.assets[0].url);
  const over = await expectFail('POST', `/api/submissions/${qRow.submissionId}/grade`, { scores: [{ answerId: photoAns.id, score: 9 }] }, T.token);
  check('主观题打分超过满分被拒', /0–3 分/.test(over || ''), over);
  const graded = await call('POST', `/api/submissions/${qRow.submissionId}/grade`, { scores: [{ answerId: photoAns.id, score: 3, comment: '过程清楚' }],
    reviewText: '书写工整，思路清楚', excellent: true }, T.token);
  check('老师给拍照题 3 分后总分 8/10、4 星', graded.score === 8 && graded.maxScore === 10 && graded.stars === 4, `${graded.score}/${graded.maxScore} ★${graded.stars}`);
  const sAfter = await call('GET', `/api/homeworks/${qhw.id}`, null, S.token);
  check('批改后学生能看到答案、解析和优秀', sAfter.mySubmission.excellent && sAfter.questions[0].answer === 1 && sAfter.questions[0].analysis === '一加一等于二',
    `优秀=${sAfter.mySubmission.excellent}`);

  const allAuto = await call('POST', '/api/homeworks/questions', { classId: mathCls.id, title: TAG + ' 口算',
    questions: [{ type: 'blank', score: 5, stem: '7×8=___', answer: { blanks: [['56']] } }] }, T.token);
  const autoV = await call('GET', `/api/homeworks/${allAuto.id}`, null, S.token);
  const autoR = await call('POST', `/api/homeworks/${allAuto.id}/answers`, { answers: [{ questionId: autoV.questions[0].id, value: ['56'] }] }, S.token);
  check('全是客观题：提交即批改完成', autoR.status === 'reviewed' && autoR.score === 5, `${autoR.status} ${autoR.score}`);

  log('\n[9] 喜报、作品展、预约试听');
  const PRAISE = JPG;
  const share = await call('POST', '/api/shares', { type: 'praise', submissionId: qRow.submissionId, imageBase64: PRAISE }, S.token);
  const pageR = await fetch(BASE + share.url);
  const html = await pageR.text();
  check('喜报分享页：卡片标题带打码姓名、og:image 是完整地址', pageR.status === 200 && /李\*/.test(html) && /property="og:image" content="https?:\/\/[^"]+\/files\/shares\//.test(html),
    (html.match(/<title>[^<]*<\/title>/) || [''])[0]);
  check('数学喜报页不出现书法作品展入口，预约标题跟科目走', !html.includes('看看更多书法作品') && html.includes('想让孩子也来学数学'), '');
  const cookie = (pageR.headers.get('set-cookie') || '').split(';')[0];
  await fetch(BASE + share.url, { headers: { cookie } });
  const mine = await call('GET', '/api/shares/mine', null, S.token);
  check('同一访客重复打开只计 1 次浏览', mine.find((x) => x.id === share.id).views === 1, `浏览 ${mine.find((x) => x.id === share.id).views}`);

  const notExcellent = await expectFail('POST', '/api/shares', { type: 'praise', submissionId: autoR.submissionId, imageBase64: PRAISE }, S.token);
  check('没被评优秀不能生成喜报', /优秀作业/.test(notExcellent || ''), notExcellent);

  const chw = await call('POST', '/api/homeworks/questions', { classId: calliCls.id, title: TAG + ' 书法',
    questions: [{ type: 'photo', score: 10, stem: '临写"永"字八法' }] }, T.token);
  const cv = await call('GET', `/api/homeworks/${chw.id}`, null, S.token);
  const cr = await call('POST', `/api/homeworks/${chw.id}/answers`, { answers: [{ questionId: cv.questions[0].id, photos: [JPG, JPG] }] }, S.token);
  const cSubs = await call('GET', `/api/homeworks/${chw.id}/submissions`, null, T.token);
  const cRow = cSubs.rows.find((r) => r.submissionId);
  await call('POST', `/api/submissions/${cRow.submissionId}/grade`, { scores: [{ answerId: cRow.answers[0].id, score: 9 }], reviewText: '笔画有力', excellent: true }, T.token);
  const work = await call('POST', '/api/shares', { type: 'work', submissionId: cr.submissionId, imageBase64: PRAISE, showFullName: true }, S.token);
  const gal = await (await fetch(BASE + '/gallery')).text();
  check('书法作品进入作品展，并显示全名（家长选择了显示全名）', gal.includes('/s/' + work.url.split('/').pop()) && gal.includes('李小明'), work.url);
  const workHtml = await (await fetch(BASE + work.url)).text();
  check('书法作品页有作品展入口', workHtml.includes('看看更多书法作品') && workHtml.includes('想让孩子也来学书法'), '');

  const badLead = await expectFail('POST', '/api/public/leads', { token: work.url.split('/').pop(), phone: '12345', grade: '三年级', agree: true });
  check('预约：手机号格式不对被拒', /手机号/.test(badLead || ''), badLead);
  const noAgree = await expectFail('POST', '/api/public/leads', { phone: '13800001111', grade: '三年级', agree: false });
  check('预约：没勾同意被拒', /同意/.test(noAgree || ''), noAgree);
  const phone = '1380000' + String(Date.now()).slice(-4);
  const subjAll = (await call('GET', '/api/subjects', null, T.token)).subjects;
  const calliSub = subjAll.find((x) => x.code === 'calli');
  check('科目下面带课程小类，作业班也在', calliSub.courses.some((c) => c.name === '小学硬笔书法')
    && subjAll.some((x) => x.code === 'hwclass'), subjAll.map((x) => `${x.name}(${x.courses.length})`).join(' '));
  const courseId = calliSub.courses.find((c) => c.name === '小学书法考级').id;
  await call('POST', '/api/public/leads', { token: work.url.split('/').pop(), phone, grade: '三年级', subjects: ['calli', 'bogus'],
    courses: [courseId, 999999], message: '孩子周六上午方便', contactTime: '周末', agree: true });
  const dupLead = await call('POST', '/api/public/leads', { token: work.url.split('/').pop(), phone, grade: '三年级', agree: true });
  const leadsData = await call('GET', '/api/admin/leads', null, T.token);
  const leadsList = leadsData.list;
  const myLead = leadsList.filter((l) => l.phone === phone);
  check('预约记录带来源学生、只保留合法科目、重复提交不重复记', myLead.length === 1 && myLead[0].refName === '李小明'
    && JSON.stringify(myLead[0].subjects) === '["calli"]' && dupLead.duplicate === true, myLead[0] && `${myLead[0].refName} ${myLead[0].subjectNames}`);
  check('预约记录带课程小类和家长留言', JSON.stringify(myLead[0].courseNames) === '["小学书法考级"]'
    && myLead[0].message === '孩子周六上午方便', `${myLead[0].courseNames} / ${myLead[0].message}`);
  const trialHtml = await (await fetch(BASE + '/trial')).text();
  check('预约页有备注栏、标语和全部科目', /name="message"/.test(trialHtml) && trialHtml.includes('成为孩子期待的一堂课')
    && trialHtml.includes('作业班'), '');
  const stats = await call('GET', '/api/admin/promo-stats', null, T.token);
  check('宣传数据', stats.last7.shares >= 2 && stats.last7.leads >= 1, JSON.stringify(stats.last7));

  await call('POST', `/api/shares/${share.id}/revoke`, null, S.token);
  const revoked = await fetch(BASE + share.url);
  const imgGone = await fetch(BASE + '/files/shares/' + share.url.split('/').pop() + '.jpg');
  check('撤回后分享页 404、分享图被删', revoked.status === 404 && imgGone.status === 404, `页面 ${revoked.status} 图片 ${imgGone.status}`);

  // 清理本段数据
  for (const l of myLead) await call('DELETE', `/api/admin/leads/${l.id}`, null, T.token);
  await call('POST', `/api/shares/${work.id}/revoke`, null, S.token);
  for (const id of [qhw.id, allAuto.id, chw.id]) await call('DELETE', `/api/homeworks/${id}`, null, T.token);
  for (const c of [mathCls, calliCls]) await call('DELETE', `/api/classes/${c.id}`, null, T.token);
  await call('DELETE', `/api/admin/teachers/${helper.id}`, null, T.token);
  const afterDel = await call("GET", "/api/me", null, S.token);
  check('删班后学生不再在这些班里', !afterDel.classes.some((x) => [mathCls.id, calliCls.id].includes(x.id)), afterDel.classes.map((x) => x.name).join('、'));

  log('\n[10] 作业班评分栏与星星奖品');
  const hwSub = (await call('GET', '/api/subjects', null, T.token)).subjects.find((x) => x.code === 'hwclass');
  const hwCls = await call('POST', '/api/classes', { subjectId: hwSub.id, gradeBand: '三四年级', name: TAG + ' 作业班' }, T.token);
  await call('POST', `/api/admin/students/${S.user.id}/classes`, { classId: hwCls.id }, T.token);
  const hwHw = await call('POST', '/api/homeworks/questions', { classId: hwCls.id, title: TAG + ' 今日作业',
    questions: [{ type: 'photo', score: 10, stem: '把今天的作业拍照上传' }] }, T.token);
  const hwView = await call('GET', `/api/homeworks/${hwHw.id}`, null, S.token);
  const hwRes = await call('POST', `/api/homeworks/${hwHw.id}/answers`, { answers: [{ questionId: hwView.questions[0].id, photos: [JPG] }] }, S.token);
  const hwSubs = await call('GET', `/api/homeworks/${hwHw.id}/submissions`, null, T.token);
  const hwRow = hwSubs.rows.find((r) => r.submissionId);
  await call('POST', `/api/submissions/${hwRow.submissionId}/grade`, {
    scores: [{ answerId: hwRow.answers[0].id, score: 9 }], reviewText: '今天很专心',
    rubric: { write: 5, posture: 4, attitude: 5, efficiency: 4, minutes: 45, other: '主动问了三个问题', bogus: 9 },
  }, T.token);
  const hwAfter = await call('GET', `/api/homeworks/${hwHw.id}`, null, S.token);
  const rb = hwAfter.mySubmission.rubric;
  check('作业班评分栏：学生能看到书写/坐姿/态度/效率和用时', rb.write === 5 && rb.posture === 4 && rb.attitude === 5
    && rb.efficiency === 4 && rb.minutes === 45 && rb.other === '主动问了三个问题' && rb.bogus === undefined, JSON.stringify(rb));
  const badRub = await call('POST', `/api/submissions/${hwRow.submissionId}/grade`, {
    scores: [{ answerId: hwRow.answers[0].id, score: 9 }], rubric: { write: 9, minutes: 9999 } }, T.token);
  const rb2 = (await call('GET', `/api/homeworks/${hwHw.id}`, null, S.token)).mySubmission.rubric;
  check('评分栏超范围的值被丢掉', rb2 === null && badRub.score === 9, JSON.stringify(rb2));

  // 星星奖品
  const before = (await call('GET', '/api/rewards', null, S.token)).stars;
  const reward = await call('POST', '/api/admin/rewards', { name: TAG + ' 文具套装', stars: 20, note: '前台领取' }, T.token);
  const tooBig = await call('POST', '/api/admin/rewards', { name: TAG + ' 自行车', stars: before + 500 }, T.token);
  const wall = await call('GET', '/api/rewards', null, S.token);
  const myRw = wall.rewards.find((r) => r.id === reward.id);
  const far = wall.rewards.find((r) => r.id === tooBig.id);
  check('奖品墙显示还差多少颗星', myRw.canRedeem === true && far.canRedeem === false && far.need > 0, `${myRw.name} 可换；${far.name} 还差 ${far.need}`);
  const cantAfford = await expectFail('POST', `/api/rewards/${tooBig.id}/redeem`, {}, S.token);
  check('星星不够不能兑换', /还差/.test(cantAfford || ''), cantAfford);
  const red = await call('POST', `/api/rewards/${reward.id}/redeem`, {}, S.token);
  check('兑换后立刻扣星', red.left === before - 20, `${before} → ${red.left}`);
  const pendings = await call('GET', '/api/admin/redemptions?status=pending', null, T.token);
  check('老师看到待发放', pendings.list.some((x) => x.id === red.id && x.studentName === '李小明'), `${pendings.pending} 份待发放`);
  await call('POST', `/api/admin/redemptions/${red.id}/cancel`, null, T.token);
  check('取消兑换退回星星', (await call('GET', '/api/rewards', null, S.token)).stars === before, '');
  const stuAdmin = await expectFail('POST', '/api/admin/rewards', { name: 'x', stars: 1 }, S.token);
  check('学生不能自己加奖品', /无权限/.test(stuAdmin || ''), stuAdmin);

  // 清理本段
  await call('DELETE', `/api/homeworks/${hwHw.id}`, null, T.token);
  await call('DELETE', `/api/classes/${hwCls.id}`, null, T.token);
  for (const rw of [reward, tooBig]) await call('DELETE', `/api/admin/rewards/${rw.id}`, null, T.token).catch(() => {});

  log('\n[11] 教务档案：学员、课包、点名、请假');
  const enSub = (await call('GET', '/api/subjects', null, T.token)).subjects.find((x) => x.code === 'en');
  const arcCls = await call('POST', '/api/classes', { subjectId: enSub.id, gradeBand: '三四年级', name: TAG + ' 档案班' }, T.token);
  const arcStu = await call('POST', '/api/admin/students', { name: TAG + '学员', gender: '男', school: '实验小学',
    grade: '三年级', parentName: '学员妈妈', phone: '13800002222', note: '周六下午', classId: arcCls.id }, T.token);
  const stuTok = (await call('POST', '/api/auth/login', { role: 'student', name: TAG + '学员' })).token;
  const arcPkg = await call('POST', '/api/admin/packages', { studentId: arcStu.id, subjectId: enSub.id, totalHours: 40, giftHours: 5,
    priceOriginal: 4000, pricePaid: 3600, purchasedAt: '2026-01-01', expiresAt: '2027-01-01', note: '暑期班' }, T.token);
  check('课包：共计=购买+赠送，金额按元存', arcPkg.sumHours === 45 && arcPkg.leftHours === 45 && arcPkg.pricePaid === 3600,
    `共 ${arcPkg.sumHours} 剩 ${arcPkg.leftHours} 实收 ¥${arcPkg.pricePaid}`);

  const dayOf = (n) => new Date(Date.now() + 8 * 3600e3 + n * 86400e3).toISOString().slice(0, 10);
  // 家长请假 → 老师准假 → 点名时不扣课时
  const arcLeave = await call('POST', '/api/leaves', { date: dayOf(1), classId: arcCls.id, reason: '发烧' }, stuTok);
  const dupLv = await expectFail('POST', '/api/leaves', { date: dayOf(1), classId: arcCls.id }, stuTok);
  check('同一天不能重复请假', /已经请过假/.test(dupLv || ''), dupLv);
  const pastLv = await expectFail('POST', '/api/leaves', { date: dayOf(-3) }, stuTok);
  check('不能给过去的日子请假', /今天或以后/.test(pastLv || ''), pastLv);
  await call('POST', `/api/admin/leaves/${arcLeave.id}/approve`, {}, T.token);
  const arcRoster = await call('GET', `/api/classes/${arcCls.id}/attendance?date=${dayOf(1)}`, null, T.token);
  const rosterRow = arcRoster.students.find((x) => x.id === arcStu.id);
  check('点名页带出已批准的请假和剩余课时', rosterRow.approvedLeave === true && rosterRow.leftHours === 45, `${rosterRow.name} 剩 ${rosterRow.leftHours}`);
  const r1 = await call('POST', `/api/classes/${arcCls.id}/attendance`, { date: dayOf(1), hours: 2,
    records: [{ studentId: arcStu.id, status: 'leave' }] }, T.token);
  check('请假不扣课时', r1.usedHours === 0, `扣 ${r1.usedHours}`);

  // 到课扣课时，改点名会退回
  await call('POST', `/api/classes/${arcCls.id}/attendance`, { date: dayOf(0), hours: 2, records: [{ studentId: arcStu.id, status: 'present' }] }, T.token);
  let arc = await call('GET', '/api/me/archive', null, stuTok);
  check('到课扣课时，学生端看得到剩余', arc.hours.leftHours === 43, `剩 ${arc.hours.leftHours}`);
  await call('POST', `/api/classes/${arcCls.id}/attendance`, { date: dayOf(0), hours: 2, records: [{ studentId: arcStu.id, status: 'leave' }] }, T.token);
  arc = await call('GET', '/api/me/archive', null, stuTok);
  check('改成请假后课时退回', arc.hours.leftHours === 45, `剩 ${arc.hours.leftHours}`);

  // 手工加减 + 流水
  await call('POST', `/api/admin/packages/${arcPkg.id}/adjust`, { hours: -3, note: '补上次漏扣' }, T.token);
  const arcDetail = await call('GET', `/api/admin/students/${arcStu.id}`, null, T.token);
  check('手工调整进流水，档案能查到', arcDetail.hours.leftHours === 42 && arcDetail.logs.some((l) => l.reason === 'adjust' && l.hours === -3),
    `剩 ${arcDetail.hours.leftHours}，${arcDetail.logs.length} 条流水`);
  check('档案里有学员资料和班级', arcDetail.profile.school === '实验小学' && arcDetail.classes.some((c) => c.id === arcCls.id), arcDetail.profile.school);

  // 停课顺延
  await call('POST', `/api/admin/packages/${arcPkg.id}/pause`, {}, T.token);
  const pausedPkg = (await call('GET', `/api/admin/students/${arcStu.id}`, null, T.token)).packages[0];
  check('停课中的课包不计入可用', pausedPkg.status === 'paused', pausedPkg.status);
  const resumedPkg = await call('POST', `/api/admin/packages/${arcPkg.id}/resume`, {}, T.token);
  check('恢复上课后到期日顺延', resumedPkg.expiresAt >= '2027-01-01', resumedPkg.expiresAt);

  // 权限：老师看不到金额，看不到别班学生
  const tOnly = await call('POST', '/api/admin/teachers', { name: TAG + '周老师' }, T.token);
  const tOnlyTok = (await call('POST', '/api/auth/login', { role: 'teacher', name: tOnly.name, teacherCode: tOnly.code })).token;
  const notMine = await expectFail('GET', `/api/admin/students/${arcStu.id}`, null, tOnlyTok);
  check('老师看不到别班学生的档案', /不是你班上/.test(notMine || ''), notMine);
  await call('PUT', `/api/classes/${arcCls.id}`, { subjectId: enSub.id, gradeBand: '三四年级', name: arcCls.name, teacherId: tOnly.id }, T.token);
  const asTeacher = await call('GET', `/api/admin/students/${arcStu.id}`, null, tOnlyTok);
  check('自己班的老师能看剩余课时，但看不到金额和家长手机', asTeacher.hours.leftHours === 42
    && asTeacher.packages[0].pricePaid === undefined, `剩 ${asTeacher.hours.leftHours}`);
  const noEdit = await expectFail('PUT', `/api/admin/students/${arcStu.id}`, { note: 'x' }, tOnlyTok);
  check('老师改不了档案资料', /无权限/.test(noEdit || ''), noEdit);

  // 学校简介
  const aboutBefore = await call('GET', '/api/about', null, T.token);
  await call('PUT', '/api/admin/about', { title: TAG + '学校', text: '办学十年\n主打小班教学' }, T.token);
  const aboutHtml = await (await fetch(BASE + '/about')).text();
  check('学校简介公开页', aboutHtml.includes(TAG + '学校') && aboutHtml.includes('主打小班教学') && aboutHtml.includes('预约试听'), '');
  await call('PUT', '/api/admin/about', { title: aboutBefore.title, text: aboutBefore.text }, T.token);   // 还原，别动真实简介

  // 清理
  await call('DELETE', `/api/admin/teachers/${tOnly.id}`, null, T.token).catch(() => {});

  log('\n[12] 教务台');
  const board = await call('GET', '/api/admin/dashboard', null, T.token);
  check('教务台：今天的班、待办数、本月收款', Array.isArray(board.classes) && board.classes.every((c) => 'marked' in c)
    && typeof board.toReview === 'number' && board.month && typeof board.month.income === 'number',
    `${board.classes.length} 个班，待批改 ${board.toReview}，本月收款 ¥${board.month.income}`);
  const boardTeacher = await call('POST', '/api/admin/teachers', { name: TAG + '吴老师' }, T.token);
  const boardTok = (await call('POST', '/api/auth/login', { role: 'teacher', name: boardTeacher.name, teacherCode: boardTeacher.code })).token;
  const tBoard = await call('GET', '/api/admin/dashboard', null, boardTok);
  check('老师的教务台不含经营数据和咨询', tBoard.month === undefined && tBoard.newLeads === undefined && tBoard.classes.length === 0,
    `${tBoard.classes.length} 个班`);
  await call('DELETE', `/api/admin/teachers/${boardTeacher.id}`, null, T.token);

  log('\n[13] 电脑版教务后台：批量建档、报表、考勤表、导出');
  const bulkCls = (await call('GET', '/api/classes', null, T.token))[0];
  const bulk = await call('POST', '/api/admin/students/bulk', { names: `${TAG}甲\n${TAG}乙`, classId: bulkCls.id,
    grade: '三年级', package: { totalHours: 10, giftHours: 0, priceOriginal: 100, pricePaid: 100, purchasedAt: dayOf(0), expiresAt: '' } }, T.token);
  check('批量建档：一行一个名字', bulk.created.length === 2, bulk.created.join('、'));
  const again = await call('POST', '/api/admin/students/bulk', { names: `${TAG}甲` }, T.token);
  check('重名的不重复建，只更新', again.created.length === 0 && again.existed.length === 1, JSON.stringify(again));

  const report = await call('GET', '/api/admin/report?months=6', null, T.token);
  check('报表：6 个月 + 课时结余', report.months.length === 6 && typeof report.owedHours === 'number'
    && report.months[5].income >= 1, `本月收款 ¥${report.months[5].income}，结余 ${report.owedHours} 课时`);

  const grid = await call('GET', `/api/admin/attendance-grid?classId=${arcCls.id}&month=${dayOf(0).slice(0, 7)}`, null, T.token);
  check('考勤网格：按天成列、每人一行', Array.isArray(grid.dates) && grid.students.every((x) => x.marks.length === grid.dates.length),
    `${grid.dates.length} 天 × ${grid.students.length} 人`);

  const csvRes = await fetch(BASE + '/api/admin/export/students', { headers: { Authorization: 'Bearer ' + T.token } });
  const csvBuf = Buffer.from(await csvRes.arrayBuffer());
  const csvText = csvBuf.toString('utf8');
  // 文件要以 BOM 开头，Excel 才不会把中文显示成乱码（fetch 的 text() 会吃掉 BOM，所以直接看字节）
  const hasBom = csvBuf[0] === 0xEF && csvBuf[1] === 0xBB && csvBuf[2] === 0xBF;
  check('导出学员名单：带 BOM 的 CSV', csvRes.status === 200 && hasBom
    && csvText.includes('姓名,性别,年级') && csvText.includes(`${TAG}甲`),
    (csvRes.headers.get('content-type') || '') + ' ' + csvText.split('\r\n').length + ' 行')
  const payRes = await fetch(BASE + '/api/admin/export/payments', { headers: { Authorization: 'Bearer ' + T.token } });
  check('导出收款流水', payRes.status === 200 && (await payRes.text()).includes('实收(元)'), '');

  const exTeacher = await call('POST', '/api/admin/teachers', { name: TAG + '郑老师' }, T.token);
  const exTok = (await call('POST', '/api/auth/login', { role: 'teacher', name: exTeacher.name, teacherCode: exTeacher.code })).token;
  const payDeny = await fetch(BASE + '/api/admin/export/payments', { headers: { Authorization: 'Bearer ' + exTok } });
  check('老师导不出收款和咨询', payDeny.status === 403, `HTTP ${payDeny.status}`);
  const stuCsv = await (await fetch(BASE + '/api/admin/export/students', { headers: { Authorization: 'Bearer ' + exTok } })).text();
  check('老师导出的名单里手机号打码', stuCsv.includes('***') || stuCsv.split('\r\n').length <= 2, '');
  await call('DELETE', `/api/admin/teachers/${exTeacher.id}`, null, T.token);

  log('\n[14] 老师科目归属、待批改统计、考勤补录');
  const subjAllX = (await call('GET', '/api/subjects', null, T.token)).subjects;
  const enX = subjAllX.find((x) => x.code === 'en'), calliX = subjAllX.find((x) => x.code === 'calli');
  const subjTeacher = await call('POST', '/api/admin/teachers', { name: TAG + '孔老师' }, T.token);
  const subjTok = (await call('POST', '/api/auth/login', { role: 'teacher', name: subjTeacher.name, teacherCode: subjTeacher.code })).token;
  await call('PUT', `/api/admin/teachers/${subjTeacher.id}/subjects`, { subjectIds: [calliX.id] }, T.token);
  const staffList = await call('GET', '/api/admin/teachers', null, T.token);
  check('老师账号带上教的科目', (staffList.find((u) => u.id === subjTeacher.id).subjectIds || []).includes(calliX.id), '书法');
  const wrongSubj = await expectFail('POST', '/api/classes', { subjectId: enX.id, gradeBand: '初中' }, subjTok);
  check('老师开不了自己不教的科目', /你教的科目里没有/.test(wrongSubj || ''), wrongSubj);
  const rightSubj = await call('POST', '/api/classes', { subjectId: calliX.id, gradeBand: '初中', name: TAG + ' 孔老师书法班' }, subjTok);
  check('自己教的科目可以开班', rightSubj.subject.code === 'calli', rightSubj.name);
  const adminAny = await call('POST', '/api/classes', { subjectId: enX.id, gradeBand: '初中', name: TAG + ' 负责人英语班' }, T.token);
  check('负责人不受科目限制', adminAny.subject.code === 'en', adminAny.name);

  // 待批改份数
  const pendHw = await call('POST', '/api/homeworks/questions', { classId: adminAny.id, title: TAG + ' 待批统计',
    questions: [{ type: 'photo', score: 10, stem: '拍照上传' }] }, T.token);
  await call('POST', `/api/admin/students/${S.user.id}/classes`, { classId: adminAny.id }, T.token);
  const pendView = await call('GET', `/api/homeworks/${pendHw.id}`, null, S.token);
  await call('POST', `/api/homeworks/${pendHw.id}/answers`, { answers: [{ questionId: pendView.questions[0].id, photos: [JPG] }] }, S.token);
  const hwList = await call('GET', '/api/homeworks', null, T.token);
  const pendRow = hwList.find((h) => h.id === pendHw.id);
  check('作业列表直接给出待批改份数', pendRow.pending === 1 && pendRow.submitted === 1, `交 ${pendRow.submitted} 待批 ${pendRow.pending}`);
  const pendSubs = await call('GET', `/api/homeworks/${pendHw.id}/submissions`, null, T.token);
  const pendSub = pendSubs.rows.find((r) => r.submissionId);
  await call('POST', `/api/submissions/${pendSub.submissionId}/grade`, { scores: [{ answerId: pendSub.answers[0].id, score: 8 }] }, T.token);
  const after2 = (await call('GET', '/api/homeworks', null, T.token)).find((h) => h.id === pendHw.id);
  check('批完之后不再计入待批改', after2.pending === 0, `待批 ${after2.pending}`);

  // 电脑端考勤补录：单个学生直接改，清除会退回课时
  const gridStu = await call('POST', '/api/admin/students', { name: TAG + '补录同学', classId: adminAny.id }, T.token);
  await call('POST', '/api/admin/packages', { studentId: gridStu.id, totalHours: 10, giftHours: 0,
    priceOriginal: 0, pricePaid: 0, purchasedAt: dayOf(0), expiresAt: '' }, T.token);
  await call('POST', `/api/classes/${adminAny.id}/attendance`, { date: dayOf(-2), hours: 2,
    records: [{ studentId: gridStu.id, status: 'present' }] }, T.token);
  let gridHours = (await call('GET', `/api/admin/students/${gridStu.id}`, null, T.token)).hours.leftHours;
  check('补录过去某天照样扣课时', gridHours === 8, `剩 ${gridHours}`);
  await call('POST', `/api/classes/${adminAny.id}/attendance`, { date: dayOf(-2), hours: 2,
    records: [{ studentId: gridStu.id, status: 'clear' }] }, T.token);
  gridHours = (await call('GET', `/api/admin/students/${gridStu.id}`, null, T.token)).hours.leftHours;
  const gridAfter = await call('GET', `/api/admin/attendance-grid?classId=${adminAny.id}&month=${dayOf(-2).slice(0, 7)}`, null, T.token);
  check('清除记录：课时退回、格子也空了', gridHours === 10 && !gridAfter.dates.includes(dayOf(-2)), `剩 ${gridHours}`);

  await call('DELETE', `/api/homeworks/${pendHw.id}`, null, T.token);
  await call('DELETE', `/api/classes/${rightSubj.id}`, null, T.token);
  await call('DELETE', `/api/admin/teachers/${subjTeacher.id}`, null, T.token);

  log('\n[15] 课时边界：扣成负数、事后准假、重复点名');
  const edgeCls = await call('POST', '/api/classes', { subjectId: enX.id, gradeBand: '初中', name: TAG + ' 边界班' }, T.token);
  const edgeStu = await call('POST', '/api/admin/students', { name: TAG + '边界同学', classId: edgeCls.id }, T.token);
  const edgeTok = (await call('POST', '/api/auth/login', { role: 'student', name: TAG + '边界同学' })).token;
  const edgePkg = await call('POST', '/api/admin/packages', { studentId: edgeStu.id, totalHours: 2, giftHours: 0,
    priceOriginal: 0, pricePaid: 0, purchasedAt: dayOf(0), expiresAt: '' }, T.token);
  const tooMuch = await expectFail('POST', `/api/admin/packages/${edgePkg.id}/adjust`, { hours: -5 }, T.token);
  check('手工扣减不能把课时扣成负数', /只剩 2 课时/.test(tooMuch || ''), tooMuch);

  // 一次课扣 3 课时，只剩 2：允许但要提醒已用超
  const edgeOver = await call('POST', `/api/classes/${edgeCls.id}/attendance`, { date: dayOf(0), hours: 3,
    records: [{ studentId: edgeStu.id, status: 'present' }] }, T.token);
  check('课时不够时照常点名，但提示已用超', edgeOver.overdrawn.includes(edgeStu.name), JSON.stringify(edgeOver.overdrawn));

  // 重复提交同一次点名：不产生新的流水
  const logsBefore = (await call('GET', `/api/admin/students/${edgeStu.id}`, null, T.token)).logs.length;
  await call('POST', `/api/classes/${edgeCls.id}/attendance`, { date: dayOf(0), hours: 3,
    records: [{ studentId: edgeStu.id, status: 'present' }, { studentId: edgeStu.id, status: 'present' }] }, T.token);
  const logsAfter = (await call('GET', `/api/admin/students/${edgeStu.id}`, null, T.token)).logs.length;
  check('重复点名不再重复写流水', logsBefore === logsAfter, `${logsBefore} → ${logsAfter}`);

  // 事后准假：已经扣掉的课时自动退回，考勤改成请假
  const lateLeave = await call('POST', '/api/leaves', { date: dayOf(0), classId: edgeCls.id, reason: '临时有事' }, edgeTok);
  const edgeAppr = await call('POST', `/api/admin/leaves/${lateLeave.id}/approve`, {}, T.token);
  const edgeAfter = await call('GET', `/api/admin/students/${edgeStu.id}`, null, T.token);
  check('事后准假：课时退回、考勤改成请假', edgeAppr.refunded === 3 && edgeAfter.hours.leftHours === 2
    && edgeAfter.attendance[0].status === 'leave', `退回 ${edgeAppr.refunded}，剩 ${edgeAfter.hours.leftHours}`);

  await call('POST', `/api/classes/${edgeCls.id}/attendance`, { date: dayOf(0), hours: 3,
    records: [{ studentId: edgeStu.id, status: 'clear' }] }, T.token);
  await call('DELETE', `/api/classes/${edgeCls.id}`, null, T.token);

  log('\n[16] 排课、子科目、联系方式');
  const schedSubj = (await call('GET', '/api/meta', null, T.token)).subjects.find((x) => x.code === 'en');
  const newCourse = await call('POST', '/api/courses', { subjectId: schedSubj.id, name: TAG.slice(-6) + '英语' }, T.token);
  check('老师可以自己加子科目（课程）', newCourse.name.endsWith('英语'), newCourse.name);
  const dupCourse = await expectFail('POST', '/api/courses', { subjectId: schedSubj.id, name: newCourse.name }, T.token);
  check('同一科目下课程不重名', /已经有/.test(dupCourse || ''), dupCourse);

  const schedCls = await call('POST', '/api/classes', { subjectId: schedSubj.id, gradeBand: '三四年级',
    courseId: newCourse.id, schedule: { days: [6, 2], start: '10:00', end: '11:30' } }, T.token);
  check('班级带课程和排期，名字自动带课程名', schedCls.course.id === newCourse.id
    && schedCls.scheduleText === '每周二、六 10:00–11:30' && schedCls.name.includes(newCourse.name),
    `${schedCls.name} / ${schedCls.scheduleText}`);
  check('算得出下次上课', /^\d{4}-\d{2}-\d{2}$/.test(schedCls.nextClassAt || ''), schedCls.nextClassAt);

  const wrongCourse = await expectFail('POST', '/api/classes', { subjectId: (await call('GET', '/api/meta', null, T.token)).subjects
    .find((x) => x.code === 'math').id, gradeBand: '初中', courseId: newCourse.id }, T.token);
  check('课程和科目对不上被拒', /不属于所选科目/.test(wrongCourse || ''), wrongCourse);

  const roster2 = await call('GET', `/api/classes/${schedCls.id}/attendance?date=2026-09-21`, null, T.token);   // 周一
  check('点名页能看出这天是不是排课日', roster2.hasSchedule && roster2.meetsOn === false, `${roster2.scheduleText} / ${roster2.meetsOn}`);
  const board2 = await call('GET', '/api/admin/dashboard', null, T.token);
  check('教务台把今天有课的班排前面', board2.classes.every((c, i, a) => i === 0 || !(c.meetsToday && !a[i - 1].meetsToday)), '');

  const usedCourse = await expectFail('DELETE', `/api/courses/${newCourse.id}`, null, T.token);
  check('课程被班级占用时不能删', /在用这门课程/.test(usedCourse || ''), usedCourse);

  // 联系方式
  const ctBefore = await call('GET', '/api/contact');
  await call('PUT', '/api/admin/contact', { phone: '15100000000', address: TAG + ' 和平路 1 号', hours: '9:00–20:00' }, T.token);
  const ct = await call('GET', '/api/contact');
  check('联系方式能存能读', ct.phone === '15100000000' && ct.address.includes('和平路'), `${ct.phone} ${ct.address}`);
  const trialHtml2 = await (await fetch(BASE + '/trial')).text();
  check('预约页底部显示联系方式', trialHtml2.includes('15100000000') && trialHtml2.includes('联系我们'), '');
  const stuDenied = await expectFail('PUT', '/api/admin/contact', { phone: '13000000000' }, S.token);
  check('学生改不了联系方式', /无权限/.test(stuDenied || ''), stuDenied);
  await call('PUT', '/api/admin/contact', { phone: ctBefore.phone, address: ctBefore.address, hours: ctBefore.hours }, T.token);

  await call('DELETE', `/api/classes/${schedCls.id}`, null, T.token);
  await call('DELETE', `/api/courses/${newCourse.id}`, null, T.token);

  log('\n[17] 家长咨询跟进流程');
  const fPhone = '1390000' + String(Date.now()).slice(-4);
  await call('POST', '/api/public/leads', { phone: fPhone, grade: '四年级', subjects: ['zh'], agree: true, source: 'trial' });
  const fLead = (await call('GET', '/api/admin/leads', null, T.token)).list.find((l) => l.phone === fPhone);
  check('新咨询默认待联系，并算出等了多久', fLead.status === 'new' && typeof fLead.waitingHours === 'number',
    `${fLead.status} / ${fLead.waitingHours}h`);
  await call('PUT', `/api/admin/leads/${fLead.id}`, { status: 'contacted', followAt: dayOf(-1) }, T.token);
  let fAfter = (await call('GET', '/api/admin/leads', null, T.token)).list.find((l) => l.id === fLead.id);
  check('跟进日过了会标成逾期，并记下联系时间', fAfter.overdue === true && !!fAfter.lastContactAt, `${fAfter.followAt} 逾期=${fAfter.overdue}`);
  await call('PUT', `/api/admin/leads/${fLead.id}`, { status: 'trial', trialAt: dayOf(1) }, T.token);
  fAfter = (await call('GET', '/api/admin/leads', null, T.token)).list.find((l) => l.id === fLead.id);
  check('约到试听会记进漏斗', fAfter.status === 'trial' && fAfter.trialAt === dayOf(1), `${fAfter.status} ${fAfter.trialAt}`);
  const funnelBefore = (await call('GET', '/api/admin/leads', null, T.token)).funnel;
  await call('PUT', `/api/admin/leads/${fLead.id}`, { status: 'enrolled' }, T.token);
  const funnelAfter = (await call('GET', '/api/admin/leads', null, T.token)).funnel;
  check('报名后漏斗里的报名数 +1', funnelAfter.enrolled === funnelBefore.enrolled + 1,
    `${funnelBefore.enrolled} → ${funnelAfter.enrolled}`);
  const badStatus = await expectFail('PUT', `/api/admin/leads/${fLead.id}`, { status: '乱写' }, T.token);
  check('状态只认这几种', /状态不对/.test(badStatus || ''), badStatus);
  const leadCsv = await (await fetch(BASE + '/api/admin/export/leads', { headers: { Authorization: 'Bearer ' + T.token } })).text();
  check('导出带上跟进日期和试听日期', leadCsv.includes('下次跟进,试听日期'), '');
  await call('DELETE', `/api/admin/leads/${fLead.id}`, null, T.token);

  log('\n[18] 预约页课程开关与矢量二维码');
  const pubCourses = (await call('GET', '/api/courses', null, T.token)).filter((c) => c.public);
  check('预约页默认只放英语那几门', pubCourses.length > 0 && pubCourses.every((c) => c.subject.code === 'en'),
    pubCourses.map((c) => c.name).join('、'));
  const trialPage = await (await fetch(BASE + '/trial')).text();
  check('预约页不显示没开放的课程', !/阅读写作|奥数思维|小学硬笔书法/.test(trialPage) && /新概念英语/.test(trialPage), '');

  const toggleMe = (await call('GET', '/api/courses', null, T.token)).find((c) => !c.public && c.subject.code === 'zh');
  await call('PUT', `/api/courses/${toggleMe.id}`, { public: true }, T.token);
  const trial2 = await (await fetch(BASE + '/trial')).text();
  check('负责人打开开关后就出现在预约页', trial2.includes(toggleMe.name), toggleMe.name);
  await call('PUT', `/api/courses/${toggleMe.id}`, { public: false }, T.token);

  const svgQr = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
  const withQr = await call('PUT', '/api/admin/contact', { qrSvg: svgQr }, T.token);
  check('联系方式支持矢量二维码', /\.svg$/.test(withQr.qr || ''), withQr.qr);
  const badSvg = await expectFail('PUT', '/api/admin/contact', { qrSvg: '<img src=x onerror=alert(1)>' }, T.token);
  check('不是 SVG 的内容被拒', /格式不对/.test(badSvg || ''), badSvg);

  log('\n[19] 入班要老师确认，防止乱加名字');
  const dev = (x) => `dev${TAG.slice(-6)}${x}`;   // 每次跑用不同的设备号，别被上一轮的限额挡住
  const joinCls = await call('POST', '/api/classes', { subjectId: enX.id, gradeBand: '初中', name: TAG + ' 入班测试班' }, T.token);
  // 老师先建好名单：学生进来点自己的名字，不用确认
  const listed = await call('POST', '/api/admin/students', { name: TAG + '名单里的', classId: joinCls.id }, T.token);
  const joinPreview = await call('POST', '/api/classes/preview', { inviteCode: joinCls.inviteCode });
  check('输邀请码能看到还没人认领的名字', joinPreview.names.some((n) => n.id === listed.id), joinPreview.names.map((n) => n.name).join('、'));
  const claimed = await call('POST', '/api/auth/claim', { inviteCode: joinCls.inviteCode, studentId: listed.id, device: dev('A') });
  check('点名单上的名字直接进班', claimed.join.status === 'active', claimed.join.status);
  const joinPreview2 = await call('POST', '/api/classes/preview', { inviteCode: joinCls.inviteCode });
  check('认领过的名字不再出现在名单里', !joinPreview2.names.some((n) => n.id === listed.id), `${joinPreview2.names.length} 个名字待认领`);
  const stolen = await expectFail('POST', '/api/auth/claim', { inviteCode: joinCls.inviteCode, studentId: listed.id, device: dev('B') });
  check('别的手机点同一个名字会被挡住', /已经有人在用/.test(stolen || ''), stolen);

  // 名单里没有的名字：进待确认队列
  const naughty = await call('POST', '/api/auth/login', { role: 'student', name: TAG + '捣蛋鬼', inviteCode: joinCls.inviteCode, device: dev('C') });
  check('乱报的名字只能挂起等确认', naughty.join.status === 'pending', naughty.join.status);
  const joinRoster = await call('GET', `/api/classes/${joinCls.id}/students`, null, T.token);
  check('没确认前不进名单、也不占人数', !joinRoster.some((m) => /捣蛋鬼/.test(m.name)), `名单 ${joinRoster.length} 人`);
  const naughtyMe = await call('GET', '/api/me', null, naughty.token);
  check('没确认前学生看不到这个班', !naughtyMe.classes.some((c) => c.id === joinCls.id), `${naughtyMe.classes.length} 个班`);

  const reqs = await call('GET', '/api/admin/join-requests', null, T.token);
  const mineReq = reqs.find((r) => r.studentId === naughty.user.id);
  check('老师能看到申请，并标出同一台手机重复提交', !!mineReq && mineReq.sameDevice >= 1, `${reqs.length} 条`);

  // 同一台手机换名字反复进：超过三次就挡住
  // 名字会按 20 个字截断，这里用短名字保证每次都是新账号
  const short = TAG.slice(-5);
  let joinBlocked = null;
  const sockPuppets = [];
  for (let i = 0; i < 4 && !joinBlocked; i++) {
    const nm = `${short}小号${i}`;
    joinBlocked = await expectFail('POST', '/api/auth/login', { role: 'student', name: nm, inviteCode: joinCls.inviteCode, device: dev('C') });
    if (!joinBlocked) sockPuppets.push(nm);
  }
  check('同一台手机一天建太多账号会被拦', /账号太多/.test(joinBlocked || ''), joinBlocked);

  await call('POST', `/api/admin/join-requests/${joinCls.id}/${naughty.user.id}/approve`, {}, T.token);
  const joinRoster2 = await call('GET', `/api/classes/${joinCls.id}/students`, null, T.token);
  check('老师确认后才进名单', joinRoster2.some((m) => m.id === naughty.user.id), `名单 ${joinRoster2.length} 人`);
  const twice = await expectFail('POST', `/api/admin/join-requests/${joinCls.id}/${naughty.user.id}/approve`, {}, T.token);
  check('同一条申请不能重复处理', /处理过/.test(twice || ''), twice);

  // 拒绝：申请删掉，空账号一并清理
  const ghost = await call('POST', '/api/auth/login', { role: 'student', name: TAG + '路人', inviteCode: joinCls.inviteCode, device: dev('D') });
  await call('POST', `/api/admin/join-requests/${joinCls.id}/${ghost.user.id}/reject`, {}, T.token);
  const joinGone = await expectFail('GET', '/api/me', null, ghost.token);
  check('拒绝后空账号被清掉', /未登录|登录已过期/.test(joinGone || ''), joinGone);

  // 清掉刚才造的小号
  for (const nm of sockPuppets) {
    const u = (await call('GET', '/api/admin/students', null, T.token)).find((x) => x.name === nm);
    if (u) await call('DELETE', `/api/classes/${joinCls.id}/students/${u.id}`, null, T.token);
  }
  for (const sid of [listed.id, naughty.user.id]) await call('DELETE', `/api/classes/${joinCls.id}/students/${sid}`, null, T.token);
  await call('DELETE', `/api/classes/${joinCls.id}`, null, T.token);

  log('\n[7] 清理');
  const guarded = await expectFail('DELETE', `/api/admin/books/${book.id}`, null, T.token);
  check('有作业时拒绝删教材', /还有作业/.test(guarded || ''), guarded);

  await call('DELETE', `/api/homeworks/${hw.id}`, null, T.token);
  await call('DELETE', `/api/admin/books/${book.id}`, null, T.token);
  const gone = await expectFail('GET', `/api/books/${book.id}/catalog`, null, T.token);
  check('测试数据已清空', /教材不存在/.test(gone || ''), gone);
  const pageGone = await expectFail('GET', `/api/pages/${page.id}`, null, T.token);
  check('页面与热区级联删除', /页面不存在/.test(pageGone || ''), pageGone);

  log(`\n${fail === 0 ? '全部通过' : '有失败项'}：${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('\n测试异常中断：', e.message); process.exit(1); });
