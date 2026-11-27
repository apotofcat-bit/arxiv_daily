#!/usr/bin/env python3
"""
AMADEUS // DAILY  —  arXiv 每日文献管线

用法:
    python3 run.py                     # 完整流程：抓取 → 排序 → 生成卡片 → 出数据
    python3 run.py --date 2026-11-25   # 指定日期
    python3 run.py --assemble          # 只用已有 cards 文件重新组装（不调 LLM）
    python3 run.py --dry-run           # 只抓取+排序，不调 LLM，打印选中结果

依赖: 标准库 + tiktoken（PYTHONPATH=../pylib）
环境: DEEPSEEK_API_KEY（或 config.llm.api_key_env 指定的变量）
"""
import argparse
import concurrent.futures as cf
import gzip
import hashlib
import html
import io
import json
import os
import re
import shutil
import sys
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
PUB = ROOT / "public"
DATA = PUB / "data"
FIGS = PUB / "figs"
STATE = HERE / "state"
for d in (DATA, FIGS, STATE):
    d.mkdir(parents=True, exist_ok=True)

# tiktoken 可选：缺失时用字符数近似
try:
    import tiktoken
    _ENC = tiktoken.get_encoding("cl100k_base")
    def ntok(s: str) -> int:
        return len(_ENC.encode(s))
except Exception:
    def ntok(s: str) -> int:
        return int(len(s) / 3.2)

UA = {"User-Agent": "amadeus-daily/0.1 (+personal research digest)"}


