// ─────────────────────────────────────────────────────────────
// downloads.js — short-lived, one-off file handoffs.
//
// Some downloads are authorised over the socket (where we know who
// the host is) but have to be fetched over HTTP so the browser
// treats them as a real file. The socket stashes the bytes here and
// hands the client a token; the REST route trades it back.
// ─────────────────────────────────────────────────────────────
const crypto = require('crypto');

const TTL_MS = 2 * 60 * 1000;   // a token is only good for two minutes
const MAX_PENDING = 40;         // and we never hold many at once

const pending = new Map();      // token -> { buffer, filename, type, expires }

function sweep() {
  const now = Date.now();
  for (const [token, entry] of pending) {
    if (entry.expires <= now) pending.delete(token);
  }
  // If something goes wrong upstream, drop the oldest rather than grow.
  while (pending.size > MAX_PENDING) {
    pending.delete(pending.keys().next().value);
  }
}
setInterval(sweep, 30 * 1000).unref();

function stash(buffer, filename, type) {
  sweep();
  const token = crypto.randomBytes(16).toString('hex');
  pending.set(token, {
    buffer,
    filename: String(filename || 'download'),
    type: type || 'application/octet-stream',
    expires: Date.now() + TTL_MS,
  });
  return token;
}

// Left in place until it expires, so a retried download still works.
function peek(token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{32}$/.test(token)) return null;
  const entry = pending.get(token);
  if (!entry) return null;
  if (entry.expires <= Date.now()) { pending.delete(token); return null; }
  return entry;
}

module.exports = { stash, peek, TTL_MS };
