// snapidocs.com: unofficial API browser for ServiceNow. Static, no build step: reads the JSON written by scripts/build-data.mjs.

const GROUPS = [
  ['server-scoped', 'Server Scoped', 'Scoped'],
  ['server-global', 'Server Global', 'Global'],
  ['client', 'Client', 'Client'],
  ['rest', 'REST', 'REST'],
];
const GROUP_IDS = GROUPS.map((g) => g[0]);
const SHORT = Object.fromEntries(GROUPS.map((g) => [g[0], g[2]]));
const MAX_RESULTS = 60;

const el = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

const state = { releases: [], family: null, group: 'server-scoped', index: null, apiKey: null, token: 0, listSig: '' };
const indexCache = new Map();
const detailCache = new Map();

const hashFor = (family, group, key, anchor) =>
  '#/' + [family, group, key, anchor].filter((p) => p != null && p !== '').map(encodeURIComponent).join('/');

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} loading ${url}`);
  return res.json();
}

async function loadIndex(family) {
  if (!indexCache.has(family)) {
    const raw = await getJson(`data/${family}/index.json`);
    const byId = new Map();
    const byName = new Map(); // class name -> APIs, for linking parameter and return types
    for (const a of raw.apis) {
      a.ln = a.n.toLowerCase();
      a.ls = (a.s || '').toLowerCase();
      a.ini = a.n.replace(/[^A-Z]/g, '').toLowerCase();
      a.m = a.m.map(([n, sig, s, anchor, kind]) => ({ n, sig, s, anchor, kind, ln: n.toLowerCase(), lsig: sig.toLowerCase() }));
      byId.set(a.id, a);
      if (!a.g.includes('rest')) (byName.get(a.n) || byName.set(a.n, []).get(a.n)).push(a);
    }
    raw.byId = byId;
    raw.byName = byName;
    indexCache.set(family, raw);
  }
  return indexCache.get(family);
}

function loadDetail(family, id) {
  const k = `${family}/${id}`;
  if (!detailCache.has(k)) detailCache.set(k, getJson(`data/${family}/api/${encodeURIComponent(id)}.json`));
  return detailCache.get(k);
}

const findApi = (index, group, key) => index.apis.find((a) => a.k === key && a.g.includes(group));
const groupOf = (api) => (api.g.includes(state.group) ? state.group : api.g[0]);
const badges = (api) => api.g.map((g) => `<span class="badge b-${g}">${SHORT[g]}</span>`).join('') + (api.d ? '<span class="badge b-dep">Deprecated</span>' : '');

// ---------- favourites ----------
// Kept in this browser's localStorage as [{ g: group, k: key, n: name, id: api id, r: release it was added in }].

const favs = { list: [], version: 0, removed: [], checked: null };
const MAX_FAVS = 200;

/** Reads the saved list, discarding anything that is not a well-formed favourite. */
function readFavs() {
  let raw;
  try { raw = JSON.parse(store.get('favs') || '[]'); } catch { raw = []; }
  const seen = new Set();
  favs.list = (Array.isArray(raw) ? raw : [])
    .filter((f) => f && typeof f.k === 'string' && f.k && typeof f.n === 'string' && GROUP_IDS.includes(f.g))
    .map((f) => ({ g: f.g, k: f.k, n: f.n, id: typeof f.id === 'string' ? f.id : '', r: typeof f.r === 'string' ? f.r : '' }))
    .filter((f) => !seen.has(`${f.g}/${f.k}`) && seen.add(`${f.g}/${f.k}`))
    .slice(0, MAX_FAVS);
  favs.version++;
}

function saveFavs() {
  store.set('favs', JSON.stringify(favs.list));
  favs.version++;
}

const isFav = (g, k) => favs.list.some((f) => f.g === g && f.k === k);

function toggleFav(g, k) {
  const i = favs.list.findIndex((f) => f.g === g && f.k === k);
  if (i >= 0) favs.list.splice(i, 1);
  else {
    const api = findApi(state.index, g, k);
    if (!api || favs.list.length >= MAX_FAVS) return;
    favs.list.push({ g, k: api.k, n: api.n, id: api.id, r: state.family });
    favs.list.sort((a, b) => a.n.localeCompare(b.n) || GROUP_IDS.indexOf(a.g) - GROUP_IDS.indexOf(b.g));
  }
  saveFavs();
  refreshFavUi();
}

/** Redraws everything that shows favourites: sidebar section, the star on the open API, the overview list. */
function refreshFavUi() {
  renderList();
  const star = el('main').querySelector('button.star');
  if (star) star.outerHTML = starButton(state.group, state.apiKey);
  else if (!state.apiKey && state.index) renderOverview();
}

function starButton(g, k) {
  const on = isFav(g, k);
  const api = findApi(state.index, g, k);
  return `<button class="star" type="button" aria-pressed="${on}" title="${on ? 'Remove from favourites' : 'Add to favourites'}" aria-label="${on ? 'Remove' : 'Add'} ${esc(api?.n || k)} ${on ? 'from' : 'to'} favourites">${on ? '&#9733;' : '&#9734;'}</button>`;
}

/**
 * Checks saved favourites against the data. One that was renamed upstream (same id, new key) is repaired.
 * One that is missing from the release being viewed is kept as long as it still exists in the latest release
 * or in the release it was added in; otherwise it is removed and reported. Returns true if anything changed.
 */
async function validateFavs(index, family) {
  const locate = (ix, f) => {
    if (findApi(ix, f.g, f.k)) return f;
    const a = f.id && ix.byId.get(f.id);
    return a && a.g.includes(f.g) ? { ...f, k: a.k, n: a.n } : null;
  };
  const latest = (state.releases.find((r) => r.latest) || state.releases[0]).family;
  const out = [];
  const removed = [];
  let changed = false;
  for (const f of favs.list) {
    let hit = locate(index, f);
    for (const fam of [latest, f.r]) {
      if (hit || !fam || fam === family || !state.releases.some((r) => r.family === fam)) continue;
      try { hit = locate(await loadIndex(fam), f); } catch { hit = f; } // could not check: keep it
    }
    if (!hit) { removed.push(f.n); changed = true; continue; }
    if (hit !== f) changed = true;
    if (out.some((o) => o.g === hit.g && o.k === hit.k)) { changed = true; continue; }
    out.push(hit);
  }
  if (!changed) return false;
  favs.list = out;
  favs.removed.push(...removed);
  saveFavs();
  return true;
}

// ---------- type links ----------

// Names that appear as a type but mean the data format, not the documented class.
const TYPE_SKIP = new Set(['JSON']);

/** The API a type name refers to, preferring the tab being viewed, then the other Server tab, then Client. */
function typeTarget(name) {
  if (TYPE_SKIP.has(name)) return null;
  const list = state.index?.byName.get(name);
  if (!list) return null;
  const g = state.group;
  const order = g === 'client' ? ['client'] : g === 'server-global' ? ['server-global', 'server-scoped', 'client'] : ['server-scoped', 'server-global', 'client'];
  for (const group of order) {
    const api = list.find((a) => a.g.includes(group));
    if (api) return api.k === state.apiKey && group === g ? null : { api, group };
  }
  return null;
}

/** Escapes a type string and links every identifier in it that is a documented API. */
function linkTypes(text) {
  if (state.group === 'rest') return esc(text);
  let out = '';
  let last = 0;
  for (const m of String(text ?? '').matchAll(/[A-Za-z_$][\w$]*/g)) {
    const t = typeTarget(m[0]);
    if (!t) continue;
    out += esc(text.slice(last, m.index));
    out += `<a class="tlink" href="${hashFor(state.family, t.group, t.api.k)}" title="${esc(t.api.n)} (${SHORT[t.group]})">${esc(m[0])}</a>`;
    last = m.index + m[0].length;
  }
  return out + esc(String(text ?? '').slice(last));
}

// ---------- search ----------

function nameScore(name, initials, q) {
  if (name === q) return 1000;
  if (name.startsWith(q)) return 700;
  if (initials && initials === q) return 650;
  if (name.includes(q)) return 400;
  if (initials && q.length > 1 && initials.startsWith(q)) return 300;
  return 0;
}

function search(query) {
  const q = query.trim().toLowerCase().replace(/\(.*$/, '');
  if (!q || !state.index) return [];
  // "GlideRecord.addQuery", "GlideRecord addQ", "gr#get" -> class part + member part
  const split = q.match(/^([^\s.#/]+)[\s.#]+(\S.*)$/);
  const cq = split?.[1];
  const mq = split?.[2];
  const out = [];
  for (const api of state.index.apis) {
    const here = api.g.includes(state.group) ? 30 : 0;
    const cs = nameScore(api.ln, api.ini, q);
    // An API whose name starts with the whole query outranks class.member interpretations ("Table API").
    if (cs) out.push({ api, score: cs + (cs >= 700 ? 3000 : 300) + here - api.ln.length * 0.1 });
    else if (q.length > 2 && api.ls.includes(q)) out.push({ api, score: 80 + here });
    const ccs = cq ? nameScore(api.ln, api.ini, cq) : 0;
    for (const mem of api.m) {
      let sc = 0;
      if (ccs) {
        const ms = nameScore(mem.ln, '', mq);
        if (ms) sc = 2000 + ccs + ms;
      }
      if (!sc) sc = nameScore(mem.ln, '', q) || (q.length > 3 && mem.lsig.includes(q) ? 60 : 0);
      if (sc) out.push({ api, mem, score: sc + here - mem.ln.length * 0.1 - (api.d ? 50 : 0) });
    }
  }
  out.sort((a, b) => b.score - a.score || a.api.ln.localeCompare(b.api.ln));
  return out.slice(0, MAX_RESULTS);
}

let active = -1;
function renderResults() {
  const box = el('results');
  const q = el('q').value;
  if (!q.trim()) return void (box.hidden = true);
  const hits = search(q);
  active = hits.length ? 0 : -1;
  box.innerHTML = hits.length
    ? hits
        .map(({ api, mem }, i) => {
          const href = hashFor(state.family, groupOf(api), api.k, mem?.anchor);
          const rest = mem?.kind === 'endpoint';
          const title = !mem ? `<b>${esc(api.n)}</b>` : rest ? `<b>${esc(mem.sig)}</b>` : `${esc(api.n)}.<b>${esc(mem.sig)}</b>`;
          const sum = (rest ? `${api.n}: ` : '') + ((mem ? mem.s : api.s) || '');
          return `<a class="res${i === 0 ? ' active' : ''}" href="${esc(href)}"><div class="sig">${title}${badges(api)}</div><div class="sum">${esc(sum)}</div></a>`;
        })
        .join('')
    : '<div class="res-empty">No matches in this release.</div>';
  box.hidden = false;
}

function moveActive(delta) {
  const items = [...el('results').querySelectorAll('.res')];
  if (!items.length) return;
  items[active]?.classList.remove('active');
  active = (active + delta + items.length) % items.length;
  items[active].classList.add('active');
  items[active].scrollIntoView({ block: 'nearest' });
}

function closeResults() {
  el('results').hidden = true;
}

// ---------- chrome: release select, tabs, sidebar ----------

function renderReleases() {
  el('release').innerHTML = state.releases
    .map((r) => `<option value="${esc(r.family)}"${r.family === state.family ? ' selected' : ''}>${esc(r.title)}${r.latest ? ' (latest)' : ''}</option>`)
    .join('');
}

function renderTabs() {
  const c = state.index.counts;
  el('tabs').innerHTML = GROUPS.map(
    ([id, label]) => `<a href="${hashFor(state.family, id)}" class="${id === state.group ? 'on' : ''}">${label} <small>${c[id] ?? 0}</small></a>`,
  ).join('');
}

// Sidebar tree: each API expands to its methods; the filter matches API names and method names.
const expanded = new Set();
let expandedVersion = 0;

function renderList({ reveal = false } = {}) {
  const f = el('filter').value.trim().toLowerCase();
  const sig = [state.family, state.group, f, state.apiKey, state.anchor, expandedVersion, favs.version].join('|');
  if (sig === state.listSig) return;
  state.listSig = sig;
  let html = '';
  let sub = null;
  if (!f && (favs.list.length || favs.removed.length)) {
    const rel = state.releases.find((r) => r.family === state.family)?.title || state.family;
    html += '<h4>Favourites</h4>';
    if (favs.removed.length) {
      const n = favs.removed.length;
      html += `<div class="favnote"><span>Removed ${n} favourite${n > 1 ? 's' : ''} that no longer exist${n > 1 ? '' : 's'}: ${esc(favs.removed.join(', '))}</span><button type="button" class="favdismiss" aria-label="Dismiss">&times;</button></div>`;
    }
    for (const fv of favs.list) {
      const here = findApi(state.index, fv.g, fv.k);
      const tag = `<small class="tag">${SHORT[fv.g]}</small>`;
      const label = here
        ? `<a href="${hashFor(state.family, fv.g, fv.k)}">${esc(fv.n)}${tag}</a>`
        : `<span class="gone" title="Not in the ${esc(rel)} release">${esc(fv.n)}${tag}<small> not in ${esc(rel)}</small></span>`;
      html += `<div class="row fav"><span class="tw staricon">&#9733;</span>${label}<button type="button" class="unfav" data-g="${fv.g}" data-k="${esc(fv.k)}" aria-label="Remove ${esc(fv.n)} from favourites" title="Remove from favourites">&times;</button></div>`;
    }
    if (state.group !== 'client') html += '<h4>All APIs</h4>';
  }
  for (const a of state.index.apis) {
    if (!a.g.includes(state.group)) continue;
    const nameHit = !f || a.ln.includes(f);
    const memHits = f ? a.m.filter((m) => m.ln.includes(f)) : [];
    if (!nameHit && !memHits.length) continue;
    if (state.group === 'client' && a.sg !== sub) {
      sub = a.sg;
      html += `<h4>${esc(sub || 'Client')}</h4>`;
    }
    const pinned = expanded.has(a.id);
    const open = pinned || memHits.length > 0;
    const current = a.k === state.apiKey;
    const cls = [current ? 'on' : '', a.d ? 'dep' : ''].join(' ').trim();
    const toggle = a.m.length
      ? `<button class="tw" type="button" data-id="${esc(a.id)}" data-open="${open ? 1 : 0}" aria-expanded="${open}" aria-label="${open ? 'Collapse' : 'Expand'} ${esc(a.n)}">${open ? '&#9662;' : '&#9656;'}</button>`
      : '<span class="tw"></span>';
    html += `<div class="row">${toggle}<a href="${hashFor(state.family, state.group, a.k)}"${cls ? ` class="${cls}"` : ''}>${esc(a.n)}</a></div>`;
    if (open && a.m.length) {
      const shown = memHits.length ? memHits : a.m; // while filtering, show only the matching methods
      html += `<div class="kids">${shown
        .map((m) => `<a class="mem${current && m.anchor === state.anchor ? ' on' : ''}" href="${hashFor(state.family, state.group, a.k, m.anchor)}" title="${esc(m.sig)}">${esc(m.sig)}</a>`)
        .join('')}</div>`;
    }
  }
  const list = el('list');
  const top = list.scrollTop;
  list.innerHTML = html || '<div class="none">No API or method matches that filter.</div>';
  // Only navigation brings the current item into view; expanding a node or filtering leaves the scroll alone.
  if (reveal) (list.querySelector('a.mem.on') || list.querySelector('a.on'))?.scrollIntoView({ block: 'nearest' });
  else list.scrollTop = top;
}

