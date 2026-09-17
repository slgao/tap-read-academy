/* 录音试听：全局只有一个播放器
 * 连点"听"不会叠在一起重复播放；再点正在播放的同一段 = 停止；
 * 和课文播放互斥（播录音时停课文，播课文时停录音）。
 */
let ctx = null;
let cur = { src: '', onChange: null };

function ensure() {
  if (ctx) return ctx;
  ctx = wx.createInnerAudioContext();
  ctx.obeyMuteSwitch = false;
  const done = () => notify(false);
  ctx.onEnded(done);
  ctx.onStop(done);
  ctx.onError(() => { notify(false); wx.showToast({ title: '录音播放失败', icon: 'none' }); });
  return ctx;
}

function notify(playing) {
  const cb = cur.onChange;
  if (!playing) cur = { src: '', onChange: null };
  if (cb) cb(playing);
}

function isPlaying(src) {
  return !!(ctx && cur.src && cur.src === src && !ctx.paused);
}

/** onChange(playing:boolean) 用于切换按钮状态 */
function play(src, onChange) {
  if (!src) return;
  if (isPlaying(src)) { stop(); return; }
  stop();
  require('./audio').stop();          // 延迟 require，避免与 audio.js 循环依赖
  const c = ensure();
  cur = { src, onChange: onChange || null };
  c.src = src;
  c.play();
  notify(true);
}

function stop() {
  if (!ctx || !cur.src) return;
  try { ctx.stop(); } catch (e) {}
  notify(false);
}

module.exports = { play, stop, isPlaying };