# ---------------------------------------------------------------- utils
def get(url: str, timeout=45) -> bytes:
    req = urllib.request.Request(url, headers={**UA, "Accept-Encoding": "identity"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
        if r.headers.get("Content-Encoding") == "gzip":
            raw = gzip.GzipFile(fileobj=io.BytesIO(raw)).read()
        return raw


def load_cfg():
    return json.loads((HERE / "config.json").read_text(encoding="utf-8"))


def jdump(path: Path, obj):
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"  → {path.relative_to(ROOT)}  ({path.stat().st_size/1024:.1f} KB)")



# ---------------------------------------------------------------- LaTeX 清理
_TEX_MAP = {
    r"\mu":"μ", r"\lambda":"λ", r"\Lambda":"Λ", r"\nu":"ν", r"\sigma":"σ",
    r"\alpha":"α", r"\beta":"β", r"\gamma":"γ", r"\delta":"δ", r"\epsilon":"ε",
    r"\eta":"η", r"\theta":"θ", r"\kappa":"κ", r"\pi":"π", r"\rho":"ρ",
    r"\tau":"τ", r"\phi":"φ", r"\chi":"χ", r"\psi":"ψ", r"\omega":"ω",
    r"\odot":"⊙", r"\pm":"±", r"\simeq":"≈", r"\sim":"~", r"\approx":"≈",
    r"\lesssim":"≲", r"\gtrsim":"≳", r"\times":"×", r"\log":"log",
    r"\%":"%", r"\,":" ", r"\;":" ", r"\!":"", r"\ ":" ",
}


def de_tex(t):
    """把 RSS 摘要里的 LaTeX 残渣压成可读文本。够用就好。"""
    if not t:
        return ""
    t = t.replace("$", "")
    t = re.sub(r"\\mathrm\{([^{}]*)\}", r"\1", t)
    t = re.sub(r"\\text\{([^{}]*)\}", r"\1", t)
    t = re.sub(r"\\mathit\{([^{}]*)\}", r"\1", t)
    for k, v in _TEX_MAP.items():
        t = t.replace(k, v)
    t = re.sub(r"\{([^{}]*)\}", r"\1", t)
    t = t.replace("\\", " ")
    t = re.sub(r"\s+", " ", t).strip()
    return t


# ---------------------------------------------------------------- 1. RSS
def fetch_rss(cfg, date: str):
    """抓当日 RSS，返回条目列表。结果缓存在 state/rss-<date>.xml"""
    feeds = cfg["arxiv"]["rss"]
    if isinstance(feeds, str):
        feeds = [feeds]

    items = []
    for feed in feeds:
        slug = re.sub(r"[^a-z.]", "", feed.rsplit("/", 1)[-1].lower()) or "feed"
        cache = STATE / f"rss-{date}-{slug}.xml"
        if cache.exists():
            raw = cache.read_bytes()
            print(f"  [{slug}] 缓存命中 ({len(raw)/1024:.0f} KB)")
        else:
            print(f"  [{slug}] 拉取 {feed}")
            raw = get(feed)
            cache.write_bytes(raw)
        items.extend(parse_feed(raw, date))
    # 去重（cross-list 会重复）
    seen, uniq = set(), []
    for x in items:
        if x["id"] in seen:
            continue
        seen.add(x["id"])
        uniq.append(x)
    print(f"  解析到 {len(items)} 条，去重后 {len(uniq)} 条")
    return uniq


def parse_feed(raw: bytes, date: str):
    root = ET.fromstring(raw)
    out = []
    for it in root.findall(".//item"):
        link = (it.findtext("link") or "").strip()
        aid = link.rstrip("/").split("/")[-1]
        desc = it.findtext("description") or ""
        abstract = re.sub(r"^.*?Abstract:\s*", "", desc, flags=re.S)
        abstract = html.unescape(re.sub(r"<[^>]+>", " ", abstract))
        abstract = re.sub(r"\s+", " ", abstract).strip()
        title = re.sub(r"\s+", " ", (it.findtext("title") or "")).strip()
        if not aid or not title:
            continue
        out.append({
            "id": aid,
            "title": title,
            "abstract": abstract,
            "abstract_clean": de_tex(abstract),
            "link": f"https://arxiv.org/abs/{aid}",
            "announced": date,
        })
    return out



# ---------------------------------------------------------------- 反馈向量
FB_FILE = HERE / "feedback.json"
_STOP = set("""a an the of in on at to for from with by as is are was were be been being and or
not no we our this that these those it its their they them which who whom what when where while
than then such can may might will would could should do does did have has had also more most
using used use we our show shows shown find finds found present presented we""".split())


def _tokens(text: str):
    return [w for w in re.findall(r"[a-z][a-z\-]{2,}", (text or "").lower()) if w not in _STOP]


def build_feedback_weights():
    """从 feedback.json 学一个词权重：喜欢的论文里出现的词加权，不喜欢的减权。
    返回 {word: weight}，没有文件就返回空字典。"""
    if not FB_FILE.exists():
        return {}
    try:
        d = json.loads(FB_FILE.read_text(encoding="utf-8"))
    except Exception:
        print("  feedback.json 解析失败，忽略")
        return {}

    def counter(items):
        c = {}
        for it in items or []:
            if isinstance(it, str):
                continue
            for w in set(_tokens(it.get("title", "")) + _tokens(it.get("abstract", ""))):
                c[w] = c.get(w, 0) + 1
        return c

    liked = counter(d.get("liked"))
    disliked = counter(d.get("disliked"))
    nL = max(len(d.get("liked") or []), 1)
    nD = max(len(d.get("disliked") or []), 1)
    w = {}
    for k, v in liked.items():
        w[k] = w.get(k, 0) + v / nL
    for k, v in disliked.items():
        w[k] = w.get(k, 0) - v / nD
    return {k: v for k, v in w.items() if abs(v) > 0.001}


def feedback_score(item, weights):
    if not weights:
        return 0.0
    toks = set(_tokens(item["title"]) + _tokens(item["abstract"]))
    if not toks:
        return 0.0
    return sum(weights.get(t, 0.0) for t in toks) / (len(toks) ** 0.5)


# ---------------------------------------------------------------- 2. 排序
def score_item(item, cfg, fbw=None) -> float:
    """存在性打分：一个关键词出现多次不重复计分，避免长摘要刷分。
    标题命中 ×2.4，摘要命中 ×1.0，排除词 ×(-6)。
    """
    title = item["title"].lower()
    txt = title + " " + item["abstract"].lower()
    s = 0.0
    for kw in cfg["interest"]["keywords"]:
        k = kw.lower()
        if k in txt:
            s += 2.4 if k in title else 1.0
    for ex in cfg["interest"].get("exclude", []):
        if ex.lower() in txt:
            s -= 6.0
    # 反馈向量：+2.5 倍权重，喜欢/不喜欢各自累积
    s += 2.5 * feedback_score(item, fbw or {})
    return s


def select(items, cfg, fbw=None):
    scored = sorted(((score_item(i, cfg, fbw), i) for i in items), key=lambda x: -x[0])
    pre = cfg["select"]["prefilter_n"]
    top = cfg["select"]["top_n"]
    cand = [x[1] for x in scored[:pre] if x[0] > 0]
    picked = cand[:top]
    return picked, len(cand), len(items)


# ---------------------------------------------------------------- 3. 正文
def fetch_body(arxiv_id: str, cfg, max_tokens: int):
    """取 HTML 全文，剥标签、剥参考文献，返回 (text, figures)。
    结果缓存在 state/body/<id>.txt，重复组装不再联网。"""
    cache = STATE / "body" / f"{arxiv_id}.txt"

    def clip(text):
        if ntok(text) > max_tokens:
            ratio = max_tokens / ntok(text)
            text = text[: int(len(text) * ratio)]
            print(f"    正文超长，截断至 {max_tokens} tokens")
        return text

    if cache.exists():
        return clip(cache.read_text(encoding="utf-8")), []

    base = cfg["arxiv"]["html_base"]
    html_txt = None
    for suffix in ("v1", "v2", ""):
        url = f"{base}/{arxiv_id}{suffix}"
        try:
            raw = get(url).decode("utf-8", "replace")
            if "<html" in raw.lower() or "ltx_" in raw:
                html_txt = raw
                break
        except Exception:
            continue
    if not html_txt:
        return None, []

    # 图片
    figs = []
    for m in re.finditer(r'<img[^>]+src="([^"]+)"', html_txt):
        src = m.group(1)
        if src.startswith("data:") or "static.arxiv.org" in src or src.endswith(".svg"):
            continue
        if not src.lower().endswith((".png", ".jpg", ".jpeg")):
            continue
        if src not in figs:
            figs.append(src)

    # 正文
    t = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", html_txt, flags=re.S | re.I)
    # 砍掉参考文献之前一切之后的东西
    cut = re.search(r"<h2[^>]*>\s*References\s*</h2>", t, flags=re.I)
    if cut:
        t = t[: cut.start()]
    t = re.sub(r"<math.*?</math>", " [MATH] ", t, flags=re.S | re.I)
    t = re.sub(r"<[^>]+>", " ", t)
    t = html.unescape(t)
    t = re.sub(r"[ \t]+", " ", t)
    t = re.sub(r"\n\s*\n+", "\n", t).strip()

    (STATE / "body").mkdir(parents=True, exist_ok=True)
    cache.write_text(t, encoding="utf-8")
    return clip(t), figs


def download_figures(arxiv_id, srcs, limit=3):
    out = FIGS / arxiv_id
    out.mkdir(parents=True, exist_ok=True)
    got = []
    for src in srcs:
        if len(got) >= limit:
            break
        url = src if src.startswith("http") else f"https://arxiv.org/html/{src}"
        name = re.sub(r"[^A-Za-z0-9._-]", "_", Path(urllib.parse.urlparse(url).path).name)[:60]
        if not name.lower().endswith((".png", ".jpg", ".jpeg")):
            name += ".png"
        dst = out / name
        if dst.exists() and dst.stat().st_size > 2000:
            got.append(f"figs/{arxiv_id}/{name}")
            continue
        try:
            blob = get(url, timeout=40)
            if len(blob) < 3000:
                continue
            dst.write_bytes(blob)
            got.append(f"figs/{arxiv_id}/{name}")
        except Exception as e:
            print(f"    图下载失败 {name}: {e}")
    return got


def compress_figures(arxiv_id, max_edge=1200, quality=82):
    """把下载的图压成适合手机的 WebP（长边 ≤ max_edge）。Pillow 缺失则跳过。"""
    try:
        from PIL import Image
    except Exception:
        return
    d = FIGS / arxiv_id
    if not d.exists():
        return
    for p in list(d.glob("*.png")) + list(d.glob("*.jpg")):
        try:
            im = Image.open(p).convert("RGB")
            w, h = im.size
            scale = min(1.0, max_edge / max(w, h))
            if scale < 1.0:
                im = im.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
            dst = p.with_suffix(".webp")
            im.save(dst, "WEBP", quality=quality, method=4)
            if dst.stat().st_size < p.stat().st_size:
                p.unlink()
        except Exception as e:
            print(f"    压缩失败 {p.name}: {e}")


# ---------------------------------------------------------------- 4. LLM
SYSTEM = """你是一个严谨的科研助理，为一个忙碌的研究者写每日论文卡片。
读者方向：高红移星系观测（JWST/ALMA 光谱与成像）。

严格遵守：
1. 只使用论文原文出现的数字。绝不推算、绝不补全、绝不编造。
2. 事实与判断分开：abstract_zh / background / summary 是事实；comment / verdict 是你的判断。
3. 论文没讲清楚的地方，写「不确定」，不要猜。
4. 中文写作，术语保留英文：例如 星族 (stellar population)。
5. 语气克制、学术、有一点温度。不用感叹号，不用「必读」「炸裂」这类词。
6. comment 必须指出这篇的弱点，不能全是好话。

只输出一个 JSON 对象，不要任何解释、不要 markdown 代码块。字段：
{
  "title_zh": "中文标题，可意译，术语保留英文，不超过 30 字",
  "verdict": "一句话结论，不超过 40 字，不要复述摘要",
  "abstract_zh": "摘要直译，200-340 字",
  "background": "研究背景：这篇在填哪个坑？前人结论或漏洞是什么？150-260 字",
  "summary": ["做了什么，≤60字", "方法，≤60字", "结论，≤70字"],
  "comment": "你的判断：卖点是否成立、实验够不够、和哪篇是一挂、值不值得读。130-220 字",
  "read_suggestion": "建议读哪几节，例如 III.2 + V.1，附录可跳过",
  "mood": "impressed | neutral | skeptical"
}"""


def call_llm(item, body, cfg, key):
    llm = cfg["llm"]
    user = f"""论文标题：{item['title']}
arXiv: {item['id']}

全文（已去除参考文献）：

{body}"""

    payload = {
        "model": llm["model"],
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": user},
        ],
        "temperature": llm.get("temperature", 0.3),
        "response_format": {"type": "json_object"},
        "max_tokens": 2000,
    }
    req = urllib.request.Request(
        llm["base_url"].rstrip("/") + "/chat/completions",
        data=json.dumps(payload).encode(),
        headers={**UA, "Content-Type": "application/json", "Authorization": f"Bearer {key}"},
    )
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=300) as r:
        resp = json.loads(r.read())

    txt = resp["choices"][0]["message"]["content"]
    txt = re.sub(r"^```(?:json)?|```$", "", txt.strip(), flags=re.M).strip()
    card = json.loads(txt)

    u = resp.get("usage") or {}
    usage = {
        "input": u.get("prompt_tokens") or ntok(user) + ntok(SYSTEM),
        "output": u.get("completion_tokens") or ntok(txt),
    }
    usage["total"] = usage["input"] + usage["output"]
    return card, usage, time.time() - t0


