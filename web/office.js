/* 电脑版教务后台：学员总表、收费报表、考勤、咨询，都能导出 CSV。
 * 和手机端共用同一套接口和同一个登录（在浏览器里登录一次即可）。 */
(function () {
  'use strict';
  const { Store, API, toast, esc, fmtDate } = App;
  const $nav = document.getElementById('nav');
  const $main = document.getElementById('main');
  const $who = document.getElementById('who');

  const S = { view: 'students', stu: null, filters: { q: '', status: 'active', classId: '', low: false },
    month: null, gridClass: null };

  const todayStr = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const thisMonth = () => todayStr().slice(0, 7);
  const ST_NAME = { active: '在读', paused: '停课', left: '已结业' };
  const ATT_NAME = { present: '到课', leave: '请假', absent: '旷课' };
  const REASON = { present: '上课', absent: '旷课', leave: '请假', adjust: '手工调整', revert: '退回' };
  const isAdmin = () => ((Store.user || {}).role === 'admin');
  const money = (n) => '¥' + Number(n || 0).toLocaleString('zh-CN');

  const VIEWS = [
    ['students', '学员档案'],
    ['report', '收费与课时'],
    ['grid', '考勤表'],
    ['leads', '家长咨询'],
  ];

  function go(view, data) { S.view = view; Object.assign(S, data || {}); render(); }

  function render() {
    if (!Store.token) return renderLogin();
    const admin = isAdmin();
    $nav.innerHTML = VIEWS.filter(([k]) => admin || k === 'students' || k === 'grid')
      .map(([k, t]) => `<button class="${S.view === k ? 'on' : ''}" data-go="${k}">${t}</button>`).join('');
    $who.innerHTML = `<span>${esc((Store.user || {}).name || '')}<i>${admin ? '负责人' : '老师'}</i></span>
      <a class="btn sm ghost" href="teacher.html">手机端</a>
      <button class="btn sm grey" data-act="logout">退出</button>`;
    $main.innerHTML = '<div class="empty">加载中…</div>';
    const fn = { students: viewStudents, report: viewReport, grid: viewGrid, leads: viewLeads }[S.view] || viewStudents;
    Promise.resolve(fn()).then((html) => { $main.innerHTML = html; if (fn.after) fn.after(); })
      .catch((e) => { $main.innerHTML = `<div class="empty">${esc(e.message)}</div>`; });
  }

  function renderLogin() {
    $nav.innerHTML = ''; $who.innerHTML = '';
    $main.innerHTML = `<div class="of-login">
      <div class="card" style="max-width:360px;margin:60px auto">
        <div class="section-title mb">教务后台登录</div>
        <label class="field"><span>姓名</span><input id="i-name" placeholder="例如：史老师"></label>
        <label class="field"><span>口令</span><input id="i-code" type="password" placeholder="负责人主口令 / 老师本人口令"></label>
        <button class="btn block" data-act="login">进入</button>
        <div class="muted small mt center">和手机端是同一个账号</div>
      </div></div>`;
  }

  /* ---------------- 学员档案 ---------------- */
  async function viewStudents() {
    const [list, classes] = await Promise.all([API.get('/api/admin/students'), API.get('/api/classes')]);
    S.all = list;
    const f = S.filters;
    let rows = list;
    if (f.q) rows = rows.filter((x) => x.name.includes(f.q) || (x.school || '').includes(f.q) || (x.phone || '').includes(f.q));
    if (f.status) rows = rows.filter((x) => (x.status || 'active') === f.status);
    if (f.classId) rows = rows.filter((x) => x.classes.includes(f.classId));
    if (f.low) rows = rows.filter((x) => x.leftHours <= 4);
    S.rows = rows;

    return `<div class="of-bar">
      <input id="f-q" class="of-search" value="${esc(f.q)}" placeholder="搜姓名、学校、手机号">
      <select id="f-status">
        <option value="">全部状态</option>
        ${Object.entries(ST_NAME).map(([k, v]) => `<option value="${k}"${f.status === k ? ' selected' : ''}>${v}</option>`).join('')}
      </select>
      <select id="f-class"><option value="">全部班级</option>
        ${classes.map((c) => `<option value="${esc(c.name)}"${f.classId === c.name ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}
      </select>
      <label class="of-check"><input type="checkbox" id="f-low"${f.low ? ' checked' : ''}> 只看课时不足（≤4）</label>
      <div class="grow"></div>
      <span class="muted small">共 ${rows.length} 人</span>
      ${isAdmin() ? '<button class="btn sm" data-act="bulkNew">批量建档</button>' : ''}
      <button class="btn sm ghost" data-act="dl" data-kind="students">导出学员名单</button>
      <button class="btn sm ghost" data-act="dl" data-kind="hours">导出课时台账</button>
    </div>
    <div class="of-split">
      <div class="of-table">
        <table><thead><tr>
          <th>姓名</th><th>性别</th><th>年级</th><th>就读学校</th><th>班级</th>
          ${isAdmin() ? '<th>家长</th><th>手机号</th>' : ''}
          <th class="num">剩余课时</th><th>到期日</th><th>状态</th>
        </tr></thead><tbody>
        ${rows.map((x) => `<tr data-act="openStu" data-id="${x.id}" class="${S.stu && S.stu.id === x.id ? 'on' : ''}">
          <td class="strong">${esc(x.name)}</td><td>${esc(x.gender || '')}</td><td>${esc(x.grade || '')}</td>
          <td>${esc(x.school || '')}</td><td class="small">${x.classes.map(esc).join('、')}</td>
          ${isAdmin() ? `<td>${esc(x.parentName || '')}</td><td>${esc(x.phone || '')}</td>` : ''}
          <td class="num ${x.leftHours <= 4 ? 'warn' : ''}">${x.leftHours}</td>
          <td class="small">${esc(x.expiresAt || '')}</td>
          <td><span class="pill ${x.status === 'active' ? 'ok' : ''}">${ST_NAME[x.status] || '在读'}</span></td>
        </tr>`).join('') || '<tr><td colspan="10" class="empty">没有符合条件的学员</td></tr>'}
        </tbody></table>
      </div>
      <aside class="of-side" id="side">${S.stu ? await sidePanel(S.stu.id) : '<div class="of-hint">点左边任意一行，在这里改资料、加课包、看流水</div>'}</aside>
    </div>`;
  }
  viewStudents.after = () => {
    const bind = (id, ev, fn) => { const el = document.getElementById(id); if (el) el.addEventListener(ev, fn); };
    bind('f-q', 'change', (e) => { S.filters.q = e.target.value.trim(); render(); });
    bind('f-status', 'change', (e) => { S.filters.status = e.target.value; render(); });
    bind('f-class', 'change', (e) => { S.filters.classId = e.target.value; render(); });
    bind('f-low', 'change', (e) => { S.filters.low = e.target.checked; render(); });
  };

  /** 右侧详情面板：资料、课包、流水、考勤 */
  async function sidePanel(id) {
    const d = await API.get('/api/admin/students/' + id);
    S.stu = d;
    const admin = isAdmin();
    const p = d.profile || {};
    return `<div class="of-panel">
      <div class="row between"><div class="section-title">${esc(d.name)}</div>
        <div class="bigscore">${d.hours.leftHours}<small> 课时</small></div></div>
      <div class="muted small">${d.classes.map((c) => esc(c.name)).join('、') || '还没进班'}${d.hours.expiresAt ? ' · ' + esc(d.hours.expiresAt) + ' 到期' : ''}</div>

      ${admin ? `<div class="of-form mt">
        <div class="of-grid2">
          <label class="field"><span>姓名</span><input id="p-name" value="${esc(d.name)}"></label>
          <label class="field"><span>性别</span><select id="p-gender">
            ${['', '男', '女'].map((g) => `<option${p.gender === g ? ' selected' : ''}>${g}</option>`).join('')}</select></label>
          <label class="field"><span>年级</span><input id="p-grade" value="${esc(p.grade || '')}"></label>
          <label class="field"><span>就读学校</span><input id="p-school" value="${esc(p.school || '')}"></label>
          <label class="field"><span>家长姓名</span><input id="p-parent" value="${esc(p.parentName || '')}"></label>
          <label class="field"><span>家长手机</span><input id="p-phone" value="${esc(p.phone || '')}"></label>
          <label class="field"><span>状态</span><select id="p-status">
            ${Object.entries(ST_NAME).map(([k, v]) => `<option value="${k}"${(p.status || 'active') === k ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
          <label class="field"><span>备注</span><input id="p-note" value="${esc(p.note || '')}"></label>
        </div>
        <button class="btn sm" data-act="saveProfile" data-id="${d.id}">保存资料</button>
      </div>` : ''}

      <div class="row between mt mb"><div class="section-title">课时包</div>
        ${admin ? `<button class="btn sm" data-act="pkgForm" data-id="${d.id}">+ 录入课包</button>` : ''}</div>
      <div id="pkg-form"></div>
      ${d.packages.length ? d.packages.map((k) => `<div class="of-pkg ${k.status}">
        <div class="row between"><b>${k.subject ? esc(k.subject.name) : '不限科目'} · ${k.sumHours} 课时</b>
          <span class="pill ${k.status === 'active' ? 'ok' : k.status === 'paused' ? 'warn' : ''}">${{ active: '在用', paused: '停课中', finished: '已结束' }[k.status]}</span></div>
        <div class="muted small">购 ${k.totalHours} + 送 ${k.giftHours} · 已用 ${k.usedHours} · 剩 <b>${k.leftHours}</b></div>
        <div class="muted small">${esc(k.purchasedAt || '')} → ${esc(k.expiresAt || '不限')}${admin && k.pricePaid != null ? ` · 原价 ${money(k.priceOriginal)} 实收 <b>${money(k.pricePaid)}</b>` : ''}</div>
        ${k.note ? `<div class="muted small">${esc(k.note)}</div>` : ''}
        ${admin ? `<div class="row mt" style="gap:6px;flex-wrap:wrap">
          <button class="btn sm ghost" data-act="adjust" data-id="${k.id}">加/减课时</button>
          ${k.status === 'active' ? `<button class="btn sm grey" data-act="pausePkg" data-id="${k.id}">停课</button>` : ''}
          ${k.status === 'paused' ? `<button class="btn sm mint" data-act="resumePkg" data-id="${k.id}">恢复</button>` : ''}
          <button class="btn sm grey" data-act="editExp" data-id="${k.id}" data-exp="${esc(k.expiresAt || '')}">改到期日</button>
          ${k.status !== 'finished' ? `<button class="btn sm grey" data-act="finishPkg" data-id="${k.id}">结束</button>` : ''}
        </div>` : ''}
      </div>`).join('') : '<div class="muted small">还没有课包</div>'}

      <div class="section-title mt mb">课时流水</div>
      ${d.logs.length ? `<table class="of-mini"><tbody>${d.logs.slice(0, 12).map((l) => `<tr>
        <td class="small">${esc(l.date || '')}</td><td class="small">${esc(REASON[l.reason] || l.reason)}${l.note ? ' · ' + esc(l.note) : ''}</td>
        <td class="num ${l.hours < 0 ? 'minus' : 'plus'}">${l.hours > 0 ? '+' : ''}${l.hours}</td></tr>`).join('')}</tbody></table>`
        : '<div class="muted small">还没有记录</div>'}

      <div class="section-title mt mb">最近考勤</div>
      ${d.attendance.length ? `<table class="of-mini"><tbody>${d.attendance.slice(0, 10).map((a) => `<tr>
        <td class="small">${esc(a.date)}</td><td class="small">${esc(a.className || '')}</td>
        <td class="small">${ATT_NAME[a.status]}${a.hours ? ` −${a.hours}` : ''}</td></tr>`).join('')}</tbody></table>`
        : '<div class="muted small">还没有上课记录</div>'}
    </div>`;
  }

  /* ---------------- 收费与课时报表 ---------------- */
  async function viewReport() {
    const r = await API.get('/api/admin/report?months=6');
    const maxIncome = Math.max(1, ...r.months.map((m) => m.income));
    const maxHours = Math.max(1, ...r.months.map((m) => m.usedHours));
    const cur = r.months[r.months.length - 1] || {};
    return `<div class="of-bar">
      <div class="section-title grow">收费与课时</div>
      <button class="btn sm ghost" data-act="dl" data-kind="payments">导出收款流水</button>
      <button class="btn sm ghost" data-act="dl" data-kind="hours">导出课时台账</button>
      <button class="btn sm ghost" data-act="dl" data-kind="attendance">导出考勤记录</button>
    </div>
    <div class="of-kpis">
      <div class="kpi"><b>${money(cur.income)}</b><span>本月收款</span></div>
      <div class="kpi"><b>${cur.usedHours || 0}</b><span>本月消耗课时</span></div>
      <div class="kpi"><b>${r.activeStudents}</b><span>有课时的学员</span></div>
      <div class="kpi"><b>${r.owedHours}</b><span>课时结余（待上）</span></div>
      <div class="kpi"><b>${cur.attendRate == null ? '—' : cur.attendRate + '%'}</b><span>本月出勤率</span></div>
    </div>

    <div class="of-cards">
      <div class="card">
        <div class="section-title mb">近 6 个月收款</div>
        <div class="chart">${r.months.map((m) => `<div class="bar" title="${m.month} ${money(m.income)}">
          <i style="height:${Math.round((m.income / maxIncome) * 100)}%"></i>
          <b>${m.income ? (m.income >= 10000 ? (m.income / 10000).toFixed(1) + '万' : m.income) : ''}</b>
          <span>${m.month.slice(5)}</span></div>`).join('')}</div>
      </div>
      <div class="card">
        <div class="section-title mb">近 6 个月课时消耗</div>
        <div class="chart mint">${r.months.map((m) => `<div class="bar" title="${m.month} ${m.usedHours} 课时">
          <i style="height:${Math.round((m.usedHours / maxHours) * 100)}%"></i>
          <b>${m.usedHours || ''}</b><span>${m.month.slice(5)}</span></div>`).join('')}</div>
      </div>
    </div>

    <div class="card">
      <div class="section-title mb">按月明细</div>
      <table class="of-plain"><thead><tr><th>月份</th><th class="num">收款</th><th class="num">课包数</th>
        <th class="num">消耗课时</th><th class="num">上课人次</th><th class="num">出勤率</th></tr></thead>
        <tbody>${r.months.slice().reverse().map((m) => `<tr><td>${m.month}</td><td class="num">${money(m.income)}</td>
          <td class="num">${m.packages}</td><td class="num">${m.usedHours}</td><td class="num">${m.lessons}</td>
          <td class="num">${m.attendRate == null ? '—' : m.attendRate + '%'}</td></tr>`).join('')}</tbody></table>
      <div class="muted small mt">收款按课包的购买日期统计；课时结余是所有在用课包还没上的课时总数。</div>
    </div>`;
  }

  /* ---------------- 考勤表 ---------------- */
  async function viewGrid() {
    const classes = await API.get('/api/classes');
    if (!classes.length) return '<div class="empty">还没有班级</div>';
    if (!S.gridClass || !classes.some((c) => c.id === S.gridClass)) S.gridClass = classes[0].id;
    const month = S.month || thisMonth();
    const g = await API.get(`/api/admin/attendance-grid?classId=${S.gridClass}&month=${month}`);
    S.grid = g;
    // 表里多留一列"今天"，方便直接补录当天
    const dates = g.dates.slice();
    const t = todayStr();
    if (t.slice(0, 7) === month && !dates.includes(t)) dates.push(t);
    // 「补录某天」点开的那一天，即使还没有记录也要给它一列
    if (S.extraDate && S.extraDate.slice(0, 7) === month && !dates.includes(S.extraDate)) dates.push(S.extraDate);
    dates.sort();
    S.gridDates = dates;
    return `<div class="of-bar">
      <select id="g-class">${classes.map((c) => `<option value="${c.id}"${c.id === S.gridClass ? ' selected' : ''}>${esc(c.subject ? c.subject.name + ' · ' : '')}${esc(c.name)}</option>`).join('')}</select>
      <input type="month" id="g-month" value="${esc(month)}">
      <button class="btn sm" data-act="addDay">+ 补录某天</button>
      <span class="muted small">每次扣 ${g.defaultHours} 课时 · 点格子就能改</span>
      <div class="grow"></div>
      <button class="btn sm ghost" data-act="dl" data-kind="attendance">导出考勤记录</button>
    </div>
    ${dates.length ? `<div class="of-table">
      <table class="of-grid"><thead><tr><th class="sticky">学员</th>
        ${dates.map((d) => `<th class="${d === t ? 'today' : ''}">${d.slice(5)}</th>`).join('')}<th class="num">本月课时</th></tr></thead>
      <tbody>${g.students.map((st) => `<tr><td class="sticky strong">${esc(st.name)}</td>
        ${dates.map((d) => {
          const m = st.marks[g.dates.indexOf(d)] || null;
          return `<td class="mark edit ${m ? m.status : ''}" data-act="cell" data-sid="${st.id}" data-date="${d}" title="${esc(st.name)} ${d}">${m ? ATT_NAME[m.status][0] : '＋'}</td>`;
        }).join('')}
        <td class="num">${Math.round(st.used * 10) / 10}</td></tr>`).join('')}</tbody></table>
    </div>
    <div class="muted small mt">到 = 到课，请 = 请假，旷 = 旷课。点任意格子可以补录或修改：到课扣课时，请假不扣，改动会自动退回上次扣的课时。</div>`
      : '<div class="empty">这个月还没有点名记录，点「+ 补录某天」开始</div>'}`;
  }
  viewGrid.after = () => {
    const c = document.getElementById('g-class'), m = document.getElementById('g-month');
    if (c) c.addEventListener('change', () => go('grid', { gridClass: Number(c.value) }));
    if (m) m.addEventListener('change', () => go('grid', { month: m.value }));
  };

  /** 点格子：选到课/请假/旷课，或清掉这次记录 */
  function cellMenu(el) {
    document.querySelectorAll('.cellmenu').forEach((x) => x.remove());
    const box = el.getBoundingClientRect();
    const m = document.createElement('div');
    m.className = 'cellmenu';
    m.style.left = Math.min(box.left, window.innerWidth - 150) + 'px';
    m.style.top = (box.bottom + window.scrollY + 4) + 'px';
    m.innerHTML = `${[['present', '到课'], ['leave', '请假（不扣）'], ['absent', '旷课'], ['clear', '清除记录']]
      .map(([k, t]) => `<button data-set="${k}">${t}</button>`).join('')}`;
    m.addEventListener('click', async (ev) => {
      const b = ev.target.closest('[data-set]');
      if (!b) return;
      m.remove();
      el.textContent = '…';
      try {
        await API.post(`/api/classes/${S.grid.classId}/attendance`, {
          date: el.dataset.date, hours: S.grid.defaultHours,
          records: [{ studentId: Number(el.dataset.sid), status: b.dataset.set }],
        });
        toast('已保存');
        render();
      } catch (e) { toast(e.message, 2600); render(); }
    });
    document.body.appendChild(m);
    setTimeout(() => document.addEventListener('click', function off() { m.remove(); document.removeEventListener('click', off); }, { once: true }), 0);
  }

  /* ---------------- 家长咨询 ---------------- */
  const LEAD_ST = [['new', '新咨询'], ['contacted', '已联系'], ['enrolled', '已报名'], ['invalid', '无效']];
  async function viewLeads() {
    const list = await API.get('/api/admin/leads');
    return `<div class="of-bar"><div class="section-title grow">家长咨询（${list.length}）</div>
      <button class="btn sm ghost" data-act="dl" data-kind="leads">导出咨询名单</button></div>
    <div class="of-table"><table><thead><tr>
      <th>时间</th><th>手机号</th><th>年级</th><th>想了解</th><th>家长留言</th><th>来源</th><th>状态</th><th>跟进备注</th>
    </tr></thead><tbody>
    ${list.map((l) => `<tr>
      <td class="small">${fmtDate(l.createdAt)}</td>
      <td><a href="tel:${esc(l.phone)}">${esc(l.phone)}</a></td>
      <td>${esc(l.grade)}</td>
      <td class="small">${[...(l.subjectNames || []), ...(l.courseNames || [])].map(esc).join('、')}</td>
      <td class="small">${esc(l.message || '')}</td>
      <td class="small">${l.source === 'share' ? `分享${l.refName ? '（' + esc(l.refName) + '）' : ''}` : l.source === 'gallery' ? '作品展' : '预约页'}</td>
      <td><select class="lead-st" data-lead="${l.id}">${LEAD_ST.map(([k, t]) => `<option value="${k}"${l.status === k ? ' selected' : ''}>${t}</option>`).join('')}</select></td>
      <td><input class="lead-note" data-lead="${l.id}" value="${esc(l.note || '')}" placeholder="改完自动保存"></td>
    </tr>`).join('') || '<tr><td colspan="8" class="empty">还没有家长预约</td></tr>'}
    </tbody></table></div>`;
  }

  /* ---------------- 事件 ---------------- */
  document.addEventListener('click', async (e) => {
    const g = e.target.closest('[data-go]');
    if (g) return go(g.dataset.go);
    const a = e.target.closest('[data-act]');
    if (!a) return;
    const fn = ACT[a.dataset.act];
    if (fn) fn(a, e);
  });

  document.addEventListener('change', async (e) => {
    const el = e.target;
    if (el.classList.contains('lead-st')) {
      try { await API.put('/api/admin/leads/' + el.dataset.lead, { status: el.value }); toast('已更新'); }
      catch (err) { toast(err.message); }
    }
    if (el.classList.contains('lead-note')) {
      try { await API.put('/api/admin/leads/' + el.dataset.lead, { note: el.value.trim() }); toast('备注已保存'); }
      catch (err) { toast(err.message); }
    }
  });

  const ACT = {
    async login() {
      const name = document.getElementById('i-name').value.trim();
      if (!name) return toast('请填写姓名');
      try {
        const d = await API.post('/api/auth/login', { role: 'teacher', name, teacherCode: document.getElementById('i-code').value });
        Store.token = d.token; Store.user = d.user; go('students');
      } catch (err) { toast(err.message, 2600); }
    },
    logout() { Store.clear(); location.reload(); },
    cell(el, ev) { ev.stopPropagation(); cellMenu(el); },
    async addDay() {
      const d = (prompt('补录哪一天？（格式 2026-09-15）', todayStr()) || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return d && toast('日期格式不对');
      if (d.slice(0, 7) !== (S.month || thisMonth())) { S.month = d.slice(0, 7); }
      S.extraDate = d;
      render();
      setTimeout(() => toast('在这一列的格子上点一下，选到课或请假', 3000), 400);
    },
    async openStu(el) {
      const side = document.getElementById('side');
      side.innerHTML = '<div class="of-hint">加载中…</div>';
      document.querySelectorAll('.of-table tr.on').forEach((t) => t.classList.remove('on'));
      el.classList.add('on');
      side.innerHTML = await sidePanel(el.dataset.id);
    },
    async saveProfile(el) {
      const v = (id) => document.getElementById(id).value.trim();
      try {
        await API.put('/api/admin/students/' + el.dataset.id, {
          name: v('p-name'), gender: v('p-gender'), grade: v('p-grade'), school: v('p-school'),
          parentName: v('p-parent'), phone: v('p-phone'), status: v('p-status'), note: v('p-note'),
        });
        toast('已保存'); render();
      } catch (err) { toast(err.message, 2600); }
    },
    async pkgForm(el) {
      const subj = await API.get('/api/subjects');
      document.getElementById('pkg-form').innerHTML = `<div class="of-form mb">
        <div class="of-grid2">
          <label class="field"><span>科目</span><select id="k-subj"><option value="">不限科目</option>
            ${subj.subjects.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select></label>
          <label class="field"><span>购买课时</span><input id="k-total" type="number" min="0" step="0.5" value="40"></label>
          <label class="field"><span>赠送课时</span><input id="k-gift" type="number" min="0" step="0.5" value="0"></label>
          <label class="field"><span>原价（元）</span><input id="k-price" type="number" min="0" value="0"></label>
          <label class="field"><span>实收（元）</span><input id="k-paid" type="number" min="0" value="0"></label>
          <label class="field"><span>购买日期</span><input id="k-buy" type="date" value="${todayStr()}"></label>
          <label class="field"><span>到期日期</span><input id="k-exp" type="date" value="${addMonths(todayStr(), 12)}"></label>
          <label class="field"><span>备注</span><input id="k-note" placeholder="例如：暑期班"></label>
        </div>
        <div class="row" style="gap:8px"><button class="btn sm" data-act="savePkg" data-id="${el.dataset.id}">保存课包</button>
          <button class="btn sm grey" data-act="cancelPkg">取消</button></div>
      </div>`;
    },
    cancelPkg() { document.getElementById('pkg-form').innerHTML = ''; },
    async savePkg(el) {
      const v = (id) => document.getElementById(id).value;
      try {
        await API.post('/api/admin/packages', {
          studentId: Number(el.dataset.id), subjectId: Number(v('k-subj')) || null,
          totalHours: Number(v('k-total')), giftHours: Number(v('k-gift')),
          priceOriginal: Number(v('k-price')), pricePaid: Number(v('k-paid')),
          purchasedAt: v('k-buy'), expiresAt: v('k-exp'), note: v('k-note').trim(),
        });
        toast('课包已录入'); render();
      } catch (err) { toast(err.message, 2600); }
    },
    async adjust(el) {
      const h = Number(prompt('加减多少课时？补课填正数，扣减填负数', '1'));
      if (!h) return;
      const note = (prompt('原因（家长能在流水里看到）', h > 0 ? '补课' : '扣减') || '').trim();
      try { await API.post(`/api/admin/packages/${el.dataset.id}/adjust`, { hours: h, note }); toast('已调整'); render(); }
      catch (err) { toast(err.message, 2600); }
    },
    async pausePkg(el) {
      if (!confirm('暂停这个课包？恢复时到期日会按停的天数顺延。')) return;
      try { await API.post(`/api/admin/packages/${el.dataset.id}/pause`); toast('已停课'); render(); }
      catch (err) { toast(err.message); }
    },
    async resumePkg(el) {
      try { const r = await API.post(`/api/admin/packages/${el.dataset.id}/resume`); toast(`已恢复，到期日顺延到 ${r.expiresAt || '不限'}`, 2800); render(); }
      catch (err) { toast(err.message); }
    },
    async editExp(el) {
      const exp = (prompt('到期日期（YYYY-MM-DD，留空表示不限）', el.dataset.exp) || '').trim();
      try { await API.put('/api/admin/packages/' + el.dataset.id, { expiresAt: exp }); toast('已保存'); render(); }
      catch (err) { toast(err.message, 2600); }
    },
    async finishPkg(el) {
      if (!confirm('把这个课包标记为已结束？剩余课时不再计入。')) return;
      try { await API.put('/api/admin/packages/' + el.dataset.id, { status: 'finished' }); toast('已结束'); render(); }
      catch (err) { toast(err.message); }
    },
    async bulkNew() {
      const classes = await API.get('/api/classes');
      const m = document.createElement('div');
      m.className = 'of-modal'; m.id = 'bulk';
      m.innerHTML = `<div class="card" style="max-width:520px;width:100%">
        <div class="section-title mb">批量建档</div>
        <label class="field"><span>学员姓名（一行一个，也可以用逗号分隔）</span>
          <textarea id="b-names" rows="7" placeholder="王小虎&#10;李小花&#10;张小明"></textarea></label>
        <div class="of-grid2">
          <label class="field"><span>直接加入班级</span><select id="b-class"><option value="">先不进班</option>
            ${classes.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></label>
          <label class="field"><span>年级（可留空）</span><input id="b-grade" placeholder="三年级"></label>
          <label class="field"><span>每人送课时（可留空）</span><input id="b-hours" type="number" min="0" step="0.5" placeholder="0"></label>
          <label class="field"><span>到期日期</span><input id="b-exp" type="date" value="${addMonths(todayStr(), 12)}"></label>
        </div>
        <div class="row" style="gap:8px"><button class="btn grow" data-act="doBulk">建档</button>
          <button class="btn grey" data-act="closeBulk">取消</button></div>
      </div>`;
      m.addEventListener('click', (ev) => { if (ev.target === m) m.remove(); });
      document.body.appendChild(m);
    },
    closeBulk() { const m = document.getElementById('bulk'); if (m) m.remove(); },
    async doBulk(el) {
      const names = document.getElementById('b-names').value.trim();
      if (!names) return toast('请填写姓名');
      const hours = Number(document.getElementById('b-hours').value) || 0;
      el.disabled = true;
      try {
        const body = { names, classId: Number(document.getElementById('b-class').value) || null,
          grade: document.getElementById('b-grade').value.trim() };
        if (hours > 0) body.package = { totalHours: hours, giftHours: 0, priceOriginal: 0, pricePaid: 0,
          purchasedAt: todayStr(), expiresAt: document.getElementById('b-exp').value, note: '批量建档' };
        const r = await API.post('/api/admin/students/bulk', body);
        ACT.closeBulk();
        toast(`新建 ${r.created.length} 人${r.existed.length ? `，已存在 ${r.existed.length} 人（已更新）` : ''}`, 3000);
        render();
      } catch (err) { toast(err.message, 2600); el.disabled = false; }
    },
    /** 导出：带上登录态取回文件再存到本地 */
    async dl(el) {
      const kind = el.dataset.kind;
      el.disabled = true;
      try {
        const res = await fetch('/api/admin/export/' + kind, { headers: { Authorization: 'Bearer ' + Store.token } });
        if (!res.ok) throw new Error('导出失败（' + res.status + '）');
        const blob = await res.blob();
        const name = decodeURIComponent((res.headers.get('content-disposition') || '').match(/filename="([^"]+)"/)?.[1] || (kind + '.csv'));
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = name;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        toast('已下载 ' + name);
      } catch (err) { toast(err.message); }
      finally { el.disabled = false; }
    },
  };

  function addMonths(dateStr, n) {
    const d = new Date(dateStr);
    d.setMonth(d.getMonth() + n);
    return d.toISOString().slice(0, 10);
  }

  (async function boot() {
    if (!Store.token) return renderLogin();
    try { await API.get('/api/me'); render(); } catch { Store.clear(); renderLogin(); }
  })();
})();
