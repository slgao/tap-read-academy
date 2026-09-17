/* 老师端：班级管理 / 布置作业 / 批改 */
(function () {
  'use strict';
  const { Store, API, toast, esc, fmtDate, starStr, Player, Clip } = App;
  const $view = document.getElementById('view');
  const $top = document.getElementById('topbar');
  const $tab = document.getElementById('tabbar');
  const player = new Player();
  const S = { view: 'classes', pick: { bookId: null, pageId: null, sel: [] } };

  function go(v, d) { Clip.stop(); player.stop(); S.view = v; Object.assign(S, d || {}); render(); }

  function render() {
    const V = VIEWS[S.view] || VIEWS.classes;
    $top.innerHTML = V.top();
    $view.className = V.noTab ? 'view no-tab' : 'view';
    $view.innerHTML = '<div class="empty">加载中…</div>';
    $tab.hidden = !V.tab;
    if (V.tab) $tab.innerHTML = [['classes', '班级'], ['hwlist', '作业'], ['me', '我的']]
      .map(([k, t]) => `<button class="${S.view === k ? 'on' : ''}" data-go="${k}">${t}</button>`).join('');
    Promise.resolve(V.body()).then((h) => { $view.innerHTML = h; if (V.after) V.after(); })
      .catch((e) => { $view.innerHTML = `<div class="empty">${esc(e.message)}</div>`; });
  }

  document.addEventListener('click', (e) => {
    const g = e.target.closest('[data-go]');
    if (g) return go(g.dataset.go, g.dataset.arg ? JSON.parse(g.dataset.arg) : null);
    const a = e.target.closest('[data-act]');
    if (a) (ACT[a.dataset.act] || (() => {}))(a, e);
  });

  const LOGIN = {
    top: () => `<h1>老师登录</h1>`, noTab: true,
    body: () => `<div class="login-brand">
        <img src="brand/logo-192.png" alt="福斯特培训学校校徽">
        <div class="name">福斯特培训学校</div>
        <div class="en">FIRST TRAINING SCHOOL</div>
        <div class="tag">布置作业 · 批改跟读 · 查看班级</div>
      </div>
      <div class="card">
        <label class="field"><span>姓名</span><input id="i-name" value="王老师"></label>
        <label class="field"><span>老师口令</span><input id="i-tcode" type="password" placeholder="本地开发可不填"></label>
        <button class="btn block" data-act="login">进入老师端</button>
        <div class="muted small mt center">演示账号：王老师（已有「六年级 A 班」）</div>
      </div>`,
  };

  const CLASSES = {
    top: () => `<h1><img src="brand/logo-96.png" alt="">班级</h1><button class="btn sm ghost" data-act="newClass">+ 新建</button>`, tab: true,
    body: async () => {
      const cs = await API.get('/api/classes');
      if (!cs.length) return `<div class="empty">还没有班级<br><span class="small">点右上角新建</span></div>`;
      const blocks = [];
      for (const c of cs) {
        const ss = await API.get(`/api/classes/${c.id}/students`);
        blocks.push(`<div class="card">
          <div class="row between"><div class="strong">${esc(c.name)}</div><span class="pill blue">邀请码 ${esc(c.inviteCode)}</span></div>
          <div class="muted small mt">${ss.length} 名学生 · 学生在登录页输入邀请码即可加入</div>
          <div class="hr"></div>
          ${ss.length ? ss.map((s, i) => `<div class="row between" style="padding:6px 0">
<span><i class="rank ${i < 3 ? 'top' : ''}">${i + 1}</i>${esc(s.name)}</span>
              <span class="muted small">${s.stars} 星 · 连续 ${s.streak} 天</span></div>`).join('')
            : '<div class="muted small">还没有学生加入</div>'}
        </div>`);
      }
      return blocks.join('');
    },
  };

  const HWLIST = {
    top: () => `<h1><img src="brand/logo-96.png" alt="">作业</h1><button class="btn sm" data-go="hwnew">+ 布置</button>`, tab: true,
    body: async () => {
      const hws = await API.get('/api/homeworks');
      if (!hws.length) return `<div class="empty">还没布置过作业<br><span class="small">点右上角「+ 布置」</span></div>`;
      return hws.map((h) => `<div class="hwitem" data-go="review" data-arg='${JSON.stringify({ hwId: h.id })}'>
        <div class="row between"><div class="strong ellip grow">${esc(h.title)}</div>
          <span class="pill ${h.submitted >= h.total && h.total ? 'ok' : 'warn'}">${h.submitted}/${h.total} 已交</span></div>
        <div class="muted small mt">${h.itemCount} 句 · ${esc(h.className)} · ${fmtDate(h.createdAt)}
          ${h.reviewed ? ` · 已批改 ${h.reviewed}` : ''}</div>
      </div>`).join('');
    },
  };

  const HWNEW = {
    top: () => `<button class="back" data-go="hwlist">‹</button><h1>布置作业</h1>`, noTab: true,
    body: async () => {
      const [classes, books] = await Promise.all([API.get('/api/classes'), API.get('/api/books')]);
      if (!classes.length) return `<div class="empty">请先建班级</div>`;
      S.pick.bookId = S.pick.bookId || (books[0] && books[0].id);
      return `<div class="card">
        <label class="field"><span>班级</span><select id="f-class">${classes.map((c) => `<option value="${c.id}">${esc(c.name)}（${c.studentCount}人）</option>`).join('')}</select></label>
        <label class="field"><span>教材</span><select id="f-book" data-act="pickBook">${books.map((b) => `<option value="${b.id}">${esc(b.title)}</option>`).join('')}</select></label>
        <label class="field"><span>页面</span><select id="f-page" data-act="pickPage"><option>加载中…</option></select></label>
      </div>
      <div class="card"><div class="row between mb"><div class="strong">选择要跟读的句子</div>
        <button class="btn sm grey" data-act="selAll">全选</button></div>
        <div id="hs-list"><div class="muted small">请先选页面</div></div></div>
      <div class="card">
        <label class="field"><span>作业标题</span><input id="f-title" placeholder="例如：Lesson 1 前四句 跟读"></label>
        <label class="field"><span>给学生的话（可选）</span><textarea id="f-note" rows="2" placeholder="注意 name 的发音…"></textarea></label>
        <button class="btn block" data-act="createHw">发布作业</button>
      </div>`;
    },
    after: async () => { await loadPages(); },
  };

  async function loadPages() {
    const bookId = document.getElementById('f-book').value;
    const cat = await API.get(`/api/books/${bookId}/catalog`);
    const opts = [];
    cat.lessons.forEach((l) => l.pages.forEach((p) => opts.push(`<option value="${p.id}">${esc(l.title)} · 第 ${p.pageNo} 页（${p.hotspotCount} 句）</option>`)));
    document.getElementById('f-page').innerHTML = opts.join('') || '<option value="">（无页面）</option>';
    await loadHotspots();
  }
  async function loadHotspots() {
    const pid = document.getElementById('f-page').value;
    if (!pid) return;
    const d = await API.get(`/api/pages/${pid}`);
    S.pick.pageId = Number(pid); S.pick.hotspots = d.hotspots; S.pick.sel = [];
    document.getElementById('hs-list').innerHTML = d.hotspots.map((h, i) => `
      <label class="row" style="gap:10px;padding:7px 0;align-items:flex-start">
        <input type="checkbox" class="hs-ck" value="${h.id}" style="width:18px;height:18px;flex:0 0 auto;margin-top:3px">
        <span class="grow"><span class="strong small">${i + 1}. ${esc(h.en)}</span><br><span class="muted small">${esc(h.cn || '')}</span></span>
      </label>`).join('') || '<div class="muted small">该页还没有点读热区，请先在内容后台标注</div>';
  }

  const REVIEW = {
    top: () => `<button class="back" data-go="hwlist">‹</button><h1>批改</h1>`, noTab: true,
    body: async () => {
      const d = await API.get(`/api/homeworks/${S.hwId}/submissions`);
      S.rev = d;
      return `<div class="card tight mb"><div class="strong">${esc(d.homework.title)}</div>
        <div class="muted small mt">${esc(d.homework.className)} · ${d.homework.itemCount} 句 · 已交 ${d.homework.submitted}/${d.homework.total}</div></div>
        ${d.rows.map((r, ri) => `
        <div class="card">
          <div class="row between">
            <div class="strong">${esc(r.studentName)}</div>
            <span class="pill ${r.status === 'reviewed' ? 'ok' : r.status === 'submitted' ? 'warn' : 'todo'}">
              ${r.status === 'reviewed' ? '已批改' : r.status === 'submitted' ? '待批改' : '未提交'}</span>
          </div>
          ${r.items.length ? `<div class="mt">${r.items.map((it, ii) => `
            <div class="row between" style="padding:5px 0">
              <span class="small ellip grow">${ii + 1}. ${esc(it.en)}</span>
              <button class="btn sm grey" data-act="playRec" data-url="${esc(it.audio ? it.audio.url : '')}">试听</button>
            </div>`).join('')}</div>` : '<div class="muted small mt">未提交录音</div>'}
          ${r.submissionId ? `
            <div class="hr"></div>
            <div class="row between mb"><span class="muted small">评星</span>
              <span class="stars" data-act="setStar" data-ri="${ri}" id="st-${ri}">${starStr(r.stars || 5)}</span></div>
            <textarea id="rv-${ri}" rows="2" placeholder="一句评语，学生和家长都能看到">${esc(r.reviewText || '')}</textarea>
            <div class="row mt" style="gap:8px">
              <button class="btn sm grow" data-act="doReview" data-ri="${ri}">提交批改</button>
              <button class="btn sm danger" data-act="doReject" data-ri="${ri}">打回重做</button>
            </div>` : ''}
        </div>`).join('')}`;
    },
  };

  const ME = {
    top: () => `<h1><img src="brand/logo-96.png" alt="">我的</h1>`, tab: true,
    body: async () => {
      const st = await API.get('/api/admin/stats');
      return `<div class="hero"><h2>${esc((Store.user || {}).name || '')}</h2><div class="small">福斯特培训学校 · 老师</div>
        <div class="stats"><div><b>${st.students}</b><span>学生</span></div><div><b>${st.homeworks}</b><span>作业</span></div>
        <div><b>${st.submissions}</b><span>提交</span></div></div></div>
      <div class="card"><div class="section-title mb">教材内容</div>
        <div class="row between"><span class="muted small">教材 ${st.books} 本 · 页面 ${st.pages} 页 · 热区 ${st.hotspots} 个</span>
        <a class="btn sm ghost" href="admin.html" target="_blank">打开内容后台</a></div></div>
      <div class="card"><div class="row between"><span>切换账号</span><button class="btn sm grey" data-act="logout">退出登录</button></div></div>`;
    },
  };

  const VIEWS = { login: LOGIN, classes: CLASSES, hwlist: HWLIST, hwnew: HWNEW, review: REVIEW, me: ME };

  const ACT = {
    async login() {
      const name = document.getElementById('i-name').value.trim();
      if (!name) return toast('请填写姓名');
      try { const d = await API.post('/api/auth/dev-login', { role: 'teacher', name, teacherCode: document.getElementById('i-tcode').value }); Store.token = d.token; Store.user = d.user; go('classes'); }
      catch (e) { toast(e.message); }
    },
    logout() { Store.clear(); go('login'); },
    async newClass() {
      const name = prompt('班级名称', '新班级');
      if (!name) return;
      try { const c = await API.post('/api/classes', { name }); toast('已创建，邀请码 ' + c.inviteCode, 2600); render(); }
      catch (e) { toast(e.message); }
    },
    pickBook() { loadPages(); },
    pickPage() { loadHotspots(); },
    selAll() {
      const cks = [...document.querySelectorAll('.hs-ck')];
      const all = cks.every((c) => c.checked);
      cks.forEach((c) => { c.checked = !all; });
    },
    async createHw(el) {
      const ids = [...document.querySelectorAll('.hs-ck:checked')].map((c) => Number(c.value));
      const title = document.getElementById('f-title').value.trim();
      if (!ids.length) return toast('请至少选一句');
      if (!title) return toast('请填写作业标题');
      el.disabled = true;
      try {
        await API.post('/api/homeworks', {
          classId: Number(document.getElementById('f-class').value),
          pageId: Number(document.getElementById('f-page').value),
          hotspotIds: ids, title, note: document.getElementById('f-note').value.trim(),
        });
        toast('作业已发布'); go('hwlist');
      } catch (e) { toast(e.message); el.disabled = false; }
    },
    playRec(el) { const u = el.dataset.url; if (!u) return toast('没有录音'); Clip.play(u, el); },
    setStar(el, ev) {
      const box = el.getBoundingClientRect();
      const n = Math.max(1, Math.min(5, Math.ceil((ev.clientX - box.left) / (box.width / 5))));
      el.dataset.val = n;
      el.innerHTML = starStr(n);
    },
    async doReview(el) {
      const ri = el.dataset.ri;
      const r = S.rev.rows[ri];
      const st = document.getElementById('st-' + ri);
      const stars = Number(st.dataset.val || r.stars || 5);
      try {
        await API.post(`/api/submissions/${r.submissionId}/review`,
          { stars, reviewText: document.getElementById('rv-' + ri).value.trim() });
        toast('批改完成 有'); render();
      } catch (e) { toast(e.message); }
    },
    async doReject(el) {
      const r = S.rev.rows[el.dataset.ri];
      try { await API.post(`/api/submissions/${r.submissionId}/reject`, { reviewText: document.getElementById('rv-' + el.dataset.ri).value.trim() || '请重新录一次' }); toast('已打回'); render(); }
      catch (e) { toast(e.message); }
    },
  };

  (async function boot() {
    if (!Store.token) return go('login');
    try { await API.get('/api/me'); go('classes'); } catch { go('login'); }
  })();
})();
