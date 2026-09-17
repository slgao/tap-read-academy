/* 学生端 —— 这一份 H5 的交互与数据流，与 miniprogram/ 下的小程序版本一一对应 */
(function () {
  'use strict';
  const { Store, API, toast, esc, fmtDate, starStr, Player, Rec, Clip } = App;
  const $view = document.getElementById('view');
  const $top = document.getElementById('topbar');
  const $tab = document.getElementById('tabbar');
  const player = new Player();

  const S = { view: 'home', book: null, catalog: null, page: null, hw: null, showHs: false, repeat: false, recs: {} };
  let accum = 0, pending = 0;

  /* ---------- 学习时长心跳 ---------- */
  setInterval(async () => {
    if (player.current || (typeof Listen !== 'undefined' && Listen.playing())) { accum += 5; pending += 5; }
    if (pending >= 15 && Store.token) {
      const s = pending; pending = 0;
      try {
        const r = await API.post('/api/study/heartbeat', { seconds: s });
        if (r.justChecked) toast(`打卡成功，连续 ${r.streak} 天`, 2600);
      } catch {}
    }
  }, 5000);

  /* ---------- 路由 ---------- */
  function go(view, data) {
    Clip.stop();
    closePoster();
    if (view !== 'reader') player.stop();
    if (view !== 'listen') Listen.stop();
    S.view = view;
    Object.assign(S, data || {});
    render();
  }
  window.addEventListener('popstate', () => { if (S.view !== 'home') go('home'); });

  function render() {
    const V = VIEWS[S.view] || VIEWS.home;
    $top.innerHTML = V.top();
    $view.className = V.bare ? 'reader' : (V.cls || (V.noTab ? 'view no-tab' : 'view'));
    $view.innerHTML = '<div class="empty">加载中…</div>';
    $tab.hidden = !V.tab;
    if (V.tab) renderTab();
    Promise.resolve(V.body()).then((html) => {
      $view.innerHTML = html;
      if (V.after) V.after();
    }).catch((e) => { $view.innerHTML = `<div class="empty">${esc(e.message)}</div>`; });
  }

  function renderTab() {
    const items = [['home', '首页'], ['shelf', '教材'], ['listenlist', '听力'], ['hwlist', '作业'], ['me', '我的']];
    $tab.innerHTML = items.map(([k, t]) =>
      `<button class="${S.view === k ? 'on' : ''}" data-go="${k}">${t}</button>`).join('');
  }

  document.addEventListener('click', (e) => {
    const g = e.target.closest('[data-go]');
    if (g) { go(g.dataset.go, g.dataset.arg ? JSON.parse(g.dataset.arg) : null); return; }
    const a = e.target.closest('[data-act]');
    if (a) { (ACT[a.dataset.act] || (() => {}))(a); }
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
        <div class="tag">点读课文 · 完成作业 · 每日打卡</div>
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
    top: () => `<h1><img src="brand/logo-96.png" alt="">福斯特</h1><span class="sub">${esc((Store.user || {}).name || '')}</span>`,
    tab: true,
    body: async () => {
      const [sum, hws, books] = await Promise.all([
        API.get('/api/study/summary'), API.get('/api/homeworks'), API.get('/api/books'),
      ]);
      const todo = hws.filter((h) => h.status === 'todo' || h.status === 'rejected');
      // 只算今天；sum.days[0] 是最近有记录的一天，不一定是今天
      const todayRow = sum.days.find((d) => d.date === new Date().toISOString().slice(0, 10));
      const mins = Math.round((todayRow ? todayRow.seconds : 0) / 60);
      return `
      <div class="hero">
        <h2>${greeting()}，${esc((Store.user || {}).name || '同学')}</h2>
        <div class="small">${sum.checkedInToday ? '今天的印已经盖上了' : `今天读满 ${Math.round(sum.needSeconds / 60) || 1} 分钟，就能盖上今天的印`}</div>
        ${sealRow(sum)}
        <div class="row between mt"><span></span><a class="small" style="color:var(--ink)" data-act="poster" role="button">生成学习海报 ›</a></div>
        <div class="stats">
          <div><b>${sum.streak}</b><span>连续打卡天数</span></div>
          <div><b>${sum.stars}</b><span>星星</span></div>
          <div><b>${mins}</b><span>今天读了几分钟</span></div>
        </div>
      </div>

      <div class="card">
        <div class="row between mb"><div class="section-title">今日作业</div><span class="pill ${todo.length ? 'todo' : 'ok'}">${todo.length ? todo.length + ' 项待完成' : '全部完成'}</span></div>
        ${todo.length ? todo.slice(0, 3).map((h, i) => `
          <div class="listitem" data-go="hwdetail" data-arg='${JSON.stringify({ hwId: h.id })}'>
<div class="n">${i + 1}</div>
            <div class="grow"><div class="strong ellip">${esc(h.title)}</div><div class="muted small">${h.itemCount} 句 · ${esc(h.className)}</div></div>
            <span class="muted">›</span>
          </div>`).join('') : '<div class="muted small">老师还没有布置新作业</div>'}
      </div>

      <div class="card">
        <div class="row between mb"><div class="section-title">教材</div><a class="small" style="color:var(--ink)" data-go="shelf">全部 ›</a></div>
        ${books.map((b) => `
          <div class="booktile" data-go="catalog" data-arg='${JSON.stringify({ bookId: b.id })}'>
<div class="cv">${esc(b.title.slice(0, 1))}</div>
            <div class="grow"><div class="strong ellip">${esc(b.title)}</div>
              <div class="muted small ellip">${esc(b.subtitle || '')}</div>
              <div class="muted small">${b.lessonCount} 课 · ${b.pageCount} 页</div></div>
            <span class="muted">›</span>
          </div>`).join('')}
      </div>`;
    },
  };

  /* ---------- 书架 ---------- */
  const SHELF = {
    top: () => `<h1><img src="brand/logo-96.png" alt="">教材</h1>`,
    tab: true,
    body: async () => {
      const books = await API.get('/api/books');
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
    top: () => `<button class="back" data-go="shelf">‹</button><h1>${esc((S.catalog && S.catalog.book.title) || '目录')}</h1>`,
    noTab: true,
    body: async () => {
      const data = await API.get(`/api/books/${S.bookId}/catalog`);
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
      <h1>${esc((S.page && S.page.lesson.title) || '点读')} <span class="sub">P${(S.page && S.page.page.pageNo) || ''}</span></h1>
      <button class="iconbtn ${S.showHs ? 'on' : ''}" data-act="toggleHs" title="显示/隐藏热区">框</button>`,
    bare: true,
    body: async () => {
      const d = await API.get(`/api/pages/${S.pageId}`);
      S.page = d; S.hsIdx = -1;
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
            <button class="btn sm" data-act="playAll" id="btn-all">连播</button>
            <button class="iconbtn ${S.repeat ? 'on' : ''}" data-act="toggleRepeat" title="单句复读">⟳</button>
            <button class="iconbtn" data-act="cycleRate" id="btn-rate" style="font-size:12px;font-weight:700">1.0×</button>
            <button class="iconbtn ${player.mode === 'audio' ? 'on' : ''}" data-act="toggleSrc" id="btn-src" style="font-size:11px;font-weight:700" title="TTS 朗读 / 原始音轨">${player.mode === 'tts' ? 'TTS' : '原音'}</button>
            <div class="grow"></div>
            <button class="iconbtn rec" data-act="recToggle" id="btn-rec">录</button>
            <button class="iconbtn" data-act="playMyRec" id="btn-myrec" hidden>听</button>
          </div>
          <div class="muted small mt" style="display:flex;justify-content:space-between">
            <span>${d.prevPageId ? '‹ 上一页' : ''}</span>
            <span id="rec-tip"></span>
            <span>${d.nextPageId ? '下一页 ›' : ''}</span>
          </div>
        </div>`;
    },
    after: () => {
      player.onTick((hs) => {
        document.querySelectorAll('.hs').forEach((el) => el.classList.remove('active'));
        if (!hs) return;
        const i = S.page.hotspots.findIndex((h) => h.id === hs.id);
        const el = document.querySelector(`.hs[data-i="${i}"]`);
        if (el) { el.classList.add('active'); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
        document.getElementById('sub-en').textContent = hs.en || '';
        document.getElementById('sub-cn').textContent = hs.cn || '';
      });
      const pw = $view.querySelector('.pagewrap');
      if (pw) {
        pw.addEventListener('click', (e) => {
          if (e.target.closest('.hs')) return;
        });
      }
    },
  };

  /* ---------- 作业列表 ---------- */
  const HWLIST = {
    top: () => `<h1><img src="brand/logo-96.png" alt="">作业</h1>`,
    tab: true,
    body: async () => {
      const hws = await API.get('/api/homeworks');
      if (!hws.length) return `<div class="empty">还没有作业</div>`;
      const P = { todo: ['todo', '待完成'], submitted: ['warn', '已提交'], reviewed: ['ok', '已批改'], rejected: ['todo', '需重做'] };
      return hws.map((h) => {
        const [cls, txt] = P[h.status] || P.todo;
        return `<div class="hwitem" data-go="hwdetail" data-arg='${JSON.stringify({ hwId: h.id })}'>
          <div class="row between"><div class="strong ellip grow">${esc(h.title)}</div><span class="pill ${cls}">${txt}</span></div>
          <div class="muted small mt">${h.itemCount} 句跟读 · ${esc(h.className)} · ${fmtDate(h.createdAt)}</div>
          ${h.status === 'reviewed' ? `<div class="mt row" style="gap:8px"><span class="stars">${starStr(h.stars)}</span><span class="muted small ellip">${esc(h.reviewText || '')}</span></div>` : ''}
        </div>`;
      }).join('');
    },
  };

  /* ---------- 作业详情 ---------- */
  const HWDETAIL = {
    top: () => `<button class="back" data-go="hwlist">‹</button><h1>${esc((S.hw && S.hw.title) || '作业')}</h1>`,
    noTab: true,
    body: async () => {
      const hw = await API.get(`/api/homeworks/${S.hwId}`);
      S.hw = hw; S.recs = {};
      if (hw.mySubmission) (hw.mySubmission.items || []).forEach((it) => { S.recs[it.hotspotId] = { url: it.audio && it.audio.url, saved: true }; });
      $top.innerHTML = HWDETAIL.top();
      const done = hw.status === 'reviewed';
      return `
        <div class="card tight mb">
          <div class="row between"><span class="muted small">${esc(hw.className)} · ${hw.itemCount} 句</span>
          <span class="pill ${done ? 'ok' : hw.status === 'submitted' ? 'warn' : 'todo'}">${done ? '已批改' : hw.status === 'submitted' ? '已提交' : '待完成'}</span></div>
          ${hw.note ? `<div class="mt small">老师说：${esc(hw.note)}</div>` : ''}
          ${done ? `<div class="hr"></div><div class="row" style="gap:8px"><span class="stars">${starStr(hw.stars)}</span><span class="small">${esc(hw.reviewText || '')}</span></div>` : ''}
        </div>
        <div class="row between mb">
          <button class="btn sm ghost" data-act="hwOpenPage">打开课本页</button>
          <button class="iconbtn ${player.mode === 'audio' ? 'on' : ''}" data-act="toggleSrc" style="font-size:11px;font-weight:700">${player.mode === 'tts' ? 'TTS' : '原音'}</button>
        </div>
        <div id="hw-items">${hw.items.map((it, i) => itemHtml(it, i)).join('')}</div>
        ${done ? '' : `<button class="btn block mt" data-act="hwSubmit" id="btn-submit">提交作业</button>`}
        <div class="muted small center mt">录音需要麦克风权限（localhost 下可用）</div>`;
    },
  };

  function itemHtml(it, i) {
    const rec = S.recs[it.hotspotId];
    return `<div class="sentence ${rec ? 'done' : ''}" id="sent-${it.hotspotId}">
      <div class="en">${i + 1}. ${esc(it.en)}</div>
      <div class="cn">${esc(it.cn || '')}</div>
      <div class="row" style="gap:8px">
        <button class="btn sm grey" data-act="hwPlay" data-i="${i}">原音</button>
        <button class="btn sm ${rec ? 'ghost' : ''}" data-act="hwRec" data-hid="${it.hotspotId}" data-i="${i}">${rec ? '重录' : '跟读'}</button>
        ${rec && rec.url ? `<button class="btn sm grey" data-act="hwPlayRec" data-hid="${it.hotspotId}">我的</button>` : ''}
        ${rec ? '<span class="pill ok">已录</span>' : ''}
      </div>
    </div>`;
  }

  /* ---------- 我的 ---------- */
  const ME = {
    top: () => `<h1><img src="brand/logo-96.png" alt="">我的</h1>`,
    tab: true,
    body: async () => {
      const sum = await API.get('/api/study/summary');
      const me = await API.get('/api/me');
      const map = {}; sum.days.forEach((d) => { map[d.date] = d; });
      const cells = [];
      for (let i = 27; i >= 0; i--) {
        const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
        cells.push(`<div class="${map[d] && map[d].seconds >= sum.needSeconds ? 'on' : ''}">${Number(d.slice(8))}</div>`);
      }
      return `
        <div class="hero"><h2>${esc((Store.user || {}).name || '')}</h2>
          <div class="small">${me.classes.map((c) => esc(c.name)).join('、') || '还没加入班级'}</div>
          <div class="stats">
            <div><b>${sum.streak}</b><span>连续打卡</span></div>
            <div><b>${sum.stars}</b><span>星星</span></div>
            <div><b>${sum.totalMinutes}</b><span>累计分钟</span></div>
          </div></div>
        <div class="card"><div class="section-title mb">近 4 周打卡</div><div class="calendar">${cells.join('')}</div>
          <div class="muted small mt">当天点读满 ${sum.needSeconds} 秒就盖一个印（正式版为 5 分钟）</div></div>
        <div class="card"><div class="row between"><div><div class="section-title">学习海报</div>
          <div class="muted small">把打卡和星星做成一张图，发给家人朋友</div></div>
          <button class="btn sm" data-act="poster">生成</button></div></div>
        <div class="card"><div class="row between"><span>切换账号</span><button class="btn sm grey" data-act="logout">退出登录</button></div></div>`;
    },
  };

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
      const d = await API.get(`/api/lessons/${lessonId}/transcript`);
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
      const books = await API.get('/api/listening');
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
    const cls = (me.classes || []).map((c) => c.name).join('、');
    ctx.fillStyle = INK_DEEP; ctx.font = `700 76px ${SERIF}`;
    ctx.fillText(name, 80, 360);
    ctx.fillStyle = TEXT2; ctx.font = `400 30px ${SANS}`;
    ctx.fillText(cls ? `${cls} · 每天坚持读英语` : '每天坚持读英语', 80, 418);

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
      const dt = new Date(Date.now() - i * 86400000);
      const on = (map[dt.toISOString().slice(0, 10)] || 0) >= sum.needSeconds;
      drawStamp(ctx, 80 + colW * (k % 7) + colW / 2, 890 + Math.floor(k / 7) * 96, 36, on,
        on ? '读' : String(dt.getDate()), 5);
    }

    // 底部：二维码
    ctx.fillStyle = LINE; ctx.fillRect(80, 1240, W - 160, 2);
    ctx.fillStyle = INK_DEEP; ctx.font = `700 40px ${SERIF}`; ctx.textAlign = 'left';
    ctx.fillText('扫码，和我一起读', 80, 1330);
    const d = new Date();
    ctx.fillStyle = TEXT3; ctx.font = `400 24px ${SANS}`;
    ctx.fillText(`${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`, 80, 1378);
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
    return cv.toDataURL('image/png');
  }

  function showPoster(url) {
    closePoster();
    const m = document.createElement('div');
    m.className = 'poster-mask'; m.id = 'poster';
    m.innerHTML = `
      <div class="poster-sheet" role="dialog" aria-label="学习海报">
        <img src="${url}" alt="我的学习海报">
        <div class="muted small center">长按图片保存，或直接发给朋友</div>
        <div class="row" style="gap:10px">
          <a class="btn ghost grow" href="${url}" download="福斯特学习海报.png">保存图片</a>
          <button class="btn grow" data-act="closePoster">完成</button>
        </div>
      </div>`;
    m.addEventListener('click', (e) => { if (e.target === m) closePoster(); });
    document.getElementById('app').appendChild(m);
  }
  function closePoster() { const m = document.getElementById('poster'); if (m) m.remove(); }

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
      const dt = new Date(Date.now() - i * 86400000);
      const key = dt.toISOString().slice(0, 10);
      const on = (map[key] || 0) >= sum.needSeconds;
      cells.push(`<div class="seal-cell"><div class="seal ${on ? 'on' : ''} ${i === 0 ? 'today' : ''}">${on ? '读' : ''}</div>${i === 0 ? '今天' : W[dt.getDay()]}</div>`);
    }
    return `<div class="seal-row mt" aria-label="近 7 天打卡">${cells.join('')}</div>`;
  }

  const VIEWS = { login: LOGIN, home: HOME, shelf: SHELF, catalog: CATALOG, reader: READER, hwlist: HWLIST, hwdetail: HWDETAIL, me: ME, listenlist: LISTENLIST, listen: LISTEN };

  /* ---------- 动作 ---------- */
  const ACT = {
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
      const label = el.textContent;
      el.textContent = '生成中…';
      try { showPoster(await drawPoster()); }
      catch (e) { toast('海报生成失败：' + e.message); }
      finally { el.textContent = label; }
    },
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
    leaveReader() { player.stop(); S.hwHotspotIds = null; go(S.catalog ? 'catalog' : 'shelf', { bookId: S.catalog ? S.catalog.book.id : null }); },
    toggleHs() { S.showHs = !S.showHs; document.querySelectorAll('.hs').forEach((el) => el.classList.toggle('show', S.showHs)); $top.innerHTML = READER.top(); },
    toggleRepeat(el) { S.repeat = !S.repeat; el.classList.toggle('on', S.repeat); toast(S.repeat ? '单句复读：开' : '单句复读：关'); },
    cycleRate() {
      const seq = [0.75, 1, 1.25]; const i = (seq.indexOf(player.rate) + 1) % seq.length;
      player.setRate(seq[i]); document.getElementById('btn-rate').textContent = seq[i].toFixed(2).replace(/0$/, '') + '×';
    },
    toggleSrc(el) {
      player.mode = player.mode === 'tts' ? 'audio' : 'tts';
      el.textContent = player.mode === 'tts' ? 'TTS' : '原音';
      el.classList.toggle('on', player.mode === 'audio');
      toast(player.mode === 'tts' ? '已切换为浏览器 TTS 朗读' : '已切换为原始音轨（按时间区间 seek）');
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
        .map((it) => ({ hotspotId: it.hotspotId, ...S.recs[it.hotspotId] }));
      if (!items.length) return toast('至少录一句再提交');
      el.disabled = true; el.textContent = '提交中…';
      try {
        await API.post(`/api/homeworks/${S.hw.id}/submit`, { items, elapsedSec: accum });
        toast('提交成功');
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
