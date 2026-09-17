const api = require('../../utils/api');

const WEEK = '日一二三四五六';
const dayKey = (d) => d.toISOString().slice(0, 10);

function greeting() {
  const h = new Date().getHours();
  return h < 6 ? '夜深了' : h < 11 ? '早上好' : h < 14 ? '中午好' : h < 18 ? '下午好' : '晚上好';
}

/** 近 7 天的打卡印章 */
function seals(sum) {
  const map = {};
  (sum.days || []).forEach((d) => { map[d.date] = d.seconds; });
  const out = [];
  for (let i = 6; i >= 0; i--) {
    const dt = new Date(Date.now() - i * 86400000);
    const key = dayKey(dt);
    out.push({ key, today: i === 0, on: (map[key] || 0) >= sum.needSeconds, label: i === 0 ? '今天' : WEEK[dt.getDay()] });
  }
  return out;
}

Page({
  data: { user: {}, sum: { streak: 0, stars: 0, days: [], needSeconds: 300 }, books: [], todo: [],
          todayMin: 0, seals: [], greeting: '你好', needMin: 1 },
  onShow() {
    if (!wx.getStorageSync('token')) return wx.redirectTo({ url: '/pages/login/login' });
    this.setData({ user: wx.getStorageSync('user') || {}, greeting: greeting() });
    Promise.all([api.get('/api/study/summary'), api.get('/api/homeworks'), api.get('/api/books')])
      .then(([sum, hws, books]) => {
        const today = (sum.days || []).find((d) => d.date === dayKey(new Date()));
        this.setData({
          sum,
          seals: seals(sum),
          needMin: Math.max(1, Math.round(sum.needSeconds / 60)),
          books: books.map((b) => Object.assign({}, b, { initial: (b.title || '书').slice(0, 1) })),
          todo: hws.filter((h) => h.status === 'todo' || h.status === 'rejected'),
          todayMin: Math.round(((today || {}).seconds || 0) / 60),   // 只算今天，不是"最近一天"
        });
      })
      .catch((e) => api.toast(e.message));
  },
  openHw(e) { wx.navigateTo({ url: '/pages/hwdetail/hwdetail?id=' + e.currentTarget.dataset.id }); },
  openBook(e) { wx.navigateTo({ url: '/pages/catalog/catalog?id=' + e.currentTarget.dataset.id }); },
});
