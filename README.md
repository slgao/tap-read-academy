# Tap Read Academy · 英语点读 + 作业打卡

面向小型英语培训机构的教材点读与作业跟读工具，对标「天天象上」，但品牌和数据都归机构自己。

一次性跑通：**教材点读 → 老师布置作业 → 学生录音提交 → 老师批改 → 打卡积分**，
外加一个能让机构自己生产内容的**热区标注后台**和一套 **PDF 自动标注工具**。

- 后端：Node.js，**零 npm 依赖**（只用 `node:http` + `node:sqlite`）
- 学生端 / 老师端 / 内容后台：原生 HTML/JS，无构建步骤
- 微信小程序：原生小程序代码，接同一套 API

### 几个值得看的点

| | |
|---|---|
| **点读数据结构** | 热区用归一化坐标（0~1），换图片分辨率不用重标；音频**一课一个文件 + 起止毫秒**，不切成几千个小片段 |
| **PDF 自动标注** | `tools/auto_annotate.mjs` 对文字可选中的 PDF 自动生成句子级热区：按「横向重叠 + 纵向相邻 + 字号相近」把文本行聚成块，并排的对话气泡不会串行 |
| **分层** | `api.js`（业务，零 SQL）→ `repo.js`（数据，唯一写 SQL 的地方）→ `storage.js`（文件）。repo/storage 全是 `async`，将来换成微信云开发时 `api.js` 一行都不用改 |
| **回归测试** | `npm test --prefix server`，24 项断言，跑完自己清理数据 |
| **静态体验版** | `static-demo/` 无后端、可一条命令部署到 Cloudflare Workers，0 成本，发链接就能演示 |

---

## 一、跑起来（30 秒）

```bash
cd mvp
./start.sh
```

浏览器打开（Chrome 里按 F12 → 切手机视图更像小程序）：

| 入口 | 地址 | 演示账号 |
|---|---|---|
| **学生端** | http://localhost:3000/ | 李小明 / 张小红 / 刘小刚，邀请码 `DEMO88` |
| **老师端** | http://localhost:3000/teacher.html | 王老师 |
| **内容后台** | http://localhost:3000/admin.html | 王老师 |

> 需要 Node.js ≥ 22.5（用到内置 `node:sqlite`）。当前机器是 v24，直接可用。
> 重置演示数据：`cd server && npm run reset`
>
> **备份别只拷 `app.db`**：数据库开了 WAL，最近的写入可能还在 `app.db-wal` 里。
> 正确做法是 `sqlite3 data/app.db ".backup 备份.db"`，或者把 `app.db`、`app.db-wal`、`app.db-shm` 三个一起拷。

---

## 二、5 分钟体验路线

1. **学生端** → 首页 → 教材 → 第 1 页 → **点任意一句**，会朗读并高亮
   - 右下 `TTS` / `原音` 可切换音源：`原音`播放真实 mp3 并按 `startMs~endMs` 精确 seek，
     这就是小程序端的真实逻辑；`TTS` 用浏览器语音合成，方便在还没配音时先试交互
   - `连播` 整页连读、`⟳` 单句复读、`1.0×` 变速、`框` 显示热区、`录` 跟读录音
   - 连续读满 60 秒会自动打卡（正式版是 5 分钟）
2. **老师端** → 作业 → `+ 布置` → 选班级/页面 → 勾几句 → 发布
3. **学生端** → 作业 → 打开 → 每句 `跟读` → `提交作业`
4. **老师端** → 作业 → 点进去 → `试听` 学生录音 → 点星 → 写评语 → `提交批改`
5. **学生端** → 作业 → 看到星星和评语；「我的」页看打卡日历

> 录音需要麦克风权限。`localhost` 是安全上下文，浏览器会正常弹权限框。

---

## 三、内容后台：怎么自己上一课

打开 http://localhost:3000/admin.html