function toggleNode(btn) {
  const id = btn.dataset.id;
  if (expanded.has(id)) expanded.delete(id);
  else expanded.add(id);
  expandedVersion++;
  renderList();
}

// ---------- pages ----------

function highlight(code) {
  if (/^\s*</.test(code)) return esc(code); // XML or HTML: leave plain
  const re =
    /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\b(var|let|const|function|return|if|else|for|while|do|new|try|catch|finally|throw|typeof|instanceof|in|of|switch|case|break|continue|default|this|null|undefined|true|false|class|extends|delete|void)\b|\b(\d+(?:\.\d+)?)\b/g;
  let out = '';
  let last = 0;
  for (let m; (m = re.exec(code)); ) {
    out += esc(code.slice(last, m.index));
    out += `<span class="tk-${m[1] ? 'c' : m[2] ? 's' : m[3] ? 'k' : 'n'}">${esc(m[0])}</span>`;
    last = re.lastIndex;
  }
  return out + esc(code.slice(last));
}

/** Post-processes injected documentation HTML: code highlighting, copy buttons, scrollable tables. */
function enhance(root) {
  for (const pre of root.querySelectorAll('pre')) {
    const code = pre.textContent;
    pre.innerHTML = `<code>${highlight(code)}</code>`;
    const wrap = document.createElement('div');
    wrap.className = 'codewrap';
    pre.replaceWith(wrap);
    const btn = document.createElement('button');
    btn.className = 'copy';
    btn.type = 'button';
    btn.textContent = 'Copy';
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(code);
        btn.textContent = 'Copied';
      } catch {
        btn.textContent = 'Copy failed';
      }
      setTimeout(() => (btn.textContent = 'Copy'), 1500);
    });
    wrap.append(pre, btn);
  }
  // Parameter types (second column) and return types (first column) link to their API where we have one.
  for (const [sel, col] of [['table.parameters', 1], ['table.returns', 0]]) {
    for (const row of root.querySelectorAll(`.doc ${sel} > tbody > tr`)) {
      const cell = row.children[col];
      if (!cell || cell.tagName !== 'TD' || cell.children.length) continue; // leave cells that already have markup
      const html = linkTypes(cell.textContent);
      if (html.includes('<a ')) cell.innerHTML = html;
    }
  }
  for (const table of root.querySelectorAll('.doc table')) {
    const wrap = document.createElement('div');
    wrap.className = 'table-wrap';
    table.replaceWith(wrap);
    wrap.append(table);
  }
}

