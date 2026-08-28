// ─────────────────────────────────────────────────────────────
// legal.js — the privacy policy and terms, as part of the site.
//
// The markdown files in docs/ stay the single source of truth; this
// renders them into the app's own styling, both as standalone pages
// (for Discord's Developer Portal, which wants real URLs) and as
// JSON for the in-app reader.
// ─────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const markdown = require('./markdown');

const DOCS = {
  privacy: { file: 'PRIVACY.md', fallbackTitle: 'Privacy Policy' },
  terms: { file: 'TERMS.md', fallbackTitle: 'Terms of Service' },
};

const cache = new Map();   // slug -> { title, html, mtime }

function load(slug) {
  const doc = Object.prototype.hasOwnProperty.call(DOCS, slug) ? DOCS[slug] : null;
  if (!doc) return null;
  const file = path.join(__dirname, '..', 'docs', doc.file);
  let stat;
  try { stat = fs.statSync(file); } catch (e) { return null; }

  const hit = cache.get(slug);
  if (hit && hit.mtime === stat.mtimeMs) return hit;

  let source;
  try { source = fs.readFileSync(file, 'utf8'); } catch (e) { return null; }
  const entry = {
    title: markdown.title(source, doc.fallbackTitle),
    html: markdown.toHtml(source),
    mtime: stat.mtimeMs,
  };
  cache.set(slug, entry);
  return entry;
}

// A standalone page, styled like the rest of the site.
function page(slug) {
  const entry = load(slug);
  if (!entry) return null;
  const other = slug === 'privacy' ? 'terms' : 'privacy';
  const otherLabel = slug === 'privacy' ? 'Terms of Service' : 'Privacy Policy';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${markdown.escapeHtml(entry.title)} — Mivimoose Draw</title>
<meta name="robots" content="noindex" />
<link rel="stylesheet" href="/fonts/css" />
<link rel="stylesheet" href="/css/style.css" />
</head>
<body>
<main class="legal-page">
  <a class="legal-back" href="/">← Back to the game</a>
  <article class="legal-doc">
${entry.html}
  </article>
  <p class="legal-foot"><a href="/${other}">${otherLabel}</a></p>
</main>
</body>
</html>`;
}

function data(slug) {
  const entry = load(slug);
  return entry ? { title: entry.title, html: entry.html } : null;
}

module.exports = { page, data, slugs: Object.keys(DOCS) };
