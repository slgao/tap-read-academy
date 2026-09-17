/* 公共：接口封装 / 存储 / 播放器 / 录音 —— 无任何第三方依赖 */
(function (global) {
  'use strict';

  const KEY = () => 'tap_read_' + (global.APP_KEY || 'app');

  const Store = {
    get token() { try { return localStorage.getItem(KEY() + '_token') || ''; } catch { return ''; } },
    set token(v) { try { v ? localStorage.setItem(KEY() + '_token', v) : localStorage.removeItem(KEY() + '_token'); } catch {} },
    get user() { try { return JSON.parse(localStorage.getItem(KEY() + '_user') || 'null'); } catch { return null; } },
    set user(v) { try { v ? localStorage.setItem(KEY() + '_user', JSON.stringify(v)) : localStorage.removeItem(KEY() + '_user'); } catch {} },
    clear() { this.token = ''; this.user = null; },
  };

  async function request(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (Store.token) headers.Authorization = 'Bearer ' + Store.token;
    const res = await fetch(path, {
      method, headers,
      body: method === 'GET' ? undefined : JSON.stringify(body || {}),
    });
    let j;
    try { j = await res.json(); } catch { throw new Error('服务器返回异常 (' + res.status + ')'); }
    if (!res.ok || j.code !== 0) {
      if (res.status === 401) { Store.clear(); }
      throw new Error(j.msg || '请求失败');
    }
    return j.data;
  }
  const API = {
    get: (p) => request('GET', p),
    post: (p, b) => request('POST', p, b),
    put: (p, b) => request('PUT', p, b),
    del: (p) => request('DELETE', p),
  };

  let toastTimer;
  function toast(msg, ms) {
    let el = document.getElementById('toast');
    if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), ms || 1900);
  }

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const fmtDate = (s) => (s || '').slice(5, 16);
  const starStr = (n) => '★'.repeat(n || 0) + '<span class="off">' + '★'.repeat(5 - (n || 0)) + '</span>';

  const PLAYERS = [];

  /* ---------------- 录音试听 ----------------
   * 全局只有一个，避免连点"听"按钮时多个录音叠在一起重复播放。
   * 再点正在播放的同一段 = 停止；点另一段 = 先停旧的再放新的。
   */
  const Clip = {
    el: null, url: null, btn: null,
    playing(url) { return !!(this.el && !this.el.paused && this.url === url); },
    play(url, btn) {
      if (!url) return;
      if (this.playing(url)) { this.stop(); return; }
      this.stop();
      PLAYERS.forEach((p) => p.stop());   // 和课文播放互斥
      const el = new Audio(url);
      this.el = el; this.url = url; this.btn = btn || null;
      if (this.btn) this.btn.classList.add('is-playing');
      el.onended = () => { if (this.el === el) this.stop(); };
      el.onerror = () => { if (this.el === el) { this.stop(); toast('录音播放失败'); } };
      el.play().catch(() => { if (this.el === el) this.stop(); });
    },
    stop() {
      if (this.el) { try { this.el.pause(); this.el.src = ''; } catch (e) {} }
      if (this.btn) this.btn.classList.remove('is-playing');
      this.el = null; this.url = null; this.btn = null;
    },
  };

  /* ---------------- 播放器 ----------------
   * 有课文音频就播音频（按 startMs~endMs 精确 seek，和小程序端逻辑一致）；
   * 没有音频才退回浏览器语音合成；两者都没有就提示还没配音。
   * 微信内置浏览器没有语音合成，所以绝不能默认走语音合成。
   */
  class Player {
    constructor() {
      PLAYERS.push(this);
      this.el = new Audio();
      this.el.preload = 'auto';
      this.rate = 1;
      this.gap = 400;
      this._stopTimer = null;
      this._onTick = null;
      this.current = null;
      this.el.addEventListener('timeupdate', () => {
        if (this._endAt != null && this.el.currentTime * 1000 >= this._endAt) this._finish();
      });
      this.el.addEventListener('ended', () => this._finish());
    }
    _clear() {
      clearTimeout(this._stopTimer); this._stopTimer = null; this._endAt = null;
      try { speechSynthesis.cancel(); } catch {}
    }
    _finish() {
      this._clear();
      try { this.el.pause(); } catch {}
      const cb = this._onEnd; this._onEnd = null; this.current = null;
      if (this._onTick) this._onTick(null);
      if (cb) cb();
    }
    stop() { this._onEnd = null; this._clear(); try { this.el.pause(); } catch {} this.current = null; if (this._onTick) this._onTick(null); }
    setRate(r) { this.rate = r; this.el.playbackRate = r; }
    onTick(fn) { this._onTick = fn; }

    /** hs: {id,en,startMs,endMs,audio:{url,placeholder}} */
    play(hs, onEnd) {
      Clip.stop();                      // 放课文时先停掉正在放的录音
      this._clear();
      this._onEnd = onEnd || null;
      this.current = hs;
      if (this._onTick) this._onTick(hs);

      const hasAudio = !!(hs.audio && hs.audio.url && (hs.endMs || 0) > (hs.startMs || 0));
      if (!hasAudio) {
        if (!('speechSynthesis' in window) || !hs.en) { toast('这句还没有配音'); this._finish(); return; }
        const u = new SpeechSynthesisUtterance(hs.en || '');
        u.lang = 'en-US'; u.rate = 0.9 * this.rate;
        u.onend = () => this._finish();
        u.onerror = () => this._finish();
        try { speechSynthesis.cancel(); speechSynthesis.speak(u); }
        catch { this._finish(); }
        return;
      }
      const url = hs.audio.url;
      const start = (hs.startMs || 0) / 1000;
      this._endAt = hs.endMs || null;
      const go = () => {
        try {
          this.el.playbackRate = this.rate;
          this.el.currentTime = start;
          this.el.play().catch(() => this._finish());
          if (hs.endMs) {
            const ms = (hs.endMs - hs.startMs) / this.rate + 120;
            this._stopTimer = setTimeout(() => this._finish(), ms);
          }
        } catch { this._finish(); }
      };
      if (this.el.getAttribute('src') !== url) {
        this.el.setAttribute('src', url);
        this.el.src = url;
        this.el.addEventListener('loadedmetadata', go, { once: true });
        this.el.load();
      } else go();
    }

    /** 连播 */
    playList(list, idx, onIndex, onDone) {
      if (idx >= list.length) { if (onDone) onDone(); return; }
      if (onIndex) onIndex(idx);
      this.play(list[idx], () => {
        setTimeout(() => {
          if (this.stopped) { this.stopped = false; return; }
          this.playList(list, idx + 1, onIndex, onDone);
        }, this.gap);
      });
    }
  }

  /* ---------------- 录音 ---------------- */
  const Rec = {
    mr: null, chunks: [], stream: null, startAt: 0,
    supported() { return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && global.MediaRecorder); },
    async start() {
      if (!this.supported()) throw new Error('当前浏览器不支持录音（需 localhost 或 https）');
      Clip.stop();
      PLAYERS.forEach((p) => p.stop());
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.chunks = [];
      this.mr = new MediaRecorder(this.stream);
      this.mr.ondataavailable = (e) => { if (e.data && e.data.size) this.chunks.push(e.data); };
      this.mr.start();
      this.startAt = Date.now();
    },
    stop() {
      return new Promise((resolve, reject) => {
        if (!this.mr) return reject(new Error('未在录音'));
        this.mr.onstop = async () => {
          const type = this.mr.mimeType || 'audio/webm';
          const blob = new Blob(this.chunks, { type });
          this.stream.getTracks().forEach((t) => t.stop());
          const durationMs = Date.now() - this.startAt;
          const ext = type.includes('mp4') || type.includes('aac') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
          const base64 = await new Promise((r) => {
            const fr = new FileReader();
            fr.onload = () => r(String(fr.result).split(',')[1]);
            fr.readAsDataURL(blob);
          });
          this.mr = null;
          resolve({ base64, ext, durationMs, url: URL.createObjectURL(blob) });
        };
        this.mr.stop();
      });
    },
  };

  const fileToBase64 = (file) => new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result).split(',')[1]);
    fr.onerror = rej;
    fr.readAsDataURL(file);
  });

  /** 手机照片动辄 4–8MB：先缩到长边 1600、JPEG 0.8 再上传，返回 { base64, url } */
  function compressImage(file, maxSide = 1600, quality = 0.8) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const im = new Image();
      im.onload = () => {
        const k = Math.min(1, maxSide / Math.max(im.naturalWidth, im.naturalHeight));
        const w = Math.round(im.naturalWidth * k), h = Math.round(im.naturalHeight * k);
        const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
        const ctx = cv.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);      // PNG 透明底转 JPEG 不发黑
        ctx.drawImage(im, 0, 0, w, h);
        URL.revokeObjectURL(url);
        const dataUrl = cv.toDataURL('image/jpeg', quality);
        resolve({ base64: dataUrl.split(',')[1], url: dataUrl });
      };
      im.onerror = () => { URL.revokeObjectURL(url); reject(new Error('这张图片打不开，换一张试试')); };
      im.src = url;
    });
  }

  /** 和服务端 maskName 一致：李小明 → 李*明 */
  function maskName(name) {
    const n = String(name || '').trim();
    if (n.length <= 1) return n || '同学';
    if (n.length === 2) return n[0] + '*';
    return n[0] + '*'.repeat(n.length - 2) + n[n.length - 1];
  }

  /** 科目小标签 */
  const subjTag = (s) => (s ? `<span class="subj ${esc(s.color)}">${esc(s.name)}</span>` : '');

  const TYPE_NAME = { single: '单选', multi: '多选', judge: '判断', blank: '填空', photo: '拍照', text: '文字', audio: '录音' };

  /** 作答 / 标准答案转成给人看的文字 */
  const LETTER = 'ABCDEF';
  function fmtAnswer(q, v) {
    if (v == null || v === '' || (Array.isArray(v) && !v.length)) return '未作答';
    if (q.type === 'single') return LETTER[v] || '–';
    if (q.type === 'multi') return v.map((k) => LETTER[k]).sort().join('');
    if (q.type === 'judge') return v === true || v === 'true' ? '对' : '错';
    if (q.type === 'blank') return (Array.isArray(v) ? v : [v]).map((x) => String(x || '').trim() || '（空）').join('、');
    return String(v);
  }
  function fmtKey(q) {
    if (q.answer == null) return '';
    if (q.type === 'blank') return (q.answer.blanks || []).map((b) => b.join(' / ')).join('、');
    return fmtAnswer(q, q.answer);
  }
  const fmtNum = (n) => (n == null ? '–' : String(Math.round(n * 100) / 100));

  /** 点图看大图 */
  function lightbox(src) {
    const m = document.createElement('div');
    m.className = 'pub-lightbox';
    m.innerHTML = '<img alt="大图">';
    m.firstChild.src = src;
    m.addEventListener('click', () => m.remove());
    document.body.appendChild(m);
  }

  /** 其他播放器（如听力模式）登记进来，和课文、录音互相停止 */
  const registerPlayer = (p) => { PLAYERS.push(p); };

  global.App = { Store, API, toast, esc, fmtDate, starStr, Player, Rec, Clip, fileToBase64, registerPlayer, compressImage, maskName, subjTag, TYPE_NAME, lightbox, LETTER, fmtAnswer, fmtKey, fmtNum };
})(window);
