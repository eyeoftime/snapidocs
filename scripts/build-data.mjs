// Regenerates site/data from the public ServiceNow docs content API.
//
//   node scripts/build-data.mjs                    refresh every release that changed upstream
//   node scripts/build-data.mjs --release brazil   only the named release(s), comma separated
//   node scripts/build-data.mjs --force            rebuild even if upstream is unchanged (uses the cache)
//   node scripts/build-data.mjs --accept-shrink   allow a release to lose more than 20% of its APIs
//   node scripts/build-data.mjs --refetch          ignore the local cache and download everything again
import { mkdir, readFile, writeFile, rm, rename, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { API, DOCS, get, pool } from './fetch.mjs';
import { parseTopic } from './parse.mjs';
import { validate, countGroups } from './check.mjs';

const SCHEMA = 1; // bump to force a rebuild when the output format changes
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'site', 'data');
const CACHE = path.join(ROOT, '.cache');

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};
const only = opt('release')?.split(',').map((s) => s.trim().toLowerCase());
const CONCURRENCY = Number(opt('concurrency') || 4);

const meta = (m, key) => m.metadata.find((x) => x.key === key)?.values ?? [];
const readJson = async (file) => (existsSync(file) ? JSON.parse(await readFile(file, 'utf8')) : null);

// Release names run A-Z and then wrap (…Xanadu, Yokohama, Zurich, Australia, Brazil…). Names from the
// current cycle sort after the tail of the previous one; the pivot letter will need moving in a few years.
const cycleRank = (family) => (family[0] >= 'q' ? 0 : 1);
const newestFirst = (a, b) => cycleRank(b.family) - cycleRank(a.family) || b.family.localeCompare(a.family);

async function discoverReleases() {
  const maps = await get(`${API}/maps`, { json: true });
  return maps
    .filter((m) => meta(m, 'bundleId')[0] === 'crapiref' && meta(m, 'ft:locale')[0] === 'en-US')
    .map((m) => ({
      family: meta(m, 'family')[0],
      title: m.title.replace(/\s*API Reference\s*$/i, ''),
      mapId: m.id,
      latest: meta(m, 'version').includes('latest'),
      stamp: [meta(m, 'ft:lastEdition')[0], meta(m, 'ft:lastPublication')[0]].join('|'),
    }))
    .filter((r) => r.family)
    .sort(newestFirst);
}

const flatten = (node, out = []) => {
  for (const c of node.children || []) {
    out.push(c);
    flatten(c, out);
  }
  return out;
};

function findNode(nodes, test) {
  for (const n of nodes) {
    if (test(n)) return n;
    const hit = findNode(n.children || [], test);
    if (hit) return hit;
  }
  return null;
}

/** Splits a table-of-contents title into a display name, groups and flags. */
function classify(section, title) {
  const dep = /deprecated/i.test(title);
  const seps = [...title.matchAll(/\s[-\u2013\u2014]\s/g)]; // hyphen, en dash or em dash
  const sep = seps[seps.length - 1];
  const base = sep ? title.slice(0, sep.index).trim() : title;
  const suffix = sep ? title.slice(sep.index + sep[0].length) : '';
  if (section.kind === 'server') {
    const scoped = /scoped/i.test(suffix);
    const global = /glo?bal/i.test(suffix); // tolerates the upstream "Gobal" typo
    if (!scoped && !global) return { name: title, groups: ['server-scoped', 'server-global'], dep, unknownScope: true };
    return { name: base, groups: [scoped && 'server-scoped', global && 'server-global'].filter(Boolean), dep };
  }
  if (section.kind === 'client') {
    const name = /client|mobile|next|uib|ui builder|scoped|global/i.test(suffix) ? base : title;
    return { name, groups: ['client'], sub: section.sub, dep };
  }
  return { name: title, groups: ['rest'], dep };
}

