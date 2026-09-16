/* 学生端 —— 这一份 H5 的交互与数据流，与 miniprogram/ 下的小程序版本一一对应 */
(function () {
  'use strict';
  const { Store, API, toast, esc, fmtDate, starStr, Player, Rec } = App;
  const $view = document.getElementById('view');
  const $top = document.getElementById('topbar');
  const $tab = document.getElementById('tabbar');
  const player = new Player();

  const S = { view: 'home', book: null, catalog: null, page: null, hw: null, showHs: false, repeat: false, recs: {} };
  let accum = 0, pending = 0;

  /* ---------- 学习时长心跳 ---------- */
  setInterval(async () => {
    if (player.current) { accum += 5; pending += 5; }
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
    if (view !== 'reader') player.stop();
    S.view = view;
    Object.assign(S, data || {});
    render();
  }
  window.addEventListener('popstate', () => { if (S.view !== 'home') go('home'); });

  function render() {
    const V = VIEWS[S.view] || VIEWS.home;
    $top.innerHTML = V.top();
    $view.className = V.bare ? 'reader' : (V.noTab ? 'view no-tab' : 'view');
    $view.innerHTML = '<div class="empty">加载中…</div>';
    $tab.hidden = !V.tab;
    if (V.tab) renderTab();
    Promise.resolve(V.body()).then((html) => {
      $view.innerHTML = html;
      if (V.after) V.after();
    }).catch((e) => { $view.innerHTML = `<div class="empty">${esc(e.message)}</div>`; });
  }

  function renderTab() {
    const items = [['home', '首页'], ['shelf', '教材'], ['hwlist', '作业'], ['me', '我的']];
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
    top: () => `<h1>点读学堂 <span class="sub">学生端</span></h1>`,
    noTab: true,
    body: () => `
<div class="hero"><h2>欢迎回来</h2><div class="small" style="opacity:.9">输入姓名和班级邀请码即可开始</div></div>
      <div class="card">
        <label class="field"><span>我的姓名</span><input id="i-name" placeholder="例如：李小明" value="李小明"></label>
        <label class="field"><span>班级邀请码</span><input id="i-code" placeholder="6 位字母数字" value="DEMO88" style="text-transform:uppercase"></label>
        <button class="btn block" data-act="login">进入学习</button>
        <div class="muted small mt center">演示账号：李小明 / 张小红 / 刘小刚 &nbsp;·&nbsp; 邀请码 DEMO88</div>
      </div>
      <div class="card tight">
        <div class="muted small">这是体验版，内容为自编讲义样例。<br>所有操作只保存在你自己的手机上，不会上传，可随时清除。</div>
      </div>`,
  };

  /* ---------- 首页 ---------- */
  const HOME = {
    top: () => `<h1>点读学堂</h1><span class="pill blue">${esc((Store.user || {}).name || '')}</span>`,
    tab: true,
    body: async () => {
      const [sum, hws, books] = await Promise.all([
        API.get('/api/study/summary'), API.get('/api/homeworks'), API.get('/api/books'),
      ]);
      const todo = hws.filter((h) => h.status === 'todo' || h.status === 'rejected');
      const mins = Math.round((sum.days[0] ? sum.days[0].seconds : 0) / 60);
      return `
      <div class="hero">
        <h2>你好，${esc((Store.user || {}).name || '同学')}</h2>
<div class="small" style="opacity:.9">${sum.checkedInToday ?'今天已打卡，继续保持' :'今天还没打卡，读 1 分钟就能打卡'}</div>
        <div class="stats">
          <div><b>${sum.streak}</b><span>连续打卡(天)</span></div>
          <div><b>${sum.stars}</b><span>累计星星</span></div>
          <div><b>${mins}</b><span>今日(分钟)</span></div>
        </div>
      </div>

      <div class="card">
        <div class="row between mb"><div class="strong">今日作业</div><span class="pill ${todo.length ? 'todo' : 'ok'}">${todo.length ? todo.length + ' 项待完成' : '全部完成'}</span></div>
        ${todo.length ? todo.slice(0, 3).map((h, i) => `
          <div class="listitem" data-go="hwdetail" data-arg='${JSON.stringify({ hwId: h.id })}'>
<div class="n">${i + 1}</div>
            <div class="grow"><div class="strong ellip">${esc(h.title)}</div><div class="muted small">${h.itemCount} 句 · ${esc(h.className)}</div></div>
            <span class="muted">›</span>
          </div>`).join('') : '<div class="muted small">老师还没有布置新作业</div>'}
      </div>

      <div class="card">
        <div class="row between mb"><div class="strong">继续点读</div><a class="small" style="color:var(--primary)" data-go="shelf">全部教材 ›</a></div>
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
    top: () => `<h1>教材</h1>`,
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
    top: () => `<h1>作业</h1>`,
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
    top: () => `<h1>我的</h1>`,
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
          <div class="small" style="opacity:.9">${me.classes.map((c) => esc(c.name)).join('、') || '未加入班级'}</div>
          <div class="stats">
            <div><b>${sum.streak}</b><span>连续打卡</span></div>
            <div><b>${sum.stars}</b><span>星星</span></div>
            <div><b>${sum.totalMinutes}</b><span>累计分钟</span></div>
          </div></div>
        <div class="card"><div class="strong mb">近 4 周打卡</div><div class="calendar">${cells.join('')}</div>
          <div class="muted small mt">当日有效点读满 ${sum.needSeconds} 秒即算打卡（正式版为 5 分钟）</div></div>
        <div class="card"><div class="row between"><span>切换账号</span><button class="btn sm grey" data-act="logout">退出登录</button></div></div>`;
    },
  };

  const VIEWS = { login: LOGIN, home: HOME, shelf: SHELF, catalog: CATALOG, reader: READER, hwlist: HWLIST, hwdetail: HWDETAIL, me: ME };

  /* ---------- 动作 ---------- */
  const ACT = {
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
    playMyRec() { if (S.myRec) new Audio(S.myRec.url).play(); },

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
    hwPlayRec(el) { const r = S.recs[Number(el.dataset.hid)]; if (r && r.url) new Audio(r.url).play(); },
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
