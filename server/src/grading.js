'use strict';
/**
 * 自动评分 —— 纯函数，不碰数据库。
 *
 * 能自动评：single 单选、multi 多选、judge 判断、blank 填空
 * 需老师评：photo 拍照、text 文字、audio 录音（返回 correct=null）
 */

const AUTO_TYPES = ['single', 'multi', 'judge', 'blank'];
const MANUAL_TYPES = ['photo', 'text', 'audio'];
const ALL_TYPES = [...AUTO_TYPES, ...MANUAL_TYPES];

/** 全角转半角、去首尾空白、合并空白、英文小写 */
function normalize(s) {
  return String(s == null ? '' : s)
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/　/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** "3.14"、"１２"、"-0.5" 这样的纯数字 */
function toNumber(s) {
  const t = normalize(s).replace(/\s/g, '');
  return /^[-+]?(\d+\.?\d*|\.\d+)$/.test(t) ? Number(t) : null;
}

/** 一个空是否答对：命中任一可接受答案即可；数字可设容差 */
function blankMatches(given, accepted, tolerance) {
  const g = normalize(given);
  if (!g) return false;
  const list = Array.isArray(accepted) ? accepted : [accepted];
  for (const a of list) {
    if (normalize(a) === g) return true;
    const tol = Number(tolerance) || 0;
    if (tol > 0) {
      const gn = toNumber(g), an = toNumber(a);
      if (gn != null && an != null && Math.abs(gn - an) <= tol + 1e-12) return true;
    }
  }
  return false;
}

/**
 * 评一道题。
 * @param q      { type, score, answer }  answer 结构：
 *               single: 选项下标 number
 *               multi:  选项下标数组
 *               judge:  true / false
 *               blank:  { blanks: [[可接受答案...], ...], tolerance }
 * @param value  学生作答，结构与 answer 对应；blank 为字符串数组
 * @returns { correct: true|false|null, score: number|null }
 */
function gradeQuestion(q, value) {
  const full = Number(q.score) || 0;
  const ans = q.answer;
  switch (q.type) {
    case 'single': {
      const ok = value !== null && value !== undefined && value !== '' && Number(value) === Number(ans);
      return { correct: ok, score: ok ? full : 0 };
    }
    case 'multi': {
      // 多选：完全选对才得分，少选、多选都不得分
      const a = [...new Set((ans || []).map(Number))].sort();
      const v = [...new Set((Array.isArray(value) ? value : []).map(Number))].sort();
      const ok = a.length > 0 && a.length === v.length && a.every((x, i) => x === v[i]);
      return { correct: ok, score: ok ? full : 0 };
    }
    case 'judge': {
      const ok = typeof value === 'boolean' ? value === Boolean(ans)
        : (value === 'true' || value === 'false') ? (value === 'true') === Boolean(ans) : false;
      return { correct: ok, score: ok ? full : 0 };
    }
    case 'blank': {
      // 多个空按答对的比例给分
      const blanks = (ans && ans.blanks) || [];
      if (!blanks.length) return { correct: false, score: 0 };
      const given = Array.isArray(value) ? value : [value];
      let right = 0;
      blanks.forEach((accepted, i) => { if (blankMatches(given[i], accepted, ans.tolerance)) right++; });
      const score = Math.round((full * right / blanks.length) * 100) / 100;
      return { correct: right === blanks.length, score };
    }
    default:
      return { correct: null, score: null };
  }
}

/** 校验并整理老师提交的一道题；有问题返回错误文字 */
function validateQuestion(q, i) {
  const n = `第 ${i + 1} 题`;
  if (!ALL_TYPES.includes(q.type)) return `${n}：题型不对`;
  const score = Number(q.score);
  if (!(score > 0 && score <= 100)) return `${n}：分值要在 0–100 之间`;
  if (!String(q.stem || '').trim() && !q.stemImageBase64 && !q.stemImageId) return `${n}：题目文字和题目图片至少要有一个`;
  if (q.type === 'single' || q.type === 'multi') {
    const opts = (q.options || []).map((o) => String(o || '').trim());
    if (opts.length < 2 || opts.some((o) => !o)) return `${n}：至少两个选项，且选项不能为空`;
    const ans = q.type === 'single' ? [q.answer] : q.answer;
    if (!Array.isArray(ans) || !ans.length || ans.some((x) => !(Number.isInteger(Number(x)) && x >= 0 && x < opts.length))) {
      return `${n}：请标出正确选项`;
    }
  }
  if (q.type === 'judge' && typeof q.answer !== 'boolean') return `${n}：请选择对或错`;
  if (q.type === 'blank') {
    const blanks = q.answer && q.answer.blanks;
    if (!Array.isArray(blanks) || !blanks.length || blanks.some((b) => !Array.isArray(b) || !b.some((x) => String(x).trim()))) {
      return `${n}：每个空至少填一个正确答案`;
    }
  }
  return null;
}

module.exports = { AUTO_TYPES, MANUAL_TYPES, ALL_TYPES, normalize, blankMatches, gradeQuestion, validateQuestion };
