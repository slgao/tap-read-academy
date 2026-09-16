const api = require('../../utils/api');
Page({
  data: { user: {}, sum: { streak: 0, stars: 0, totalMinutes: 0, needSeconds: 60 }, cells: [], classNames: '' },
  onShow() {
    if (!wx.getStorageSync('token')) return wx.redirectTo({ url: '/pages/login/login' });
    this.setData({ user: wx.getStorageSync('user') || {} });
    Promise.all([api.get('/api/study/summary'), api.get('/api/me')]).then(([sum, me]) => {
      const map = {};
      sum.days.forEach((d) => { map[d.date] = d; });
      const cells = [];
      for (let i = 27; i >= 0; i--) {
        const dt = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
        cells.push({ d: dt, n: Number(dt.slice(8)), on: !!(map[dt] && map[dt].seconds >= sum.needSeconds) });
      }
      this.setData({ sum, cells, classNames: me.classes.map((c) => c.name).join('、') });
    }).catch((e) => api.toast(e.message));
  },
  logout() {
    wx.clearStorageSync();
    wx.redirectTo({ url: '/pages/login/login' });
  },
});
