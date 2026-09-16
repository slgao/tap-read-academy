/**
 * Cloudflare Worker：只做静态资源分发。
 * 体验版没有后端 —— 点读内容内联在 mock-api.js，学习记录存在访问者自己的 localStorage。
 */
export default {
  async fetch(request, env) {
    const res = await env.ASSETS.fetch(request);
    const url = new URL(request.url);

    // 图片和音频体积大且不会变，给长缓存；HTML 不缓存，方便随时更新内容
    if (/\.(webp|png|jpg|mp3|m4a)$/i.test(url.pathname)) {
      const h = new Headers(res.headers);
      h.set('Cache-Control', 'public, max-age=604800, immutable');
      return new Response(res.body, { status: res.status, headers: h });
    }
    return res;
  },
};
