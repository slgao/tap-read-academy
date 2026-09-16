/* 静态演示版的数据层：没有后端，全部跑在浏览器里
 * - 内容（页面图 / 音频 / 热区）内联在下面
 * - 学习记录、录音、作业提交存在 localStorage
 * 覆盖 App.API 后，student.js 一行都不用改 —— 这也说明数据层是可替换的
 */
(function (g) {
  'use strict';
  const CONTENT = [
  {
    "pageNo": 1,
    "hotspots": [
      {
        "id": 101,
        "x": 0.05925925925925926,
        "y": 0.20026178010471204,
        "w": 0.8814814814814815,
        "h": 0.06806282722513089,
        "startMs": 300,
        "endMs": 2820,
        "en": "Hello! My name is Li Ming.",
        "cn": "你好！我叫李明。"
      },
      {
        "id": 102,
        "x": 0.05925925925925926,
        "y": 0.29842931937172773,
        "w": 0.8814814814814815,
        "h": 0.06806282722513089,
        "startMs": 3320,
        "endMs": 5000,
        "en": "What is your name?",
        "cn": "你叫什么名字？"
      },
      {
        "id": 103,
        "x": 0.05925925925925926,
        "y": 0.39659685863874344,
        "w": 0.8814814814814815,
        "h": 0.06806282722513089,
        "startMs": 5500,
        "endMs": 8860,
        "en": "My name is Anna. Nice to meet you.",
        "cn": "我叫安娜。很高兴认识你。"
      },
      {
        "id": 104,
        "x": 0.05925925925925926,
        "y": 0.49476439790575916,
        "w": 0.8814814814814815,
        "h": 0.06806282722513089,
        "startMs": 9360,
        "endMs": 11040,
        "en": "How old are you?",
        "cn": "你几岁了？"
      },
      {
        "id": 105,
        "x": 0.05925925925925926,
        "y": 0.5929319371727748,
        "w": 0.8814814814814815,
        "h": 0.06806282722513089,
        "startMs": 11540,
        "endMs": 13640,
        "en": "I am ten years old.",
        "cn": "我十岁了。"
      },
      {
        "id": 106,
        "x": 0.05925925925925926,
        "y": 0.6910994764397905,
        "w": 0.8814814814814815,
        "h": 0.06806282722513089,
        "startMs": 14140,
        "endMs": 15820,
        "en": "Where are you from?",
        "cn": "你来自哪里？"
      }
    ]
  },
  {
    "pageNo": 2,
    "hotspots": [
      {
        "id": 201,
        "x": 0.05925925925925926,
        "y": 0.20026178010471204,
        "w": 0.8814814814814815,
        "h": 0.06806282722513089,
        "startMs": 16320,
        "endMs": 19680,
        "en": "This is my father. He is a doctor.",
        "cn": "这是我的爸爸，他是一名医生。"
      },
      {
        "id": 202,
        "x": 0.05925925925925926,
        "y": 0.29842931937172773,
        "w": 0.8814814814814815,
        "h": 0.06806282722513089,
        "startMs": 20180,
        "endMs": 23540,
        "en": "This is my mother. She is a teacher.",
        "cn": "这是我的妈妈，她是一名老师。"
      },
      {
        "id": 203,
        "x": 0.05925925925925926,
        "y": 0.39659685863874344,
        "w": 0.8814814814814815,
        "h": 0.06806282722513089,
        "startMs": 24040,
        "endMs": 26140,
        "en": "I have a little sister.",
        "cn": "我有一个妹妹。"
      },
      {
        "id": 204,
        "x": 0.05925925925925926,
        "y": 0.49476439790575916,
        "w": 0.8814814814814815,
        "h": 0.06806282722513089,
        "startMs": 26640,
        "endMs": 29580,
        "en": "There are four people in my family.",
        "cn": "我家有四口人。"
      },
      {
        "id": 205,
        "x": 0.05925925925925926,
        "y": 0.5929319371727748,
        "w": 0.8814814814814815,
        "h": 0.06806282722513089,
        "startMs": 30080,
        "endMs": 32180,
        "en": "Do you have any brothers?",
        "cn": "你有兄弟吗？"
      },
      {
        "id": 206,
        "x": 0.05925925925925926,
        "y": 0.6910994764397905,
        "w": 0.8814814814814815,
        "h": 0.06806282722513089,
        "startMs": 32680,
        "endMs": 35200,
        "en": "I love my family very much.",
        "cn": "我非常爱我的家人。"
      }
    ]
  }
];

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
    s.subs = s.subs || {};        // hwId -> { status, stars, reviewText, items:{hotspotId:dataUrl} }
    return s;
  }

  const AUDIO = { url: 'assets/lesson1.mp3', durationMs: 35784, placeholder: true };
  const PAGES = CONTENT.map((p, i) => ({
    id: i + 1, pageNo: p.pageNo, img: { url: 'assets/p' + (i + 1) + '.webp' },
    imgW: 1080, imgH: 1528,
    hotspots: p.hotspots.map((h) => Object.assign({}, h, { audio: AUDIO, type: 'sentence' })),
  }));
  const ALL_HS = PAGES.flatMap((p) => p.hotspots);
  const HW = [{
    id: 1, title: 'Lesson 1 前四句 跟读', className: '六年级 A 班', classId: 1,
    pageId: 1, itemCount: 4, note: '注意 name 的发音，录之前先听两遍原音。',
    deadline: '', createdAt: new Date().toISOString().slice(0, 16).replace('T', ' '),
    hotspotIds: PAGES[0].hotspots.slice(0, 4).map((h) => h.id),
  }];

  function hwBrief(hw, s) {
    const sub = s.subs[hw.id];
    return Object.assign({}, hw, {
      status: sub ? sub.status : 'todo',
      stars: sub ? sub.stars : null,
      reviewText: sub ? sub.reviewText : null,
    });
  }

  const ROUTES = [
    ['POST', /^\/api\/auth\/dev-login$/, (m, body) => {
      const s = state(); s.name = (body.name || '同学').trim(); save(s);
      return { token: 'demo', user: { id: 1, role: 'student', name: s.name, stars: s.stars, streak: s.streak } };
    }],
    ['GET', /^\/api\/me$/, () => {
      const s = state();
      return { user: { id: 1, role: 'student', name: s.name, stars: s.stars, streak: s.streak },
               classes: [{ id: 1, name: '六年级 A 班', inviteCode: 'DEMO88' }] };
    }],
    ['GET', /^\/api\/books$/, () => [{
      id: 1, title: '自编讲义 · 英语入门 Demo', subtitle: '机构自编内容，无版权风险',
      grade: '三年级起点', cover: null, lessonCount: 1, pageCount: PAGES.length,
    }]],
    ['GET', /^\/api\/books\/(\d+)\/catalog$/, () => ({
      book: { id: 1, title: '自编讲义 · 英语入门 Demo', subtitle: '机构自编内容' },
      lessons: [{ id: 1, title: 'Lesson 1  Greetings & Family', sort: 1,
        pages: PAGES.map((p) => ({ id: p.id, pageNo: p.pageNo, hotspotCount: p.hotspots.length })) }],
    })],
    ['GET', /^\/api\/pages\/(\d+)$/, (m) => {
      const i = PAGES.findIndex((p) => p.id === Number(m[1]));
      const p = PAGES[i];
      return {
        page: { id: p.id, pageNo: p.pageNo, imgW: p.imgW, imgH: p.imgH, img: p.img },
        lesson: { id: 1, title: 'Lesson 1  Greetings & Family', audio: AUDIO },
        book: { id: 1, title: '自编讲义 · 英语入门 Demo' },
        prevPageId: i > 0 ? PAGES[i - 1].id : null,
        nextPageId: i < PAGES.length - 1 ? PAGES[i + 1].id : null,
        hotspots: p.hotspots,
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
    ['GET', /^\/api\/homeworks$/, () => { const s = state(); return HW.map((h) => hwBrief(h, s)); }],
    ['GET', /^\/api\/homeworks\/(\d+)$/, (m) => {
      const s = state();
      const hw = HW.find((h) => h.id === Number(m[1]));
      const items = hw.hotspotIds.map((id) => {
        const h = ALL_HS.find((x) => x.id === id);
        return { hotspotId: h.id, en: h.en, cn: h.cn, startMs: h.startMs, endMs: h.endMs, audio: AUDIO };
      });
      const out = Object.assign(hwBrief(hw, s), { items, lessonAudio: AUDIO });
      const sub = s.subs[hw.id];
      if (sub) {
        out.mySubmission = { id: 1, status: sub.status, stars: sub.stars, reviewText: sub.reviewText,
          items: Object.keys(sub.items || {}).map((k) => ({ hotspotId: Number(k), audio: { url: sub.items[k] } })) };
      }
      return out;
    }],
    ['POST', /^\/api\/homeworks\/(\d+)\/submit$/, (m, body) => {
      const s = state();
      const id = Number(m[1]);
      const items = {};
      (body.items || []).forEach((it) => {
        // 演示版把录音存成 dataURL（localStorage 容量有限，只留最近一次）
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

  function handle(method, path, body) {
    for (const [m, re, fn] of ROUTES) {
      if (m !== method) continue;
      const mt = re.exec(path);
      if (mt) return fn(mt, body || {});
    }
    throw new Error('演示版未实现该接口：' + method + ' ' + path);
  }

  function wrap(method) {
    return (path, body) => new Promise((resolve, reject) => {
      setTimeout(() => {
        try { resolve(handle(method, path, body)); } catch (e) { reject(e); }
      }, 60);   // 模拟一点网络延迟，手感更真实
    });
  }

  function install() {
    g.App.API = { get: wrap('GET'), post: wrap('POST'), put: wrap('PUT'), del: wrap('DELETE') };

    // 若设备没有英文语音合成，自动回退到内置音轨，避免点了没声音
    const p = g.App.Player.prototype;
    const origPlay = p.play;
    p.play = function (hs, onEnd) {
      if (this.mode === 'tts' && !hasEnVoice()) this.mode = 'audio';
      return origPlay.call(this, hs, onEnd);
    };
  }

  let voiceChecked = null;
  function hasEnVoice() {
    if (voiceChecked !== null) return voiceChecked;
    try {
      const vs = speechSynthesis.getVoices() || [];
      if (!vs.length) return true;               // 还没加载出来，先按支持处理
      voiceChecked = vs.some((v) => /^en/i.test(v.lang));
      if (!voiceChecked) {
        setTimeout(() => g.App.toast('本机没有英文语音，已切换到内置音轨（正式版用真人录音）', 3200), 800);
      }
      return voiceChecked;
    } catch { voiceChecked = false; return false; }
  }

  if (g.App) install(); else window.addEventListener('DOMContentLoaded', install);
})(window);
