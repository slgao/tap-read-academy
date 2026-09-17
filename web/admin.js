/* 内容后台：教材 / 课 / 页面 / 音频 + 热区标注工具
 * 标注产出的就是小程序端直接消费的数据结构（归一化坐标 + 音频时间区间）
 */
(function () {
  'use strict';
  const { Store, API, toast, esc, fileToBase64 } = App;
  const $top = document.getElementById('topbar');
  const $side = document.getElementById('side');
  const $main = document.getElementById('main');
  const $wrap = document.getElementById('wrap');

  const S = { books: [], page: null, hs: [], sel: -1, dirty: false };
  const audio = new Audio();
  let segTimer = null;

  const fmtMs = (ms) => (ms == null ? '-' : (ms / 1000).toFixed(2) + 's');

  /* ---------------- 布局 ---------------- */
  function renderTop() {
    const u = Store.user;
    $top.innerHTML = `<h1><img src="brand/logo-96.png" alt="">福斯特培训学校 <span class="sub">内容后台</span></h1>
      ${u ? `<span class="pill blue">${esc(u.name)}</span>
             <button class="btn sm grey" data-act="logout">退出</button>` : ''}`;
  }

  async function renderSide() {
    const books = await API.get('/api/books');
    S.books = books;
    const parts = [`<button class="btn sm block mb" data-act="newBook">+ 新建教材</button>`];
    for (const b of books) {
      const cat = await API.get(`/api/books/${b.id}/catalog`);
      parts.push(`<div class="tree-book">${esc(b.title)}
        <button class="btn sm danger" style="float:right;padding:2px 8px;margin-left:4px" data-act="delBook" data-bid="${b.id}" data-name="${esc(b.title)}">×</button>
        <button class="btn sm grey" style="float:right;padding:2px 8px" data-act="newLesson" data-bid="${b.id}">+课</button></div>`);
      for (const l of cat.lessons) {
        parts.push(`<div class="tree-lesson">${esc(l.title)}
          <button class="btn sm danger" style="float:right;padding:1px 6px;font-size:11px;margin-left:4px" data-act="delLesson" data-lid="${l.id}" data-name="${esc(l.title)}">×</button>
          <button class="btn sm grey" style="float:right;padding:1px 6px;font-size:11px" data-act="upAudio" data-lid="${l.id}">音频</button>
          <button class="btn sm grey" style="float:right;padding:1px 6px;font-size:11px;margin-right:4px" data-act="upPage" data-lid="${l.id}">+页</button></div>`);
        for (const p of l.pages) {
          parts.push(`<div class="tree-page ${S.page && S.page.page.id === p.id ? 'on' : ''}" data-act="openPage" data-pid="${p.id}">
            第 ${p.pageNo} 页 <span class="muted small">· ${p.hotspotCount} 热区</span></div>`);
        }
      }
    }
    parts.push(`<div class="hr"></div><div class="muted small">导入自己的 PDF：<br><code>tools/import_pdf.sh</code></div>`);
    $side.innerHTML = parts.join('');
  }

  function renderMain() {
    if (!S.page) {
      $main.innerHTML = `<div class="empty">从左侧选一个页面开始标注<br>
        <span class="small">没有内容？先「新建教材 → +课 → +页」，再上传课文音频</span></div>`;
      return;
    }
    const d = S.page;
    const hasAudio = !!(d.lesson.audio && d.lesson.audio.url);
    $main.innerHTML = `
      <div class="row between mb">
        <div><span class="strong">${esc(d.book.title)}</span>
          <span class="muted"> / ${esc(d.lesson.title)} / 第 ${d.page.pageNo} 页</span></div>
        <div class="row" style="gap:8px">
          <button class="btn sm grey" data-act="autoRows">自动等分 6 行</button>
          <button class="btn sm grey" data-act="pasteText">批量粘贴文本</button>
          <button class="btn sm" data-act="save">保存 (${S.hs.length})</button>
        </div>
      </div>

      <div class="card tight mb">
        ${hasAudio ? `
          <div class="row" style="gap:8px;flex-wrap:wrap">
            <button class="btn sm" data-act="aPlay">播放 / 暂停</button>
            <span class="muted small" id="a-time" style="min-width:110px">0.00s / ${fmtMs(d.lesson.audio.durationMs)}</span>
            <input type="range" id="a-seek" min="0" max="1000" value="0" style="flex:1;min-width:160px;padding:0">
            <button class="btn sm ghost" data-act="markStart">打起点</button>
            <button class="btn sm ghost" data-act="markEnd">打终点</button>
            <button class="btn sm grey" data-act="preview">试听选中句</button>
          </div>`
        : `<div class="muted small">这一课还没有上传音频 —— 左侧点「音频」上传 mp3 后，才能给热区打时间区间。
           （没有音频也可以先画框、录文本，学生端会用 TTS 兜底朗读）</div>`}
      </div>

      <div style="display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap">
        <div style="flex:0 1 560px;min-width:320px">
          <div class="muted small mb">在图上 <b>按住拖拽</b> 画出一句话的范围；点已有框可选中；选中后按 Delete 删除</div>
          <div class="canvas-wrap" id="cv">
            <img src="${d.page.img.url}" id="cv-img" draggable="false">
            <div id="boxes"></div>
          </div>
        </div>
        <div style="flex:1 1 380px;min-width:320px">
          <div class="card">
            <div class="strong mb">热区列表</div>
            <div id="hs-list"></div>
          </div>
          <div class="card" id="editor"></div>
        </div>
      </div>`;
    if (hasAudio) {
      audio.src = d.lesson.audio.url;
      audio.ontimeupdate = () => {
        const t = document.getElementById('a-time');
        const sk = document.getElementById('a-seek');
        if (t) t.textContent = `${audio.currentTime.toFixed(2)}s / ${fmtMs(d.lesson.audio.durationMs)}`;
        if (sk && audio.duration) sk.value = String(Math.round((audio.currentTime / audio.duration) * 1000));
      };
      const sk = document.getElementById('a-seek');
      sk.oninput = () => { if (audio.duration) audio.currentTime = (Number(sk.value) / 1000) * audio.duration; };
    }
    bindCanvas();
    renderBoxes();
  }

  function renderBoxes() {
    const box = document.getElementById('boxes');
    if (!box) return;
    box.innerHTML = S.hs.map((h, i) => `
      <div class="abox ${i === S.sel ? 'sel' : ''}" data-i="${i}"
        style="left:${h.x * 100}%;top:${h.y * 100}%;width:${h.w * 100}%;height:${h.h * 100}%">
        <span class="lbl">${i + 1}</span></div>`).join('');
    document.getElementById('hs-list').innerHTML = S.hs.length ? S.hs.map((h, i) => `
      <div class="hs-row ${i === S.sel ? 'sel' : ''}" data-act="selHs" data-i="${i}">
        <div class="idx">${i + 1}</div>
        <div class="grow">
          <div class="small strong ellip">${esc(h.en) || '<span style="color:#CBD5E1">（未填英文）</span>'}</div>
          <div class="muted small ellip">${esc(h.cn) || '—'}</div>
          <div class="muted small">${fmtMs(h.startMs)} → ${fmtMs(h.endMs)}</div>
        </div>
        <button class="btn sm danger" data-act="delHs" data-i="${i}" style="padding:2px 8px">×</button>
      </div>`).join('') : '<div class="muted small">还没有热区，在左边图上拖拽画一个</div>';
    renderEditor();
  }

  function renderEditor() {
    const el = document.getElementById('editor');
    if (!el) return;
    if (S.sel < 0 || !S.hs[S.sel]) { el.innerHTML = '<div class="muted small">选中一个热区来编辑内容与时间区间</div>'; return; }
    const h = S.hs[S.sel];
    el.innerHTML = `
      <div class="strong mb">编辑第 ${S.sel + 1} 个热区</div>
      <label class="field"><span>英文原文</span><input id="e-en" value="${esc(h.en)}" placeholder="Hello! My name is Li Ming."></label>
      <label class="field"><span>中文释义</span><input id="e-cn" value="${esc(h.cn)}" placeholder="你好！我叫李明。"></label>
      <div class="row" style="gap:8px">
        <label class="field grow"><span>起点 (ms)</span><input id="e-s" type="number" value="${h.startMs || 0}"></label>
        <label class="field grow"><span>终点 (ms)</span><input id="e-e" type="number" value="${h.endMs || 0}"></label>
      </div>
      <div class="muted small">坐标 x=${h.x.toFixed(4)} y=${h.y.toFixed(4)} w=${h.w.toFixed(4)} h=${h.h.toFixed(4)}（归一化，换图片分辨率不用重标）</div>`;
    ['e-en', 'e-cn', 'e-s', 'e-e'].forEach((id) => {
      const inp = document.getElementById(id);
      inp.oninput = () => {
        const t = S.hs[S.sel];
        if (id === 'e-en') t.en = inp.value;
        if (id === 'e-cn') t.cn = inp.value;
        if (id === 'e-s') t.startMs = Number(inp.value) || 0;
        if (id === 'e-e') t.endMs = Number(inp.value) || 0;
        S.dirty = true;
        const row = document.querySelectorAll('.hs-row')[S.sel];
        if (row && (id === 'e-en' || id === 'e-cn')) {
          row.querySelector('.strong').textContent = t.en || '（未填英文）';
          row.querySelectorAll('.muted')[0].textContent = t.cn || '—';
        }
      };
    });
  }

  /* ---------------- 画框 ---------------- */
  function bindCanvas() {
    const cv = document.getElementById('cv');
    if (!cv) return;
    let start = null, temp = null;
    cv.addEventListener('mousedown', (e) => {
      const hit = e.target.closest('.abox');
      if (hit) { S.sel = Number(hit.dataset.i); renderBoxes(); return; }
      const r = cv.getBoundingClientRect();
      start = { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height, r };
      temp = document.createElement('div');
      temp.className = 'abox sel';
      cv.appendChild(temp);
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!start) return;
      const x2 = (e.clientX - start.r.left) / start.r.width;
      const y2 = (e.clientY - start.r.top) / start.r.height;
      const x = Math.max(0, Math.min(start.x, x2)), y = Math.max(0, Math.min(start.y, y2));
      const w = Math.min(1 - x, Math.abs(x2 - start.x)), h = Math.min(1 - y, Math.abs(y2 - start.y));
      Object.assign(temp.style, { left: x * 100 + '%', top: y * 100 + '%', width: w * 100 + '%', height: h * 100 + '%' });
      temp._rect = { x, y, w, h };
    });
    window.addEventListener('mouseup', () => {
      if (!start) return;
      const rect = temp && temp._rect;
      if (temp) temp.remove();
      start = null; temp = null;
      if (!rect || rect.w < 0.02 || rect.h < 0.012) return;
      const prev = S.hs[S.hs.length - 1];
      S.hs.push({ ...rect, en: '', cn: '', startMs: prev ? prev.endMs + 400 : 0, endMs: prev ? prev.endMs + 2400 : 2000 });
      S.sel = S.hs.length - 1;
      S.dirty = true;
      renderBoxes();
    });
  }

  document.addEventListener('keydown', (e) => {
    if (/input|textarea/i.test((e.target.tagName || ''))) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && S.sel >= 0) { ACT.delHs({ dataset: { i: S.sel } }); e.preventDefault(); }
    if (e.key === 'ArrowDown' && S.hs.length) { S.sel = Math.min(S.hs.length - 1, S.sel + 1); renderBoxes(); e.preventDefault(); }
    if (e.key === 'ArrowUp' && S.hs.length) { S.sel = Math.max(0, S.sel - 1); renderBoxes(); e.preventDefault(); }
    if (e.key === ' ' && S.page) { ACT.aPlay(); e.preventDefault(); }
    if (e.key === 's' && (e.ctrlKey || e.metaKey)) { ACT.save(); e.preventDefault(); }
  });

  /* ---------------- 动作 ---------------- */
  const ACT = {
    async login() {
      const name = (document.getElementById('i-name') || {}).value || '';
      if (!name.trim()) return toast('请填写姓名');
      try { const d = await API.post('/api/auth/dev-login', { role: 'teacher', name: name.trim(), teacherCode: (document.getElementById('i-tcode') || {}).value || '' }); Store.token = d.token; Store.user = d.user; boot(); }
      catch (e) { toast(e.message); }
    },
    logout() { Store.clear(); boot(); },
    async newBook() {
      const title = prompt('教材名称', '自编讲义 · 新教材');
      if (!title) return;
      await API.post('/api/admin/books', { title, subtitle: '机构自编内容' });
      toast('已创建'); renderSide();
    },
    async newLesson(el) {
      const title = prompt('课名', 'Lesson 1');
      if (!title) return;
      await API.post('/api/admin/lessons', { bookId: Number(el.dataset.bid), title });
      toast('已创建'); renderSide();
    },
    upPage(el) { pickFile('image/*', async (f) => {
      const b64 = await fileToBase64(f);
      const ext = (f.name.split('.').pop() || 'png').toLowerCase();
      toast('上传中…');
      const r = await API.post('/api/admin/pages', { lessonId: Number(el.dataset.lid), imageBase64: b64, ext });
      toast(`页面已上传 ${r.imgW}×${r.imgH}`); renderSide();
    }); },
    upAudio(el) { pickFile('audio/*', async (f) => {
      const b64 = await fileToBase64(f);
      const ext = (f.name.split('.').pop() || 'mp3').toLowerCase();
      toast('上传中…');
      const r = await API.post(`/api/admin/lessons/${el.dataset.lid}/audio`, { base64: b64, ext });
      toast(`音频已上传，时长 ${fmtMs(r.asset.durationMs)}`);
      if (S.page) ACT.openPage({ dataset: { pid: S.page.page.id } });
    }); },
    async delBook(el) {
      if (!confirm(`删除教材「${el.dataset.name}」？\n它下面的课、页面、热区会一并删除，不可恢复。`)) return;
      try { await API.del('/api/admin/books/' + el.dataset.bid); toast('已删除'); S.page = null; renderSide(); renderMain(); }
      catch (e) { toast(e.message, 3000); }
    },
    async delLesson(el) {
      if (!confirm(`删除「${el.dataset.name}」？\n它下面的页面和热区会一并删除，不可恢复。`)) return;
      try { await API.del('/api/admin/lessons/' + el.dataset.lid); toast('已删除'); S.page = null; renderSide(); renderMain(); }
      catch (e) { toast(e.message, 3000); }
    },
    async openPage(el) {
      if (S.dirty && !confirm('当前页有未保存的改动，确定切换？')) return;
      const d = await API.get(`/api/pages/${el.dataset.pid}`);
      S.page = d;
      S.hs = d.hotspots.map((h) => ({ x: h.x, y: h.y, w: h.w, h: h.h, en: h.en || '', cn: h.cn || '', startMs: h.startMs, endMs: h.endMs }));
      S.sel = S.hs.length ? 0 : -1; S.dirty = false;
      renderMain(); renderSide();
    },
    selHs(el) { S.sel = Number(el.dataset.i); renderBoxes(); },
    delHs(el) { S.hs.splice(Number(el.dataset.i), 1); S.sel = Math.min(S.sel, S.hs.length - 1); S.dirty = true; renderBoxes(); },
    aPlay() { if (audio.paused) audio.play(); else audio.pause(); },
    markStart() { if (S.sel < 0) return toast('先选中一个热区'); S.hs[S.sel].startMs = Math.round(audio.currentTime * 1000); S.dirty = true; renderBoxes(); },
    markEnd() { if (S.sel < 0) return toast('先选中一个热区'); S.hs[S.sel].endMs = Math.round(audio.currentTime * 1000); S.dirty = true; renderBoxes(); },
    preview() {
      if (S.sel < 0) return toast('先选中一个热区');
      const h = S.hs[S.sel];
      clearTimeout(segTimer);
      audio.currentTime = (h.startMs || 0) / 1000;
      audio.play();
      segTimer = setTimeout(() => audio.pause(), Math.max(200, (h.endMs - h.startMs)) + 100);
    },
    autoRows() {
      const n = Number(prompt('等分成几行？', '6'));
      if (!n || n < 1) return;
      const top = 0.20, bottom = 0.80, x = 0.06, w = 0.88;
      const gap = (bottom - top) / n;
      S.hs = Array.from({ length: n }, (_, i) => ({
        x, y: top + i * gap, w, h: gap * 0.72, en: '', cn: '',
        startMs: i * 3000, endMs: i * 3000 + 2500,
      }));
      S.sel = 0; S.dirty = true; renderBoxes();
      toast('已生成等分框，拖拽微调即可');
    },
    pasteText() {
      const t = prompt('每行一句，格式：英文 | 中文\n（按顺序填入现有热区）',
        'Hello! My name is Li Ming. | 你好！我叫李明。\nWhat is your name? | 你叫什么名字？');
      if (!t) return;
      t.split('\n').map((s) => s.trim()).filter(Boolean).forEach((line, i) => {
        if (!S.hs[i]) return;
        const [en, cn] = line.split('|').map((x) => (x || '').trim());
        S.hs[i].en = en || ''; S.hs[i].cn = cn || '';
      });
      S.dirty = true; renderBoxes();
      toast('文本已填入');
    },
    async save() {
      if (!S.page) return;
      try {
        const r = await API.put(`/api/admin/pages/${S.page.page.id}/hotspots`, { hotspots: S.hs });
        S.dirty = false;
        toast(`已保存 ${r.count} 个热区 有`);
        renderSide();
      } catch (e) { toast(e.message); }
    },
  };

  function pickFile(accept, cb) {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = accept;
    inp.onchange = () => { if (inp.files[0]) cb(inp.files[0]).catch((e) => toast(e.message)); };
    inp.click();
  }

  document.addEventListener('click', (e) => {
    const a = e.target.closest('[data-act]');
    if (a) (ACT[a.dataset.act] || (() => {}))(a, e);
  });
  window.addEventListener('beforeunload', (e) => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });

  async function boot() {
    renderTop();
    if (!Store.token) {
      $wrap.style.display = 'none';
      $top.insertAdjacentHTML('afterend', `<div class="view" id="lg" style="max-width:420px;margin:40px auto">
        <div class="card"><div class="strong mb">登录内容后台</div>
        <label class="field"><span>姓名（老师/管理员）</span><input id="i-name" value="王老师"></label>
        <label class="field"><span>老师口令</span><input id="i-tcode" type="password" placeholder="本地开发可不填"></label>
        <button class="btn block" data-act="login">进入</button></div></div>`);
      return;
    }
    const lg = document.getElementById('lg'); if (lg) lg.remove();
    $wrap.style.display = 'flex';
    try { await API.get('/api/me'); } catch { Store.clear(); return boot(); }
    await renderSide();
    renderMain();
  }
  boot();
})();
