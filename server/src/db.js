'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '../..');          // mvp/
const DATA_DIR = path.join(ROOT, 'data');
const CONTENT_DIR = path.join(ROOT, 'content');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(CONTENT_DIR, 'pages'), { recursive: true });
fs.mkdirSync(path.join(CONTENT_DIR, 'audio'), { recursive: true });
fs.mkdirSync(path.join(CONTENT_DIR, 'rec'), { recursive: true });
fs.mkdirSync(path.join(CONTENT_DIR, 'posters'), { recursive: true });
fs.mkdirSync(path.join(CONTENT_DIR, 'shares'), { recursive: true });
fs.mkdirSync(path.join(CONTENT_DIR, 'photos'), { recursive: true });
fs.mkdirSync(path.join(CONTENT_DIR, 'stems'), { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
// WAL 下 NORMAL 已经能保证掉电不坏库（最多丢最后一两次写），写入比 FULL 快很多
db.exec('PRAGMA synchronous = NORMAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  openid TEXT UNIQUE,
  role TEXT NOT NULL,                -- student | teacher | admin
  name TEXT NOT NULL,
  avatar TEXT,
  stars INTEGER DEFAULT 0,
  streak INTEGER DEFAULT 0,
  last_checkin TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS classes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  invite_code TEXT UNIQUE NOT NULL,
  teacher_id INTEGER REFERENCES users(id),
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS class_members (
  class_id INTEGER NOT NULL REFERENCES classes(id),
  student_id INTEGER NOT NULL REFERENCES users(id),
  joined_at TEXT,
  PRIMARY KEY (class_id, student_id)
);

CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                -- audio | image | rec
  rel_path TEXT NOT NULL,            -- 相对 content/ 的路径
  mime TEXT,
  duration_ms INTEGER DEFAULT 0,
  size_bytes INTEGER DEFAULT 0,
  is_placeholder INTEGER DEFAULT 0,  -- 1=占位音（前端可用 TTS 兜底试听）
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS books (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  subtitle TEXT,
  grade TEXT,
  cover TEXT,
  sort INTEGER DEFAULT 0,
  status INTEGER DEFAULT 1,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES books(id),
  title TEXT NOT NULL,
  audio_id INTEGER REFERENCES assets(id),   -- 一课一音频
  sort INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lesson_id INTEGER NOT NULL REFERENCES lessons(id),
  page_no INTEGER,
  img_id INTEGER REFERENCES assets(id),
  img_w INTEGER, img_h INTEGER,
  sort INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS hotspots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  audio_id INTEGER REFERENCES assets(id),
  x REAL, y REAL, w REAL, h REAL,           -- 归一化 0~1
  start_ms INTEGER DEFAULT 0,
  end_ms INTEGER DEFAULT 0,
  text_en TEXT, text_cn TEXT,
  type TEXT DEFAULT 'sentence',
  sort INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS book_grants (
  book_id INTEGER NOT NULL REFERENCES books(id),
  class_id INTEGER NOT NULL REFERENCES classes(id),
  PRIMARY KEY (book_id, class_id)
);

CREATE TABLE IF NOT EXISTS homeworks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes(id),
  teacher_id INTEGER REFERENCES users(id),
  title TEXT NOT NULL,
  type TEXT DEFAULT 'follow_read',
  book_id INTEGER, page_id INTEGER,
  hotspot_ids TEXT,                          -- JSON 数组
  note TEXT,
  deadline TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  homework_id INTEGER NOT NULL REFERENCES homeworks(id),
  student_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT DEFAULT 'submitted',           -- submitted | reviewed | rejected
  submitted_at TEXT,
  elapsed_sec INTEGER DEFAULT 0,
  stars INTEGER,
  review_text TEXT,
  reviewed_at TEXT,
  UNIQUE (homework_id, student_id)
);

CREATE TABLE IF NOT EXISTS submission_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  hotspot_id INTEGER REFERENCES hotspots(id),
  asset_id INTEGER REFERENCES assets(id),
  duration_ms INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS checkins (
  student_id INTEGER NOT NULL REFERENCES users(id),
  date TEXT NOT NULL,
  seconds INTEGER DEFAULT 0,
  stars INTEGER DEFAULT 0,
  PRIMARY KEY (student_id, date)
);

CREATE INDEX IF NOT EXISTS idx_hotspot_page ON hotspots(page_id, sort);
CREATE INDEX IF NOT EXISTS idx_page_lesson ON pages(lesson_id, sort);
CREATE INDEX IF NOT EXISTS idx_hw_class ON homeworks(class_id, created_at);
`);

/* ---------- 多科目作业与宣传（在线上已有数据的库上增量升级） ---------- */
db.exec(`
CREATE TABLE IF NOT EXISTS subjects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,         -- en | zh | math | calli
  name TEXT NOT NULL,
  color TEXT,                        -- 前端配色键：sky | coral | mint | star
  sort INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS teacher_subjects (
  user_id INTEGER NOT NULL REFERENCES users(id),
  subject_id INTEGER NOT NULL REFERENCES subjects(id),
  PRIMARY KEY (user_id, subject_id)
);

-- 题目作业里的题：single 单选 | multi 多选 | judge 判断 | blank 填空（自动评分）
--                photo 拍照 | text 文字 | audio 录音（老师批改）
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  homework_id INTEGER NOT NULL REFERENCES homeworks(id) ON DELETE CASCADE,
  sort INTEGER DEFAULT 0,
  type TEXT NOT NULL,
  stem TEXT,
  stem_image_id INTEGER REFERENCES assets(id),
  options TEXT,                      -- JSON：选项文字数组
  answer TEXT,                       -- JSON：标准答案（学生提交前不下发）
  score REAL DEFAULT 1,
  analysis TEXT
);

CREATE TABLE IF NOT EXISTS answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  value TEXT,                        -- JSON：学生作答
  asset_ids TEXT,                    -- JSON：照片/录音资产
  auto_correct INTEGER,              -- 1 对 / 0 错 / NULL 需老师批改
  score REAL,
  comment TEXT,
  UNIQUE (submission_id, question_id)
);

-- 分享：喜报 praise | 作品 work
CREATE TABLE IF NOT EXISTS shares (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT UNIQUE NOT NULL,
  type TEXT NOT NULL,
  student_id INTEGER NOT NULL REFERENCES users(id),
  submission_id INTEGER REFERENCES submissions(id) ON DELETE SET NULL,
  subject_id INTEGER REFERENCES subjects(id),
  title TEXT,
  image_path TEXT,                   -- 分享卡片与页面主图（相对 content/）
  photo_ids TEXT,                    -- JSON：作品原图资产
  comment TEXT,
  stars INTEGER,
  show_full_name INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active',      -- active | revoked
  views INTEGER DEFAULT 0,
  created_at TEXT,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS share_views (
  share_id INTEGER NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  visitor TEXT NOT NULL,
  first_at TEXT,
  PRIMARY KEY (share_id, visitor)
);

CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  share_id INTEGER REFERENCES shares(id) ON DELETE SET NULL,
  ref_student_id INTEGER REFERENCES users(id),
  source TEXT,                       -- share | gallery | trial
  phone TEXT NOT NULL,
  grade TEXT,
  subjects TEXT,                     -- JSON
  contact_time TEXT,
  status TEXT DEFAULT 'new',         -- new | contacted | enrolled | invalid
  note TEXT,
  ip TEXT,
  created_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_q_hw ON questions(homework_id, sort);
CREATE INDEX IF NOT EXISTS idx_share_student ON shares(student_id, created_at);
CREATE INDEX IF NOT EXISTS idx_leads_created ON leads(created_at);
-- 下面这些是按外键查的高频路径：学生查自己的班、自己的提交，老师批改时按提交查作答
CREATE INDEX IF NOT EXISTS idx_member_student ON class_members(student_id);
CREATE INDEX IF NOT EXISTS idx_sub_student ON submissions(student_id);
CREATE INDEX IF NOT EXISTS idx_subitem_sub ON submission_items(submission_id);
CREATE INDEX IF NOT EXISTS idx_answer_sub ON answers(submission_id);
CREATE INDEX IF NOT EXISTS idx_class_teacher ON classes(teacher_id);
CREATE INDEX IF NOT EXISTS idx_share_status ON shares(status, subject_id);
`);

/** 已有表加列：线上库已有数据，不能重建表 */
function addColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}
addColumn('homeworks', 'subject_id', 'INTEGER REFERENCES subjects(id)');
addColumn('homeworks', 'kind', "TEXT DEFAULT 'follow_read'");   // follow_read 课本跟读 | questions 题目作业
addColumn('submissions', 'score', 'REAL');
addColumn('submissions', 'max_score', 'REAL');
addColumn('submissions', 'excellent', 'INTEGER DEFAULT 0');
// 作业班的评分栏：书写、坐姿、学习态度、作业时长、作业效率、其他，存成 JSON
addColumn('submissions', 'rubric', 'TEXT');

const SUBJECTS = [['en', '英语', 'sky', 1], ['zh', '语文', 'coral', 2], ['math', '数学', 'mint', 3],
  ['calli', '书法', 'star', 4], ['hwclass', '作业班', 'ink', 5]];
const insSubject = db.prepare('INSERT OR IGNORE INTO subjects (code, name, color, sort) VALUES (?,?,?,?)');
for (const row of SUBJECTS) insSubject.run(...row);

/* 科目下面的具体课程：家长预约时选到这一层，老师才知道该安排哪位老师试听 */
db.exec(`
CREATE TABLE IF NOT EXISTS courses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id INTEGER NOT NULL REFERENCES subjects(id),
  name TEXT NOT NULL,
  sort INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1,
  UNIQUE (subject_id, name)
);
CREATE INDEX IF NOT EXISTS idx_course_subject ON courses(subject_id, sort);
`);
const COURSES = {
  en: ['小学英语', '初中英语', '新概念英语', '启蒙英语', '自然拼读', '国际音标'],
  math: ['小学数学', '初中精品数学', '奥数思维'],
  zh: ['小学语文', '阅读写作', '好书共读', '走进小古文', '绘本学语文'],
  calli: ['小学硬笔书法', '小学书法考级'],
  hwclass: ['小学精品作业班'],
};
const insCourse = db.prepare('INSERT OR IGNORE INTO courses (subject_id, name, sort) VALUES (?,?,?)');
const subjIdOf = db.prepare('SELECT id FROM subjects WHERE code=?');
for (const [code, list] of Object.entries(COURSES)) {
  const sid = subjIdOf.get(code);
  if (sid) list.forEach((name, i) => insCourse.run(sid.id, name, i + 1));
}

/* ================= 教务档案：学员档案、课时包、考勤、请假 =================
 * 课时是钱，所有增减都要留痕：packages 记总量，hour_logs 记每一笔，
 * attendance 记每次点名，三者对得上账，家长来问能一条条摆出来。
 */
db.exec(`
CREATE TABLE IF NOT EXISTS student_profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  gender TEXT,                       -- 男 | 女 | ''
  school TEXT,                       -- 就读学校
  grade TEXT,                        -- 年级
  parent_name TEXT,
  phone TEXT,
  phone2 TEXT,
  note TEXT,                         -- 其他
  status TEXT DEFAULT 'active',      -- active 在读 | paused 停课 | left 已结业
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS packages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES users(id),
  subject_id INTEGER REFERENCES subjects(id),
  course_id INTEGER REFERENCES courses(id),
  total_hours REAL DEFAULT 0,        -- 购买课时
  gift_hours REAL DEFAULT 0,         -- 赠送课时
  used_hours REAL DEFAULT 0,         -- 已消耗（由流水累计）
  price_original INTEGER DEFAULT 0,  -- 原价，单位：分
  price_paid INTEGER DEFAULT 0,      -- 实收，单位：分
  purchased_at TEXT,                 -- 购买日期
  expires_at TEXT,                   -- 到期日期
  paused_at TEXT,                    -- 停课起始日（恢复时按天数顺延到期日）
  status TEXT DEFAULT 'active',      -- active | paused | finished
  note TEXT,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_package_student ON packages(student_id, status);

CREATE TABLE IF NOT EXISTS hour_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  package_id INTEGER REFERENCES packages(id),
  student_id INTEGER NOT NULL REFERENCES users(id),
  hours REAL NOT NULL,               -- 负数是扣课时，正数是补回或赠送
  reason TEXT,                       -- attend 上课 | absent 旷课 | adjust 手工调整 | revert 撤销
  ref_id INTEGER,                    -- 对应的考勤记录
  date TEXT,
  note TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_hourlog_student ON hour_logs(student_id, id);
CREATE INDEX IF NOT EXISTS idx_hourlog_package ON hour_logs(package_id, id);

CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes(id),
  student_id INTEGER NOT NULL REFERENCES users(id),
  date TEXT NOT NULL,
  status TEXT NOT NULL,              -- present 到课 | leave 请假 | absent 旷课
  hours REAL DEFAULT 0,              -- 本次扣掉的课时
  package_id INTEGER REFERENCES packages(id),
  note TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT,
  UNIQUE (class_id, student_id, date)
);
CREATE INDEX IF NOT EXISTS idx_attend_class_date ON attendance(class_id, date);
CREATE INDEX IF NOT EXISTS idx_attend_student ON attendance(student_id, date);

