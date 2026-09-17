/**
 * Cloudflare Worker：分发体验版的静态资源。
 *
 * 为什么不直接用静态资源服务：它不支持 Range 请求，音频一律整文件返回 200。
 * iPhone（包括微信内置浏览器）播放音频要求服务端返回 206 分段，否则点读按时间段 seek 会失效。
 * 所以 /assets/* 先经过这里，由 Worker 自己切片。音频文件都在 1MB 以内，整读再切没有压力。
 */
const POSTER_TTL = 3 * 24 * 3600;          // 海报只留 3 天
const POSTER_MAX = 1.5 * 1024 * 1024;

/**
 * 学习海报：体验版没有后端，海报画好后传到这里存进 KV，换成真实的 https 图片地址。
 * 微信内置浏览器不支持下载，对 base64 内嵌图片长按也常常存不下来；真实图片地址可以长按保存、识别二维码。
 */
async function savePoster(request, env, url) {
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) return Response.json({ code: 403, msg: '不允许跨站上传' }, { status: 403 });
  const buf = await request.arrayBuffer();
  const b = new Uint8Array(buf);
  if (!buf.byteLength || buf.byteLength > POSTER_MAX) return Response.json({ code: 1001, msg: '海报大小不对' }, { status: 400 });
  if (!(b[0] === 0xFF && b[1] === 0xD8)) return Response.json({ code: 1001, msg: '海报必须是 JPG 图片' }, { status: 400 });
  const id = crypto.randomUUID().replace(/-/g, '');
  await env.POSTERS.put('p:' + id, buf, { expirationTtl: POSTER_TTL });
  return Response.json({ code: 0, msg: 'ok', data: { url: `/poster/${id}.jpg` } });
}

async function getPoster(id, env) {
  const buf = await env.POSTERS.get('p:' + id, 'arrayBuffer');
  if (!buf) return new Response('海报已过期', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  return new Response(buf, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/_poster') {
      return request.method === 'POST' ? savePoster(request, env, url) : new Response(null, { status: 405 });
    }
    const pm = /^\/poster\/([a-f0-9]{32})\.jpg$/.exec(url.pathname);
    if (pm) return getPoster(pm[1], env);

    const res = await env.ASSETS.fetch(new Request(url.toString(), { method: 'GET' }));
    if (!url.pathname.startsWith('/assets/') || res.status !== 200) return res;

    const headers = new Headers(res.headers);
    headers.set('Accept-Ranges', 'bytes');
    headers.set('Cache-Control', 'public, max-age=604800');
    headers.delete('Content-Encoding');

    const range = request.headers.get('Range');
    if (!range) {
      return new Response(request.method === 'HEAD' ? null : res.body, { status: 200, headers });
    }

    const buf = await res.arrayBuffer();
    const size = buf.byteLength;
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] !== '' ? parseInt(m[1], 10) : NaN;
    let end = m && m[2] !== '' ? parseInt(m[2], 10) : NaN;
    if (isNaN(start) && !isNaN(end)) { start = Math.max(0, size - end); end = size - 1; }  // bytes=-500
    if (isNaN(start)) start = 0;
    if (isNaN(end) || end >= size) end = size - 1;
    if (start >= size || start > end) {
      headers.set('Content-Range', `bytes */${size}`);
      return new Response(null, { status: 416, headers });
    }
    headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
    headers.set('Content-Length', String(end - start + 1));
    return new Response(request.method === 'HEAD' ? null : buf.slice(start, end + 1), { status: 206, headers });
  },
};
