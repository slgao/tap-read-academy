# 体验版（静态，可放 Cloudflare Worker）

给朋友看的版本。**没有后端**：点读内容内联在 `public/mock-api.js`，学习记录、录音、作业提交都存在访问者自己手机的 localStorage 里，不上传、不产生任何服务器成本。

UI 代码（`styles.css` / `common.js` / `student.js`）和本地完整版**是同一份**，只是把数据层从 HTTP 接口换成了本地实现——这也顺带说明：数据层是可替换的，后面换成微信云不需要动界面。

## 本地预览

```bash
cd static-demo/public && python3 -m http.server 8080
# 打开 http://localhost:8080
```

## 部署到 Cloudflare

```bash
cd static-demo
npx wrangler login          # 首次
npx wrangler deploy
```

部署完会给一个 `https://dianbu-demo.<你的账号>.workers.dev` 地址，手机直接打开。

- 想换名字：改 `wrangler.toml` 里的 `name`
- 想挂自己域名：取消 `wrangler.toml` 里 `routes` 那两行的注释
- 也可以用 Pages：`npx wrangler pages deploy public`

**费用**：Workers 免费额度每天 10 万次请求，这个体验版一天几十个人访问远远用不完，实际是 0 元。

## 换成你自己的内容

1. 页面图放 `public/assets/`，命名 `p1.webp`、`p2.webp`…
2. 整课音频放 `public/assets/lesson1.mp3`
3. 打开 `public/mock-api.js`，改开头的 `CONTENT` 数组：坐标是归一化的 0~1，`startMs`/`endMs` 是这句话在音频里的起止毫秒

更省事的办法：在本地完整版（`mvp/`）的内容后台里画好热区，然后从数据库导出：

```bash
cd mvp && node -e "
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync('data/app.db');
const out=db.prepare('SELECT * FROM pages WHERE lesson_id=? ORDER BY sort').all(1).map(p=>({
  pageNo:p.page_no,
  hotspots:db.prepare('SELECT x,y,w,h,start_ms,end_ms,text_en,text_cn FROM hotspots WHERE page_id=? ORDER BY sort').all(p.id)
    .map((h,i)=>({id:p.page_no*100+i+1,x:h.x,y:h.y,w:h.w,h:h.h,startMs:h.start_ms,endMs:h.end_ms,en:h.text_en,cn:h.text_cn}))
}));
console.log(JSON.stringify(out,null,2));
"
```

## 两个要注意的

**1. 声音。** 体验版默认用浏览器语音合成朗读英文；如果访问者的手机没有英文语音包，会自动回退到内置音轨——而内置音轨目前是 ffmpeg 合成的**占位提示音**，不是人声。给朋友看之前，建议用手机把这 12 句录一遍（5 分钟的事），替换掉 `public/assets/lesson1.mp3` 并在 `mock-api.js` 里调整 `startMs`/`endMs`。

**2. 版权。** 这个体验版里的教材是脚本生成的**自编讲义**。冀教版等教材扫描件**不要**放到公网地址上——本地自己试可以，公开分发是另一回事。出版社对教材内容和配套音频享有著作权，未经授权把扫描件放上公网属于侵权。
