// ─────────────────────────────────────────────────────────────
// api.js — REST endpoints: accounts, word lists, drawing gallery,
// public room browser.
// ─────────────────────────────────────────────────────────────
const express = require('express');
const crypto = require('crypto');
const store = require('./store');
const auth = require('./auth');
const game = require('./game');
const config = require('./config');
const profanity = require('../public/js/profanity');
const friends = require('./friends');
const moderation = require('./moderation');
const downloads = require('./downloads');
const legal = require('./legal');
const unzip = require('./unzip');
const stats = require('./stats');
const version = require('./version');
const ai = require('./ai');

const router = express.Router();


// `store.db.lists[id]` with an id straight off the URL can reach
// Object.prototype members ("constructor", "__proto__"). Every lookup goes
// through here instead.
function own(collection, id) {
  return (typeof id === 'string' && Object.prototype.hasOwnProperty.call(collection, id))
    ? collection[id] : null;
}

const MAX_DRAWINGS_PER_USER = 500;
const MAX_LISTS_PER_USER = 200;
const MAX_LIST_WORDS = 50000;        // per list — effectively unlimited
const MAX_TOTAL_WORDS_PER_USER = 250000; // across all lists, keeps db.json writable
const MAX_PNG_BYTES = 3 * 1024 * 1024;
const MAX_GIF_BYTES = 12 * 1024 * 1024;  // a whole game's recap
const MAX_LIBRARY_LISTS = 500;       // shared library, whole server
const MAX_LIBRARY_WORDS = 5000;      // per shared list
const MAX_ZIP_BYTES = 8 * 1024 * 1024;   // an imported .zip of word lists

// ── Per-IP sliding-window rate limiter ──
// Separate buckets per label so hammering one endpoint can't lock out others.
const attempts = new Map(); // "label|ip" -> [timestamps]
// Sweep idle entries so the map can't grow without bound.
setInterval(() => {
  const now = Date.now();
  for (const [key, list] of attempts) {
    const fresh = list.filter(t => now - t < 60 * 60 * 1000);
    if (fresh.length === 0) attempts.delete(key);
    else attempts.set(key, fresh);
  }
}, 5 * 60 * 1000).unref();

function rateLimited(req, label = 'auth', limit = 10, windowMs = 60 * 1000) {
  const ip = req.ip || req.socket.remoteAddress || '?';
  const key = label + '|' + ip;
  const now = Date.now();
  const list = (attempts.get(key) || []).filter(t => now - t < windowMs);
  list.push(now);
  attempts.set(key, list);
  return list.length > limit;
}

// ── Cookies ──
// Hand-rolled rather than pulling in cookie-parser: two headers, no parsing
// surprises, and one fewer dependency in a project that has kept its list short.
function cookies(req) {
  const raw = req.headers.cookie || '';
  const out = {};
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); }
    catch (e) { out[k] = part.slice(i + 1).trim(); }
  }
  return out;
}

// Secure only over HTTPS — a Secure cookie on plain http://localhost is
// simply dropped, which would break every local dev session.
function isSecureRequest(req) {
  return req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function setCookie(req, res, name, value, maxAgeMs) {
  const bits = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (isSecureRequest(req)) bits.push('Secure');
  const prev = res.getHeader('Set-Cookie');
  const list = prev ? (Array.isArray(prev) ? prev.slice() : [prev]) : [];
  list.push(bits.join('; '));
  res.setHeader('Set-Cookie', list);
}

function clearCookie(req, res, name) {
  setCookie(req, res, name, "", 0);
}

const SESSION_COOKIE = 'mivi_session';
const OAUTH_COOKIE = 'mivi_oauth';

// The session token. The Authorization header wins, because that is what the
// Discord Activity uses — an iframe on discordsays.com cannot rely on our
// cookies surviving third-party cookie blocking. The cookie is the fallback
// that keeps a normal browser signed in even when localStorage is blocked
// (private windows, "block site data"), which used to log people straight out.
function bearer(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  const fromCookie = cookies(req)[SESSION_COOKIE];
  if (!fromCookie) return null;
  // A cookie rides along automatically, so on its own it would make every
  // mutating endpoint CSRF-able. SameSite=Lax already blocks cross-site form
  // posts; this refuses anything that announces a foreign origin as well.
  if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req)) return null;
  return fromCookie;
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;                 // same-origin fetches often send none
  try {
    const host = new URL(origin).host;
    if (host === req.headers.host) return true;
    if (config.baseUrl && host === new URL(config.baseUrl).host) return true;
    // The Activity is framed by Discord and legitimately posts from there.
    return config.activityEnabled && /(^|\.)discordsays\.com$/.test(host);
  } catch (e) { return false; }
}

// ── Answer only once the change is actually in the database ──
// Handlers mutate the in-memory mirror and call store.scheduleSave(), which
// batches the write. For anything a player can see, "saved" has to mean
// committed — otherwise a redeploy landing in that window loses a change the
// UI already confirmed. Wrapping res.json here gives every mutating route the
// guarantee at once, instead of forty hand-written awaits that drift apart.
router.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const json = res.json.bind(res);
  res.json = function (body) {
    if (res.statusCode >= 400) return json(body);   // nothing changed; nothing to wait for
    store.flush().then(() => {
      if (store.healthy) return json(body);
      res.status(503);
      json({ error: 'The database is not reachable right now — that change was not saved.' });
    });
    return res;
  };
  next();
});

// Populate req.user when a valid token is supplied.
function requireAuth(req, res, next) {
  const user = auth.userForToken(bearer(req));
  if (!user) return res.status(401).json({ error: 'Not signed in.' });
  req.user = user;
  next();
}

// ═══ Auth — Discord OAuth only ═══
// Pending OAuth "state" values (CSRF protection), short-lived.
const oauthStates = new Map(); // state -> createdAt
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [s, t] of oauthStates) if (t < cutoff) oauthStates.delete(s);
}, 60 * 1000).unref();

const discordRedirect = () => config.discordRedirectUri;


// ═══ Leaderboard ═══
// The top players in each category, straight from account stats. Public —
// it is a leaderboard.
const LB_CATEGORIES = {
  games: { label: 'Games played', stat: 'games' },
  wins: { label: 'Wins', stat: 'wins' },
  points: { label: 'Points', stat: 'points' },
  guesses: { label: 'Words guessed', stat: 'guesses' },
  drawn: { label: 'Words drawn', stat: 'wordsDrawn' },
  likes: { label: 'Likes received', stat: 'likes' },
};

