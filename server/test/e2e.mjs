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
  const T = await call('POST', '/api/auth/dev-login', { role: 'teacher', name: '王老师', teacherCode: process.env.TEACHER_CODE || '' });
  check('老师登录', T.user.role === 'teacher', T.user.name);
  const me = await call('GET', '/api/me', null, T.token);
  check('老师有班级', me.classes.length > 0, me.classes[0] && me.classes[0].name);
  const noAuth = await expectFail('GET', '/api/me');
  check('未登录被拒', /未登录/.test(noAuth || ''), noAuth);

  const cls = (await call('GET', '/api/classes', null, T.token))[0];
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
  const hb = await call('POST', '/api/study/heartbeat', { seconds: 70 }, S.token);
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

  log('\n[6] 权限');
  if (process.env.TEACHER_CODE) {
    const bad = await expectFail('POST', '/api/auth/dev-login', { role: 'teacher', name: '王老师', teacherCode: 'wrong' });
    check('口令错误不能登录老师', /口令/.test(bad || ''), bad);
  }
  const forbid = await expectFail('POST', '/api/admin/books', { title: 'x' }, S.token);
  check('学生不能建教材', /无权限/.test(forbid || ''), forbid);

  log('\n[8] 多科目题目作业');
  const JPG = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
  const subj = await call('GET', '/api/subjects', null, T.token);
  const math = subj.subjects.find((x) => x.code === 'math');
  const calli = subj.subjects.find((x) => x.code === 'calli');
  check('四个科目', ['en', 'zh', 'math', 'calli'].every((c) => subj.subjects.some((x) => x.code === c)), subj.subjects.map((x) => x.name).join('、'));

  // 机构按科目开班、同科目按年级段分班；学生可以同时在几个科目的班里
  const badCls = await expectFail('POST', '/api/classes', { subjectId: math.id, gradeBand: '高中' }, T.token);
  check('建班：年级段不对被拒', /年级段/.test(badCls || ''), badCls);
  const mathCls = await call('POST', '/api/classes', { subjectId: math.id, gradeBand: '三四年级' }, T.token);
  const calliCls = await call('POST', '/api/classes', { subjectId: calli.id, gradeBand: '不分年级', name: TAG + ' 书法周六班' }, T.token);
  check('建班：不填班名自动起名', mathCls.name === '三四年级数学班' && mathCls.subject.code === 'math', mathCls.name);
  const joined = await call('POST', '/api/classes/join', { inviteCode: mathCls.inviteCode }, S.token);
  await call('POST', '/api/classes/join', { inviteCode: calliCls.inviteCode.toLowerCase() }, S.token);
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
  const other = await call('POST', '/api/auth/dev-login', { role: 'teacher', name: TAG + '赵老师', teacherCode: process.env.TEACHER_CODE || '' });
  const otherDel = await expectFail('DELETE', `/api/homeworks/${qhw.id}`, null, other.token);
  check('别的老师不能删这个班的作业', /只能删除自己班/.test(otherDel || ''), otherDel);
  const otherSee = await expectFail('GET', `/api/homeworks/${qhw.id}/submissions`, null, other.token);
  check('别的老师看不到这个班的批改页', /不是你带的班/.test(otherSee || ''), otherSee);
  const otherGrade = await expectFail('POST', `/api/submissions/${1}/grade`, { scores: [] }, other.token);
  check('别的老师不能打分', /不是你带的班|提交记录不存在/.test(otherGrade || ''), otherGrade);
  const otherRoster = await expectFail('GET', `/api/classes/${mathCls.id}/students`, null, other.token);
  check('别的老师看不到这个班的名单', /别的班/.test(otherRoster || ''), otherRoster);
  const otherPost = await expectFail('POST', '/api/homeworks/questions', { classId: mathCls.id, title: TAG + ' 蹭班',
    questions: [{ type: 'judge', score: 1, stem: 'x', answer: true }] }, other.token);
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
  await call('POST', '/api/public/leads', { token: work.url.split('/').pop(), phone, grade: '三年级', subjects: ['calli', 'bogus'], contactTime: '周末', agree: true });
  const dupLead = await call('POST', '/api/public/leads', { token: work.url.split('/').pop(), phone, grade: '三年级', agree: true });
  const leadsList = await call('GET', '/api/admin/leads', null, T.token);
  const myLead = leadsList.filter((l) => l.phone === phone);
  check('预约记录带来源学生、只保留合法科目、重复提交不重复记', myLead.length === 1 && myLead[0].refName === '李小明'
    && JSON.stringify(myLead[0].subjects) === '["calli"]' && dupLead.duplicate === true, myLead[0] && `${myLead[0].refName} ${myLead[0].subjectNames}`);
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
  const afterDel = await call("GET", "/api/me", null, S.token);
  check('删班后学生不再在这些班里', !afterDel.classes.some((x) => [mathCls.id, calliCls.id].includes(x.id)), afterDel.classes.map((x) => x.name).join('、'));

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
