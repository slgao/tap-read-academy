'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, CONTENT_DIR } = require('./db');
const { handleApi } = require('./api');
const { handlePublic } = require('./public');

const PORT = Number(process.env.PORT) || 3000;
// 公网部署时设 HOST=127.0.0.1，只让反向代理（Caddy）访问；本地开发不设，监听所有网卡
const HOST = process.env.HOST || undefined;
const WEB_DIR = path.join(ROOT, 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav',
  '.webm': 'audio/webm', '.ogg': 'audio/ogg', '.ico': 'image/x-icon',
};

/**
 * 缓存策略：
 *   学生每次打开都要下 student.js + styles.css 一百多 KB，手机流量上很心疼。
 *   带上 ETag / Last-Modified 后，没改动的文件浏览器只会收到一个 304（几十字节）。
 *   校徽、课本图片、录音这类内容文件名字不会变，直接让浏览器缓存久一点。
 */
function cacheControl(baseDir, relPath) {
  if (baseDir === CONTENT_DIR) {
    return relPath.startsWith('posters/') ? 'no-cache' : 'public, max-age=604800';   // 海报按学生覆盖保存，必须回源
  }
  return relPath.startsWith('brand/') ? 'public, max-age=2592000' : 'no-cache';      // 页面和脚本每次回源问一句，没变就是 304
}

// 静态文件，支持 Range —— 音频 seek（点读按时间区间播放）依赖它
function serveStatic(req, res, baseDir, relPath) {
  const safe = path.normalize(relPath).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
  const file = path.join(baseDir, safe);
  if (!file.startsWith(baseDir)) { res.writeHead(403); return res.end('forbidden'); }
  let st;
  try { st = fs.statSync(file); } catch { res.writeHead(404); return res.end('not found'); }
  if (st.isDirectory()) return serveStatic(req, res, baseDir, path.join(safe, 'index.html'));

  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(36)}"`;
  const lastModified = st.mtime.toUTCString();
  const cache = cacheControl(baseDir, safe.split(path.sep).join('/'));
  const fresh = req.headers['if-none-match'] === etag
    || (!req.headers['if-none-match'] && req.headers['if-modified-since'] === lastModified);
  if (fresh) {
    res.writeHead(304, { ETag: etag, 'Last-Modified': lastModified, 'Cache-Control': cache });
    return res.end();
  }
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : st.size - 1;
    if (isNaN(start) || start >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    if (end >= st.size) end = st.size - 1;
    res.writeHead(206, {
      'Content-Type': type, 'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Accept-Ranges': 'bytes',
      ETag: etag, 'Last-Modified': lastModified, 'Cache-Control': cache,
      'Access-Control-Allow-Origin': '*',
    });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, {
    'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes',
    ETag: etag, 'Last-Modified': lastModified, 'Cache-Control': cache,
    'Access-Control-Allow-Origin': '*',
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const p = decodeURIComponent(url.pathname);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    });
    return res.end();
  }
  if (p.startsWith('/api/')) return handleApi(req, res, p);
  if (p === '/gallery' || p === '/trial' || p === '/about' || p === '/s' || p.startsWith('/s/')) {
    if (await handlePublic(req, res, url)) return;
  }
  if (p.startsWith('/files/')) return serveStatic(req, res, CONTENT_DIR, p.slice('/files/'.length));
  if (p === '/') return serveStatic(req, res, WEB_DIR, 'index.html');
  return serveStatic(req, res, WEB_DIR, p);
});

server.listen(PORT, HOST, () => {
  console.log(`
  ┌────────────────────────────────────────────────┐
  │  点读 MVP 服务已启动                             │
  ├────────────────────────────────────────────────┤
  │  学生端      http://localhost:${PORT}/            │
  │  老师端      http://localhost:${PORT}/teacher.html│
  │  内容后台    http://localhost:${PORT}/admin.html  │
  └────────────────────────────────────────────────┘
  数据库: mvp/data/app.db    内容目录: mvp/content/
  `);
});
