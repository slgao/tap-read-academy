/* 公共：接口封装 / 存储 / 播放器 / 录音 —— 无任何第三方依赖 */
(function (global) {
  'use strict';

  const KEY = () => 'dianbu_' + (global.APP_KEY || 'app');

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

  /* ---------------- 播放器 ----------------
   * mode='tts'   浏览器语音合成朗读英文（Demo 默认；占位音轨听不出内容）
   * mode='audio' 播放真实音频文件，按 startMs~endMs 精确 seek —— 这是小程序端的真实逻辑
   */
  class Player {
    constructor() {
      this.el = new Audio();
      this.el.preload = 'auto';
      this.mode = 'tts';
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
      this._clear();
      this._onEnd = onEnd || null;
      this.current = hs;
      if (this._onTick) this._onTick(hs);

      const useTts = this.mode === 'tts' || !hs.audio || !hs.audio.url;
      if (useTts) {
        if (!('speechSynthesis' in window)) { toast('此浏览器不支持语音合成，请切换到「原音」'); this._finish(); return; }
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

  global.App = { Store, API, toast, esc, fmtDate, starStr, Player, Rec, fileToBase64 };
})(window);