# ---------------------------------------------------------------- 5. 组装
def build_greeting(cards, scanned, matched):
    n = len(cards)
    lead = cards[0]["title_zh"] if cards else ""
    return (
        f"今天 astro-ph 新到 {scanned} 篇。按你的方向留下 {matched} 篇，"
        f"选了 {n} 篇给你——先看第一款：<b>{lead}</b>。"
    )


def assemble(date, items, picked, cards, usages, cfg, matched_hint=None):
    papers = []
    for item in picked:
        c = cards.get(item["id"])
        if not c:
            continue
        papers.append({
            "id": item["id"],
            "title_en": item["title"],
            "abstract_en": item.get("abstract_clean") or de_tex(item.get("abstract", "")),
            "title_zh": c.get("title_zh", item["title"]),
            "verdict": c.get("verdict", ""),
            "abstract_zh": c.get("abstract_zh", ""),
            "background": c.get("background", ""),
            "summary": c.get("summary", []),
            "comment": c.get("comment", ""),
            "read_suggestion": c.get("read_suggestion", ""),
            "mood": c.get("mood", "neutral"),
            "figures": item.get("figures", []),
        })

    usage = {
        "input": sum(u["input"] for u in usages.values()),
        "output": sum(u["output"] for u in usages.values()),
    }
    usage["total"] = usage["input"] + usage["output"]

    day = {
        "date": date,
        "label": datetime.strptime(date, "%Y-%m-%d").strftime("%m.%d %a").upper(),
        "scanned": len(items),
        "matched": matched_hint if matched_hint else len(picked),
        "greeting": build_greeting(papers, len(items), len(picked)),
        "papers": papers,
        "usage": usage,
        "model": cfg["llm"]["model"],
    }
    jdump(DATA / f"{date}.json", day)

    # index
    idx_path = DATA / "index.json"
    idx = json.loads(idx_path.read_text(encoding="utf-8")) if idx_path.exists() else {}
    idx.setdefault("days", [])
    if date in idx["days"]:
        idx["days"].remove(date)
    idx["days"].insert(0, date)
    idx["days"] = idx["days"][:60]
    idx["price"] = cfg["price"]

    hist = {h["date"]: h for h in idx.get("history", [])}
    hist[date] = {"date": date, **usage}
    idx["history"] = [hist[d] for d in sorted(hist)[-30:]]
    jdump(idx_path, idx)
    return day


