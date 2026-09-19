'use strict';
/**
 * 上课排期 —— 纯函数，不碰数据库。
 *
 * 培训机构的班不是每天都上：有的每周六上午，有的周二周四晚上。
 * 排期结构：{ days: [0..6], start: 'HH:MM', end: 'HH:MM' }，days 里 0 是周日、6 是周六。
 * 日期一律按北京时间算，和打卡、考勤保持一致。
 */

const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
const CN_OFFSET_MS = 8 * 3600 * 1000;

/** 'YYYY-MM-DD' -> 星期几（0 周日 ~ 6 周六） */
function weekdayOf(dateStr) {
  const t = Date.parse(dateStr + 'T00:00:00Z');
  return Number.isNaN(t) ? null : new Date(t).getUTCDay();
}

const dayKey = (ms = Date.now()) => new Date(ms + CN_OFFSET_MS).toISOString().slice(0, 10);

/** 校验并整理排期；空排期返回 null（表示“时间不固定”） */
function clean(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const days = [...new Set((Array.isArray(raw.days) ? raw.days : []).map(Number)
    .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
  if (!days.length) return null;
  const time = (v) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || '')) ? String(v) : '');
  const start = time(raw.start), end = time(raw.end);
  const out = { days };
  if (start) out.start = start;
  if (start && end && end > start) out.end = end;
  return out;
}

/** 这个班某天有没有课 */
function meetsOn(schedule, dateStr) {
  const s = clean(schedule);
  if (!s) return false;
  const w = weekdayOf(dateStr);
  return w != null && s.days.includes(w);
}

/** 下一次上课的日期（含今天）；没排期返回 null */
function nextMeeting(schedule, fromDate = dayKey()) {
  const s = clean(schedule);
  if (!s) return null;
  const base = Date.parse(fromDate + 'T00:00:00Z');
  if (Number.isNaN(base)) return null;
  for (let i = 0; i < 7; i++) {
    const d = new Date(base + i * 86400000).toISOString().slice(0, 10);
    if (meetsOn(s, d)) return d;
  }
  return null;
}

/** 给人看的排期文字：每周二、周四 18:00–19:30 */
function text(schedule) {
  const s = clean(schedule);
  if (!s) return '';
  const days = '每周' + s.days.map((d) => WEEK[d]).join('、');
  const time = s.start ? ` ${s.start}${s.end ? '–' + s.end : ''}` : '';
  return days + time;
}

module.exports = { WEEK, clean, meetsOn, nextMeeting, text, weekdayOf, dayKey };
