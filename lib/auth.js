// ─────────────────────────────────────────────────────────────
// auth.js — accounts and session tokens.
// Sign-in happens exclusively through Discord OAuth (see api.js);
// this module owns the user records and bearer tokens.
// ─────────────────────────────────────────────────────────────
const crypto = require('crypto');
const store = require('./store');
const stats = require('./stats');

// Find the account linked to a Discord user, or create one.
// Build the CDN url for a Discord user's picture, falling back to one of
// Discord's own default avatars when they have not set one.
function discordAvatarUrl(id, hash) {
  if (hash) {
    const ext = String(hash).startsWith('a_') ? 'gif' : 'png';
    return `https://cdn.discordapp.com/avatars/${id}/${hash}.${ext}?size=128`;
  }
  let index = 0;
  try { index = Number((BigInt(id) >> 22n) % 6n); } catch (e) { index = 0; }
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

// Usernames are how people find each other, so no two accounts share one.
// A clash gets a numeric suffix — "Silk", "Silk2", "Silk3" …
function usernameTaken(name, exceptId) {
  const lower = String(name).toLowerCase();
  return Object.values(store.db.users)
    .some(u => u.id !== exceptId && String(u.username || '').toLowerCase() === lower);
}

function uniqueUsername(base, exceptId) {
  let name = String(base || 'Player').replace(/\s+/g, ' ').trim().slice(0, 20) || 'Player';
  if (!usernameTaken(name, exceptId)) return name;
  for (let n = 2; n < 1000; n++) {
    const suffix = String(n);
    const candidate = name.slice(0, 20 - suffix.length) + suffix;
    if (!usernameTaken(candidate, exceptId)) return candidate;
  }
  return name.slice(0, 14) + Date.now().toString(36).slice(-6);
}

function findOrCreateDiscordUser({ discordId, username, avatarHash }) {
  let user = Object.values(store.db.users).find(u => u.discordId === discordId);
  const cleanName = String(username || 'Player').replace(/\s+/g, ' ').trim().slice(0, 20) || 'Player';
  const avatarUrl = discordAvatarUrl(discordId, avatarHash);
  if (user) {
    let changed = false;
    // Follow their Discord name only while they have not picked their own,
    // and never onto a name somebody else already holds.
    if (!user.nameSetByUser && user.username !== cleanName && !usernameTaken(cleanName, user.id)) {
      user.username = cleanName;
      changed = true;
    }
    if (user.avatarUrl !== avatarUrl) { user.avatarUrl = avatarUrl; changed = true; }
    // Older accounts predate both of these.
    if (!user.settings) { user.settings = { autosaveDrawings: true }; changed = true; }
    else if (user.settings.autosaveDrawings === undefined) { user.settings.autosaveDrawings = true; changed = true; }
    if (!user.prefs || typeof user.prefs !== 'object') { user.prefs = {}; changed = true; }
    if (!user.stats) {
      // Without this the account scores nothing and never reaches the
      // leaderboard — silently, because every caller guards on `if (stats)`.
      user.stats = { games: 0, wins: 0, points: 0, guesses: 0, wordsDrawn: 0, likes: 0 };
      changed = true;
    }
    if (changed) store.scheduleSave();
    return user;
  }
  const id = store.newId();
  user = {
    id,
    discordId,
    username: uniqueUsername(cleanName, id),
    created: Date.now(),
    avatar: { emoji: '🦌', color: '#6C5CE7' },
    avatarUrl,
    settings: { autosaveDrawings: true },
    prefs: {},
    prefsUpdated: 0,
    stats: { games: 0, wins: 0, points: 0, guesses: 0, wordsDrawn: 0, likes: 0 },
    friends: [], requestsIn: [], requestsOut: [],
  };
  store.db.users[id] = user;
  stats.countAccount();
  store.scheduleSave();
  return user;
}

// Smoke-test only — password-less local account, gated behind
// config.allowTestLogin. Never reachable in normal operation.
function findOrCreateTestUser(username) {
  const clean = String(username || '').trim().slice(0, 20);
  if (!clean) return null;
  let user = Object.values(store.db.users).find(u => u.testUser && u.username === clean);
  if (user) return user;
  const id = store.newId();
  user = {
    id,
    testUser: true,
    username: uniqueUsername(clean, id),
    created: Date.now(),
    avatar: { emoji: '🧪', color: '#6C5CE7' },
    settings: { autosaveDrawings: true },
    prefs: {},
    prefsUpdated: 0,
    stats: { games: 0, wins: 0, points: 0, guesses: 0, wordsDrawn: 0, likes: 0 },
    friends: [], requestsIn: [], requestsOut: [],
  };
  store.db.users[id] = user;
  store.scheduleSave();
  return user;
}

// ── Session tokens ──
// The raw token is handed to the browser once and never stored. What the
// database holds is its SHA-256, so a leaked dump — a backup, a log line, a
// read-only replica — cannot be replayed as somebody's login.
function tokenHash(token) {
  return store.sha256(token);
}

function createToken(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  store.db.tokens[tokenHash(token)] = { userId, created: now, lastSeen: now };
  store.scheduleSave();
  return token;
}

function deleteToken(token) {
  if (typeof token !== 'string' || !token) return;
  const hash = tokenHash(token);
  if (store.db.tokens[hash]) {
    delete store.db.tokens[hash];
    store.scheduleSave();
  }
}

/** Drop every session for an account — "sign out everywhere". */
function deleteAllTokens(userId) {
  let removed = 0;
  for (const [hash, info] of Object.entries(store.db.tokens)) {
    if (info && info.userId === userId) { delete store.db.tokens[hash]; removed++; }
  }
  if (removed) store.scheduleSave();
  return removed;
}

// Sessions idle for this long stop resolving, and store.pruneTokens() clears
// them out for good.
const SESSION_TTL_MS = 90 * 24 * 3600 * 1000;
// `lastSeen` is what keeps an active session alive, but writing it on every
// single request would mark the row dirty constantly for no benefit.
const LAST_SEEN_GRANULARITY_MS = 6 * 3600 * 1000;

// Resolve a token to a user (or null).
function userForToken(token) {
  if (typeof token !== 'string' || token.length < 20) return null;
  const info = store.db.tokens[tokenHash(token)];
  if (!info) return null;
  const now = Date.now();
  const last = Math.max(Number(info.lastSeen) || 0, Number(info.created) || 0);
  if (now - last > SESSION_TTL_MS) return null;
  const user = store.db.users[info.userId] || null;
  if (!user) return null;
  if (now - last > LAST_SEEN_GRANULARITY_MS) {
    info.lastSeen = now;
    store.scheduleSave();
  }
  return user;
}

// Public-safe view of a user record.
function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    avatar: user.avatar,
    avatarUrl: user.avatarUrl || null,
    settings: user.settings,
    // A copy, not the live object: the client cache used to be able to alias
    // straight into the database row.
    stats: { ...(user.stats || {}) },
    prefs: user.prefs || {},
    prefsUpdated: Number(user.prefsUpdated) || 0,
    created: user.created,
  };
}

module.exports = {
  usernameTaken,
  uniqueUsername,
  discordAvatarUrl,
  findOrCreateDiscordUser,
  findOrCreateTestUser,
  createToken,
  deleteToken,
  deleteAllTokens,
  tokenHash,
  userForToken,
  publicUser,
  SESSION_TTL_MS,
};