1. `+ 新建教材` → 在教材下 `+课`
2. 课右侧 `音频` 上传整课 mp3（**一课一个文件**，不用切成几千个小片段）
3. 课右侧 `+页` 逐张上传页面图
4. 点左侧页面进入标注：
   - 在图上**按住拖拽**画出一句话的范围
   - 播放音频，在句子开始处点 `打起点`、结束处点 `打终点`
   - 填英文原文和中文释义，`试听选中句` 校对
   - `保存`
5. 学生端刷新即可看到

**效率工具**：`自动等分 6 行` 一次生成 6 个框再微调；`批量粘贴文本` 把 `英文 | 中文` 按行灌进去。
快捷键：`空格` 播放/暂停、`↑/↓` 切换热区、`Delete` 删除、`Ctrl+S` 保存。

### 导入自己的 PDF

**自动标注（推荐）** —— 对"文字可选中"的 PDF，热区可以全自动生成，不用手工画框：

```bash
# 渲染页面图 + 裁掉底部页脚水印 + 自动生成句子级热区，一步到位
node tools/auto_annotate.mjs 我的讲义.pdf <lessonId> --pages 7-10 --crop-bottom 7

# 先看结果不写库
node tools/auto_annotate.mjs 我的讲义.pdf 2 --pages 7-10 --dry
```

原理：`pdftotext -bbox-layout` 拿到每行文字的精确坐标，再按「横向重叠 + 纵向相邻 + 字号相近」
把行聚成文本块（一个气泡 = 一个块），块内把换行拆断的句子接回去。并排的对话气泡不会串行。

生成的热区坐标是归一化的，和页面图严丝合缝；中文释义留空，在后台补即可。
纯图片扫描件拿不到文字坐标，仍需人工在后台画框。

**手工流程**：

```bash
# 转图（150dpi → WebP 1080 宽 q75，约 60–90KB/页），并顺便提取文本
./tools/import_pdf.sh ../text_books/我的讲义.pdf 1 20 out/handout 1080

# 批量上传到某一课（lessonId 在后台左侧树里能看到）
node tools/upload_pages.mjs 1 out/handout

# 音频规范化：单声道 16kHz 48kbps
./tools/audio_norm.sh 原始录音.wav
```

### 没有配音怎么办：本地 TTS 自动生成

自编讲义最大的门槛不是排版，是**没有录音**。`tools/tts_lesson.mjs` 用本地神经网络 TTS
一次解决「配音 + 时间轴」两件事，全程离线，不花钱：

```bash
# 一次性安装（约 60MB 模型）
python3 -m venv .ttsenv && ./.ttsenv/bin/pip install piper-tts
./.ttsenv/bin/python -m piper.download_voices en_US-amy-medium
export PIPER=$PWD/.ttsenv/bin/piper PIPER_MODEL=$PWD/en_US-amy-medium.onnx

# 句子文件：一行一句，可选中文用 | 分隔
node tools/tts_lesson.mjs 课文.txt --out out/lesson1 --rate 1.05

# 直接写进某一页：上传课文音频 + 按顺序回填每个热区的起止毫秒
node tools/tts_lesson.mjs 课文.txt --out out/lesson1 --page 3

# 整课一次配完：时间轴按「页面顺序 + 页内热区顺序」依次分发给全部热区
node tools/tts_lesson.mjs 课文.txt --out out/lesson2 --lesson 2
```

产出单声道 48kbps mp3（约 0.36MB/分钟）和一份时间轴 JSON。
机器音用于验证流程和做演示足够了；正式上线建议换成老师本人的录音——
换了之后 `--page` 那一步照跑，时间轴会重新对齐。

演示教材的配音就是这么生成的，成品存在 `server/assets/demo_lesson1.mp3`，
`npm run reset` 时会优先使用它。

> **只导入自编讲义或已获授权的素材。** 出版社对教材内容与配套音频享有著作权，把扫描件放进对外分发的小程序
> 有侵权风险（被投诉下架、账号封禁、索赔）。教材 PDF 建议只作为提取课文文本的内部参考。
> 仓库里的演示教材是脚本现画的自编内容，不含任何出版社素材。

---

## 四、微信小程序版

