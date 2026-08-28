// ─────────────────────────────────────────────────────────────
// auth.js — accounts and session tokens.
// Sign-in happens exclusively through Discord OAuth (see api.js);
// this module owns the user records and bearer tokens.
// ─────────────────────────────────────────────────────────────
const crypto = require('crypto');
const store = require('./store');

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

function findOrCreateDiscordUser({ discordId, username, avatarHash }) {
  let user = Object.values(store.db.users).find(u => u.discordId === discordId);
  const cleanName = String(username || 'Player').replace(/\s+/g, ' ').trim().slice(0, 20) || 'Player';
  const avatarUrl = discordAvatarUrl(discordId, avatarHash);
  if (user) {
    // Keep the display name and picture in sync with Discord.
    let changed = false;
    if (user.username !== cleanName) { user.username = cleanName; changed = true; }
    if (user.avatarUrl !== avatarUrl) { user.avatarUrl = avatarUrl; changed = true; }
    if (changed) store.scheduleSave();
    return user;
  }
  const id = store.newId();
  user = {
    id,
    discordId,
    username: cleanName,
    created: Date.now(),
    avatar: { emoji: '🦌', color: '#6C5CE7' },
    avatarUrl,
    settings: { autosaveDrawings: true },
    stats: { games: 0, wins: 0, points: 0, guesses: 0, wordsDrawn: 0, likes: 0 },
  };
  store.db.users[id] = user;
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
    username: clean,
    created: Date.now(),
    avatar: { emoji: '🧪', color: '#6C5CE7' },
    settings: { autosaveDrawings: true },
    stats: { games: 0, wins: 0, points: 0, guesses: 0, wordsDrawn: 0, likes: 0 },
  };
  store.db.users[id] = user;
  store.scheduleSave();
  return user;
}

function createToken(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  store.db.tokens[token] = { userId, created: Date.now() };
  store.scheduleSave();
  return token;
}

function deleteToken(token) {
  if (token && store.db.tokens[token]) {
    delete store.db.tokens[token];
    store.scheduleSave();
  }
}

// Resolve a token to a user (or null).
function userForToken(token) {
  if (typeof token !== 'string' || token.length < 20) return null;
  const info = store.db.tokens[token];
  if (!info) return null;
  return store.db.users[info.userId] || null;
}

// Public-safe view of a user record.
function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    avatar: user.avatar,
    avatarUrl: user.avatarUrl || null,
    settings: user.settings,
    stats: user.stats,
    created: user.created,
  };
}

module.exports = {
  discordAvatarUrl,
  findOrCreateDiscordUser,
  findOrCreateTestUser,
  createToken,
  deleteToken,
  userForToken,
  publicUser,
};