router.get('/leaderboard', (req, res) => {
  const users = Object.values(store.db.users).filter(u => u.stats);
  const me = auth.userForToken(bearer(req));
  const out = {};
  for (const [key, spec] of Object.entries(LB_CATEGORIES)) {
    const ranked = users
      .map(u => ({ u, v: Number(u.stats[spec.stat]) || 0 }))
      .filter(r => r.v > 0)
      .sort((a, b) => b.v - a.v)
      .slice(0, 25);
    out[key] = {
      label: spec.label,
      rows: ranked.map((r, i) => ({
        rank: i + 1,
        username: r.u.username,
        avatarUrl: r.u.avatarUrl || null,
        avatar: r.u.avatar || null,
        value: r.v,
        me: !!(me && me.id === r.u.id),
      })),
    };
    // Where do I sit, if not in the top slice?
    if (me && me.stats) {
      const myV = Number(me.stats[spec.stat]) || 0;
      const above = users.filter(u => (Number(u.stats[spec.stat]) || 0) > myV).length;
      out[key].myRank = myV > 0 ? above + 1 : null;
      out[key].myValue = myV;
    }
  }
  res.json({ categories: out, players: users.length });
});

router.get('/auth/config', (req, res) => {
  res.json({
    version: version.VERSION,
    versionLabel: version.LABEL,
    discord: config.discordConfigured,
    // The client id is public (it already rides in the OAuth URL) and the
    // Activity client needs it to open its handshake with Discord.
    clientId: config.discordClientId || null,
    activity: !!config.activityEnabled,
  });
});

router.get('/auth/discord', (req, res) => {
  if (!config.discordConfigured) {
    return res.status(503).send('Discord sign-in is not set up on this server yet — see the README for the two-minute setup.');
  }
  if (rateLimited(req, 'oauth', 20, 60 * 1000)) return res.status(429).send('Too many attempts — give it a minute.');
  const state = crypto.randomBytes(16).toString('hex');
  oauthStates.set(state, Date.now());
  // The state is also written to a short-lived httpOnly cookie. Without that
  // binding, a state minted in the attacker's browser validates in the
  // victim's, which is a login-CSRF: the victim silently ends up signed into
  // somebody else's account.
  setCookie(req, res, OAUTH_COOKIE, state, 10 * 60 * 1000);
  const url = 'https://discord.com/oauth2/authorize'
    + '?client_id=' + encodeURIComponent(config.discordClientId)
    + '&response_type=code'
    + '&redirect_uri=' + encodeURIComponent(discordRedirect())
    + '&scope=identify'
    + '&state=' + state;
  res.redirect(url);
});

router.get('/auth/discord/callback', async (req, res) => {
  const fail = (msg) => res.redirect('/#autherr=' + encodeURIComponent(msg));
  try {
    if (!config.discordConfigured) return fail('Discord sign-in is not configured.');
    const { code, state } = req.query;
    const expected = cookies(req)[OAUTH_COOKIE];
    clearCookie(req, res, OAUTH_COOKIE);
    if (!code || !state) return fail('That sign-in attempt expired — please try again.');
    // Both halves have to agree: the server minted this state, AND it was
    // minted for this browser.
    const known = oauthStates.has(String(state));
    oauthStates.delete(String(state));
    if (!known || !expected || expected !== String(state)) {
      return fail('That sign-in attempt expired — please try again.');
    }

    // Exchange the code for an access token.
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.discordClientId,
        client_secret: config.discordClientSecret,
        grant_type: 'authorization_code',
        code: String(code),
        redirect_uri: discordRedirect(),
      }),
    });
    if (!tokenRes.ok) return fail('Discord rejected the sign-in — please try again.');
    const tokenData = await tokenRes.json();

    // Who is this?
    const meRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    if (!meRes.ok) return fail('Could not read your Discord profile.');
    const me = await meRes.json();
    if (!me.id) return fail('Could not read your Discord profile.');

    const user = auth.findOrCreateDiscordUser({
      discordId: String(me.id),
      username: me.global_name || me.username || 'Player',
      avatarHash: me.avatar || null,
    });
    const token = auth.createToken(user.id);
    // Two carriers, deliberately. The fragment is what the client stores for
    // the Authorization header (and what the Discord Activity needs); the
    // httpOnly cookie is what keeps the session when localStorage is blocked,
    // and it is not readable by script, so an XSS cannot lift it.
    setCookie(req, res, SESSION_COOKIE, token, auth.SESSION_TTL_MS);
    // The token travels in the URL fragment so it never shows up in logs.
    await store.flush();
    res.redirect('/#authtoken=' + token);
  } catch (e) {
    console.error('Discord OAuth error:', e.message);
    fail('Something went wrong during sign-in — please try again.');
  }
});

// Signing in from inside a Discord Activity. The embedded client cannot do a
// redirect round-trip, so it hands us the authorization code from the SDK and
// we swap it for a token here (the client secret must never leave the server).
router.post('/auth/discord/activity', async (req, res) => {
  if (!config.discordConfigured) return res.status(503).json({ error: 'Discord is not set up on this server.' });
  if (rateLimited(req, 'oauth', 30, 60 * 1000)) return res.status(429).json({ error: 'Too many attempts — give it a minute.' });
  const code = (req.body || {}).code;
  if (typeof code !== 'string' || !code || code.length > 512) {
    return res.status(400).json({ error: 'Missing authorization code.' });
  }
  try {
    // Note: no redirect_uri here — an Activity has none.
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.discordClientId,
        client_secret: config.discordClientSecret,
        grant_type: 'authorization_code',
        code,
      }),
    });
    if (!tokenRes.ok) return res.status(401).json({ error: 'Discord rejected that sign-in.' });
    const tokenData = await tokenRes.json();
    const meRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: 'Bearer ' + tokenData.access_token },
    });
    if (!meRes.ok) return res.status(401).json({ error: 'Could not read your Discord profile.' });
    const me = await meRes.json();
    if (!me.id) return res.status(401).json({ error: 'Could not read your Discord profile.' });
    const user = auth.findOrCreateDiscordUser({
      discordId: String(me.id),
      username: me.global_name || me.username || 'Player',
      avatarHash: me.avatar || null,
    });
    res.json({
      token: auth.createToken(user.id),
      user: auth.publicUser(user),
      // Handed straight back to the SDK's authenticate() call.
      accessToken: tokenData.access_token,
    });
  } catch (e) {
    console.error('Activity sign-in failed:', e.message);
    res.status(500).json({ error: 'Sign-in failed — try relaunching the activity.' });
  }
});

// Smoke-test back door — only mounted when ALLOW_TEST_LOGIN=1.
// It creates a real account with a real session from nothing but a username,
// so on a durable shared database it would be instant impersonation of anyone
// — including the bootstrap moderator. Refuse to mount it there at all.
// pglite:// is the in-process test backend, so it does not count as a real
// deployment; a postgres:// URL does.
const REAL_DATABASE = /^postgres(ql)?:\/\//i
  .test(process.env.DATABASE_URL || process.env.POSTGRES_URL || '');
if (config.allowTestLogin && !REAL_DATABASE && process.env.NODE_ENV !== 'production') {
  router.post('/auth/test-login', (req, res) => {
    const user = auth.findOrCreateTestUser((req.body || {}).username);
    if (!user) return res.status(400).json({ error: 'Bad username.' });
    res.json({ token: auth.createToken(user.id), user: auth.publicUser(user) });
  });
}

