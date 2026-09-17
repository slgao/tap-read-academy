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

const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

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

module.exports = { db, ROOT, DATA_DIR, CONTENT_DIR };
