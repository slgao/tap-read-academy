/* 老师端：班级管理 / 布置作业 / 批改 */
(function () {
  'use strict';
  const { Store, API, toast, esc, fmtDate, starStr, Player, Clip, compressImage, subjTag, TYPE_NAME, lightbox, LETTER, fmtAnswer, fmtKey, fmtNum } = App;
  const $view = document.getElementById('view');
  const $top = document.getElementById('topbar');
  const $tab = document.getElementById('tabbar');
  const player = new Player();
  const isAdmin = () => ((Store.user || {}).role === 'admin');

  const S = { view: 'home', pick: { bookId: null, pageId: null, sel: [] }, newKind: 'questions', qs: [] };

  const TAB_IC = {
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14a6.5 6.5 0 0 1 3.5 6"/>',
    pencil: '<path d="M4 20l1.2-4.8L16 4.4a2 2 0 0 1 2.8 0l.8.8a2 2 0 0 1 0 2.8L8.8 18.8z"/><path d="M14 6.5l3.5 3.5"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    phone: '<path d="M6.5 3.5h3l1.5 4.5-2 1.5a11 11 0 0 0 5.5 5.5l1.5-2 4.5 1.5v3a2 2 0 0 1-2 2A16 16 0 0 1 4.5 5.5a2 2 0 0 1 2-2z"/>',
    folder: '<path d="M3 7.5a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    board: '<rect x="3.5" y="4" width="17" height="16" rx="2.5"/><path d="M8 9h8M8 13h8M8 17h4"/>',
  };

  function go(v, d) {
    Clip.stop(); player.stop();
    if (v !== 'classform') S.formFor = null;          // 离开建班表单，下次进来重新初始化
    S.view = v; Object.assign(S, d || {}); render();
  }

  let renderSeq = 0;
  function render() {
    const V = VIEWS[S.view] || VIEWS.classes;
    const seq = ++renderSeq;                 // 上一个页面的数据回来晚了，不能把新页面盖掉
    $top.innerHTML = V.top();
    $view.className = V.noTab ? 'view no-tab' : 'view';
    $view.innerHTML = '<div class="empty">加载中…</div>';
    $tab.hidden = !V.tab;
    // 五个标签够用：咨询、请假、奖品这些入口都在教务台和「我的」里
    const tabs = [['home', '教务台', TAB_IC.board], ['classes', '班级', TAB_IC.users],
      ['students', '学员', TAB_IC.folder], ['hwlist', '作业', TAB_IC.pencil], ['me', '我的', TAB_IC.user]];
    if (V.tab) $tab.innerHTML = tabs
      .map(([k, t, icon]) => `<button class="${S.view === k ? 'on' : ''}" data-go="${k}" aria-label="${t}"><span class="tab-ic"><svg class="i" viewBox="0 0 24 24" aria-hidden="true">${icon}</svg></span>${t}</button>`).join('');
    return Promise.resolve(V.body()).then((h) => {
      if (seq !== renderSeq) return;
      $view.innerHTML = h; if (V.after) V.after();
    }).catch((e) => { if (seq === renderSeq) $view.innerHTML = `<div class="empty">${esc(e.message)}</div>`; });
  }

  document.addEventListener('click', (e) => {
    const g = e.target.closest('[data-go]');
    if (g) return go(g.dataset.go, g.dataset.arg ? JSON.parse(g.dataset.arg) : null);
    const a = e.target.closest('[data-act]');
    if (a) (ACT[a.dataset.act] || (() => {}))(a, e);
  });

  document.addEventListener('focusin', (e) => {
    const el = e.target;
    if (el.matches('input[type="text"], input:not([type]), textarea')) S.lastField = el;
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
    if (el.name === 'c-subj') { S.formSubj = Number(el.value); S.formCourse = null; refreshCourses(); return; }
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

  /* ---------- 教务台：今天要办的事都摆在这一屏 ---------- */
  const greet = () => {
    const h = new Date().getHours();
    return h < 6 ? '夜深了' : h < 11 ? '早上好' : h < 14 ? '中午好' : h < 18 ? '下午好' : '晚上好';
  };

  const HOME = {
    top: () => `<h1><img src="brand/logo-96.png" alt="">教务台</h1>`, tab: true,
    body: async () => {
      const d = await API.get('/api/admin/dashboard', 20000);
      // 首页看完，顺手把其他标签的数据拉回来，切过去就是瞬开
      API.prefetch(['/api/classes?withMembers=1', '/api/homeworks', '/api/admin/students', '/api/meta']);
      const admin = d.role === 'admin';
      const todo = [];
      if (d.toReview) todo.push(['hwlist', '作业待批改', d.toReview, '去批改', 'coral']);
      if (d.pendingLeaves) todo.push(['leaves', '请假待审批', d.pendingLeaves, '去审批', 'star']);
      if (d.pendingRewards) todo.push(['rewards', '奖品待发放', d.pendingRewards, '去发放', 'mint']);
      if (admin && d.newLeads) todo.push(['leads', '新咨询', d.newLeads, '去联系家长', 'sky']);
      const unmarked = d.classes.filter((c) => !c.marked && c.studentCount);
      const todayClasses = d.classes.filter((c) => c.meetsToday);

      return `<div class="hello">
        <h2>${esc(d.name)}，${greet()}！</h2>
        <div class="level">${esc(d.date)} · ${admin ? '负责人' : '老师'}</div>
      </div>

      <div class="card">
        <div class="row between mb"><div class="section-title">今天的点名</div>
          <span class="muted small">${todayClasses.length ? `今天有课 ${todayClasses.length} 个班 · 已点 ${todayClasses.filter((c) => c.marked).length}` : `${d.classes.length - unmarked.length}/${d.classes.length} 个班已点`}</span></div>
        ${d.classes.length ? `<div class="rollgrid">${d.classes.map((c) => `
          <button class="rollchip ${c.marked ? 'done' : ''} ${c.meetsToday || !c.scheduleText ? '' : 'off'}" data-go="roll" data-arg='${JSON.stringify({ clsId: c.id, rollDate: null })}'>
            <b>${esc(c.name)}</b><span>${c.marked ? '已点名'
              : c.meetsToday ? `${c.studentCount} 人待点名`
              : c.scheduleText ? `${esc(c.scheduleText)}` : `${c.studentCount} 人待点名`}</span></button>`).join('')}</div>`
          : '<div class="muted small">还没有班级，先去「班级」里建一个</div>'}
      </div>

      ${todo.length ? `<div class="tiles">${todo.map(([view, label, n, hint, color]) => `
        <button class="tile ${color}" data-go="${view}"><span class="t-num">${n}</span>
          <div><b>${label}</b><span>${hint} ›</span></div></button>`).join('')}</div>`
        : '<div class="card tight mb"><div class="strong">今天没有待办</div><div class="muted small mt">作业都批完了，请假、奖品、咨询也都处理过了。</div></div>'}

      ${(d.lowHours.length || d.expiring.length) ? `<div class="card">
        <div class="section-title mb">课时提醒</div>
        ${d.lowHours.length ? `<div class="muted small mb">课时快用完</div>
          ${d.lowHours.map((x) => `<div class="row between alertline" data-go="student" data-arg='${JSON.stringify({ stuId: x.id })}'>
            <span>${esc(x.name)}</span><span class="pill todo">剩 ${x.leftHours} 课时</span></div>`).join('')}` : ''}
        ${d.expiring.length ? `<div class="muted small mb mt">30 天内到期</div>
          ${d.expiring.map((x) => `<div class="row between alertline" data-go="student" data-arg='${JSON.stringify({ stuId: x.id })}'>
            <span>${esc(x.name)}</span><span class="pill warn">${esc(x.expiresAt)} · 剩 ${x.leftHours}</span></div>`).join('')}` : ''}
        <div class="muted small mt">点名字可以直接打开档案，联系家长续费。</div>
      </div>` : ''}

      ${admin && d.month ? `<div class="card">
        <div class="section-title mb">本月（${esc(d.date.slice(0, 7))}）</div>
        <div class="minis">
          <div><b>¥${d.month.income}</b><span>收款</span></div>
          <div><b>${d.month.newStudents}</b><span>新学员</span></div>
          <div><b>${d.month.lessons}</b><span>上课人次</span></div>
        </div>
        <div class="muted small mt">收款按课包的购买日期统计，只有负责人看得到。</div>
      </div>` : ''}`;
    },
  };

  const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

  /** 某个科目下面的课程选择条：点一下选中，再点取消；末尾可以新建 */
  function courseChips(subjects, subjectId, courseId) {
    const sub = subjects.find((x) => x.id === Number(subjectId));
    const list = (sub && sub.courses) || [];
    return `<div class="chips">
      ${list.map((c) => `<button class="fchip ${Number(courseId) === c.id ? 'on' : ''}" data-act="pickCourse" data-id="${c.id}">${esc(c.name)}</button>`).join('')}
      <button class="fchip add" data-act="newCourse" data-subj="${subjectId || ''}">+ 新课程</button>
      ${list.length && courseId ? `<button class="fchip" data-act="renameCourse" data-id="${courseId}">改名</button>` : ''}
    </div>
    ${list.length ? '' : '<div class="muted small mt">这个科目还没有分课程，点「+ 新课程」可以加，比如「新概念英语」「自然拼读」</div>'}`;
  }

  /* ---------- 班级：按科目开班，同一科目按年级段分班 ---------- */
  const CLASSES = {
    top: () => `<h1><img src="brand/logo-96.png" alt="">班级</h1><button class="btn sm ghost" data-go="classform" data-arg='{"clsId":null}'>+ 新建</button>`, tab: true,
    body: async () => {
      const cs = await API.get('/api/classes?withMembers=1', 45000);
      if (!cs.length) return `<div class="empty">还没有班级<br><span class="small">点右上角新建，先选科目和年级段</span></div>`;
      // 负责人也带课：自己的班排前面，别人的班压暗显示（仍然可以管理）
      const myId = (Store.user || {}).id;
      const mine = cs.filter((c) => c.teacherId === myId);
      const others = cs.filter((c) => c.teacherId !== myId);
      const groups = [];
      const push = (c, dim) => {
        const key = (c.subject ? c.subject.code : '') + (dim ? '_o' : '');
        let g = groups.find((x) => x.key === key);
        if (!g) groups.push(g = { key, subject: c.subject, dim, list: [] });
        g.list.push(c);
      };
      mine.forEach((c) => push(c, false));
      others.forEach((c) => push(c, true));
      const out = [];
      for (const g of groups) {
        const cards = [];
        for (const c of g.list) {
          const ss = c.members || [];
          cards.push(`<div class="card cls ${g.subject ? esc(g.subject.color) : ''} ${g.dim ? 'dim' : ''}">
            <div class="row between"><div class="strong grow ellip">${esc(c.name)}</div>
              <div class="row" style="gap:6px">
                <button class="btn sm mint" data-go="roll" data-arg='${JSON.stringify({ clsId: c.id, rollDate: null })}'>点名</button>
                <button class="btn sm grey" data-go="classform" data-arg='${JSON.stringify({ clsId: c.id })}'>管理</button></div></div>
            <div class="muted small">${c.course ? esc(c.course.name) : ''}${c.scheduleText ? `${c.course ? ' · ' : ''}${esc(c.scheduleText)}` : ''}</div>
            <div class="row mt" style="gap:6px;flex-wrap:wrap">${c.gradeBand ? `<span class="pill">${esc(c.gradeBand)}</span>` : ''}
              ${c.meetsToday ? '<span class="pill ok">今天有课</span>' : ''}
              <span class="pill blue">邀请码 ${esc(c.inviteCode)}</span><span class="muted small">${ss.length} 名学生</span>
              ${isAdmin() && c.teacherName ? `<span class="muted small">· ${esc(c.teacherName)}</span>` : ''}</div>
            ${ss.length ? `<div class="hr"></div>${ss.map((st, i) => `<div class="row between" style="padding:5px 0">
              <span><i class="rank ${i < 3 ? 'top' : ''}">${i + 1}</i>${esc(st.name)}</span>
              <span class="muted small">${st.stars} 星 · 连续 ${st.streak} 天</span></div>`).join('')}`
              : '<div class="muted small mt">还没有学生。把邀请码发给家长，孩子登录或在「我的」里输入邀请码就能进班</div>'}
          </div>`);
        }
        out.push(`<div class="group-title ${g.subject ? esc(g.subject.color) : ''} ${g.dim ? 'dim' : ''}">${g.subject ? esc(g.subject.name) : '未设科目'}
          <span class="muted small">${g.dim ? '别的老师带 · ' : ''}${g.list.length} 个班</span></div>${cards.join('')}`);
      }
      return out.join('');
    },
  };

  const CLASSFORM = {
    top: () => `<button class="back" data-go="classes">‹</button><h1>${S.clsId ? '管理班级' : '新建班级'}</h1>`, noTab: true,
    body: async () => {
      const [meta, cs] = await Promise.all([API.get('/api/meta', 300000), API.get('/api/classes', 45000)]);
      const subj = meta, suggest = meta.gradeSuggest || [{ group: '常用', items: meta.gradeBands || [] }];
      const c = S.clsId ? cs.find((x) => x.id === S.clsId) : null;
      if (S.clsId && !c) return `<div class="empty">班级不存在</div>`;
      const ss = c ? await API.get(`/api/classes/${c.id}/students`) : [];
      const subId = c && c.subject ? c.subject.id : null;
      // 负责人可以指定这个班归谁带；老师自己建的班就是自己的
      const staff = isAdmin() ? (await API.get('/api/admin/teachers', 45000)).filter((u) => u.active) : [];
      // 老师只能开自己教的科目；负责人不限
      const myIds = subj.mine || [];
      const subjList = (!isAdmin() && myIds.length) ? subj.subjects.filter((x) => myIds.includes(x.id)) : subj.subjects;
      // 只在刚进这个表单时初始化，之后重画（比如新建课程后）不要把已选的清掉
      const formKey = String(S.clsId || 'new');
      if (S.formFor !== formKey) {
        S.formFor = formKey;
        S.formSubj = subId || (subjList[0] || {}).id;
        S.formCourse = c ? (c.course && c.course.id) || c.courseId || null : null;
        S.formSched = c && c.schedule ? { ...c.schedule } : { days: [], start: '', end: '' };
      }
      const curT = c ? c.teacherId : (Store.user || {}).id;
      const teacherField = staff.length ? `<label class="field"><span>任课老师</span><select id="c-teacher">${
        staff.map((u) => `<option value="${u.id}"${u.id === curT ? ' selected' : ''}>${esc(u.name)}${u.role === 'admin' ? '（负责人）' : ''}</option>`).join('')}</select></label>` : '';
      return `<div class="card">
        <div class="field"><span>科目${!isAdmin() && myIds.length ? '（你教的科目）' : ''}</span>
          <div class="chips">${subjList.map((x) => `<label class="chip ${esc(x.color)}"><input type="radio" name="c-subj" value="${x.id}"${x.id === subId ? ' checked' : ''}><span>${esc(x.name)}</span></label>`).join('')}</div>
          ${!isAdmin() && !myIds.length ? '<div class="muted small mt">负责人还没给你设科目，现在可以选全部</div>' : ''}</div>
        <label class="field"><span>年级 / 层次（可不填，也可以自己写，比如「三到五年级」「周末提高班」）</span>
          <input id="c-band" value="${c ? esc(c.gradeBand || '') : ''}" maxlength="12" placeholder="不填也行"></label>
        <div class="field" style="margin-top:-6px">
          ${suggest.map((g) => `<div class="row" style="gap:6px;align-items:flex-start;margin-bottom:6px">
            <span class="muted small" style="flex:0 0 42px;padding-top:7px">${esc(g.group)}</span>
            <div class="chips grow">${g.items.map((b) => `<button class="fchip sm" data-act="pickBand" data-v="${esc(b)}">${esc(b)}</button>`).join('')}</div>
          </div>`).join('')}
        </div>
        <div class="field"><span>课程（科目下面的具体课，可不选）</span>
          <div id="course-box">${courseChips(subj.subjects, S.formSubj, S.formCourse)}</div></div>
        <div class="field"><span>上课时间（选了之后，教务台会把今天有课的班排在最前面）</span>
          <div class="chips">${WEEK.map((w, i) => `<label class="chip"><input type="checkbox" data-week="${i}"${S.formSched.days.includes(i) ? ' checked' : ''}><span>周${w}</span></label>`).join('')}</div>
          <div class="row mt" style="gap:8px"><input id="c-start" type="time" value="${esc(S.formSched.start || '')}" style="width:auto;flex:1">
            <span class="muted small" style="flex:0 0 auto">到</span>
            <input id="c-end" type="time" value="${esc(S.formSched.end || '')}" style="width:auto;flex:1"></div>
          <div class="muted small mt">只选星期、不填时间也行</div></div>
        <label class="field"><span>班级名称（可不填，自动按「年级段 + 课程」起名）</span><input id="c-name" value="${c ? esc(c.name) : ''}" placeholder="例如：新概念英语 周六上午班"></label>
        ${teacherField}
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
      const hws = await API.get('/api/homeworks', 45000);
      if (!hws.length) return `<div class="empty">还没布置过作业<br><span class="small">点右上角「+ 布置」</span></div>`;
      // 待批改的排最前面，标红显示份数；剩下的按"还没交齐"和"全批完"分开
      const todo = hws.filter((h) => h.pending > 0);
      const rest = hws.filter((h) => !h.pending);
      const item = (h) => `<div class="hwitem ${h.pending ? 'hw-todo' : ''}" data-go="review" data-arg='${JSON.stringify({ hwId: h.id })}'>
        <div class="row between"><div class="strong ellip grow">${subjTag(h.subject)}${esc(h.title)}</div>
          ${h.pending ? `<span class="pill todo">${h.pending} 份待批改</span>`
            : `<span class="pill ${h.submitted >= h.total && h.total ? 'ok' : ''}">${h.submitted >= h.total && h.total ? '全批完' : `${h.submitted}/${h.total} 已交`}</span>`}</div>
        <div class="muted small mt">${h.kind === 'questions' ? `${h.itemCount} 道题` : `${h.itemCount} 句跟读`} · ${esc(h.className)} · ${fmtDate(h.createdAt)}
          · 已交 ${h.submitted}/${h.total}${h.reviewed ? ` · 已批 ${h.reviewed}` : ''}</div>
      </div>`;
      return `${todo.length ? `<div class="row between mb"><div class="section-title">待批改</div>
          <span class="pill todo">${todo.reduce((a, b) => a + b.pending, 0)} 份</span></div>
        ${todo.map(item).join('')}` : '<div class="card tight mb"><div class="strong">作业都批完了</div></div>'}
        ${rest.length ? `<div class="section-title mb mt">其他作业</div>${rest.map(item).join('')}` : ''}`;
    },
  };

  const HWNEW = {
    top: () => `<button class="back" data-go="hwlist">‹</button><h1>布置作业</h1>`, noTab: true,
    body: async () => {
      const [classes, books] = await Promise.all([API.get('/api/classes', 45000), API.get('/api/books', 300000)]);
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
          <div class="row mt" style="gap:8px;flex-wrap:wrap">
            <button class="btn sm mint" data-act="genMath">自动出计算题</button>
            <button class="btn sm grey" data-act="symbols">插入符号</button>
          </div>
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
  /** 完全没动过的空题：自动出题或发布时直接丢掉，免得挡住发布 */
  function isEmptyQ(q) {
    return !String(q.stem || '').trim() && !q.img && !String(q.analysis || '').trim()
      && (q.options || []).every((o) => !String(o || '').trim())
      && (q.blanks || []).every((b) => !String(b || '').trim());
  }

  function drawQs() {
    const box = document.getElementById('q-list');
    if (box) box.innerHTML = S.qs.map(qHtml).join('');
  }

  async function loadPages() {
    const bookId = document.getElementById('f-book').value;
    const cat = await API.get(`/api/books/${bookId}/catalog`, 300000);
    const opts = [];
    cat.lessons.forEach((l) => l.pages.forEach((p) => opts.push(`<option value="${p.id}">${esc(l.title)} · 第 ${p.pageNo} 页（${p.hotspotCount} 句）</option>`)));
    document.getElementById('f-page').innerHTML = opts.join('') || '<option value="">（无页面）</option>';
    await loadHotspots();
  }
  async function loadHotspots() {
    const pid = document.getElementById('f-page').value;
    if (!pid) return;
    const d = await API.get(`/api/pages/${pid}`, 300000);
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
            ${isHwClass(d.homework.subject) ? rubricBox(ri, r) : ''}
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

  /* 作业班的评分栏：书写、坐姿、学习态度、作业效率各打星，再记用时和一句话 */
  const RUBRIC = [['write', '书写'], ['posture', '坐姿'], ['attitude', '学习态度'], ['efficiency', '作业效率']];
  const isHwClass = (subject) => !!subject && subject.code === 'hwclass';

  function rubricBox(ri, r) {
    const rb = r.rubric || {};
    return `<div class="rubric">
      <div class="section-title mb">作业班评分</div>
      ${RUBRIC.map(([k, name]) => `<div class="row between rub-row">
        <span>${name}</span>
        <span class="stars" data-act="setRubStar" data-ri="${ri}" data-key="${k}" id="rb-${ri}-${k}" data-val="${rb[k] || 0}">${starStr(rb[k] || 0)}</span>
      </div>`).join('')}
      <div class="row rub-row" style="gap:10px">
        <span class="grow">作业时长</span>
        <input class="mins" type="number" min="1" max="600" inputmode="numeric" id="rb-${ri}-min" value="${rb.minutes || ''}" placeholder="分钟">
      </div>
      <input id="rb-${ri}-other" value="${esc(rb.other || '')}" placeholder="其他（比如：今天主动问了三个问题）">
    </div>`;
  }

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
          ${isHwClass(hw.subject) ? rubricBox(ri, r) : ''}
          ${excellentBox(ri, r, hw.subject)}
          <div class="row mt" style="gap:8px">
            <button class="btn sm grow" data-act="doGrade" data-ri="${ri}">${r.status === 'reviewed' ? '修改批改' : '提交批改'}</button>
            <button class="btn sm danger" data-act="doReject" data-ri="${ri}">打回重做</button>
          </div></div>` : '<div class="muted small mt">还没交</div>'}
      </details>`).join('')}`;
  }

  /* ================= 教务档案 ================= */
  const todayStr = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const ST_NAME = { active: '在读', paused: '停课', left: '已结业' };
  const ATT_NAME = { present: '到课', leave: '请假', absent: '旷课' };

  /* ---------- 学员名单 ---------- */
  const STUDENTS = {
    top: () => `<h1><img src="brand/logo-96.png" alt="">学员</h1>${isAdmin() ? '<button class="btn sm" data-act="newStudent">+ 建档</button>' : ''}`, tab: true,
    body: async () => {
      const list = await API.get('/api/admin/students' + (S.stuQ ? '?q=' + encodeURIComponent(S.stuQ) : ''), 45000);
      const low = list.filter((x) => x.status === 'active' && x.leftHours > 0 && x.leftHours <= 4);
      return `<div class="card tight mb"><input id="stu-q" value="${esc(S.stuQ || '')}" placeholder="搜学员姓名" data-act="noop"></div>
        ${low.length ? `<div class="card tight mb warnbox"><div class="strong">课时快用完了</div>
          <div class="small mt">${low.map((x) => `${esc(x.name)} 剩 ${x.leftHours} 课时`).join('、')}</div></div>` : ''}
        ${list.length > 60 ? `<div class="muted small mb">共 ${list.length} 人，先显示 60 个，用上面的搜索框找人</div>` : ''}
        ${list.length ? list.slice(0, 60).map((x) => `<div class="card stu" data-go="student" data-arg='${JSON.stringify({ stuId: x.id })}'>
          <div class="row between">
            <div class="strong grow ellip">${esc(x.name)}
              ${x.status === 'active' ? '' : `<span class="pill">${ST_NAME[x.status] || ''}</span>`}</div>
            <span class="pill ${x.leftHours > 4 ? 'ok' : x.leftHours > 0 ? 'warn' : 'todo'}">剩 ${x.leftHours} 课时</span>
          </div>
          <div class="muted small mt">${[x.grade, x.school, x.classes.join('、')].filter(Boolean).map(esc).join(' · ') || '还没填档案'}</div>
          ${x.expiresAt ? `<div class="muted small">到期 ${esc(x.expiresAt)}</div>` : ''}
        </div>`).join('') : '<div class="empty">还没有学员<br><span class="small">点右上角「+ 建档」，或让学生用邀请码加入班级</span></div>'}`;
    },
    after: () => {
      const q = document.getElementById('stu-q');
      if (q) q.addEventListener('change', () => { S.stuQ = q.value.trim(); render(); });
    },
  };

  /* ---------- 学员档案详情 ---------- */
  const STUDENT = {
    top: () => `<button class="back" data-go="students">‹</button><h1>学员档案</h1>`, noTab: true,
    body: async () => {
      const d = await API.get('/api/admin/students/' + S.stuId);
      S.stu = d;
      const admin = isAdmin();
      const p = d.profile || {};
      return `<div class="card">
        <div class="row between"><div><div class="section-title">${esc(d.name)}</div>
          <div class="muted small mt">${[p.gender, p.grade, p.school].filter(Boolean).map(esc).join(' · ') || '资料还没填'}</div></div>
          <div class="right"><div class="bigscore">${d.hours.leftHours}<small> 课时</small></div>
            ${d.hours.expiresAt ? `<div class="muted small">${esc(d.hours.expiresAt)} 到期</div>` : ''}</div></div>
        <div class="hr"></div>
        <div class="small">班级：${d.classes.map((c) => `${subjTag(c.subject)}${esc(c.name)}`).join(' ') || '还没进班'}</div>
        ${admin ? `<div class="small mt">家长：${esc(p.parentName || '—')} ${p.phone ? `<a href="tel:${esc(p.phone)}">${esc(p.phone)}</a>` : ''}</div>
        ${p.note ? `<div class="muted small mt">备注：${esc(p.note)}</div>` : ''}
        <div class="row mt" style="gap:8px"><button class="btn sm ghost" data-act="editStudent">修改资料</button>
          <span class="pill">${ST_NAME[p.status] || '在读'}</span></div>` : ''}
      </div>

      <div class="row between mb"><div class="section-title">课时包</div>
        ${admin ? '<button class="btn sm" data-act="newPackage">+ 购买课包</button>' : ''}</div>
      ${d.packages.length ? d.packages.map((k) => `<div class="card pkg ${k.status}">
        <div class="row between"><div class="strong">${k.subject ? subjTag(k.subject) : ''}${k.sumHours} 课时
          <span class="muted small">（购 ${k.totalHours} + 送 ${k.giftHours}）</span></div>
          <span class="pill ${k.status === 'active' ? 'ok' : k.status === 'paused' ? 'warn' : ''}">${k.status === 'active' ? '在用' : k.status === 'paused' ? '停课中' : '已结束'}</span></div>
        <div class="row between mt"><span class="muted small">已用 ${k.usedHours} · 剩 <b>${k.leftHours}</b></span>
          <span class="muted small">${esc(k.purchasedAt || '')} → ${esc(k.expiresAt || '不限')}</span></div>
        ${admin && (k.priceOriginal || k.pricePaid) ? `<div class="muted small mt">原价 ¥${k.priceOriginal} · 实收 <b>¥${k.pricePaid}</b></div>` : ''}
        ${k.note ? `<div class="muted small">${esc(k.note)}</div>` : ''}
        ${admin ? `<div class="row mt" style="gap:8px;flex-wrap:wrap">
          <button class="btn sm ghost" data-act="adjustHours" data-id="${k.id}">加/减课时</button>
          ${k.status === 'active' ? `<button class="btn sm grey" data-act="pausePkg" data-id="${k.id}">停课</button>` : ''}
          ${k.status === 'paused' ? `<button class="btn sm mint" data-act="resumePkg" data-id="${k.id}">恢复上课</button>` : ''}
          <button class="btn sm grey" data-act="editPkg" data-id="${k.id}" data-exp="${esc(k.expiresAt || '')}">改到期日</button>
          ${k.status !== 'finished' ? `<button class="btn sm grey" data-act="finishPkg" data-id="${k.id}">结束</button>` : ''}
        </div>` : ''}
      </div>`).join('') : '<div class="card tight muted small mb">还没有课包</div>'}

      <div class="section-title mb">最近上课</div>
      ${d.attendance.length ? d.attendance.map((a) => `<div class="card tight">
        <div class="row between"><span>${esc(a.date)} ${esc(a.className || '')}</span>
          <span class="pill ${a.status === 'present' ? 'ok' : a.status === 'leave' ? 'warn' : 'todo'}">${ATT_NAME[a.status]}${a.hours ? ` −${a.hours}` : ''}</span></div>
      </div>`).join('') : '<div class="card tight muted small">还没有上课记录</div>'}

      ${admin && d.logs.length ? `<div class="section-title mb mt">课时流水</div>
        <div class="card">${d.logs.map((l) => `<div class="row between logline">
          <span class="muted small">${esc(l.date || '')} ${esc({ present: '上课', absent: '旷课', adjust: '手工调整', revert: '退回', leave: '请假' }[l.reason] || l.reason)}${l.note ? ' · ' + esc(l.note) : ''}</span>
          <b class="${l.hours < 0 ? 'minus' : 'plus'}">${l.hours > 0 ? '+' : ''}${l.hours}</b></div>`).join('')}</div>` : ''}`;
    },
  };

  /* ---------- 点名 ---------- */
  const ROLL = {
    top: () => `<button class="back" data-go="classes">‹</button><h1>点名</h1>`, noTab: true,
    body: async () => {
      const d = await API.get(`/api/classes/${S.clsId}/attendance?date=${S.rollDate || todayStr()}`);
      S.roll = d;
      return `<div class="card">
        <div class="row between"><div class="strong grow ellip">${subjTag(d.subject)}${esc(d.className)}</div>
          <input type="date" id="roll-date" value="${esc(d.date)}" data-act="noop" style="width:148px;flex:0 0 auto"></div>
        ${d.hasSchedule ? `<div class="muted small mt">${esc(d.scheduleText)}${d.meetsOn ? '' : ' · 这天不是排的上课日，补课或调课照常点名就行'}</div>` : ''}
        <div class="row mt" style="gap:10px"><span class="muted small grow">本次每人扣</span>
          <input id="roll-hours" type="number" min="0.5" max="10" step="0.5" value="${d.defaultHours || 1}" style="width:88px;text-align:center"> <span class="muted small">课时</span></div>
      </div>
      <div class="card tight mb"><div class="row" style="gap:8px">
        <button class="btn sm mint grow" data-act="rollAll" data-st="present">全部到课</button>
        <span class="muted small">请假不扣课时</span></div></div>
      ${d.students.map((st) => `<div class="card tight roll" id="rl-${st.id}">
        <div class="row between">
          <div class="grow"><b>${esc(st.name)}</b>
            <span class="muted small"> 剩 ${st.leftHours} 课时${st.approvedLeave ? ' · 已批准请假' : ''}</span></div>
        </div>
        <div class="row mt" style="gap:6px">
          ${['present', 'leave', 'absent'].map((k) => `<button class="btn sm ${st.status === k ? (k === 'present' ? 'mint' : k === 'leave' ? 'star' : 'coral') : 'ghost'} grow"
            data-act="rollPick" data-id="${st.id}" data-st="${k}">${ATT_NAME[k]}</button>`).join('')}
        </div>
      </div>`).join('') || '<div class="empty">这个班还没有学生</div>'}
      ${d.students.length ? '<button class="btn block mt" data-act="saveRoll">保存点名并扣课时</button>' : ''}
      ${d.dates.length ? `<div class="muted small center mt">最近点名：${d.dates.map((x) => esc(x.date)).join('、')}</div>` : ''}`;
    },
    after: () => {
      const dt = document.getElementById('roll-date');
      if (dt) dt.addEventListener('change', () => go('roll', { clsId: S.clsId, rollDate: dt.value }));
    },
  };

  /* ---------- 请假审批 ---------- */
  const LEAVES = {
    top: () => `<button class="back" data-go="me">‹</button><h1>请假审批</h1>`, noTab: true,
    body: async () => {
      const d = await API.get('/api/admin/leaves', 20000);
      const pend = d.list.filter((l) => l.status === 'pending');
      const other = d.list.filter((l) => l.status !== 'pending').slice(0, 15);
      return `${pend.length ? pend.map((l) => `<div class="card">
          <div class="row between"><div><b>${esc(l.studentName)}</b> <span class="muted small">${esc(l.className || '')}</span></div>
            <span class="pill warn">${esc(l.date)}</span></div>
          ${l.reason ? `<div class="small mt">${esc(l.reason)}</div>` : ''}
          <div class="row mt" style="gap:8px">
            <button class="btn sm grow" data-act="leaveOk" data-id="${l.id}">准假（不扣课时）</button>
            <button class="btn sm danger" data-act="leaveNo" data-id="${l.id}">不准</button>
          </div></div>`).join('') : '<div class="card tight muted small mb">没有待审批的请假</div>'}
        ${other.length ? `<div class="section-title mb mt">最近处理</div>${other.map((l) => `<div class="card tight">
          <div class="row between"><span>${esc(l.studentName)} · ${esc(l.date)}</span>
            <span class="pill ${l.status === 'approved' ? 'ok' : ''}">${l.status === 'approved' ? '已准假' : '未准'}</span></div></div>`).join('')}` : ''}`;
    },
  };

  /* ---------- 学校简介 ---------- */
  const ABOUT = {
    top: () => `<button class="back" data-go="me">‹</button><h1>学校信息</h1>`, noTab: true,
    body: async () => {
      const [a, ct, courses] = await Promise.all([API.get('/api/about'), API.get('/api/contact'), API.get('/api/courses')]);
      S.allCourses = courses;
      return `<div class="card">
        <div class="section-title mb">联系方式（会显示在分享页、预约页和简介页底部）</div>
        <label class="field"><span>电话</span><input id="ct-phone" value="${esc(ct.phone || '')}" inputmode="tel" placeholder="15131810365"></label>
        <label class="field"><span>地址</span><textarea id="ct-address" rows="2" placeholder="和平路…福斯特培训学校（8-5、8-6门店）">${esc(ct.address || '')}</textarea></label>
        <label class="field"><span>营业时间（可不填）</span><input id="ct-hours" value="${esc(ct.hours || '')}" placeholder="周一至周日 9:00–20:00"></label>
        <div class="field"><span>微信二维码</span>
          <div class="row" style="gap:12px;align-items:center">
            ${ct.qr ? `<img class="ct-qr" src="${esc(ct.qr)}" alt="二维码">` : '<div class="ct-qr none">还没传</div>'}
            <label class="btn sm ghost" style="display:inline-flex">${ct.qr ? '换一张' : '上传二维码'}<input type="file" accept="image/*" id="ct-qr" hidden></label>
          </div></div>
        <button class="btn block" data-act="saveContact">保存联系方式</button>
      </div>
      <div class="card">
        <div class="row between mb"><div class="section-title">预约页显示的课程</div>
          <button class="btn sm" data-act="savePublicCourses">保存</button></div>
        <div class="muted small mb">家长在预约试听页勾了科目后，只会看到这里打勾的课程。不勾就只显示科目。</div>
        ${S.allCourses.length ? [...new Set(S.allCourses.map((c) => c.subject && c.subject.name))].map((sn) => `
          <div class="row" style="gap:8px;align-items:flex-start;margin-bottom:8px">
            <span class="muted small" style="flex:0 0 46px;padding-top:7px">${esc(sn || '其他')}</span>
            <div class="chips grow">${S.allCourses.filter((c) => (c.subject && c.subject.name) === sn).map((c) => `
              <label class="chip"><input type="checkbox" data-pub="${c.id}"${c.public ? ' checked' : ''}><span>${esc(c.name)}</span></label>`).join('')}</div>
          </div>`).join('') : '<div class="muted small">还没有课程</div>'}
      </div>
      <div class="card">
        <div class="section-title mb">学校简介</div>
        <label class="field"><span>标题</span><input id="ab-title" value="${esc(a.title || '')}" placeholder="福斯特培训学校"></label>
        <label class="field"><span>简介正文</span><textarea id="ab-text" rows="8" placeholder="办学理念、师资、课程、地址电话…">${esc(a.text || '')}</textarea></label>
        <div class="field"><span>图片（最多 6 张，可传学校环境、师资海报）</span>
          <div class="thumbs" id="ab-imgs">${(a.images || []).map((u) => `<button class="thumb" data-act="zoom" data-src="${esc(u)}"><img src="${esc(u)}" alt=""></button>`).join('')}
            <label class="thumb add">加图片<input type="file" accept="image/*" id="ab-file" hidden></label></div></div>
        <button class="btn block" data-act="saveAbout">保存</button>
        <div class="row mt" style="gap:8px"><a class="btn sm ghost grow" href="/about" target="_blank">看看家长打开的样子</a></div>
      </div>`;
    },
  };

  /* ---------- 星星奖品：学生用星星换礼物，老师在前台发放 ---------- */
  const REWARDS = {
    top: () => `<button class="back" data-go="me">‹</button><h1>星星奖品</h1>`, noTab: true,
    body: async () => {
      const admin = isAdmin();
      const [data, reds] = await Promise.all([API.get('/api/rewards', 20000), API.get('/api/admin/redemptions', 20000)]);
      const pending = reds.list.filter((r) => r.status === 'pending');
      const done = reds.list.filter((r) => r.status !== 'pending').slice(0, 10);
      const newForm = admin ? `<div class="card">
        <div class="section-title mb">添加奖品</div>
        <div class="row" style="gap:10px">
          <label class="field grow"><span>奖品名称</span><input id="rw-name" placeholder="例如：精美文具套装"></label>
          <label class="field" style="width:110px;flex:0 0 auto"><span>需要星星</span><input id="rw-stars" type="number" min="1" inputmode="numeric" value="200"></label>
        </div>
        <label class="field"><span>说明（可不填）</span><input id="rw-note" placeholder="例如：到前台领取"></label>
        <div class="row between">
          <label class="btn sm ghost" style="display:inline-flex">加照片<input type="file" accept="image/*" id="rw-img" hidden></label>
          <span class="muted small grow" id="rw-imgtip">家长和孩子看得见照片会更有动力</span>
          <button class="btn sm" data-act="addReward">添加</button>
        </div>
      </div>` : '';
      return `${newForm}
      <div class="row between mb"><div class="section-title">待发放</div>${pending.length ? `<span class="pill todo">${pending.length} 份</span>` : ''}</div>
      ${pending.length ? pending.map((r) => `<div class="card tight">
        <div class="row between"><div><b>${esc(r.studentName)}</b> 换 ${esc(r.rewardName)}</div><span class="pill blue">${r.stars} 星</span></div>
        <div class="muted small mt">${fmtDate(r.createdAt)}</div>
        <div class="row mt" style="gap:8px">
          <button class="btn sm grow" data-act="redDone" data-id="${r.id}">已发放</button>
          <button class="btn sm danger" data-act="redCancel" data-id="${r.id}" data-name="${esc(r.studentName)}">取消退星</button>
        </div>
      </div>`).join('') : '<div class="card tight muted small">还没有人兑换</div>'}
      ${admin ? `<div class="section-title mb mt">奖品（${data.rewards.length}）</div>
      ${data.rewards.map((r) => `<div class="card reward ${r.active ? '' : 'off'}">
        <div class="row" style="gap:12px">
          ${r.image ? `<img class="rw-pic" src="${esc(r.image.url)}" alt="">` : '<div class="rw-pic none">无图</div>'}
          <div class="grow"><div class="strong">${esc(r.name)}${r.active ? '' : ' <span class="pill">已下架</span>'}</div>
            <div class="muted small">${r.stars} 颗星 · 已兑换 ${r.redeemed || 0} 次${r.note ? ' · ' + esc(r.note) : ''}</div></div>
        </div>
        <div class="row mt" style="gap:8px;flex-wrap:wrap">
          <button class="btn sm ghost" data-act="editReward" data-id="${r.id}" data-name="${esc(r.name)}" data-stars="${r.stars}">改名称 / 星数</button>
          <button class="btn sm grey" data-act="toggleReward" data-id="${r.id}" data-on="${r.active ? 1 : 0}">${r.active ? '下架' : '上架'}</button>
          ${r.redeemed ? '' : `<button class="btn sm danger" data-act="delReward" data-id="${r.id}" data-name="${esc(r.name)}">删除</button>`}
        </div>
      </div>`).join('')}` : ''}
      ${done.length ? `<div class="section-title mb mt">最近处理</div>
        ${done.map((r) => `<div class="card tight"><div class="row between"><span>${esc(r.studentName)} · ${esc(r.rewardName)}</span>
          <span class="pill ${r.status === 'done' ? 'ok' : ''}">${r.status === 'done' ? '已发放' : '已取消'}</span></div></div>`).join('')}` : ''}`;
    },
  };

  /* ---------- 咨询：按该做什么排序，先打该打的电话 ---------- */
  const LEAD_ST = { new: '待联系', contacted: '跟进中', trial: '已约试听', enrolled: '已报名', invalid: '无效' };
  const addDays = (n) => new Date(Date.now() + 8 * 3600 * 1000 + n * 86400000).toISOString().slice(0, 10);

  const LEADS = {
    top: () => `<button class="back" data-go="me">‹</button><h1>家长咨询</h1>`, noTab: true,
    body: async () => {
      const [ps, d] = await Promise.all([API.get('/api/admin/promo-stats', 20000), API.get('/api/admin/leads', 20000)]);
      const list = d.list || [];
      const f = d.funnel || {};
      const src = (l) => (l.source === 'share' ? (l.refName ? `看了 ${esc(l.refName)} 的分享` : '来自分享页')
        : l.source === 'gallery' ? '来自书法作品展' : '来自预约试听页');
      const todo = list.filter((l) => l.status === 'new').sort((a, b) => (b.waitingHours || 0) - (a.waitingHours || 0));
      const due = list.filter((l) => l.status === 'contacted' && (l.overdue || l.dueToday));
      const soon = list.filter((l) => l.status === 'contacted' && !l.overdue && !l.dueToday);
      const trial = list.filter((l) => l.status === 'trial').sort((a, b) => String(a.trialAt || '9999').localeCompare(String(b.trialAt || '9999')));
      const rest = list.filter((l) => l.status === 'enrolled' || l.status === 'invalid');

      const card = (l, tone) => `<div class="card lead ${tone}">
        <div class="row between">
          <a class="strong lead-phone" href="tel:${esc(l.phone)}">${esc(l.phone.replace(/(\d{3})(\d{4})(\d{4})/, '$1 $2 $3'))}</a>
          <span class="pill ${tone === 'urgent' ? 'todo' : tone === 'warn' ? 'warn' : tone === 'ok' ? 'ok' : ''}">${LEAD_ST[l.status]}</span>
        </div>
        <div class="small mt">${esc(l.grade || '')}${l.subjectNames.length ? ' · ' + l.subjectNames.map(esc).join('、') : ''}${l.courseNames && l.courseNames.length ? ' · ' + l.courseNames.map(esc).join('、') : ''}</div>
        ${l.message ? `<div class="lead-msg">家长留言：${esc(l.message)}</div>` : ''}
        <div class="muted small">${src(l)} · ${fmtDate(l.createdAt)}${l.status === 'new' && l.waitingHours != null
          ? ` · ${l.waitingHours < 24 ? `等了 ${l.waitingHours} 小时` : `等了 ${Math.floor(l.waitingHours / 24)} 天`}` : ''}</div>
        ${l.status === 'contacted' && l.followAt ? `<div class="muted small">${l.overdue ? '跟进已逾期：' : l.dueToday ? '今天要跟进：' : '下次跟进：'}${esc(l.followAt)}</div>` : ''}
        ${l.status === 'trial' && l.trialAt ? `<div class="muted small">试听日期：${esc(l.trialAt)}</div>` : ''}
        <div class="row mt" style="gap:6px;flex-wrap:wrap">
          ${l.status === 'new' ? `<button class="btn sm" data-act="leadTo" data-id="${l.id}" data-st="contacted">已联系</button>` : ''}
          ${l.status !== 'trial' && l.status !== 'enrolled' ? `<button class="btn sm sky" data-act="leadTo" data-id="${l.id}" data-st="trial">约试听</button>` : ''}
          ${l.status !== 'enrolled' ? `<button class="btn sm mint" data-act="leadTo" data-id="${l.id}" data-st="enrolled">已报名</button>` : ''}
          ${l.status !== 'invalid' ? `<button class="btn sm grey" data-act="leadTo" data-id="${l.id}" data-st="invalid">无效</button>` : ''}
          ${l.status === 'contacted' || l.status === 'trial' ? `<button class="btn sm ghost" data-act="leadDate" data-id="${l.id}" data-st="${l.status}" data-cur="${esc(l.followAt || l.trialAt || '')}">改日期</button>` : ''}
          <button class="btn sm ghost" data-act="leadNote" data-id="${l.id}" data-cur="${esc(l.note || '')}">${l.note ? '改备注' : '写备注'}</button>
        </div>
        ${l.note ? `<div class="muted small mt">备注：${esc(l.note)}</div>` : ''}
      </div>`;
      const group = (title, arr, tone, hint) => (arr.length
        ? `<div class="row between mb mt"><div class="section-title">${title}</div><span class="pill ${tone === 'urgent' ? 'todo' : ''}">${arr.length}</span></div>
           ${hint ? `<div class="muted small mb">${hint}</div>` : ''}${arr.map((l) => card(l, tone)).join('')}` : '');

      return `<div class="card">
        <div class="section-title mb">近 30 天转化</div>
        <div class="minis"><div><b>${f.total || 0}</b><span>咨询</span></div><div><b>${f.trials || 0}</b><span>约到试听</span></div>
          <div><b>${f.enrolled || 0}</b><span>报名</span></div></div>
        <div class="muted small mt">近 7 天：${ps.last7.shares} 次分享 · ${ps.last7.views} 人看过 · ${ps.last7.leads} 条预约</div>
        <div class="row mt" style="gap:8px">
          <a class="btn sm ghost grow" href="/gallery" target="_blank">书法作品展</a>
          <a class="btn sm ghost grow" href="/trial" target="_blank">预约试听页</a>
        </div>
      </div>
      ${todo.length || due.length ? `<div class="card tight warnbox"><div class="strong">今天要做</div>
        <div class="small mt">${todo.length ? `${todo.length} 个新咨询要打电话` : ''}${todo.length && due.length ? '；' : ''}${due.length ? `${due.length} 个到期要跟进` : ''}</div></div>`
        : '<div class="card tight muted small">新咨询都联系过了，跟进也没有逾期</div>'}
      ${group('待联系', todo, 'urgent', '等得越久越靠前，趁热打')}
      ${group('该跟进了', due, 'warn', '约好的日子到了')}
      ${group('跟进中', soon, 'plain')}
      ${group('已约试听', trial, 'blue', '提前一天提醒家长')}
      ${group('已报名 / 无效', rest, 'dim')}
      ${list.length ? '' : '<div class="empty">还没有家长预约<br><span class="small">学生分享喜报、作品后，家长可以在分享页上预约试听</span></div>'}`;
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
      ${admin ? `<div class="card"><div class="row between mb"><div class="section-title">家长咨询</div>
          <button class="btn sm" data-go="leads">查看</button></div>
        <div class="muted small">分享页和预约页收到的家长预约，只有负责人能看到手机号。</div></div>` : ''}
      <div class="card"><div class="row between mb"><div class="section-title">请假审批</div>
          <button class="btn sm" data-go="leaves">查看</button></div>
        <div class="muted small">家长在学生端提交请假，准假后点名时这一天不扣课时。</div></div>
      ${admin ? `<div class="card"><div class="row between mb"><div class="section-title">学校简介</div>
          <button class="btn sm" data-go="about">编辑</button></div>
        <div class="muted small">编辑后生成一个公开页面，可以直接发给家长。</div></div>` : ''}
      <div class="card"><div class="row between mb"><div class="section-title">星星奖品</div>
          <button class="btn sm" data-go="rewards">${admin ? '管理' : '发放'}</button></div>
        <div class="muted small">学生攒够星星在手机上兑换，${admin ? '你在这里设置奖品，' : ''}孩子来前台领时点一下「已发放」。</div></div>
      <div class="card"><div class="row between"><span>切换账号</span><button class="btn sm grey" data-act="logout">退出登录</button></div></div>`;
    },
  };

  /* ---------- 教职工账号（只有负责人能进） ---------- */
  const STAFF = {
    top: () => `<button class="back" data-go="me">‹</button><h1>老师账号</h1><button class="btn sm" data-act="newStaff">+ 新建</button>`, noTab: true,
    body: async () => {
      const [list, subj] = await Promise.all([API.get('/api/admin/teachers'), API.get('/api/meta', 300000)]);
      S.subjects = subj.subjects;
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
          <div class="field mt" style="margin-bottom:6px"><span>教的科目${u.role === 'admin' ? '（负责人不受限制，这里是她自己带的课）' : '（决定他能开哪些科目的班）'}</span>
            <div class="chips">${S.subjects.map((x) => `<label class="chip ${esc(x.color)}"><input type="checkbox" data-subj-of="${u.id}" value="${x.id}"${(u.subjectIds || []).includes(x.id) ? ' checked' : ''}><span>${esc(x.name)}</span></label>`).join('')}</div>
            <button class="btn sm ghost mt" data-act="saveSubjects" data-id="${u.id}" data-name="${esc(u.name)}">保存科目</button></div>
          ${u.role === 'admin' && u.isMe ? `<div class="row between mt"><span class="muted small">负责人用部署时设置的主口令登录</span>
            <button class="btn sm grey" data-act="renameStaff" data-id="${u.id}" data-name="${esc(u.name)}">改名</button></div>` : `
          <div class="row mt" style="gap:8px;flex-wrap:wrap">
            ${u.canShowCode ? `<button class="btn sm star" data-act="showCode" data-id="${u.id}">查看口令</button>` : ''}
            <button class="btn sm ghost" data-act="resetCode" data-id="${u.id}" data-name="${esc(u.name)}">重置口令</button>
            <button class="btn sm grey" data-act="renameStaff" data-id="${u.id}" data-name="${esc(u.name)}">改名</button>
            <button class="btn sm grey" data-act="toggleRole" data-id="${u.id}" data-name="${esc(u.name)}" data-role="${u.role}">${u.role === 'admin' ? '改为老师' : '设为负责人'}</button>
            <button class="btn sm grey" data-act="toggleStaff" data-id="${u.id}" data-on="${u.active ? 1 : 0}">${u.active ? '停用' : '恢复'}</button>
            ${u.classCount
              ? `<button class="btn sm ghost" data-act="transferClasses" data-id="${u.id}" data-name="${esc(u.name)}">转出班级</button>`
              : `<button class="btn sm danger" data-act="delStaff" data-id="${u.id}" data-name="${esc(u.name)}">删除</button>`}
          </div>`}
        </div>`).join('')}`;
    },
  };

  /* ---------- 自动出小学计算题 ----------
   * 在手机上一道道敲计算题太慢，这里按范围一次生成，生成后每道题都还能改。
   */
  const MATH_KINDS = [
    ['add20', '20 以内加减法'], ['add100', '100 以内加减法'], ['mul9', '表内乘除法（九九表）'],
    ['mul2x1', '两位数 × 一位数'], ['div', '除法（无余数）'], ['mix', '混合：加减乘除'],
  ];
  const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));

  function makeMathQuestion(kind, score) {
    let stem, answer;
    const plus = () => { const a = rnd(1, kind === 'add20' ? 19 : 99), b = rnd(1, (kind === 'add20' ? 20 : 100) - a); return [`${a} + ${b}`, a + b]; };
    const minus = () => { const a = rnd(2, kind === 'add20' ? 20 : 100), b = rnd(1, a - 1); return [`${a} − ${b}`, a - b]; };
    const times = () => { const a = rnd(2, 9), b = rnd(2, 9); return [`${a} × ${b}`, a * b]; };
    const big = () => { const a = rnd(11, 99), b = rnd(2, 9); return [`${a} × ${b}`, a * b]; };
    const div = () => { const b = rnd(2, 9), r = rnd(2, 9); return [`${b * r} ÷ ${b}`, r]; };
    const pick = {
      add20: () => (Math.random() < 0.5 ? plus() : minus()),
      add100: () => (Math.random() < 0.5 ? plus() : minus()),
      mul9: () => (Math.random() < 0.5 ? times() : div()),
      mul2x1: big,
      div,
      mix: () => [plus, minus, times, div][rnd(0, 3)](),
    }[kind] || plus;
    [stem, answer] = pick();
    const q = newQ('blank');
    q.stem = `${stem} = ____`;
    q.blanks = [String(answer)];
    q.score = score;
    return q;
  }

  function genMathDialog() {
    const m = document.createElement('div');
    m.className = 'poster-mask'; m.id = 'mathbox';
    m.innerHTML = `<div class="poster-sheet" role="dialog" aria-label="自动出计算题">
        <div class="section-title">自动出计算题</div>
        <label class="field"><span>题型</span><select id="mg-kind">${MATH_KINDS.map(([k, n]) => `<option value="${k}">${n}</option>`).join('')}</select></label>
        <div class="row" style="gap:10px">
          <label class="field grow"><span>题数</span><input id="mg-n" type="number" min="1" max="30" value="10" inputmode="numeric"></label>
          <label class="field grow"><span>每题分值</span><input id="mg-score" type="number" min="1" max="20" value="5" inputmode="numeric"></label>
        </div>
        <div class="muted small">生成的是填空题，学生做完立刻出分。生成后还能逐题修改或删除。</div>
        <div class="row" style="gap:10px">
          <button class="btn ghost grow" data-act="closeMath">取消</button>
          <button class="btn grow" data-act="doGenMath">生成</button>
        </div>
      </div>`;
    m.addEventListener('click', (e) => { if (e.target === m) m.remove(); });
    document.getElementById('app').appendChild(m);
  }

  /* ---------- 符号面板：数学符号和音标，点一下插进正在编辑的那一栏 ---------- */
  const SYMBOLS = {
    数学: ['＋', '−', '×', '÷', '=', '≠', '＜', '＞', '≤', '≥', '≈', '±', '½', '⅓', '¼', '¾', '²', '³', '√', '∠', '°', '△', '○', 'π', '∵', '∴', '⊥', '∥', '％', '…', '｜｜', '（）'],
    音标: ['iː', 'ɪ', 'e', 'æ', 'ɑː', 'ɒ', 'ɔː', 'ʊ', 'uː', 'ʌ', 'ɜː', 'ə', 'eɪ', 'aɪ', 'ɔɪ', 'əʊ', 'aʊ', 'ɪə', 'eə', 'ʊə', 'p', 'b', 't', 'd', 'k', 'ɡ', 'f', 'v', 'θ', 'ð', 's', 'z', 'ʃ', 'ʒ', 'h', 'tʃ', 'dʒ', 'tr', 'dr', 'ts', 'dz', 'm', 'n', 'ŋ', 'l', 'r', 'j', 'w', 'ˈ', 'ˌ'],
  };

  function symbolPanel() {
    if (!S.lastField || !document.body.contains(S.lastField)) return toast('先点一下要输入的那一栏');
    const m = document.createElement('div');
    m.className = 'poster-mask'; m.id = 'symbox';
    const tabs = Object.keys(SYMBOLS);
    m.innerHTML = `<div class="poster-sheet" role="dialog" aria-label="插入符号">
        <div class="seg">${tabs.map((t, i) => `<button class="${i ? '' : 'on'}" data-symtab="${t}">${t}</button>`).join('')}</div>
        <div class="symgrid" id="symgrid">${SYMBOLS[tabs[0]].map((c) => `<button data-sym="${esc(c)}">${esc(c)}</button>`).join('')}</div>
        <button class="btn grey block" data-act="closeSym">完成</button>
      </div>`;
    m.addEventListener('click', (e) => {
      if (e.target === m) return m.remove();
      const tab = e.target.closest('[data-symtab]');
      if (tab) {
        [...m.querySelectorAll('[data-symtab]')].forEach((b) => b.classList.toggle('on', b === tab));
        document.getElementById('symgrid').innerHTML = SYMBOLS[tab.dataset.symtab].map((c) => `<button data-sym="${esc(c)}">${esc(c)}</button>`).join('');
        return;
      }
      const sym = e.target.closest('[data-sym]');
      if (sym) insertSymbol(sym.dataset.sym);
    });
    document.getElementById('app').appendChild(m);
  }

  /** 插到光标处，并让编辑器同步到 state */
  function insertSymbol(ch) {
    const el = S.lastField;
    if (!el) return;
    const start = el.selectionStart == null ? el.value.length : el.selectionStart;
    const end = el.selectionEnd == null ? el.value.length : el.selectionEnd;
    el.value = el.value.slice(0, start) + ch + el.value.slice(end);
    const pos = start + ch.length;
    try { el.setSelectionRange(pos, pos); } catch (e) {}
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /** 只刷新课程选择条，不动表单里已经填的内容 */
  async function refreshCourses() {
    const box = document.getElementById('course-box');
    if (!box) return;
    const meta = await API.get('/api/meta', 300000);
    box.innerHTML = courseChips(meta.subjects, S.formSubj, S.formCourse);
  }

  /** 点名按钮的选中样式 */
  function paintRoll(id, status) {
    const box = document.getElementById('rl-' + id);
    if (!box) return;
    [...box.querySelectorAll('[data-act="rollPick"]')].forEach((b) => {
      const on = b.dataset.st === status;
      b.className = `btn sm ${on ? (b.dataset.st === 'present' ? 'mint' : b.dataset.st === 'leave' ? 'star' : 'coral') : 'ghost'} grow`;
    });
  }

  /** 日期加几个月，用来给课包的到期日一个默认值 */
  function addMonths(dateStr, n) {
    const d = new Date(dateStr || todayStr());
    d.setMonth(d.getMonth() + n);
    return d.toISOString().slice(0, 10);
  }

  /** 通用的单选弹窗 */
  function pickList(title, list, onPick) {
    const m = document.createElement('div');
    m.className = 'poster-mask'; m.id = 'pickbox';
    m.innerHTML = `<div class="poster-sheet" role="dialog" aria-label="${esc(title)}">
        <div class="section-title">${esc(title)}</div>
        <div class="picklist">${list.map((x, i) => `<button class="btn ghost block" data-pick="${i}">${esc(x.name)}</button>`).join('')}</div>
        <button class="btn grey block" data-act="closePick">取消</button>
      </div>`;
    m.addEventListener('click', (e) => {
      if (e.target === m) return m.remove();
      const b = e.target.closest('[data-pick]');
      if (!b) return;
      m.remove();
      onPick(list[Number(b.dataset.pick)]);
    });
    document.getElementById('app').appendChild(m);
  }

  /** 转班：一个班一个班地选接手的老师，也可以一键全转给同一个人 */
  function transferDialog(fromName, classes, targets) {
    const opts = (sel) => `<option value="">不转</option>` +
      targets.map((u) => `<option value="${u.id}"${String(sel) === String(u.id) ? ' selected' : ''}>${esc(u.name)}${u.role === 'admin' ? '（负责人）' : ''}</option>`).join('');
    const m = document.createElement('div');
    m.className = 'poster-mask'; m.id = 'trbox';
    m.innerHTML = `<div class="poster-sheet" role="dialog" aria-label="转出班级">
        <div class="section-title">${esc(fromName)} 的班转给谁</div>
        <div class="muted small">可以分别转给不同的老师；选「不转」的班留在原处。学生、作业、课时记录都跟着班一起走。</div>
        <label class="field" style="margin:10px 0 4px"><span>快速：全部转给</span>
          <select id="tr-all"><option value="">请选择</option>${targets.map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join('')}</select></label>
        <div class="trlist">${classes.map((c) => `<div class="trrow">
          <div class="grow"><b>${subjTag(c.subject)}${esc(c.name)}</b>
            <span class="muted small">${c.studentCount} 人${c.gradeBand ? ' · ' + esc(c.gradeBand) : ''}</span></div>
          <select class="tr-to" data-cls="${c.id}">${opts('')}</select>
        </div>`).join('')}</div>
        <div class="row" style="gap:10px">
          <button class="btn ghost grow" data-act="closeTransfer">取消</button>
          <button class="btn grow" data-act="doTransfer">转出</button>
        </div>
      </div>`;
    m.addEventListener('click', (e) => { if (e.target === m) m.remove(); });
    m.addEventListener('change', (e) => {
      if (e.target.id !== 'tr-all' || !e.target.value) return;
      m.querySelectorAll('.tr-to').forEach((s) => { s.value = e.target.value; });
    });
    document.getElementById('app').appendChild(m);
  }

  /** 选一位老师（转班时用） */
  function pickStaff(title, list, onPick) {
    const m = document.createElement('div');
    m.className = 'poster-mask'; m.id = 'pickbox';
    m.innerHTML = `<div class="poster-sheet" role="dialog" aria-label="${esc(title)}">
        <div class="section-title">${esc(title)}</div>
        <div class="muted small">班里的学生、作业和批改记录都会跟着一起转过去。</div>
        <div class="picklist">${list.map((u) => `<button class="btn ghost block" data-pick="${u.id}">${esc(u.name)}${u.role === 'admin' ? '（负责人）' : ''} · ${u.classCount} 个班</button>`).join('')}</div>
        <button class="btn grey block" data-act="closePick">取消</button>
      </div>`;
    m.addEventListener('click', (e) => {
      if (e.target === m) return m.remove();
      const b = e.target.closest('[data-pick]');
      if (!b) return;
      m.remove();
      onPick(list.find((u) => String(u.id) === b.dataset.pick));
    });
    document.getElementById('app').appendChild(m);
  }

  /** 新口令只显示这一次，让负责人抄下来发给老师 */
  function showCode(name, code, existing) {
    const m = document.createElement('div');
    m.className = 'poster-mask'; m.id = 'codebox';
    m.innerHTML = `<div class="poster-sheet" role="dialog" aria-label="老师口令">
        <div class="center"><div class="section-title">${esc(name)} 的口令</div>
          <div class="bigcode">${esc(code)}</div>
          <div class="muted small">把这 6 位数字发给${esc(name)}，登录时输姓名和它。
            <br>${existing ? '这是当前在用的口令，随时可以回来查。' : '忘了可以随时回来查看或重置。'}</div></div>
        <div class="row" style="gap:10px">
          <button class="btn ghost grow" data-act="copyCode" data-code="${esc(code)}">复制</button>
          <button class="btn grow" data-act="closeCode">知道了</button>
        </div>
      </div>`;
    m.addEventListener('click', (e) => { if (e.target === m) m.remove(); });
    document.getElementById('app').appendChild(m);
  }

  const VIEWS = { login: LOGIN, home: HOME, classes: CLASSES, classform: CLASSFORM, staff: STAFF, rewards: REWARDS,
    students: STUDENTS, student: STUDENT, roll: ROLL, leaves: LEAVES, about: ABOUT, hwlist: HWLIST, hwnew: HWNEW, review: REVIEW, leads: LEADS, me: ME };

  /** 把页面上的评分栏读成一个对象；没打分就返回 null（后端会原样清空） */
  function readRubric(ri) {
    if (!document.getElementById(`rb-${ri}-min`)) return undefined;   // 不是作业班，不提交这个字段
    const out = {};
    for (const [k] of RUBRIC) {
      const el = document.getElementById(`rb-${ri}-${k}`);
      const v = Number(el && el.dataset.val) || 0;
      if (v) out[k] = v;
    }
    const min = Number(document.getElementById(`rb-${ri}-min`).value);
    if (min > 0) out.minutes = min;
    const other = document.getElementById(`rb-${ri}-other`).value.trim();
    if (other) out.other = other;
    return Object.keys(out).length ? out : null;
  }

  const ACT = {
    async login() {
      const name = document.getElementById('i-name').value.trim();
      if (!name) return toast('请填写姓名');
      try { const d = await API.post('/api/auth/login', { role: 'teacher', name, teacherCode: document.getElementById('i-tcode').value }); Store.token = d.token; Store.user = d.user; go('home'); }
      catch (e) { toast(e.message); }
    },
    logout() { Store.clear(); go('login'); },
    async newStaff() {
      const name = (prompt('老师姓名（学生和家长会看到，建议写「李老师」这样）') || '').trim();
      if (!name) return;
      try { const r = await API.post('/api/admin/teachers', { name }); render(); showCode(r.name, r.code); }
      catch (e) { toast(e.message, 2600); }
    },
    async showCode(el) {
      try { const r = await API.get(`/api/admin/teachers/${el.dataset.id}/code`); showCode(r.name, r.code, true); }
      catch (e) { toast(e.message, 3200); }
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
    async saveSubjects(el) {
      const ids = [...document.querySelectorAll(`[data-subj-of="${el.dataset.id}"]:checked`)].map((x) => Number(x.value));
      try {
        await API.put(`/api/admin/teachers/${el.dataset.id}/subjects`, { subjectIds: ids });
        toast(ids.length ? `${el.dataset.name}：已设为 ${ids.length} 个科目` : `${el.dataset.name}：不限科目`, 2600);
        render();
      } catch (e) { toast(e.message, 2600); }
    },
    async toggleRole(el) {
      const toAdmin = el.dataset.role !== 'admin';
      const msg = toAdmin
        ? `把 ${el.dataset.name} 设为负责人？他将能看到全校的班、家长预约和教材内容。`
        : `把 ${el.dataset.name} 改成普通老师？他之后只能看到自己带的班。`;
      if (!confirm(msg)) return;
      try { await API.put('/api/admin/teachers/' + el.dataset.id, { role: toAdmin ? 'admin' : 'teacher' }); toast('已修改'); render(); }
      catch (e) { toast(e.message, 3000); }
    },
    async transferClasses(el) {
      const id = el.dataset.id;
      const [staff, classes] = await Promise.all([API.get('/api/admin/teachers'), API.get(`/api/admin/teachers/${id}/classes`)]);
      const targets = staff.filter((u) => u.active && String(u.id) !== id);
      if (!targets.length) return toast('还没有别的在职账号可以接手');
      if (!classes.length) return toast('这位老师名下没有班');
      transferDialog(el.dataset.name, classes, targets);
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
    closePick() { const m = document.getElementById('pickbox'); if (m) m.remove(); },
    closeTransfer() { const m = document.getElementById('trbox'); if (m) m.remove(); },
    async doTransfer(el) {
      const moves = [...document.querySelectorAll('.tr-to')].filter((s) => s.value)
        .map((s) => ({ classId: Number(s.dataset.cls), toId: Number(s.value) }));
      if (!moves.length) return toast('还没选要转给谁');
      el.disabled = true;
      try {
        const r = await API.post('/api/admin/classes/transfer', { moves });
        ACT.closeTransfer();
        toast(`${r.moved} 个班已转出：${r.detail.join('；')}`, 3600);
        render();
      } catch (e) { toast(e.message, 3200); el.disabled = false; }
    },
    pickBand(el) {
      const input = document.getElementById('c-band');
      if (!input) return;
      input.value = input.value.trim() === el.dataset.v ? '' : el.dataset.v;   // 再点一次就清空
      input.focus();
    },
    pickCourse(el) {
      const id = Number(el.dataset.id);
      S.formCourse = S.formCourse === id ? null : id;
      refreshCourses();
    },
    async newCourse(el) {
      const subjectId = Number(el.dataset.subj) || S.formSubj;
      if (!subjectId) return toast('先选科目');
      const name = (prompt('课程名称，比如「新概念英语」「奥数思维」') || '').trim();
      if (!name) return;
      try {
        const c = await API.post('/api/courses', { subjectId, name });
        S.formCourse = c.id;
        await refreshCourses();               // 只刷课程条，表单里填好的内容不动
        toast('已添加');
      } catch (e) { toast(e.message, 3000); }
    },
    async renameCourse(el) {
      const meta = await API.get('/api/meta', 300000);
      const sub = meta.subjects.find((x) => x.id === Number(S.formSubj));
      const cur = ((sub && sub.courses) || []).find((c) => c.id === Number(el.dataset.id));
      const name = (prompt('改成什么名字？', cur ? cur.name : '') || '').trim();
      if (!name || (cur && name === cur.name)) return;
      try { await API.put('/api/courses/' + el.dataset.id, { name }); await refreshCourses(); toast('已改名'); }
      catch (e) { toast(e.message, 3000); }
    },
    async saveClass(el) {
      const sub = document.querySelector('input[name="c-subj"]:checked');
      if (!sub) return toast('请选科目');
      const band = document.getElementById('c-band');
      const tSel = document.getElementById('c-teacher');
      const days = [...document.querySelectorAll('[data-week]:checked')].map((x) => Number(x.dataset.week));
      const body = { subjectId: Number(sub.value), gradeBand: band.value.trim(), name: document.getElementById('c-name').value.trim(),
        courseId: S.formCourse || null,
        schedule: days.length ? { days, start: document.getElementById('c-start').value, end: document.getElementById('c-end').value } : null };
      if (tSel) body.teacherId = Number(tSel.value);
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
      const kept = S.qs.filter((q) => !isEmptyQ(q));
      if (kept.length !== S.qs.length) { S.qs = kept; drawQs(); }   // 空白题不发出去
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
    genMath() { genMathDialog(); },
    closeMath() { const m = document.getElementById('mathbox'); if (m) m.remove(); },
    doGenMath() {
      const kind = document.getElementById('mg-kind').value;
      const n = Math.max(1, Math.min(30, Number(document.getElementById('mg-n').value) || 10));
      const score = Math.max(1, Math.min(20, Number(document.getElementById('mg-score').value) || 5));
      S.qs = S.qs.filter((q) => !isEmptyQ(q));          // 进页面时那道空白题让位给生成的题
      const seen = new Set(S.qs.map((q) => q.stem));
      for (let i = 0, guard = 0; i < n && guard < n * 20; guard++) {
        const q = makeMathQuestion(kind, score);
        if (seen.has(q.stem)) continue;                 // 同一份作业里不出重复的题
        seen.add(q.stem); S.qs.push(q); i++;
      }
      ACT.closeMath(); drawQs(); toast(`已生成 ${n} 道题`);
    },
    symbols() { symbolPanel(); },
    closeSym() { const m = document.getElementById('symbox'); if (m) m.remove(); },
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
          scores, reviewText: document.getElementById('rv-' + ri).value.trim(),
          excellent: document.getElementById('ex-' + ri).checked, rubric: readRubric(ri),
        });
        toast(`批改完成：${fmtNum(res.score)} / ${fmtNum(res.maxScore)} 分`); render();
      } catch (e) { toast(e.message); el.disabled = false; }
    },
    /* ---------- 教务档案 ---------- */
    async newStudent() {
      const name = (prompt('学员姓名') || '').trim();
      if (!name) return;
      try {
        const st = await API.post('/api/admin/students', { name });
        toast('已建档'); go('student', { stuId: st.id });
      } catch (e) { toast(e.message, 2600); }
    },
    async editStudent() {
      const p = (S.stu && S.stu.profile) || {};
      const ask = (label, cur) => { const v = prompt(label, cur || ''); return v == null ? cur || '' : v.trim(); };
      const body = {
        gender: ask('性别（男 / 女，可留空）', p.gender),
        grade: ask('年级', p.grade),
        school: ask('就读学校', p.school),
        parentName: ask('家长姓名', p.parentName),
        phone: ask('家长手机号', p.phone),
        note: ask('其他备注', p.note),
        status: p.status || 'active',
      };
      try { await API.put('/api/admin/students/' + S.stuId, body); toast('已保存'); render(); }
      catch (e) { toast(e.message, 2600); }
    },
    async newPackage() {
      const subj = await API.get('/api/meta', 300000);
      pickList('这个课包属于哪个科目？', [{ id: 0, name: '不限科目' }, ...subj.subjects], async (x) => {
        const total = Number(prompt('购买课时（不含赠送）', '40'));
        if (!(total > 0)) return toast('课时数不对');
        const gift = Number(prompt('赠送课时（没有就填 0）', '0')) || 0;
        const priceOriginal = Number(prompt('原价（元）', '0')) || 0;
        const pricePaid = Number(prompt('实收（元）', String(priceOriginal))) || 0;
        const purchasedAt = (prompt('购买日期', todayStr()) || todayStr()).trim();
        const expiresAt = (prompt('到期日期（可留空）', addMonths(purchasedAt, 12)) || '').trim();
        const note = (prompt('备注（可留空）', '') || '').trim();
        try {
          await API.post('/api/admin/packages', { studentId: S.stuId, subjectId: x.id || null,
            totalHours: total, giftHours: gift, priceOriginal, pricePaid, purchasedAt, expiresAt, note });
          toast('课包已录入'); render();
        } catch (e) { toast(e.message, 2600); }
      });
    },
    async adjustHours(el) {
      const h = Number(prompt('要加减多少课时？补课填正数，扣减填负数', '1'));
      if (!h) return;
      const note = (prompt('说明一下原因（家长能在流水里看到）', h > 0 ? '补课' : '扣减') || '').trim();
      try { await API.post(`/api/admin/packages/${el.dataset.id}/adjust`, { hours: h, note }); toast('已调整'); render(); }
      catch (e) { toast(e.message, 2600); }
    },
    async pausePkg(el) {
      if (!confirm('暂停这个课包？停课期间不扣课时，恢复时到期日会按停的天数自动顺延。')) return;
      try { await API.post(`/api/admin/packages/${el.dataset.id}/pause`); toast('已停课'); render(); }
      catch (e) { toast(e.message); }
    },
    async resumePkg(el) {
      try { const r = await API.post(`/api/admin/packages/${el.dataset.id}/resume`); toast(`已恢复，到期日顺延到 ${r.expiresAt || '不限'}`, 2800); render(); }
      catch (e) { toast(e.message); }
    },
    async editPkg(el) {
      const exp = (prompt('到期日期（YYYY-MM-DD，留空表示不限）', el.dataset.exp) || '').trim();
      try { await API.put('/api/admin/packages/' + el.dataset.id, { expiresAt: exp }); toast('已保存'); render(); }
      catch (e) { toast(e.message, 2600); }
    },
    async finishPkg(el) {
      if (!confirm('把这个课包标记为已结束？剩余课时不再计入。')) return;
      try { await API.put('/api/admin/packages/' + el.dataset.id, { status: 'finished' }); toast('已结束'); render(); }
      catch (e) { toast(e.message); }
    },
    rollPick(el) {
      const id = el.dataset.id;
      S.roll.students.find((x) => String(x.id) === id).status = el.dataset.st;
      paintRoll(id, el.dataset.st);
    },
    rollAll() {
      // 只改按钮样式，不能重画整页：重画会重新取数据，把还没保存的点名结果冲掉
      S.roll.students.forEach((st) => {
        if (st.approvedLeave) return;            // 已准假的保持请假
        st.status = 'present';
        paintRoll(st.id, 'present');
      });
    },
    async saveRoll(el) {
      const records = S.roll.students.filter((x) => x.status).map((x) => ({ studentId: x.id, status: x.status }));
      if (!records.length) return toast('还没点名');
      el.disabled = true;
      try {
        const r = await API.post(`/api/classes/${S.clsId}/attendance`, {
          date: document.getElementById('roll-date').value,
          hours: Number(document.getElementById('roll-hours').value) || 1, records,
        });
        toast(`已点名 ${r.marked} 人，共扣 ${r.usedHours} 课时`
          + (r.noPackage.length ? `；${r.noPackage.join('、')} 没有可用课包（没录、已用完、过期或停课中）` : '')
          + (r.overdrawn && r.overdrawn.length ? `；${r.overdrawn.join('、')} 课时已用超，记得提醒续费` : ''), 4000);
        render();
      } catch (e) { toast(e.message, 2600); el.disabled = false; }
    },
    async leaveOk(el) {
      try { await API.post(`/api/admin/leaves/${el.dataset.id}/approve`); toast('已准假'); render(); }
      catch (e) { toast(e.message); }
    },
    async leaveNo(el) {
      try { await API.post(`/api/admin/leaves/${el.dataset.id}/reject`); toast('已标记为不准'); render(); }
      catch (e) { toast(e.message); }
    },
    async savePublicCourses(el) {
      el.disabled = true;
      try {
        const boxes = [...document.querySelectorAll('[data-pub]')];
        const changed = boxes.filter((b) => {
          const c = S.allCourses.find((x) => String(x.id) === b.dataset.pub);
          return c && !!c.public !== b.checked;
        });
        for (const b of changed) await API.put('/api/courses/' + b.dataset.pub, { public: b.checked });
        toast(changed.length ? `已更新 ${changed.length} 门课程` : '没有改动');
        render();
      } catch (e) { toast(e.message, 2600); el.disabled = false; }
    },
    async saveContact(el) {
      const f = document.getElementById('ct-qr').files[0];
      el.disabled = true;
      try {
        const body = {
          phone: document.getElementById('ct-phone').value.trim(),
          address: document.getElementById('ct-address').value.trim(),
          hours: document.getElementById('ct-hours').value.trim(),
        };
        if (f) body.qrBase64 = (await compressImage(f, 900, 0.9)).base64;
        await API.put('/api/admin/contact', body);
        toast('联系方式已保存'); render();
      } catch (e) { toast(e.message, 2600); el.disabled = false; }
    },
    async saveAbout(el) {
      const f = document.getElementById('ab-file').files[0];
      el.disabled = true;
      try {
        const body = { title: document.getElementById('ab-title').value.trim(), text: document.getElementById('ab-text').value };
        if (f) body.images = [(await compressImage(f, 1400, 0.85)).base64];
        await API.put('/api/admin/about', body);
        toast('已保存'); render();
      } catch (e) { toast(e.message, 2600); el.disabled = false; }
    },

    async addReward(el) {
      const name = document.getElementById('rw-name').value.trim();
      const stars = Number(document.getElementById('rw-stars').value);
      if (!name) return toast('请填写奖品名称');
      if (!(stars > 0)) return toast('请填写需要多少颗星');
      const f = document.getElementById('rw-img').files[0];
      el.disabled = true;
      try {
        const body = { name, stars, note: document.getElementById('rw-note').value.trim() };
        if (f) body.imageBase64 = (await compressImage(f, 900, 0.8)).base64;
        await API.post('/api/admin/rewards', body);
        toast('已添加'); render();
      } catch (e) { toast(e.message, 2600); el.disabled = false; }
    },
    async editReward(el) {
      const name = (prompt('奖品名称', el.dataset.name) || '').trim();
      if (!name) return;
      const stars = Number(prompt('需要多少颗星？', el.dataset.stars));
      if (!(stars > 0)) return toast('星数不对');
      try { await API.put('/api/admin/rewards/' + el.dataset.id, { name, stars }); toast('已保存'); render(); }
      catch (e) { toast(e.message); }
    },
    async toggleReward(el) {
      const on = el.dataset.on === '1';
      try { await API.put('/api/admin/rewards/' + el.dataset.id, { active: !on }); toast(on ? '已下架' : '已上架'); render(); }
      catch (e) { toast(e.message); }
    },
    async delReward(el) {
      if (!confirm(`删除奖品「${el.dataset.name}」？`)) return;
      try { await API.del('/api/admin/rewards/' + el.dataset.id); toast('已删除'); render(); }
      catch (e) { toast(e.message, 2600); }
    },
    async redDone(el) {
      try { await API.post(`/api/admin/redemptions/${el.dataset.id}/done`); toast('已发放'); render(); }
      catch (e) { toast(e.message); }
    },
    async redCancel(el) {
      if (!confirm(`取消这次兑换？星星会退回给 ${el.dataset.name}`)) return;
      try { const r = await API.post(`/api/admin/redemptions/${el.dataset.id}/cancel`); toast(`已取消，退回 ${r.refunded} 颗星`); render(); }
      catch (e) { toast(e.message); }
    },
    async leadTo(el) {
      const st = el.dataset.st;
      const body = { status: st };
      if (st === 'contacted') body.followAt = addDays(2);
      if (st === 'trial') body.trialAt = addDays(2);
      if (st === 'invalid' && !confirm('标记为无效？之后还能重新跟进。')) return;
      try {
        await API.put('/api/admin/leads/' + el.dataset.id, body);
        toast({ contacted: '已标记联系，两天后提醒跟进', trial: '已约试听，可以点「改日期」调整',
          enrolled: '恭喜，已报名', invalid: '已标记无效' }[st] || '已更新', 2600);
        render();
      } catch (e) { toast(e.message); }
    },
    async leadDate(el) {
      const cur = el.dataset.cur || addDays(2);
      const v = (prompt(el.dataset.st === 'trial' ? '试听日期（2026-09-25）' : '下次跟进日期（2026-09-25）', cur) || '').trim();
      if (!v) return;
      const body = el.dataset.st === 'trial' ? { trialAt: v } : { followAt: v };
      try { await API.put('/api/admin/leads/' + el.dataset.id, body); toast('已更新'); render(); }
      catch (e) { toast(e.message); }
    },
    async leadNote(el) {
      const v = prompt('跟进记录（家长看不到）', el.dataset.cur || '');
      if (v == null) return;
      try { await API.put('/api/admin/leads/' + el.dataset.id, { note: v.trim() }); toast('已保存'); render(); }
      catch (e) { toast(e.message); }
    },
    async leadDel(el) {
      if (!confirm('删除这条预约？删除后找不回来')) return;
      try { await API.del('/api/admin/leads/' + el.dataset.id); toast('已删除'); render(); }
      catch (e) { toast(e.message); }
    },
    playRec(el) { const u = el.dataset.url; if (!u) return toast('没有录音'); Clip.play(u, el); },
    setRubStar(el, ev) {
      const box = el.getBoundingClientRect();
      const n = Math.max(1, Math.min(5, Math.ceil((ev.clientX - box.left) / (box.width / 5))));
      el.dataset.val = n;
      el.innerHTML = starStr(n);
    },
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
          { stars, reviewText: document.getElementById('rv-' + ri).value.trim(),
            excellent: document.getElementById('ex-' + ri).checked, rubric: readRubric(ri) });
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
    try { await API.get('/api/me'); go('home'); } catch { go('login'); }
  })();
})();
