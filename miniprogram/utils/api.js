const { BASE } = require('./config');

function request(method, path, data) {
  return new Promise((resolve, reject) => {
    const token = wx.getStorageSync('token');
    wx.request({
      url: BASE + path,
      method,
      data: data || {},
      header: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
      timeout: 15000,
      success(res) {
        const b = res.data || {};
        if (res.statusCode === 401) {
          wx.removeStorageSync('token');
          wx.redirectTo({ url: '/pages/login/login' });
          return reject(new Error('登录已过期'));
        }
        if (b.code !== 0) return reject(new Error(b.msg || '请求失败'));
        resolve(b.data);
      },
      fail(e) { reject(new Error('网络错误：' + (e.errMsg || ''))); },
    });
  });
}

module.exports = {
  BASE,
  get: (p) => request('GET', p),
  post: (p, d) => request('POST', p, d),
  put: (p, d) => request('PUT', p, d),
  url: (u) => (u && u.startsWith('/') ? BASE + u : u),
  toast: (t, icon) => wx.showToast({ title: t, icon: icon || 'none' }),
};
