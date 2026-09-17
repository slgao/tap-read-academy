# 体验版（静态，可放 Cloudflare Worker）

> **当前没有部署。** 测试验证改用 Oracle 上的完整版，Cloudflare 上的 `tap-read-demo` Worker 和海报用的 KV 存储已删除。
> 以后要重新上线，按下面步骤部署，并先按 `wrangler.toml` 里的注释新建 KV 存储。

给朋友看的版本。**没有后端**：教材内容在 `public/content.json`，学习记录、录音、作业提交都存在访问者自己手机的 localStorage 里，不上传、不产生任何服务器成本。

> **仓库里不含教材内容。** `public/content.json` 和 `public/assets/` 已加入 `.gitignore`——
> 导入的教材可能是出版社素材，不应进公开仓库。克隆下来后先按下面「生成内容」一节导出一次。

UI 代码（`styles.css` / `common.js` / `student.js`）和本地完整版**是同一份**，只是把数据层从 HTTP 接口换成了本地实现——这也顺带说明：数据层是可替换的，后面换成微信云不需要动界面。

## 生成内容

内容从本地完整版导出：先在完整版里导入教材、画好热区、配好音频，然后

```bash
cd mvp && ./start.sh &
node tools/export_static_demo.mjs
```

会生成 `public/content.json` 和 `public/assets/`（页面图自动转 WebP）。常用选项：

| 选项 | 作用 |
|---|---|
| `--books 自编讲义` | 只导出书名包含这些关键字的教材，逗号分隔 |
| `--hw-page 9 --hw-from 2 --hw-count 4` | 演示作业用第几页、从第几句开始、取几句 |
| `--hw-title` / `--hw-note` | 作业标题和给学生的话 |

**只想公开演示、不带任何出版社内容**：`--books 自编讲义`。

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

部署完会给一个 `https://tap-read-demo.<你的账号>.workers.dev` 地址，手机直接打开。

- 想换名字：改 `wrangler.toml` 里的 `name`
- 想挂自己域名：取消 `wrangler.toml` 里 `routes` 那两行的注释
- 也可以用 Pages：`npx wrangler pages deploy public`

**费用**：Workers 免费额度每天 10 万次请求，这个体验版一天几十个人访问远远用不完，实际是 0 元。

## 要注意的

**1. 声音。** 体验版**默认直接播放课文音频文件**，不依赖访问者设备的语音合成——
安卓微信的内置浏览器经常没有英文语音包，靠 TTS 会哑火。所以导出前，完整版里的每一课都要有音频。

没有录音的课可以先用 `tools/tts_lesson.mjs --lesson <id>` 生成机器音配音；
换成老师本人的录音后，在完整版里重新对齐时间轴，再导出一次即可。

**2. 版权。** 导出了什么，部署出去就公开什么。出版社对教材内容和配套音频享有著作权，
把扫描件放上公网地址有被投诉的风险，是否这样做由机构自己决定；
只想零风险演示，用 `--books 自编讲义` 导出。

**3. 音频分段。** Cloudflare 的静态资源服务不支持 Range 请求，而 iPhone（含微信内置浏览器）
播放音频要求服务端返回 206，否则点读按时间段跳转会失效。所以 `wrangler.toml` 里配了
`run_worker_first = ["/assets/*"]`，由 `worker.js` 自己切片返回 206。
