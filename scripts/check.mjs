// Sanity checks for generated data. Used by build-data.mjs before it replaces a release's data,
// and runnable on its own (`npm run check`) to verify what is on disk.
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const GROUPS = ['server-scoped', 'server-global', 'client', 'rest'];
const MAX_SHRINK = 0.2;

export function countGroups(apis) {
  const counts = Object.fromEntries(GROUPS.map((g) => [g, 0]));
  let members = 0;
  for (const a of apis) {
    for (const g of a.g) counts[g]++;
    members += a.m.length;
  }
  return { ...counts, members };
}

const hasMember = (index, group, test, member) =>
  index.apis.some((a) => a.g.includes(group) && test(a.n) && a.m.some((m) => m[0] === member));

/** Returns a list of problems; empty means the data looks sound. */
export function validate(index, prev) {
  const errors = [];
  const c = index.counts;
  for (const g of GROUPS) {
    if (!c[g]) errors.push(`no APIs in group ${g}`);
    const before = prev?.counts?.[g];
    if (before && c[g] < before * (1 - MAX_SHRINK)) errors.push(`${g} shrank from ${before} to ${c[g]} APIs`);
  }
  if (prev?.counts?.members && c.members < prev.counts.members * (1 - MAX_SHRINK))
    errors.push(`members shrank from ${prev.counts.members} to ${c.members}`);
  if (c.members < index.apis.length) errors.push(`only ${c.members} members across ${index.apis.length} APIs: method parsing is probably broken`);

  // Landmarks that exist in every release; if they vanish, the upstream markup has changed.
  if (!hasMember(index, 'server-scoped', (n) => n === 'GlideRecord', 'addQuery')) errors.push('scoped GlideRecord.addQuery not found');
  if (!hasMember(index, 'server-global', (n) => n === 'GlideRecord', 'addQuery')) errors.push('global GlideRecord.addQuery not found');
  if (!hasMember(index, 'client', (n) => n.startsWith('GlideForm'), 'setValue')) errors.push('client GlideForm.setValue not found');
  if (!index.apis.some((a) => a.g.includes('rest') && /^Table API/.test(a.n) && a.m.length >= 5)) errors.push('REST Table API endpoints not found');
  return errors;
}

async function main() {
  const DATA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'site', 'data');
  const manifest = JSON.parse(await readFile(path.join(DATA, 'releases.json'), 'utf8'));
  let bad = 0;
  for (const rel of manifest.releases) {
    const dir = path.join(DATA, rel.family);
    const index = JSON.parse(await readFile(path.join(dir, 'index.json'), 'utf8'));
    const errors = validate(index, null);
    const files = new Set(await readdir(path.join(dir, 'api')));
    for (const a of index.apis) {
      if (!files.has(`${a.id}.json`)) errors.push(`missing detail file for ${a.n}`);
    }
    const c = index.counts;
    console.log(
      `${rel.family.padEnd(10)} scoped ${String(c['server-scoped']).padStart(4)}  global ${String(c['server-global']).padStart(4)}  ` +
        `client ${String(c.client).padStart(3)}  rest ${String(c.rest).padStart(4)}  members ${String(c.members).padStart(6)}  ` +
        (errors.length ? 'FAIL' : 'ok'),
    );
    for (const e of errors.slice(0, 10)) console.log(`   - ${e}`);
    bad += errors.length;
  }
  if (!manifest.releases.length) {
    console.log('no releases in manifest');
    bad++;
  }
  process.exit(bad ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