function sectionFor(node) {
  const t = node.title;
  if (/^server api/i.test(t)) return { kind: 'server' };
  if (/^rest api/i.test(t)) return { kind: 'rest' };
  if (/sdk/i.test(t)) return { kind: 'skip' }; // native Android/iOS SDK, not a JavaScript API
  if (/client|mobile|uib|ui builder/i.test(t)) return { kind: 'client', sub: t.replace(/\s*API reference\s*$/i, '') };
  return null;
}

const anchorOf = (name) => name.replace(/[^A-Za-z0-9_$.]+/g, '-').replace(/^-+|-+$/g, '') || 'member';

function unique(base, used) {
  let v = base;
  for (let n = 2; used.has(v); n++) v = `${base}-${n}`;
  used.add(v);
  return v;
}

async function fetchTopic(rel, topicId, updated, stamps, refetch) {
  const file = path.join(CACHE, rel.mapId, `${topicId}.html`);
  if (!refetch && stamps[topicId] === updated && existsSync(file)) return readFile(file, 'utf8');
  const html = await get(`${API}/maps/${rel.mapId}/topics/${topicId}/content`);
  await writeFile(file, html);
  stamps[topicId] = updated;
  return html;
}

async function buildRelease(rel) {
  const dir = path.join(DATA, rel.family);
  const prev = await readJson(path.join(dir, 'index.json'));
  if (prev && prev.stamp === rel.stamp && prev.schema === SCHEMA && !flag('force') && !flag('refetch')) {
    console.log(`${rel.family}: unchanged upstream, skipped`);
    return { counts: prev.counts, changed: false };
  }

  console.log(`${rel.family}: fetching table of contents`);
  const [toc, topics] = await Promise.all([
    get(`${API}/maps/${rel.mapId}/toc`, { json: true }),
    get(`${API}/maps/${rel.mapId}/topics`, { json: true }),
  ]);
  const updatedOf = new Map(topics.map((t) => [t.id, (meta(t, 'last_updated_date')[0] || '').slice(0, 10)]));

  const refNode = findNode(toc, (n) => /^api reference$/i.test(n.title));
  if (!refNode) throw new Error('could not find the "API reference" section in the table of contents');

  const entries = [];
  const slugs = new Set();
  for (const sectionNode of refNode.children || []) {
    const section = sectionFor(sectionNode);
    const nodes = flatten(sectionNode);
    if (section?.kind === 'skip') continue;
    if (!section) {
      if (nodes.length) console.warn(`  ! unrecognised section "${sectionNode.title}" (${nodes.length} topics) skipped`);
      continue;
    }
    for (const node of nodes) {
      const c = classify(section, node.title);
      if (c.unknownScope) console.warn(`  ! no scope in title "${node.title}", listed under both scoped and global`);
      const slug = unique(path.basename(node.prettyUrl || node.tocId, '.html'), slugs);
      entries.push({ ...c, node, slug });
    }
  }

  const tocToSlug = new Map(entries.map((e) => [e.node.tocId, e.slug]));
  const tocToUrl = new Map(flatten({ children: toc }).filter((n) => n.prettyUrl).map((n) => [n.tocId, DOCS + n.prettyUrl]));

  await mkdir(path.join(CACHE, rel.mapId), { recursive: true });
  const stampFile = path.join(CACHE, rel.mapId, 'stamps.json');
  const stamps = (await readJson(stampFile)) || {};
  let done = 0;
  const failures = [];
  const htmls = await pool(entries, CONCURRENCY, async (e) => {
    try {
      return await fetchTopic(rel, e.node.contentId, updatedOf.get(e.node.contentId) || '', stamps, flag('refetch'));
    } catch (err) {
      failures.push(`${e.node.title}: ${err.message}`);
      return null;
    } finally {
      if (++done % 100 === 0 || done === entries.length) console.log(`  ${done}/${entries.length} topics`);
    }
  });
  await writeFile(stampFile, JSON.stringify(stamps));
  if (failures.length) throw new Error(`${failures.length} topics failed to download, e.g. ${failures[0]}`);

  // Route keys: the API name, made unique within each group it appears in.
  const keysByGroup = new Map();
  const details = [];
  const apis = entries.map((e, i) => {
    const parsed = parseTopic(htmls[i], { tocToSlug, tocToUrl });
    const taken = e.groups.map((g) => keysByGroup.get(g) || keysByGroup.set(g, new Set()).get(g));
    let key = e.name;
    for (let n = 2; taken.some((s) => s.has(key)); n++) key = `${e.name} (${n})`;
    taken.forEach((s) => s.add(key));

    const anchors = new Set();
    const members = parsed.members.map((m) => ({ ...m, anchor: unique(anchorOf(m.name), anchors) }));
    const updated = updatedOf.get(e.node.contentId) || '';
    details.push({
      id: e.slug,
      key,
      name: e.name,
      title: e.node.title,
      groups: e.groups,
      sub: e.sub,
      deprecated: e.dep,
      summary: parsed.summary,
      url: DOCS + e.node.prettyUrl,
      updated,
      overview: parsed.overview,
      members: members.map(({ cls, ...m }) => m),
    });
    return {
      id: e.slug,
      k: key,
      n: e.name,
      g: e.groups,
      ...(e.sub && { sg: e.sub }),
      ...(e.dep && { d: 1 }),
      s: parsed.summary,
      u: updated,
      m: members.map((m) => [m.name, m.sig, m.summary, m.anchor, m.kind]),
    };
  });

  const index = {
    schema: SCHEMA,
    family: rel.family,
    title: rel.title,
    stamp: rel.stamp,
    generated: new Date().toISOString(),
    counts: countGroups(apis),
    apis,
  };
  const errors = validate(index, flag('accept-shrink') ? null : prev);
  if (errors.length) throw new Error(`validation failed:\n    - ${errors.join('\n    - ')}`);

  const tmp = path.join(DATA, `.${rel.family}.tmp`);
  await rm(tmp, { recursive: true, force: true });
  await mkdir(path.join(tmp, 'api'), { recursive: true });
  await writeFile(path.join(tmp, 'index.json'), JSON.stringify(index));
  await Promise.all(details.map((d) => writeFile(path.join(tmp, 'api', `${d.id}.json`), JSON.stringify(d))));
  await rm(dir, { recursive: true, force: true });
  await rename(tmp, dir);
  const c = index.counts;
  console.log(`${rel.family}: wrote ${apis.length} APIs (scoped ${c['server-scoped']}, global ${c['server-global']}, client ${c.client}, rest ${c.rest}; ${c.members} members)`);
  return { counts: index.counts, changed: true };
}

