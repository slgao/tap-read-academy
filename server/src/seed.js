'use strict';
/**
 * 生成 Demo 内容：
 *  - 页面图：ImageMagick 画出"自编讲义"（不使用受版权保护的教材扫描件，见 PRD §9.1）
 *  - 课文音频：ffmpeg 合成占位音轨，每句一个音高，用于验证「按时间区间 seek 播放」的点读逻辑
 *    （学生端默认用浏览器 TTS 朗读真实英文，可在界面里切换到原始音轨对比）
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DATA_DIR, CONTENT_DIR } = require('./db');
const repo = require('./repo');

const TMP = path.join(DATA_DIR, 'tmp');
fs.mkdirSync(TMP, { recursive: true });

const W = 1080, H = 1528;
const TITLE_BASE = 150, FIRST_BASE = 380, LINE_H = 150;
const BOX_X = 64, BOX_W = 952, BOX_TOP_OFF = 74, BOX_H = 104;

const PAGES = [
  {
    title: 'Unit 1   Nice to Meet You',
    color: '#0EA5E9',
    lines: [
      ['1. Hello! My name is Li Ming.', '你好！我叫李明。'],
      ['2. What is your name?', '你叫什么名字？'],
      ['3. My name is Anna. Nice to meet you.', '我叫安娜。很高兴认识你。'],
      ['4. How old are you?', '你几岁了？'],
      ['5. I am ten years old.', '我十岁了。'],
      ['6. Where are you from?', '你来自哪里？'],
    ],
  },
  {
    title: 'Unit 1   This Is My Family',
    color: '#F59E0B',
    lines: [
      ['1. This is my father. He is a doctor.', '这是我的爸爸，他是一名医生。'],
      ['2. This is my mother. She is a teacher.', '这是我的妈妈，她是一名老师。'],
      ['3. I have a little sister.', '我有一个妹妹。'],
      ['4. There are four people in my family.', '我家有四口人。'],
      ['5. Do you have any brothers?', '你有兄弟吗？'],
      ['6. I love my family very much.', '我非常爱我的家人。'],
    ],
  },
];

function drawPage(p, outFile) {
  const args = ['-size', `${W}x${H}`, 'xc:#FFFDF7',
    '-fill', p.color, '-draw', `rectangle 0,0 ${W},220`,
    '-fill', '#FFFFFF', '-pointsize', '52', '-annotate', `+64+${TITLE_BASE}`, p.title,
    '-fill', '#FFFFFF', '-pointsize', '24', '-annotate', `+64+${TITLE_BASE + 46}`, 'Tap any sentence to listen'];
  p.lines.forEach((_, i) => {
    const base = FIRST_BASE + i * LINE_H;
    args.push('-fill', '#F1F5F9', '-draw',
      `roundrectangle ${BOX_X},${base - BOX_TOP_OFF} ${BOX_X + BOX_W},${base - BOX_TOP_OFF + BOX_H} 14,14`);
  });
  p.lines.forEach((ln, i) => {
    const base = FIRST_BASE + i * LINE_H;
    args.push('-fill', '#0F172A', '-pointsize', '40', '-annotate', `+${BOX_X + 28}+${base}`, ln[0]);
  });
  args.push('-fill', '#94A3B8', '-pointsize', '26', '-annotate', `+64+${H - 48}`,
    'Demo handout - self-authored content, no copyrighted textbook used');
  args.push(outFile);
  execFileSync('convert', args);
}

function buildLessonAudio(allLines, outMp3) {
  const listFile = path.join(TMP, 'list.txt');
  const entries = [];
  const timings = [];
  const mkSilence = (sec, name) => {
    const f = path.join(TMP, name);
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', String(sec), f]);
    return f;
  };
  const sil300 = mkSilence(0.3, 'sil300.wav');
  const sil500 = mkSilence(0.5, 'sil500.wav');

  let t = 300;
  entries.push(sil300);
  allLines.forEach((ln, i) => {
    const words = ln[0].replace(/^\d+\.\s*/, '').split(/\s+/).length;
    const dur = Math.max(1.2, Math.min(4.0, words * 0.42));
    const f = path.join(TMP, `seg${i}.wav`);
    const freq = 392 + (i % 8) * 44;
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi',
      '-i', `sine=frequency=${freq}:duration=${dur.toFixed(2)}:sample_rate=16000`,
      '-af', 'afade=t=in:d=0.06,afade=t=out:st=' + (dur - 0.1).toFixed(2) + ':d=0.1', '-ac', '1', f]);
    const durMs = Math.round(dur * 1000);
    timings.push({ startMs: t, endMs: t + durMs });
    t += durMs + 500;
    entries.push(f, sil500);
  });
  fs.writeFileSync(listFile, entries.map((f) => `file '${f}'`).join('\n'));
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', listFile,
    '-c:a', 'libmp3lame', '-b:a', '48k', '-ac', '1', '-ar', '16000', outMp3]);
  return { timings, totalMs: t };
}

