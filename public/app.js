/* ============================================================
   AMADEUS // DAILY  —  app.js
   路由:
     #/              最新一天
     #/d/<date>      指定日期列表
     #/d/<date>/<id> 论文详情
     #/cal           日历 / 归档
     #/stats         token 统计
   ============================================================ */
(() => {
'use strict';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, txt) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
};

const NOTES_KEY = 'amadeus.notes.v1';
let BASE = '';                 // '' = 包内快照；否则为远程前缀
const REMOTE_TIMEOUT = 4000;

const state = {
  index: null,
  day: null,
  date: null,
  papers: [],
  dayCache: {},
  l2d: null,
  l2dLoading: false,
  noteTimer: null,
  calCursor: null,
};

/* ---------------- 小工具 ---------------- */
const fmtTokens = (n) => n == null ? '--' : (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n));
const pad2 = (n) => String(n).padStart(2, '0');
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
function clock() { const d = new Date(); $('clock').textContent = pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }

/* ---------------- 批注存储 ---------------- */
function loadNotes() {
  try { return JSON.parse(localStorage.getItem(NOTES_KEY) || '{}') || {}; } catch (e) { return {}; }
}
function writeNotes(obj) {
  try { localStorage.setItem(NOTES_KEY, JSON.stringify(obj)); return true; } catch (e) { return false; }
}
function getNote(id) { const n = loadNotes()[id]; return n ? n.text : ''; }
function setNote(id, text) {
  const all = loadNotes();
  if (text && text.trim()) all[id] = { text, updated: Date.now() };
  else delete all[id];
  return writeNotes(all);
}

/* ---------------- 数据 ---------------- */
async function resolveBase() {
  const rb = (window.REMOTE_BASE || '').trim();
  BASE = '';
  if (!rb) return;
  // 同源就是自己，不用探测
  if (rb.startsWith(location.origin)) return;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), REMOTE_TIMEOUT);
    const r = await fetch(rb + 'data/index.json', { cache: 'no-store', signal: ctl.signal });
    clearTimeout(timer);
    if (r.ok) { BASE = rb; console.info('[amadeus] 远程数据源', rb); }
  } catch (e) {
    console.info('[amadeus] 远程不可达，使用内置快照');
  }
}

