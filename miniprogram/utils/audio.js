/* 点读播放器：一课一个音频文件 + 按 start/end 毫秒 seek 播放单句
 * 这是点读体验的核心，避免把课文切成几千个小音频文件
 */
const ctx = wx.createInnerAudioContext();
ctx.obeyMuteSwitch = false;   // 静音键下也能出声

let state = { src: '', endAt: null, timer: null, onEnd: null, rate: 1, stopped: false };

function clear() {
  if (state.timer) { clearTimeout(state.timer); state.timer = null; }
  state.endAt = null;
}

ctx.onTimeUpdate(() => {
  if (state.endAt != null && ctx.currentTime * 1000 >= state.endAt) finish();
});
ctx.onEnded(() => finish());
ctx.onError(() => finish());

function finish() {
  clear();
  try { ctx.pause(); } catch (e) {}
  const cb = state.onEnd; state.onEnd = null;
  if (cb) cb();
}

function stop() { state.onEnd = null; state.stopped = true; clear(); try { ctx.pause(); } catch (e) {} }

/** hs: { audioUrl, startMs, endMs } */
function playSegment(hs, onEnd) {
  clear();
  state.onEnd = onEnd || null;
  state.stopped = false;

  const start = (hs.startMs || 0) / 1000;
  state.endAt = hs.endMs || null;

  const go = () => {
    try {
      if (ctx.playbackRate !== undefined) ctx.playbackRate = state.rate;
    } catch (e) {}
    ctx.seek(start);
    ctx.play();
    if (hs.endMs) {
      // 部分安卓机 seek 有 ±200ms 误差，定时器兜底，终点后延 120ms 防吃字
      const ms = (hs.endMs - hs.startMs) / state.rate + 120;
      state.timer = setTimeout(finish, ms);
    }
  };

  if (state.src !== hs.audioUrl) {
    state.src = hs.audioUrl;
    ctx.src = hs.audioUrl;
    ctx.onCanplay(go);
  } else {
    go();
  }
}

/** 整页连播 */
function playList(list, idx, onIndex, onDone) {
  if (state.stopped || idx >= list.length) { if (onDone) onDone(); return; }
  if (onIndex) onIndex(idx, list[idx]);
  playSegment(list[idx], () => {
    setTimeout(() => {
      if (state.stopped) return;
      playList(list, idx + 1, onIndex, onDone);
    }, 400);
  });
}

function setRate(r) { state.rate = r; try { ctx.playbackRate = r; } catch (e) {} }

module.exports = { playSegment, playList, stop, setRate, ctx };
