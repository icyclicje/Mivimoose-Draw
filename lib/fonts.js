// ─────────────────────────────────────────────────────────────
// fonts.js — same-origin Google Fonts proxy.
//
// Inside a Discord Activity the page is framed from *.discordsays.com and the
// sandbox CSP kills absolute cross-origin URLs BEFORE Discord's URL mappings
// are consulted — so the <link> to fonts.googleapis.com never loads and the
// game drops to system fonts. This router serves the same stylesheet from our
// own origin and rewrites every fonts.gstatic.com url() back at ourselves, so
// the browser makes no cross-origin request at all.
//
//   GET <mount>/css          the stylesheet, url()s rewritten
//   GET <mount>/file/:id     one font binary, proxied from fonts.gstatic.com
//
// The rewritten url()s are RELATIVE ("file/<id>.woff2"), which is what makes
// this mount-agnostic: a browser resolves them against the stylesheet's own
// URL, so the same cached bytes are correct at /fonts/css and at
// /.proxy/fonts/css without this module ever knowing where it was mounted.
//
// Verified 2026-08-28 against the live endpoint (docs/css2 does not document
// format negotiation, so this was confirmed empirically):
//   • a modern Chrome UA returns woff2 (32 @font-face blocks, 7 distinct
//     files — the variable fonts reuse one file per unicode subset);
//     with no UA the same query returns .ttf instead. Hence FETCH_UA.
//   • font bodies come back as content-type font/woff2, magic "wOF2",
//     cache-control public,max-age=31536000 — i.e. immutable.
// ─────────────────────────────────────────────────────────────
const express = require('express');
const crypto = require('crypto');

// The two families the page uses. Kept here so the client only ever needs the
// mount point, never the upstream query string.
const CSS_URL =
  'https://fonts.googleapis.com/css2' +
  '?family=Fredoka:wght@400;500;600;700' +
  '&family=Plus+Jakarta+Sans:wght@400;500;600;700;800' +
  '&display=swap';

const CSS_HOST = 'fonts.googleapis.com';
const FONT_HOST = 'fonts.gstatic.com';

// Google picks the font format from the User-Agent. Ask as Chrome or we get
// .ttf files that are several times larger than the woff2 equivalents.
const FETCH_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const CSS_TTL_MS = 24 * 60 * 60 * 1000; // matches Google's own max-age
const CSS_TIMEOUT_MS = 6000;
const FONT_TIMEOUT_MS = 10000;

const MAX_CACHE_BYTES = 12 * 1024 * 1024; // whole-module ceiling, CSS + fonts
const MAX_FONT_BYTES = 4 * 1024 * 1024;   // one font this big is already wrong
const MAX_REGISTRY = 512;                 // distinct upstream URLs we'll ever map

const ID_RE = /^[a-f0-9]{16}$/;

const MIME_BY_EXT = {
  woff2: 'font/woff2',
  woff: 'font/woff',
  ttf: 'font/ttf',
  otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject',
  svg: 'image/svg+xml',
};
// Only these may be echoed from upstream; anything else we derive ourselves,
// so a stray text/html error page can never be served as a font.
const ALLOWED_MIME = new Set(Object.values(MIME_BY_EXT).concat(['application/octet-stream']));

// ── id registry ──
// id -> { url, ext }. An id only ever gets in here by parsing a stylesheet we
// fetched from Google ourselves, which is the whole security story for
// /file/:id: it can't be pointed at an arbitrary URL because it never takes
// one — it takes an opaque id and looks the URL up.
const registry = new Map();

// ── bounded LRU byte cache ──
// key -> { body: Buffer, type, etag }. Map keeps insertion order, so the
// oldest entry is always the first key; re-inserting on read makes it LRU.
const cache = new Map();
let cacheBytes = 0;

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  cache.delete(key);
  cache.set(key, hit); // touch: move to the young end
  return hit;
}

function cacheSet(key, entry) {
  const old = cache.get(key);
  if (old) { cache.delete(key); cacheBytes -= old.body.length; }
  if (entry.body.length > MAX_CACHE_BYTES) return; // never cache the uncacheable
  cache.set(key, entry);
  cacheBytes += entry.body.length;
  while (cacheBytes > MAX_CACHE_BYTES && cache.size > 0) {
    const oldest = cache.keys().next().value;
    const victim = cache.get(oldest);
    cache.delete(oldest);
    cacheBytes -= victim.body.length;
  }
}

