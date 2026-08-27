// ─────────────────────────────────────────────────────────────
// store.js — zero-dependency JSON persistence layer.
// Everything lives in memory and is flushed to data/db.json with
// atomic, debounced writes. Drawing PNGs are stored as individual
// files in data/drawings/.
// ─────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// MIVI_DATA_DIR lets the smoke test (or a deployment) point elsewhere.
const DATA_DIR = process.env.MIVI_DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const TMP_FILE = path.join(DATA_DIR, 'db.json.tmp');
const DRAWINGS_DIR = path.join(DATA_DIR, 'drawings');

const db = {
  users: {},     // id -> { id, discordId, username, created, avatar, settings, stats }
  tokens: {},    // token -> { userId, created }
  lists: {},     // id -> { id, ownerId, name, words[], created, updated }
  drawings: {},  // id -> { id, ownerId, word, artist, roomCode, created, file, guessedCount, playerCount, likes }
  library: {},   // id -> { id, ownerId, author, name, words[], created, downloads }
};

let dirty = false;
let saveTimer = null;

function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(DRAWINGS_DIR, { recursive: true });
}

function load() {
  ensureDirs();
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      for (const key of Object.keys(db)) {
        if (raw[key] && typeof raw[key] === 'object') db[key] = raw[key];
      }
    }
  } catch (e) {
    console.error('⚠️  Could not read data/db.json — starting fresh.', e.message);
    // Keep a backup of the corrupt file so nothing is silently lost.
    try { fs.copyFileSync(DB_FILE, DB_FILE + '.corrupt-' + Date.now()); } catch (_) {}
  }
  pruneTokens();
}

function saveNow() {
  if (!dirty) return;
  try {
    fs.writeFileSync(TMP_FILE, JSON.stringify(db));
    fs.renameSync(TMP_FILE, DB_FILE); // atomic replace
    dirty = false;
  } catch (e) {
    console.error('⚠️  Failed to save database:', e.message);
  }
}

function scheduleSave() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveNow();
  }, 400);
}

// Prune session tokens older than 90 days.
function pruneTokens() {
  const cutoff = Date.now() - 90 * 24 * 3600 * 1000;
  let removed = 0;
  for (const [tok, info] of Object.entries(db.tokens)) {
    if (!info || info.created < cutoff || !db.users[info.userId]) {
      delete db.tokens[tok];
      removed++;
    }
  }
  if (removed > 0) scheduleSave();
}

function newId() {
  return crypto.randomBytes(8).toString('hex');
}

// ── Drawings on disk ──
function drawingPath(id) {
  // ids are our own hex strings — sanitize anyway
  return path.join(DRAWINGS_DIR, id.replace(/[^a-f0-9]/g, '') + '.png');
}

function saveDrawingFile(id, pngBuffer) {
  ensureDirs();
  fs.writeFileSync(drawingPath(id), pngBuffer);
}

function readDrawingFile(id) {
  const p = drawingPath(id);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p);
}

function deleteDrawingFile(id) {
  try { fs.unlinkSync(drawingPath(id)); } catch (_) {}
}

// Flush on shutdown so nothing recent is lost.
function installExitHooks() {
  const flush = () => { try { saveNow(); } catch (_) {} };
  process.on('exit', flush);
  process.on('SIGINT', () => { flush(); process.exit(0); });
  process.on('SIGTERM', () => { flush(); process.exit(0); });
}

load();
installExitHooks();
// Re-prune expired tokens periodically (not just at boot).
setInterval(pruneTokens, 60 * 60 * 1000).unref();

module.exports = {
  db,
  newId,
  scheduleSave,
  saveNow,
  saveDrawingFile,
  readDrawingFile,
  deleteDrawingFile,
};
