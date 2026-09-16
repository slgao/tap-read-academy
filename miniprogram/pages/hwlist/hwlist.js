const api = require('../../utils/api');
const P = { todo: ['todo', '待完成'], submitted: ['warn', '已提交'], reviewed: ['ok', '已批改'], rejected: ['todo', '需重做'] };
Page({
  data: { list: [] },
  onShow() {
    if (!wx.getStorageSync('token')) return wx.redirectTo({ url: '/pages/login/login' });
    api.get('/api/homeworks').then((rows) => {
      this.setData({
        list: rows.map((h) => {
          const [cls, txt] = P[h.status] || P.todo;
          return Object.assign({}, h, {
            pillCls: cls, pillTxt: txt,
            starStr: '★'.repeat(h.stars || 0),
          });
        }),
      });
    }).catch((e) => api.toast(e.message));
  },
  open(e) { wx.navigateTo({ url: '/pages/hwdetail/hwdetail?id=' + e.currentTarget.dataset.id }); },
});
