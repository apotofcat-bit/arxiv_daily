/* ============================================================
   AMADEUS // LOCAL  —  纯本地生成引擎
   所有网络走原生桥（绕开 CORS），数据存 IndexedDB，密钥只在本机。
   ============================================================ */
(() => {
'use strict';

const DB_NAME = 'amadeus-local';
const DB_VER = 1;

/* ---------------- IndexedDB ---------------- */
let _db = null;
function db() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    // 某些环境（如 file:// 源）IndexedDB 不可用且不会报错，加超时兜底
    const timer = setTimeout(() => reject(new Error('IndexedDB 不可用')), 3000);
    let r;
    try {
      r = indexedDB.open(DB_NAME, DB_VER);
    } catch (e) {
      clearTimeout(timer); reject(e); return;
    }
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('days')) d.createObjectStore('days', { keyPath: 'date' });
      if (!d.objectStoreNames.contains('figures')) d.createObjectStore('figures');
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
    };
    r.onsuccess = () => { clearTimeout(timer); _db = r.result; resolve(_db); };
    r.onerror = () => { clearTimeout(timer); reject(r.error); };
  });
}
async function idbGet(store, key) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, 'readonly').objectStore(store).get(key);
    t.onsuccess = () => res(t.result);
    t.onerror = () => rej(t.error);
  });
}
async function idbPut(store, val, key) {
  const d = await db();
  return new Promise((res, rej) => {
    const st = d.transaction(store, 'readwrite').objectStore(store);
    const q = key === undefined ? st.put(val) : st.put(val, key);
    q.onsuccess = () => res(true);
    q.onerror = () => rej(q.error);
  });
}
async function idbDel(store, key) {
  const d = await db();
  return new Promise((res, rej) => {
    const q = d.transaction(store, 'readwrite').objectStore(store).delete(key);
    q.onsuccess = () => res(true);
    q.onerror = () => rej(q.error);
  });
}
async function idbKeys(store) {
  const d = await db();
  return new Promise((res, rej) => {
    const q = d.transaction(store, 'readonly').objectStore(store).getAllKeys();
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  });
}

/* ---------------- 设置 ---------------- */
const DEFAULT_CFG = {
  apiKey: '',
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  categories: ['astro-ph.GA'],
  interest: '',
  topN: 5,
  keepDays: 60,      // 整天保留多少天
  figPurgeDays: 30,  // 插图单独保留多少天（超期只删图，卡片文字留着）
};
let CFG = { ...DEFAULT_CFG };

async function loadCfg() {
  let v = null;
  try { v = await idbGet('kv', 'cfg'); } catch (e) { console.warn('读取设置失败', e); }
  CFG = { ...DEFAULT_CFG, ...(v || {}) };
  return CFG;
}
async function saveCfg(patch) {
  CFG = { ...CFG, ...patch };
  await idbPut('kv', CFG, 'cfg');
  return CFG;
}
function hasKey() { return !!(CFG.apiKey && CFG.apiKey.trim()); }

/* ---------------- 原生桥 ---------------- */
let seq = 0;
const pending = new Map();

window.__nativeResolve = (id, json) => {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  try { p(JSON.parse(json)); } catch (e) { p({ ok: false, error: 'bad payload' }); }
};

function nativeReq(method, url, { headers, body } = {}) {
  return new Promise((resolve, reject) => {
    const Native = window.Native;
    if (!Native || !Native.req) { reject(new Error('不在 App 内运行，原生桥不可用')); return; }
    const id = 'r' + (++seq);
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('timeout')); }, 120000);
    pending.set(id, (res) => { clearTimeout(timer); resolve(res); });
    Native.req(id, method, url, JSON.stringify(headers || {}), body || '');
  });
}

function b64ToBlob(b64, mime) {
  const bin = atob(b64);
  const len = bin.length;
  const buf = new Uint8Array(len);
  for (let i = 0; i < len; i++) buf[i] = bin.charCodeAt(i);
  return new Blob([buf], { type: mime || 'application/octet-stream' });
}

