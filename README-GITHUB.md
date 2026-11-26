# 部署到 GitHub Pages（每天自动更新）

仓库根目录就是 `app/`。按下面五步走一次，之后就不用管了。

---

## 1. 建仓库并推上去

```bash
cd /home/catmint/sth_interesting/app

git init
git add .
git commit -m "amadeus daily: init"

# 在 GitHub 上建一个空仓库（不要勾 README），假设叫 amadeus-daily
git remote add origin git@github.com:<你的用户名>/amadeus-daily.git
git branch -M main
git push -u origin main
```

> `public/model/`（15 MB）和 `public/figs/` 会被一起推上去，第一次大约 20 MB。

---

## 2. 配 API Key

仓库 → **Settings → Secrets and variables → Actions → New repository secret**

| Name | Value |
|---|---|
| `DEEPSEEK_API_KEY` | 你的 key |

换别的模型：改 `pipeline/config.json` 的 `llm.base_url` / `model` / `api_key_env`，
再把 secret 名字对应上。

---

## 3. 打开 Pages

**Settings → Pages → Build and deployment → Source** 选 **GitHub Actions**（不要选 branch）。

---

## 4. 手动跑一次

**Actions → daily → Run workflow**，日期留空即可。

跑完你会看到：
- `public/data/<date>.json` 被自动提交（bot 提交）
- Pages 发布，地址形如 `https://<用户名>.github.io/amadeus-daily/`

---

## 5. 之后

每天 UTC 01:30（北京时间 09:30）自动跑。周末 arXiv 不公告，脚本会自动跳过，不报错。

---

## 注意事项

### 仓库体积
- `data/*.json` 每天约 24 KB，一年 9 MB —— 无所谓
- `figs/` 每天约 1 MB。管线默认 **只保留最近 60 天的图片**（`--prune-days 60`），
  更早的日期 JSON 还在、日历还能点开，只是图片会显示 `NO FIGURE`
- 想全留：workflow 里去掉 `--prune-days`，但一年会长 365 MB

### 隐私
批注存在手机本地（localStorage），**不会上传仓库**。换机前用 App 里「导出到剪贴板」备份。

### 本地开发与线上共存
本地 `serve.py` 用的也是 `public/`，和 Pages 完全同构。改动先在本地 `git push` 前跑一遍
`python3 pipeline/run.py --dry-run` 看看选出来的 5 篇。

### APK 与线上数据
现在的 APK 是**离线快照**。如果想让手机上的 App 每天都是新的：

1. Pages 部署好之后拿到网址
2. 在 `public/` 下新建 `remote.js`：`window.REMOTE_BASE = "https://<用户名>.github.io/amadeus-daily/";`
3. `app.js` 里把 `loadIndex()` / `getDay()` 的 URL 前面拼上 `window.REMOTE_BASE`
4. 重新 `build.sh` 并装一次

这一步还没做，需要的话说一声。
