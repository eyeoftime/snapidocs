// HTTP helpers for the ServiceNow docs (Fluid Topics) content API.

export const DOCS = 'https://www.servicenow.com/docs';
export const API = `${DOCS}/api/khub`;
const UA = 'api-reference-indexer/1.0 (static API reference index builder)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** GET with retries and exponential backoff. Returns parsed JSON or text. */
export async function get(url, { json = false, tries = 5 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': UA, accept: json ? 'application/json' : 'text/html,*/*' },
        signal: AbortSignal.timeout(90_000),
      });
      if (res.status === 404) throw Object.assign(new Error(`404 ${url}`), { fatal: true });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      return json ? await res.json() : await res.text();
    } catch (e) {
      lastErr = e;
      if (e.fatal) break;
      await sleep(1000 * 2 ** i);
    }
  }
  throw lastErr;
}

/** Run fn over items with at most n in flight. Results keep item order. */
export async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}