def prune_figures(keep_days: int, today: str):
    """只保留最近 keep_days 天的图片目录；更早的清掉，JSON 保留。
    前端遇到 404 会显示 NO FIGURE，不影响日历浏览。"""
    if keep_days <= 0:
        return
    cutoff = datetime.strptime(today, "%Y-%m-%d").toordinal() - keep_days
    removed = 0
    idx_path = DATA / "index.json"
    if not idx_path.exists():
        return
    idx = json.loads(idx_path.read_text(encoding="utf-8"))
    for date in idx.get("days", []):
        try:
            if datetime.strptime(date, "%Y-%m-%d").toordinal() >= cutoff:
                continue
        except ValueError:
            continue
        f = DATA / f"{date}.json"
        if not f.exists():
            continue
        day = json.loads(f.read_text(encoding="utf-8"))
        for p in day.get("papers", []):
            d = FIGS / p["id"]
            if d.exists():
                shutil.rmtree(d, ignore_errors=True)
                removed += 1
    if removed:
        print(f"  清理了 {removed} 个过期图片目录（保留最近 {keep_days} 天）")


# ---------------------------------------------------------------- push
def push(day, cfg):
    p = cfg["push"]
    if not p.get("enabled") or not p.get("topic") or p["topic"] == "CHANGE_ME":
        return
    first = day["papers"][0]["title_zh"] if day["papers"] else "无新论文"
    body = f"{day['date']} · {len(day['papers'])} 篇\n{first}"
    url = f"{p['server'].rstrip('/')}/{p['topic']}"
    if p.get("url"):
        body += f"\n{p['url']}"
    req = urllib.request.Request(
        url, data=body.encode("utf-8"),
        headers={"Title": "AMADEUS 每日文献".encode("utf-8").decode("latin-1"),
                 "Tags": "books", "Click": p.get("url", "")},
    )
    try:
        urllib.request.urlopen(req, timeout=20)
        print("  推送已发送")
    except Exception as e:
        print(f"  推送失败: {e}")


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", default=datetime.now(timezone.utc).strftime("%Y-%m-%d"))
    ap.add_argument("--assemble", action="store_true", help="只用已有 cards 文件组装，不调 LLM")
    ap.add_argument("--dry-run", action="store_true", help="只抓取与排序")
    ap.add_argument("--no-push", action="store_true")
    ap.add_argument("--prune-days", type=int, default=60, help="图片只保留最近 N 天")
    args = ap.parse_args()

    cfg = load_cfg()
    date = args.date
    print(f"[{date}] AMADEUS daily pipeline")

    # 1
    print("· 抓取 RSS")
    items = fetch_rss(cfg, date)

    # 2
    print("· 相关性排序")
    fbw = build_feedback_weights()
    if fbw:
        print(f"  反馈向量：{len(fbw)} 个词（来自 feedback.json）")
    picked, n_match, n_all = select(items, cfg, fbw)
    n_matched = max(n_match, len(picked))
    print(f"  候选 {n_match} 篇，选中 {len(picked)} 篇:")
    for i, p in enumerate(picked, 1):
        print(f"   {i}. {p['id']}  {p['title'][:70]}")

    if args.dry_run:
        return

    if not picked:
        print("  今天没有匹配到论文（arXiv 周末不公告），跳过。")
        return

    cards_file = DATA / f"cards-{date}.json"
    usages = {}

    if args.assemble:
        print("· 读取已有卡片")
        raw = json.loads(cards_file.read_text(encoding="utf-8"))
        cards = {c["id"]: c for c in raw}
        # 组装模式下实测 usage：input = 正文 + 系统提示（重新取正文，只花本地 token 计数，不调 LLM）
        print("· 实测 token（拉正文计数）")
        for c in cards.values():
            try:
                body, _ = fetch_body(c["id"], cfg, cfg["llm"]["max_body_tokens"])
                tin = ntok(body or "") + ntok(SYSTEM) if body else 0
            except Exception:
                tin = 0
            tout = ntok(json.dumps(c, ensure_ascii=False))
            usages[c["id"]] = {"input": tin, "output": tout, "total": tin + tout}
            print(f"   {c['id']}  in≈{tin}  out≈{tout}")
        # 组装模式下：以 cards 文件为准决定入选与顺序
        by_id = {i["id"]: i for i in items}
        picked = []
        for c in raw:
            item = by_id.get(c["id"]) or {"id": c["id"], "title": c.get("title_en", ""),
                                           "abstract": c.get("abstract_en", ""),
                                           "link": "", "announced": date}
            figs = c.get("figures", [])
            raw_figs = [f["file"] if isinstance(f, dict) else f for f in figs]
            # 若已压缩成 webp，替换路径
            fixed = []
            for f in raw_figs:
                alt = re.sub(r"\.(png|jpg|jpeg)$", ".webp", f)
                fixed.append(alt if (PUB / alt).exists() else f)
            item["figures"] = fixed
            picked.append(item)
        print(f"  cards 里 {len(picked)} 篇")
        # matched 用排序的真实候选数，而不是入选数
        n_matched = max(select(items, cfg)[1], len(picked))
    else:
        key = os.environ.get(cfg["llm"]["api_key_env"], "")
        if not key:
            print(f"!! 缺少环境变量 {cfg['llm']['api_key_env']}，无法调用 LLM。")
            print("   改用 --assemble 走已有卡片，或在 config.json 里换 provider。")
            sys.exit(2)

        print("· 抓正文 + 图")
        bodies, cards = {}, {}
        for item in picked:
            body, figs = fetch_body(item["id"], cfg, cfg["llm"]["max_body_tokens"])
            if not body:
                print(f"   {item['id']} 无 HTML，跳过")
                continue
            nb = ntok(body)
            if nb < 3000:
                # 已知问题：arXiv 的 LaTeXML 有时会在中途的表格处截断 HTML
                print(f"   !! {item['id']} 正文只有 {nb} tok，HTML 可能被截断，结论需人工复核")
            bodies[item["id"]] = body
            item["figures"] = download_figures(item["id"], figs)
            compress_figures(item["id"])
            # 路径是相对 public/ 的（figs/<id>/x.png），压缩后要改成 .webp
            def _to_webp(f):
                alt = re.sub(r"\.(png|jpg|jpeg)$", ".webp", f)
                return alt if (PUB / alt).exists() else f
            item["figures"] = [_to_webp(f) for f in item["figures"]]
            print(f"   {item['id']}  正文 {ntok(body)} tok · 图 {len(item['figures'])}")

        print(f"· 生成卡片（{cfg['llm']['model']}）")
        def job(item):
            card, usage, secs = call_llm(item, bodies[item["id"]], cfg, key)
            print(f"   {item['id']}  done {secs:.1f}s  in={usage['input']} out={usage['output']}")
            return item["id"], card, usage

        with cf.ThreadPoolExecutor(max_workers=cfg["llm"]["concurrency"]) as ex:
            for aid, card, usage in ex.map(job, [p for p in picked if p["id"] in bodies]):
                cards[aid] = card
                usages[aid] = usage

        jdump(cards_file, [
            {"id": aid, **cards[aid],
             "figures": [{"file": f, "caption": ""} for f in next(i["figures"] for i in picked if i["id"] == aid)]}
            for aid in cards
        ])

    print("· 组装")
    day = assemble(date, items, picked, cards, usages, cfg, matched_hint=locals().get("n_matched"))
    prune_figures(args.prune_days, date)

    if not args.no_push:
        push(day, cfg)

    u = day["usage"]
    print(f"\n完成：{len(day['papers'])} 篇 · {u['total']} tokens "
          f"(in {u['input']} / out {u['output']})")


if __name__ == "__main__":
    main()
