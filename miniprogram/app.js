const api = require('./utils/api');

App({
  globalData: { user: null, accumSec: 0, pendingSec: 0 },

  onLaunch() {
    // 学习时长心跳：只在有音频播放时累计（见 reader 页），每 15 秒上报一次
    setInterval(() => {
      const g = this.globalData;
      if (g.pendingSec >= 15 && wx.getStorageSync('token')) {
        const s = g.pendingSec; g.pendingSec = 0;
        api.post('/api/study/heartbeat', { seconds: s })
          .then((r) => { if (r.justChecked) wx.showToast({ title: '打卡成功！连续 ' + r.streak + ' 天', icon: 'none' }); })
          .catch(() => {});
      }
    }, 5000);
  },

  tick(sec) { this.globalData.accumSec += sec; this.globalData.pendingSec += sec; },
});