// ── one-time failure logging ──
let loggedFailure = false;
function logOnce(what, err) {
  if (loggedFailure) return;
  loggedFailure = true;
  const msg = (err && err.message) || err;
  console.warn(`⚠️  fonts: ${what} (${msg}) — serving system-font fallback. Further font errors are silenced.`);
}

function idFor(url) {
  return crypto.createHash('sha256').update(url).digest('hex').slice(0, 16);
}

function extOf(url) {
  const m = /\.([a-z0-9]{2,5})(?:[?#]|$)/i.exec(url);
  return m ? m[1].toLowerCase() : '';
}

// Browsers may ask for encodings Node's fetch will not transparently decode
// (zstd today). We terminate encoding here and let the app's own compression
// middleware re-encode for the client, so we only forward what we can decode.
function upstreamAcceptEncoding(req) {
  const raw = String((req && req.headers && req.headers['accept-encoding']) || '');
  const safe = raw
    .split(',')
    .map(p => p.split(';')[0].trim().toLowerCase())
    .filter(p => p === 'gzip' || p === 'deflate' || p === 'br');
  return safe.length ? [...new Set(safe)].join(', ') : 'gzip, deflate, br';
}

// ── upstream fetches ──────────────────────────────────────────

async function fetchUpstream(url, timeoutMs, acceptEncoding) {
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      'User-Agent': FETCH_UA,
      'Accept-Encoding': acceptEncoding,
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res;
}

// Turn one upstream url() into a relative, same-origin one. Returns the
// replacement path, or null when we refuse to map it.
function mapFontUrl(raw) {
  let u;
  try {
    // Google emits absolute https URLs, but tolerate protocol-relative too.
    u = new URL(raw.startsWith('//') ? 'https:' + raw : raw, CSS_URL);
  } catch { return null; }
  if (u.protocol !== 'https:' || u.hostname !== FONT_HOST) return null;
  const url = u.toString();
  const id = idFor(url);
  if (!registry.has(id)) {
    if (registry.size >= MAX_REGISTRY) return null;
    registry.set(id, { url, ext: extOf(url) });
  }
  const ext = registry.get(id).ext;
  return 'file/' + id + (ext ? '.' + ext : '');
}

// url( ... ) in all three spellings CSS allows.
const URL_RE = /url\(\s*(?:'([^']*)'|"([^"]*)"|([^)\s'"]*))\s*\)/g;

function rewriteCss(css) {
  let mapped = 0;
  let dropped = 0;
  const out = css.replace(URL_RE, (whole, sq, dq, bare) => {
    const raw = (sq != null ? sq : dq != null ? dq : bare || '').trim();
    if (!raw) return whole;
    if (/^data:/i.test(raw)) return whole; // already same-origin-safe
    const rel = mapFontUrl(raw);
    if (rel) { mapped++; return 'url(' + rel + ')'; }
    // Anything we won't vouch for becomes a same-origin path that 404s, so the
    // browser falls back to the next font in the stack instead of reaching out.
    dropped++;
    return 'url(file/unsupported)';
  });
  if (dropped) logOnce(`${dropped} url() in the Google stylesheet were not ${FONT_HOST} and were dropped`);
  if (!mapped) throw new Error('no usable font URLs in stylesheet');
  return out;
}

// ── CSS state ──
let cssState = { body: null, etag: null, at: 0 };
let cssInflight = null;

async function loadCss(acceptEncoding) {
  if (cssInflight) return cssInflight; // single-flight: no stampede on cold start
  cssInflight = (async () => {
    const res = await fetchUpstream(CSS_URL, CSS_TIMEOUT_MS, acceptEncoding);
    const raw = await res.text();
    const body = rewriteCss(raw);
    cssState = {
      body,
      etag: '"c' + crypto.createHash('sha256').update(body).digest('hex').slice(0, 16) + '"',
      at: Date.now(),
    };
    return cssState;
  })();
  try {
    return await cssInflight;
  } finally {
    cssInflight = null;
  }
}

// ── font state ──
const fontInflight = new Map();

async function loadFont(id, acceptEncoding) {
  const cached = cacheGet('f:' + id);
  if (cached) return cached;
  if (fontInflight.has(id)) return fontInflight.get(id);

  const entry = registry.get(id);
  if (!entry) return null;

  const p = (async () => {
    // Belt and braces: the registry is already trusted, but re-check the host
    // right before the socket is opened.
    const u = new URL(entry.url);
    if (u.protocol !== 'https:' || u.hostname !== FONT_HOST) return null;

    const res = await fetchUpstream(entry.url, FONT_TIMEOUT_MS, acceptEncoding);
    const body = Buffer.from(await res.arrayBuffer());
    if (!body.length || body.length > MAX_FONT_BYTES) throw new Error(`implausible font size ${body.length}`);

    const upstreamType = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const type = ALLOWED_MIME.has(upstreamType)
      ? upstreamType
      : (MIME_BY_EXT[entry.ext] || 'application/octet-stream');

    const record = { body, type, etag: '"' + id + '"' };
    cacheSet('f:' + id, record);
    return record;
  })();

  fontInflight.set(id, p);
  try {
    return await p;
  } finally {
    fontInflight.delete(id);
  }
}

// ── router ───────────────────────────────────────────────────
const router = express.Router();

router.get('/css', async (req, res) => {
  // The stylesheet's url()s are relative, so they resolve against the
  // stylesheet's own URL. A trailing slash would shift that base one level
  // deeper, so step back out.
  const prefix = /\/$/.test(String(req.originalUrl || '').split('?')[0]) ? '../' : '';

  let state = cssState;
  try {
    if (!state.body || Date.now() - state.at > CSS_TTL_MS) {
      state = await loadCss(upstreamAcceptEncoding(req));
    }
  } catch (err) {
    logOnce('could not reach Google Fonts', err);
    // Stale beats empty: keep the last good stylesheet if we ever had one.
    if (!cssState.body) {
      res.set('Content-Type', 'text/css; charset=utf-8');
      res.set('Cache-Control', 'no-store'); // retry on the next page load
      return res.status(200).send('/* Google Fonts unavailable — using system fonts. */\n');
    }
    state = cssState;
  }

  const body = prefix ? state.body.split('url(file/').join('url(' + prefix + 'file/') : state.body;
  const etag = prefix ? state.etag.replace(/^"c/, '"d') : state.etag;

  res.set('Content-Type', 'text/css; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=86400');
  res.set('ETag', etag);
  if (req.headers['if-none-match'] === etag) return res.status(304).end();
  res.status(200).send(body);
});

router.get('/file/:id', async (req, res) => {
  // Accept "<id>" or the cosmetic "<id>.woff2" the stylesheet actually emits.
  const m = /^([a-f0-9]{16})(?:\.[a-z0-9]{2,5})?$/i.exec(String(req.params.id || ''));
  const id = m ? m[1].toLowerCase() : null;
  if (!id || !ID_RE.test(id) || !registry.has(id)) {
    return res.status(404).type('text/plain').send('Not found');
  }

  let record = null;
  try {
    record = await loadFont(id, upstreamAcceptEncoding(req));
  } catch (err) {
    logOnce('could not fetch a font file', err);
    record = null;
  }
  if (!record) return res.status(502).type('text/plain').send('Font unavailable');

  res.set('Content-Type', record.type);
  // gstatic URLs are content-versioned, so the bytes behind an id never change.
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.set('ETag', record.etag);
  res.set('Access-Control-Allow-Origin', '*'); // public bytes; helps if the CSS is ever cross-origin
  if (req.headers['if-none-match'] === record.etag) return res.status(304).end();
  res.status(200).send(record.body);
});

// ── warm() ───────────────────────────────────────────────────
// Optional prefetch so the first player doesn't pay for the round trips.
// Resolves to true if the stylesheet is ready. Never throws, never rejects.
async function warm() {
  try {
    if (!cssState.body || Date.now() - cssState.at > CSS_TTL_MS) {
      await loadCss('gzip, deflate, br');
    }
    const ids = [...registry.keys()];
    await Promise.allSettled(ids.map(id => loadFont(id, 'gzip, deflate, br')));
    return Boolean(cssState.body);
  } catch (err) {
    logOnce('warm-up failed', err);
    return false;
  }
}

module.exports = { router, warm };