async function loadIndex() {
  try {
    const r = await fetch(BASE + 'data/index.json', { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status);
    return await r.json();
  } catch (e) { console.warn('index.json 失败', e); return { days: [] }; }
}
async function getDay(date) {
  if (state.dayCache[date]) return state.dayCache[date];
  let d = null, usedBase = '';
  for (const base of BASE ? [BASE, ''] : ['']) {
    try {
      const r = await fetch(`${base}data/${date}.json`, { cache: 'no-store' });
      if (r.ok) { d = await r.json(); usedBase = base; break; }
    } catch (e) { /* 试下一个 */ }
  }
  if (!d) throw new Error('day ' + date + ' 不存在');
  d._base = usedBase;
  d.papers.forEach(p => {
    p.figures = (p.figures || []).map(f =>
      typeof f === 'string' ? { file: f, caption: '' } : { file: f.file, caption: f.caption || '' });
  });
  state.dayCache[date] = d;
  return d;
}

function baseOf(p) {
  const d = state.day;
  return (d && d._base) || '';
}

/* ---------------- 路由 ---------------- */
function route() {
  const h = location.hash.replace(/^#\/?/, '');
  const parts = h.split('/').filter(Boolean);
  if (parts[0] === 'cal') return showCal();
  if (parts[0] === 'stats') return showStats();
  if (parts[0] === 'd' && parts[1]) {
    return parts[2] ? showDetail(parts[1], parts[2]) : showList(parts[1]);
  }
  return showList(null);
}
function hideAll() { ['view-list', 'view-detail', 'view-cal', 'view-stats'].forEach(v => { $(v).hidden = true; }); }

/* ---------------- 列表 ---------------- */
async function showList(date) {
  hideAll();
  $('view-list').hidden = false;
  $('brandTag').textContent = 'DAILY';
  document.title = 'AMADEUS · 每日文献';

  const latest = (state.index && state.index.days && state.index.days[0]) || null;
  const target = date || latest;
  if (!target) { renderEmptyList('NO DATA', '还没有数据。先跑 pipeline/run.py'); return; }

  if (state.date !== target) {
    try {
      state.day = await getDay(target);
      state.date = target;
      state.papers = state.day.papers || [];
    } catch (e) { renderEmptyList('NO DATA', `${target} 没有数据`); return; }
  }
  renderList();
}

function renderEmptyList(big, msg) {
  $('kScanned').textContent = '--'; $('kMatched').textContent = '--'; $('kToday').textContent = '--';
  $('greeting').textContent = '—'; $('chipSync').textContent = '—'; $('listSec').textContent = 'TODAY';
  $('list').innerHTML = `<div class="empty"><div class="big">${esc(big)}</div>${esc(msg)}</div>`;
}

function renderList() {
  const d = state.day;
  if (!d) return;
  const isLatest = state.index && state.index.days && state.index.days[0] === d.date;

  $('kScanned').textContent = pad2(d.scanned ?? 0);
  $('kMatched').textContent = pad2(d.matched ?? 0);
  $('kToday').textContent = pad2(d.papers.length);
  $('greeting').innerHTML = d.greeting || '—';
  $('chipSync').textContent = d.date;
  $('listSec').textContent = isLatest ? 'TODAY' : d.date;
  setTokenChips(d.usage);

  const notes = loadNotes();
  const list = $('list');
  list.innerHTML = '';

  if (!isLatest) {
    const back = el('a', 'backrow', '← 回到最新');
    back.href = '#/';
    list.appendChild(back);
  }

  d.papers.forEach((p, i) => {
    const a = el('a', 'en');
    a.href = `#/d/${d.date}/${p.id}`;
    a.appendChild(el('div', 'no', pad2(i + 1)));

    const th = el('div', 'th');
    if (p.figures.length) {
      const img = new Image();
      img.alt = ''; img.loading = 'lazy';
      img.onerror = () => { th.innerHTML = ''; th.appendChild(el('span', 'nofig', 'NO FIG')); };
      img.src = baseOf(p) + p.figures[0].file;
      th.appendChild(img);
    } else {
      th.appendChild(el('span', 'nofig', 'NO FIG'));
    }

    const tx = el('div', 'tx');
    tx.appendChild(el('div', 'zh', p.title_zh || p.title_en));
    tx.appendChild(el('div', 'vd', p.verdict || ''));
    const meta = el('div', 'm', `${p.id} · ${p.mood || ''}`);
    if (notes[p.id]) meta.appendChild(el('span', 'mark', '✎'));
    tx.appendChild(meta);

    a.appendChild(th); a.appendChild(tx);
    list.appendChild(a);
  });
}

/* ---------------- 详情 ---------------- */
async function showDetail(date, id) {
  hideAll();
  $('view-detail').hidden = false;
  $('brandTag').textContent = 'READING';

  if (state.date !== date) {
    try {
      state.day = await getDay(date);
      state.date = date;
      state.papers = state.day.papers || [];
    } catch (e) { location.hash = '#/'; return; }
  }

  const idx = state.papers.findIndex(p => p.id === id);
  if (idx < 0) { location.hash = `#/d/${date}`; return; }
  const p = state.papers[idx];

  const latest = state.index && state.index.days && state.index.days[0] === date;
  const back = $('dBack');
  back.href = latest ? '#/' : `#/d/${date}`;
  back.textContent = latest ? '← TODAY' : '← ' + date;

  $('dIndex').textContent = pad2(idx + 1) + ' / ' + pad2(state.papers.length);
  $('dTitle').textContent = p.title_zh || p.title_en;
  $('dTitleEn').textContent = p.title_en || '';
  $('dMeta').textContent = [date, 'astro-ph.GA', 'arXiv:' + p.id].join(' · ');
  $('dSub').textContent = p.verdict || '';
  $('dComment').textContent = p.comment || '';
  $('dAbstract').textContent = p.abstract_zh || '';
  $('dAbstractEn').textContent = p.abstract_en || '（这篇文章没有抓到英文摘要）';
  $('dOrigWrap').open = false;
  $('dBackground').textContent = p.background || '';
  $('dRead').textContent = p.read_suggestion || '';

  const ul = $('dSummary'); ul.innerHTML = '';
  (p.summary || []).forEach(s => ul.appendChild(el('li', null, s)));

  const wrap = $('dFigWrap'); wrap.innerHTML = '';
  if (p.figures.length) {
    const img = new Image();
    img.alt = '';
    img.onerror = () => { wrap.innerHTML = '<div class="nofig">NO FIGURE</div>'; };
    img.src = baseOf(p) + p.figures[0].file;
    img.onclick = () => openViewer(p, 0);
    wrap.appendChild(img);
    wrap.appendChild(el('span', 'tag2', p.figures[0].caption || 'FIG 1'));
  } else {
    wrap.appendChild(el('div', 'nofig', 'NO FIGURE'));
  }

  const th = $('dThumbs'); th.innerHTML = '';
  p.figures.slice(1).forEach((f, i) => {
    const img = new Image(); img.alt = ''; img.loading = 'lazy';
    img.src = baseOf(p) + f.file; img.title = f.caption || '';
    img.onclick = () => openViewer(p, i + 1);
    th.appendChild(img);
  });

  $('dArxiv').href = 'https://arxiv.org/abs/' + p.id;
  setTokenChips(state.day && state.day.usage);

  const ta = $('dNote');
  ta.value = getNote(p.id);
  ta.oninput = () => {
    $('dNoteStatus').textContent = '编辑中…';
    clearTimeout(state.noteTimer);
    state.noteTimer = setTimeout(() => {
      const ok = setNote(p.id, ta.value);
      $('dNoteStatus').textContent = ok
        ? '已保存 ' + new Date().toTimeString().slice(0, 5) + (ta.value.trim() ? '' : '（已清空）')
        : '保存失败：存储不可用';
    }, 500);
  };
  $('dNoteStatus').textContent = ta.value.trim() ? '已保存' : '—';

  $('dMood').textContent = p.mood || 'neutral';
  initLive2D(p.mood);
  $('detailScroll').scrollTop = 0;
}

/* ---------------- Live2D ---------------- */
const MOOD_EXPR = { impressed: 'Stanby Smile', neutral: 'Stanby Surprised', skeptical: 'Stanby Angry' };

async function initLive2D(mood) {
  if (!window.PIXI || !PIXI.live2d) { $('l2dLoading').textContent = 'LIVE2D\n不可用'; return; }
  if (!state.l2d) {
    if (state.l2dLoading) return;
    state.l2dLoading = true;
    try {
      const host = $('l2dHost');
      const W = host.clientWidth || 142, H = host.clientHeight || 200;
      const app = new PIXI.Application({
        width: W, height: H, backgroundAlpha: 0, antialias: true, autoStart: true,
        resolution: Math.min(window.devicePixelRatio || 1, 2),
      });
      host.insertBefore(app.view, host.firstChild);
      const model = await PIXI.live2d.Live2DModel.from('model/Kurisu.model3.json');
      app.stage.addChild(model);

      // 半身取景：发顶 y≈1.2% / 下巴 21% / 肩线 31.5% / 面中线 x≈50%
      const MW = model.width, MH = model.height;
      const cropTop = 0.012 * MH, cropBottom = 0.315 * MH;
      const s = H / (cropBottom - cropTop);
      model.scale.set(s);
      model.x = W / 2 - 0.50 * MW * s;
      model.y = -cropTop * s;

      try { model.motion('Idle'); } catch (e) {}
      state.l2d = { app, model };
      const ld = $('l2dLoading'); if (ld) ld.remove();
    } catch (e) {
      console.warn('Live2D 失败', e);
      $('l2dLoading').innerHTML = 'LIVE2D<br>加载失败';
      state.l2dLoading = false;
      return;
    }
    state.l2dLoading = false;
  }
  applyMood(mood);
}
function applyMood(mood) {
  const m = state.l2d && state.l2d.model;
  if (!m) return;
  try { m.expression(MOOD_EXPR[mood] || MOOD_EXPR.neutral); } catch (e) {}
}

/* ---------------- Token ---------------- */
function setTokenChips(usage) {
  const t = usage ? (usage.total ?? ((usage.input || 0) + (usage.output || 0))) : null;
  const s = fmtTokens(t) + ' TOKENS';
  $('chipTok').textContent = s;
  $('chipTok2').textContent = s;
}

function showStats() {
  hideAll();
  $('view-stats').hidden = false;
  $('brandTag').textContent = 'USAGE';

  const u = (state.day && state.day.usage) || { input: 0, output: 0, total: 0 };
  $('sIn').textContent = fmtTokens(u.input);
  $('sOut').textContent = fmtTokens(u.output);
  $('sTot').textContent = fmtTokens(u.total ?? (u.input + u.output));

  const bars = $('sBars'); bars.innerHTML = '';
  const hist = (state.index && state.index.history) || [];
  const rows = hist.length ? hist : [{ date: todayISO(), input: u.input || 0, output: u.output || 0 }];
  const max = Math.max(...rows.map(r => (r.input || 0) + (r.output || 0)), 1);
  rows.slice(-7).forEach(r => {
    const row = el('div', 'r');
    row.appendChild(el('div', 'lb', (r.date || '').slice(5)));
    const tr = el('div', 'tr');
    const i = el('div', 'i'); i.style.width = ((r.input || 0) / max * 100) + '%';
    const o = el('div', 'o'); o.style.width = ((r.output || 0) / max * 100) + '%';
    tr.appendChild(i); tr.appendChild(o);
    row.appendChild(tr);
    row.appendChild(el('div', 'vv', fmtTokens((r.input || 0) + (r.output || 0))));
    bars.appendChild(row);
  });

  const price = (state.index && state.index.price) || { input_per_m: 0.27, output_per_m: 1.1, symbol: '$' };
  const cost = ((u.input || 0) / 1e6) * price.input_per_m + ((u.output || 0) / 1e6) * price.output_per_m;
  $('sCost').innerHTML = `按 <em>${price.symbol}${price.input_per_m}/M in · ${price.symbol}${price.output_per_m}/M out</em> 计：
    今日约 <em>${price.symbol}${cost.toFixed(4)}</em>，折合一个月 ≈ <em>${price.symbol}${(cost * 30).toFixed(2)}</em>。`;
}

/* ---------------- 日历 ---------------- */
function showCal() {
  hideAll();
  $('view-cal').hidden = false;
  $('brandTag').textContent = 'ARCHIVE';
  renderCal();
}

function renderCal() {
  const days = (state.index && state.index.days) || [];
  const daySet = new Set(days);
  const notes = loadNotes();

  if (!state.calCursor) {
    const base = days[0] || todayISO();
    const p = base.split('-').map(Number);
    state.calCursor = { y: p[0], m: p[1] };
  }
  const { y, m } = state.calCursor;

  $('calTitle').textContent = `${y} 年 ${m} 月`;
  $('chipDays').textContent = days.length + ' DAYS';

  const grid = $('calGrid'); grid.innerHTML = '';
  const first = new Date(y, m - 1, 1);
  const startDow = (first.getDay() + 6) % 7;
  const dim = new Date(y, m, 0).getDate();

  for (let i = 0; i < startDow; i++) grid.appendChild(el('div', 'calcell blank'));

  for (let d = 1; d <= dim; d++) {
    const iso = `${y}-${pad2(m)}-${pad2(d)}`;
    const cell = el('div', 'calcell');
    cell.appendChild(el('span', 'num', String(d)));
    if (daySet.has(iso)) {
      cell.classList.add('has');
      cell.onclick = () => { location.hash = `#/d/${iso}`; };
      const cached = state.dayCache[iso];
      if (cached && cached.papers.some(p => notes[p.id])) cell.appendChild(el('s', 'dot'));
      else if (iso === state.date) {
        if (state.papers.some(p => notes[p.id])) cell.appendChild(el('s', 'dot'));
      }
    } else {
      cell.classList.add('none');
    }
    grid.appendChild(cell);
  }

  const n = Object.keys(notes).length;
  $('calStats').textContent = `共 ${days.length} 天有内容，${n} 条批注。`
    + (days.length ? ` 最早 ${days[days.length - 1]}，最新 ${days[0]}。` : '');
}

/* ---------------- 导入导出 ---------------- */
function bindIO() {
  const box = $('ioBox');
  const st = $('ioStatus');

  $('btnExport').onclick = async () => {
    const payload = JSON.stringify({ version: 1, exported: new Date().toISOString(), notes: loadNotes() }, null, 2);
    try {
      await navigator.clipboard.writeText(payload);
      st.textContent = '已复制到剪贴板（' + Object.keys(loadNotes()).length + ' 条）';
    } catch (e) {
      box.hidden = false; box.value = payload; box.select();
      st.textContent = '剪贴板不可用，已放进下方文本框，手动复制';
    }
  };
  $('btnShowJson').onclick = () => {
    box.hidden = false;
    box.value = JSON.stringify({ version: 1, notes: loadNotes() }, null, 2);
    box.select();
    st.textContent = '长按可复制';
  };
  $('btnImport').onclick = () => {
    if (box.hidden) { box.hidden = false; box.value = ''; box.focus(); st.textContent = '粘贴 JSON 后再次点「从文本导入」'; return; }
    try {
      const obj = JSON.parse(box.value);
      const src = obj.notes || obj;
      if (typeof src !== 'object' || src === null) throw new Error('格式不对');
      const merged = Object.assign({}, loadNotes(), src);
      writeNotes(merged);
      st.textContent = '已导入，共 ' + Object.keys(merged).length + ' 条';
      renderCal();
    } catch (e) {
      st.textContent = '解析失败：' + e.message;
    }
  };
}


/* ---------------- 图片查看器 ---------------- */
const V = { paper: null, i: 0, open: false, scale: 1, tx: 0, ty: 0,
            sx: 0, sy: 0, ox: 0, oy: 0, moved: false, downAt: 0, lastTap: 0 };

function openViewer(paper, index) {
  if (!paper.figures || !paper.figures.length) return;
  V.paper = paper;
  V.i = Math.max(0, Math.min(index, paper.figures.length - 1));
  V.open = true;
  $('viewer').hidden = false;
  renderViewer();
}

function closeViewer() {
  V.open = false;
  $('viewer').hidden = true;
  resetZoom();
}

function renderViewer() {
  const figs = V.paper.figures;
  const f = figs[V.i];
  const img = $('vImg');
  img.style.opacity = '0';
  const n = new Image();
  n.onload = () => { $('vImg').src = n.src; $('vImg').style.opacity = '1'; };
  n.onerror = () => { $('vImg').src = n.src; $('vImg').style.opacity = '1'; };
  n.src = baseOf(V.paper) + f.file;

  $('vCount').textContent = (V.i + 1) + ' / ' + figs.length;
  $('vCap').textContent = f.caption || ('图 ' + (V.i + 1));

  const th = $('vThumbs');
  th.innerHTML = '';
  figs.forEach((g, i) => {
    const t = new Image();
    t.src = baseOf(V.paper) + g.file;
    t.className = i === V.i ? 'on' : '';
    t.onclick = (e) => { e.stopPropagation(); V.i = i; renderViewer(); };
    th.appendChild(t);
  });
  resetZoom();
  preloadNeighbours();
}

function preloadNeighbours() {
  const figs = V.paper.figures;
  [V.i - 1, V.i + 1].forEach(k => {
    if (figs[k]) { const im = new Image(); im.src = baseOf(V.paper) + figs[k].file; }
  });
}

function step(d) {
  const n = V.paper.figures.length;
  V.i = (V.i + d + n) % n;
  renderViewer();
}

function applyTransform() {
  $('vImg').style.transform = `translate(${V.tx}px, ${V.ty}px) scale(${V.scale})`;
}
function resetZoom() { V.scale = 1; V.tx = 0; V.ty = 0; applyTransform(); }

function bindViewer() {
  const stage = $('vStage');

  $('vClose').onclick = closeViewer;
  $('viewer').onclick = (e) => { if (e.target.id === 'viewer') closeViewer(); };

  stage.addEventListener('pointerdown', (e) => {
    V.dragging = true; V.moved = false;
    V.sx = e.clientX; V.sy = e.clientY;
    V.ox = V.tx; V.oy = V.ty;
    V.downAt = Date.now();
    stage.setPointerCapture(e.pointerId);
  });

  stage.addEventListener('pointermove', (e) => {
    if (!V.dragging) return;
    const dx = e.clientX - V.sx, dy = e.clientY - V.sy;
    if (Math.abs(dx) > 6 || Math.abs(dy) > 6) V.moved = true;
    if (V.scale > 1) {
      V.tx = V.ox + dx; V.ty = V.oy + dy;
      applyTransform();
    }
  });

  stage.addEventListener('pointerup', (e) => {
    if (!V.dragging) return;
    V.dragging = false;
    const dx = e.clientX - V.sx, dy = e.clientY - V.sy;
    const dt = Date.now() - V.downAt;

    if (V.scale > 1) return;                 // 放大状态下不翻页

    if (!V.moved && dt < 260) {              // 轻点：判断双击
      const now = Date.now();
      if (now - V.lastTap < 320) {
        V.scale = 2.2;
        const r = stage.getBoundingClientRect();
        V.tx = -(e.clientX - r.left - r.width / 2) * 1.2;
        V.ty = -(e.clientY - r.top - r.height / 2) * 1.2;
        applyTransform();
        V.lastTap = 0;
        return;
      }
      V.lastTap = now;
      return;
    }
    if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy)) step(dx < 0 ? 1 : -1);
  });

  window.addEventListener('keydown', (e) => {
    if (!V.open) return;
    if (e.key === 'Escape') closeViewer();
    if (e.key === 'ArrowRight') step(1);
    if (e.key === 'ArrowLeft') step(-1);
  });
}

/* ---------------- 启动 ---------------- */
async function boot() {
  clock(); setInterval(clock, 30000);

  const isAppShell = location.host.includes('appassets');
  if (isAppShell) document.body.classList.add('in-app');
  if ('serviceWorker' in navigator && location.protocol === 'https:' && !isAppShell) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  await resolveBase();
  state.index = await loadIndex();
  bindIO();
  bindViewer();

  window.addEventListener('hashchange', route);
  await route();
}

boot();
})();
