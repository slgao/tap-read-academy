/* 学生端 —— 这一份 H5 的交互与数据流，与 miniprogram/ 下的小程序版本一一对应 */
(function () {
  'use strict';
  const { Store, API, toast, esc, fmtDate, starStr, Player, Rec, Clip, compressImage, maskName, subjTag, TYPE_NAME, lightbox, LETTER, fmtAnswer, fmtKey, fmtNum } = App;
  const $view = document.getElementById('view');
  const $top = document.getElementById('topbar');
  const $tab = document.getElementById('tabbar');
  const player = new Player();

  /* 线条图标（stroke=currentColor），不用 emoji */
  const ICON = {
    home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v9.5h13V10"/><path d="M10 19.5v-5h4v5"/>',
    book: '<path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z"/><path d="M5 17a3 3 0 0 1 3-3h11"/>',
    headphones: '<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="5" height="7" rx="2"/><rect x="16" y="14" width="5" height="7" rx="2"/>',
    pencil: '<path d="M4 20l1.2-4.8L16 4.4a2 2 0 0 1 2.8 0l.8.8a2 2 0 0 1 0 2.8L8.8 18.8z"/><path d="M14 6.5l3.5 3.5"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    star: '<path fill="currentColor" stroke="none" d="M12 2.8l2.8 5.8 6.3.9-4.6 4.4 1.1 6.3L12 17.2l-5.6 3 1.1-6.3L2.9 9.5l6.3-.9z"/>',
    image: '<rect x="4" y="3" width="16" height="18" rx="3"/><path d="M8 16l2.5-3 2 2.2L15 12l2 4"/><circle cx="9" cy="8" r="1.5"/>',
    mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
    speaker: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
    repeat: '<path d="M17 3l3 3-3 3"/><path d="M4 11V9a3 3 0 0 1 3-3h13"/><path d="M7 21l-3-3 3-3"/><path d="M20 13v2a3 3 0 0 1-3 3H4"/>',
    calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4M9 15l2 2 4-4"/>',
  };
  const ic = (name, cls = 'i') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICON[name] || ''}</svg>`;

  /** 一天按北京时间算，和服务端保持一致（手机时区不对也不会错位） */
  const dayKey = (ms = Date.now()) => new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10);

  /** 等级：按星星数，给初中生也留出追求的目标 */
  const LEVELS = [[0, '新芽'], [50, '小书虫'], [150, '阅读之星'], [300, '学习达人'], [600, '学霸']];
  function levelOf(stars) {
    let i = 0; while (i < LEVELS.length - 1 && stars >= LEVELS[i + 1][0]) i++;
    const next = LEVELS[i + 1];
    return { name: LEVELS[i][1], next: next ? next[1] : null, need: next ? next[0] - stars : 0 };
  }

  /** 庆祝：印章盖下来，星星迸出 */
  function celebrate({ mark = '读', label = '', title, sub = '', gain = 0 }) {
    const old = document.getElementById('celebrate'); if (old) old.remove();
    const sparks = [[-78, -40], [74, -52], [-60, 46], [82, 30], [0, -88], [-30, 76], [40, 70], [-92, -4]]
      .map(([dx, dy], k) => `<i class="spark" style="--dx:${dx}px;--dy:${dy}px;animation-delay:${0.22 + k * 0.03}s">${ic('star')}</i>`).join('');
    const m = document.createElement('div');
    m.className = 'celebrate'; m.id = 'celebrate';
    m.innerHTML = `<div class="box" role="dialog" aria-label="${esc(title)}">
        ${sparks}
        <div class="stamp"><b>${esc(mark)}</b>${label ? `<span>${esc(label)}</span>` : ''}</div>
        <h3>${esc(title)}</h3>
        ${sub ? `<p>${esc(sub)}</p>` : '<p></p>'}
        ${gain ? `<div class="gain">${ic('star')}+${gain} 星星</div><br>` : ''}
        <button class="btn block" data-act="closeCelebrate">太棒了</button>
      </div>`;
    m.addEventListener('click', (e) => { if (e.target === m) m.remove(); });
    document.getElementById('app').appendChild(m);
  }

  const S = { view: 'home', book: null, catalog: null, page: null, hw: null, showHs: false, repeat: false, recs: {}, ans: {}, subj: '' };
  let accum = 0, pending = 0;

  /* ---------- 学习时长心跳 ----------
   * 以前只在"音频正好在播"的那一刻计时：点读一句只响两三秒，5 秒采样常常正好错过，
   * 读十分钟也攒不到一分钟；语文、数学、书法这些没有音频的作业更是一秒都不算，
   * 首页的圆盘看着就像卡住不动。
   * 现在按"在学习页面上并且人还在操作"计时：在读课文、听课文、做作业都算，
   * 音频在放时即使锁屏也算；切到后台、停在首页或者两分钟没动手就不算。
   */
  const STUDY_VIEWS = ['reader', 'listen', 'hwdetail'];
  const IDLE_MS = 120000;
  let lastActive = Date.now();
  const touch = () => { lastActive = Date.now(); };
  ['click', 'touchstart', 'keydown', 'scroll'].forEach((ev) => document.addEventListener(ev, touch, { passive: true, capture: true }));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) touch(); });

  function studying() {
    if (player.current || (typeof Listen !== 'undefined' && Listen.playing())) return true;   // 放音频：锁屏听也算
    if (document.hidden) return false;                                                        // 切去别的 App 不算
    if (Rec.mr) return true;                                                                  // 正在录音
    return STUDY_VIEWS.includes(S.view) && Date.now() - lastActive < IDLE_MS;
  }

  setInterval(async () => {
    if (studying()) { accum += 5; pending += 5; }
    if (pending >= 15 && Store.token) {
      const s = pending; pending = 0;
      try {
        const r = await API.post('/api/study/heartbeat', { seconds: s });
        // 打卡成功：在首页盖个印庆祝一下；正在读课文、做作业时只轻提示一句，不挡住屏幕
        if (r.justChecked) {
          if (S.view === 'home') celebrate({ mark: '读', label: '今日已打卡', title: '今天的印盖上啦', sub: `已经连续打卡 ${r.streak} 天`, gain: 0 });
          else toast(`今天的打卡印盖上啦，连续 ${r.streak} 天`, 2600);
        }
        if (S.view === 'home') render();            // 停在首页时圆盘跟着一起走（重画会清掉没提交的答案，所以别的页面不重画）
      } catch {}
    }
  }, 5000);

  /* ---------- 路由 ---------- */
  function go(view, data) {
    if (Rec.mr) { Rec.cancel(); S.recQ = null; toast('这次录音没保存'); }   // 离开页面把麦克风放掉
    Clip.stop();
    closePoster();
    if (view !== 'reader') player.stop();
    if (view !== 'listen') Listen.stop();
    S.view = view;
    Object.assign(S, data || {});
    render();
  }
  window.addEventListener('popstate', () => { if (S.view !== 'home') go('home'); });

  let renderSeq = 0;
  function render() {
    const V = VIEWS[S.view] || VIEWS.home;
    const seq = ++renderSeq;                 // 慢请求回来时页面可能已经切走了
    $top.innerHTML = V.top();
    $view.className = V.bare ? 'reader' : (V.cls || (V.noTab ? 'view no-tab' : 'view'));
    $view.innerHTML = '<div class="empty">加载中…</div>';
    $tab.hidden = !V.tab;
    if (V.tab) renderTab();
    Promise.resolve(V.body()).then((html) => {
      if (seq !== renderSeq) return;
      $view.innerHTML = html;
      if (V.after) V.after();
    }).catch((e) => { if (seq === renderSeq) $view.innerHTML = `<div class="empty">${esc(e.message)}</div>`; });
  }

  function renderTab() {
    const items = [['home', '首页', 'home'], ['shelf', '教材', 'book'], ['listenlist', '听力', 'headphones'],
      ['hwlist', '作业', 'pencil'], ['me', '我的', 'user']];
    $tab.innerHTML = items.map(([k, t, icon]) =>
      `<button class="${S.view === k ? 'on' : ''}" data-go="${k}" aria-label="${t}"><span class="tab-ic">${ic(icon)}</span>${t}</button>`).join('');
  }

  document.addEventListener('click', (e) => {
    const g = e.target.closest('[data-go]');
    if (g) { go(g.dataset.go, g.dataset.arg ? JSON.parse(g.dataset.arg) : null); return; }
    const a = e.target.closest('[data-act]');
    if (a) { (ACT[a.dataset.act] || (() => {}))(a); }
  });
  document.addEventListener('input', (e) => {
    const el = e.target;
    if (el.dataset.qaText) S.ans[el.dataset.qaText] = { value: el.value };
    if (el.dataset.qaBlank) {
      const st = S.ans[el.dataset.qaBlank] || (S.ans[el.dataset.qaBlank] = { value: [] });
      if (!Array.isArray(st.value)) st.value = [];
      st.value[Number(el.dataset.k)] = el.value;
    }
  });
  document.addEventListener('change', async (e) => {
    const el = e.target;
    if (el.dataset.qaPhoto) {
      const qid = el.dataset.qaPhoto;
      const st = S.ans[qid] || (S.ans[qid] = { photos: [] });
      st.photos = st.photos || [];
      const files = [...(el.files || [])].slice(0, 6 - st.photos.length);
      if (el.files.length > files.length) toast('每题最多 6 张照片');
      for (const f of files) {
        try { st.photos.push(await compressImage(f)); } catch (err) { toast(err.message); }
      }
      redrawQ(qid);
    }
    if (el.id === 'sh-full') drawSharePreview();
  });

  /* ---------- 登录 ---------- */
  const LOGIN = {
    top: () => `<h1>学生登录</h1>`,
    noTab: true,
    body: () => `
      <div class="login-brand">
        <img src="brand/logo-192.png" alt="福斯特培训学校校徽">
        <div class="name">福斯特培训学校</div>
        <div class="en">FIRST TRAINING SCHOOL</div>
        <div class="tag"><span style="background:var(--sky-wash);color:var(--sky-shade)">点读课文</span><span style="background:var(--mint-wash);color:var(--mint-shade)">英语听力</span><span style="background:var(--coral-wash);color:var(--coral-shade)">各科作业</span><span style="background:var(--star-wash);color:#8A5A00">每日打卡</span></div>
      </div>
      <div class="card">
        <label class="field"><span>姓名</span><input id="i-name" placeholder="例如：李小明" value="李小明" autocomplete="name"></label>
        <label class="field"><span>班级邀请码</span><input id="i-code" placeholder="向老师要 6 位邀请码" value="DEMO88" style="text-transform:uppercase"></label>
        <button class="btn block" data-act="login">进入学习</button>
      </div>
      <div class="muted small center">演示账号：李小明 / 张小红 / 刘小刚，邀请码 DEMO88</div>
      <div class="muted small center mt">${window.DEMO_MODE
        ? '这是体验版，学习记录只保存在你自己的手机上'
        : '浏览器预览版，微信小程序代码在 mvp/miniprogram/'}</div>`,
  };

  /* ---------- 首页 ---------- */
  const HOME = {
    top: () => `<h1><img src="brand/logo-96.png" alt="">福斯特</h1><span class="star-pill" id="top-stars">${ic('star')}<span>…</span></span>`,
    tab: true,
    body: async () => {
      const [sum, hws] = await Promise.all([API.get('/api/study/summary', 15000), API.get('/api/homeworks', 30000)]);
      API.prefetch(['/api/books', '/api/listening'], 300000);
      const todo = hws.filter((h) => h.status === 'todo' || h.status === 'rejected');
      // 只算今天；sum.days[0] 是最近有记录的一天，不一定是今天
      const todayRow = sum.days.find((d) => d.date === dayKey());
      const secs = todayRow ? todayRow.seconds : 0;
      const pct = Math.min(100, Math.round((secs / sum.needSeconds) * 100));
      const needMin = Math.max(1, Math.round(sum.needSeconds / 60));
      const leftMin = Math.max(1, Math.ceil((sum.needSeconds - secs) / 60));
      const lv = levelOf(sum.stars);
      const st = document.querySelector('#top-stars span'); if (st) st.textContent = sum.stars;
      return `
      <div class="hello">
        <h2>${esc((Store.user || {}).name || '同学')}，${greeting()}！</h2>
        <div class="level"><b>${lv.name}</b>${lv.next ? `再得 ${lv.need} 颗星升级「${lv.next}」` : '已经是最高等级'}</div>
      </div>

      <div class="card">
        <div class="goal">
          <div class="ring" style="--p:${pct}" role="img" aria-label="今日目标完成 ${pct}%">
            <div class="ring-in"><b>${Math.floor(secs / 60)}</b><span>${pct >= 100 ? '已达成' : `/ ${needMin} 分钟`}</span></div>
          </div>
          <div class="goal-text grow">
            <div class="strong">${sum.checkedInToday ? '今日目标完成，印已盖好' : `再读 ${leftMin} 分钟就能盖印`}</div>
            <div class="muted small">点读、听力、做作业都算时间</div>
            <div class="streak">${ic('calendar')}连续打卡 ${sum.streak} 天</div>
          </div>
        </div>
        ${sealRow(sum)}
      </div>

      <div class="tiles">
        <button class="tile sky" data-go="shelf"><span class="t-ic">${ic('book')}</span><div><b>点读课本</b><span>点哪句读哪句</span></div></button>
        <button class="tile mint" data-go="listenlist"><span class="t-ic">${ic('headphones')}</span><div><b>听力</b><span>整课连着听</span></div></button>
        <button class="tile coral" data-go="hwlist">${todo.length ? `<i class="badge">${todo.length}</i>` : ''}<span class="t-ic">${ic('pencil')}</span><div><b>做作业</b><span>${todo.length ? `还有 ${todo.length} 项` : '都做完啦'}</span></div></button>
        <button class="tile star" data-act="poster"><span class="t-ic">${ic('image')}</span><div><b>学习海报</b><span>晒晒我的打卡</span></div></button>
      </div>

      ${todo.length ? `<div class="card">
        <div class="row between mb"><div class="section-title">今日作业</div><span class="pill todo">${todo.length} 项待完成</span></div>
        ${todo.slice(0, 3).map((h, i) => `
          <div class="listitem" data-go="hwdetail" data-arg='${JSON.stringify({ hwId: h.id })}'>
            <div class="n">${i + 1}</div>
            <div class="grow"><div class="strong ellip">${esc(h.title)}</div><div class="muted small">${hwMeta(h)} · ${esc(h.className)}</div></div>
            <span class="muted">›</span>
          </div>`).join('')}
      </div>` : ''}`;
    },
  };

  /* ---------- 书架 ---------- */
  const SHELF = {
    top: () => `<h1><img src="brand/logo-96.png" alt="">教材</h1>`,
    tab: true,
    body: async () => {
      const books = await API.get('/api/books', 300000);
      if (!books.length) return `<div class="empty">还没有教材<br><span class="small">请老师在内容后台添加</span></div>`;
      return books.map((b) => `
        <div class="booktile" data-go="catalog" data-arg='${JSON.stringify({ bookId: b.id })}'>
<div class="cv">${esc(b.title.slice(0, 1))}</div>
          <div class="grow"><div class="strong">${esc(b.title)}</div>
            <div class="muted small">${esc(b.subtitle || '')}</div>
            <div class="muted small">${b.lessonCount} 课 · ${b.pageCount} 页</div></div>
          <span class="muted">›</span>
        </div>`).join('');
    },
  };

  /* ---------- 目录 ---------- */
  const CATALOG = {
    top: () => `<button class="back" data-go="shelf">‹</button><h1><span class="t">${esc((S.catalog && S.catalog.book.title) || '目录')}</span></h1>`,
    noTab: true,
    body: async () => {
      const data = await API.get(`/api/books/${S.bookId}/catalog`, 300000);
      S.catalog = data;
      $top.innerHTML = CATALOG.top();
      if (!data.lessons.length) return `<div class="empty">这本书还没有内容</div>`;
      return data.lessons.map((l) => `
        <div class="card">
          <div class="strong mb">${esc(l.title)}</div>
          ${l.pages.map((p) => `
            <div class="listitem" data-go="reader" data-arg='${JSON.stringify({ pageId: p.id })}'>
              <div class="n">${p.pageNo}</div>
              <div class="grow"><div class="strong">第 ${p.pageNo} 页</div>
                <div class="muted small">${p.hotspotCount} 个点读句</div></div>
              <span class="muted">›</span>
            </div>`).join('')}
        </div>`).join('');
    },
  };

  /* ---------- 点读器 ---------- */
  const READER = {
    top: () => `<button class="back" data-act="leaveReader">‹</button>
      <h1><span class="t">${esc((S.page && S.page.lesson.title) || '点读')}</span><span class="sub">P${(S.page && S.page.page.pageNo) || ''}</span></h1>
      <button class="iconbtn ${S.showHs ? 'on' : ''}" data-act="toggleHs" title="显示/隐藏热区">框</button>`,
    bare: true,
    body: async () => {
      const d = await API.get(`/api/pages/${S.pageId}`, 300000);
      S.page = d; S.hsIdx = -1;
      // 预取上一页和下一页：翻页时不用再等网络
      API.prefetch([d.prevPageId, d.nextPageId].filter(Boolean).map((id) => `/api/pages/${id}`), 300000);
      $top.innerHTML = READER.top();
      const hwHs = S.hwHotspotIds || [];
      return `
        <div class="pagewrap">
          <img src="${d.page.img.url}" alt="page">
          <div id="hslayer">
            ${d.hotspots.map((h, i) => `
              <div class="hs ${S.showHs ? 'show' : ''} ${hwHs.includes(h.id) ? 'hw' : ''}" data-act="tapHs" data-i="${i}"
                   style="left:${h.x * 100}%;top:${h.y * 100}%;width:${h.w * 100}%;height:${h.h * 100}%"></div>`).join('')}
          </div>
        </div>
        <div class="playbar">
          <div class="subtitle" id="sub-en">点击句子即可播放</div>
          <div class="subtitle-cn" id="sub-cn">${d.hotspots.length} 个点读句</div>
          <div class="ctrls">
            <button class="btn sm sky" data-act="playAll" id="btn-all">连播</button>
            <button class="iconbtn ${S.repeat ? 'on' : ''}" data-act="toggleRepeat" aria-label="单句复读">${ic('repeat')}</button>
            <button class="iconbtn" data-act="cycleRate" id="btn-rate" style="font-size:12px;font-weight:700">1.0×</button>
            <div class="grow"></div>
            <button class="iconbtn rec" data-act="recToggle" id="btn-rec" aria-label="跟读录音">${ic('mic')}</button>
            <button class="iconbtn" data-act="playMyRec" id="btn-myrec" aria-label="听我的录音" hidden>${ic('speaker')}</button>
          </div>
          <div class="pagenav">
            <button class="btn sm ghost" data-act="turnPage" data-pid="${d.prevPageId || ''}" ${d.prevPageId ? '' : 'disabled'} aria-label="上一页">‹ 上一页</button>
            <span class="muted small" id="rec-tip">左右滑动也能翻页</span>
            <button class="btn sm ghost" data-act="turnPage" data-pid="${d.nextPageId || ''}" ${d.nextPageId ? '' : 'disabled'} aria-label="下一页">下一页 ›</button>
          </div>
        </div>`;
    },
    after: () => {
      player.onTick((hs) => {
        // 播放器是全局共用的：离开点读页后（比如作业页点"原音"）不再更新点读页的元素
        if (S.view !== 'reader' || !S.page) return;
        document.querySelectorAll('.hs').forEach((el) => el.classList.remove('active'));
        if (!hs) return;
        const i = S.page.hotspots.findIndex((h) => h.id === hs.id);
        const el = document.querySelector(`.hs[data-i="${i}"]`);
        if (el) { el.classList.add('active'); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
        const en = document.getElementById('sub-en'), cn = document.getElementById('sub-cn');
        if (en) en.textContent = hs.en || '';
        if (cn) cn.textContent = hs.cn || '';
      });
      // 左右滑动翻页：水平位移明显大于垂直位移才算，不影响上下滚动看课本
      let sx = 0, sy = 0, multi = false;
      $view.ontouchstart = (e) => { multi = e.touches.length > 1; sx = e.touches[0].clientX; sy = e.touches[0].clientY; };
      $view.ontouchend = (e) => {
        if (multi || S.view !== 'reader' || !S.page) return;
        const t = e.changedTouches[0], dx = t.clientX - sx, dy = t.clientY - sy;
        if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
        const pid = dx < 0 ? S.page.nextPageId : S.page.prevPageId;
        if (pid) turnTo(pid); else toast(dx < 0 ? '已经是最后一页' : '已经是第一页');
      };
      const pw = $view.querySelector('.pagewrap');
      if (pw) {
        pw.addEventListener('click', (e) => {
          if (e.target.closest('.hs')) return;
        });
      }
    },
  };

  /* ---------- 作业列表 ---------- */
  const hwMeta = (h) => (h.kind === 'questions' ? `${h.itemCount} 道题` : `${h.itemCount} 句跟读`);
  const HWLIST = {
    top: () => `<h1><img src="brand/logo-96.png" alt="">作业</h1>`,
    tab: true,
    body: async () => {
      const all = await API.get('/api/homeworks', 30000);
      if (!all.length) return `<div class="empty">还没有作业</div>`;
      const subs = [];
      all.forEach((h) => { if (h.subject && !subs.some((x) => x.code === h.subject.code)) subs.push(h.subject); });
      if (S.subj && !subs.some((x) => x.code === S.subj)) S.subj = '';
      const hws = S.subj ? all.filter((h) => h.subject && h.subject.code === S.subj) : all;
      const P = { todo: ['todo', '待完成'], submitted: ['warn', '已提交'], reviewed: ['ok', '已批改'], rejected: ['todo', '需重做'] };
      const chips = subs.length > 1 ? `<div class="chips mb" role="tablist">
          <button class="fchip ${S.subj ? '' : 'on'}" data-act="pickSubj" data-code="">全部</button>
          ${subs.map((x) => `<button class="fchip ${esc(x.color)} ${S.subj === x.code ? 'on' : ''}" data-act="pickSubj" data-code="${esc(x.code)}">${esc(x.name)}</button>`).join('')}
        </div>` : '';
      return chips + hws.map((h) => {
        const [cls, txt] = P[h.status] || P.todo;
        return `<div class="hwitem" data-go="hwdetail" data-arg='${JSON.stringify({ hwId: h.id })}'>
          <div class="row between"><div class="strong ellip grow">${subjTag(h.subject)}${esc(h.title)}</div><span class="pill ${cls}">${txt}</span></div>
          <div class="muted small mt">${hwMeta(h)} · ${esc(h.className)} · ${fmtDate(h.createdAt)}</div>
          ${h.status === 'reviewed' ? `<div class="mt row" style="gap:8px">
            ${h.excellent ? '<span class="pill warn">优秀</span>' : ''}
            ${h.kind === 'questions' && h.maxScore ? `<b class="score">${fmtNum(h.score)}<small>/${fmtNum(h.maxScore)}</small></b>` : `<span class="stars">${starStr(h.stars)}</span>`}
            <span class="muted small ellip">${esc(h.reviewText || '')}</span></div>` : ''}
        </div>`;
      }).join('');
    },
  };

  /* ---------- 作业详情 ---------- */
  const HWDETAIL = {
    top: () => `<button class="back" data-go="hwlist">‹</button><h1><span class="t">${esc((S.hw && S.hw.title) || '作业')}</span></h1>`,
    noTab: true,
    body: async () => {
      const hw = await API.get(`/api/homeworks/${S.hwId}`);
      S.hw = hw; S.recs = {};
      if (hw.kind === 'questions') { $top.innerHTML = HWDETAIL.top(); return questionDetail(hw); }
      if (hw.mySubmission) (hw.mySubmission.items || []).forEach((it) => { S.recs[it.hotspotId] = { url: it.audio && it.audio.url, saved: true }; });
      $top.innerHTML = HWDETAIL.top();
      const done = hw.status === 'reviewed';
      return `
        <div class="card tight mb">
          <div class="row between"><span class="muted small">${esc(hw.className)} · ${hw.itemCount} 句</span>
          <span class="pill ${done ? 'ok' : hw.status === 'submitted' ? 'warn' : 'todo'}">${done ? '已批改' : hw.status === 'submitted' ? '已提交' : '待完成'}</span></div>
          ${hw.note ? `<div class="mt small">老师说：${esc(hw.note)}</div>` : ''}
          ${done ? `<div class="hr"></div><div class="row" style="gap:8px"><span class="stars">${starStr(hw.stars)}</span><span class="small">${esc(hw.reviewText || '')}</span></div>
            ${rubricView(hw.mySubmission && hw.mySubmission.rubric)}` : ''}
          ${done && hw.excellent ? `<div class="hr"></div><div class="row between"><span class="strong">被评为优秀作业</span><button class="btn sm star" data-act="shareOpen" data-type="praise">生成喜报</button></div>` : ''}
        </div>
        <div class="row between mb">
          <button class="btn sm ghost" data-act="hwOpenPage">打开课本页</button>
        </div>
        <div id="hw-items">${hw.items.map((it, i) => itemHtml(it, i)).join('')}</div>
        ${done ? '' : `<button class="btn block mt" data-act="hwSubmit" id="btn-submit">提交作业</button>`}
        <div class="muted small center mt">第一次录音时，请允许使用麦克风</div>`;
    },
  };

  function itemHtml(it, i) {
    const rec = S.recs[it.hotspotId];
    return `<div class="sentence ${rec ? 'done' : ''}" id="sent-${it.hotspotId}">
      <div class="en">${i + 1}. ${esc(it.en)}</div>
      <div class="cn">${esc(it.cn || '')}</div>
      <div class="row" style="gap:8px">
        <button class="btn sm sky" data-act="hwPlay" data-i="${i}">${ic('speaker')}原音</button>
        <button class="btn sm ${rec ? 'ghost' : 'coral'}" data-act="hwRec" data-hid="${it.hotspotId}" data-i="${i}">${ic('mic')}${rec ? '重录' : '跟读'}</button>
        ${rec && rec.url ? `<button class="btn sm ghost" data-act="hwPlayRec" data-hid="${it.hotspotId}">我的</button>` : ''}
        ${rec ? '<span class="pill ok">已录</span>' : ''}
      </div>
    </div>`;
  }


  /** 作业班的评分栏（老师打的） */
  const RUBRIC_NAMES = { write: '书写', posture: '坐姿', attitude: '学习态度', efficiency: '作业效率' };
  function rubricView(rb) {
    if (!rb) return '';
    const rows = Object.keys(RUBRIC_NAMES).filter((k) => rb[k]);
    if (!rows.length && !rb.minutes && !rb.other) return '';
    return `<div class="rubric-view">
      ${rows.map((k) => `<div class="row between"><span class="muted small">${RUBRIC_NAMES[k]}</span><span class="stars">${starStr(rb[k])}</span></div>`).join('')}
      ${rb.minutes ? `<div class="row between"><span class="muted small">作业时长</span><span class="strong">${rb.minutes} 分钟</span></div>` : ''}
      ${rb.other ? `<div class="muted small mt">${esc(rb.other)}</div>` : ''}
    </div>`;
  }

  /* ---------- 题目作业 ---------- */
  function questionDetail(hw) {
    const sub = hw.mySubmission;
    const st = hw.status;
    S.editing = st === 'todo' || st === 'rejected' || (st === 'submitted' && S.editing === hw.id) ? hw.id : null;
    const edit = !!S.editing;
    S.ans = {};
    if (edit) {
      // 打回重做或重新作答时，把之前答过的客观题和文字带进来；照片和录音要重新拍、重新录
      hw.questions.forEach((q) => {
        const a = q.myAnswer;
        if (a && (q.auto || q.type === 'text') && a.value != null) S.ans[q.id] = { value: a.value };
      });
    }
    let head = '';
    if (st === 'reviewed' && sub) {
      const photo = hw.questions.some((q) => q.type === 'photo' && q.myAnswer && q.myAnswer.assets.length);
      const calli = hw.subject && hw.subject.code === 'calli';
      head = `<div class="card result ${sub.excellent ? 'excellent' : ''}">
        <div class="row between">
          <div><div class="bigscore">${fmtNum(sub.score)}<small> / ${fmtNum(sub.maxScore)} 分</small></div>
            <span class="stars">${starStr(sub.stars)}</span></div>
          ${sub.excellent ? '<div class="seal-ex" aria-label="优秀作业">优</div>' : ''}
        </div>
        ${rubricView(sub.rubric)}
        ${sub.reviewText ? `<div class="teacher-say"><b>老师说</b>${esc(sub.reviewText)}</div>` : ''}
        ${sub.excellent || (calli && photo) ? `<div class="row mt" style="gap:8px">
          ${sub.excellent ? '<button class="btn sm star grow" data-act="shareOpen" data-type="praise">生成喜报</button>' : ''}
          ${calli && photo ? '<button class="btn sm grow" data-act="shareOpen" data-type="work">分享书法作品</button>' : ''}
        </div>` : ''}
      </div>`;
    } else if (st === 'submitted' && !edit) {
      head = `<div class="card tight mb"><div class="strong">已提交，等老师批改</div>
        <div class="muted small mt">${sub && sub.score ? `选择题、填空题已得 ${fmtNum(sub.score)} 分，` : ''}老师批改后能看到总分和评语</div>
        <button class="btn sm ghost mt" data-act="qaRedo">重新作答</button></div>`;
    } else if (st === 'rejected') {
      head = `<div class="card tight mb warnbox"><div class="strong">老师让你重做</div>${sub && sub.reviewText ? `<div class="small mt">${esc(sub.reviewText)}</div>` : ''}</div>`;
    }
    return `
      <div class="card tight mb">
        <div class="row between"><span class="muted small">${subjTag(hw.subject)}${esc(hw.className)} · ${hw.questions.length} 道题</span>
          <span class="pill ${st === 'reviewed' ? 'ok' : st === 'submitted' ? 'warn' : 'todo'}">${{ reviewed: '已批改', submitted: '已提交', rejected: '需重做' }[st] || '待完成'}</span></div>
        ${hw.note ? `<div class="mt small">老师说：${esc(hw.note)}</div>` : ''}
      </div>
      ${head}
      ${hw.questions.map((q, i) => qCard(q, i, edit)).join('')}
      ${edit ? `<button class="btn block mt" data-act="qaSubmit">提交作业</button>
        <div class="muted small center mt">单选、多选、判断、填空交上去马上出分</div>` : ''}`;
  }

  function qCard(q, i, edit) {
    const a = q.myAnswer;
    const reviewed = S.hw.status === 'reviewed';
    let mark = '';
    if (reviewed && a) {
      mark = q.auto ? `<span class="mark ${a.autoCorrect ? 'ok' : 'bad'}">${a.autoCorrect ? '对' : '错'}</span>`
        : `<span class="mark ${a.score >= q.score ? 'ok' : 'mid'}">${fmtNum(a.score)} 分</span>`;
    }
    const stem = `${q.stem ? `<div class="q-stem">${esc(q.stem)}</div>` : ''}
      ${q.stemImage ? `<button class="stem-pic" data-act="zoom" data-src="${esc(q.stemImage.url)}"><img src="${esc(q.stemImage.url)}" alt="题目图片"></button>` : ''}`;
    const body = edit ? qInput(q) : qShow(q, a);
    const extra = reviewed ? `
      ${a && !a.autoCorrect && q.auto && q.answer != null ? `<div class="q-key">正确答案：<b>${esc(fmtKey(q))}</b></div>` : ''}
      ${a && a.comment ? `<div class="q-key">老师点评：${esc(a.comment)}</div>` : ''}
      ${q.analysis ? `<div class="q-key muted">解析：${esc(q.analysis)}</div>` : ''}` : '';
    return `<div class="qcard" id="q-${q.id}">
      <div class="q-head"><span class="q-no">${i + 1}</span><span class="pill">${TYPE_NAME[q.type]}</span><span class="muted small grow">${fmtNum(q.score)} 分</span>${mark}</div>
      ${stem}${body}${extra}
    </div>`;
  }

  function qInput(q) {
    const st = S.ans[q.id] || {};
    const v = st.value;
    if (q.type === 'single' || q.type === 'multi') {
      const on = (k) => (q.type === 'single' ? Number(v) === k && v !== undefined && v !== null : Array.isArray(v) && v.includes(k));
      return `<div class="opts">${q.options.map((o, k) => `<button class="opt ${on(k) ? 'on' : ''}" data-act="qaPick" data-q="${q.id}" data-k="${k}" aria-pressed="${on(k)}"><i>${LETTER[k]}</i><span>${esc(o)}</span></button>`).join('')}</div>
        ${q.type === 'multi' ? '<div class="muted small">可以选多个</div>' : ''}`;
    }
    if (q.type === 'judge') {
      return `<div class="row judge" style="gap:10px">
        <button class="opt ${v === true ? 'on' : ''}" data-act="qaJudge" data-q="${q.id}" data-v="1"><i>✓</i><span>对</span></button>
        <button class="opt ${v === false ? 'on' : ''}" data-act="qaJudge" data-q="${q.id}" data-v="0"><i>✗</i><span>错</span></button></div>`;
    }
    if (q.type === 'blank') {
      const vals = Array.isArray(v) ? v : [];
      return `<div class="blanks">${Array.from({ length: q.blankCount || 1 }, (_, k) => `<label class="blank"><span>${k + 1}</span><input data-qa-blank="${q.id}" data-k="${k}" value="${esc(vals[k] || '')}" placeholder="第 ${k + 1} 个空" autocomplete="off"></label>`).join('')}</div>`;
    }
    if (q.type === 'text') return `<textarea data-qa-text="${q.id}" rows="4" placeholder="在这里写答案">${esc(v || '')}</textarea>`;
    if (q.type === 'photo') {
      const ph = st.photos || [];
      return `<div class="thumbs">${ph.map((p, k) => `<div class="thumb"><img src="${p.url}" alt="第 ${k + 1} 张"><button class="x" data-act="qaPhotoDel" data-q="${q.id}" data-k="${k}" aria-label="删掉这张">×</button></div>`).join('')}
        ${ph.length < 6 ? `<label class="thumb add">${ic('image')}<span>${ph.length ? '再加一张' : '拍照 / 选照片'}</span><input type="file" accept="image/*" multiple data-qa-photo="${q.id}" hidden></label>` : ''}</div>`;
    }
    if (q.type === 'audio') {
      const r = st.rec;
      return `<div class="row" style="gap:8px">
        <button class="btn sm ${r ? 'ghost' : 'coral'}" data-act="qaRec" data-q="${q.id}">${ic('mic')}${r ? '重录' : '开始录音'}</button>
        ${r ? `<button class="btn sm ghost" data-act="qaPlay" data-q="${q.id}">${ic('speaker')}听一遍</button><span class="pill ok">${(r.durationMs / 1000).toFixed(1)} 秒</span>` : ''}</div>`;
    }
    return '';
  }

  function qShow(q, a) {
    if (!a) return '<div class="muted small">没有作答</div>';
    if (q.auto) return `<div class="q-my">我的答案：<b>${esc(fmtAnswer(q, a.value))}</b></div>`;
    if (q.type === 'text') return `<div class="q-my pre">${esc(a.value || '')}</div>`;
    if (q.type === 'photo') return `<div class="thumbs">${a.assets.map((x) => `<button class="thumb" data-act="zoom" data-src="${esc(x.url)}"><img src="${esc(x.url)}" alt="我的照片" loading="lazy"></button>`).join('')}</div>`;
    if (q.type === 'audio') return a.assets[0] ? `<button class="btn sm ghost" data-act="qaPlayUrl" data-url="${esc(a.assets[0].url)}">${ic('speaker')}听我的录音</button>` : '';
    return '';
  }

  function redrawQ(qid) {
    const el = document.getElementById('q-' + qid);
    const i = S.hw.questions.findIndex((q) => String(q.id) === String(qid));
    if (el && i >= 0) el.outerHTML = qCard(S.hw.questions[i], i, true);
  }

  /* ---------- 喜报 / 作品分享 ----------
   * 分享图在手机上画好传给服务器，服务器生成一个公开页 /s/xxx，页面底部有预约试听。
   * 默认只显示「李*明」，家长可以选择显示全名；分享随时可在「我的」里撤回。
   */
  function wrapLines(ctx, text, maxW, maxLines) {
    const lines = []; let line = '';
    for (const ch of String(text || '')) {
      if (ch === '\n') { lines.push(line); line = ''; continue; }
      if (ctx.measureText(line + ch).width > maxW && line) { lines.push(line); line = ch; } else line += ch;
    }
    if (line) lines.push(line);
    if (lines.length > maxLines) { lines.length = maxLines; lines[maxLines - 1] = lines[maxLines - 1].slice(0, -1) + '…'; }
    return lines;
  }

  function drawQR(ctx, text, x0, y0, size) {
    if (typeof window.qrcode !== 'function') return;
    const qr = window.qrcode(0, 'M'); qr.addData(text); qr.make();
    const n = qr.getModuleCount(), cell = size / n;
    ctx.fillStyle = INK_DEEP;
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) ctx.fillRect(x0 + c * cell, y0 + r * cell, Math.ceil(cell), Math.ceil(cell));
    }
  }

  async function posterHeader(ctx, W) {
    const logo = await loadImg('brand/logo-512.png') || await loadImg('brand/logo-192.png');
    if (logo) ctx.drawImage(logo, 80, 72, 104, 104);
    ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
    ctx.fillStyle = INK_DEEP; ctx.font = `700 40px ${SERIF}`;
    ctx.fillText('福斯特培训学校', logo ? 208 : 80, 126);
    ctx.fillStyle = TEXT3; ctx.font = `400 19px ${SANS}`;
    if ('letterSpacing' in ctx) ctx.letterSpacing = '5px';
    ctx.fillText('FIRST TRAINING SCHOOL', logo ? 208 : 80, 162);
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    ctx.fillStyle = LINE; ctx.fillRect(80, 224, W - 160, 2);
  }

  function posterFooter(ctx, W, title, link) {
    ctx.fillStyle = LINE; ctx.fillRect(80, 1240, W - 160, 2);
    ctx.fillStyle = INK_DEEP; ctx.font = `700 38px ${SERIF}`; ctx.textAlign = 'left';
    ctx.fillText(title, 80, 1318);
    ctx.fillStyle = INK; ctx.font = `400 26px ${SERIF}`;
    if ('letterSpacing' in ctx) ctx.letterSpacing = '2px';
    ctx.fillText('成为孩子期待的一堂课', 80, 1362);
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    const d = new Date();
    ctx.fillStyle = TEXT3; ctx.font = `400 22px ${SANS}`;
    ctx.fillText(`${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`, 80, 1400);
    drawQR(ctx, link, W - 80 - 150, 1262, 150);
  }

  const RED = '#D93A2B';

  async function drawPraise(info, name) {
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    const W = 1080, H = 1440;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, W, H);
    await posterHeader(ctx, W);

    // 「喜报」大字 + 朱红「优」印
    ctx.fillStyle = RED; ctx.font = `900 190px ${SERIF}`; ctx.textAlign = 'left';
    ctx.fillText('喜报', 70, 450);
    ctx.save(); ctx.translate(850, 360); ctx.rotate(-10 * Math.PI / 180);
    ctx.strokeStyle = RED; ctx.lineWidth = 9; ctx.strokeRect(-100, -100, 200, 200);
    ctx.lineWidth = 2; ctx.strokeRect(-84, -84, 168, 168);
    ctx.fillStyle = RED; ctx.textAlign = 'center'; ctx.font = `900 120px ${SERIF}`; ctx.fillText('优', 0, 42);
    ctx.restore();

    ctx.textAlign = 'left';
    ctx.fillStyle = INK_DEEP; ctx.font = `700 64px ${SERIF}`;
    ctx.fillText(`恭喜 ${name} 同学`, 80, 590);
    ctx.fillStyle = TEXT2; ctx.font = `400 34px ${SANS}`;
    const line = `${info.subject ? info.subject + '作业' : '作业'}「${info.title}」被老师评为优秀作业`;
    wrapLines(ctx, line, W - 160, 2).forEach((l, i) => ctx.fillText(l, 80, 656 + i * 50));

    let y = 790;
    if (info.maxScore) {
      ctx.fillStyle = INK; ctx.font = `700 96px ${SANS}`; ctx.fillText(fmtNum(info.score), 80, y + 60);
      const w = ctx.measureText(fmtNum(info.score)).width;
      ctx.fillStyle = TEXT3; ctx.font = `400 36px ${SANS}`; ctx.fillText(` / ${fmtNum(info.maxScore)} 分`, 80 + w, y + 60);
    }
    if (info.stars) {
      ctx.font = `400 60px ${SANS}`; ctx.textAlign = 'left';
      const sx = info.maxScore ? W - 80 - 5 * 64 : 80;
      for (let k = 0; k < 5; k++) { ctx.fillStyle = k < info.stars ? '#FFC23D' : WASH2; ctx.fillText('★', sx + k * 64, y + (info.maxScore ? 52 : 60)); }
    }

    if (info.comment) {
      y = 920;
      ctx.font = `400 36px ${SERIF}`;
      const lines = wrapLines(ctx, info.comment, W - 240, 3);
      const h = 96 + lines.length * 56;
      ctx.fillStyle = '#F4F2FC'; roundRect(ctx, 80, y, W - 160, h, 28); ctx.fill();
      ctx.fillStyle = TEXT3; ctx.font = `700 26px ${SANS}`; ctx.fillText('老师评语', 120, y + 58);
      ctx.fillStyle = INK_DEEP; ctx.font = `400 36px ${SERIF}`;
      lines.forEach((l, i) => ctx.fillText(l, 120, y + 118 + i * 56));
    }
    posterFooter(ctx, W, '扫码预约试听课', location.origin + '/trial');
    return cv.toDataURL('image/jpeg', 0.9);
  }

  async function drawWork(info, name) {
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    const W = 1080, H = 1440;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, W, H);
    await posterHeader(ctx, W);

    // 装裱：浅底衬纸 + 细线框，作品按原比例放进去
    const fx = 80, fy = 270, fw = W - 160, fh = 800;
    ctx.fillStyle = '#F6F3EC'; ctx.fillRect(fx, fy, fw, fh);
    const im = await loadImg(info.photo);
    if (im) {
      const pad = 40, k = Math.min((fw - pad * 2) / im.naturalWidth, (fh - pad * 2) / im.naturalHeight);
      const w = im.naturalWidth * k, h = im.naturalHeight * k;
      const x = fx + (fw - w) / 2, y = fy + (fh - h) / 2;
      ctx.fillStyle = 'rgba(0,0,0,.08)'; ctx.fillRect(x + 6, y + 8, w, h);
      ctx.drawImage(im, x, y, w, h);
    }
    ctx.strokeStyle = INK; ctx.lineWidth = 2; ctx.strokeRect(fx, fy, fw, fh);

    ctx.textAlign = 'left';
    ctx.fillStyle = INK_DEEP; ctx.font = `700 56px ${SERIF}`;
    ctx.fillText(`${name} 的书法作品`, 80, 1150);
    if (info.comment) {
      ctx.fillStyle = TEXT2; ctx.font = `400 30px ${SERIF}`;
      ctx.fillText('老师评语：' + wrapLines(ctx, info.comment, W - 320, 1)[0], 80, 1204);
    }
    if (info.excellent) {
      ctx.save(); ctx.translate(W - 150, 1130); ctx.rotate(-10 * Math.PI / 180);
      ctx.strokeStyle = RED; ctx.lineWidth = 6; ctx.strokeRect(-50, -50, 100, 100);
      ctx.fillStyle = RED; ctx.textAlign = 'center'; ctx.font = `900 64px ${SERIF}`; ctx.fillText('优', 0, 22);
      ctx.restore();
    }
    posterFooter(ctx, W, '扫码看书法作品展', location.origin + '/gallery');
    return cv.toDataURL('image/jpeg', 0.9);
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  function shareInfo(type) {
    const hw = S.hw, sub = hw.mySubmission || {};
    const photoQ = (hw.questions || []).find((q) => q.type === 'photo' && q.myAnswer && q.myAnswer.assets.length);
    return {
      type, submissionId: hw.submissionId, title: hw.title, subject: hw.subject ? hw.subject.name : '',
      score: hw.kind === 'questions' ? sub.score : null, maxScore: hw.kind === 'questions' ? sub.maxScore : null,
      stars: hw.stars, comment: hw.reviewText, excellent: hw.excellent,
      photo: photoQ ? photoQ.myAnswer.assets[0].url : null,
    };
  }

  async function drawSharePreview() {
    const box = document.getElementById('sh-preview');
    if (!box || !S.share) return;
    const full = document.getElementById('sh-full').checked;
    const name = full ? ((Store.user || {}).name || '同学') : maskName((Store.user || {}).name);
    box.style.opacity = '.5';
    S.share.image = await (S.share.info.type === 'work' ? drawWork(S.share.info, name) : drawPraise(S.share.info, name));
    box.src = S.share.image; box.style.opacity = '';
  }

  /* ---------- 我的 ---------- */
  const ME = {
    top: () => `<h1><img src="brand/logo-96.png" alt="">我的</h1>`,
    tab: true,
    body: async () => {
      // 五个接口一起发，等一次网络就够了（原来渲染完还要再等两次）
      const [sum, me, allShares, archive, rewards] = await Promise.all([
        API.get('/api/study/summary'), API.get('/api/me'), API.get('/api/shares/mine').catch(() => []),
        API.get('/api/me/archive').catch(() => null), API.get('/api/rewards').catch(() => null)]);
      S.archive = archive; S.rewards = rewards;
      const shares = allShares.filter((x) => x.status === 'active');   // 撤回的不再列出
      const map = {}; sum.days.forEach((d) => { map[d.date] = d; });
      const cells = [];
      for (let i = 27; i >= 0; i--) {
        const d = dayKey(Date.now() - i * 86400000);
        cells.push(`<div class="${map[d] && map[d].seconds >= sum.needSeconds ? 'on' : ''}">${Number(d.slice(8))}</div>`);
      }
      return `
        <div class="hero">
          <div class="row" style="gap:14px">
            <div class="avatar">${esc(((Store.user || {}).name || '同').slice(-2))}</div>
            <div class="grow"><h2>${esc((Store.user || {}).name || '')}</h2>
              <div class="small">${me.classes.length ? [...new Set(me.classes.map((c) => c.subject ? c.subject.name : c.name))].map(esc).join(' · ') : '还没加入班级'}</div>
              <div class="level-line"><b>${levelOf(sum.stars).name}</b></div></div>
          </div>
          <div class="stats">
            <div><b>${sum.streak}</b><span>连续打卡</span></div>
            <div><b>${sum.stars}</b><span>星星</span></div>
            <div><b>${sum.totalMinutes}</b><span>累计分钟</span></div>
          </div></div>
        <div class="card"><div class="section-title mb">近 4 周打卡</div><div class="calendar">${cells.join('')}</div>
          <div class="muted small mt">当天学习满 ${Math.max(1, Math.round(sum.needSeconds / 60))} 分钟就盖一个印</div></div>
        <div class="card" id="ar-card"><div class="row between mb"><div class="section-title">我的课时</div>
            <button class="btn sm ghost" data-act="askLeave">请假</button></div>
          <div id="ar-body"><div class="muted small">加载中…</div></div>
        </div>
        <div class="card" id="rw-card"><div class="row between mb"><div class="section-title">星星奖品</div>
            <span class="star-pill">${ic('star')}<span>${sum.stars}</span></span></div>
          <div class="muted small">攒够星星就能换礼物，换好了去前台找老师领。</div>
          <div id="rw-list" class="mt"><div class="muted small">加载中…</div></div>
        </div>
        <div class="card"><div class="row between mb"><div class="section-title">我的班级</div>
            <button class="btn sm ghost" data-act="joinClass">+ 加入班级</button></div>
          ${me.classes.map((c) => `<div class="class-row">${subjTag(c.subject)}<span class="grow ellip">${esc(c.name)}</span>${c.gradeBand ? `<span class="muted small">${esc(c.gradeBand)}</span>` : ''}</div>`).join('')
            || '<div class="muted small">向老师要班级邀请码，报了几个科目就加入几个班</div>'}
        </div>
        <div class="card"><div class="row between"><div><div class="section-title">学习海报</div>
          <div class="muted small">把打卡和星星做成一张图，发给家人朋友</div></div>
          <button class="btn sm star" data-act="poster">生成</button></div></div>
        <div class="card"><div class="section-title">我的分享</div>
          ${shares.length ? shares.map((x) => `<div class="share-row ${x.status}">
            ${x.image ? `<img src="${esc(x.image)}" alt="">` : '<div class="ph">已撤回</div>'}
            <div class="grow"><div class="strong ellip">${esc(x.title)}</div>
              <div class="muted small">${x.status === 'active' ? `${x.views} 位亲友看过 · ` : ''}${fmtDate(x.createdAt)}</div></div>
            ${x.status === 'active' ? `<div class="share-acts"><a class="btn sm ghost" href="${esc(x.url)}?guide=1">再分享</a><button class="btn sm danger" data-act="shareRevoke" data-id="${x.id}">撤回</button></div>` : '<span class="pill">已撤回</span>'}
          </div>`).join('') : '<div class="muted small mt">作业被老师评为优秀后，可以生成喜报发给家人朋友</div>'}
        </div>
        <div class="card"><div class="row between"><span>切换账号</span><button class="btn sm grey" data-act="logout">退出登录</button></div></div>`;
    },
    after: () => { drawArchive(S.archive); drawRewards(S.rewards); },
  };

  /** 我的课时：剩多少、什么时候到期、最近上了几次课、请假记录 */
  const LEAVE_NAME = { pending: '待老师确认', approved: '已准假', rejected: '未准假' };
  const ATT_NAME2 = { present: '到课', leave: '请假', absent: '缺课' };
  async function drawArchive(pre) {
    const box = document.getElementById('ar-body');
    if (!box) return;
    try {
      const d = pre || await API.get('/api/me/archive');
      const list = d.packages.filter((p) => p.status !== 'finished');
      box.innerHTML = `
        <div class="row between"><div class="bigscore">${d.hours.leftHours}<small> 课时</small></div>
          ${d.hours.expiresAt ? `<span class="muted small">${esc(d.hours.expiresAt)} 到期</span>` : ''}</div>
        ${list.length ? list.map((p) => `<div class="muted small mt">${p.subject ? esc(p.subject.name) : '不限科目'}：
          共 ${p.sumHours} 课时，已上 ${p.usedHours}，剩 ${p.leftHours}${p.status === 'paused' ? '（停课中）'
            : p.expired ? '（已过期，请联系老师）' : ''}</div>`).join('')
          : '<div class="muted small mt">还没有课包，可以问老师</div>'}
        ${d.attendance.length ? `<div class="hr"></div><div class="muted small mb">最近上课</div>
          ${d.attendance.slice(0, 5).map((a) => `<div class="row between" style="padding:3px 0">
            <span class="small">${esc(a.date)} ${esc(a.className || '')}</span>
            <span class="muted small">${ATT_NAME2[a.status] || ''}${a.hours ? ` −${a.hours}` : ''}</span></div>`).join('')}` : ''}
        ${d.leaves.length ? `<div class="hr"></div><div class="muted small mb">我的请假</div>
          ${d.leaves.slice(0, 5).map((l) => `<div class="row between" style="padding:3px 0">
            <span class="small">${esc(l.date)}${l.reason ? ' · ' + esc(l.reason) : ''}</span>
            <span class="muted small">${LEAVE_NAME[l.status]}</span></div>`).join('')}` : ''}`;
    } catch (e) { box.innerHTML = `<div class="muted small">${esc(e.message)}</div>`; }
  }

  /** 奖品墙：显示进度，够了才能点兑换 */
  async function drawRewards(pre) {
    const box = document.getElementById('rw-list');
    if (!box) return;
    try {
      const d = pre || await API.get('/api/rewards');
      const pending = d.mine.filter((x) => x.status === 'pending');
      box.innerHTML = `${d.rewards.length ? d.rewards.map((r) => `
        <div class="rw-row">
          ${r.image ? `<img src="${esc(r.image.url)}" alt="">` : `<div class="rw-none">${ic('star')}</div>`}
          <div class="grow">
            <div class="strong">${esc(r.name)}</div>
            <div class="muted small">${r.stars} 颗星${r.note ? ' · ' + esc(r.note) : ''}</div>
            <div class="rw-bar"><i style="width:${Math.min(100, Math.round((d.stars / r.stars) * 100))}%"></i></div>
          </div>
          ${r.canRedeem
            ? `<button class="btn sm star" data-act="redeem" data-id="${r.id}" data-name="${esc(r.name)}" data-stars="${r.stars}">兑换</button>`
            : `<span class="muted small nowrap">还差 ${r.need}</span>`}
        </div>`).join('') : '<div class="muted small">老师还没有上架奖品</div>'}
        ${pending.length ? `<div class="muted small mt">已兑换待领取：${pending.map((x) => esc(x.rewardName)).join('、')}（去前台找老师领）</div>` : ''}`;
    } catch (e) { box.innerHTML = `<div class="muted small">${esc(e.message)}</div>`; }
  }

  /* ---------- 听力模式 ----------
   * 整课音频连续播放（不按句切片），靠时间轴判断当前在哪一句。
   * 这样句与句之间是原音频的自然停顿，锁屏后也能继续放；系统锁屏界面可以暂停、切句。
   */
  const fmtTime = (ms) => {
    const t = Math.max(0, Math.floor((ms || 0) / 1000));
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  };
  const LOOPS = [['lesson', '整课循环'], ['one', '单句循环'], ['off', '不循环']];
  const reduceMotion = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  const Listen = {
    el: null, data: null, idx: -1, loop: 'lesson', rate: 1, showCn: true,

    audio() {
      if (this.el) return this.el;
      const el = new Audio();
      el.preload = 'auto';
      el.addEventListener('timeupdate', () => this.onTime());
      el.addEventListener('play', () => this.syncButtons());
      el.addEventListener('pause', () => this.syncButtons());
      el.addEventListener('loadedmetadata', () => this.onTime());
      el.addEventListener('ended', () => {
        if (this.loop === 'lesson') { el.currentTime = 0; el.play().catch(() => {}); }
        else this.syncButtons();
      });
      this.el = el;
      return el;
    },
    playing() { return !!(this.el && !this.el.paused); },
    pause() { if (this.el) this.el.pause(); },
    stop() { if (this.el) { this.el.pause(); } },

    async load(lessonId) {
      const d = await API.get(`/api/lessons/${lessonId}/transcript`, 300000);
      const el = this.audio();
      if (!this.data || this.data.lesson.id !== d.lesson.id) {
        this.pause();
        el.src = d.lesson.audio.url;
        this.idx = -1;
      }
      this.data = d;
      return d;
    },

    play() {
      Clip.stop();
      player.stop();
      const el = this.audio();
      el.playbackRate = this.rate;
      el.play().catch(() => toast('播放失败，请再点一次'));
      this.mediaSession();
    },
    toggle() { if (this.playing()) this.pause(); else this.play(); },

    seekTo(i) {
      const s = this.data && this.data.sentences[i];
      if (!s) return;
      this.audio().currentTime = s.startMs / 1000;
      this.setIdx(i);
      if (!this.playing()) this.play();
    },
    prev() {
      if (!this.data) return;
      const cur = this.data.sentences[this.idx];
      // 当前句已经放了一会儿，先回到本句开头；刚开始放，才退到上一句
      if (cur && this.el.currentTime * 1000 - cur.startMs > 1500) this.seekTo(this.idx);
      else this.seekTo(Math.max(0, this.idx - 1));
    },
    next() { if (this.data && this.idx < this.data.sentences.length - 1) this.seekTo(this.idx + 1); },

    onTime() {
      if (!this.data || !this.el) return;
      const t = this.el.currentTime * 1000;
      const list = this.data.sentences;
      const cur = list[this.idx];
      if (this.loop === 'one' && cur && t >= cur.endMs) { this.el.currentTime = cur.startMs / 1000; return; }
      let i = -1;
      for (let k = 0; k < list.length; k++) { if (list[k].startMs <= t + 60) i = k; else break; }
      if (i !== this.idx) this.setIdx(i);
      const dur = (this.el.duration || this.data.lesson.audio.durationMs / 1000) * 1000;
      const bar = document.getElementById('ls-seek');
      if (bar && !bar.dataset.dragging) bar.value = dur ? String(Math.round((t / dur) * 1000)) : '0';
      const now = document.getElementById('ls-now'); if (now) now.textContent = fmtTime(t);
      const end = document.getElementById('ls-dur'); if (end) end.textContent = fmtTime(dur);
    },

    setIdx(i) {
      const old = document.getElementById('ln-' + this.idx);
      if (old) old.classList.remove('on');
      this.idx = i;
      const el = document.getElementById('ln-' + i);
      if (el) {
        el.classList.add('on');
        el.scrollIntoView({ block: 'center', behavior: reduceMotion() ? 'auto' : 'smooth' });
      }
    },

    syncButtons() {
      const b = document.getElementById('ls-play');
      if (b) { b.textContent = this.playing() ? '暂停' : '播放'; b.setAttribute('aria-pressed', this.playing()); }
    },

    mediaSession() {
      if (!('mediaSession' in navigator) || !this.data) return;
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: this.data.lesson.title, artist: '福斯特培训学校', album: this.data.book.title,
          artwork: [{ src: 'brand/logo-192.png', sizes: '192x192', type: 'image/png' }],
        });
        navigator.mediaSession.setActionHandler('play', () => this.play());
        navigator.mediaSession.setActionHandler('pause', () => this.pause());
        navigator.mediaSession.setActionHandler('previoustrack', () => this.prev());
        navigator.mediaSession.setActionHandler('nexttrack', () => this.next());
      } catch (e) {}
    },
  };
  App.registerPlayer(Listen);

  const LISTENLIST = {
    top: () => `<h1><img src="brand/logo-96.png" alt="">听力</h1>`,
    tab: true,
    body: async () => {
      const books = await API.get('/api/listening', 300000);
      if (!books.length) {
        return `<div class="empty">还没有带音频的课文<br><span class="small">老师在内容后台给课文上传音频后，这里就能听</span></div>`;
      }
      return `<div class="muted small mb">整课连续播放，锁屏后也能继续听</div>` + books.map((b) => `
        <div class="card">
          <div class="section-title mb">${esc(b.bookTitle)}</div>
          ${b.lessons.map((l) => `
            <div class="listitem" data-go="listen" data-arg='${JSON.stringify({ lessonId: l.id })}'>
              <div class="n">听</div>
              <div class="grow"><div class="strong ellip">${esc(l.title)}</div>
                <div class="muted small">${l.sentenceCount} 句 · ${fmtTime(l.durationMs)}</div></div>
              <span class="muted">›</span>
            </div>`).join('')}
        </div>`).join('');
    },
  };

  const LISTEN = {
    top: () => `<button class="back" data-go="listenlist" aria-label="返回">‹</button><h1>听力</h1>
      <button class="iconbtn ${Listen.showCn ? 'on' : ''}" data-act="lsCn" aria-label="显示中文" aria-pressed="${Listen.showCn}">译</button>`,
    cls: 'view no-tab listen-view',
    body: async () => {
      const d = await Listen.load(S.lessonId);
      const loopText = LOOPS.find((x) => x[0] === Listen.loop)[1];
      return `
        <div class="listen-head">
          <div class="muted small">${esc(d.book.title)}</div>
          <div class="listen-title">${esc(d.lesson.title)}</div>
        </div>
        <div class="listen-lines ${Listen.showCn ? '' : 'hide-cn'}" id="ls-lines">
          ${d.sentences.map((s, i) => `
            <button class="ln" id="ln-${i}" data-act="lsSeek" data-i="${i}">
              <span class="ln-en">${esc(s.en)}</span>
              ${s.cn ? `<span class="ln-cn">${esc(s.cn)}</span>` : ''}
            </button>`).join('')}
        </div>
        <div class="listen-bar">
          <input type="range" id="ls-seek" min="0" max="1000" value="0" aria-label="播放进度">
          <div class="row between small muted"><span id="ls-now">0:00</span><span id="ls-dur">${fmtTime(d.lesson.audio.durationMs)}</span></div>
          <div class="listen-ctrls">
            <button class="btn sm grey" data-act="lsLoop" id="ls-loop">${loopText}</button>
            <button class="iconbtn" data-act="lsPrev" aria-label="上一句">上</button>
            <button class="ls-play" data-act="lsToggle" id="ls-play" aria-pressed="false">播放</button>
            <button class="iconbtn" data-act="lsNext" aria-label="下一句">下</button>
            <button class="btn sm grey" data-act="lsRate" id="ls-rate">${Listen.rate.toFixed(2).replace(/0$/, '')}×</button>
          </div>
        </div>`;
    },
    after: () => {
      const bar = document.getElementById('ls-seek');
      bar.addEventListener('input', () => {
        bar.dataset.dragging = '1';
        const el = Listen.audio();
        if (el.duration) el.currentTime = (Number(bar.value) / 1000) * el.duration;
      });
      bar.addEventListener('change', () => { delete bar.dataset.dragging; });
      if (Listen.idx >= 0) Listen.setIdx(Listen.idx);
      Listen.syncButtons();
      Listen.onTime();
    },
  };

  /* ---------- 学习海报 ----------
   * 学生自愿分享学习记录。刻意不和积分挂钩：微信禁止用奖励诱导分享。
   */
  const SERIF = '"Songti SC","Noto Serif SC","Noto Serif CJK SC","Source Han Serif SC",serif';
  const SANS = '-apple-system,"PingFang SC","Noto Sans SC","Noto Sans CJK SC","Microsoft YaHei",sans-serif';
  const INK = '#2B1A6E', INK_DEEP = '#1C1147', LINE = '#E6E3EF', TEXT2 = '#6E6A80', TEXT3 = '#A8A4B8', WASH2 = '#E9E5F4';

  const loadImg = (src) => new Promise((res) => {
    const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = src;
  });

  function drawStamp(ctx, cx, cy, r, on, label, lineW) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2);
    if (on) {
      ctx.rotate(-8 * Math.PI / 180);
      ctx.setLineDash([]); ctx.lineWidth = lineW; ctx.strokeStyle = INK; ctx.stroke();
      ctx.fillStyle = INK; ctx.font = `700 ${Math.round(r * 0.8)}px ${SERIF}`;
    } else {
      ctx.setLineDash([6, 7]); ctx.lineWidth = 2; ctx.strokeStyle = WASH2; ctx.stroke();
      ctx.fillStyle = TEXT3; ctx.font = `400 ${Math.round(r * 0.62)}px ${SANS}`;
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(label, 0, 2);
    ctx.restore();
  }

  async function drawPoster() {
    const [sum, me, hws] = await Promise.all([API.get('/api/study/summary'), API.get('/api/me'), API.get('/api/homeworks')]);
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    const W = 1080, H = 1440;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, W, H);

    // 抬头：校徽 + 校名
    const logo = await loadImg('brand/logo-512.png') || await loadImg('brand/logo-192.png');
    if (logo) ctx.drawImage(logo, 80, 72, 104, 104);
    ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
    ctx.fillStyle = INK_DEEP; ctx.font = `700 40px ${SERIF}`;
    ctx.fillText('福斯特培训学校', logo ? 208 : 80, 126);
    ctx.fillStyle = TEXT3; ctx.font = `400 19px ${SANS}`;
    if ('letterSpacing' in ctx) ctx.letterSpacing = '5px';
    ctx.fillText('FIRST TRAINING SCHOOL', logo ? 208 : 80, 162);
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    ctx.fillStyle = LINE; ctx.fillRect(80, 224, W - 160, 2);

    // 名字 + 大印章（连续打卡天数）
    const name = (me.user && me.user.name) || '同学';
    const cls = [...new Set((me.classes || []).map((c) => (c.subject ? c.subject.name : c.name)))].join('、');
    ctx.fillStyle = INK_DEEP; ctx.font = `700 76px ${SERIF}`;
    ctx.fillText(name, 80, 360);
    ctx.fillStyle = TEXT2; ctx.font = `400 30px ${SANS}`;
    ctx.fillText(cls ? `学习${cls} · 每天坚持打卡` : '每天坚持打卡', 80, 418);

    ctx.save();
    ctx.translate(820, 370); ctx.rotate(-8 * Math.PI / 180);
    ctx.beginPath(); ctx.arc(0, 0, 138, 0, Math.PI * 2);
    ctx.lineWidth = 10; ctx.strokeStyle = INK; ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, 118, 0, Math.PI * 2);
    ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = INK; ctx.textAlign = 'center';
    ctx.font = `400 28px ${SERIF}`; ctx.fillText('连续打卡', 0, -52);
    ctx.font = `700 ${String(sum.streak).length > 2 ? 92 : 112}px ${SERIF}`; ctx.fillText(String(sum.streak), 0, 44);
    ctx.font = `400 28px ${SERIF}`; ctx.fillText('天', 0, 88);
    ctx.restore();

    // 三个数字
    const done = hws.filter((h) => h.status === 'reviewed' || h.status === 'submitted').length;
    const stats = [[sum.stars, '累计星星'], [sum.totalMinutes, '累计分钟'], [done, '完成作业']];
    ctx.fillStyle = LINE; ctx.fillRect(80, 540, W - 160, 2);
    stats.forEach(([n, lbl], i) => {
      const x = 80 + i * 320;
      if (i) { ctx.fillStyle = LINE; ctx.fillRect(x - 24, 580, 2, 120); }
      ctx.textAlign = 'left';
      ctx.fillStyle = INK; ctx.font = `600 72px ${SANS}`; ctx.fillText(String(n), x + (i ? 16 : 0), 660);
      ctx.fillStyle = TEXT3; ctx.font = `400 26px ${SANS}`; ctx.fillText(lbl, x + (i ? 16 : 0), 704);
    });
    ctx.fillStyle = LINE; ctx.fillRect(80, 744, W - 160, 2);

    // 近 4 周的印
    ctx.fillStyle = INK_DEEP; ctx.font = `700 32px ${SERIF}`; ctx.textAlign = 'left';
    ctx.fillText('近 4 周打卡', 80, 820);
    const map = {}; (sum.days || []).forEach((d) => { map[d.date] = d.seconds; });
    const colW = (W - 160) / 7;
    for (let i = 27; i >= 0; i--) {
      const k = 27 - i;
      const key = dayKey(Date.now() - i * 86400000);
      const on = (map[key] || 0) >= sum.needSeconds;
      drawStamp(ctx, 80 + colW * (k % 7) + colW / 2, 890 + Math.floor(k / 7) * 96, 36, on,
        on ? '读' : String(Number(key.slice(8))), 5);
    }

    // 底部：二维码
    ctx.fillStyle = LINE; ctx.fillRect(80, 1240, W - 160, 2);
    ctx.fillStyle = INK_DEEP; ctx.font = `700 40px ${SERIF}`; ctx.textAlign = 'left';
    ctx.fillText('扫码，和我一起学习', 80, 1318);
    ctx.fillStyle = INK; ctx.font = `400 27px ${SERIF}`;
    if ('letterSpacing' in ctx) ctx.letterSpacing = '2px';
    ctx.fillText('成为孩子期待的一堂课', 80, 1362);
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    const d = new Date();
    ctx.fillStyle = TEXT3; ctx.font = `400 22px ${SANS}`;
    ctx.fillText(`${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`, 80, 1400);
    if (typeof window.qrcode === 'function') {
      const qr = window.qrcode(0, 'M');
      qr.addData(location.origin + location.pathname.replace(/[^/]*$/, ''));
      qr.make();
      const n = qr.getModuleCount(), size = 150, cell = size / n, x0 = W - 80 - size, y0 = 1262;
      ctx.fillStyle = INK_DEEP;
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
        if (qr.isDark(r, c)) ctx.fillRect(x0 + c * cell, y0 + r * cell, Math.ceil(cell), Math.ceil(cell));
      }
    }
    return cv.toDataURL('image/jpeg', 0.92);
  }

  const isWeChat = () => /MicroMessenger/i.test(navigator.userAgent);

  /** hosted=true 表示是服务器上的真实图片地址（微信里长按能保存、能识别二维码） */
  function showPoster(url, hosted) {
    closePoster();
    const t = document.getElementById('toast'); if (t) t.classList.remove('show');   // 收起"正在生成海报"提示
    const wx = isWeChat();
    const m = document.createElement('div');
    m.className = 'poster-mask'; m.id = 'poster';
    m.innerHTML = `
      <div class="poster-sheet" role="dialog" aria-label="学习海报">
        <img src="${url}" alt="我的学习海报">
        ${wx ? `<div class="save-tip">
            <b>长按上面的图片</b>，选「保存图片」存到手机，<br>或选「发送给朋友」直接分享
            ${hosted ? '' : '<div class="muted small mt">如果长按没有保存选项，请截屏保存</div>'}
          </div>
          <button class="btn block" data-act="closePoster">完成</button>`
        : `<div class="muted small center">长按图片保存，或点下面的按钮</div>
          <div class="row" style="gap:10px">
            <a class="btn ghost grow" href="${url}" download="福斯特学习海报.jpg">保存图片</a>
            <button class="btn grow" data-act="closePoster">完成</button>
          </div>`}
      </div>`;
    m.addEventListener('click', (e) => { if (e.target === m) closePoster(); });
    document.getElementById('app').appendChild(m);
  }
  function closePoster() { const m = document.getElementById('poster'); if (m) m.remove(); }

  /** 翻到指定页：停掉正在放的声音；正在录音时不翻，免得录音丢失 */
  function turnTo(pageId) {
    if (Rec.mr) { toast('先点一下录音按钮结束录音，再翻页'); return; }
    player.stop();
    go('reader', { pageId });
    $view.scrollTop = 0;
  }

  function greeting() {
    const h = new Date().getHours();
    return h < 6 ? '夜深了' : h < 11 ? '早上好' : h < 14 ? '中午好' : h < 18 ? '下午好' : '晚上好';
  }

  /** 近 7 天的打卡印章：读满当天就盖一个印 */
  function sealRow(sum) {
    const map = {}; (sum.days || []).forEach((d) => { map[d.date] = d.seconds; });
    const W = '日一二三四五六';
    const cells = [];
    for (let i = 6; i >= 0; i--) {
      const key = dayKey(Date.now() - i * 86400000);
      const on = (map[key] || 0) >= sum.needSeconds;
      const weekday = W[new Date(key + 'T12:00:00Z').getUTCDay()];
      cells.push(`<div class="seal-cell"><div class="seal ${on ? 'on' : ''} ${i === 0 ? 'today' : ''}">${on ? '读' : ''}</div>${i === 0 ? '今天' : weekday}</div>`);
    }
    return `<div class="seal-row mt" aria-label="近 7 天打卡">${cells.join('')}</div>`;
  }

  const VIEWS = { login: LOGIN, home: HOME, shelf: SHELF, catalog: CATALOG, reader: READER, hwlist: HWLIST, hwdetail: HWDETAIL, me: ME, listenlist: LISTENLIST, listen: LISTEN };

  /* ---------- 动作 ---------- */
  const ACT = {
    async joinClass() {
      const code = (prompt('输入老师给的班级邀请码') || '').trim();
      if (!code) return;
      try { const c = await API.post('/api/classes/join', { inviteCode: code }); toast(`已加入「${c.name}」`); render(); }
      catch (e) { toast(e.message); }
    },
    pickSubj(el) { S.subj = el.dataset.code; render(); },
    async askLeave() {
      const me = await API.get('/api/me');
      const date = (prompt('请哪天的假？（格式 2026-09-20）', dayKey(Date.now() + 86400000)) || '').trim();
      if (!date) return;
      const classId = me.classes.length === 1 ? me.classes[0].id : null;
      const reason = (prompt('原因（老师会看到，可不填）', '') || '').trim();
      try {
        await API.post('/api/leaves', { date, classId, reason });
        toast('已提交，等老师确认', 2600); render();
      } catch (e) { toast(e.message, 2600); }
    },
    async redeem(el) {
      if (!confirm(`用 ${el.dataset.stars} 颗星换「${el.dataset.name}」？换了之后星星会扣掉，去前台找老师领。`)) return;
      el.disabled = true;
      try {
        const r = await API.post(`/api/rewards/${el.dataset.id}/redeem`);
        celebrate({ mark: '换', label: esc(r.name), title: '换好啦', sub: '去前台找老师领奖品', gain: 0 });
        render();
      } catch (e) { toast(e.message, 2600); el.disabled = false; }
    },
    zoom(el) { lightbox(el.dataset.src); },
    qaPick(el) {
      const q = S.hw.questions.find((x) => String(x.id) === el.dataset.q), k = Number(el.dataset.k);
      const st = S.ans[q.id] || (S.ans[q.id] = {});
      if (q.type === 'single') st.value = k;
      else { const v = Array.isArray(st.value) ? st.value : []; st.value = v.includes(k) ? v.filter((x) => x !== k) : [...v, k]; }
      redrawQ(q.id);
    },
    qaJudge(el) { S.ans[el.dataset.q] = { value: el.dataset.v === '1' }; redrawQ(el.dataset.q); },
    qaPhotoDel(el) { const st = S.ans[el.dataset.q]; st.photos.splice(Number(el.dataset.k), 1); redrawQ(el.dataset.q); },
    async qaRec(el) {
      const qid = el.dataset.q;
      if (!Rec.mr) {
        try { await Rec.start(); S.recQ = qid; el.innerHTML = `${ic('mic')}停止`; el.classList.add('recording'); toast('录音中…'); }
        catch (e) { toast(e.message); }
      } else {
        if (S.recQ !== qid) return toast('先停止正在进行的录音');
        const r = await Rec.stop();
        (S.ans[qid] || (S.ans[qid] = {})).rec = r;
        S.recQ = null; redrawQ(qid);
      }
    },
    qaPlay(el) { const st = S.ans[el.dataset.q]; if (st && st.rec) Clip.play(st.rec.url, el); },
    qaPlayUrl(el) { Clip.play(el.dataset.url, el); },
    qaRedo() { S.editing = S.hw.id; render(); },
    async qaSubmit(el) {
      if (Rec.mr) return toast('先停止录音');
      const qs = S.hw.questions;
      const answers = [];
      let blank = 0;
      for (const [i, q] of qs.entries()) {
        const st = S.ans[q.id] || {};
        if (q.auto) {
          const v = st.value;
          const empty = v == null || (Array.isArray(v) && !v.some((x) => String(x == null ? '' : x).trim()));
          if (empty) blank++;
          answers.push({ questionId: q.id, value: empty ? null : v });
        } else if (q.type === 'text') {
          if (!String(st.value || '').trim()) return toast(`第 ${i + 1} 题还没写`);
          answers.push({ questionId: q.id, value: st.value });
        } else if (q.type === 'photo') {
          if (!(st.photos && st.photos.length)) return toast(`第 ${i + 1} 题还没拍照`);
          answers.push({ questionId: q.id, photos: st.photos.map((p) => p.base64) });
        } else if (q.type === 'audio') {
          if (!st.rec) return toast(`第 ${i + 1} 题还没录音`);
          answers.push({ questionId: q.id, audioBase64: st.rec.base64, ext: st.rec.ext, durationMs: st.rec.durationMs });
        }
      }
      if (blank && !confirm(`还有 ${blank} 道题没做，确定交吗？`)) return;
      el.disabled = true; el.textContent = '提交中…';
      try {
        const r = await API.post(`/api/homeworks/${S.hw.id}/answers`, { answers, elapsedSec: accum });
        S.editing = null;
        if (r.status === 'reviewed') {
          const stars = Math.max(1, Math.min(5, Math.round((r.maxScore ? r.score / r.maxScore : 0) * 5)));
          celebrate({ mark: fmtNum(r.score), label: `满分 ${fmtNum(r.maxScore)}`, title: r.score >= r.maxScore ? '全对！' : '分数出来啦',
            sub: r.score >= r.maxScore ? '一道都没错' : '看看错在哪里，下次就会了', gain: 5 + stars * 2 });
          render();
        } else {
          celebrate({ mark: '交', label: '作业已提交', title: '作业交上啦', sub: '老师批改后，这里就能看到分数和评语', gain: 5 });
          go('hwlist');
        }
      } catch (e) { toast(e.message, 2600); el.disabled = false; el.textContent = '提交作业'; }
    },
    async shareOpen(el) {
      const info = shareInfo(el.dataset.type);
      S.share = { info, image: null };
      closePoster();
      const m = document.createElement('div');
      m.className = 'poster-mask'; m.id = 'poster';
      m.innerHTML = `<div class="poster-sheet" role="dialog" aria-label="${info.type === 'work' ? '分享书法作品' : '生成喜报'}">
          <img id="sh-preview" alt="分享图预览">
          <label class="check"><input type="checkbox" id="sh-full"><span>显示孩子全名<br><span class="muted small">不勾选时只显示「${esc(maskName((Store.user || {}).name))}」</span></span></label>
          <div class="muted small">分享出去的页面可以随时在「我的 → 我的分享」里撤回</div>
          <div class="row" style="gap:10px">
            <button class="btn ghost grow" data-act="closePoster">取消</button>
            <button class="btn grow" data-act="shareCreate">生成分享页</button>
          </div>
        </div>`;
      m.addEventListener('click', (e) => { if (e.target === m) closePoster(); });
      document.getElementById('app').appendChild(m);
      try { await drawSharePreview(); } catch (e) { toast('分享图生成失败：' + e.message); }
    },
    async shareCreate(el) {
      if (!S.share || !S.share.image) return toast('分享图还在生成，稍等一下');
      el.disabled = true; el.textContent = '生成中…';
      try {
        const r = await API.post('/api/shares', {
          type: S.share.info.type, submissionId: S.share.info.submissionId,
          imageBase64: S.share.image, showFullName: document.getElementById('sh-full').checked,
        });
        location.href = r.url + '?guide=1';
      } catch (e) { toast(e.message); el.disabled = false; el.textContent = '生成分享页'; }
    },
    async shareRevoke(el) {
      if (!confirm('撤回后，别人再打开这个链接就看不到了。确定撤回？')) return;
      try { await API.post(`/api/shares/${el.dataset.id}/revoke`); toast('已撤回'); render(); }
      catch (e) { toast(e.message); }
    },
    lsToggle() { Listen.toggle(); },
    lsPrev() { Listen.prev(); },
    lsNext() { Listen.next(); },
    lsSeek(el) { Listen.seekTo(Number(el.dataset.i)); },
    lsLoop(el) {
      const i = (LOOPS.findIndex((x) => x[0] === Listen.loop) + 1) % LOOPS.length;
      Listen.loop = LOOPS[i][0]; el.textContent = LOOPS[i][1];
      toast(LOOPS[i][1]);
    },
    lsRate(el) {
      const seq = [0.75, 1, 1.25];
      Listen.rate = seq[(seq.indexOf(Listen.rate) + 1) % seq.length];
      if (Listen.el) Listen.el.playbackRate = Listen.rate;
      el.textContent = Listen.rate.toFixed(2).replace(/0$/, '') + '×';
    },
    lsCn(el) {
      Listen.showCn = !Listen.showCn;
      el.classList.toggle('on', Listen.showCn); el.setAttribute('aria-pressed', Listen.showCn);
      const box = document.getElementById('ls-lines'); if (box) box.classList.toggle('hide-cn', !Listen.showCn);
    },
    async poster(el) {
      const plain = !el.querySelector('*');
      const label = el.textContent;
      if (plain) el.textContent = '生成中…'; else toast('正在生成海报…', 1200);
      try {
        const dataUrl = await drawPoster();
        // 传到服务器换成真实图片地址；失败就先直接显示，不耽误看海报
        let url = dataUrl, hosted = false;
        try {
          const r = await API.post('/api/posters', { imageBase64: dataUrl });
          if (r && r.url) { url = r.url; hosted = true; }
        } catch (e) {}
        showPoster(url, hosted);
      } catch (e) { toast('海报生成失败：' + e.message); }
      finally { if (plain) el.textContent = label; }
    },
    closeCelebrate() { const m = document.getElementById('celebrate'); if (m) m.remove(); },
    closePoster() { closePoster(); },
    async login() {
      const name = document.getElementById('i-name').value.trim();
      const code = document.getElementById('i-code').value.trim().toUpperCase();
      if (!name) return toast('请填写姓名');
      try {
        const d = await API.post('/api/auth/dev-login', { role: 'student', name, inviteCode: code });
        Store.token = d.token; Store.user = d.user;
        go('home');
      } catch (e) { toast(e.message); }
    },
    logout() { Store.clear(); go('login'); },
    turnPage(el) { const pid = Number(el.dataset.pid); if (pid) turnTo(pid); },
    leaveReader() { player.stop(); S.hwHotspotIds = null; go(S.catalog ? 'catalog' : 'shelf', { bookId: S.catalog ? S.catalog.book.id : null }); },
    toggleHs() { S.showHs = !S.showHs; document.querySelectorAll('.hs').forEach((el) => el.classList.toggle('show', S.showHs)); $top.innerHTML = READER.top(); },
    toggleRepeat(el) { S.repeat = !S.repeat; el.classList.toggle('on', S.repeat); toast(S.repeat ? '单句复读：开' : '单句复读：关'); },
    cycleRate() {
      const seq = [0.75, 1, 1.25]; const i = (seq.indexOf(player.rate) + 1) % seq.length;
      player.setRate(seq[i]); document.getElementById('btn-rate').textContent = seq[i].toFixed(2).replace(/0$/, '') + '×';
    },
    tapHs(el) {
      const i = Number(el.dataset.i);
      const hs = S.page.hotspots[i];
      if (player.current && player.current.id === hs.id) { player.stop(); return; }
      const loop = () => player.play(hs, S.repeat ? loop : null);
      loop();
    },
    playAll() {
      if (player.current) { player.stopped = true; player.stop(); document.getElementById('btn-all').textContent = '连播'; return; }
      document.getElementById('btn-all').textContent = '停止';
      player.stopped = false;
      player.playList(S.page.hotspots, 0, null, () => { document.getElementById('btn-all').textContent = '连播'; });
    },
    async recToggle(el) {
      const tip = document.getElementById('rec-tip');
      if (!Rec.mr) {
        try { await Rec.start(); el.classList.add('recording'); tip.textContent = '● 录音中，再点一次结束'; }
        catch (e) { toast(e.message); }
      } else {
        const r = await Rec.stop();
        el.classList.remove('recording');
        tip.textContent = `已录 ${(r.durationMs / 1000).toFixed(1)}s`;
        S.myRec = r;
        document.getElementById('btn-myrec').hidden = false;
      }
    },
    playMyRec(el) { if (S.myRec) Clip.play(S.myRec.url, el); },

    hwOpenPage() { S.hwHotspotIds = S.hw.items.map((i) => i.hotspotId); go('reader', { pageId: S.hw.pageId }); },
    hwPlay(el) {
      const it = S.hw.items[Number(el.dataset.i)];
      player.play({ id: it.hotspotId, en: it.en, startMs: it.startMs, endMs: it.endMs, audio: it.audio || S.hw.lessonAudio });
    },
    async hwRec(el) {
      const hid = Number(el.dataset.hid);
      if (!Rec.mr) {
        try { await Rec.start(); el.textContent = '停止'; el.classList.add('accent'); toast('录音中…'); }
        catch (e) { toast(e.message); }
      } else {
        const r = await Rec.stop();
        S.recs[hid] = { url: r.url, base64: r.base64, ext: r.ext, durationMs: r.durationMs };
        const i = S.hw.items.findIndex((x) => x.hotspotId === hid);
        document.getElementById('sent-' + hid).outerHTML = itemHtml(S.hw.items[i], i);
        toast('录好了，可以试听');
      }
    },
    hwPlayRec(el) { const r = S.recs[Number(el.dataset.hid)]; if (r && r.url) Clip.play(r.url, el); },
    async hwSubmit(el) {
      const items = S.hw.items
        .filter((it) => S.recs[it.hotspotId] && S.recs[it.hotspotId].base64)
        .map((it) => {
          const r = S.recs[it.hotspotId];
          // 字段名必须是 audioBase64（和服务端、小程序端一致）；之前发的是 base64，录音被服务端静默丢弃
          return { hotspotId: it.hotspotId, audioBase64: r.base64, ext: r.ext, durationMs: r.durationMs };
        });
      if (!items.length) return toast('至少录一句再提交');
      el.disabled = true; el.textContent = '提交中…';
      try {
        await API.post(`/api/homeworks/${S.hw.id}/submit`, { items, elapsedSec: accum });
        celebrate({ mark: '交', label: '作业已提交', title: '作业交上啦', sub: '老师批改后，这里就能看到星星和评语', gain: 5 });
        go('hwlist');
      } catch (e) { toast(e.message); el.disabled = false; el.textContent = '提交作业'; }
    },
  };

  /* ---------- 启动 ---------- */
  (async function boot() {
    if (!Store.token) return go('login');
    try { await API.get('/api/me'); go('home'); }
    catch { go('login'); }
  })();
})();
