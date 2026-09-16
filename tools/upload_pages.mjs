/* 批量把一个目录里的页面图上传到某一课
 * 用法: node tools/upload_pages.mjs <lessonId> <目录> [老师姓名]
 *   例: node tools/upload_pages.mjs 1 out/handout 王老师
 */
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://localhost:3000';
const [lessonId, dir, name = '王老师'] = process.argv.slice(2);
if (!lessonId || !dir) {
  console.error('用法: node tools/upload_pages.mjs <lessonId> <目录> [老师姓名]');
  process.exit(1);
}

const call = async (m, p, b, t) => {
  const r = await fetch(BASE + p, {
    method: m,
    headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) },
    body: m === 'GET' ? undefined : JSON.stringify(b || {}),
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error(p + ' -> ' + j.msg);
  return j.data;
};

const { token } = await call('POST', '/api/auth/dev-login', { role: 'teacher', name });
const files = fs.readdirSync(dir).filter((f) => /\.(webp|png|jpe?g)$/i.test(f)).sort();
if (!files.length) { console.error('目录里没有图片'); process.exit(1); }

let n = 0;
for (const f of files) {
  const ext = path.extname(f).slice(1).toLowerCase();
  const imageBase64 = fs.readFileSync(path.join(dir, f)).toString('base64');
  const r = await call('POST', '/api/admin/pages', { lessonId: Number(lessonId), pageNo: ++n, imageBase64, ext }, token);
  console.log(`  [${n}/${files.length}] ${f} → page ${r.id} (${r.imgW}×${r.imgH})`);
}
console.log(`\n已上传 ${n} 页到 lesson ${lessonId}。去后台画热区：${BASE}/admin.html`);
