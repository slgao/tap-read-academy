'use strict';
/**
 * 数据访问层 —— 全库唯一写 SQL 的地方。
 *
 * 业务代码（api.js）只调用这里的领域方法，看不见表名、列名和 SQL。
 * 迁移到微信云开发 / MySQL 时，只需要重写本文件，api.js 一行都不用动。
 *
 * 两条刻意的约定：
 *   1. 所有方法都是 async —— 当前 node:sqlite 是同步的，这里用 async 包一层是为了
 *      将来换成异步驱动（云开发 / mysql2）时调用方无需改动。
 *   2. 对外一律返回 camelCase 的领域对象，不泄露数据库列名。
 */
const { db } = require('./db');
const { now } = require('./util');

const q = (sql) => db.prepare(sql);
const num = (v) => Number(v);

/* ---------- 行 → 领域对象 ---------- */
const toUser = (r) => r && ({
  id: r.id, openid: r.openid, role: r.role, name: r.name, avatar: r.avatar,
  stars: r.stars, streak: r.streak, lastCheckin: r.last_checkin, createdAt: r.created_at,
});
const toClass = (r) => r && ({
  id: r.id, name: r.name, inviteCode: r.invite_code, teacherId: r.teacher_id, createdAt: r.created_at,
});
const toBook = (r) => r && ({
  id: r.id, title: r.title, subtitle: r.subtitle, grade: r.grade, cover: r.cover,
  sort: r.sort, status: r.status,
});
const toLesson = (r) => r && ({ id: r.id, bookId: r.book_id, title: r.title, audioId: r.audio_id, sort: r.sort });
const toPage = (r) => r && ({
  id: r.id, lessonId: r.lesson_id, pageNo: r.page_no, imgId: r.img_id,
  imgW: r.img_w, imgH: r.img_h, sort: r.sort,
});
const toHotspot = (r) => r && ({
  id: r.id, pageId: r.page_id, audioId: r.audio_id,
  x: r.x, y: r.y, w: r.w, h: r.h, startMs: r.start_ms, endMs: r.end_ms,
  en: r.text_en, cn: r.text_cn, type: r.type, sort: r.sort,
});
const toAsset = (r) => r && ({
  id: r.id, kind: r.kind, relPath: r.rel_path, mime: r.mime,
  durationMs: r.duration_ms, sizeBytes: r.size_bytes, placeholder: !!r.is_placeholder,
});
const toHomework = (r) => r && ({
  id: r.id, classId: r.class_id, teacherId: r.teacher_id, title: r.title, type: r.type,
  bookId: r.book_id, pageId: r.page_id,
  hotspotIds: JSON.parse(r.hotspot_ids || '[]'),
  note: r.note, deadline: r.deadline, createdAt: r.created_at,
});
const toSubmission = (r) => r && ({
  id: r.id, homeworkId: r.homework_id, studentId: r.student_id, status: r.status,
  submittedAt: r.submitted_at, elapsedSec: r.elapsed_sec, stars: r.stars,
  reviewText: r.review_text, reviewedAt: r.reviewed_at,
});
const toSubItem = (r) => r && ({
  id: r.id, submissionId: r.submission_id, hotspotId: r.hotspot_id,
  assetId: r.asset_id, durationMs: r.duration_ms,
});
const toCheckin = (r) => r && ({ studentId: r.student_id, date: r.date, seconds: r.seconds, stars: r.stars });

const count = (sql, ...args) => q(sql).get(...args).n;

/* ---------- users ---------- */
const users = {
  async byId(id) { return toUser(q('SELECT * FROM users WHERE id=?').get(num(id))); },
  async byNameRole(name, role) { return toUser(q('SELECT * FROM users WHERE name=? AND role=?').get(name, role)); },
  async byToken(token) {
    const s = q('SELECT * FROM sessions WHERE token=?').get(token);
    return s ? users.byId(s.user_id) : null;
  },
  async create({ openid, role, name }) {
    const r = q('INSERT INTO users (openid, role, name, stars, streak, created_at) VALUES (?,?,?,0,0,?)')
      .run(openid, role, name, now());
    return users.byId(Number(r.lastInsertRowid));
  },
  async addStars(id, n) { q('UPDATE users SET stars=stars+? WHERE id=?').run(num(n), num(id)); },
  async markCheckin(id, { date, streak, gainedStars }) {
    q('UPDATE users SET last_checkin=?, streak=?, stars=stars+? WHERE id=?').run(date, num(streak), num(gainedStars), num(id));
  },
  async countByRole(role) { return count('SELECT COUNT(*) n FROM users WHERE role=?', role); },
};

