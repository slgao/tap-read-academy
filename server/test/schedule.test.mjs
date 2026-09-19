import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const S = require('../src/schedule.js');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; } catch (e) { fail++; console.log('  [FAIL]', name, '-', e.message); } };

t('空排期算“时间不固定”', () => {
  assert.equal(S.clean(null), null);
  assert.equal(S.clean({ days: [] }), null);
  assert.equal(S.clean({ days: [9, -1] }), null);
});
t('去重排序、时间格式校验', () => {
  assert.deepEqual(S.clean({ days: [6, 2, 6], start: '10:00', end: '11:30' }), { days: [2, 6], start: '10:00', end: '11:30' });
  assert.deepEqual(S.clean({ days: [1], start: '25:00' }), { days: [1] });
  assert.deepEqual(S.clean({ days: [1], start: '10:00', end: '09:00' }), { days: [1], start: '10:00' });
});
t('判断某天有没有课', () => {
  assert.equal(S.meetsOn({ days: [6] }, '2026-09-19'), true);      // 2026-09-19 是周六
  assert.equal(S.meetsOn({ days: [6] }, '2026-09-20'), false);
  assert.equal(S.meetsOn(null, '2026-09-19'), false);
});
t('下一次上课（含今天）', () => {
  assert.equal(S.nextMeeting({ days: [6] }, '2026-09-19'), '2026-09-19');
  assert.equal(S.nextMeeting({ days: [6] }, '2026-09-20'), '2026-09-26');
  assert.equal(S.nextMeeting({ days: [2, 4] }, '2026-09-19'), '2026-09-22');
  assert.equal(S.nextMeeting(null, '2026-09-19'), null);
});
t('排期文字', () => {
  assert.equal(S.text({ days: [6], start: '10:00', end: '11:30' }), '每周六 10:00–11:30');
  assert.equal(S.text({ days: [2, 4], start: '18:00' }), '每周二、四 18:00');
  assert.equal(S.text(null), '');
});
console.log(`\n排期：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