function renderOverview() {
  const { index, group, family } = state;
  const rel = state.releases.find((r) => r.family === family);
  const [, label] = GROUPS.find((g) => g[0] === group);
  const apis = index.apis.filter((a) => a.g.includes(group));
  const recent = [...apis].filter((a) => a.u).sort((a, b) => b.u.localeCompare(a.u) || a.ln.localeCompare(b.ln)).slice(0, 10);
  const c = index.counts;
  const myFavs = favs.list.filter((fv) => findApi(index, fv.g, fv.k));
  el('main').innerHTML = `
    <h1>${esc(label)} APIs <span class="badge b-${group}">${esc(rel?.title || family)}</span></h1>
    <p class="lead">A searchable, unofficial view of the ServiceNow API reference. Pick an API from the list or search across every API and method in this release.</p>
    <div class="cards">${GROUPS.map(([id, l]) => `<a class="card" href="${hashFor(family, id)}"><b>${c[id] ?? 0}</b>${l} APIs</a>`).join('')}
      <div class="card"><b>${(c.members ?? 0).toLocaleString()}</b>methods and endpoints</div></div>
    <p class="tips">Search tips: press <kbd>/</kbd> to search &middot; <kbd>GlideRecord.addQuery</kbd> or <kbd>gr addq</kbd> finds a method on a class &middot;
      <kbd>&uarr;</kbd> <kbd>&darr;</kbd> <kbd>Enter</kbd> to pick a result &middot; the release switcher keeps you on the same API.</p>
    ${myFavs.length ? `<h2>Your favourites</h2><p class="favlinks">${myFavs
      .map((fv) => `<a href="${hashFor(family, fv.g, fv.k)}">&#9733; ${esc(fv.n)}<small class="tag">${SHORT[fv.g]}</small></a>`)
      .join('')}</p>` : ''}
    ${recent.length ? `<h2>Recently updated</h2><div class="table-wrap"><table><tbody>${recent
      .map((a) => `<tr><td><a href="${hashFor(family, group, a.k)}">${esc(a.n)}</a></td><td>${esc(a.u)}</td><td>${esc(a.s)}</td></tr>`)
      .join('')}</tbody></table></div>` : ''}
    <h2>All ${esc(label)} APIs</h2>
    <div class="table-wrap"><table><tbody>${apis
      .map((a) => `<tr><td><a href="${hashFor(family, group, a.k)}">${esc(a.n)}</a>${a.d ? '<span class="badge b-dep">Deprecated</span>' : ''}</td><td>${esc(a.s)}</td></tr>`)
      .join('')}</tbody></table></div>`;
  document.title = `${label} APIs (${rel?.title || family}) - SN API Docs`;
}