/* ---------- sessions ---------- */
const sessions = {
  async create(token, userId) { q('INSERT INTO sessions (token, user_id, created_at) VALUES (?,?,?)').run(token, num(userId), now()); },
};

/* ---------- classes ---------- */
const classes = {
  async byId(id) { return toClass(q('SELECT * FROM classes WHERE id=?').get(num(id))); },
  async byInviteCode(code) { return toClass(q('SELECT * FROM classes WHERE invite_code=?').get(code)); },
  async all() { return q('SELECT * FROM classes').all().map(toClass); },
  /** 老师看自己带的班，学生看自己加入的班 */
  async idsForUser(user) {
    return user.role === 'student'
      ? q('SELECT class_id AS id FROM class_members WHERE student_id=?').all(num(user.id)).map((r) => r.id)
      : q('SELECT id FROM classes WHERE teacher_id=?').all(num(user.id)).map((r) => r.id);
  },
  async create({ name, inviteCode, teacherId }) {
    const r = q('INSERT INTO classes (name, invite_code, teacher_id, created_at) VALUES (?,?,?,?)')
      .run(name, inviteCode, num(teacherId), now());
    return classes.byId(Number(r.lastInsertRowid));
  },
  async inviteCodeTaken(code) { return !!q('SELECT 1 x FROM classes WHERE invite_code=?').get(code); },
  async addMember(classId, studentId) {
    q('INSERT OR IGNORE INTO class_members (class_id, student_id, joined_at) VALUES (?,?,?)').run(num(classId), num(studentId), now());
  },
  /** 班级学生名单，按星星降序 */
  async members(classId) {
    return q(`SELECT u.id, u.name, u.stars, u.streak FROM class_members m
              JOIN users u ON u.id=m.student_id WHERE m.class_id=? ORDER BY u.stars DESC`).all(num(classId));
  },
  async memberCount(classId) { return count('SELECT COUNT(*) n FROM class_members WHERE class_id=?', num(classId)); },
};

/* ---------- books / lessons / pages / hotspots ---------- */
const books = {
  async listActive() { return q('SELECT * FROM books WHERE status=1 ORDER BY sort, id').all().map(toBook); },
  async byId(id) { return toBook(q('SELECT * FROM books WHERE id=?').get(num(id))); },
  async byTitle(title) { return toBook(q('SELECT * FROM books WHERE title=?').get(title)); },
  async all() { return q('SELECT * FROM books').all().map(toBook); },
  async create({ title, subtitle, grade }) {
    const r = q('INSERT INTO books (title, subtitle, grade, sort, status, created_at) VALUES (?,?,?,0,1,?)')
      .run(title, subtitle || '', grade || '', now());
    return books.byId(Number(r.lastInsertRowid));
  },
  async lessonCount(bookId) { return count('SELECT COUNT(*) n FROM lessons WHERE book_id=?', num(bookId)); },
  async pageCount(bookId) {
    return count('SELECT COUNT(*) n FROM pages p JOIN lessons l ON l.id=p.lesson_id WHERE l.book_id=?', num(bookId));
  },
  async grantToClass(bookId, classId) {
    q('INSERT OR IGNORE INTO book_grants (book_id, class_id) VALUES (?,?)').run(num(bookId), num(classId));
  },
  async count() { return count('SELECT COUNT(*) n FROM books'); },
  /** 连同其下的课、页面、热区、授权一起删掉 */
  async remove(id) {
    for (const l of await lessons.byBook(id)) await lessons.remove(l.id);
    q('DELETE FROM book_grants WHERE book_id=?').run(num(id));
    q('DELETE FROM books WHERE id=?').run(num(id));
  },
};

const lessons = {
  async byId(id) { return toLesson(q('SELECT * FROM lessons WHERE id=?').get(num(id))); },
  async byBook(bookId) { return q('SELECT * FROM lessons WHERE book_id=? ORDER BY sort, id').all(num(bookId)).map(toLesson); },
  async countByBook(bookId) { return count('SELECT COUNT(*) n FROM lessons WHERE book_id=?', num(bookId)); },
  async create({ bookId, title, sort }) {
    const r = q('INSERT INTO lessons (book_id, title, sort) VALUES (?,?,?)').run(num(bookId), title, num(sort));
    return lessons.byId(Number(r.lastInsertRowid));
  },
  async setAudio(id, assetId) { q('UPDATE lessons SET audio_id=? WHERE id=?').run(num(assetId), num(id)); },
  /** 连同其下的页面与热区一起删掉 */
  async remove(id) {
    for (const pid of await pages.idsByLesson(id)) await pages.remove(pid);
    q('DELETE FROM lessons WHERE id=?').run(num(id));
  },
};

