/* 自动评分单元测试：node test/grading.test.mjs */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { gradeQuestion: g, validateQuestion: v, normalize } = require('../src/grading.js');

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`  [${ok ? 'ok' : 'FAIL'}] ${name}${ok ? '' : `  得到 ${JSON.stringify(got)}，应为 ${JSON.stringify(want)}`}`);
};

console.log('\n单选 / 多选 / 判断');
eq('单选答对', g({ type: 'single', score: 2, answer: 1 }, 1), { correct: true, score: 2 });
eq('单选答错', g({ type: 'single', score: 2, answer: 1 }, 0), { correct: false, score: 0 });
eq('单选未作答', g({ type: 'single', score: 2, answer: 0 }, null), { correct: false, score: 0 });
eq('单选字符串下标也算', g({ type: 'single', score: 2, answer: 2 }, '2'), { correct: true, score: 2 });
eq('多选全对（顺序无关）', g({ type: 'multi', score: 4, answer: [0, 2] }, [2, 0]), { correct: true, score: 4 });
eq('多选少选不得分', g({ type: 'multi', score: 4, answer: [0, 2] }, [0]), { correct: false, score: 0 });
eq('多选多选不得分', g({ type: 'multi', score: 4, answer: [0, 2] }, [0, 1, 2]), { correct: false, score: 0 });
eq('判断答对', g({ type: 'judge', score: 1, answer: false }, false), { correct: true, score: 1 });
eq('判断答错', g({ type: 'judge', score: 1, answer: true }, false), { correct: false, score: 0 });

console.log('\n填空');
const zh = { type: 'blank', score: 3, answer: { blanks: [['春风'], ['绿', '綠']] } };
eq('语文两空全对', g(zh, ['春风', '绿']), { correct: true, score: 3 });
eq('可接受的另一个答案', g(zh, ['春风', '綠']), { correct: true, score: 3 });
eq('两空对一空按比例', g(zh, ['春风', '红']), { correct: false, score: 1.5 });
eq('首尾空格、全角忽略', g({ type: 'blank', score: 1, answer: { blanks: [['Apple']] } }, ['　ａｐｐｌｅ ']), { correct: true, score: 1 });
eq('数学整数', g({ type: 'blank', score: 2, answer: { blanks: [['12']] } }, ['１２']), { correct: true, score: 2 });
const pi = { type: 'blank', score: 2, answer: { blanks: [['3.14']], tolerance: 0.01 } };
eq('数值容差内', g(pi, ['3.1416']), { correct: true, score: 2 });
eq('数值超出容差', g(pi, ['3.2']), { correct: false, score: 0 });
eq('没设容差时 3.140 不等于 3.14', g({ type: 'blank', score: 1, answer: { blanks: [['3.14']] } }, ['3.140']), { correct: false, score: 0 });
eq('空着不算对', g({ type: 'blank', score: 1, answer: { blanks: [['0']] } }, ['']), { correct: false, score: 0 });

console.log('\n老师批改的题');
for (const t of ['photo', 'text', 'audio']) eq(`${t} 返回待批改`, g({ type: t, score: 5 }, 'x'), { correct: null, score: null });

console.log('\n出题校验');
eq('合法单选', v({ type: 'single', score: 2, stem: '1+1=?', options: ['1', '2'], answer: 1 }, 0), null);
eq('选项为空', v({ type: 'single', score: 2, stem: 'x', options: ['1', ''], answer: 0 }, 0), '第 1 题：至少两个选项，且选项不能为空');
eq('没标正确选项', v({ type: 'multi', score: 2, stem: 'x', options: ['a', 'b'], answer: [] }, 1), '第 2 题：请标出正确选项');
eq('分值为 0', v({ type: 'photo', score: 0, stem: '写一个"永"字' }, 0), '第 1 题：分值要在 0–100 之间');
eq('题干和图片都没有', v({ type: 'photo', score: 5, stem: ' ' }, 2), '第 3 题：题目文字和题目图片至少要有一个');
eq('只有题目图片也行', v({ type: 'photo', score: 5, stem: '', stemImageBase64: 'xx' }, 0), null);
eq('填空某空没答案', v({ type: 'blank', score: 2, stem: 'x', answer: { blanks: [['a'], ['']] } }, 0), '第 1 题：每个空至少填一个正确答案');
eq('判断没选', v({ type: 'judge', score: 1, stem: 'x' }, 0), '第 1 题：请选择对或错');
eq('normalize', normalize('  Ｈｅｌｌｏ　 World '), 'hello world');

console.log(`\n${fail ? '有失败' : '全部通过'}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