`miniprogram/` 是原生小程序代码，页面和数据流与 H5 版一一对应：

```
pages/login    登录（MVP 用姓名+邀请码，正式版换 wx.login + 手机号快速验证）
pages/index    首页：打卡数据 + 今日作业 + 教材
pages/catalog  目录
pages/reader   ★ 点读器：图片 + 归一化坐标热区 + 按时间区间 seek + 连播/复读/变速/录音
pages/hwlist   作业列表
pages/hwdetail 作业详情：逐句跟读、提交
pages/me       打卡日历、星星
utils/audio.js ★ 播放器封装（一课一音频 + start/end 毫秒切片）
```

**在 Linux 上没法直接运行**——微信开发者工具没有官方 Linux 版。要预览请在 Windows / macOS 上：

1. 安装微信开发者工具，导入 `mvp/miniprogram/` 目录
2. AppID 选「测试号」
3. 勾选 **详情 → 本地设置 → 不校验合法域名**
4. 把 `utils/config.js` 里的 `BASE` 改成这台 Linux 机器的局域网 IP，例如 `http://192.168.1.20:3000`
5. 两台设备在同一个 Wi-Fi 下即可

---

## 四之二、发给别人看

`static-demo/` 是一份**纯静态**的体验版：没有后端，内容内联，学习记录存在访问者自己手机的 localStorage 里。

```bash
cd static-demo
npx wrangler deploy        # 部署到 Cloudflare Workers，免费额度足够
```

本地先看看：`cd static-demo/public && python3 -m http.server 8080`

UI 代码和完整版是同一份文件，只是多加载了一个 `mock-api.js` 把数据层换成本地实现。
详见 `static-demo/README.md`。

---

## 五、目录结构

```
mvp/
├── start.sh              一键启动
├── server/
│   ├── package.json      零依赖
│   ├── assets/           演示教材的课文语音（TTS 生成）+ 时间轴
│   ├── test/e2e.mjs      端到端回归测试（npm test）
│   └── src/
│       ├── index.js      HTTP 服务 + 静态文件（支持 Range，音频 seek 靠它）
│       ├── db.js         SQLite 表结构
│       ├── repo.js       ★ 数据访问层 —— 全库唯一写 SQL 的地方
│       ├── storage.js    ★ 文件存储层 —— 全库唯一碰文件系统的地方
│       ├── api.js        全部接口（无 SQL、不碰文件）
│       ├── util.js
│       └── seed.js       生成演示内容（ImageMagick 画页 + ffmpeg 合成音轨）
├── web/                  浏览器版三端（无构建）
│   ├── index.html/student.js    学生端
│   ├── teacher.html/teacher.js  老师端
│   ├── admin.html/admin.js      ★ 内容后台 + 热区标注工具
│   ├── common.js                接口/播放器/录音封装
│   └── styles.css
├── miniprogram/          微信小程序原生代码
├── static-demo/          纯静态体验版（可部署到 Cloudflare Worker，无后端、0 成本）
├── tools/                PDF 导入与自动标注、批量上传、音频规范化、TTS 配音、演示录屏
├── content/              页面图 / 音频 / 学生录音（静态托管在 /files/）
└── data/app.db           SQLite 数据库
```

---

## 四之三、录一段演示视频

发给别人看最省事的方式是一段竖屏小视频（微信里直接能播，也不怕对方打不开链接）：

```bash
cd static-demo/public && python3 -m http.server 8080 &   # 体验版先跑起来
npm i playwright                                          # 一次性，用系统已装的 Chrome
node tools/record_demo.mjs --out out/demo
```

产出 `out/demo.mp4`，竖屏 860x1864、H.264+AAC，一分钟左右约 3MB。

想在视频里同时展示两套教材（比如自编讲义 + 导入的课本），给第二套音频和时间轴即可：

```bash
node tools/record_demo.mjs --out out/demo \
  --timings2 out/lesson2.json --audio2 out/lesson2.mp3 \
  --book-b 冀教版 --book-page-no 3 --book-offset 15
```

