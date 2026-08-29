// ─────────────────────────────────────────────────────────────
// unzip.js — a minimal ZIP reader, the mirror of zip.js.
//
// Used when a host imports a .zip full of .txt word lists. Reads
// the central directory (never trusting local headers, which can
// carry streamed sizes), and refuses anything that looks like a
// zip bomb or a path-traversal attempt.
// ─────────────────────────────────────────────────────────────
const zlib = require('zlib');

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

// The EOCD sits at the very end, after a comment of up to 64KB.
function findEocd(buf) {
  const min = 22;
  if (buf.length < min) return -1;
  const start = Math.max(0, buf.length - (min + 0xFFFF));
  for (let i = buf.length - min; i >= start; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      // Guard against the signature turning up inside a comment.
      const commentLen = buf.readUInt16LE(i + 20);
      if (i + min + commentLen === buf.length) return i;
    }
  }
  return -1;
}

// Reject anything that would escape the folder we unpack into. We only ever
// use the base name, but a traversal attempt is a good reason to skip.
function safeEntryName(raw) {
  const name = String(raw || '').replace(/\\/g, '/');
  if (!name || name.endsWith('/')) return null;             // directory entry
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return null;
  if (name.split('/').some(part => part === '..')) return null;
  const base = name.slice(name.lastIndexOf('/') + 1).trim();
  if (!base || base === '.' || base === '..') return null;
  return base;
}

function hasExtension(name, extensions) {
  const lower = name.toLowerCase();
  return extensions.some(ext => lower.endsWith(ext.toLowerCase()));
}

function decodeText(buf) {
  let text = buf.toString('utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  return text;
}

/**
 * Pull the text files out of a ZIP buffer.
 * Returns [{ name, text }] — entries that are unreadable, the wrong type or
 * over budget are skipped rather than throwing.
 */
function readTextFiles(buffer, opts = {}) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  const maxFiles = opts.maxFiles || 200;
  const maxTotalBytes = opts.maxTotalBytes || 20 * 1024 * 1024;
  const maxFileBytes = opts.maxFileBytes || 5 * 1024 * 1024;
  const extensions = opts.extensions || ['.txt'];

  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('Not a zip file');

  const count = buf.readUInt16LE(eocd + 10);
  let pos = buf.readUInt32LE(eocd + 16);
  const cenSize = buf.readUInt32LE(eocd + 12);
  if (pos + cenSize > buf.length) throw new Error('Not a zip file');

  const out = [];
  let budget = maxTotalBytes;

  for (let i = 0; i < count && out.length < maxFiles; i++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== CEN_SIG) break;

    const method = buf.readUInt16LE(pos + 10);
    const compSize = buf.readUInt32LE(pos + 20);
    const rawSize = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localOff = buf.readUInt32LE(pos + 42);
    const rawName = buf.slice(pos + 46, pos + 46 + nameLen).toString('utf8');
    pos += 46 + nameLen + extraLen + commentLen;

    const name = safeEntryName(rawName);
    if (!name) continue;
    if (!hasExtension(name, extensions)) continue;
    if (method !== 0 && method !== 8) continue;

    // Check the *declared* size against the budget before inflating anything,
    // so a bomb never gets expanded in the first place.
    if (rawSize > maxFileBytes || rawSize > budget) continue;

    // Walk past the local header to the body. Its name/extra lengths can
    // differ from the central directory's, so read them here.
    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== LOC_SIG) continue;
    const locNameLen = buf.readUInt16LE(localOff + 26);
    const locExtraLen = buf.readUInt16LE(localOff + 28);
    const bodyStart = localOff + 30 + locNameLen + locExtraLen;
    const bodyEnd = bodyStart + compSize;
    if (bodyEnd > buf.length) continue;
    const body = buf.slice(bodyStart, bodyEnd);

    let raw;
    try {
      raw = method === 0 ? body : zlib.inflateRawSync(body, { maxOutputLength: rawSize + 1 });
    } catch (e) {
      continue;                                   // corrupt or lying about its size
    }
    if (raw.length > maxFileBytes || raw.length > budget) continue;

    budget -= raw.length;
    out.push({ name, text: decodeText(raw) });
  }

  return out;
}

module.exports = { readTextFiles, safeEntryName, findEocd };