CREATE TABLE IF NOT EXISTS leaves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES users(id),
  class_id INTEGER REFERENCES classes(id),
  date TEXT NOT NULL,
  reason TEXT,
  status TEXT DEFAULT 'pending',     -- pending 待审 | approved 已批准 | rejected 未批准
  handled_by INTEGER REFERENCES users(id),
  created_at TEXT,
  handled_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_leave_status ON leaves(status, id);
CREATE INDEX IF NOT EXISTS idx_leave_student ON leaves(student_id, date);

/* 学校简介等后台可编辑的内容 */
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT
);
`);

/* 星星奖品：攒够星星换实物礼物，老师在后台发放 */
db.exec(`
CREATE TABLE IF NOT EXISTS rewards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  stars INTEGER NOT NULL,
  image_id INTEGER REFERENCES assets(id),
  note TEXT,
  sort INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS redemptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reward_id INTEGER REFERENCES rewards(id),
  student_id INTEGER NOT NULL REFERENCES users(id),
  reward_name TEXT,                  -- 兑换当时的名字和星数，奖品以后改了也不影响记录
  stars INTEGER,
  status TEXT DEFAULT 'pending',     -- pending 待领取 | done 已发放 | canceled 已取消（星星退回）
  created_at TEXT,
  done_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_redemption_status ON redemptions(status, id);
