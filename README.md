# AMADEUS · 每日文献

把 arXiv 上跟你方向相关的新论文读一遍——翻译摘要、补背景、写总结、给一句判断。
界面是命运石之门 / Amadeus 的调子，详情页有会跟心情变表情的 Live2D 红莉栖。

**v0.8.0 起是纯本地应用**：所有抓取、筛选、生成、存储都在手机上完成，没有任何服务器。

---

## 它做什么

```
抓 arXiv 每日公告（RSS）
  → 模型按你填的「研究方向」挑 N 篇
  → 逐篇抓正文、剥参考文献
  → 下载插图、压成 WebP
  → 模型写卡片：摘要译文 / 背景 / 总结 / 判断
  → 存进手机本地数据库
```

点开一篇能看到：一句话判决（字幕条样式）、AI 批注、摘要中英对照、背景、要点、
自己的批注（自动保存）、论文插图（可全屏放大、左右翻页、双击缩放）。

另有日历视图浏览历史、Token 用量统计、反馈按钮（▲ 有用 / ▼ 不感兴趣）。

---

## 安装

从 **Releases** 下载 `amadeus-daily.apk`（约 9.4 MB），或用这个地址：

```
https://apotofcat-bit.github.io/arxiv_daily/download.html
```

- Android 8.0+（minSdk 26 / targetSdk 34）
- 已签名，覆盖安装不会丢数据
- 装好后第一次打开是空的，需要先填 API Key

---

## 首次使用

1. 打开 App → 底部 **⚙**
2. **DeepSeek API Key**：粘贴你的 key（只存本机，不进 APK，不上传）
3. **研究方向**：一句自然语言，例如
   `观察高红移星系的星际介质与化学演化，关注 JWST/ALMA 的光谱观测`
4. **arXiv 分类**：勾选你关注的（默认 astro-ph.GA）
5. **每天几篇** / **卡片保留** / **插图保留**
6. 点 **保存设置** → **运行自检**（三项都要绿）
7. 点 **立即生成今天的日报**

> 生成时 App 必须在前台，大约 1–2 分钟。切后台 Android 会节流 JS，请求链会断。
> arXiv 周末和美国假日不公告，那时候会是「没有论文」。

---

## 存储

用 **IndexedDB**（不是 localStorage，后者只有 5–10 MB）。

| | |
|---|---|
| 单天卡片 JSON | ~25 KB |
| 单天插图（压成 WebP 后） | 15 张 × ~100 KB ≈ 1.5 MB |
| **单天合计** | **~1.5 MB** |
| 默认：插图留 30 天 | ≈ 45 MB |
| 默认：卡片留 60 天 | ≈ 46 MB（稳态） |

超过保留天数的会在每次生成后自动清掉：

- 超过**插图保留**天数 → 只删图，卡片文字留着，那天仍可打开（显示 NO FIGURE）
- 超过**卡片保留**天数 → 整天删除

---

## 关于「定时」

**没有定时。** 每天需要手动点一次生成。

想在手机上做定时是可能的，但要改成前台服务 + 原生（或常驻 WebView）的实现，
而且 Android 的 Doze 会让执行时间漂移几小时。考虑到每次生成只花 1–2 分钟，
手动点一次是当前性价比最高的方案。

---

## 从源码构建

不需要 Android Studio，也不需要 Gradle。

```bash
cd android/project
./build.sh
```

产物：`android/amadeus-daily.apk`

工具链已就位在 `android/` 下：

| 组件 | 路径 |
|---|---|
| JDK 17 | `android/jdk-17.0.21.1+2` |
| Android SDK | `android/sdk`（build-tools 34 + platform 34） |
| 构建脚本 | `android/project/build.sh` |
| 签名密钥 | `android/project/amadeus.keystore`（密码 `amadeus123`） |

构建路径：`aapt2 compile` → `aapt2 link` → `javac` → `d8` → `zipalign` → `apksigner`。

---

## 架构

```
android/project/
├── java/dev/amadeus/daily/MainActivity.java
│     WebView 外壳 + 原生 HTTP 桥（绕开 CORS）
├── res/                 图标（自适应）
└── assets/              构建时从 app/public 拷入

app/public/
├── index.html           列表 / 详情 / 日历 / 设置
├── app.js               路由、渲染、图片查看器、设置
├── local.js             本地引擎：RSS / 模型 / 正文 / IndexedDB
├── style.css
├── vendor/              pixi + Cubism（Live2D）
└── model/               Kurisu Live2D（15 MB）
```

### 为什么需要原生 HTTP 桥

`rss.arxiv.org`、`arxiv.org`、`api.deepseek.com` 都不发 CORS 头，
WebView 里 `fetch` 会被同源策略拦掉。所以 `MainActivity` 里有一个异步桥：

```
JS:   Native.req(id, method, url, headers, body)
Java: 开线程发请求 → evaluateJavascript("__nativeResolve(id, …)")
```

### 密钥边界

- API key 只存在手机的 IndexedDB 里，运行时可改，**不编译进 APK**
- APK 里没有任何凭据，谁下载都拿不到你的 key
- `android:allowBackup="false"`，不进 adb backup / 云备份

---

## 依赖与许可

- Live2D Cubism Core：Live2D Inc. 的许可（见 `public/vendor/live2dcubismcore.min.js` 头部）
- pixi.js：MIT
- 角色立绘为第三方版权，仅供个人使用
- 界面风格参考 [Code-Amadeus/Amadeus](https://github.com/Code-Amadeus/Amadeus)（AGPL-3.0），
  只借鉴配色与排版逻辑，未使用其任何素材
