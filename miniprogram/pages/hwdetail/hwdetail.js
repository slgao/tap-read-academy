const api = require('../../utils/api');
const audio = require('../../utils/audio');
const rec = wx.getRecorderManager();

Page({
  data: { hw: {}, items: [], recIdx: -1, starStr: '' },

  onLoad(o) {
    this.hwId = o.id;
    api.get('/api/homeworks/' + o.id).then((hw) => {
      const lessonAudio = hw.lessonAudio ? api.url(hw.lessonAudio.url) : '';
      const items = hw.items.map((it) => Object.assign({}, it, {
        audioUrl: it.audio ? api.url(it.audio.url) : lessonAudio, recPath: '',
      }));
      this.setData({ hw, items, starStr: '★'.repeat(hw.stars || 0) });
      wx.setNavigationBarTitle({ title: hw.title });
    }).catch((e) => api.toast(e.message));

    rec.onStop((r) => {
      const i = this.data.recIdx;
      if (i < 0) return;
      const items = this.data.items;
      items[i].recPath = r.tempFilePath;
      items[i].durationMs = r.duration;
      this.setData({ items, recIdx: -1 });
      api.toast('录好了，可以试听');
    });
  },
  onUnload() { audio.stop(); },

  openPage() {
    const ids = this.data.items.map((i) => i.hotspotId).join(',');
    wx.navigateTo({ url: '/pages/reader/reader?pageId=' + this.data.hw.pageId + '&hwIds=' + ids });
  },
  playOrigin(e) {
    const it = this.data.items[e.currentTarget.dataset.idx];
    audio.playSegment(it, null);
  },
  recToggle(e) {
    const i = e.currentTarget.dataset.idx;
    if (this.data.recIdx === i) { rec.stop(); return; }
    this.setData({ recIdx: i });
    rec.start({ duration: 60000, sampleRate: 16000, numberOfChannels: 1, encodeBitRate: 48000, format: 'mp3' });
  },
  playMine(e) {
    const c = wx.createInnerAudioContext();
    c.src = this.data.items[e.currentTarget.dataset.idx].recPath;
    c.play();
  },

  submit() {
    const fs = wx.getFileSystemManager();
    const payload = [];
    this.data.items.forEach((it) => {
      if (!it.recPath) return;
      payload.push({
        hotspotId: it.hotspotId,
        ext: 'mp3',
        durationMs: it.durationMs || 0,
        audioBase64: fs.readFileSync(it.recPath, 'base64'),
      });
    });
    if (!payload.length) return api.toast('至少录一句再提交');
    wx.showLoading({ title: '提交中…' });
    api.post('/api/homeworks/' + this.hwId + '/submit', { items: payload })
      .then(() => { wx.hideLoading(); api.toast('提交成功', 'success'); setTimeout(() => wx.navigateBack(), 800); })
      .catch((e) => { wx.hideLoading(); api.toast(e.message); });
  },
});