function renderApi(api, d) {
  const { family, group, index } = state;
  const rel = state.releases.find((r) => r.family === family);
  const sibling =
    group.startsWith('server-') && index.apis.find((a) => a.n === api.n && a.id !== api.id && a.g.some((g) => g.startsWith('server-') && g !== group));
  const sibGroup = sibling && sibling.g.find((g) => g.startsWith('server-') && g !== group);
  const noun = group === 'rest' ? 'Endpoints' : 'Methods';
  const kindLabel = { constructor: 'Constructor', property: 'Property' };
  el('main').innerHTML = `
    <h1>${esc(d.name)}${badges(api)}${starButton(group, api.k)}</h1>
    ${d.summary ? `<p class="lead">${esc(d.summary)}</p>` : ''}
    <div class="meta">
      <span>Release: ${esc(rel?.title || family)}</span>
      ${d.updated ? `<span>Updated upstream: ${esc(d.updated)}</span>` : ''}
      <a href="${esc(d.url)}" target="_blank" rel="noopener noreferrer">View on ServiceNow docs &#8599;</a>
    </div>
    ${sibling ? `<div class="notice">There is a separate <a href="${hashFor(family, sibGroup, sibling.k)}">${SHORT[sibGroup]} version of ${esc(api.n)}</a>.</div>` : ''}
    <div class="doc">${d.overview}</div>
    ${d.members.length ? `<h2>${noun} <small>(${d.members.length})</small></h2>
    <div class="table-wrap"><table class="mtable"><thead><tr><th>${group === 'rest' ? 'Endpoint' : 'Signature'}</th>${group === 'rest' ? '' : '<th class="ret">Returns</th>'}<th>Summary</th></tr></thead><tbody>${d.members
      .map((m) => `<tr><td><a href="${hashFor(family, group, api.k, m.anchor)}">${esc(m.sig)}</a></td>${group === 'rest' ? '' : `<td class="ret">${linkTypes(m.ret)}</td>`}<td>${esc(m.summary)}</td></tr>`)
      .join('')}</tbody></table></div>` : ''}
    ${d.members
      .map(
        (m) => `<section class="member" id="m-${esc(m.anchor)}">
        <h3>${kindLabel[m.kind] ? `<span class="kind">${kindLabel[m.kind]}</span>` : ''}${esc(m.sig)}<a class="perma" href="${hashFor(family, group, api.k, m.anchor)}" aria-label="Link to ${esc(m.name)}">#</a></h3>
        ${m.summary ? `<p>${esc(m.summary)}</p>` : ''}
        <div class="doc">${m.html}</div></section>`,
      )
      .join('')}`;
  enhance(el('main'));
  document.title = `${d.name} (${SHORT[group]}, ${rel?.title || family}) - SN API Docs`;
}

