const api = require('../../utils/api');
Page({
  data: { name: '李小明', code: 'DEMO88' },
  onName(e) { this.setData({ name: e.detail.value }); },
  onCode(e) { this.setData({ code: e.detail.value.toUpperCase() }); },
  login() {
    if (!this.data.name.trim()) return api.toast('请填写姓名');
    api.post('/api/auth/dev-login', { role: 'student', name: this.data.name.trim(), inviteCode: this.data.code.trim() })
      .then((d) => {
        wx.setStorageSync('token', d.token);
        wx.setStorageSync('user', d.user);
        wx.switchTab({ url: '/pages/index/index' });
      })
      .catch((e) => api.toast(e.message));
  },
});