async function seed() {
  // --- 用户与班级 ---
  const ensureUser = async (role, name) =>
    (await repo.users.byNameRole(name, role))
    || repo.users.create({ openid: `seed_${role}_${name}`, role, name });

  const teacher = await ensureUser('teacher', '王老师');
  const students = [];
  for (const n of ['李小明', '张小红', '刘小刚']) students.push(await ensureUser('student', n));

  let cls = await repo.classes.byInviteCode('DEMO88');
  if (!cls) cls = await repo.classes.create({ name: '六年级 A 班', inviteCode: 'DEMO88', teacherId: teacher.id });
  for (const s of students) await repo.classes.addMember(cls.id, s.id);

  // --- 教材内容 ---
  const BOOK_TITLE = '自编讲义 · 英语入门 Demo';
  let book = await repo.books.byTitle(BOOK_TITLE);
  if (book) {
    console.log('Demo 教材已存在，跳过内容生成。如需重建：npm run reset');
  } else {
    book = await repo.books.create({
      title: BOOK_TITLE, subtitle: '机构自编内容，无版权风险', grade: '三年级起点',
    });
    const lesson = await repo.lessons.create({ bookId: book.id, title: 'Lesson 1  Greetings & Family', sort: 1 });

    const allLines = PAGES.flatMap((p) => p.lines);
    const mp3Rel = 'audio/demo_lesson1.mp3';

    // 优先用仓库里预先合成好的真人语音（tools/tts_lesson.mjs 生成）；
    // 没有的话退回 ffmpeg 合成的提示音，保证 seed 在任何机器上都能跑完。
    const canned = path.join(__dirname, '../assets/demo_lesson1.mp3');
    const cannedJson = path.join(__dirname, '../assets/demo_lesson1.json');
    let timings, placeholder;
    if (fs.existsSync(canned) && fs.existsSync(cannedJson)) {
      console.log('  使用预置课文语音 server/assets/demo_lesson1.mp3 ...');
      fs.copyFileSync(canned, path.join(CONTENT_DIR, mp3Rel));
      timings = JSON.parse(fs.readFileSync(cannedJson, 'utf8'));
      placeholder = false;
    } else {
      console.log('  未找到预置语音，用 ffmpeg 合成占位音轨 ...');
      ({ timings } = buildLessonAudio(allLines, path.join(CONTENT_DIR, mp3Rel)));
      placeholder = true;
    }
    const audio = await repo.assets.create({
      kind: 'audio', relPath: mp3Rel, mime: 'audio/mpeg',
      durationMs: Math.round(timings[timings.length - 1].endMs + 500),
      sizeBytes: fs.statSync(path.join(CONTENT_DIR, mp3Rel)).size, placeholder,
    });
    await repo.lessons.setAudio(lesson.id, audio.id);

    let k = 0;
    for (let pi = 0; pi < PAGES.length; pi++) {
      const p = PAGES[pi];
      const rel = `pages/demo_p${pi + 1}.png`;
      console.log(`  生成页面图 (ImageMagick) ${rel} ...`);
      drawPage(p, path.join(CONTENT_DIR, rel));
      const img = await repo.assets.create({
        kind: 'image', relPath: rel, mime: 'image/png', durationMs: 0,
        sizeBytes: fs.statSync(path.join(CONTENT_DIR, rel)).size,
      });
      const page = await repo.pages.create({
        lessonId: lesson.id, pageNo: pi + 1, imgId: img.id, imgW: W, imgH: H, sort: pi + 1,
      });
      await repo.hotspots.replaceForPage(page.id, p.lines.map((ln, i) => {
        const base = FIRST_BASE + i * LINE_H;
        const t = timings[k++];
        return {
          x: BOX_X / W, y: (base - BOX_TOP_OFF) / H, w: BOX_W / W, h: BOX_H / H,
          startMs: t.startMs, endMs: t.endMs,
          en: ln[0].replace(/^\d+\.\s*/, ''), cn: ln[1], type: 'sentence',
        };
      }), audio.id);
    }
    await repo.books.grantToClass(book.id, cls.id);

    // --- 一条示例作业 ---
    const firstPage = (await repo.pages.byLesson(lesson.id))[0];
    const hs = (await repo.hotspots.byPage(firstPage.id)).slice(0, 4).map((h) => h.id);
    await repo.homeworks.create({
      classId: cls.id, teacherId: teacher.id, title: 'Lesson 1 前四句 跟读', type: 'follow_read',
      bookId: book.id, pageId: firstPage.id, hotspotIds: hs,
      note: '注意 name 的发音，录之前先听两遍原音。', deadline: '',
    });
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`
  种子数据就绪
     教师账号：王老师        班级：六年级 A 班   邀请码：${cls.inviteCode}
     学生账号：李小明 / 张小红 / 刘小刚
     教材：${BOOK_TITLE}（2 页 / 12 个点读热区）
  `);
}

seed().catch((e) => { console.error(e); process.exit(1); });