function scrollToAnchor(anchor) {
  document.querySelector('.member.target')?.classList.remove('target');
  const target = anchor && document.getElementById(`m-${anchor}`);
  if (target) {
    target.classList.add('target');
    target.scrollIntoView();
  } else {
    window.scrollTo(0, 0);
  }
}

// ---------- router ----------

async function route() {
  const token = ++state.token;
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map((p) => { try { return decodeURIComponent(p); } catch { return p; } });
  const latest = (state.releases.find((r) => r.latest) || state.releases[0]).family;
  const known = (f) => state.releases.some((r) => r.family === f);
  const saved = store.get('family');
  const fallback = state.family || (known(saved) ? saved : latest);

  // Cross-reference links inside the docs: #/~/<api id>/<section id>
  if (parts[0] === '~') {
    const index = await loadIndex(fallback);
    const api = index.byId.get(parts[1]);
    if (!api) return void location.replace(hashFor(fallback, state.group));
    const d = await loadDetail(fallback, api.id);
    const sid = parts[2] || '';
    const mem = d.members.find((m) => m.sid === sid) || d.members.find((m) => m.sid && sid.startsWith(m.sid + '__'));
    return void location.replace(hashFor(fallback, groupOf(api), api.k, mem?.anchor));
  }

  let [family, group, key, anchor] = parts;
  if (!known(family)) return void location.replace(hashFor(fallback, state.group));
  if (!GROUP_IDS.includes(group)) group = group ? null : 'server-scoped';
  if (!group) return void location.replace(hashFor(family, 'server-scoped'));

  const index = await loadIndex(family);
  if (token !== state.token) return;
  const pageChanged = family !== state.family || group !== state.group || key !== state.apiKey;
  Object.assign(state, { family, group, index, apiKey: key || null, anchor: anchor || null });
  const currentApi = key && findApi(index, group, key);
  if (currentApi && pageChanged && !expanded.has(currentApi.id)) {
    expanded.add(currentApi.id); // open the current API's methods in the tree
    expandedVersion++;
  }
  store.set('family', family);
  if (favs.checked !== family) {
    favs.checked = family; // check saved favourites against each release once, without holding up the page
    validateFavs(index, family).then((changed) => changed && refreshFavUi());
  }
  el('release').value = family;
  el('generated').textContent = `Data for this release generated ${index.generated.slice(0, 10)}.`;
  renderTabs();
  renderList({ reveal: true });
  document.body.classList.remove('menu-open');

  if (!key) {
    renderOverview();
    return void window.scrollTo(0, 0);
  }
  const api = findApi(index, group, key);
  if (!api) {
    el('main').innerHTML = `<h1>Not found</h1><p class="lead">There is no ${esc(SHORT[group])} API named <code>${esc(key)}</code> in the ${esc(family)} release. It may exist under a different name or scope: try the search box.</p>`;
    return;
  }
  if (pageChanged || !el('main').querySelector('.member, .doc')) {
    el('main').innerHTML = '<p class="lead">Loading&hellip;</p>';
    let d;
    try {
      d = await loadDetail(family, api.id);
    } catch (e) {
      if (token === state.token) el('main').innerHTML = `<h1>Could not load this API</h1><p class="lead">${esc(e.message)}</p>`;
      return;
    }
    if (token !== state.token) return;
    renderApi(api, d);
  }
  scrollToAnchor(anchor);
}

