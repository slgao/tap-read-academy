'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, CONTENT_DIR } = require('./db');
const { handleApi } = require('./api');

const PORT = Number(process.env.PORT) || 3000;
const WEB_DIR = path.join(ROOT, 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav',
  '.webm': 'audio/webm', '.ogg': 'audio/ogg', '.ico': 'image/x-icon',
};

// 静态文件，支持 Range —— 音频 seek（点读按时间区间播放）依赖它
function serveStatic(req, res, baseDir, relPath) {
  const safe = path.normalize(relPath).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(baseDir, safe);
  if (!file.startsWith(baseDir)) { res.writeHead(403); return res.end('forbidden'); }
  let st;
  try { st = fs.statSync(file); } catch { res.writeHead(404); return res.end('not found'); }
  if (st.isDirectory()) return serveStatic(req, res, baseDir, path.join(safe, 'index.html'));

  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
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
      'Access-Control-Allow-Origin': '*',
    });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, {
    'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes',
    'Cache-Control': baseDir === CONTENT_DIR ? 'public, max-age=86400' : 'no-cache',
    'Access-Control-Allow-Origin': '*',
  });
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
  if (p.startsWith('/files/')) return serveStatic(req, res, CONTENT_DIR, p.slice('/files/'.length));
  if (p === '/') return serveStatic(req, res, WEB_DIR, 'index.html');
  return serveStatic(req, res, WEB_DIR, p);
});

server.listen(PORT, () => {
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
