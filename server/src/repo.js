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

/**
 * 预编译语句缓存：同一条 SQL 只 prepare 一次。
 * 这些接口里不少是循环里反复查同一条语句，重复编译的开销比查询本身还大。
 */
const stmts = new Map();
const q = (sql) => {
  let st = stmts.get(sql);
  if (!st) { st = db.prepare(sql); stmts.set(sql, st); }
  return st;
};
const num = (v) => Number(v);
/** IN (?,?,?) 占位符 */
const marks = (list) => list.map(() => '?').join(',');
/** 批量查询结果整理成 Map，配合上面的 IN 查询，避免在循环里一条条查 */
const mapBy = (rows, key, val) => {
  const m = new Map();
  for (const r of rows) m.set(r[key], val ? val(r) : r);
  return m;
};

/* ---------- 行 → 领域对象 ---------- */
const toUser = (r) => r && ({
  id: r.id, openid: r.openid, role: r.role, name: r.name, avatar: r.avatar,
  stars: r.stars, streak: r.streak, lastCheckin: r.last_checkin, createdAt: r.created_at,
  loginCode: r.login_code, loginCodeEnc: r.login_code_enc, active: r.active == null ? 1 : r.active, device: r.device || '',
});
const toClass = (r) => r && ({
  id: r.id, name: r.name, inviteCode: r.invite_code, teacherId: r.teacher_id, createdAt: r.created_at,
  subjectId: r.subject_id, gradeBand: r.grade_band || '',
  courseId: r.course_id, schedule: parseJSON(r.schedule, null),
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
  subjectId: r.subject_id, kind: r.kind || 'follow_read',
});
const toSubmission = (r) => r && ({
  id: r.id, homeworkId: r.homework_id, studentId: r.student_id, status: r.status,
  submittedAt: r.submitted_at, elapsedSec: r.elapsed_sec, stars: r.stars,
  reviewText: r.review_text, reviewedAt: r.reviewed_at,
  score: r.score, maxScore: r.max_score, excellent: !!r.excellent, rubric: parseJSON(r.rubric, null),
});
const toSubject = (r) => r && ({ id: r.id, code: r.code, name: r.name, color: r.color, sort: r.sort });
const parseJSON = (t, d) => { try { return t == null || t === '' ? d : JSON.parse(t); } catch { return d; } };
const toQuestion = (r) => r && ({
  id: r.id, homeworkId: r.homework_id, sort: r.sort, type: r.type, stem: r.stem, stemImageId: r.stem_image_id,
  options: parseJSON(r.options, []), answer: parseJSON(r.answer, null), score: r.score, analysis: r.analysis,
});
const toAnswer = (r) => r && ({
  id: r.id, submissionId: r.submission_id, questionId: r.question_id, value: parseJSON(r.value, null),
  assetIds: parseJSON(r.asset_ids, []), autoCorrect: r.auto_correct == null ? null : !!r.auto_correct,
  score: r.score, comment: r.comment,
});
const toShare = (r) => r && ({
  id: r.id, token: r.token, type: r.type, studentId: r.student_id, submissionId: r.submission_id,
  subjectId: r.subject_id, title: r.title, imagePath: r.image_path, photoIds: parseJSON(r.photo_ids, []),
  comment: r.comment, stars: r.stars, showFullName: !!r.show_full_name, status: r.status,
  views: r.views, createdAt: r.created_at, revokedAt: r.revoked_at,
});
const toLead = (r) => r && ({
  id: r.id, shareId: r.share_id, refStudentId: r.ref_student_id, source: r.source, phone: r.phone,
  grade: r.grade, subjects: parseJSON(r.subjects, []), courses: parseJSON(r.courses, []),
  contactTime: r.contact_time, status: r.status,
  message: r.message || '', note: r.note, createdAt: r.created_at,
  followAt: r.follow_at || '', trialAt: r.trial_at || '', lastContactAt: r.last_contact_at || '',
});
const toCourse = (r) => r && ({ id: r.id, subjectId: r.subject_id, name: r.name, sort: r.sort, active: r.active, public: !!r.public });
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
  /** 按姓名找教职工（老师或负责人） */
  async staffByName(name) {
    return toUser(q("SELECT * FROM users WHERE name=? AND role IN ('teacher','admin') ORDER BY id LIMIT 1").get(name));
  },
  async staff() {
    return q("SELECT * FROM users WHERE role IN ('teacher','admin') ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END, id").all().map(toUser);
  },
  async setLoginCode(id, hash, enc) {
    q('UPDATE users SET login_code=?, login_code_enc=? WHERE id=?').run(hash, enc || null, num(id));
  },
  async setActive(id, on) { q('UPDATE users SET active=? WHERE id=?').run(on ? 1 : 0, num(id)); },
  async bindDevice(id, device) { q('UPDATE users SET device=? WHERE id=?').run(device || '', num(id)); },
  async countByDevice(device, sinceTime) {
    if (!device) return 0;
    return count("SELECT COUNT(*) n FROM users WHERE role='student' AND device=? AND created_at >= ?", device, sinceTime);
  },
  async setRole(id, role) { q('UPDATE users SET role=? WHERE id=?').run(role, num(id)); },
  async rename(id, name) { q('UPDATE users SET name=? WHERE id=?').run(name, num(id)); },
  async countStudentsSince(date) { return count("SELECT COUNT(*) n FROM users WHERE role='student' AND created_at >= ?", date); },
  async listByRole(role) { return q('SELECT * FROM users WHERE role=? ORDER BY id').all(role).map(toUser); },
  async remove(id) {
    q('DELETE FROM sessions WHERE user_id=?').run(num(id));
    q('DELETE FROM teacher_subjects WHERE user_id=?').run(num(id));
    q('DELETE FROM users WHERE id=?').run(num(id));
  },
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
  /** 清掉很久没用的登录凭证，免得这张表一直涨 */
  async pruneBefore(dateTime) {
    const r = q('DELETE FROM sessions WHERE created_at < ?').run(dateTime);
    return Number(r.changes || 0);
  },
};

