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

  log('\n[6] 权限');
  if (process.env.TEACHER_CODE) {
    const bad = await expectFail('POST', '/api/auth/dev-login', { role: 'teacher', name: '王老师', teacherCode: 'wrong' });
    check('口令错误不能登录老师', /口令/.test(bad || ''), bad);
  }
  const forbid = await expectFail('POST', '/api/admin/books', { title: 'x' }, S.token);
  check('学生不能建教材', /无权限/.test(forbid || ''), forbid);

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
