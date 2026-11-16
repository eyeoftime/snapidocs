// Turns one topic's HTML (one API class / REST API) into structured, sanitised data.
import * as cheerio from 'cheerio';
import { DOCS } from './fetch.mjs';

const ALLOWED = new Set(
  ('p div span section ul ol li dl dt dd table caption colgroup col thead tbody tfoot tr th td pre code a b strong ' +
    'i em u sub sup br hr h1 h2 h3 h4 h5 h6 img figure figcaption blockquote kbd samp var cite q').split(' '),
);
// Removed together with their content (everything else unknown is unwrapped, keeping its children).
const DROP = new Set(
  'script style iframe object embed form input button select textarea svg math link meta noscript template video audio'.split(' '),
);
const KEEP_CLASS =
  /^(note|codeblock|codeph|parameters|returns|rest_api|title|sectiontitle|apiname|parmname|keyword|xref|table|fig|image|uicontrol|filepath|varname|cmdname|option|userinput|systemoutput|menucascade)/;
const SPAN_ATTRS = { td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan'] };

function cleanHref(href) {
  if (!href) return null;
  href = href.trim();
  if (href.startsWith('#/')) return href; // in-site route written by rewriteXrefs
  if (/^(https?:|mailto:)/i.test(href)) return href;
  if (href.startsWith('/')) return DOCS + href.replace(/^\/docs/, '');
  return null;
}

function cleanSrc(src) {
  if (!src) return null;
  try {
    const u = new URL(src, DOCS + '/');
    return u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

function sanitize($, root) {
  $(root)
    .find('*')
    .each((_, el) => {
      const tag = el.tagName?.toLowerCase();
      if (!tag) return;
      const $el = $(el);
      if (DROP.has(tag)) return void $el.remove();
      if (!ALLOWED.has(tag)) return void $el.replaceWith($el.contents());
      const old = el.attribs || {};
      const attrs = {};
      const cls = (old.class || '').split(/\s+/).filter((c) => KEEP_CLASS.test(c));
      if (cls.length) attrs.class = cls.join(' ');
      if (tag === 'a') {
        const href = cleanHref(old.href);
        if (!href) return void $el.replaceWith($el.contents());
        attrs.href = href;
        if (!href.startsWith('#')) {
          attrs.target = '_blank';
          attrs.rel = 'noopener noreferrer';
        }
      } else if (tag === 'img') {
        const src = cleanSrc(old.src);
        if (!src) return void $el.remove();
        attrs.src = src;
        attrs.alt = old.alt || '';
        attrs.loading = 'lazy';
      }
      for (const a of SPAN_ATTRS[tag] || []) if (/^\d+$/.test(old[a] || '')) attrs[a] = old[a];
      el.attribs = attrs;
    });
  collapseWhitespace(root);
}

function collapseWhitespace(node) {
  for (const child of node.children || []) {
    if (child.type === 'text') child.data = child.data.replace(/\s+/g, ' ');
    else if (child.type === 'tag' && child.name !== 'pre') collapseWhitespace(child);
  }
}

/** Internal cross-references become in-site routes (API topics) or official doc links (anything else). */
function rewriteXrefs($, ctx) {
  $('[data-tocid]').each((_, el) => {
    const toc = el.attribs['data-tocid'];
    const sec = el.attribs['data-section'] || '';
    let href = null;
    if (ctx.tocToSlug.has(toc)) href = `#/~/${encodeURIComponent(ctx.tocToSlug.get(toc))}/${encodeURIComponent(sec)}`;
    else if (ctx.tocToUrl.has(toc)) href = ctx.tocToUrl.get(toc);
    if (href) {
      el.tagName = 'a';
      el.attribs = { href, class: 'xref' };
    }
  });
}

const text = ($el) => $el.text().replace(/\s+/g, ' ').trim();

function kindOf(cls) {
  if (/api-constructor/.test(cls)) return 'constructor';
  if (/api-method/.test(cls)) return 'method';
  if (/rest_api_endpoint/.test(cls)) return 'endpoint';
  if (/api-property/.test(cls)) return 'property';
  return 'section';
}

/** "Scoped GlideRecord - addQuery(String name)" -> "addQuery(String name)"; "Table - GET /now/x" -> "GET /now/x" */
export function signatureFromTitle(title) {
  const paren = title.indexOf('(');
  const head = paren > 0 ? title.slice(0, paren) : title;
  const seps = [...head.matchAll(/\s[-\u2013\u2014]\s/g)];
  if (!seps.length) return title.trim();
  const sep = paren > 0 ? seps[seps.length - 1] : seps[0];
  return title.slice(sep.index + sep[0].length).trim();
}

function extract($, el) {
  const $el = $(el);
  const $title = $el.children('h1,h2,h3,h4,h5,h6').first();
  const title = text($title);
  $title.remove();
  const $short = $el.find('.shortdesc').first();
  const summary = text($short);
  $short.remove();
  const ret = text($el.find('table.returns tbody tr').first().find('td').first());
  sanitize($, el);
  return { title, summary, ret, html: ($el.html() || '').trim() };
}

/**
 * @param {string} html  topic content from the docs API
 * @param {{tocToSlug: Map<string,string>, tocToUrl: Map<string,string>}} ctx
 */
export function parseTopic(html, ctx) {
  const $ = cheerio.load(html, null, false);
  $('script,style,.zDocsTopicPageDetails,.table--title-label').remove();
  rewriteXrefs($, ctx);
  $('pre').each((_, el) => {
    const code = $(el).text().replace(/\s+$/, '');
    $(el).empty().text(code);
    el.attribs = { class: 'codeblock' };
  });

  let $root = $('article').filter((_, el) => /\bnested0\b/.test(el.attribs.class || '')).first();
  if (!$root.length) $root = $('article').first();
  const rootEl = $root.length ? $root[0] : $.root()[0];

  // Every nested article is a member (method, constructor, endpoint...). Detach deepest-first so that
  // each one's HTML holds only its own content.
  const memberEls = $(rootEl).find('article').toArray();
  const meta = memberEls.map((el) => ({ el, sid: el.attribs.id || '', cls: el.attribs.class || '' }));
  for (const el of [...memberEls].reverse()) $(el).remove();

  const top = extract($, rootEl);
  const members = meta.map(({ el, sid, cls }) => {
    const m = extract($, el);
    const kind = kindOf(cls);
    const sig = signatureFromTitle(m.title);
    const name = kind === 'endpoint' || !sig.includes('(') ? sig : sig.slice(0, sig.indexOf('(')).trim();
    return { kind, name, sig, summary: m.summary, ret: m.ret, sid, html: m.html, cls };
  });
  return { summary: top.summary, overview: top.html, members };
}