CREATE INDEX IF NOT EXISTS idx_redemption_student ON redemptions(student_id, id);
`);

// 跟进用：下次跟进日期、约好的试听日期、最近一次联系时间
addColumn('courses', 'public', 'INTEGER DEFAULT 0');   // 是否显示在家长预约页上
// 预约页先只放英语这几门，其余以后按需打开
const pubCourses = ['小学英语', '初中英语', '新概念英语', '启蒙英语'];
if (!db.prepare("SELECT 1 x FROM courses WHERE public=1 LIMIT 1").get()) {
  const up = db.prepare('UPDATE courses SET public=1 WHERE name=?');
  for (const n of pubCourses) up.run(n);
}

addColumn('leads', 'follow_at', 'TEXT');
addColumn('leads', 'trial_at', 'TEXT');
addColumn('leads', 'last_contact_at', 'TEXT');

// 家长在预约表单里写的话（和老师自己的跟进备注 note 分开存）
addColumn('leads', 'message', 'TEXT');
addColumn('leads', 'courses', 'TEXT');           // JSON：具体想上的课程
// 升级前的作业都是英语课本跟读
const en = db.prepare("SELECT id FROM subjects WHERE code='en'").get();
db.prepare('UPDATE homeworks SET subject_id=? WHERE subject_id IS NULL').run(en.id);
db.prepare("UPDATE homeworks SET kind='follow_read' WHERE kind IS NULL").run();

// 培训机构按科目开班、同一科目按年级段分班：班级带上科目和年级段
// 每位老师一个自己的口令（存哈希），由负责人在后台生成；停用后不能再登录
addColumn('users', 'login_code', 'TEXT');
addColumn('users', 'active', 'INTEGER DEFAULT 1');
// 口令的可还原副本（用主口令派生的密钥加密），负责人忘了可以查回来；验证仍然用哈希
addColumn('users', 'login_code_enc', 'TEXT');
// 升级前只有"老师"一种身份：把最早的那个老师升为负责人，由他来给其他老师建账号
if (!db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get()) {
  const first = db.prepare("SELECT id FROM users WHERE role='teacher' ORDER BY id LIMIT 1").get();
  if (first) db.prepare("UPDATE users SET role='admin' WHERE id=?").run(first.id);
}

addColumn('classes', 'subject_id', 'INTEGER REFERENCES subjects(id)');
addColumn('classes', 'grade_band', "TEXT DEFAULT ''");
addColumn('classes', 'schedule', 'TEXT');                    // 上课排期 JSON：{days:[6],start:'10:00',end:'11:30'}
addColumn('classes', 'course_id', 'INTEGER REFERENCES courses(id)');   // 具体课程，比如「新概念英语」
db.prepare('UPDATE classes SET subject_id=? WHERE subject_id IS NULL').run(en.id);   // 升级前的班都是英语班


module.exports = { db, ROOT, DATA_DIR, CONTENT_DIR };
