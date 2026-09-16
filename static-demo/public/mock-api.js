/* 静态体验版的数据层：没有后端，全部跑在浏览器里
 * - 教材内容（页面图 / 音频 / 热区）在同目录的 content.json，由 tools/export_static_demo.mjs 生成
 * - 学习记录、录音、作业提交存在访问者自己的 localStorage
 * 覆盖 App.API 后，student.js 一行都不用改 —— 这也说明数据层是可替换的
 */
(function (g) {
  'use strict';

  const LS = 'dianbu_demo_state';
  const load = () => { try { return JSON.parse(localStorage.getItem(LS)) || {}; } catch { return {}; } };
  const save = (s) => { try { localStorage.setItem(LS, JSON.stringify(s)); } catch {} };
  const today = () => new Date().toISOString().slice(0, 10);

  function state() {
    const s = load();
    s.name = s.name || '';
    s.stars = s.stars || 0;
    s.streak = s.streak || 0;
    s.lastCheckin = s.lastCheckin || null;
    s.days = s.days || {};
    s.subs = s.subs || {};
    return s;
  }

  /* ---------- 内容索引 ---------- */
  let C = null;                 // content.json
  const idx = { pages: {}, hotspots: {}, lessonOf: {}, siblings: {} };

  function buildIndex() {
    for (const b of C.books) {
      for (const l of b.lessons) {
        const ids = l.pages.map((p) => p.id);
        for (const p of l.pages) {
          idx.pages[p.id] = { page: p, lesson: l, book: b };
          idx.siblings[p.id] = ids;
          for (const h of p.hotspots) idx.hotspots[h.id] = { h, lesson: l };
        }
      }
    }
  }
  const audioOf = (lesson) =>
    lesson.audio ? { id: lesson.id, url: lesson.audio.url, durationMs: lesson.audio.durationMs, placeholder: false } : null;

  const ready = fetch('content.json', { cache: 'no-cache' })
    .then((r) => r.json())
    .then((j) => { C = j; buildIndex(); })
    .catch((e) => { console.error('内容加载失败', e); throw new Error('内容加载失败，请刷新重试'); });

  /* ---------- 作业 ---------- */
  function hwBrief(s) {
    const hw = C.homework;
    const sub = s.subs[hw.id];
    return {
      id: hw.id, title: hw.title, className: hw.className, classId: hw.classId,
      pageId: hw.pageId, itemCount: hw.hotspotIds.length, note: hw.note, deadline: '',
      createdAt: new Date().toISOString().slice(0, 16).replace('T', ' '),
      status: sub ? sub.status : 'todo',
      stars: sub ? sub.stars : null,
      reviewText: sub ? sub.reviewText : null,
      submissionId: sub ? 1 : null,
    };
  }

  /* ---------- 路由 ---------- */
  const R = [
    ['POST', /^\/api\/auth\/dev-login$/, (m, body) => {
      const s = state(); s.name = (body.name || '同学').trim(); save(s);
      return { token: 'demo', user: { id: 1, role: 'student', name: s.name, stars: s.stars, streak: s.streak } };
    }],
    ['GET', /^\/api\/me$/, () => {
      const s = state();
      return {
        user: { id: 1, role: 'student', name: s.name, stars: s.stars, streak: s.streak },
        classes: [{ id: 1, name: C.homework.className, inviteCode: 'DEMO88' }],
      };
    }],
    ['GET', /^\/api\/books$/, () => C.books.map((b) => ({
      id: b.id, title: b.title, subtitle: b.subtitle, grade: b.grade, cover: null,
      lessonCount: b.lessons.length,
      pageCount: b.lessons.reduce((n, l) => n + l.pages.length, 0),
    }))],
    ['GET', /^\/api\/books\/(\d+)\/catalog$/, (m) => {
      const b = C.books.find((x) => x.id === Number(m[1]));
      if (!b) throw new Error('教材不存在');
      return {
        book: { id: b.id, title: b.title, subtitle: b.subtitle, grade: b.grade },
        lessons: b.lessons.map((l, i) => ({
          id: l.id, title: l.title, sort: i + 1,
          pages: l.pages.map((p) => ({ id: p.id, pageNo: p.pageNo, hotspotCount: p.hotspots.length })),
        })),
      };
    }],
    ['GET', /^\/api\/pages\/(\d+)$/, (m) => {
      const e = idx.pages[Number(m[1])];
      if (!e) throw new Error('页面不存在');
      const sib = idx.siblings[e.page.id];
      const i = sib.indexOf(e.page.id);
      const audio = audioOf(e.lesson);
      return {
        page: { id: e.page.id, pageNo: e.page.pageNo, imgW: e.page.imgW, imgH: e.page.imgH,
                img: { url: e.page.img } },
        lesson: { id: e.lesson.id, title: e.lesson.title, audio },
        book: { id: e.book.id, title: e.book.title },
        prevPageId: i > 0 ? sib[i - 1] : null,
        nextPageId: i < sib.length - 1 ? sib[i + 1] : null,
        hotspots: e.page.hotspots.map((h) => Object.assign({}, h, { type: 'sentence', audio })),
      };
    }],
    ['POST', /^\/api\/study\/heartbeat$/, (m, body) => {
      const s = state(); const d = today();
      s.days[d] = (s.days[d] || 0) + (Number(body.seconds) || 0);
      let justChecked = false;
      if (s.days[d] >= 60 && s.lastCheckin !== d) {
        const yest = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
        s.streak = s.lastCheckin === yest ? s.streak + 1 : 1;
        s.lastCheckin = d;
        s.stars += Math.max(1, Math.round(s.days[d] / 60));
        justChecked = true;
      }
      save(s);
      return { todaySeconds: s.days[d], needSeconds: 60, checkedInToday: s.lastCheckin === d,
               justChecked, streak: s.streak, stars: s.stars };
    }],
    ['GET', /^\/api\/study\/summary$/, () => {
      const s = state();
      const days = Object.keys(s.days).sort().reverse().map((d) => ({ date: d, seconds: s.days[d], stars: 0 }));
      return { streak: s.streak, stars: s.stars, checkedInToday: s.lastCheckin === today(),
               totalMinutes: Math.round(days.reduce((a, b) => a + b.seconds, 0) / 60), days, needSeconds: 60 };
    }],
    ['GET', /^\/api\/homeworks$/, () => [hwBrief(state())]],
    ['GET', /^\/api\/homeworks\/(\d+)$/, () => {
      const s = state();
      const hw = C.homework;
      const lesson = idx.pages[hw.pageId].lesson;
      const audio = audioOf(lesson);
      const items = hw.hotspotIds.map((id) => {
        const h = idx.hotspots[id].h;
        return { hotspotId: h.id, en: h.en, cn: h.cn, startMs: h.startMs, endMs: h.endMs, audio };
      });
      const out = Object.assign(hwBrief(s), { items, lessonAudio: audio });
      const sub = s.subs[hw.id];
      if (sub) {
        out.mySubmission = {
          id: 1, status: sub.status, stars: sub.stars, reviewText: sub.reviewText,
          items: Object.keys(sub.items || {}).map((k) => ({ hotspotId: Number(k), audio: { url: sub.items[k] } })),
        };
      }
      return out;
    }],
    ['POST', /^\/api\/homeworks\/(\d+)\/submit$/, (m, body) => {
      const s = state();
      const id = C.homework.id;
      const items = {};
      // 演示版把录音存成 dataURL；localStorage 容量有限，只留最近一次
      (body.items || []).forEach((it) => {
        if (it.audioBase64) items[it.hotspotId] = 'data:audio/' + (it.ext || 'webm') + ';base64,' + it.audioBase64;
      });
      s.subs[id] = { status: 'submitted', stars: null, reviewText: null, items };
      s.stars += 5;
      save(s);
      // 演示：3 秒后模拟老师批改，让整条链路走完
      setTimeout(() => {
        const t = state();
        if (t.subs[id] && t.subs[id].status === 'submitted') {
          t.subs[id].status = 'reviewed';
          t.subs[id].stars = 4;
          t.subs[id].reviewText = '读得不错，name 的 [eɪ] 再拉长一点。（演示：这条评语由老师端填写）';
          t.stars += 8;
          save(t);
          g.App.toast('老师已批改，去作业列表看看', 2600);
        }
      }, 3000);
      return { submissionId: 1 };
    }],
  ];

  function handle(method, p, body) {
    for (const [m, re, fn] of R) {
      if (m !== method) continue;
      const mt = re.exec(p);
      if (mt) return fn(mt, body || {});
    }
    throw new Error('体验版未实现该接口：' + method + ' ' + p);
  }

  const wrap = (method) => (p, body) =>
    ready.then(() => new Promise((res, rej) => {
      setTimeout(() => {
        try { res(handle(method, p, body)); } catch (e) { rej(e); }
      }, 60);   // 模拟一点网络延迟，手感更真实
    }));

  let voiceChecked = null;
  function hasEnVoice() {
    if (voiceChecked !== null) return voiceChecked;
    try {
      const vs = speechSynthesis.getVoices() || [];
      if (!vs.length) return true;
      voiceChecked = vs.some((v) => /^en/i.test(v.lang));
      if (!voiceChecked) setTimeout(() => g.App.toast('本机没有英文语音，已切换到课文录音', 3200), 800);
      return voiceChecked;
    } catch { voiceChecked = false; return false; }
  }

  function install() {
    g.App.API = { get: wrap('GET'), post: wrap('POST'), put: wrap('PUT'), del: wrap('DELETE') };

    // 体验版自带课文录音，默认直接放音频文件 —— 比依赖设备的语音合成可靠
    // （安卓微信内置浏览器常常没有英文语音包）
    const Base = g.App.Player;
    function DemoPlayer() { const p = new Base(); p.mode = 'audio'; return p; }
    DemoPlayer.prototype = Base.prototype;
    g.App.Player = DemoPlayer;

    const proto = Base.prototype;
    const origPlay = proto.play;
    proto.play = function (hs, onEnd) {
      if (this.mode === 'tts' && !hasEnVoice()) this.mode = 'audio';
      return origPlay.call(this, hs, onEnd);
    };
  }

  if (g.App) install(); else window.addEventListener('DOMContentLoaded', install);
})(window);
