# AMADEUS · 每日文献

每天把 arXiv 上跟你方向相关的新论文读一遍，翻译摘要、补背景、写总结、给一句判断，推到你手机上一 —— 界面是命运石之门 / Amadeus 的调子，详情页里有会跟心情变表情的 Live2D 红莉栖。

目标设备：**Pixel 5 / Android 14**（PWA，加到主屏幕即可）。

---

## 目录

```
app/
├── public/                  ← 静态站点（部署的就是这个目录）
│   ├── index.html
│   ├── style.css
│   ├── app.js
│   ├── manifest.json        PWA 清单
│   ├── sw.js                离线缓存
│   ├── data/                每日数据（pipeline 生成）
│   ├── figs/                论文插图
│   ├── vendor/              pixi / cubism4 / cubism core
│   └── model/               Kurisu Live2D（15 MB）
├── pipeline/
│   ├── run.py               主流程
│   ├── config.json          兴趣、模型、单价、推送
│   └── state/               RSS 缓存
├── pylib/                   tiktoken（本地依赖）
└── serve.py                 本地服务器
```

---

## 快速开始

### 1. 起服务

```bash
cd app
python3 serve.py
```

- 电脑：`http://127.0.0.1:8788/`
- 手机：`http://<你的局域网IP>:8788/`（脚本会打印出来）

手机 Chrome 打开后 → 菜单 → **添加到主屏幕**。之后就是全屏 App 的样子。

### 2. 生成某天的数据

```bash
# 完整流程（需要 API key）
export DEEPSEEK_API_KEY=sk-xxxx
PYTHONPATH=./pylib python3 pipeline/run.py

# 只看今天会选中哪 5 篇，不花钱
PYTHONPATH=./pylib python3 pipeline/run.py --dry-run

# 已有卡片文件，只重新组装数据（不调模型）
PYTHONPATH=./pylib python3 pipeline/run.py --assemble --date 2026-11-25
```

### 3. 自动跑（可选）

GitHub Actions 每天定时：

```yaml
on:
  schedule:
    - cron: '0 1 * * *'   # UTC 01:00 = 北京时间 09:00
jobs:
  daily:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: '3.11' }
      - run: python3 -m pip install --target app/pylib tiktoken
      - run: PYTHONPATH=app/pylib python3 pipeline/run.py
        working-directory: app
        env:
          DEEPSEEK_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}
      - uses: peaceiris/actions-gh-pages@v3
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          publish_dir: ./app/public
```

---

## 每日自动更新（GitHub Actions）

见 `README-GITHUB.md`。要点：

- 仓库根就是 `app/`，推上去后 Pages 源选 **GitHub Actions**
- 需要 secret `DEEPSEEK_API_KEY`
- 每天 UTC 01:30 跑；周末 arXiv 不公告时自动跳过
- `data/` 与 `figs/` 由 bot 自动提交；图片默认只保留最近 60 天（`--prune-days 60`）

---

## 功能说明（v0.5）

### 英文原文
详情页「ABSTRACT」下方有可折叠的 **ENGLISH ORIGINAL**，显示 arXiv 原始摘要。
管线会用 `de_tex()` 把 RSS 里的 LaTeX 残渣（`$\mu\simeq78$` 之类）压成可读文本。

### 我的批注
详情页每篇底部有一个文本框，**输入即自动保存**（500ms 防抖）到 `localStorage['amadeus.notes.v1']`。
列表里有批注的条目会在 arXiv id 后面显示一个朱红的 ✎。

### 日历 / 归档
底部 `ARCHIVE` 进入月历：

- 有内容的日期高亮、可点开
- 有批注的日期带朱红圆点
- 支持跨月翻页

### 备份
批注只在本机。日历页下方提供 **导出到剪贴板 / 显示文本 / 从文本导入**，
换手机或清数据前导一份 JSON 出来。

> 为什么不上传 GitHub：批注是私人笔记，走 Actions 需要再配一个 PAT 并处理冲突，
> 收益不抵复杂度。仓库里已经有「生成的内容」，批注留在设备上是合理的分工。

---

## 配置

`pipeline/config.json`：

| 键 | 说明 |
|---|---|
| `arxiv.categories` | 盯哪些分类，`RSS` 也在这里换 |
| `interest.keywords` | 关键词加权（标题命中权重 ×2.4） |
| `interest.exclude` | 扣分项，比如把纯模拟类论文压下去 |
| `select.top_n` | 每天推几篇，**默认 5** |
| `llm.base_url` / `model` | 任何 OpenAI 兼容接口 |
| `llm.api_key_env` | 从哪个环境变量读 key |
| `price` | 单价，决定统计页的成本估算 |

换模型只改 `llm` 三项 + `price`，代码不用动。

---

## Token 监测

- 每篇的 `usage` 来自 API 返回值（没有就用 tiktoken 本地算）
- 汇总写进 `public/data/<date>.json` 的 `usage` 字段
- 累计写进 `public/data/index.json` 的 `history`
- App 底部状态条显示当日总量，点进去是 7 天柱状图 + 成本估算

实测（2026-11-25，真实 5 篇）：**74,033 in / 6,220 out**，合计 **80,253**。

按 DeepSeek 价位（$0.27/M in、$1.10/M out）≈ **$0.027/天 ≈ $0.80/月**。

> 注意输出只有约 1.2k tokens/篇——卡片是结构化 JSON，比散文体省一半以上。

---

## 界面约定

### 扫描线只出现在「外壳」上

`.chrome` 类 = 有扫描线。加在：状态栏、品牌栏、尼克斯计数、字幕条、CRT 图窗、底部状态条。

**不加在**：论文列表、正文（摘要 / 背景 / 总结）。文字区保持干净。

新加组件时：它是"屏幕里的一块玻璃"就加 `.chrome`，是"纸上的字"就不加。

### 信息分层

| 颜色 | 含义 |
|---|---|
| 朱红 `#b94b43` | 她的判断（verdict / comment） |
| 暖白 `#e8e2d4` | 标题、关键数字 |
| 灰 `#aaa69e` | 正文 |
| 暗灰 `#5f5e59` | 元数据 |

### Live2D

- 在详情页左侧 142×200 的窗里，与论文主图并排
- `mood` 字段驱动表情：`impressed` → Smile，`neutral` → Surprised，`skeptical` → Angry
- 懒加载：第一次进详情页才拉 15 MB 模型，之后浏览器缓存
- 取景参数写在 `app.js` 的 `initLive2D` 里（发顶 1.2% / 肩线 31.5%），换模型要重调

---

## 已知限制

- 只有 `astro-ph.GA`，加分类请改 `config.json` 的 RSS
- 相关性排序是**关键词加权**，没有向量。对你这个聚焦的兴趣够用；兴趣变宽再加
- 抓不到 HTML 版的论文会被跳过（2023-12 之前的基本都没有）
- **arXiv 的 LaTeXML 偶尔会在中途的表格处截断 HTML**（实测 `2611.31355` 在 Sec 7.2 之后被截断）。
  管线会在正文 < 3000 tokens 时打印 `!!` 告警；遇到时需要人工复核结论，或改用 PDF
- 图片每次重跑都会重新下载并压缩；如果有别的程序覆盖了 `figs/`，跑一次
  `python3 -c` 里的 `compress_figures` 或直接重跑 `--assemble` 重新对齐路径
- Live2D 模型 15 MB，首次进入详情页会有 1–2 秒白屏
- 推送默认关闭，配好 ntfy 或 Telegram 再打开