const pages = {
  async byId(id) { return toPage(q('SELECT * FROM pages WHERE id=?').get(num(id))); },
  async byLesson(lessonId) { return q('SELECT * FROM pages WHERE lesson_id=? ORDER BY sort, id').all(num(lessonId)).map(toPage); },
  async idsByLesson(lessonId) { return q('SELECT id FROM pages WHERE lesson_id=? ORDER BY sort, id').all(num(lessonId)).map((r) => r.id); },
  async countByLesson(lessonId) { return count('SELECT COUNT(*) n FROM pages WHERE lesson_id=?', num(lessonId)); },
  async create({ lessonId, pageNo, imgId, imgW, imgH, sort }) {
    const r = q('INSERT INTO pages (lesson_id, page_no, img_id, img_w, img_h, sort) VALUES (?,?,?,?,?,?)')
      .run(num(lessonId), num(pageNo), num(imgId), num(imgW), num(imgH), num(sort));
    return pages.byId(Number(r.lastInsertRowid));
  },
  async remove(id) {
    q('DELETE FROM hotspots WHERE page_id=?').run(num(id));
    q('DELETE FROM pages WHERE id=?').run(num(id));
  },
  async count() { return count('SELECT COUNT(*) n FROM pages'); },
};

const hotspots = {
  async byId(id) { return toHotspot(q('SELECT * FROM hotspots WHERE id=?').get(num(id))); },
  async byPage(pageId) { return q('SELECT * FROM hotspots WHERE page_id=? ORDER BY sort, id').all(num(pageId)).map(toHotspot); },
  async countByPage(pageId) { return count('SELECT COUNT(*) n FROM hotspots WHERE page_id=?', num(pageId)); },
  /** 整页替换（标注后台保存时用）—— 语义上是一次原子的"这一页的热区就是这些" */
  async replaceForPage(pageId, list, defaultAudioId) {
    q('DELETE FROM hotspots WHERE page_id=?').run(num(pageId));
    const ins = q(`INSERT INTO hotspots (page_id, audio_id, x, y, w, h, start_ms, end_ms, text_en, text_cn, type, sort)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    let i = 0;
    for (const h of list) {
      ins.run(num(pageId), h.audioId || defaultAudioId || null,
        Number(h.x) || 0, Number(h.y) || 0, Number(h.w) || 0, Number(h.h) || 0,
        Math.round(Number(h.startMs) || 0), Math.round(Number(h.endMs) || 0),
        String(h.en || ''), String(h.cn || ''), h.type || 'sentence', ++i);
    }
    return list.length;
  },
  async count() { return count('SELECT COUNT(*) n FROM hotspots'); },
};

/* ---------- assets（只管数据库记录，文件读写在 storage.js） ---------- */
const assets = {
  async byId(id) { return id ? toAsset(q('SELECT * FROM assets WHERE id=?').get(num(id))) : null; },
  async create({ kind, relPath, mime, durationMs, sizeBytes, placeholder }) {
    const r = q(`INSERT INTO assets (kind, rel_path, mime, duration_ms, size_bytes, is_placeholder, created_at)
                 VALUES (?,?,?,?,?,?,?)`)
      .run(kind, relPath, mime || '', num(durationMs) || 0, num(sizeBytes) || 0, placeholder ? 1 : 0, now());
    return assets.byId(Number(r.lastInsertRowid));
  },
};

/* ---------- 作业 ---------- */
const homeworks = {
  async byId(id) { return toHomework(q('SELECT * FROM homeworks WHERE id=?').get(num(id))); },
  async byClassIds(ids, limit = 50) {
    if (!ids.length) return [];
    const marks = ids.map(() => '?').join(',');
    return q(`SELECT * FROM homeworks WHERE class_id IN (${marks}) ORDER BY id DESC LIMIT ${num(limit)}`)
      .all(...ids.map(num)).map(toHomework);
  },
  async create({ classId, teacherId, title, type, bookId, pageId, hotspotIds, note, deadline }) {
    const r = q(`INSERT INTO homeworks (class_id, teacher_id, title, type, book_id, page_id, hotspot_ids, note, deadline, created_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(num(classId), num(teacherId), title, type || 'follow_read', num(bookId), num(pageId),
        JSON.stringify(hotspotIds.map(num)), note || '', deadline || '', now());
    return homeworks.byId(Number(r.lastInsertRowid));
  },
  async count() { return count('SELECT COUNT(*) n FROM homeworks'); },
  async countByBook(bookId) { return count('SELECT COUNT(*) n FROM homeworks WHERE book_id=?', num(bookId)); },
  async countByPage(pageId) { return count('SELECT COUNT(*) n FROM homeworks WHERE page_id=?', num(pageId)); },
  /** 连同提交记录一起删掉 */
  async remove(id) {
    for (const r of q('SELECT id FROM submissions WHERE homework_id=?').all(num(id))) {
      q('DELETE FROM submission_items WHERE submission_id=?').run(r.id);
    }
    q('DELETE FROM submissions WHERE homework_id=?').run(num(id));
    q('DELETE FROM homeworks WHERE id=?').run(num(id));
  },
};

const submissions = {
  async byId(id) { return toSubmission(q('SELECT * FROM submissions WHERE id=?').get(num(id))); },
  async byHomeworkAndStudent(homeworkId, studentId) {
    return toSubmission(q('SELECT * FROM submissions WHERE homework_id=? AND student_id=?').get(num(homeworkId), num(studentId)));
  },
  async countByHomework(homeworkId) { return count('SELECT COUNT(*) n FROM submissions WHERE homework_id=?', num(homeworkId)); },
  async countReviewed(homeworkId) {
    return count(`SELECT COUNT(*) n FROM submissions WHERE homework_id=? AND status='reviewed'`, num(homeworkId));
  },
  async create({ homeworkId, studentId, elapsedSec }) {
    const r = q(`INSERT INTO submissions (homework_id, student_id, status, submitted_at, elapsed_sec)
                 VALUES (?,?,'submitted',?,?)`).run(num(homeworkId), num(studentId), now(), num(elapsedSec) || 0);
    return submissions.byId(Number(r.lastInsertRowid));
  },
  async markResubmitted(id, elapsedSec) {
    q(`UPDATE submissions SET status='submitted', submitted_at=?, elapsed_sec=? WHERE id=?`)
      .run(now(), num(elapsedSec) || 0, num(id));
  },
  async review(id, { stars, reviewText }) {
    q(`UPDATE submissions SET status='reviewed', stars=?, review_text=?, reviewed_at=? WHERE id=?`)
      .run(num(stars), reviewText || '', now(), num(id));
  },
  async reject(id, reviewText) {
    q(`UPDATE submissions SET status='rejected', review_text=? WHERE id=?`).run(reviewText || '', num(id));
  },
  async count() { return count('SELECT COUNT(*) n FROM submissions'); },
};

const submissionItems = {
  async bySubmission(submissionId) {
    return q('SELECT * FROM submission_items WHERE submission_id=?').all(num(submissionId)).map(toSubItem);
  },
  async add({ submissionId, hotspotId, assetId, durationMs }) {
    q('INSERT INTO submission_items (submission_id, hotspot_id, asset_id, duration_ms) VALUES (?,?,?,?)')
      .run(num(submissionId), num(hotspotId), num(assetId), num(durationMs) || 0);
  },
  async clear(submissionId) { q('DELETE FROM submission_items WHERE submission_id=?').run(num(submissionId)); },
};

/* ---------- 打卡 ---------- */
const checkins = {
  async addSeconds(studentId, date, seconds) {
    q(`INSERT INTO checkins (student_id,date,seconds,stars) VALUES (?,?,?,0)
       ON CONFLICT(student_id,date) DO UPDATE SET seconds=seconds+?`)
      .run(num(studentId), date, num(seconds), num(seconds));
    return checkins.get(studentId, date);
  },
  async get(studentId, date) {
    return toCheckin(q('SELECT * FROM checkins WHERE student_id=? AND date=?').get(num(studentId), date));
  },
  async setStars(studentId, date, stars) {
    q('UPDATE checkins SET stars=? WHERE student_id=? AND date=?').run(num(stars), num(studentId), date);
  },
  async recent(studentId, limit = 30) {
    return q(`SELECT date, seconds, stars FROM checkins WHERE student_id=? ORDER BY date DESC LIMIT ${num(limit)}`)
      .all(num(studentId));
  },
};

module.exports = {
  users, sessions, classes, books, lessons, pages, hotspots, assets,
  homeworks, submissions, submissionItems, checkins,
};