/** Switching release keeps the same API and method where they exist in the target release. */
async function switchRelease(family) {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const [, , key, anchor] = parts;
  const index = await loadIndex(family);
  const api = key && (findApi(index, state.group, key) || index.apis.find((a) => a.n === state.index.apis.find((x) => x.k === key && x.g.includes(state.group))?.n && a.g.includes(state.group)));
  location.hash = api ? hashFor(family, state.group, api.k, api.m.some((m) => m.anchor === anchor) ? anchor : null) : hashFor(family, state.group);
}

// ---------- wiring ----------

function wire() {
  const q = el('q');
  q.addEventListener('input', renderResults);
  q.addEventListener('focus', renderResults);
  q.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveActive(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveActive(-1); }
    else if (e.key === 'Enter') {
      const item = el('results').querySelectorAll('.res')[active];
      if (item && !el('results').hidden) { location.hash = item.getAttribute('href'); closeResults(); q.blur(); }
    } else if (e.key === 'Escape') { closeResults(); q.blur(); }
  });
  el('results').addEventListener('click', (e) => { if (e.target.closest('.res')) closeResults(); });
  document.addEventListener('click', (e) => { if (!e.target.closest('.search')) closeResults(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName) && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      q.focus();
      q.select();
    }
  });
  el('filter').addEventListener('input', () => renderList());
  el('list').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.classList.contains('tw')) toggleNode(b);
    else if (b.classList.contains('unfav')) toggleFav(b.dataset.g, b.dataset.k);
    else if (b.classList.contains('favdismiss')) { favs.removed = []; favs.version++; renderList(); }
  });
  el('main').addEventListener('click', (e) => { if (e.target.closest('button.star') && state.apiKey) toggleFav(state.group, state.apiKey); });
  window.addEventListener('storage', (e) => { if (e.key === 'favs') { readFavs(); refreshFavUi(); } });
  el('release').addEventListener('change', (e) => switchRelease(e.target.value));
  el('menu').addEventListener('click', () => document.body.classList.toggle('menu-open'));
  el('theme').addEventListener('click', () => {
    const root = document.documentElement;
    const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = dark ? 'light' : 'dark';
    store.set('theme', root.dataset.theme);
  });
  window.addEventListener('hashchange', route);
}

async function start() {
  try {
    const manifest = await getJson('data/releases.json');
    state.releases = manifest.releases;
    if (!state.releases.length) throw new Error('no releases in data/releases.json');
  } catch (e) {
    el('main').innerHTML = `<h1>No data yet</h1><p class="lead">Run <code>npm run refresh</code> to generate the documentation data, then reload. (${esc(e.message)})</p>`;
    return;
  }
  readFavs();
  wire();
  renderReleases();
  await route();
}

start();
