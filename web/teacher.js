/* 老师端：班级管理 / 布置作业 / 批改 */
(function () {
  'use strict';
  const { Store, API, toast, esc, fmtDate, starStr, Player, Clip, compressImage, subjTag, TYPE_NAME, lightbox, LETTER, fmtAnswer, fmtKey, fmtNum } = App;
  const $view = document.getElementById('view');
  const $top = document.getElementById('topbar');
  const $tab = document.getElementById('tabbar');
  const player = new Player();
  const isAdmin = () => ((Store.user || {}).role === 'admin');

  const S = { view: 'classes', pick: { bookId: null, pageId: null, sel: [] }, newKind: 'questions', qs: [] };

  const TAB_IC = {
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14a6.5 6.5 0 0 1 3.5 6"/>',
    pencil: '<path d="M4 20l1.2-4.8L16 4.4a2 2 0 0 1 2.8 0l.8.8a2 2 0 0 1 0 2.8L8.8 18.8z"/><path d="M14 6.5l3.5 3.5"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    phone: '<path d="M6.5 3.5h3l1.5 4.5-2 1.5a11 11 0 0 0 5.5 5.5l1.5-2 4.5 1.5v3a2 2 0 0 1-2 2A16 16 0 0 1 4.5 5.5a2 2 0 0 1 2-2z"/>',
  };

  function go(v, d) { Clip.stop(); player.stop(); S.view = v; Object.assign(S, d || {}); render(); }

  function render() {
    const V = VIEWS[S.view] || VIEWS.classes;
    $top.innerHTML = V.top();
    $view.className = V.noTab ? 'view no-tab' : 'view';
    $view.innerHTML = '<div class="empty">加载中…</div>';
    $tab.hidden = !V.tab;
    const tabs = [['classes', '班级', TAB_IC.users], ['hwlist', '作业', TAB_IC.pencil]];
    if (isAdmin()) tabs.push(['leads', '咨询', TAB_IC.phone]);      // 家长手机号只给负责人看
    tabs.push(['me', '我的', TAB_IC.user]);
    if (V.tab) $tab.innerHTML = tabs
      .map(([k, t, icon]) => `<button class="${S.view === k ? 'on' : ''}" data-go="${k}" aria-label="${t}"><span class="tab-ic"><svg class="i" viewBox="0 0 24 24" aria-hidden="true">${icon}</svg></span>${t}</button>`).join('');
    return Promise.resolve(V.body()).then((h) => { $view.innerHTML = h; if (V.after) V.after(); })
      .catch((e) => { $view.innerHTML = `<div class="empty">${esc(e.message)}</div>`; });
  }

  document.addEventListener('click', (e) => {
    const g = e.target.closest('[data-go]');
    if (g) return go(g.dataset.go, g.dataset.arg ? JSON.parse(g.dataset.arg) : null);
    const a = e.target.closest('[data-act]');
    if (a) (ACT[a.dataset.act] || (() => {}))(a, e);
  });

  document.addEventListener('input', (e) => {
    const el = e.target, f = el.dataset.qf;
    if (!f) return;
    const q = S.qs[Number(el.dataset.i)]; if (!q) return;
    if (f === 'opt') q.options[Number(el.dataset.k)] = el.value;
    else if (f === 'blank') q.blanks[Number(el.dataset.k)] = el.value;
    else q[f] = el.value;
  });
  document.addEventListener('change', async (e) => {
    const el = e.target;
    if (el.id === 'f-class' && S.view === 'hwnew') {
      S.newClassId = Number(el.value);
      const title = document.getElementById('f-title'), note = document.getElementById('f-note');
      const keep = { t: title ? title.value : '', n: note ? note.value : '' };
      await render();
      const t2 = document.getElementById('f-title'), n2 = document.getElementById('f-note');
      if (t2) t2.value = keep.t; if (n2) n2.value = keep.n;
      return;
    }
    if (el.dataset.qimg != null) {
      const f = el.files && el.files[0]; if (!f) return;
      try { S.qs[Number(el.dataset.qimg)].img = await compressImage(f, 2000, 0.85); drawQs(); }
      catch (err) { toast(err.message); }
    }
    if (el.dataset.leadStatus) {
      try { await API.put('/api/admin/leads/' + el.dataset.leadStatus, { status: el.value }); toast('已更新'); }
      catch (err) { toast(err.message); }
    }
    if (el.dataset.leadNote) {
      try { await API.put('/api/admin/leads/' + el.dataset.leadNote, { note: el.value.trim() }); toast('备注已保存'); }
      catch (err) { toast(err.message); }
    }
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
        <label class="field"><span>姓名</span><input id="i-name" placeholder="例如：李老师"></label>
        <label class="field"><span>口令</span><input id="i-tcode" type="password" inputmode="numeric" placeholder="6 位数字" autocomplete="off"></label>
        <button class="btn block" data-act="login">进入老师端</button>
        <div class="muted small mt center">口令找负责人要；负责人用自己的主口令登录</div>
      </div>`,
  };

  /* ---------- 班级：按科目开班，同一科目按年级段分班 ---------- */
  const CLASSES = {
    top: () => `<h1><img src="brand/logo-96.png" alt="">班级</h1><button class="btn sm ghost" data-go="classform" data-arg='{"clsId":null}'>+ 新建</button>`, tab: true,
    body: async () => {
      const cs = await API.get('/api/classes');
      if (!cs.length) return `<div class="empty">还没有班级<br><span class="small">点右上角新建，先选科目和年级段</span></div>`;
      const groups = [];
      for (const c of cs) {
        const key = c.subject ? c.subject.code : '';
        let g = groups.find((x) => x.key === key);
        if (!g) groups.push(g = { key, subject: c.subject, list: [] });
        g.list.push(c);
      }
      const out = [];
      for (const g of groups) {
        const cards = [];
        for (const c of g.list) {
          const ss = await API.get(`/api/classes/${c.id}/students`);
          cards.push(`<div class="card cls ${g.subject ? esc(g.subject.color) : ''}">
            <div class="row between"><div class="strong grow ellip">${esc(c.name)}</div>
              <button class="btn sm grey" data-go="classform" data-arg='${JSON.stringify({ clsId: c.id })}'>管理</button></div>
            <div class="row mt" style="gap:6px;flex-wrap:wrap">${c.gradeBand ? `<span class="pill">${esc(c.gradeBand)}</span>` : ''}
              <span class="pill blue">邀请码 ${esc(c.inviteCode)}</span><span class="muted small">${ss.length} 名学生</span>
              ${isAdmin() && c.teacherName ? `<span class="muted small">· ${esc(c.teacherName)}</span>` : ''}</div>
            ${ss.length ? `<div class="hr"></div>${ss.map((st, i) => `<div class="row between" style="padding:5px 0">
              <span><i class="rank ${i < 3 ? 'top' : ''}">${i + 1}</i>${esc(st.name)}</span>
              <span class="muted small">${st.stars} 星 · 连续 ${st.streak} 天</span></div>`).join('')}`
              : '<div class="muted small mt">还没有学生。把邀请码发给家长，孩子登录或在「我的」里输入邀请码就能进班</div>'}
          </div>`);
        }
        out.push(`<div class="group-title ${g.subject ? esc(g.subject.color) : ''}">${g.subject ? esc(g.subject.name) : '未设科目'}<span class="muted small">${g.list.length} 个班</span></div>${cards.join('')}`);
      }
      return out.join('');
    },
  };

  const CLASSFORM = {
    top: () => `<button class="back" data-go="classes">‹</button><h1>${S.clsId ? '管理班级' : '新建班级'}</h1>`, noTab: true,
    body: async () => {
      const [subj, bands, cs] = await Promise.all([API.get('/api/subjects'), API.get('/api/grade-bands'), API.get('/api/classes')]);
      const c = S.clsId ? cs.find((x) => x.id === S.clsId) : null;
      if (S.clsId && !c) return `<div class="empty">班级不存在</div>`;
      const ss = c ? await API.get(`/api/classes/${c.id}/students`) : [];
      const subId = c && c.subject ? c.subject.id : null;
      return `<div class="card">
        <div class="field"><span>科目</span><div class="chips">${subj.subjects.map((x) => `<label class="chip ${esc(x.color)}"><input type="radio" name="c-subj" value="${x.id}"${x.id === subId ? ' checked' : ''}><span>${esc(x.name)}</span></label>`).join('')}</div></div>
        <div class="field"><span>年级段</span><div class="chips">${bands.map((b) => `<label class="chip"><input type="radio" name="c-band" value="${esc(b)}"${c && c.gradeBand === b ? ' checked' : ''}><span>${esc(b)}</span></label>`).join('')}</div></div>
        <label class="field"><span>班级名称（可不填，自动叫「三四年级书法班」这样）</span><input id="c-name" value="${c ? esc(c.name) : ''}" placeholder="也可以写上课时间，比如：书法 周六上午班"></label>
        <button class="btn block" data-act="saveClass">${c ? '保存' : '创建班级'}</button>
      </div>
      ${c ? `<div class="card"><div class="row between"><div class="section-title">学生 ${ss.length} 人</div><span class="pill blue">邀请码 ${esc(c.inviteCode)}</span></div>
        ${ss.map((st) => `<div class="row between" style="padding:7px 0;border-top:1px solid var(--line)"><span>${esc(st.name)}</span>
          <button class="btn sm danger" data-act="kickStudent" data-sid="${st.id}" data-name="${esc(st.name)}">移出</button></div>`).join('') || '<div class="muted small mt">还没有学生</div>'}
      </div>
      <div class="card"><div class="row between"><span class="muted small">没布置过作业的班可以删除</span>
        <button class="btn sm danger" data-act="delClass">删除班级</button></div></div>` : ''}`;
    },
  };

  const HWLIST = {
    top: () => `<h1><img src="brand/logo-96.png" alt="">作业</h1><button class="btn sm" data-go="hwnew">+ 布置</button>`, tab: true,
    body: async () => {
      const hws = await API.get('/api/homeworks');
      if (!hws.length) return `<div class="empty">还没布置过作业<br><span class="small">点右上角「+ 布置」</span></div>`;
      return hws.map((h) => `<div class="hwitem" data-go="review" data-arg='${JSON.stringify({ hwId: h.id })}'>
        <div class="row between"><div class="strong ellip grow">${subjTag(h.subject)}${esc(h.title)}</div>
          <span class="pill ${h.submitted >= h.total && h.total ? 'ok' : 'warn'}">${h.submitted}/${h.total} 已交</span></div>
        <div class="muted small mt">${h.kind === 'questions' ? `${h.itemCount} 道题` : `${h.itemCount} 句跟读`} · ${esc(h.className)} · ${fmtDate(h.createdAt)}
          ${h.reviewed ? ` · 已批改 ${h.reviewed}` : ''}</div>
      </div>`).join('');
    },
  };

  const HWNEW = {
    top: () => `<button class="back" data-go="hwlist">‹</button><h1>布置作业</h1>`, noTab: true,
    body: async () => {
      const [classes, books] = await Promise.all([API.get('/api/classes'), API.get('/api/books')]);
      if (!classes.length) return `<div class="empty">请先建班级<br><span class="small">在「班级」里点「+ 新建」</span></div>`;
      // 作业布置给班级，科目跟着班级走；只有英语班能布置课本跟读
      if (!classes.some((c) => c.id === S.newClassId)) S.newClassId = classes[0].id;
      const cur = classes.find((c) => c.id === S.newClassId);
      const isEn = !cur.subject || cur.subject.code === 'en';
      if (!isEn) S.newKind = 'questions';
      const classSel = `<div class="card"><label class="field" style="margin-bottom:0"><span>布置给哪个班</span><select id="f-class">${classes.map((c) =>
        `<option value="${c.id}"${c.id === S.newClassId ? ' selected' : ''}>${c.subject ? esc(c.subject.name) + ' · ' : ''}${esc(c.name)}（${c.studentCount}人）</option>`).join('')}</select></label></div>`;
      const seg = isEn ? `<div class="seg mb">
          <button class="${S.newKind === 'questions' ? 'on' : ''}" data-act="newKind" data-k="questions">题目作业</button>
          <button class="${S.newKind === 'follow_read' ? 'on' : ''}" data-act="newKind" data-k="follow_read">课本跟读</button>
        </div>` : '';
      if (S.newKind === 'questions') {
        if (!S.qs.length) S.qs = [newQ('single')];
        return `${classSel}${seg}
        <div class="card">
          <label class="field"><span>作业标题</span><input id="f-title" placeholder="例如：第三单元 口算练习"></label>
          <label class="field" style="margin-bottom:0"><span>给学生的话（可选）</span><textarea id="f-note" rows="2" placeholder="写完检查一遍再交"></textarea></label>
        </div>
        <div id="q-list"></div>
        <div class="card"><div class="section-title mb">再加一道题</div>
          <div class="qtypes">${Object.entries(TYPE_NAME).map(([t, n]) => `<button class="btn sm ghost" data-act="qAdd" data-t="${t}">${n}</button>`).join('')}</div>
          <div class="muted small mt">单选、多选、判断、填空由系统自动判分；拍照、文字、录音题交上来后由您打分。整张试卷可以拍照放在题目图片里。</div>
        </div>
        <button class="btn block" data-act="createQHw">发布作业</button>`;
      }
      S.pick.bookId = S.pick.bookId || (books[0] && books[0].id);
      return `${classSel}${seg}<div class="card">
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
    after: async () => { if (S.newKind === 'questions') drawQs(); else await loadPages(); },
  };

  /* ---------- 出题编辑器 ---------- */
  function newQ(type) {
    return { type, stem: '', img: null, options: ['', '', '', ''].slice(0, type === 'multi' || type === 'single' ? 4 : 0),
      correct: [], judge: null, blanks: [''], tolerance: '', score: type === 'photo' || type === 'text' || type === 'audio' ? 10 : 5, analysis: '' };
  }
  function qHtml(q, i) {
    let body = '';
    if (q.type === 'single' || q.type === 'multi') {
      body = `<div class="field"><span>选项（点字母标出正确答案${q.type === 'multi' ? '，可以标多个' : ''}）</span>
        ${q.options.map((o, k) => `<div class="opt-ed">
          <button class="optk ${q.correct.includes(k) ? 'on' : ''}" data-act="qMark" data-i="${i}" data-k="${k}" aria-pressed="${q.correct.includes(k)}" aria-label="把 ${LETTER[k]} 设为正确答案">${LETTER[k]}</button>
          <input data-qf="opt" data-i="${i}" data-k="${k}" value="${esc(o)}" placeholder="选项 ${LETTER[k]}">
          ${q.options.length > 2 ? `<button class="x" data-act="qOptDel" data-i="${i}" data-k="${k}" aria-label="删除选项">×</button>` : ''}
        </div>`).join('')}
        ${q.options.length < 6 ? `<button class="btn sm grey" data-act="qOptAdd" data-i="${i}">+ 选项</button>` : ''}</div>`;
    } else if (q.type === 'judge') {
      body = `<div class="field"><span>正确答案</span><div class="row" style="gap:8px">
        <button class="btn sm ${q.judge === true ? 'mint' : 'ghost'}" data-act="qJudge" data-i="${i}" data-v="1">对</button>
        <button class="btn sm ${q.judge === false ? 'coral' : 'ghost'}" data-act="qJudge" data-i="${i}" data-v="0">错</button></div></div>`;
    } else if (q.type === 'blank') {
      body = `<div class="field"><span>每个空的正确答案（有几种写法都算对，用 / 隔开，比如 3/三）</span>
        ${q.blanks.map((b, k) => `<div class="opt-ed"><span class="optk on">${k + 1}</span>
          <input data-qf="blank" data-i="${i}" data-k="${k}" value="${esc(b)}" placeholder="第 ${k + 1} 个空的答案">
          ${q.blanks.length > 1 ? `<button class="x" data-act="qBlankDel" data-i="${i}" data-k="${k}" aria-label="删除这个空">×</button>` : ''}
        </div>`).join('')}
        <button class="btn sm grey" data-act="qBlankAdd" data-i="${i}">+ 空</button></div>
        <label class="field"><span>数字答案允许的误差（可不填，比如 0.01）</span><input data-qf="tolerance" data-i="${i}" inputmode="decimal" value="${esc(q.tolerance)}"></label>`;
    } else {
      body = `<div class="muted small mb">${{ photo: '学生拍照上传（最多 6 张），', text: '学生打字作答，', audio: '学生录音作答，' }[q.type]}交上来后由您打分。</div>`;
    }
    return `<div class="card qed">
      <div class="row between mb"><div class="strong">第 ${i + 1} 题 <span class="pill blue">${TYPE_NAME[q.type]}</span></div>
        <div class="row" style="gap:6px">${i ? `<button class="btn sm grey" data-act="qUp" data-i="${i}">上移</button>` : ''}
          <button class="btn sm danger" data-act="qDel" data-i="${i}">删除</button></div></div>
      <label class="field"><span>题目${q.type === 'blank' ? '（空的位置写 ____）' : ''}</span>
        <textarea data-qf="stem" data-i="${i}" rows="2" placeholder="${q.type === 'photo' ? '例如：临写《静夜思》，写完拍照上传' : '题目文字；只有图片也可以'}">${esc(q.stem)}</textarea></label>
      ${q.img ? `<div class="stem-img mb"><img src="${q.img.url}" alt="题目图片"><button class="btn sm grey" data-act="qImgDel" data-i="${i}">移除图片</button></div>`
        : `<label class="btn sm ghost mb" style="display:inline-flex">加题目图片<input type="file" accept="image/*" data-qimg="${i}" hidden></label>`}
      ${body}
      <div class="row" style="gap:10px;align-items:flex-end">
        <label class="field" style="width:96px;flex:0 0 auto"><span>分值</span><input data-qf="score" data-i="${i}" type="number" min="1" max="100" inputmode="decimal" value="${esc(q.score)}"></label>
        <label class="field grow"><span>解析（批改后学生可见，可不填）</span><input data-qf="analysis" data-i="${i}" value="${esc(q.analysis)}"></label>
      </div>
    </div>`;
  }
  function drawQs() {
    const box = document.getElementById('q-list');
    if (box) box.innerHTML = S.qs.map(qHtml).join('');
  }

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
    top: () => `<button class="back" data-go="hwlist">‹</button><h1>批改</h1><button class="btn sm danger" data-act="delHw">删除作业</button>`, noTab: true,
    body: async () => {
      const d = await API.get(`/api/homeworks/${S.hwId}/submissions`);
      S.rev = d;
      if (d.questions) return questionReview(d);
      return `<div class="card tight mb"><div class="strong">${subjTag(d.homework.subject)}${esc(d.homework.title)}</div>
        <div class="muted small mt">${esc(d.homework.className)} · ${d.homework.itemCount} 句 · 已交 ${d.homework.submitted}/${d.homework.total}</div></div>
        ${d.rows.map((r, ri) => `
        <div class="card">
          <div class="row between">
            <div class="strong">${esc(r.studentName)}${r.excellent ? ' <span class="pill warn">优秀</span>' : ''}</div>
            ${statusPill(r.status)}
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
            ${excellentBox(ri, r, d.homework.subject)}
            <div class="row mt" style="gap:8px">
              <button class="btn sm grow" data-act="doReview" data-ri="${ri}">提交批改</button>
              <button class="btn sm danger" data-act="doReject" data-ri="${ri}">打回重做</button>
            </div>` : ''}
        </div>`).join('')}`;
    },
  };

  const statusPill = (st) => `<span class="pill ${st === 'reviewed' ? 'ok' : st === 'submitted' ? 'warn' : 'todo'}">
    ${st === 'reviewed' ? '已批改' : st === 'submitted' ? '待批改' : st === 'rejected' ? '已打回' : '未提交'}</span>`;

  const excellentBox = (ri, r, subject) => `<label class="check mt"><input type="checkbox" id="ex-${ri}"${r.excellent ? ' checked' : ''}>
    <span>评为优秀作业<br><span class="muted small">学生可以生成喜报分享${subject && subject.code === 'calli' ? '，作品会进入书法作品展' : ''}</span></span></label>`;

  function questionReview(d) {
    const hw = d.homework;
    return `<div class="card tight mb"><div class="strong">${subjTag(hw.subject)}${esc(hw.title)}</div>
      <div class="muted small mt">${esc(hw.className)} · ${d.questions.length} 道题 · 已交 ${hw.submitted}/${hw.total} · 已批改 ${hw.reviewed}</div></div>
      ${d.rows.map((r, ri) => `
      <details class="card rv"${r.status === 'submitted' ? ' open' : ''}>
        <summary class="row between">
          <span class="strong">${esc(r.studentName)}${r.excellent ? ' <span class="pill warn">优秀</span>' : ''}</span>
          <span class="row" style="gap:6px">${r.score != null ? `<b class="score">${fmtNum(r.score)}<small>/${fmtNum(r.maxScore)}</small></b>` : ''}${statusPill(r.status)}</span>
        </summary>
        ${r.submissionId ? `<div class="rv-body">
          ${d.questions.map((q, qi) => {
            const a = r.answers.find((x) => x.questionId === q.id);
            const head = `<div class="rv-head"><b>${qi + 1}.</b> <span class="pill">${TYPE_NAME[q.type]}</span> <span class="muted small">${fmtNum(q.score)} 分</span></div>
              ${q.stem ? `<div class="rv-stem">${esc(q.stem)}</div>` : ''}
              ${q.stemImage ? `<button class="thumb sm" data-act="zoom" data-src="${esc(q.stemImage.url)}"><img src="${esc(q.stemImage.url)}" alt="题目图片"></button>` : ''}`;
            if (!a) return `<div class="rv-q">${head}<div class="muted small">没有作答</div></div>`;
            if (q.auto) {
              return `<div class="rv-q">${head}
                <div class="row between small"><span>作答：<b>${esc(fmtAnswer(q, a.value))}</b>${a.autoCorrect ? '' : `<span class="muted">　正确：${esc(fmtKey(q))}</span>`}</span>
                <span class="mark ${a.autoCorrect ? 'ok' : 'bad'}">${a.autoCorrect ? '对' : '错'} ${fmtNum(a.score)}</span></div></div>`;
            }
            const content = q.type === 'text' ? `<div class="rv-text">${esc(a.value || '')}</div>`
              : q.type === 'photo' ? `<div class="thumbs">${a.assets.map((x) => `<button class="thumb" data-act="zoom" data-src="${esc(x.url)}"><img src="${esc(x.url)}" alt="学生照片" loading="lazy"></button>`).join('')}</div>`
              : `<button class="btn sm grey" data-act="playRec" data-url="${esc(a.assets[0] ? a.assets[0].url : '')}">听录音</button>`;
            return `<div class="rv-q">${head}${content}
              <div class="row mt" style="gap:8px">
                <label class="grade"><input type="number" id="sc-${ri}-${qi}" min="0" max="${q.score}" step="0.5" inputmode="decimal" value="${a.score == null ? '' : a.score}" placeholder="分"><span>/ ${fmtNum(q.score)}</span></label>
                <input class="grow" id="cm-${ri}-${qi}" value="${esc(a.comment || '')}" placeholder="这题的点评（可不填）">
              </div></div>`;
          }).join('')}
          <textarea id="rv-${ri}" rows="2" class="mt" placeholder="总评语，学生和家长都能看到">${esc(r.reviewText || '')}</textarea>
          ${excellentBox(ri, r, hw.subject)}
          <div class="row mt" style="gap:8px">
            <button class="btn sm grow" data-act="doGrade" data-ri="${ri}">${r.status === 'reviewed' ? '修改批改' : '提交批改'}</button>
            <button class="btn sm danger" data-act="doReject" data-ri="${ri}">打回重做</button>
          </div></div>` : '<div class="muted small mt">还没交</div>'}
      </details>`).join('')}`;
  }

  /* ---------- 咨询：家长预约试听 ---------- */
  const LEAD_ST = [['new', '新咨询'], ['contacted', '已联系'], ['enrolled', '已报名'], ['invalid', '无效']];
  const LEADS = {
    top: () => `<h1><img src="brand/logo-96.png" alt="">咨询</h1>`, tab: true,
    body: async () => {
      const [ps, leads] = await Promise.all([API.get('/api/admin/promo-stats'), API.get('/api/admin/leads')]);
      const src = (l) => (l.source === 'share' ? (l.refName ? `看了 ${esc(l.refName)} 的分享` : '来自分享页')
        : l.source === 'gallery' ? '来自书法作品展' : '来自预约试听页');
      return `<div class="card">
        <div class="section-title mb">近 7 天宣传效果</div>
        <div class="minis"><div><b>${ps.last7.shares}</b><span>新分享</span></div><div><b>${ps.last7.views}</b><span>家长浏览</span></div><div><b>${ps.last7.leads}</b><span>预约试听</span></div></div>
        ${ps.top.length ? `<div class="muted small mt mb">分享最多的同学</div>${ps.top.map((t, i) => `<div class="row between" style="padding:4px 0">
          <span><i class="rank ${i < 3 ? 'top' : ''}">${i + 1}</i>${esc(t.name)}</span><span class="muted small">${t.shares} 份 · ${t.views || 0} 次浏览</span></div>`).join('')}` : ''}
        <div class="row mt" style="gap:8px">
          <a class="btn sm ghost grow" href="/gallery" target="_blank">书法作品展</a>
          <a class="btn sm ghost grow" href="/trial" target="_blank">预约试听页</a>
        </div>
        <div class="muted small mt">这两个页面可以直接发到家长群、朋友圈。</div>
      </div>
      <div class="row between mb"><div class="section-title">家长预约</div>${ps.newLeads ? `<span class="pill todo">${ps.newLeads} 条待联系</span>` : ''}</div>
      ${leads.length ? leads.map((l) => `<div class="card lead ${l.status}">
        <div class="row between">
          <a class="strong lead-phone" href="tel:${esc(l.phone)}">${esc(l.phone.replace(/(\d{3})(\d{4})(\d{4})/, '$1 $2 $3'))}</a>
          <select class="lead-st" data-lead-status="${l.id}" aria-label="跟进状态">${LEAD_ST.map(([k, t]) => `<option value="${k}"${l.status === k ? ' selected' : ''}>${t}</option>`).join('')}</select>
        </div>
        <div class="small mt">${esc(l.grade)}${l.subjectNames.length ? ' · ' + l.subjectNames.map(esc).join('、') : ''} · ${esc(l.contactTime || '都可以')}</div>
        <div class="muted small">${src(l)} · ${fmtDate(l.createdAt)}</div>
        <div class="row mt" style="gap:8px">
          <input class="grow" data-lead-note="${l.id}" value="${esc(l.note || '')}" placeholder="跟进备注，改完自动保存">
          <button class="btn sm danger" data-act="leadDel" data-id="${l.id}">删除</button>
        </div>
      </div>`).join('') : `<div class="empty">还没有家长预约<br><span class="small">学生分享喜报、作品后，家长可以在分享页上预约试听</span></div>`}`;
    },
  };

  const ME = {
    top: () => `<h1><img src="brand/logo-96.png" alt="">我的</h1>`, tab: true,
    body: async () => {
      const st = await API.get('/api/admin/stats');
      const admin = isAdmin();
      const scope = admin ? '全校' : '我的班';
      return `<div class="hero"><h2>${esc((Store.user || {}).name || '')}</h2>
        <div class="small">福斯特培训学校 · ${admin ? '负责人' : '老师'}</div>
        <div class="stats"><div><b>${st.students}</b><span>${scope}学生</span></div><div><b>${st.homeworks}</b><span>作业</span></div>
        <div><b>${st.submissions}</b><span>提交</span></div></div></div>
      ${admin ? `<div class="card"><div class="row between mb"><div class="section-title">老师账号</div>
          <button class="btn sm" data-go="staff">管理</button></div>
        <div class="muted small">${st.teachers} 个教职工账号。每位老师用自己的口令登录，只能看到自己带的班。</div></div>
      <div class="card"><div class="section-title mb">教材内容</div>
        <div class="row between"><span class="muted small">教材 ${st.books} 本 · 页面 ${st.pages} 页 · 热区 ${st.hotspots} 个</span>
        <a class="btn sm ghost" href="admin.html" target="_blank">打开内容后台</a></div></div>`
        : `<div class="card"><div class="section-title mb">我带的班</div>
        <div class="muted small">${st.classes} 个班。要加新班或改科目，在「班级」页操作；教材内容和家长咨询由负责人管理。</div></div>`}
      <div class="card"><div class="row between"><span>切换账号</span><button class="btn sm grey" data-act="logout">退出登录</button></div></div>`;
    },
  };

  /* ---------- 教职工账号（只有负责人能进） ---------- */
  const STAFF = {
    top: () => `<button class="back" data-go="me">‹</button><h1>老师账号</h1><button class="btn sm" data-act="newStaff">+ 新建</button>`, noTab: true,
    body: async () => {
      const list = await API.get('/api/admin/teachers');
      return `<div class="card tight mb"><div class="muted small">
          每位老师用「姓名 + 自己的口令」登录，只能看到自己带的班和作业；家长预约、教材内容只有负责人能看。
          老师忘了口令就点「重置口令」，系统会生成一个新的，旧的立刻失效。</div></div>
        ${list.map((u) => `<div class="card">
          <div class="row between">
            <div class="strong grow ellip">${esc(u.name)}
              <span class="pill ${u.role === 'admin' ? 'warn' : 'blue'}">${esc(u.roleName)}</span>
              ${u.active ? '' : '<span class="pill todo">已停用</span>'}</div>
          </div>
          <div class="muted small mt">${u.classCount} 个班${u.role === 'admin' || u.hasCode ? '' : ' · 还没有口令，先点「重置口令」'}${u.isMe ? ' · 当前登录' : ''}</div>
          ${u.role === 'admin' && u.isMe ? `<div class="row between mt"><span class="muted small">负责人用部署时设置的主口令登录</span>
            <button class="btn sm grey" data-act="renameStaff" data-id="${u.id}" data-name="${esc(u.name)}">改名</button></div>` : `
          <div class="row mt" style="gap:8px;flex-wrap:wrap">
            <button class="btn sm ghost" data-act="resetCode" data-id="${u.id}" data-name="${esc(u.name)}">重置口令</button>
            <button class="btn sm grey" data-act="renameStaff" data-id="${u.id}" data-name="${esc(u.name)}">改名</button>
            <button class="btn sm grey" data-act="toggleStaff" data-id="${u.id}" data-on="${u.active ? 1 : 0}">${u.active ? '停用' : '恢复'}</button>
            ${u.classCount ? '' : `<button class="btn sm danger" data-act="delStaff" data-id="${u.id}" data-name="${esc(u.name)}">删除</button>`}
          </div>`}
        </div>`).join('')}`;
    },
  };

  /** 新口令只显示这一次，让负责人抄下来发给老师 */
  function showCode(name, code) {
    const m = document.createElement('div');
    m.className = 'poster-mask'; m.id = 'codebox';
    m.innerHTML = `<div class="poster-sheet" role="dialog" aria-label="老师口令">
        <div class="center"><div class="section-title">${esc(name)} 的口令</div>
          <div class="bigcode">${esc(code)}</div>
          <div class="muted small">把这 6 位数字发给${esc(name)}，登录时输姓名和它。<br>这个口令只显示这一次，忘了可以重置。</div></div>
        <div class="row" style="gap:10px">
          <button class="btn ghost grow" data-act="copyCode" data-code="${esc(code)}">复制</button>
          <button class="btn grow" data-act="closeCode">知道了</button>
        </div>
      </div>`;
    m.addEventListener('click', (e) => { if (e.target === m) m.remove(); });
    document.getElementById('app').appendChild(m);
  }

  const VIEWS = { login: LOGIN, classes: CLASSES, classform: CLASSFORM, staff: STAFF, hwlist: HWLIST, hwnew: HWNEW, review: REVIEW, leads: LEADS, me: ME };

  const ACT = {
    async login() {
      const name = document.getElementById('i-name').value.trim();
      if (!name) return toast('请填写姓名');
      try { const d = await API.post('/api/auth/dev-login', { role: 'teacher', name, teacherCode: document.getElementById('i-tcode').value }); Store.token = d.token; Store.user = d.user; go('classes'); }
      catch (e) { toast(e.message); }
    },
    logout() { Store.clear(); go('login'); },
    async newStaff() {
      const name = (prompt('老师姓名（学生和家长会看到，建议写「李老师」这样）') || '').trim();
      if (!name) return;
      try { const r = await API.post('/api/admin/teachers', { name }); render(); showCode(r.name, r.code); }
      catch (e) { toast(e.message, 2600); }
    },
    async resetCode(el) {
      if (!confirm(`给 ${el.dataset.name} 换一个新口令？旧口令马上失效。`)) return;
      try { const r = await API.post(`/api/admin/teachers/${el.dataset.id}/code`); showCode(r.name, r.code); }
      catch (e) { toast(e.message); }
    },
    async renameStaff(el) {
      const name = (prompt('改成什么名字？学生和家长会看到', el.dataset.name) || '').trim();
      if (!name || name === el.dataset.name) return;
      try {
        await API.put('/api/admin/teachers/' + el.dataset.id, { name });
        const me = Store.user || {};
        if (String(me.id) === String(el.dataset.id)) {
          Store.user = { ...me, name };
          toast('改好了。下次登录请用新名字加原来的口令', 3200);
        } else toast('改好了，口令不变');
        render();
      } catch (e) { toast(e.message, 2600); }
    },
    async toggleStaff(el) {
      const on = el.dataset.on === '1';
      if (on && !confirm('停用后这位老师就登录不了了，确定？')) return;
      try { await API.put(`/api/admin/teachers/${el.dataset.id}`, { active: !on }); toast(on ? '已停用' : '已恢复'); render(); }
      catch (e) { toast(e.message); }
    },
    async delStaff(el) {
      if (!confirm(`删除 ${el.dataset.name} 的账号？`)) return;
      try { await API.del('/api/admin/teachers/' + el.dataset.id); toast('已删除'); render(); }
      catch (e) { toast(e.message, 2600); }
    },
    copyCode(el) {
      const code = el.dataset.code;
      if (navigator.clipboard) navigator.clipboard.writeText(code).then(() => toast('口令已复制')).catch(() => toast('复制不了，请手抄：' + code, 3000));
      else toast('请手抄：' + code, 3000);
    },
    closeCode() { const m = document.getElementById('codebox'); if (m) m.remove(); },
    async saveClass(el) {
      const sub = document.querySelector('input[name="c-subj"]:checked');
      const band = document.querySelector('input[name="c-band"]:checked');
      if (!sub) return toast('请选科目');
      if (!band) return toast('请选年级段');
      const body = { subjectId: Number(sub.value), gradeBand: band.value, name: document.getElementById('c-name').value.trim() };
      el.disabled = true;
      try {
        const c = S.clsId ? await API.put('/api/classes/' + S.clsId, body) : await API.post('/api/classes', body);
        toast(S.clsId ? '已保存' : `已创建「${c.name}」，邀请码 ${c.inviteCode}`, 2800); go('classes');
      } catch (e) { toast(e.message, 2600); el.disabled = false; }
    },
    async delHw(el) {
      const hw = S.rev && S.rev.homework;
      if (!hw) return;
      const n = hw.submitted || 0;
      if (!confirm(`删除作业「${hw.title}」？${n ? `已经交上来的 ${n} 份作业、分数和评语会一起删掉，` : ''}删除后找不回来。`)) return;
      el.disabled = true;
      try { await API.del('/api/homeworks/' + hw.id); toast('作业已删除'); go('hwlist'); }
      catch (e) { toast(e.message); el.disabled = false; }
    },
    async delClass() {
      if (!confirm('删除这个班？学生会被移出，但学生账号还在')) return;
      try { await API.del('/api/classes/' + S.clsId); toast('已删除'); go('classes'); }
      catch (e) { toast(e.message, 2600); }
    },
    async kickStudent(el) {
      if (!confirm(`把 ${el.dataset.name} 移出这个班？`)) return;
      try { await API.del(`/api/classes/${S.clsId}/students/${el.dataset.sid}`); toast('已移出'); render(); }
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
    noop() {},
    newKind(el) { if (S.newKind === el.dataset.k) return; S.newKind = el.dataset.k; render(); },
    qAdd(el) { S.qs.push(newQ(el.dataset.t)); drawQs(); const c = document.querySelectorAll('.qed'); if (c.length) c[c.length - 1].scrollIntoView({ block: 'start', behavior: 'smooth' }); },
    qDel(el) {
      const i = Number(el.dataset.i), q = S.qs[i];
      if ((q.stem || q.img) && !confirm(`删除第 ${i + 1} 题？`)) return;
      S.qs.splice(i, 1); drawQs();
    },
    qUp(el) { const i = Number(el.dataset.i); [S.qs[i - 1], S.qs[i]] = [S.qs[i], S.qs[i - 1]]; drawQs(); },
    qMark(el) {
      const q = S.qs[Number(el.dataset.i)], k = Number(el.dataset.k);
      if (q.type === 'single') q.correct = [k];
      else q.correct = q.correct.includes(k) ? q.correct.filter((x) => x !== k) : [...q.correct, k];
      drawQs();
    },
    qOptAdd(el) { S.qs[Number(el.dataset.i)].options.push(''); drawQs(); },
    qOptDel(el) {
      const q = S.qs[Number(el.dataset.i)], k = Number(el.dataset.k);
      q.options.splice(k, 1);
      q.correct = q.correct.filter((x) => x !== k).map((x) => (x > k ? x - 1 : x));
      drawQs();
    },
    qJudge(el) { S.qs[Number(el.dataset.i)].judge = el.dataset.v === '1'; drawQs(); },
    qBlankAdd(el) { S.qs[Number(el.dataset.i)].blanks.push(''); drawQs(); },
    qBlankDel(el) { S.qs[Number(el.dataset.i)].blanks.splice(Number(el.dataset.k), 1); drawQs(); },
    qImgDel(el) { S.qs[Number(el.dataset.i)].img = null; drawQs(); },
    async createQHw(el) {
      const title = document.getElementById('f-title').value.trim();
      if (!title) return toast('请填写作业标题');
      if (!S.qs.length) return toast('至少出一道题');
      const questions = S.qs.map((q) => ({
        type: q.type, stem: q.stem, stemImageBase64: q.img ? q.img.base64 : undefined,
        options: q.type === 'single' || q.type === 'multi' ? q.options : undefined,
        answer: q.type === 'single' ? q.correct[0]
          : q.type === 'multi' ? q.correct
          : q.type === 'judge' ? q.judge
          : q.type === 'blank' ? { blanks: q.blanks.map((b) => b.split(/[/／]/).map((x) => x.trim()).filter(Boolean)), tolerance: Number(q.tolerance) || 0 }
          : null,
        score: Number(q.score), analysis: q.analysis,
      }));
      el.disabled = true; el.textContent = '发布中…';
      try {
        await API.post('/api/homeworks/questions', {
          classId: Number(document.getElementById('f-class').value),
          title, note: document.getElementById('f-note').value.trim(), questions,
        });
        S.qs = []; toast('作业已发布'); go('hwlist');
      } catch (e) { toast(e.message, 2600); el.disabled = false; el.textContent = '发布作业'; }
    },
    zoom(el) { lightbox(el.dataset.src); },
    async doGrade(el) {
      const ri = Number(el.dataset.ri), r = S.rev.rows[ri];
      const scores = [];
      for (const [qi, q] of S.rev.questions.entries()) {
        if (q.auto) continue;
        const a = r.answers.find((x) => x.questionId === q.id);
        if (!a) continue;
        const v = document.getElementById(`sc-${ri}-${qi}`).value.trim();
        if (v === '') return toast(`第 ${qi + 1} 题还没打分`);
        scores.push({ answerId: a.id, score: Number(v), comment: document.getElementById(`cm-${ri}-${qi}`).value.trim() });
      }
      el.disabled = true;
      try {
        const res = await API.post(`/api/submissions/${r.submissionId}/grade`, {
          scores, reviewText: document.getElementById('rv-' + ri).value.trim(), excellent: document.getElementById('ex-' + ri).checked,
        });
        toast(`批改完成：${fmtNum(res.score)} / ${fmtNum(res.maxScore)} 分`); render();
      } catch (e) { toast(e.message); el.disabled = false; }
    },
    async leadDel(el) {
      if (!confirm('删除这条预约？删除后找不回来')) return;
      try { await API.del('/api/admin/leads/' + el.dataset.id); toast('已删除'); render(); }
      catch (e) { toast(e.message); }
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
          { stars, reviewText: document.getElementById('rv-' + ri).value.trim(), excellent: document.getElementById('ex-' + ri).checked });
        toast('批改完成'); render();
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
