/* 公开宣传页（分享页、作品展、预约试听）的交互 —— 不依赖学生端代码 */
(function () {
  'use strict';
  function toast(msg, ms) {
    var el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg; el.classList.add('show');
    clearTimeout(toast.t); toast.t = setTimeout(function () { el.classList.remove('show'); }, ms || 2200);
  }

  // 分享引导：只给分享者本人看。先把地址里的 guide 参数去掉，否则转发出去别人也会看到引导
  var guide = document.getElementById('share-guide');
  if (guide) {
    try { history.replaceState(null, '', location.pathname); } catch (e) {}
    guide.addEventListener('click', function (e) { if (e.target === guide || e.target.hasAttribute('data-close-guide')) guide.remove(); });
  }

  // 作品原图：点开看大图
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('.pub-photo');
    if (!b) return;
    var m = document.createElement('div');
    m.className = 'pub-lightbox';
    m.innerHTML = '<img alt="作品大图">';
    m.firstChild.src = b.getAttribute('data-src');
    m.addEventListener('click', function () { m.remove(); });
    document.body.appendChild(m);
  });

  var form = document.getElementById('lead-form');
  if (!form) return;
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var fd = new FormData(form);
    var body = {
      token: form.getAttribute('data-token') || '',
      source: form.getAttribute('data-source') || 'trial',
      grade: fd.get('grade') || '',
      subjects: fd.getAll('subjects'),
      phone: String(fd.get('phone') || '').replace(/\s|-/g, ''),
      contactTime: fd.get('contactTime') || '',
      agree: !!fd.get('agree'),
    };
    if (!body.grade) return toast('请选择孩子年级');
    if (!/^1[3-9]\d{9}$/.test(body.phone)) return toast('请填写正确的 11 位手机号');
    if (!body.agree) return toast('请勾选同意老师联系您');
    var btn = form.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = '提交中…';
    fetch('/api/public/leads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j.code !== 0) throw new Error(j.msg || '提交失败');
        form.hidden = true;
        form.parentNode.querySelector('.pub-done').hidden = false;
      })
      .catch(function (err) { toast(err.message || '提交失败，请稍后再试'); btn.disabled = false; btn.textContent = '预约试听'; });
  });
})();