router.post('/auth/logout', (req, res) => {
  auth.deleteToken(bearer(req));
  clearCookie(req, res, SESSION_COOKIE);
  res.json({ ok: true });
});

router.post('/auth/logout-all', requireAuth, (req, res) => {
  const removed = auth.deleteAllTokens(req.user.id);
  clearCookie(req, res, SESSION_COOKIE);
  res.json({ ok: true, signedOut: removed });
});

router.get('/auth/me', requireAuth, (req, res) => {
  res.json({ user: auth.publicUser(req.user) });
});

const USERNAME_RE = /^[\p{L}\p{N} _.'-]{3,20}$/u;

router.put('/auth/me', requireAuth, (req, res) => {
  const { avatar, settings, username } = req.body || {};
  if (username !== undefined) {
    if (rateLimited(req, 'rename', 8, 60 * 60 * 1000)) {
      return res.status(429).json({ error: 'Too many name changes — try again later.' });
    }
    const name = String(username).replace(/\s+/g, ' ').trim();
    if (!USERNAME_RE.test(name)) {
      return res.status(400).json({ error: 'Names are 3–20 characters: letters, numbers, spaces and . _ - \' only.' });
    }
    if (!profanity.isCleanName(name)) {
      return res.status(400).json({ error: 'Pick a friendlier name.' });
    }
    const taken = Object.values(store.db.users)
      .some(u => u.id !== req.user.id && String(u.username).toLowerCase() === name.toLowerCase());
    if (taken) return res.status(409).json({ error: 'Somebody already goes by that name.' });
    req.user.username = name;
    // From now on their Discord name does not overwrite this.
    req.user.nameSetByUser = true;
    // Their shared lists carry the author's name, so keep those in step.
    for (const l of Object.values(store.db.library)) {
      if (l.ownerId === req.user.id) l.author = name;
    }
  }
  if (avatar && typeof avatar === 'object') {
    const emoji = (typeof avatar.emoji === 'string' && avatar.emoji.length <= 8 && avatar.emoji.length > 0) ? avatar.emoji : req.user.avatar.emoji;
    const color = (typeof avatar.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(avatar.color)) ? avatar.color : req.user.avatar.color;
    req.user.avatar = { emoji, color };
  }
  if (settings && typeof settings === 'object') {
    if (settings.autosaveDrawings !== undefined) req.user.settings.autosaveDrawings = !!settings.autosaveDrawings;
  }
  store.scheduleSave();
  res.json({ user: auth.publicUser(req.user) });
});

// ═══ Account-synced preferences ═══
// Everything the game used to keep only in the browser: the theme, the UI
// scale, the four audio settings, the lobby setup you last used, and the name
// and avatar you play under. Signing in on a second device now brings them
// with you instead of starting from defaults.
//
// The blob is allow-listed key by key and size-capped — an account is a place
// for a player's settings, not free key/value storage for whatever the client
// feels like posting.

// Mirrors REMEMBERED_OPTS in public/js/app.js.
const REMEMBERED_OPTS = new Set([
  'rounds', 'roundTime', 'pickTime', 'wordChoices', 'hintCount', 'hintSpeed',
  'maxPlayers', 'autocorrectStrength', 'strokeLimit',
  'combinations', 'lockComboParts', 'hidden', 'coopMode', 'relayMode',
  'mirrorMode', 'oneColorMode', 'suddenDeath', 'wetPaint', 'tileReveal',
  'randomRoundTime', 'randomWordChoices', 'showWordSource', 'showPunctuation',
  'avoidRepeats', 'spamProtection', 'textTool', 'sceneBackgrounds', 'lockOnGuess',
]);

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : undefined);
const bool = (v) => (typeof v === 'boolean' ? v : undefined);
const range = (v, lo, hi, round) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi) return undefined;
  return round ? Math.round(n) : n;
};

const PREF_FIELDS = {
  theme: (v) => str(v, 24),
  scale: (v) => range(v, 50, 150, true),
  musicOn: bool,
  sfxOn: bool,
  musicVol: (v) => range(v, 0, 1),
  sfxVol: (v) => range(v, 0, 1),
  // What a guest plays as. Kept separate from the account username, which has
  // its own uniqueness rules and lives on the user row.
  name: (v) => str(v, 20),
  avatar: (v) => {
    if (!v || typeof v !== 'object') return undefined;
    const emoji = str(v.emoji, 8);
    if (!emoji) return undefined;
    const color = (typeof v.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(v.color)) ? v.color : '#6C5CE7';
    return { emoji, color };
  },
  gameOptions: (v) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      if (!REMEMBERED_OPTS.has(k)) continue;
      if (typeof val === 'boolean' || Number.isFinite(val)) out[k] = val;
      else if (typeof val === 'string' && val.length <= 24) out[k] = val;
    }
    return Object.keys(out).length ? out : undefined;
  },
};

const MAX_PREFS_BYTES = 16 * 1024;

function sanitizePrefs(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out = {};
  for (const [key, validate] of Object.entries(PREF_FIELDS)) {
    if (input[key] === undefined) continue;
    const clean = validate(input[key]);
    if (clean !== undefined) out[key] = clean;
  }
  return out;
}

router.get('/prefs', requireAuth, (req, res) => {
  res.json({ prefs: req.user.prefs || {}, updated: Number(req.user.prefsUpdated) || 0 });
});

// Last write wins, decided by the client's own clock stamp. If the account
// already holds something newer — another device saved while this tab was
// asleep — the newer copy is handed back rather than being trampled, and the
// client adopts it.
router.put('/prefs', requireAuth, (req, res) => {
  if (rateLimited(req, 'prefs', 120, 60 * 1000)) {
    return res.status(429).json({ error: 'Slow down a little.' });
  }
  const body = req.body || {};
  const incomingAt = Number(body.updated);
  const stamp = Number.isFinite(incomingAt) && incomingAt > 0 ? incomingAt : Date.now();
  const storedAt = Number(req.user.prefsUpdated) || 0;

  if (stamp < storedAt) {
    return res.json({ prefs: req.user.prefs || {}, updated: storedAt, stale: true });
  }

  // Unknown keys are dropped, not merged, so a bad client cannot slowly grow
  // the row. Known keys the client omitted keep their stored value.
  const merged = { ...(req.user.prefs || {}), ...sanitizePrefs(body.prefs) };
  if (JSON.stringify(merged).length > MAX_PREFS_BYTES) {
    return res.status(400).json({ error: 'Those settings are too large to save.' });
  }
  req.user.prefs = merged;
  // Never accept a stamp from the future: a device with a wrong clock would
  // otherwise pin the account and block every real update after it.
  req.user.prefsUpdated = Math.min(stamp, Date.now());
  store.scheduleSave();
  res.json({ prefs: merged, updated: req.user.prefsUpdated });
});

