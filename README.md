# SN API Docs (snapidocs.com)

Unofficial API browser for ServiceNow.

A fast, searchable browser for the ServiceNow API reference: Server Scoped, Server Global, Client and REST
APIs, with a release switcher. It is a static site (`site/`) fed by JSON that a script regenerates from
ServiceNow's public documentation.

Not affiliated with ServiceNow. Documentation content is © ServiceNow, Inc.; every page links back to the
official topic it came from.

## Use it locally

```bash
npm install
npm run serve      # http://localhost:4173
```

## Refresh the data

```bash
npm run refresh    # re-fetch every release that changed upstream
npm run check      # sanity-check what is on disk
```

Options for `npm run refresh -- <flags>`:

| Flag | Effect |
| --- | --- |
| `--release brazil,zurich` | Only these releases |
| `--force` | Rebuild even if upstream is unchanged (re-parses from the local cache) |
| `--refetch` | Ignore the local cache and download everything again |
| `--accept-shrink` | Allow a release to lose more than 20% of its APIs (normally treated as a failure) |
| `--concurrency 4` | Parallel downloads |

How it works:

1. The docs site is a Fluid Topics portal with a public JSON API (`/docs/api/khub`). The script lists all
   publications and keeps the English "API Reference" one for each release, so new releases appear on their own.
2. For each release it reads the table of contents, takes the Server, Client and REST sections, and downloads
   one topic per API. Raw responses are cached in `.cache/`; unchanged topics and unchanged releases are skipped.
3. Each topic is parsed into an API with its methods/endpoints. HTML is passed through an allow-list sanitiser
   and cross-references are rewritten to in-site links.
4. Before a release's data is replaced it is validated (non-empty groups, no large shrink, landmark methods
   such as `GlideRecord.addQuery` present). On failure the previous data is kept and the command exits non-zero,
   which is the signal that ServiceNow changed their markup and `scripts/parse.mjs` needs a look.

Output: `site/data/releases.json`, `site/data/<release>/index.json` (search index) and
`site/data/<release>/api/<id>.json` (full detail, loaded on demand).

Not included: the native Android/iOS Mobile SDK reference (not JavaScript).

## Weekly refresh

- **GitHub Pages**: `.github/workflows/refresh.yml` refreshes every Monday (and on demand), commits changed
  data and deploys `site/`. Push the project to GitHub and set Pages' source to "GitHub Actions". `site/CNAME` already points Pages at the
  `snapidocs.com` custom domain (DNS still has to be pointed at GitHub).
- **Anywhere else**: run `npm run refresh && npm run check` on a schedule (cron, launchd, CI) and upload `site/`
  to any static host. There is no build step.

## Layout

```
scripts/build-data.mjs   orchestrates the refresh
scripts/fetch.mjs        HTTP with retries
scripts/parse.mjs        topic HTML -> structured, sanitised data
scripts/check.mjs        validation
scripts/serve.mjs        local preview server
site/                    the static site (index.html, app.js, styles.css, data/)
```
