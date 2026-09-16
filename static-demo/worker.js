/**
 * Cloudflare Worker：分发体验版的静态资源。
 *
 * 为什么不直接用静态资源服务：它不支持 Range 请求，音频一律整文件返回 200。
 * iPhone（包括微信内置浏览器）播放音频要求服务端返回 206 分段，否则点读按时间段 seek 会失效。
 * 所以 /assets/* 先经过这里，由 Worker 自己切片。音频文件都在 1MB 以内，整读再切没有压力。
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
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