// ── Word lists (account) ──
function sanitizeListName(name) {
  const clean = String(name || '').trim().slice(0, 40).replace(/[^\p{L}\p{N} _\-'!?.]/gu, '').trim();
  if (!clean || /^(__proto__|constructor|prototype)$/i.test(clean)) return 'Imported list';
  return clean;
}

// Total words a user has stored across all their lists (optionally ignoring one).
function userTotalWords(userId, excludeListId) {
  return Object.values(store.db.lists)
    .filter(l => l.ownerId === userId && l.id !== excludeListId)
    .reduce((s, l) => s + l.words.length, 0);
}

function sanitizeWords(arr) {
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  const out = [];
  for (const item of arr) {
    if (typeof item !== 'string') continue;
    const w = item.replace(/\s+/g, ' ').trim().slice(0, 64);
    if (!w) continue;
    const lower = w.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(w);
    if (out.length >= MAX_LIST_WORDS) break;
  }
  return out;
}

function listSummary(list) {
  return {
    id: list.id, name: list.name, count: list.words.length,
    created: list.created, updated: list.updated,
    // Personal lists are private by default; a share token is opt-in.
    shared: !!list.shareToken,
    shareUrl: list.shareToken ? config.baseUrl + '/?list=' + list.shareToken : null,
  };
}

router.get('/lists', requireAuth, (req, res) => {
  const lists = Object.values(store.db.lists)
    .filter(l => l.ownerId === req.user.id)
    .sort((a, b) => b.updated - a.updated)
    .map(listSummary);
  res.json({ lists });
});

router.get('/lists/:id', requireAuth, (req, res) => {
  const list = own(store.db.lists, req.params.id);
  if (!list || list.ownerId !== req.user.id) return res.status(404).json({ error: 'List not found.' });
  res.json({ list: { ...listSummary(list), words: list.words } });
});

// A short, unguessable token so a personal list can be shared by link
// without being listed anywhere.
function shareTokenFor(list) {
  if (!list.shareToken) {
    list.shareToken = crypto.randomBytes(9).toString('base64url');
    store.scheduleSave();
  }
  return list.shareToken;
}

// Anyone with the link can read the list; nothing else is exposed.
router.get('/share/:token', (req, res) => {
  const token = String(req.params.token || '');
  const list = Object.values(store.db.lists).find(l => l.shareToken && l.shareToken === token);
  if (!list) return res.status(404).json({ error: 'That link does not point at a list any more.' });
  const owner = own(store.db.users, list.ownerId);
  res.json({
    list: {
      id: list.id,
      name: list.name,
      words: list.words,
      count: list.words.length,
      author: owner ? owner.username : 'Someone',
      created: list.created,
    },
  });
});

// Turn sharing on (or off) for one of your own lists.
router.post('/lists/:id/share', requireAuth, (req, res) => {
  const list = own(store.db.lists, req.params.id);
  if (!list || list.ownerId !== req.user.id) return res.status(404).json({ error: 'List not found.' });
  const on = (req.body || {}).shared !== false;
  if (!on) {
    delete list.shareToken;
    store.scheduleSave();
    return res.json({ shared: false, url: null });
  }
  const token = shareTokenFor(list);
  res.json({ shared: true, token, url: config.baseUrl + '/?list=' + token });
});

router.post('/lists', requireAuth, (req, res) => {
  if (rateLimited(req, 'lists', 60, 60 * 1000)) return res.status(429).json({ error: 'Slow down a little.' });
  const name = sanitizeListName((req.body || {}).name);
  const wordsArr = sanitizeWords((req.body || {}).words);
  if (wordsArr.length === 0) return res.status(400).json({ error: 'The list needs at least one word.' });
  const mine = Object.values(store.db.lists).filter(l => l.ownerId === req.user.id);
  if (mine.length >= MAX_LISTS_PER_USER) return res.status(400).json({ error: 'List limit reached.' });
  if (userTotalWords(req.user.id) + wordsArr.length > MAX_TOTAL_WORDS_PER_USER) {
    return res.status(400).json({ error: 'Total word storage limit reached.' });
  }
  const id = store.newId();
  const now = Date.now();
  store.db.lists[id] = { id, ownerId: req.user.id, name, words: wordsArr, created: now, updated: now };
  store.scheduleSave();
  res.json({ list: listSummary(store.db.lists[id]) });
});


// ── Import a .zip of .txt lists ──────────────────────────────
// The browser posts the zip as base64 (the JSON body parser is already
// wired up and this keeps us free of a multipart dependency).
router.post('/lists/import-zip', requireAuth, (req, res) => {
  if (rateLimited(req, 'zip-import', 10, 10 * 60 * 1000)) {
    return res.status(429).json({ error: 'That is a lot of importing — give it ten minutes.' });
  }
  const b64 = String((req.body || {}).zip || '');
  if (!b64) return res.status(400).json({ error: 'No file was attached.' });
  let buf;
  try {
    buf = Buffer.from(b64.replace(/^data:[^,]*,/, ''), 'base64');
  } catch (e) {
    return res.status(400).json({ error: 'That file could not be read.' });
  }
  if (buf.length > MAX_ZIP_BYTES) {
    return res.status(400).json({ error: 'That zip is too big — 8 MB is the limit.' });
  }

  let entries;
  try {
    entries = unzip.readTextFiles(buf, { maxFiles: 60, maxTotalBytes: 8 * 1024 * 1024 });
  } catch (e) {
    return res.status(400).json({ error: "That doesn't look like a .zip file." });
  }
  if (entries.length === 0) {
    return res.status(400).json({ error: 'No .txt files were found inside that zip.' });
  }

  const mine = Object.values(store.db.lists).filter(l => l.ownerId === req.user.id);
  let slots = MAX_LISTS_PER_USER - mine.length;
  let budget = MAX_TOTAL_WORDS_PER_USER - userTotalWords(req.user.id);

  const added = [];
  const skipped = [];
  for (const entry of entries) {
    if (slots <= 0) { skipped.push({ name: entry.name, why: 'you have hit your list limit' }); continue; }
    const name = sanitizeListName(entry.name.replace(/\.txt$/i, ''));
    const wordsArr = sanitizeWords(entry.text.split(/[\r\n,]+/));
    if (wordsArr.length === 0) { skipped.push({ name: entry.name, why: 'no usable words' }); continue; }
    if (wordsArr.length > budget) { skipped.push({ name: entry.name, why: 'not enough storage left' }); continue; }
    const id = store.newId();
    const now = Date.now();
    store.db.lists[id] = { id, ownerId: req.user.id, name, words: wordsArr, created: now, updated: now };
    added.push(listSummary(store.db.lists[id]));
    slots--;
    budget -= wordsArr.length;
  }
  if (added.length) store.scheduleSave();
  if (!added.length) {
    return res.status(400).json({ error: 'Nothing in that zip could be imported.', skipped });
  }
  res.json({ lists: added, skipped });
});

// ── Generate a list with OpenAI (moderators) ─────────────────
// Moderators bring their own API key; it is used for the one call and is
// never written down anywhere.
router.post('/mod/generate-list', requireMod, async (req, res) => {
  if (rateLimited(req, 'ai-gen', 20, 60 * 60 * 1000)) {
    return res.status(429).json({ error: 'Generation limit reached — try again in an hour.' });
  }
  const body = req.body || {};
  const apiKey = String(body.apiKey || '').trim();
  const topic = String(body.topic || '').trim();
  const targetChars = Math.max(200, Math.min(8000, parseInt(body.targetChars, 10) || 2000));

  let result;
  try {
    result = await ai.generateWordList({ apiKey, topic, targetChars });
  } catch (e) {
    return res.status(400).json({ error: e.message || 'The generator could not run.' });
  }

  // The same swear protection every shared list gets.
  const filtered = profanity.filter(sanitizeWords(result.words));
  if (filtered.clean.length === 0) {
    return res.status(400).json({ error: 'Everything it produced was filtered out — try a different topic.' });
  }
  res.json({
    words: filtered.clean,
    chars: filtered.clean.join(' ').length,
    removed: result.words.length - filtered.clean.length,
    model: result.model,
    topic,
  });
});

router.put('/lists/:id', requireAuth, (req, res) => {
  const list = own(store.db.lists, req.params.id);
  if (!list || list.ownerId !== req.user.id) return res.status(404).json({ error: 'List not found.' });
  const body = req.body || {};
  if (body.name !== undefined) {
    list.name = sanitizeListName(body.name);
  }
  if (body.words !== undefined) {
    const wordsArr = sanitizeWords(body.words);
    if (wordsArr.length === 0) return res.status(400).json({ error: 'The list needs at least one word.' });
    if (userTotalWords(req.user.id, list.id) + wordsArr.length > MAX_TOTAL_WORDS_PER_USER) {
      return res.status(400).json({ error: 'Total word storage limit reached.' });
    }
    list.words = wordsArr;
  }
  list.updated = Date.now();
  store.scheduleSave();
  res.json({ list: listSummary(list) });
});

router.delete('/lists/:id', requireAuth, (req, res) => {
  const list = own(store.db.lists, req.params.id);
  if (!list || list.ownerId !== req.user.id) return res.status(404).json({ error: 'List not found.' });
  delete store.db.lists[req.params.id];
  store.scheduleSave();
  res.json({ ok: true });
});

router.get('/lists/:id/export', requireAuth, (req, res) => {
  const list = own(store.db.lists, req.params.id);
  if (!list || list.ownerId !== req.user.id) return res.status(404).json({ error: 'List not found.' });
  const safe = list.name.replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'wordlist';
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${safe}.txt"`);
  res.send(list.words.join('\r\n'));
});

// ── Drawing gallery ──
router.get('/drawings', requireAuth, (req, res) => {
  const drawings = Object.values(store.db.drawings)
    .filter(d => d.ownerId === req.user.id)
    .sort((a, b) => b.created - a.created)
    .map(d => ({
      id: d.id, word: d.word, artist: d.artist, created: d.created,
      guessedCount: d.guessedCount, playerCount: d.playerCount, likes: d.likes,
      kind: d.kind || 'png',
      url: `/api/drawings/${d.id}/image`,
    }));
  res.json({ drawings });
});

router.post('/drawings', requireAuth, (req, res) => {
  if (rateLimited(req, 'drawings', 20, 60 * 1000)) return res.status(429).json({ error: 'Slow down a little.' });
  const { dataUrl, word, artist, guessedCount, playerCount, likes, roomCode } = req.body || {};
  const isGif = typeof dataUrl === 'string' && dataUrl.startsWith('data:image/gif;base64,');
  const isPng = typeof dataUrl === 'string' && dataUrl.startsWith('data:image/png;base64,');
  if (!isGif && !isPng) return res.status(400).json({ error: 'Invalid image.' });

  const prefix = isGif ? 'data:image/gif;base64,' : 'data:image/png;base64,';
  const b64 = dataUrl.slice(prefix.length);
  let buf;
  try { buf = Buffer.from(b64, 'base64'); } catch (_) { return res.status(400).json({ error: 'Invalid image.' }); }
  // A whole game's recap is naturally bigger than one round's snapshot.
  const cap = isGif ? MAX_GIF_BYTES : MAX_PNG_BYTES;
  if (buf.length === 0 || buf.length > cap) return res.status(400).json({ error: 'That file is too large to save.' });
  if (isGif) {
    if (buf.length < 6 || buf.toString('latin1', 0, 4) !== 'GIF8') return res.status(400).json({ error: 'Not a GIF.' });
  } else if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) {
    return res.status(400).json({ error: 'Not a PNG.' });
  }

  const mine = Object.values(store.db.drawings).filter(d => d.ownerId === req.user.id);
  if (mine.length >= MAX_DRAWINGS_PER_USER) {
    return res.status(400).json({ error: `Gallery is full (${MAX_DRAWINGS_PER_USER} drawings) — delete some first.` });
  }

  const id = store.newId();
  const kind = isGif ? 'gif' : 'png';
  store.saveDrawingFile(id, buf);
  store.db.drawings[id] = {
    id,
    kind,
    ownerId: req.user.id,
    word: String(word || '').slice(0, 80),
    artist: String(artist || '').slice(0, 50),
    roomCode: /^[A-Z0-9]{4,8}$/.test(String(roomCode || '')) ? String(roomCode) : undefined,
    created: Date.now(),
    guessedCount: Math.max(0, parseInt(guessedCount, 10) || 0),
    playerCount: Math.max(0, parseInt(playerCount, 10) || 0),
    likes: Math.max(0, parseInt(likes, 10) || 0),
  };
  store.scheduleSave();
  res.json({ ok: true, id });
});

router.delete('/drawings/:id', requireAuth, (req, res) => {
  const d = own(store.db.drawings, req.params.id);
  if (!d || d.ownerId !== req.user.id) return res.status(404).json({ error: 'Drawing not found.' });
  store.deleteDrawingFile(d.id);
  delete store.db.drawings[d.id];
  store.scheduleSave();
  res.json({ ok: true });
});

// Images are served by unguessable random id so <img> tags work.
router.get('/drawings/:id/image', async (req, res) => {
  // Each hit is a blob read out of the database rather than a file off disk,
  // so it is worth a ceiling. A gallery page is ~30 images; this is generous.
  if (rateLimited(req, 'image', 240, 60 * 1000)) return res.status(429).end();
  const d = own(store.db.drawings, req.params.id);
  if (!d) return res.status(404).end();
  let buf;
  try { buf = await store.readDrawingFile(d.id); }
  catch (e) { return res.status(503).end(); }
  if (!buf) return res.status(404).end();
  res.setHeader('Content-Type', (d.kind === 'gif') ? 'image/gif' : 'image/png');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.send(buf);
});

// One-off file handoff: the socket authorised this and stashed the bytes,
// the token is unguessable and expires in a couple of minutes.
router.get('/download/:token', (req, res) => {
  const entry = downloads.peek(req.params.token);
  if (!entry) return res.status(404).json({ error: 'That download has expired — ask for it again.' });
  const safe = entry.filename.replace(/[^a-zA-Z0-9._-]/g, '') || 'download';
  res.setHeader('Content-Type', entry.type);
  res.setHeader('Content-Disposition', `attachment; filename="${safe}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(entry.buffer);
});

// ═══ Friends ═══
function friendView(u) {
  return { ...friends.brief(u), online: game.isOnline(u.id) };
}

router.get('/friends', requireAuth, (req, res) => {
  const me = friends.ensureFields(req.user);
  const users = ids => ids.map(friends.userById).filter(Boolean);
  res.json({
    code: friends.friendCode(me),
    friends: users(me.friends).map(friendView).sort((a, b) => (b.online - a.online) || a.username.localeCompare(b.username)),
    requestsIn: users(me.requestsIn).map(friends.brief),
    requestsOut: users(me.requestsOut).map(friends.brief),
  });
});

router.post('/friends/request', requireAuth, (req, res) => {
  if (rateLimited(req, 'friends', 30, 60 * 1000)) return res.status(429).json({ error: 'Slow down a little.' });
  const body = req.body || {};
  // Usernames are unique, so that is the friendly way in. The old friend
  // code still resolves for anyone who has one written down.
  const target = body.username
    ? friends.findByUsername(body.username)
    : friends.findByCode(body.code);
  if (!target) {
    return res.status(404).json({
      error: body.username ? 'Nobody goes by that username.' : 'No account has that friend code.',
    });
  }
  const r = friends.sendRequest(req.user, target);
  if (!r.ok) return res.status(400).json({ error: r.message });
  game.notifyUser(target.id, 'friendRequestReceived', { from: friends.brief(req.user), accepted: !!r.accepted });
  res.json({ ok: true, message: r.message, accepted: !!r.accepted });
});

router.post('/friends/accept', requireAuth, (req, res) => {
  const other = friends.userById((req.body || {}).userId);
  if (!other) return res.status(404).json({ error: 'Account not found.' });
  if (!friends.accept(req.user, other)) return res.status(400).json({ error: 'No request from them to accept.' });
  game.notifyUser(other.id, 'friendAccepted', { by: friends.brief(req.user) });
  res.json({ ok: true });
});

router.post('/friends/decline', requireAuth, (req, res) => {
  const other = friends.userById((req.body || {}).userId);
  if (other) friends.decline(req.user, other);
  res.json({ ok: true });
});

router.delete('/friends/:id', requireAuth, (req, res) => {
  const other = friends.userById(req.params.id);
  if (other) friends.remove(req.user, other);
  res.json({ ok: true });
});

// ═══ Moderators ═══
function requireMod(req, res, next) {
  const user = auth.userForToken(bearer(req));
  if (!user) return res.status(401).json({ error: 'Not signed in.' });
  if (!moderation.isMod(user)) return res.status(403).json({ error: 'Moderators only.' });
  // The fallback mod becomes a real one the first time they actually use the
  // powers — otherwise granting the badge to someone else would immediately
  // switch the fallback off and lock them out.
  if (moderation.isBootstrap(user)) moderation.grant(user);
  req.user = user;
  next();
}

router.get('/mod/me', requireAuth, (req, res) => {
  res.json({
    isMod: moderation.isMod(req.user),
    bootstrap: moderation.isBootstrap(req.user),
    anyMods: moderation.anyMods(),
    bootstrapName: moderation.BOOTSTRAP_NAME,
  });
});

// Everyone who holds the badge, plus anyone currently banned, plus an
// optional name search so a mod can find who they're looking for.
router.get('/mod/users', requireMod, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const all = Object.values(store.db.users);
  const picked = all.filter(u => {
    if (q) return String(u.username).toLowerCase().includes(q);
    return u.mod === true || u.libBanned || moderation.isBootstrap(u);
  });
  res.json({
    users: picked
      .sort((a, b) => (b.mod === true) - (a.mod === true) || String(a.username).localeCompare(String(b.username)))
      .slice(0, 60)
      .map(moderation.userRow),
    total: all.length,
  });
});

function targetFrom(req, res) {
  const id = (req.body || {}).userId;
  const user = friends.userById(id);
  if (!user) { res.status(404).json({ error: 'Account not found.' }); return null; }
  return user;
}

router.post('/mod/grant', requireMod, (req, res) => {
  const target = targetFrom(req, res);
  if (!target) return;
  moderation.grant(target);
  res.json({ ok: true, user: moderation.userRow(target) });
});

router.post('/mod/revoke', requireMod, (req, res) => {
  const target = targetFrom(req, res);
  if (!target) return;
  // Taking the last badge off would drop the server back to the bootstrap
  // rule, where whoever renames themselves to the bootstrap name becomes a
  // moderator. Never leave it in that state by accident.
  const otherMods = Object.values(store.db.users).filter(u => u.mod === true && u.id !== target.id);
  if (target.mod === true && otherMods.length === 0) {
    return res.status(400).json({ error: 'That is the last moderator — grant the badge to somebody else first.' });
  }
  moderation.revoke(target);
  res.json({ ok: true, user: moderation.userRow(target) });
});

router.post('/mod/ban', requireMod, (req, res) => {
  const target = targetFrom(req, res);
  if (!target) return;
  if (moderation.isMod(target)) return res.status(400).json({ error: 'Take their badge off first.' });
  const { removed } = moderation.ban(target, {
    removeLists: (req.body || {}).removeLists !== false,
    reason: (req.body || {}).reason,
  });
  res.json({ ok: true, removedLists: removed, user: moderation.userRow(target) });
});

router.post('/mod/unban', requireMod, (req, res) => {
  const target = targetFrom(req, res);
  if (!target) return;
  moderation.unban(target);
  res.json({ ok: true, user: moderation.userRow(target) });
});


// ═══ Moderator statistics ═══
// How busy the game has been, and what the moderation surface looks like.
router.get('/mod/stats', requireMod, (req, res) => {
  const range = ['24h', '7d', '30d', '1y'].includes(String(req.query.range)) ? req.query.range : '24h';
  const users = Object.values(store.db.users);
  const library = Object.values(store.db.library);
  const lists = Object.values(store.db.lists);
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;

  const since = (ms) => now - ms;
  const newUsers = (ms) => users.filter(u => (u.created || 0) >= since(ms)).length;

  res.json({
    players: stats.series(range, now),
    accounts: stats.accounts(range === '24h' ? '7d' : range, now),
    live: game.totals(),
    totals: {
      accounts: users.length,
      accountsToday: newUsers(DAY),
      accounts7d: newUsers(7 * DAY),
      accounts30d: newUsers(30 * DAY),
      librarySharedLists: library.length,
      libraryWords: library.reduce((a, l) => a + l.words.length, 0),
      libraryDownloads: library.reduce((a, l) => a + (l.downloads || 0), 0),
      privateLists: lists.length,
      drawingsSaved: Object.keys(store.db.drawings).length,
    },
    moderation: {
      moderators: users.filter(u => moderation.isMod(u)).map(u => ({
        id: u.id, username: u.username, since: u.modSince || null,
        bootstrap: !u.mod,             // Silk holding the fort, not a granted badge
      })),
      banned: users.filter(u => moderation.isBanned(u)).map(u => ({
        id: u.id, username: u.username, reason: u.libBanReason || '', at: u.libBannedAt || null,
      })),
      bootstrapName: moderation.BOOTSTRAP_NAME,
      anyMods: moderation.anyMods(),
    },
    // The lists most likely to need a look: newest, and most downloaded.
    recentShares: library
      .slice()
      .sort((a, b) => b.created - a.created)
      .slice(0, 12)
      .map(l => ({ id: l.id, name: l.name, author: l.author, count: l.words.length, created: l.created })),
    topShares: library
      .slice()
      .sort((a, b) => (b.downloads || 0) - (a.downloads || 0))
      .slice(0, 12)
      .map(l => ({ id: l.id, name: l.name, author: l.author, downloads: l.downloads || 0 })),
  });
});

// ═══ Community list library — the hub for sharing word lists ═══
// Lists carry a description and tags so people can actually find them, and
// the browse endpoint does the searching/filtering/sorting server-side.

const LIBRARY_TAGS = [
  'general', 'animals', 'food', 'objects', 'places', 'people',
  'nature', 'science', 'sport', 'music', 'film-tv', 'games',
  'anime', 'memes', 'hard', 'easy', 'kids', 'other',
];

function sanitizeDescription(v) {
  return String(v === undefined || v === null ? '' : v)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

function sanitizeTags(v) {
  const raw = Array.isArray(v) ? v : (typeof v === 'string' ? v.split(',') : []);
  const out = [];
  for (const t of raw) {
    const tag = String(t || '').trim().toLowerCase();
    if (LIBRARY_TAGS.indexOf(tag) === -1) continue;
    if (out.indexOf(tag) === -1) out.push(tag);
    if (out.length >= 4) break;
  }
  return out;
}

// A cheap readability signal: shorter, fewer-word entries draw better.
function difficultyOf(words) {
  if (!words.length) return 'easy';
  let chars = 0, multi = 0;
  for (const w of words) {
    chars += w.length;
    if (w.indexOf(' ') !== -1) multi++;
  }
  const avg = chars / words.length;
  const multiFrac = multi / words.length;
  if (avg <= 6 && multiFrac < 0.15) return 'easy';
  if (avg >= 11 || multiFrac > 0.45) return 'hard';
  return 'medium';
}

function librarySummary(l) {
  return {
    id: l.id,
    name: l.name,
    author: l.author,
    description: l.description || '',
    tags: Array.isArray(l.tags) ? l.tags : [],
    count: l.words.length,
    created: l.created,
    updated: l.updated || l.created,
    downloads: Number(l.downloads) || 0,
    difficulty: l.difficulty || difficultyOf(l.words),
    preview: l.words.slice(0, 8),
  };
}

const LIBRARY_SORTS = {
  popular: (a, b) => (Number(b.downloads) || 0) - (Number(a.downloads) || 0) || b.created - a.created,
  newest: (a, b) => b.created - a.created,
  oldest: (a, b) => a.created - b.created,
  biggest: (a, b) => b.words.length - a.words.length,
  smallest: (a, b) => a.words.length - b.words.length,
  name: (a, b) => String(a.name).localeCompare(String(b.name)),
};

router.get('/library', (req, res) => {
  const user = auth.userForToken(bearer(req)); // optional — marks your own uploads
  const mod = moderation.isMod(user);
  const q = String(req.query.q || '').trim().toLowerCase().slice(0, 60);
  const tag = String(req.query.tag || '').trim().toLowerCase();
  const difficulty = String(req.query.difficulty || '').trim().toLowerCase();
  const author = String(req.query.author || '').trim().toLowerCase().slice(0, 40);
  const mineOnly = req.query.mine === '1';
  const minWords = Math.max(0, parseInt(req.query.minWords, 10) || 0);
  const maxWords = Math.max(0, parseInt(req.query.maxWords, 10) || 0);
  const sort = LIBRARY_SORTS[req.query.sort] ? req.query.sort : 'popular';
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 60));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

  const all = Object.values(store.db.library);
  const matches = all.filter(l => {
    if (mineOnly && !(user && l.ownerId === user.id)) return false;
    if (tag && (!Array.isArray(l.tags) || l.tags.indexOf(tag) === -1)) return false;
    if (difficulty && (l.difficulty || difficultyOf(l.words)) !== difficulty) return false;
    if (author && String(l.author || '').toLowerCase().indexOf(author) === -1) return false;
    if (minWords && l.words.length < minWords) return false;
    if (maxWords && l.words.length > maxWords) return false;
    if (q) {
      // Name, description, author and the words themselves are all searchable.
      const hay = [l.name, l.description || '', l.author || ''].join(' ').toLowerCase();
      if (hay.indexOf(q) === -1 && !l.words.some(w => w.toLowerCase().indexOf(q) !== -1)) return false;
    }
    return true;
  });

  matches.sort(LIBRARY_SORTS[sort]);
  const page = matches.slice(offset, offset + limit);

  res.json({
    lists: page.map(l => Object.assign(
      librarySummary(l),
      { mine: !!(user && l.ownerId === user.id) },
      // Moderators need the uploader's id to be able to act on them.
      mod ? { ownerId: l.ownerId || null, canModerate: true } : null,
    )),
    total: matches.length,
    offset,
    libraryTotal: all.length,
    tags: LIBRARY_TAGS,
    // What the filter dropdowns should offer, based on what is actually there.
    facets: {
      tags: LIBRARY_TAGS.map(t => ({
        tag: t,
        count: all.filter(l => Array.isArray(l.tags) && l.tags.indexOf(t) !== -1).length,
      })).filter(f => f.count > 0),
      authors: [...new Set(all.map(l => l.author).filter(Boolean))].sort().slice(0, 100),
    },
    isMod: mod,
  });
});

router.get('/library/:id', (req, res) => {
  const l = own(store.db.library, req.params.id);
  if (!l) return res.status(404).json({ error: 'List not found.' });
  const user = auth.userForToken(bearer(req));
  res.json({ list: { ...librarySummary(l), words: l.words, mine: !!(user && l.ownerId === user.id) } });
});

router.get('/library/:id/download', (req, res) => {
  const l = own(store.db.library, req.params.id);
  if (!l) return res.status(404).json({ error: 'List not found.' });
  if (!rateLimited(req, 'lib-dl', 60, 60 * 1000)) l.downloads = (Number(l.downloads) || 0) + 1;
  store.scheduleSave();
  const safe = l.name.replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'wordlist';
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${safe}.txt"`);
  res.send(l.words.join('\r\n'));
});

// Upload a list to the shared library. Swear protection always runs here —
// this is public content — and you need an account to share.
router.post('/library', (req, res) => {
  if (rateLimited(req, 'lib-up', 40, 60 * 60 * 1000)) {
    return res.status(429).json({ error: 'Upload limit reached — try again in an hour.' });
  }
  const user = auth.userForToken(bearer(req));
  if (!user) {
    return res.status(401).json({ error: 'You need an account to share lists — sign in with Discord first.' });
  }
  if (moderation.isBanned(user)) {
    return res.status(403).json({ error: 'A moderator has stopped this account from sharing lists.' });
  }
  const name = sanitizeListName((req.body || {}).name);
  const description = sanitizeDescription((req.body || {}).description);
  const tags = sanitizeTags((req.body || {}).tags);
  let wordsArr = sanitizeWords((req.body || {}).words).slice(0, MAX_LIBRARY_WORDS);
  if (wordsArr.length === 0) return res.status(400).json({ error: 'The list needs at least one word.' });
  if (Object.keys(store.db.library).length >= MAX_LIBRARY_LISTS) {
    return res.status(400).json({ error: 'The library is full right now.' });
  }
  // Swear protection.
  const filtered = profanity.filter(wordsArr);
  if (filtered.clean.length === 0) {
    return res.status(400).json({ error: 'Nothing survived swear protection — nice try.' });
  }
  const author = user.username;
  if (!profanity.isClean(name) || !profanity.isClean(author)) {
    return res.status(400).json({ error: 'Keep the list name and your name family-friendly.' });
  }
  if (description && !profanity.isClean(description)) {
    return res.status(400).json({ error: 'Keep the description family-friendly.' });
  }
  const id = store.newId();
  store.db.library[id] = {
    id,
    ownerId: user ? user.id : null,
    author,
    name,
    description,
    tags,
    words: filtered.clean,
    difficulty: difficultyOf(filtered.clean),
    created: Date.now(),
    updated: Date.now(),
    downloads: 0,
  };
  store.scheduleSave();
  res.json({ list: librarySummary(store.db.library[id]), removedBySwearFilter: filtered.removed });
});

// Share a whole .zip of .txt files to the library in one go.
router.post('/library/import-zip', requireAuth, (req, res) => {
  if (rateLimited(req, 'lib-zip', 6, 60 * 60 * 1000)) {
    return res.status(429).json({ error: 'That is a lot of sharing — give it an hour.' });
  }
  if (moderation.isBanned(req.user)) {
    return res.status(403).json({ error: 'A moderator has stopped this account from sharing lists.' });
  }
  const b64 = String((req.body || {}).zip || '');
  if (!b64) return res.status(400).json({ error: 'No file was attached.' });
  let buf;
  try { buf = Buffer.from(b64.replace(/^data:[^,]*,/, ''), 'base64'); }
  catch (e) { return res.status(400).json({ error: 'That file could not be read.' }); }
  if (buf.length > MAX_ZIP_BYTES) return res.status(400).json({ error: 'That zip is too big — 8 MB is the limit.' });

  let entries;
  try { entries = unzip.readTextFiles(buf, { maxFiles: 30, maxTotalBytes: 8 * 1024 * 1024 }); }
  catch (e) { return res.status(400).json({ error: "That doesn't look like a .zip file." }); }
  if (!entries.length) return res.status(400).json({ error: 'No .txt files were found inside that zip.' });

  const description = sanitizeDescription((req.body || {}).description);
  const tags = sanitizeTags((req.body || {}).tags);
  const author = req.user.username;
  const added = [];
  const skipped = [];
  for (const entry of entries) {
    if (Object.keys(store.db.library).length >= MAX_LIBRARY_LISTS) {
      skipped.push({ name: entry.name, why: 'the library is full' });
      continue;
    }
    const name = sanitizeListName(entry.name.replace(/\.txt$/i, ''));
    if (!profanity.isClean(name)) { skipped.push({ name: entry.name, why: 'the name did not pass the filter' }); continue; }
    const words = sanitizeWords(entry.text.split(/[\r\n,]+/)).slice(0, MAX_LIBRARY_WORDS);
    if (!words.length) { skipped.push({ name: entry.name, why: 'no usable words' }); continue; }
    const filtered = profanity.filter(words);
    if (!filtered.clean.length) { skipped.push({ name: entry.name, why: 'nothing survived swear protection' }); continue; }
    const id = store.newId();
    store.db.library[id] = {
      id, ownerId: req.user.id, author, name, description, tags,
      words: filtered.clean,
      difficulty: difficultyOf(filtered.clean),
      created: Date.now(), updated: Date.now(), downloads: 0,
    };
    added.push(librarySummary(store.db.library[id]));
  }
  if (!added.length) return res.status(400).json({ error: 'Nothing in that zip could be shared.', skipped });
  store.scheduleSave();
  res.json({ lists: added, skipped });
});

// Edit one of your own shared lists — name, description, tags or the words.
router.put('/library/:id', requireAuth, (req, res) => {
  const l = own(store.db.library, req.params.id);
  if (!l || l.ownerId !== req.user.id) return res.status(404).json({ error: 'List not found.' });
  const body = req.body || {};

  if (body.name !== undefined) {
    const name = sanitizeListName(body.name);
    if (!profanity.isClean(name)) return res.status(400).json({ error: 'Keep the list name family-friendly.' });
    l.name = name;
  }
  if (body.description !== undefined) {
    const description = sanitizeDescription(body.description);
    if (description && !profanity.isClean(description)) {
      return res.status(400).json({ error: 'Keep the description family-friendly.' });
    }
    l.description = description;
  }
  if (body.tags !== undefined) l.tags = sanitizeTags(body.tags);
  if (body.words !== undefined) {
    const words = sanitizeWords(body.words).slice(0, MAX_LIBRARY_WORDS);
    if (!words.length) return res.status(400).json({ error: 'The list needs at least one word.' });
    const filtered = profanity.filter(words);
    if (!filtered.clean.length) {
      return res.status(400).json({ error: 'Nothing survived swear protection — nice try.' });
    }
    l.words = filtered.clean;
    l.difficulty = difficultyOf(filtered.clean);
  }
  l.updated = Date.now();
  store.scheduleSave();
  res.json({ list: librarySummary(l) });
});

router.delete('/library/:id', requireAuth, (req, res) => {
  const l = own(store.db.library, req.params.id);
  // Your own list, or anyone's if you're a moderator.
  const mayDelete = l && (l.ownerId === req.user.id || moderation.isMod(req.user));
  if (!mayDelete) return res.status(404).json({ error: 'List not found.' });
  delete store.db.library[req.params.id];
  store.scheduleSave();
  res.json({ ok: true });
});

// Same documents, for the in-app reader.
router.get('/legal/:doc', (req, res) => {
  const doc = legal.data(req.params.doc);
  if (!doc) return res.status(404).json({ error: 'Not found.' });
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.json(doc);
});

// ── Public room browser ──
// totals count EVERY room, listed or not, so the number on the home screen
// reflects how busy the game actually is.
router.get('/rooms', (req, res) => {
  res.json({ rooms: game.listPublicRooms(), totals: game.totals() });
});

module.exports = router;