/* ---------- classes ---------- */
const classes = {
  async byId(id) { return toClass(q('SELECT * FROM classes WHERE id=?').get(num(id))); },
  async byInviteCode(code) { return toClass(q('SELECT * FROM classes WHERE invite_code=?').get(code)); },
  async all() { return q('SELECT * FROM classes').all().map(toClass); },
  /** 学生看自己加入的班，老师看自己带的班，负责人看全校 */
  async idsForUser(user) {
    if (user.role === 'student') return q("SELECT class_id AS id FROM class_members WHERE student_id=? AND status='active'").all(num(user.id)).map((r) => r.id);
    if (user.role === 'admin') return q('SELECT id FROM classes ORDER BY id').all().map((r) => r.id);
    return q('SELECT id FROM classes WHERE teacher_id=?').all(num(user.id)).map((r) => r.id);
  },
  async countByTeacher(teacherId) { return count('SELECT COUNT(*) n FROM classes WHERE teacher_id=?', num(teacherId)); },
  async byTeacher(teacherId) { return q('SELECT * FROM classes WHERE teacher_id=? ORDER BY id').all(num(teacherId)).map(toClass); },
  async create({ name, inviteCode, teacherId, subjectId, gradeBand, courseId, schedule }) {
    const r = q(`INSERT INTO classes (name, invite_code, teacher_id, subject_id, grade_band, course_id, schedule, created_at)
                 VALUES (?,?,?,?,?,?,?,?)`)
      .run(name, inviteCode, num(teacherId), subjectId ? num(subjectId) : null, gradeBand || '',
        courseId ? num(courseId) : null, schedule ? JSON.stringify(schedule) : null, now());
    return classes.byId(Number(r.lastInsertRowid));
  },
  async update(id, { name, subjectId, gradeBand, courseId, schedule }) {
    const cur = q('SELECT * FROM classes WHERE id=?').get(num(id));
    if (!cur) return null;
    q('UPDATE classes SET name=?, subject_id=?, grade_band=?, course_id=?, schedule=? WHERE id=?')
      .run(name, num(subjectId), gradeBand || '',
        courseId === undefined ? cur.course_id : (courseId ? num(courseId) : null),
        schedule === undefined ? cur.schedule : (schedule ? JSON.stringify(schedule) : null), num(id));
    return classes.byId(id);
  },
  /** 换任课老师：一个班转给另一位老师 */
  async setTeacher(id, teacherId) {
    q('UPDATE classes SET teacher_id=? WHERE id=?').run(num(teacherId), num(id));
    return classes.byId(id);
  },
  /** 一位老师名下的班全部转走（离职、换人带班时用） */
  async moveAll(fromTeacherId, toTeacherId) {
    const r = q('UPDATE classes SET teacher_id=? WHERE teacher_id=?').run(num(toTeacherId), num(fromTeacherId));
    return Number(r.changes || 0);
  },
  /** 删班：成员、教材授权一起删；有作业或点过名的班由调用方拦住 */
  async remove(id) {
    q('DELETE FROM class_members WHERE class_id=?').run(num(id));
    q('DELETE FROM book_grants WHERE class_id=?').run(num(id));
    q('UPDATE leaves SET class_id=NULL WHERE class_id=?').run(num(id));   // 请假记录留着，只是不再挂在这个班
    q('DELETE FROM classes WHERE id=?').run(num(id));
  },
  async attendanceCount(classId) { return count('SELECT COUNT(*) n FROM attendance WHERE class_id=?', num(classId)); },
  async removeMember(classId, studentId) {
    q('DELETE FROM class_members WHERE class_id=? AND student_id=?').run(num(classId), num(studentId));
  },
  async inviteCodeTaken(code) { return !!q('SELECT 1 x FROM classes WHERE invite_code=?').get(code); },
  async addMember(classId, studentId, { status = 'active', device = '' } = {}) {
    q('INSERT OR IGNORE INTO class_members (class_id, student_id, joined_at, status, device) VALUES (?,?,?,?,?)')
      .run(num(classId), num(studentId), now(), status, device || '');
    if (status === 'active') q("UPDATE class_members SET status='active' WHERE class_id=? AND student_id=?").run(num(classId), num(studentId));
  },
  async memberStatus(classId, studentId) {
    const r = q('SELECT status FROM class_members WHERE class_id=? AND student_id=?').get(num(classId), num(studentId));
    return r ? (r.status || 'active') : null;
  },
  async setMemberStatus(classId, studentId, status) {
    q('UPDATE class_members SET status=? WHERE class_id=? AND student_id=?').run(status, num(classId), num(studentId));
  },
  /** 待老师确认的入班申请 */
  async pendingJoins(classIds) {
    if (!classIds.length) return [];
    return q(`SELECT m.class_id, m.student_id, m.joined_at, m.device, u.name, c.name AS class_name
              FROM class_members m JOIN users u ON u.id=m.student_id JOIN classes c ON c.id=m.class_id
              WHERE m.status='pending' AND m.class_id IN (${marks(classIds)})
              ORDER BY m.joined_at DESC`).all(...classIds.map(num))
      .map((r) => ({ classId: r.class_id, studentId: r.student_id, name: r.name, className: r.class_name,
        device: r.device || '', at: r.joined_at }));
  },
  async countPendingJoins(classIds) {
    if (!classIds.length) return 0;
    return count(`SELECT COUNT(*) n FROM class_members WHERE status='pending' AND class_id IN (${marks(classIds)})`, ...classIds.map(num));
  },
  /** 名单上还没人认领的名字（老师先建了档，学生进来点自己的名字） */
  async unclaimed(classId) {
    return q(`SELECT u.id, u.name FROM class_members m JOIN users u ON u.id=m.student_id
              WHERE m.class_id=? AND m.status='active' AND (u.device IS NULL OR u.device='')
              ORDER BY u.name`).all(num(classId)).map((r) => ({ id: r.id, name: r.name }));
  },
  /** 同一台手机最近提交过几次申请 */
  async deviceJoinCount(device, sinceTime) {
    if (!device) return 0;
    return count('SELECT COUNT(*) n FROM class_members WHERE device=? AND joined_at >= ?', device, sinceTime);
  },
  /** 班级学生名单，按星星降序 */
  async members(classId) {
    return q(`SELECT u.id, u.name, u.stars, u.streak FROM class_members m
              JOIN users u ON u.id=m.student_id WHERE m.class_id=? AND m.status='active'
              ORDER BY u.stars DESC`).all(num(classId));
  },
  async memberCount(classId) { return count("SELECT COUNT(*) n FROM class_members WHERE class_id=? AND status='active'", num(classId)); },
  /** 多个班的名单一次取完：classId -> [{id,name,stars,streak}] */
  async membersOfMany(classIds) {
    const out = new Map();
    if (!classIds.length) return out;
    const rows = q(`SELECT m.class_id, u.id, u.name, u.stars, u.streak FROM class_members m
                    JOIN users u ON u.id=m.student_id WHERE m.class_id IN (${marks(classIds)}) AND m.status='active'
                    ORDER BY u.stars DESC`).all(...classIds.map(num));
    for (const r of rows) {
      const arr = out.get(r.class_id) || out.set(r.class_id, []).get(r.class_id);
      arr.push({ id: r.id, name: r.name, stars: r.stars, streak: r.streak });
    }
    return out;
  },
  /** 一个学生在哪些班：一条查询代替遍历全校班级 */
  async forStudent(studentId) {
    return q(`SELECT c.* FROM classes c JOIN class_members m ON m.class_id=c.id
              WHERE m.student_id=? AND m.status='active' ORDER BY c.id`).all(num(studentId)).map(toClass);
  },
  /** 每位老师名下的班数：teacherId -> 个数 */
  async countsByTeacher() {
    return mapBy(q('SELECT teacher_id, COUNT(*) n FROM classes GROUP BY teacher_id').all(), 'teacher_id', (r) => r.n);
  },
  /** 这些班里的所有学生 id（老师的可见范围） */
  async studentIdsOfClasses(classIds) {
    if (!classIds.length) return [];
    return [...new Set(q(`SELECT DISTINCT student_id FROM class_members WHERE class_id IN (${marks(classIds)}) AND status='active'`)
      .all(...classIds.map(num)).map((r) => r.student_id))];
  },
  /** 一次取多个班（列表页用，避免一个班一条查询） */
  async byIds(ids) {
    if (!ids.length) return new Map();
    return mapBy(q(`SELECT * FROM classes WHERE id IN (${marks(ids)})`).all(...ids.map(num)), 'id', toClass);
  },
  /** 多个班的人数：classId -> 人数 */
  async memberCounts(ids) {
    if (!ids.length) return new Map();
    return mapBy(q(`SELECT class_id, COUNT(*) n FROM class_members WHERE class_id IN (${marks(ids)}) AND status='active' GROUP BY class_id`)
      .all(...ids.map(num)), 'class_id', (r) => r.n);
  },
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
  /** 整本书按「课顺序 + 页顺序」排好的页面 id，用于连续翻页 */
  async idsByBook(bookId) {
    return q(`SELECT p.id FROM pages p JOIN lessons l ON l.id=p.lesson_id
              WHERE l.book_id=? ORDER BY l.sort, l.id, p.sort, p.id`).all(num(bookId)).map((r) => r.id);
  },
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
  /** 每页热区数：pageId -> 个数 */
  async countsByPages(pageIds) {
    if (!pageIds.length) return new Map();
    return mapBy(q(`SELECT page_id, COUNT(*) n FROM hotspots WHERE page_id IN (${marks(pageIds)}) GROUP BY page_id`)
      .all(...pageIds.map(num)), 'page_id', (r) => r.n);
  },
  /** 每课带时间轴的句子数（听力列表用）：lessonId -> 句数 */
  async listenCountsByBook(bookId) {
    return mapBy(q(`SELECT p.lesson_id, COUNT(*) n FROM hotspots h
                    JOIN pages p ON p.id=h.page_id JOIN lessons l ON l.id=p.lesson_id
                    WHERE l.book_id=? AND h.end_ms > h.start_ms GROUP BY p.lesson_id`)
      .all(num(bookId)), 'lesson_id', (r) => r.n);
  },
  /** 整课的句子（按音频时间排好），听力播放页用 */
  async byLessonTimeline(lessonId) {
    return q(`SELECT h.*, p.page_no FROM hotspots h JOIN pages p ON p.id=h.page_id
              WHERE p.lesson_id=? AND h.end_ms > h.start_ms ORDER BY h.start_ms`)
      .all(num(lessonId)).map((r) => ({ ...toHotspot(r), pageNo: r.page_no }));
  },
  /**
   * 整页保存热区（标注后台用）。
   *
   * 按位置**就地更新**已有的行，而不是删掉重插 —— 因为热区 id 会被作业（homeworks.hotspot_ids）
   * 和学生录音（submission_items.hotspot_id）引用。删掉重插会让老师每改一次标注，
   * 之前布置的作业和学生交的录音就全部对不上了。
   *
   * 多出来的行才删除；若该行已有学生录音，拒绝删除并说明原因。
   */
  async replaceForPage(pageId, list, defaultAudioId) {
    const existing = q('SELECT id FROM hotspots WHERE page_id=? ORDER BY sort, id').all(num(pageId));
    const upd = q(`UPDATE hotspots SET audio_id=?, x=?, y=?, w=?, h=?, start_ms=?, end_ms=?,
                   text_en=?, text_cn=?, type=?, sort=? WHERE id=?`);
    const ins = q(`INSERT INTO hotspots (page_id, audio_id, x, y, w, h, start_ms, end_ms, text_en, text_cn, type, sort)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);

    list.forEach((h, i) => {
      const args = [h.audioId || defaultAudioId || null,
        Number(h.x) || 0, Number(h.y) || 0, Number(h.w) || 0, Number(h.h) || 0,
        Math.round(Number(h.startMs) || 0), Math.round(Number(h.endMs) || 0),
        String(h.en || ''), String(h.cn || ''), h.type || 'sentence', i + 1];
      if (existing[i]) upd.run(...args, existing[i].id);
      else ins.run(num(pageId), ...args);
    });

    for (const row of existing.slice(list.length)) {
      const used = count('SELECT COUNT(*) n FROM submission_items WHERE hotspot_id=?', row.id);
      if (used) {
        const e = new Error('有学生已经对这一页的句子交过录音，不能减少热区数量；请先删掉相关作业');
        e.code = 3009;
        throw e;
      }
      q('DELETE FROM hotspots WHERE id=?').run(row.id);
    }
    return list.length;
  },
  async count() { return count('SELECT COUNT(*) n FROM hotspots'); },
};

/* ---------- assets（只管数据库记录，文件读写在 storage.js） ---------- */
const assets = {
  async byId(id) { return id ? toAsset(q('SELECT * FROM assets WHERE id=?').get(num(id))) : null; },
  /** 一次取多个资产：id -> 资产（批改页、作品页一次要几十张图） */
  async byIds(ids) {
    const list = [...new Set(ids.filter(Boolean).map(num))];
    if (!list.length) return new Map();
    return mapBy(q(`SELECT * FROM assets WHERE id IN (${marks(list)})`).all(...list), 'id', toAsset);
  },
  async remove(ids) {
    const list = [...new Set(ids.filter(Boolean).map(num))];
    if (list.length) q(`DELETE FROM assets WHERE id IN (${marks(list)})`).run(...list);
  },
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
  async create({ classId, teacherId, title, type, bookId, pageId, hotspotIds, note, deadline, subjectId }) {
    const r = q(`INSERT INTO homeworks (class_id, teacher_id, title, type, book_id, page_id, hotspot_ids, note, deadline, created_at, subject_id, kind)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,'follow_read')`)
      .run(num(classId), num(teacherId), title, type || 'follow_read', num(bookId), num(pageId),
        JSON.stringify(hotspotIds.map(num)), note || '', deadline || '', now(), subjectId ? num(subjectId) : null);
    return homeworks.byId(Number(r.lastInsertRowid));
  },
  /** 题目作业：作业与题目一起写入，要么全成功要么全不写 */
  async createWithQuestions({ classId, teacherId, subjectId, title, note, deadline, questions }) {
    db.exec('BEGIN');
    try {
      const r = q(`INSERT INTO homeworks (class_id, teacher_id, title, type, hotspot_ids, note, deadline, created_at, subject_id, kind)
                   VALUES (?,?,?,'questions','[]',?,?,?,?,'questions')`)
        .run(num(classId), num(teacherId), title, note || '', deadline || '', now(), num(subjectId));
      const hwId = Number(r.lastInsertRowid);
      const ins = q(`INSERT INTO questions (homework_id, sort, type, stem, stem_image_id, options, answer, score, analysis)
                     VALUES (?,?,?,?,?,?,?,?,?)`);
      questions.forEach((x, i) => ins.run(hwId, i + 1, x.type, x.stem || '', x.stemImageId || null,
        JSON.stringify(x.options || []), JSON.stringify(x.answer === undefined ? null : x.answer), Number(x.score) || 1, x.analysis || ''));
      db.exec('COMMIT');
      return homeworks.byId(hwId);
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  },
  async count() { return count('SELECT COUNT(*) n FROM homeworks'); },
  async countByBook(bookId) { return count('SELECT COUNT(*) n FROM homeworks WHERE book_id=?', num(bookId)); },
  async countByClass(classId) { return count('SELECT COUNT(*) n FROM homeworks WHERE class_id=?', num(classId)); },
  async countByPage(pageId) { return count('SELECT COUNT(*) n FROM homeworks WHERE page_id=?', num(pageId)); },
  /** 连同提交记录一起删掉 */
  async remove(id) {
    for (const r of q('SELECT id FROM submissions WHERE homework_id=?').all(num(id))) {
      q('DELETE FROM submission_items WHERE submission_id=?').run(r.id);
      q('DELETE FROM answers WHERE submission_id=?').run(r.id);
    }
    q('DELETE FROM questions WHERE homework_id=?').run(num(id));
    q('DELETE FROM submissions WHERE homework_id=?').run(num(id));
    q('DELETE FROM homeworks WHERE id=?').run(num(id));
  },
};

const submissions = {
  async byId(id) { return toSubmission(q('SELECT * FROM submissions WHERE id=?').get(num(id))); },
  async byHomeworkAndStudent(homeworkId, studentId) {
    return toSubmission(q('SELECT * FROM submissions WHERE homework_id=? AND student_id=?').get(num(homeworkId), num(studentId)));
  },
  async countByStudent(studentId) { return count('SELECT COUNT(*) n FROM submissions WHERE student_id=?', num(studentId)); },
  async countByHomework(homeworkId) { return count('SELECT COUNT(*) n FROM submissions WHERE homework_id=?', num(homeworkId)); },
  /** 这些班里还等着老师批改的作业份数 */
  async countToReview(classIds) {
    if (!classIds.length) return 0;
    return count(`SELECT COUNT(*) n FROM submissions s JOIN homeworks h ON h.id=s.homework_id
                  WHERE s.status='submitted' AND h.class_id IN (${marks(classIds)})`, ...classIds.map(num));
  },
  /** 一个学生在多份作业里的提交：homeworkId -> 提交 */
  async byStudentForHomeworks(studentId, homeworkIds) {
    if (!homeworkIds.length) return new Map();
    return mapBy(q(`SELECT * FROM submissions WHERE student_id=? AND homework_id IN (${marks(homeworkIds)})`)
      .all(num(studentId), ...homeworkIds.map(num)), 'homework_id', toSubmission);
  },
  /** 多份作业的提交/批改份数：homeworkId -> { submitted, reviewed } */
  async statsByHomeworks(homeworkIds) {
    if (!homeworkIds.length) return new Map();
    return mapBy(q(`SELECT homework_id, COUNT(*) n, SUM(CASE WHEN status='reviewed' THEN 1 ELSE 0 END) r
                    FROM submissions WHERE homework_id IN (${marks(homeworkIds)}) GROUP BY homework_id`)
      .all(...homeworkIds.map(num)), 'homework_id', (x) => ({ submitted: x.n, reviewed: x.r || 0 }));
  },
  /** 一份作业里全班的提交：studentId -> 提交 */
  async byHomeworkForStudents(homeworkId) {
    return mapBy(q('SELECT * FROM submissions WHERE homework_id=?').all(num(homeworkId)), 'student_id', toSubmission);
  },
  async byIds(ids) {
    if (!ids.length) return new Map();
    return mapBy(q(`SELECT * FROM submissions WHERE id IN (${marks(ids)})`).all(...ids.map(num)), 'id', toSubmission);
  },
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
    q(`UPDATE submissions SET status='rejected', review_text=?, excellent=0 WHERE id=?`).run(reviewText || '', num(id));
  },
  async setScore(id, { score, maxScore, status, stars }) {
    q(`UPDATE submissions SET score=?, max_score=?, status=?, stars=COALESCE(?, stars),
       reviewed_at=CASE WHEN ?='reviewed' THEN ? ELSE reviewed_at END WHERE id=?`)
      .run(score, maxScore, status, stars == null ? null : num(stars), status, now(), num(id));
  },
  async setExcellent(id, excellent) { q('UPDATE submissions SET excellent=? WHERE id=?').run(excellent ? 1 : 0, num(id)); },
  /** 作业班的评分栏（书写、坐姿、态度、效率、用时） */
  async setRubric(id, rubric) {
    q('UPDATE submissions SET rubric=? WHERE id=?').run(rubric ? JSON.stringify(rubric) : null, num(id));
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


/* ---------- 科目 ---------- */
const toProfile = (r) => r && ({
  userId: r.user_id, gender: r.gender || '', school: r.school || '', grade: r.grade || '',
  parentName: r.parent_name || '', phone: r.phone || '', phone2: r.phone2 || '',
  note: r.note || '', status: r.status || 'active', updatedAt: r.updated_at,
});
const toPackage = (r) => r && ({
  id: r.id, studentId: r.student_id, subjectId: r.subject_id, courseId: r.course_id,
  totalHours: r.total_hours, giftHours: r.gift_hours, usedHours: r.used_hours,
  priceOriginal: r.price_original, pricePaid: r.price_paid,
  purchasedAt: r.purchased_at, expiresAt: r.expires_at, pausedAt: r.paused_at,
  status: r.status, note: r.note || '', createdAt: r.created_at,
});
const toHourLog = (r) => r && ({
  id: r.id, packageId: r.package_id, studentId: r.student_id, hours: r.hours,
  reason: r.reason, refId: r.ref_id, date: r.date, note: r.note || '', createdAt: r.created_at,
});
const toAttendance = (r) => r && ({
  id: r.id, classId: r.class_id, studentId: r.student_id, date: r.date, status: r.status,
  hours: r.hours, packageId: r.package_id, note: r.note || '', createdAt: r.created_at,
});
const toLeave = (r) => r && ({
  id: r.id, studentId: r.student_id, classId: r.class_id, date: r.date, reason: r.reason || '',
  status: r.status, createdAt: r.created_at, handledAt: r.handled_at,
});

/* ---------- 教务档案 ---------- */
const profiles = {
  async byUser(userId) { return toProfile(q('SELECT * FROM student_profiles WHERE user_id=?').get(num(userId))); },
  async byUsers(ids) {
    if (!ids.length) return new Map();
    return mapBy(q(`SELECT * FROM student_profiles WHERE user_id IN (${marks(ids)})`).all(...ids.map(num)), 'user_id', toProfile);
  },
  async save(userId, p) {
    q(`INSERT INTO student_profiles (user_id, gender, school, grade, parent_name, phone, phone2, note, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(user_id) DO UPDATE SET gender=excluded.gender, school=excluded.school, grade=excluded.grade,
         parent_name=excluded.parent_name, phone=excluded.phone, phone2=excluded.phone2,
         note=excluded.note, status=excluded.status, updated_at=excluded.updated_at`)
      .run(num(userId), p.gender || '', p.school || '', p.grade || '', p.parentName || '',
        p.phone || '', p.phone2 || '', p.note || '', p.status || 'active', now(), now());
    return profiles.byUser(userId);
  },
};

const packages = {
  async byId(id) { return toPackage(q('SELECT * FROM packages WHERE id=?').get(num(id))); },
  async byStudent(studentId) {
    return q('SELECT * FROM packages WHERE student_id=? ORDER BY id DESC').all(num(studentId)).map(toPackage);
  },
  /** 多个学生的课包，用于名单上显示剩余课时 */
  async byStudents(ids) {
    if (!ids.length) return new Map();
    const out = new Map();
    for (const r of q(`SELECT * FROM packages WHERE student_id IN (${marks(ids)})`).all(...ids.map(num))) {
      const list = out.get(r.student_id) || out.set(r.student_id, []).get(r.student_id);
      list.push(toPackage(r));
    }
    return out;
  },
  /** 扣课时优先用：同科目 > 不限科目，先到期的先用 */
  async pickForConsume(studentId, subjectId, date) {
    const rows = q(`SELECT * FROM packages WHERE student_id=? AND status='active'
                    AND total_hours + gift_hours - used_hours > 0
                    AND (expires_at IS NULL OR expires_at='' OR expires_at >= ?)`).all(num(studentId), date).map(toPackage);
    const same = rows.filter((p) => subjectId && p.subjectId === num(subjectId));
    const pool = same.length ? same : rows.filter((p) => !p.subjectId);
    const list = pool.length ? pool : rows;
    return list.sort((a, b) => String(a.expiresAt || '9999').localeCompare(String(b.expiresAt || '9999')))[0] || null;
  },
  async create(x) {
    const r = q(`INSERT INTO packages (student_id, subject_id, course_id, total_hours, gift_hours, used_hours,
                   price_original, price_paid, purchased_at, expires_at, status, note, created_at)
                 VALUES (?,?,?,?,?,0,?,?,?,?,'active',?,?)`)
      .run(num(x.studentId), x.subjectId ? num(x.subjectId) : null, x.courseId ? num(x.courseId) : null,
        Number(x.totalHours) || 0, Number(x.giftHours) || 0, num(x.priceOriginal) || 0, num(x.pricePaid) || 0,
        x.purchasedAt || '', x.expiresAt || '', x.note || '', now());
    return packages.byId(Number(r.lastInsertRowid));
  },
  async update(id, x) {
    const cur = q('SELECT * FROM packages WHERE id=?').get(num(id));
    if (!cur) return null;
    q(`UPDATE packages SET total_hours=?, gift_hours=?, price_original=?, price_paid=?,
         purchased_at=?, expires_at=?, paused_at=?, status=?, note=?, subject_id=? WHERE id=?`)
      .run(x.totalHours == null ? cur.total_hours : Number(x.totalHours),
        x.giftHours == null ? cur.gift_hours : Number(x.giftHours),
        x.priceOriginal == null ? cur.price_original : num(x.priceOriginal),
        x.pricePaid == null ? cur.price_paid : num(x.pricePaid),
        x.purchasedAt == null ? cur.purchased_at : x.purchasedAt,
        x.expiresAt == null ? cur.expires_at : x.expiresAt,
        x.pausedAt === undefined ? cur.paused_at : x.pausedAt,
        x.status || cur.status, x.note == null ? cur.note : x.note,
        x.subjectId === undefined ? cur.subject_id : (x.subjectId ? num(x.subjectId) : null), num(id));
    return packages.byId(id);
  },
  /** 一段时间内的收款（负责人看经营数据用） */
  /** 课包明细：收款流水导出用 */
  async list({ from, to, studentIds, limit = 5000 }) {
    const where = ['1=1'], args = [];
    if (from) { where.push('p.purchased_at >= ?'); args.push(from); }
    if (to) { where.push('p.purchased_at <= ?'); args.push(to); }
    if (studentIds) {
      if (!studentIds.length) return [];
      where.push(`p.student_id IN (${marks(studentIds)})`); args.push(...studentIds.map(num));
    }
    return q(`SELECT p.*, u.name AS student_name FROM packages p JOIN users u ON u.id=p.student_id
              WHERE ${where.join(' AND ')} ORDER BY p.purchased_at DESC, p.id DESC LIMIT ${num(limit)}`)
      .all(...args).map((r) => ({ ...toPackage(r), studentName: r.student_name }));
  },
  async monthlyPaid(from, to) {
    return q(`SELECT substr(purchased_at,1,7) m, COUNT(*) n, COALESCE(SUM(price_paid),0) paid
              FROM packages WHERE purchased_at >= ? AND purchased_at <= ? GROUP BY m ORDER BY m`).all(from, to);
  },
  async statsBetween(from, to) {
    const r = q('SELECT COUNT(*) n, COALESCE(SUM(price_paid),0) paid FROM packages WHERE purchased_at >= ? AND purchased_at <= ?').get(from, to);
    return { count: r.n, paid: r.paid };
  },
  async addUsed(id, hours) { q('UPDATE packages SET used_hours = used_hours + ? WHERE id=?').run(Number(hours), num(id)); },
  async remove(id) {
    q('DELETE FROM hour_logs WHERE package_id=?').run(num(id));
    q('DELETE FROM packages WHERE id=?').run(num(id));
  },
  async hasLogs(id) { return count('SELECT COUNT(*) n FROM hour_logs WHERE package_id=?', num(id)); },
};

const hourLogs = {
  async add(x) {
    const r = q(`INSERT INTO hour_logs (package_id, student_id, hours, reason, ref_id, date, note, created_by, created_at)
                 VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(x.packageId ? num(x.packageId) : null, num(x.studentId), Number(x.hours), x.reason || 'adjust',
        x.refId ? num(x.refId) : null, x.date || '', x.note || '', x.createdBy ? num(x.createdBy) : null, now());
    return Number(r.lastInsertRowid);
  },
  async byStudent(studentId, limit = 50) {
    return q(`SELECT * FROM hour_logs WHERE student_id=? ORDER BY id DESC LIMIT ${num(limit)}`)
      .all(num(studentId)).map(toHourLog);
  },
  /** 课时台账：导出和报表用 */
  async list({ from, to, studentIds, limit = 5000 }) {
    const where = ['1=1'], args = [];
    if (from) { where.push('l.date >= ?'); args.push(from); }
    if (to) { where.push('l.date <= ?'); args.push(to); }
    if (studentIds) {
      if (!studentIds.length) return [];
      where.push(`l.student_id IN (${marks(studentIds)})`); args.push(...studentIds.map(num));
    }
    return q(`SELECT l.*, u.name AS student_name, t.name AS by_name FROM hour_logs l
              JOIN users u ON u.id=l.student_id LEFT JOIN users t ON t.id=l.created_by
              WHERE ${where.join(' AND ')} ORDER BY l.id DESC LIMIT ${num(limit)}`)
      .all(...args).map((r) => ({ ...toHourLog(r), studentName: r.student_name, byName: r.by_name || '' }));
  },
  /** 按月统计消耗的课时 */
  async monthlyUsed(from, to) {
    return q(`SELECT substr(date,1,7) m, COALESCE(SUM(-hours),0) hours FROM hour_logs
              WHERE hours < 0 AND date >= ? AND date <= ? GROUP BY m ORDER BY m`).all(from, to);
  },
};

const attendance = {
  async byId(id) { return toAttendance(q('SELECT * FROM attendance WHERE id=?').get(num(id))); },
  async byClassDate(classId, date) {
    return q('SELECT * FROM attendance WHERE class_id=? AND date=?').all(num(classId), date).map(toAttendance);
  },
  async byStudent(studentId, limit = 30) {
    return q(`SELECT a.*, c.name AS class_name FROM attendance a LEFT JOIN classes c ON c.id=a.class_id
              WHERE a.student_id=? ORDER BY a.date DESC, a.id DESC LIMIT ${num(limit)}`)
      .all(num(studentId)).map((r) => ({ ...toAttendance(r), className: r.class_name || '' }));
  },
  /** 考勤明细：导出、月度网格用 */
  async list({ from, to, classIds, limit = 5000 }) {
    const where = ['1=1'], args = [];
    if (from) { where.push('a.date >= ?'); args.push(from); }
    if (to) { where.push('a.date <= ?'); args.push(to); }
    if (classIds) {
      if (!classIds.length) return [];
      where.push(`a.class_id IN (${marks(classIds)})`); args.push(...classIds.map(num));
    }
    return q(`SELECT a.*, u.name AS student_name, c.name AS class_name FROM attendance a
              JOIN users u ON u.id=a.student_id LEFT JOIN classes c ON c.id=a.class_id
              WHERE ${where.join(' AND ')} ORDER BY a.date DESC, a.id DESC LIMIT ${num(limit)}`)
      .all(...args).map((r) => ({ ...toAttendance(r), studentName: r.student_name, className: r.class_name || '' }));
  },
  async monthlyCount(from, to) {
    return q(`SELECT substr(date,1,7) m, COUNT(*) n, SUM(CASE WHEN status='present' THEN 1 ELSE 0 END) present
              FROM attendance WHERE date >= ? AND date <= ? GROUP BY m ORDER BY m`).all(from, to);
  },
  async datesOfClass(classId, limit = 20) {
    return q(`SELECT date, COUNT(*) n FROM attendance WHERE class_id=? GROUP BY date ORDER BY date DESC LIMIT ${num(limit)}`)
      .all(num(classId));
  },
  /** 这些班里，哪些今天已经点过名 */
  async markedClassIds(date, classIds) {
    if (!classIds.length) return new Set();
    return new Set(q(`SELECT DISTINCT class_id FROM attendance WHERE date=? AND class_id IN (${marks(classIds)})`)
      .all(date, ...classIds.map(num)).map((r) => r.class_id));
  },
  async countSince(date) { return count('SELECT COUNT(*) n FROM attendance WHERE date >= ?', date); },
  async remove(id) { q('DELETE FROM attendance WHERE id=?').run(num(id)); },
  async upsert(x) {
    const cur = q('SELECT * FROM attendance WHERE class_id=? AND student_id=? AND date=?')
      .get(num(x.classId), num(x.studentId), x.date);
    if (cur) {
      q('UPDATE attendance SET status=?, hours=?, package_id=?, note=?, created_by=?, created_at=? WHERE id=?')
        .run(x.status, Number(x.hours) || 0, x.packageId ? num(x.packageId) : null, x.note || '',
          x.createdBy ? num(x.createdBy) : null, now(), cur.id);
      return attendance.byId(cur.id);
    }
    const r = q(`INSERT INTO attendance (class_id, student_id, date, status, hours, package_id, note, created_by, created_at)
                 VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(num(x.classId), num(x.studentId), x.date, x.status, Number(x.hours) || 0,
        x.packageId ? num(x.packageId) : null, x.note || '', x.createdBy ? num(x.createdBy) : null, now());
    return attendance.byId(Number(r.lastInsertRowid));
  },
};

const leaves = {
  async byId(id) { return toLeave(q('SELECT * FROM leaves WHERE id=?').get(num(id))); },
  async create(x) {
    const r = q('INSERT INTO leaves (student_id, class_id, date, reason, status, created_at) VALUES (?,?,?,?,\'pending\',?)')
      .run(num(x.studentId), x.classId ? num(x.classId) : null, x.date, x.reason || '', now());
    return leaves.byId(Number(r.lastInsertRowid));
  },
  async byStudent(studentId, limit = 20) {
    return q(`SELECT * FROM leaves WHERE student_id=? ORDER BY id DESC LIMIT ${num(limit)}`).all(num(studentId)).map(toLeave);
  },
  async approvedOn(classId, date) {
    return q(`SELECT student_id FROM leaves WHERE date=? AND status='approved' AND (class_id=? OR class_id IS NULL)`)
      .all(date, num(classId)).map((r) => r.student_id);
  },
  async list(status, studentIds, limit = 100) {
    const where = [];
    const args = [];
    if (status) { where.push('l.status=?'); args.push(status); }
    if (studentIds) {
      if (!studentIds.length) return [];
      where.push(`l.student_id IN (${marks(studentIds)})`);
      args.push(...studentIds.map(num));
    }
    const sql = `SELECT l.*, u.name AS student_name, c.name AS class_name FROM leaves l
                 JOIN users u ON u.id=l.student_id LEFT JOIN classes c ON c.id=l.class_id
                 ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY l.id DESC LIMIT ${num(limit)}`;
    return q(sql).all(...args).map((r) => ({ ...toLeave(r), studentName: r.student_name, className: r.class_name || '' }));
  },
  async setStatus(id, status, handledBy) {
    q('UPDATE leaves SET status=?, handled_by=?, handled_at=? WHERE id=?').run(status, num(handledBy), now(), num(id));
  },
  async countPending(studentIds) {
    if (studentIds && !studentIds.length) return 0;
    return studentIds
      ? count(`SELECT COUNT(*) n FROM leaves WHERE status='pending' AND student_id IN (${marks(studentIds)})`, ...studentIds.map(num))
      : count(`SELECT COUNT(*) n FROM leaves WHERE status='pending'`);
  },
};

const settings = {
  async get(key, dflt = null) {
    const r = q('SELECT value FROM settings WHERE key=?').get(key);
    return r ? parseJSON(r.value, dflt) : dflt;
  },
  async set(key, value) {
    q(`INSERT INTO settings (key, value, updated_at) VALUES (?,?,?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
      .run(key, JSON.stringify(value), now());
    return value;
  },
};

const toReward = (r) => r && ({ id: r.id, name: r.name, stars: r.stars, imageId: r.image_id,
  note: r.note || '', sort: r.sort, active: !!r.active, createdAt: r.created_at });
const toRedemption = (r) => r && ({ id: r.id, rewardId: r.reward_id, studentId: r.student_id,
  rewardName: r.reward_name, stars: r.stars, status: r.status, createdAt: r.created_at, doneAt: r.done_at });

const rewards = {
  async all() { return q('SELECT * FROM rewards ORDER BY sort, stars, id').all().map(toReward); },
  async listActive() { return q('SELECT * FROM rewards WHERE active=1 ORDER BY sort, stars, id').all().map(toReward); },
  async byId(id) { return toReward(q('SELECT * FROM rewards WHERE id=?').get(num(id))); },
  async create({ name, stars, imageId, note, sort }) {
    const r = q('INSERT INTO rewards (name, stars, image_id, note, sort, active, created_at) VALUES (?,?,?,?,?,1,?)')
      .run(name, num(stars), imageId ? num(imageId) : null, note || '', num(sort) || 0, now());
    return rewards.byId(Number(r.lastInsertRowid));
  },
  async update(id, { name, stars, note, active, imageId }) {
    const cur = q('SELECT * FROM rewards WHERE id=?').get(num(id));
    if (!cur) return null;
    q('UPDATE rewards SET name=?, stars=?, note=?, active=?, image_id=? WHERE id=?').run(
      name == null ? cur.name : name,
      stars == null ? cur.stars : num(stars),
      note == null ? cur.note : note,
      active == null ? cur.active : (active ? 1 : 0),
      imageId === undefined ? cur.image_id : (imageId ? num(imageId) : null),
      num(id));
    return rewards.byId(id);
  },
  async remove(id) { q('DELETE FROM rewards WHERE id=?').run(num(id)); },
  async countRedemptions(id) { return count('SELECT COUNT(*) n FROM redemptions WHERE reward_id=?', num(id)); },
};

const redemptions = {
  async byId(id) { return toRedemption(q('SELECT * FROM redemptions WHERE id=?').get(num(id))); },
  async create({ rewardId, studentId, rewardName, stars }) {
    const r = q(`INSERT INTO redemptions (reward_id, student_id, reward_name, stars, status, created_at)
                 VALUES (?,?,?,?,'pending',?)`).run(num(rewardId), num(studentId), rewardName, num(stars), now());
    return redemptions.byId(Number(r.lastInsertRowid));
  },
  async byStudent(studentId, limit = 20) {
    return q(`SELECT * FROM redemptions WHERE student_id=? ORDER BY id DESC LIMIT ${num(limit)}`)
      .all(num(studentId)).map(toRedemption);
  },
  async list(status, limit = 100) {
    const rows = status
      ? q(`SELECT r.*, u.name AS student_name FROM redemptions r JOIN users u ON u.id=r.student_id
           WHERE r.status=? ORDER BY r.id DESC LIMIT ${num(limit)}`).all(status)
      : q(`SELECT r.*, u.name AS student_name FROM redemptions r JOIN users u ON u.id=r.student_id
           ORDER BY r.id DESC LIMIT ${num(limit)}`).all();
    return rows.map((r) => ({ ...toRedemption(r), studentName: r.student_name }));
  },
  async countPending() { return count(`SELECT COUNT(*) n FROM redemptions WHERE status='pending'`); },
  async setStatus(id, status) {
    q('UPDATE redemptions SET status=?, done_at=? WHERE id=?').run(status, now(), num(id));
  },
};

const courses = {
  async all() { return q('SELECT * FROM courses WHERE active=1 ORDER BY subject_id, sort, id').all().map(toCourse); },
  async bySubject(subjectId) {
    return q('SELECT * FROM courses WHERE subject_id=? AND active=1 ORDER BY sort, id').all(num(subjectId)).map(toCourse);
  },
  async byId(id) { return toCourse(q('SELECT * FROM courses WHERE id=?').get(num(id))); },
  async create({ subjectId, name, sort }) {
    const r = q('INSERT INTO courses (subject_id, name, sort) VALUES (?,?,?)').run(num(subjectId), name, num(sort) || 0);
    return courses.byId(Number(r.lastInsertRowid));
  },
  async update(id, { name, sort, active, isPublic }) {
    const cur = q('SELECT * FROM courses WHERE id=?').get(num(id));
    if (!cur) return null;
    q('UPDATE courses SET name=?, sort=?, active=?, public=? WHERE id=?')
      .run(name == null ? cur.name : name, sort == null ? cur.sort : num(sort),
        active == null ? cur.active : (active ? 1 : 0),
        isPublic == null ? cur.public : (isPublic ? 1 : 0), num(id));
    return courses.byId(id);
  },
  async publicList() {
    return q('SELECT * FROM courses WHERE active=1 AND public=1 ORDER BY subject_id, sort, id').all().map(toCourse);
  },
  async remove(id) { q('DELETE FROM courses WHERE id=?').run(num(id)); },
  async usage(id) {
    return {
      classes: count('SELECT COUNT(*) n FROM classes WHERE course_id=?', num(id)),
      packages: count('SELECT COUNT(*) n FROM packages WHERE course_id=?', num(id)),
    };
  },
  async byName(subjectId, name) {
    return toCourse(q('SELECT * FROM courses WHERE subject_id=? AND name=?').get(num(subjectId), name));
  },
};

const subjects = {
  async all() { return q('SELECT * FROM subjects ORDER BY sort, id').all().map(toSubject); },
  async byId(id) { return toSubject(q('SELECT * FROM subjects WHERE id=?').get(num(id))); },
  async byCode(code) { return toSubject(q('SELECT * FROM subjects WHERE code=?').get(code)); },
  async idsForTeacher(userId) {
    return q('SELECT subject_id AS id FROM teacher_subjects WHERE user_id=?').all(num(userId)).map((r) => r.id);
  },
  /** 一次取多位老师教的科目：userId -> [subjectId] */
  async byTeachers(userIds) {
    const out = new Map();
    if (!userIds.length) return out;
    for (const r of q(`SELECT * FROM teacher_subjects WHERE user_id IN (${marks(userIds)})`).all(...userIds.map(num))) {
      const arr = out.get(r.user_id) || out.set(r.user_id, []).get(r.user_id);
      arr.push(r.subject_id);
    }
    return out;
  },
  async setForTeacher(userId, ids) {
    q('DELETE FROM teacher_subjects WHERE user_id=?').run(num(userId));
    const ins = q('INSERT OR IGNORE INTO teacher_subjects (user_id, subject_id) VALUES (?,?)');
    for (const id of ids) ins.run(num(userId), num(id));
  },
};

/* ---------- 题目与作答 ---------- */
const questions = {
  /** 多份作业的题目数：homeworkId -> 题数 */
  async countsByHomeworks(homeworkIds) {
    if (!homeworkIds.length) return new Map();
    return mapBy(q(`SELECT homework_id, COUNT(*) n FROM questions WHERE homework_id IN (${marks(homeworkIds)}) GROUP BY homework_id`)
      .all(...homeworkIds.map(num)), 'homework_id', (r) => r.n);
  },
  async byHomework(homeworkId) {
    return q('SELECT * FROM questions WHERE homework_id=? ORDER BY sort, id').all(num(homeworkId)).map(toQuestion);
  },
};

const answers = {
  async bySubmission(submissionId) {
    return q('SELECT * FROM answers WHERE submission_id=?').all(num(submissionId)).map(toAnswer);
  },
  /** 多份提交的作答：submissionId -> 作答数组（老师批改页一次取全班） */
  async bySubmissions(ids) {
    if (!ids.length) return new Map();
    const out = new Map();
    for (const r of q(`SELECT * FROM answers WHERE submission_id IN (${marks(ids)})`).all(...ids.map(num))) {
      const list = out.get(r.submission_id) || out.set(r.submission_id, []).get(r.submission_id);
      list.push(toAnswer(r));
    }
    return out;
  },
  async byId(id) { return toAnswer(q('SELECT * FROM answers WHERE id=?').get(num(id))); },
  /** 整份重交：清掉旧作答再写入 */
  async replaceAll(submissionId, list) {
    db.exec('BEGIN');
    try {
      q('DELETE FROM answers WHERE submission_id=?').run(num(submissionId));
      const ins = q(`INSERT INTO answers (submission_id, question_id, value, asset_ids, auto_correct, score, comment)
                     VALUES (?,?,?,?,?,?,?)`);
      for (const a of list) {
        ins.run(num(submissionId), num(a.questionId), JSON.stringify(a.value === undefined ? null : a.value),
          JSON.stringify(a.assetIds || []), a.autoCorrect == null ? null : (a.autoCorrect ? 1 : 0),
          a.score == null ? null : Number(a.score), a.comment || '');
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  },
  async setManual(id, { score, comment }) {
    q('UPDATE answers SET score=?, comment=? WHERE id=?').run(score == null ? null : Number(score), comment || '', num(id));
  },
};

/* ---------- 分享与咨询 ---------- */
const shares = {
  async byToken(token) { return toShare(q('SELECT * FROM shares WHERE token=?').get(String(token))); },
  async byId(id) { return toShare(q('SELECT * FROM shares WHERE id=?').get(num(id))); },
  async byStudent(studentId) {
    return q('SELECT * FROM shares WHERE student_id=? ORDER BY id DESC').all(num(studentId)).map(toShare);
  },
  async create(x) {
    const r = q(`INSERT INTO shares (token, type, student_id, submission_id, subject_id, title, image_path, photo_ids,
                 comment, stars, show_full_name, status, views, created_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,'active',0,?)`)
      .run(x.token, x.type, num(x.studentId), x.submissionId ? num(x.submissionId) : null, x.subjectId ? num(x.subjectId) : null,
        x.title || '', x.imagePath || '', JSON.stringify(x.photoIds || []), x.comment || '',
        x.stars == null ? null : num(x.stars), x.showFullName ? 1 : 0, now());
    return shares.byId(Number(r.lastInsertRowid));
  },
  async revoke(id) { q(`UPDATE shares SET status='revoked', revoked_at=? WHERE id=?`).run(now(), num(id)); },
  /** 同一访客只计一次浏览 */
  /** 还在分享中的作品图 —— 这些资产不能跟着重交被删掉 */
  async activeAssetIds() {
    const out = new Set();
    for (const r of q("SELECT photo_ids FROM shares WHERE status='active'").all()) {
      for (const id of parseJSON(r.photo_ids, [])) out.add(Number(id));
    }
    return out;
  },
  async addView(shareId, visitor) {
    const r = q('INSERT OR IGNORE INTO share_views (share_id, visitor, first_at) VALUES (?,?,?)').run(num(shareId), visitor, now());
    if (r.changes) q('UPDATE shares SET views=views+1 WHERE id=?').run(num(shareId));
  },
  /** 作品展：书法作品里仍在分享中的 */
  async galleryRows(subjectId, limit = 60) {
    return q(`SELECT s.* FROM shares s JOIN submissions su ON su.id=s.submission_id
              WHERE s.status='active' AND s.subject_id=? AND su.excellent=1
              ORDER BY s.id DESC LIMIT ${num(limit)}`).all(num(subjectId)).map(toShare);
  },
  async gallery(subjectId, limit = 60) {
    return q(`SELECT * FROM shares WHERE status='active' AND type='work' AND subject_id=? ORDER BY id DESC LIMIT ${num(limit)}`)
      .all(num(subjectId)).map(toShare);
  },
  async stats(sinceDate) {
    const row = q(`SELECT COUNT(*) n, COALESCE(SUM(views),0) v FROM shares WHERE created_at >= ?`).get(sinceDate);
    const active = count(`SELECT COUNT(*) n FROM shares WHERE status='active'`);
    const top = q(`SELECT s.student_id AS studentId, u.name, COUNT(*) AS shares, SUM(s.views) AS views
                   FROM shares s JOIN users u ON u.id=s.student_id GROUP BY s.student_id ORDER BY views DESC, shares DESC LIMIT 5`).all();
    return { recentShares: row.n, recentViews: row.v, activeShares: active, top };
  },
};

const leads = {
  async create(x) {
    const r = q(`INSERT INTO leads (share_id, ref_student_id, source, phone, grade, subjects, courses, contact_time, message, status, ip, created_at)
                 VALUES (?,?,?,?,?,?,?,?,?,'new',?,?)`)
      .run(x.shareId ? num(x.shareId) : null, x.refStudentId ? num(x.refStudentId) : null, x.source,
        x.phone, x.grade || '', JSON.stringify(x.subjects || []), JSON.stringify(x.courses || []),
        x.contactTime || '', x.message || '', x.ip || '', now());
    return Number(r.lastInsertRowid);
  },
  async list(limit = 200) {
    return q(`SELECT l.*, u.name AS ref_name FROM leads l LEFT JOIN users u ON u.id=l.ref_student_id
              ORDER BY l.id DESC LIMIT ${num(limit)}`).all().map((r) => ({ ...toLead(r), refName: r.ref_name || '' }));
  },
  async update(id, { status, note, followAt, trialAt, lastContactAt }) {
    q(`UPDATE leads SET status=COALESCE(?, status), note=COALESCE(?, note),
         follow_at=COALESCE(?, follow_at), trial_at=COALESCE(?, trial_at), last_contact_at=COALESCE(?, last_contact_at)
       WHERE id=?`)
      .run(status || null, note == null ? null : String(note),
        followAt == null ? null : String(followAt), trialAt == null ? null : String(trialAt),
        lastContactAt == null ? null : String(lastContactAt), num(id));
  },
  /** 漏斗统计：某段时间内的咨询、试听、报名 */
  async funnel(since) {
    const r = q(`SELECT COUNT(*) total,
                   SUM(CASE WHEN status!='new' AND status!='invalid' THEN 1 ELSE 0 END) worked,
                   SUM(CASE WHEN trial_at IS NOT NULL AND trial_at!='' THEN 1 ELSE 0 END) trials,
                   SUM(CASE WHEN status='enrolled' THEN 1 ELSE 0 END) enrolled
                 FROM leads WHERE created_at >= ?`).get(since);
    return { total: r.total || 0, worked: r.worked || 0, trials: r.trials || 0, enrolled: r.enrolled || 0 };
  },
  async countSince(sinceDate) { return count('SELECT COUNT(*) n FROM leads WHERE created_at >= ?', sinceDate); },
  async countNew() { return count(`SELECT COUNT(*) n FROM leads WHERE status='new'`); },
  async remove(id) { q('DELETE FROM leads WHERE id=?').run(num(id)); },
  async recentByPhone(phone, sinceTime) { return count('SELECT COUNT(*) n FROM leads WHERE phone=? AND created_at >= ?', phone, sinceTime); },
};

/** 日常维护：合并 WAL、更新统计信息、清理过期登录 */
async function maintain(keepDays = 120) {
  const before = new Date(Date.now() - keepDays * 86400000).toISOString().replace('T', ' ').slice(0, 19);
  const gone = await sessions.pruneBefore(before);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.exec('PRAGMA optimize');
  return { prunedSessions: gone };
}

module.exports = {
  maintain,
  users, sessions, classes, books, lessons, pages, hotspots, assets, courses, rewards, redemptions,
  profiles, packages, hourLogs, attendance, leaves, settings,
  homeworks, submissions, submissionItems, checkins,
  subjects, questions, answers, shares, leads,
};
