const api = require('../../utils/api');
const audio = require('../../utils/audio');
const clip = require('../../utils/clip');
const app = getApp();
const rec = wx.getRecorderManager();

Page({
  data: {
    imgUrl: '', hotspots: [], activeId: 0, showHs: false, showCn: true, repeat: false,
    rate: 1, rateText: '1.0×', playingAll: false, subEn: '', subCn: '',
    prevPageId: null, nextPageId: null, scrollTo: '', recording: false, recTip: '', myRecPath: '',
  },

  onLoad(o) {
    this.hwIds = o.hwIds ? o.hwIds.split(',').map(Number) : [];
    this.load(o.pageId);
    // 有音频播放时才累计学习时长
    this.timer = setInterval(() => { if (this.playing) app.tick(5); }, 5000);
    rec.onStop((r) => {
      this.setData({ recording: false, myRecPath: r.tempFilePath, recTip: '已录 ' + (r.duration / 1000).toFixed(1) + 's' });
    });
  },
  onUnload() { clearInterval(this.timer); audio.stop(); clip.stop(); },
  onHide() { audio.stop(); clip.stop(); this.playing = false; },

  load(pageId) {
    api.get('/api/pages/' + pageId).then((d) => {
      this.raw = d;
      const lessonAudio = d.lesson.audio ? api.url(d.lesson.audio.url) : '';
      const hotspots = d.hotspots.map((h) => ({
        id: h.id, left: +(h.x * 100).toFixed(3), top: +(h.y * 100).toFixed(3),
        wp: +(h.w * 100).toFixed(3), hp: +(h.h * 100).toFixed(3),
        startMs: h.startMs, endMs: h.endMs, en: h.en, cn: h.cn,
        audioUrl: h.audio ? api.url(h.audio.url) : lessonAudio,
        isHw: this.hwIds.indexOf(h.id) >= 0,
      }));
      this.setData({
        imgUrl: api.url(d.page.img.url), hotspots,
        prevPageId: d.prevPageId, nextPageId: d.nextPageId,
        subEn: '', subCn: '', activeId: 0,
      });
      wx.setNavigationBarTitle({ title: d.lesson.title + ' P' + d.page.pageNo });
    }).catch((e) => api.toast(e.message));
  },

  highlight(hs) {
    this.playing = !!hs;
    this.setData(hs
      ? { activeId: hs.id, subEn: hs.en, subCn: hs.cn, scrollTo: 'hs' + hs.id }
      : { activeId: 0 });
  },

  tapHs(e) {
    const hs = this.data.hotspots[e.currentTarget.dataset.idx];
    if (this.data.activeId === hs.id) { audio.stop(); this.highlight(null); return; }
    const loop = () => {
      this.highlight(hs);
      audio.playSegment(hs, this.data.repeat ? loop : () => this.highlight(null));
    };
    loop();
  },

  playAll() {
    if (this.data.playingAll) { audio.stop(); this.setData({ playingAll: false }); this.highlight(null); return; }
    this.setData({ playingAll: true });
    audio.playList(this.data.hotspots, 0,
      (i, hs) => this.highlight(hs),
      () => { this.setData({ playingAll: false }); this.highlight(null); });
  },

  toggleRepeat() { this.setData({ repeat: !this.data.repeat }); },
  toggleCn() { this.setData({ showCn: !this.data.showCn }); },
  toggleHs() { this.setData({ showHs: !this.data.showHs }); },
  cycleRate() {
    const seq = [0.75, 1, 1.25];
    const r = seq[(seq.indexOf(this.data.rate) + 1) % seq.length];
    audio.setRate(r);
    this.setData({ rate: r, rateText: r.toFixed(2).replace(/0$/, '') + '×' });
  },

  recToggle() {
    if (!this.data.recording) {
      audio.stop(); clip.stop();          // 录音时不能外放，否则会录进去
      rec.start({ duration: 60000, sampleRate: 16000, numberOfChannels: 1, encodeBitRate: 48000, format: 'mp3' });
      this.setData({ recording: true, recTip: '● 录音中，再点一次结束' });
    } else {
      rec.stop();
    }
  },
  playMyRec() {
    clip.play(this.data.myRecPath, (playing) => this.setData({ myRecPlaying: playing }));
  },

  prevPage() { if (this.data.prevPageId) { audio.stop(); this.load(this.data.prevPageId); } },
  nextPage() { if (this.data.nextPageId) { audio.stop(); this.load(this.data.nextPageId); } },
});
