const api = require('../../utils/api');
Page({
  data: { lessons: [] },
  onLoad(o) {
    api.get('/api/books/' + o.id + '/catalog').then((d) => {
      this.setData({ lessons: d.lessons });
      wx.setNavigationBarTitle({ title: d.book.title });
    }).catch((e) => api.toast(e.message));
  },
  openPage(e) { wx.navigateTo({ url: '/pages/reader/reader?pageId=' + e.currentTarget.dataset.id }); },
});