`--book-offset` 是该页第一个热区在第二套时间轴里的下标（前面几页的热区数之和）。

Playwright 录屏是**没有声音**的，所以脚本会记录每次触发发音的时刻，事后用 ffmpeg
把课文音频按这些时刻混回去；开头闪一帧纯黑作同步标记，用 `blackdetect` 校准零点——
录制起点每次都会漂移一点（实测 1.16~1.48s 不等），固定偏移量对不齐。

脚本还会在录制前重建一条干净的作业，并在学生提交后**用老师身份调接口真的批改一次**，
所以"老师批改 → 学生看到评语"这段是真实链路，不是演出来的。分镜写在脚本里，改内容直接改那几行。

---

## 五之二、分层与测试

```
api.js       业务接口：参数校验、权限、组装响应        ← 迁云时不动
  ├── repo.js      数据访问：领域方法，唯一写 SQL 的地方   ← 迁云时重写这个
  └── storage.js   文件存储：存取文件、探测时长尺寸        ← 迁云时重写这个
```

两条刻意的约定：

- **repo / storage 的方法全是 `async`**。现在 `node:sqlite` 是同步的，包一层 async 是为了将来换成
  异步驱动（微信云开发 / mysql2 / COS SDK）时，`api.js` 一行都不用改。
- **repo 对外只返回 camelCase 领域对象**，不泄露表名列名。`api.js` 里看不到 `last_checkin`、`text_en` 这种东西。

验收靠这个：

```bash
npm test --prefix server     # 需要服务已启动
```

24 项断言，覆盖登录鉴权、内容后台全链路、作业提交批改、打卡、权限、级联删除，
以及「重存标注不能换掉热区 id」——热区 id 被作业和学生录音引用，换了就全对不上。
跑完自己把测试数据删干净。**换掉 repo.js 之后全绿，就说明业务行为没变。**

---

## 六、数据模型要点

**热区（hotspots）是整个产品的核心数据**：

```json
{ "x":0.059, "y":0.200, "w":0.881, "h":0.068,
  "startMs":300, "endMs":2820,
  "en":"Hello! My name is Li Ming.", "cn":"你好！我叫李明。" }
```

- 坐标是**归一化的 0~1**，换图片分辨率不用重标
- 音频只存**一课一个文件 + 起止毫秒**，不切成几千个小文件（省请求、省流量、好维护）
- 前端用百分比定位热区层，天然跟随缩放和不同屏宽

---

## 七、这个 MVP 有什么、没有什么

**有**
- 点读（单句/连播/复读/变速/中英对照/跟读录音/热区显示）
- 作业全流程（布置 → 提交 → 批改 → 打回）
- 打卡、连续天数、星星、班级排行
- 内容后台 + 热区标注工具 + PDF 导入工具
- 学习时长统计（只在有音频播放时累计）

**没有（下一步）**
- 微信真实登录、手机号绑定、订阅消息
- AI 口语评测（讯飞 ISE / 腾讯 SOE，接口位置已留好：录音上传后由后端转发，失败降级为普通录音提交）
- 学情周报、续班风险预警
- 家长端、分享海报
- 资源防盗链、限流、内容安全检测（上线前必做，见 TRD §7）

**MVP 的简化（不要直接上线）**
- 登录是姓名+邀请码，没有真实鉴权强度
- 图片/音频走 base64 JSON 上传，正式版应改对象存储直传
- 单机 SQLite，没有备份
- 接口没有限流，管理接口只按角色粗粒度校验

---

## 八、下一步建议

1. 先用这个 MVP 给你朋友演示，**让她自己上一课内容**（这一步最能暴露真实问题）
2. 真机验证：Windows/Mac 上用开发者工具跑小程序端，重点测安卓机的音频 seek 精度
3. 决定内容路线（自编讲义 vs 取得授权），再决定要不要投产
4. 投产前补齐上线清单：小程序主体注册与微信认证、ICP 备案、类目与隐私协议、
   订阅消息模板、资源防盗链、接口限流、内容安全检测（`msgSecCheck`）