async function main() {
  await mkdir(DATA, { recursive: true });
  const releases = await discoverReleases();
  if (!releases.length) throw new Error('no API Reference publications found: the docs site layout may have changed');
  console.log(`Found releases: ${releases.map((r) => r.family + (r.latest ? ' (latest)' : '')).join(', ')}`);

  let failed = 0;
  for (const rel of releases) {
    if (only && !only.includes(rel.family)) continue;
    try {
      await buildRelease(rel);
    } catch (err) {
      failed++;
      console.error(`${rel.family}: FAILED, previous data kept. ${err.message}`);
    }
  }

  // The manifest lists every upstream release that has data on disk.
  const out = [];
  for (const rel of releases) {
    const idx = await readJson(path.join(DATA, rel.family, 'index.json'));
    if (idx) out.push({ family: rel.family, title: rel.title, latest: rel.latest, generated: idx.generated, counts: idx.counts });
  }
  if (out.length && !out.some((r) => r.latest)) out[0].latest = true;
  await writeFile(path.join(DATA, 'releases.json'), JSON.stringify({ generated: new Date().toISOString(), releases: out }, null, 1));

  // Drop data for releases that no longer exist upstream.
  for (const d of await readdir(DATA, { withFileTypes: true })) {
    if (d.isDirectory() && !d.name.startsWith('.') && !releases.some((r) => r.family === d.name)) {
      console.log(`${d.name}: no longer published upstream, removing`);
      await rm(path.join(DATA, d.name), { recursive: true, force: true });
    }
  }
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