async function getText(url, headers) {
  const r = await nativeReq('GET', url, { headers });
  if (!r.ok) throw new Error('HTTP ' + (r.status || '?') + ' ' + url);
  const bin = atob(r.base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

async function getBlob(url) {
  const r = await nativeReq('GET', url);
  if (!r.ok) throw new Error('HTTP ' + (r.status || '?'));
  return b64ToBlob(r.base64);
}

/* ---------------- token 估算 ---------------- */
// cl100k 的粗略近似：中文 ≈ 1 token/字，英文 ≈ 1 token/4 字符
function ntok(s) {
  if (!s) return 0;
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  return Math.round(cjk + (s.length - cjk) / 4);
}

/* ---------------- RSS ---------------- */
async function fetchFeed(cat) {
  const url = `https://rss.arxiv.org/rss/${cat}`;
  const xml = await getText(url);
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const ch = doc.querySelector('channel');
  let pub = '';
  const pd = ch && ch.querySelector('pubDate') ? ch.querySelector('pubDate').textContent : '';
  const m = pd.match(/(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/);
  if (m) {
    const mo = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ').indexOf(m[2]) + 1;
    pub = `${m[3]}-${String(mo).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
  }
  const items = [...doc.querySelectorAll('item')].map(it => {
    const link = (it.querySelector('link')?.textContent || '').trim();
    const id = link.split('/').pop();
    const raw = it.querySelector('description')?.textContent || '';
    const abs = raw.replace(/^[\s\S]*?Abstract:\s*/, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return {
      id,
      title: (it.querySelector('title')?.textContent || '').replace(/\s+/g, ' ').trim(),
      abstract: abs,
      cat,
    };
  }).filter(x => x.id && x.title);
  return { items, pub };
}

/* ---------------- LLM ---------------- */
async function chat(messages, { json = true, maxTokens = 2000, temp = 0.3 } = {}) {
  if (!hasKey()) throw new Error('还没填 API key');
  const body = {
    model: CFG.model,
    messages,
    temperature: temp,
    max_tokens: maxTokens,
  };
  if (json) body.response_format = { type: 'json_object' };

  const r = await nativeReq('POST', CFG.baseUrl.replace(/\/$/, '') + '/chat/completions', {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + CFG.apiKey,
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    let msg = 'HTTP ' + r.status;
    try { msg += ' ' + atob(r.base64).slice(0, 200); } catch (e) {}
    throw new Error(msg);
  }
  const data = JSON.parse(atob(r.base64));
  const text = data.choices?.[0]?.message?.content || '';
  const u = data.usage || {};
  return {
    text,
    usage: {
      input: u.prompt_tokens || 0,
      output: u.completion_tokens || 0,
    },
  };
}

function parseJsonLoose(t) {
  let s = String(t).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(s); } catch (e) {}
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch (e) {} }
  const c = s.indexOf('['), d = s.lastIndexOf(']');
  if (c >= 0 && d > c) { try { return JSON.parse(s.slice(c, d + 1)); } catch (e) {} }
  throw new Error('模型返回的不是 JSON');
}

/* ---------------- 排序 ---------------- */
async function rank(pool, n) {
  const brief = pool.map((p, i) => `[${i}] ${p.title}\n${(p.abstract || '').slice(0, 320)}`).join('\n\n');
  const interest = (CFG.interest || '').trim() || '（用户未填写，按论文的通用科学价值挑选）';

  const sys = `你是一个科研文献筛选助手。用户的研究方向是：
${interest}

从候选论文里挑出与该方向最相关的 N 篇。判断标准：主题契合度 > 方法新颖度 > 影响力。
不要挑只是"听起来相关"的，要挑用户真的会读的。`;

  const user = `候选论文共 ${pool.length} 篇：

${brief}

请返回 JSON：{"picks":[{"i":索引数字,"why":"一句话理由，中文，不超过 20 字"}]}
按相关度从高到低，最多 ${n} 篇。`;

  const { text, usage } = await chat(
    [{ role: 'system', content: sys }, { role: 'user', content: user }],
    { maxTokens: 800, temp: 0.2 }
  );
  const obj = parseJsonLoose(text);
  const picks = (obj.picks || []).filter(x => Number.isInteger(x.i) && pool[x.i]);
  return { picks: picks.slice(0, n), usage };
}

/* ---------------- 正文 ---------------- */
function stripHtml(html) {
  const cut = html.search(/<h2[^>]*>\s*References\s*<\/h2>/i);
  let t = cut > 0 ? html.slice(0, cut) : html;
  t = t.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
       .replace(/<math[\s\S]*?<\/math>/gi, ' [MATH] ')
       .replace(/<[^>]+>/g, ' ')
       .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
       .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
       .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
  return t;
}

async function fetchBody(id) {
  for (const suf of ['v1', 'v2', '']) {
    try {
      const html = await getText(`https://arxiv.org/html/${id}${suf}`);
      if (!/<html|ltx_/i.test(html)) continue;
      const figs = [...html.matchAll(/<img[^>]+src="([^"]+)"/g)]
        .map(m => m[1])
        .filter(s => /\.(png|jpe?g)$/i.test(s) && !s.includes('static.arxiv.org'));
      const text = stripHtml(html);
      // 控制输入长度：约 14000 token
      let body = text;
      if (ntok(body) > 14000) {
        body = body.slice(0, Math.floor(body.length * 14000 / ntok(body)));
      }
      return { body, figs: [...new Set(figs)] };
    } catch (e) { /* 试下一个后缀 */ }
  }
  return null;
}

/* ---------------- 图片 ---------------- */
async function shrinkToWebp(blob, maxEdge = 1200, quality = 0.82) {
  try {
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    cv.getContext('2d').drawImage(bmp, 0, 0, w, h);
    const out = await new Promise(res => cv.toBlob(res, 'image/webp', quality));
    return out && out.size < blob.size ? out : blob;
  } catch (e) {
    return blob;
  }
}

async function grabFigures(id, srcs, limit = 3) {
  const out = [];
  for (const src of srcs.slice(0, limit)) {
    try {
      const url = src.startsWith('http') ? src : `https://arxiv.org/html/${src}`;
      const raw = await getBlob(url);
      if (raw.size < 3000) continue;
      const webp = await shrinkToWebp(raw);
      const name = (url.split('/').pop() || 'fig').replace(/[^A-Za-z0-9._-]/g, '_').replace(/\.(png|jpe?g)$/i, '') + '.webp';
      const key = `${id}/${name}`;
      await idbPut('figures', webp, key);
      out.push({ file: key, caption: '' });
    } catch (e) { /* 单张失败不影响 */ }
  }
  return out;
}

/* ---------------- 卡片 ---------------- */
const CARD_SYSTEM = `你是一个严谨的科研助理，为一个忙碌的研究者写每日论文卡片。
读者方向见下方 user 消息开头。

严格遵守：
1. 只使用论文原文出现的数字。绝不推算、绝不补全、绝不编造。
2. 事实与判断分开：abstract_zh / background / summary 是事实；comment / verdict 是你的判断。
3. 论文没讲清楚的地方，写「不确定」，不要猜。
4. 中文写作，术语保留英文，例如 星族 (stellar population)。
5. 语气克制、学术、有一点温度。不用感叹号，不用「必读」「炸裂」这类词。
6. comment 必须指出这篇的弱点，不能全是好话。

只输出一个 JSON 对象，不要解释、不要 markdown 代码块：
{
  "title_zh": "中文标题，不超过 30 字",
  "verdict": "一句话结论，不超过 40 字，不复述摘要",
  "abstract_zh": "摘要直译，200-340 字",
  "background": "研究背景：这篇在填哪个坑？150-260 字",
  "summary": ["做了什么，≤60字", "方法，≤60字", "结论，≤70字"],
  "comment": "判断：卖点是否成立、实验够不够、和哪篇是一挂、值不值得读。130-220 字",
  "read_suggestion": "建议读哪几节",
  "mood": "impressed | neutral | skeptical"
}`;

async function makeCard(item, body) {
  const user = `用户研究方向：${CFG.interest || '未填写'}

论文标题：${item.title}
arXiv: ${item.id}

全文（已去除参考文献）：

${body}`;
  const { text, usage } = await chat(
    [{ role: 'system', content: CARD_SYSTEM }, { role: 'user', content: user }],
    { maxTokens: 2000, temp: 0.3 }
  );
  return { card: parseJsonLoose(text), usage };
}

/* ---------------- 主流程 ---------------- */
async function runDaily(onProgress) {
  if (!hasKey()) throw new Error('先去设置里填 DeepSeek API key');
  const report = (k, msg, pct) => { try { onProgress && onProgress({ stage: k, msg, pct }); } catch (e) {} };

  const cats = (CFG.categories && CFG.categories.length) ? CFG.categories : ['astro-ph.GA'];
  report('feed', '抓取 arXiv 公告…', 4);

  let items = [], pubDates = [];
  for (const c of cats) {
    try {
      const { items: got, pub } = await fetchFeed(c);
      items = items.concat(got);
      if (pub) pubDates.push(pub);
    } catch (e) {
      console.warn('feed 失败', c, e);
    }
  }
  const seen = new Set();
  items = items.filter(x => (seen.has(x.id) ? false : (seen.add(x.id), true)));
  if (!items.length) throw new Error('没抓到任何论文，检查网络或分类');

  const date = pubDates.sort().pop() || new Date().toISOString().slice(0, 10);
  const exists = await idbGet('days', date);
  if (exists) return { skipped: true, date, reason: '这一天已经生成过' };

  report('rank', `共 ${items.length} 篇，正在筛选…`, 12);
  const pool = items.slice(0, 60);
  const { picks, usage: uRank } = await rank(pool, CFG.topN || 5);

  const usage = { input: uRank.input, output: uRank.output };
  const papers = [];
  for (let k = 0; k < picks.length; k++) {
    const it = pool[picks[k].i];
    if (!it) continue;
    const pct = 20 + Math.round((k / picks.length) * 70);
    report('body', `[${k + 1}/${picks.length}] 读取正文 ${it.id}`, pct);
    const got = await fetchBody(it.id);
    if (!got) continue;

    report('fig', `[${k + 1}/${picks.length}] 下载插图`, pct + 4);
    const figures = await grabFigures(it.id, got.figs);

    report('card', `[${k + 1}/${picks.length}] 写卡片 ${it.id}`, pct + 8);
    let res;
    try {
      res = await makeCard(it, got.body);
    } catch (e) {
      console.warn('卡片失败', it.id, e);
      continue;
    }
    usage.input += res.usage.input;
    usage.output += res.usage.output;
    const c = res.card;
    papers.push({
      id: it.id,
      title_en: it.title,
      title_zh: c.title_zh || it.title,
      abstract_en: it.abstract,
      verdict: c.verdict || '',
      abstract_zh: c.abstract_zh || '',
      background: c.background || '',
      summary: c.summary || [],
      comment: c.comment || '',
      read_suggestion: c.read_suggestion || '',
      mood: c.mood || 'neutral',
      figures,
      why: picks[k].why || '',
    });
  }

  if (!papers.length) throw new Error('全部论文处理失败');

  usage.total = usage.input + usage.output;
  const day = {
    date,
    label: date.slice(5).replace('-', '.'),
    scanned: items.length,
    matched: papers.length,
    local: true,
    greeting: `今天 ${cats.join(' / ')} 共 ${items.length} 篇，按你的方向选了 ${papers.length} 篇。`,
    papers,
    usage,
    model: CFG.model,
  };
  await idbPut('days', day, date);
  report('done', `完成：${papers.length} 篇 · ${usage.total} tokens`, 100);
  await prune();
  return day;
}

/* ---------------- 维护 ---------------- */
async function prune() {
  const keep = CFG.keepDays || 60;
  const figKeep = Math.min(CFG.figPurgeDays || 30, keep);
  const keys = (await idbKeys('days')).sort().reverse();   // 新 -> 旧

  // ① 超出「整天保留」的直接删掉（含图）
  const drop = keys.slice(keep);
  for (const d of drop) {
    const day = await idbGet('days', d);
    for (const p of (day && day.papers) || []) {
      for (const f of p.figures || []) await idbDel('figures', f.file).catch(() => {});
    }
    await idbDel('days', d).catch(() => {});
  }

  // ② 在「整天保留」之内、但超出「插图保留」的：只删图，卡片留着
  const strip = keys.slice(figKeep, keep);
  let purged = 0;
  for (const d of strip) {
    const day = await idbGet('days', d);
    if (!day || day.figsPurged) continue;
    for (const p of day.papers || []) {
      for (const f of p.figures || []) {
        await idbDel('figures', f.file).catch(() => {});
        purged++;
      }
      p.figures = [];       // 界面上会显示 NO FIGURE
    }
    day.figsPurged = true;
    await idbPut('days', day, d);
  }
  if (drop.length || purged) {
    console.info(`[prune] 删除 ${drop.length} 天，清理 ${purged} 张过期插图`);
  }
  return { days: drop.length, figures: purged };
}

async function listDays() { return (await idbKeys('days')).sort().reverse(); }
async function getDay(date) { return await idbGet('days', date); }

async function figureURL(key) {
  const b = await idbGet('figures', key);
  return b ? URL.createObjectURL(b) : '';
}

async function usageStats() {
  const days = await listDays();
  const hist = [];
  for (const d of days.slice(0, 30)) {
    const day = await idbGet('days', d);
    if (day && day.usage) hist.push({ date: d, ...day.usage });
  }
  return hist;
}

async function clearAll() {
  const days = await listDays();
  for (const d of days) {
    const day = await idbGet('days', d);
    for (const p of (day && day.papers) || []) {
      for (const f of p.figures || []) await idbDel('figures', f.file).catch(() => {});
    }
    await idbDel('days', d).catch(() => {});
  }
}

window.LocalEngine = {
  loadCfg, saveCfg, hasKey, getCfg: () => CFG,
  runDaily, listDays, getDay, figureURL, usageStats, clearAll,
  estimateTokens: ntok,
};
})();
