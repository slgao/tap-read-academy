const api = require('../../utils/api');
Page({
  data: { user: {}, sum: { streak: 0, stars: 0, days: [] }, books: [], todo: [], todayMin: 0 },
  onShow() {
    if (!wx.getStorageSync('token')) return wx.redirectTo({ url: '/pages/login/login' });
    this.setData({ user: wx.getStorageSync('user') || {} });
    Promise.all([api.get('/api/study/summary'), api.get('/api/homeworks'), api.get('/api/books')])
      .then(([sum, hws, books]) => this.setData({
        sum,
        books: books.map((b) => Object.assign({}, b, { initial: (b.title || '书').slice(0, 1) })),
        todo: hws.filter((h) => h.status === 'todo' || h.status === 'rejected'),
        todayMin: Math.round(((sum.days[0] || {}).seconds || 0) / 60),
      }))
      .catch((e) => api.toast(e.message));
  },
  openHw(e) { wx.navigateTo({ url: '/pages/hwdetail/hwdetail?id=' + e.currentTarget.dataset.id }); },
  openBook(e) { wx.navigateTo({ url: '/pages/catalog/catalog?id=' + e.currentTarget.dataset.id }); },
});
