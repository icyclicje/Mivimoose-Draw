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
const ai = require('./ai');

const router = express.Router();


const MAX_DRAWINGS_PER_USER = 500;
const MAX_LISTS_PER_USER = 200;
const MAX_LIST_WORDS = 50000;        // per list — effectively unlimited
const MAX_TOTAL_WORDS_PER_USER = 250000; // across all lists, keeps db.json writable
const MAX_PNG_BYTES = 3 * 1024 * 1024;
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

function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

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

router.get('/auth/config', (req, res) => {
  res.json({
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
    if (!code || !state || !oauthStates.has(String(state))) return fail('That sign-in attempt expired — please try again.');
    oauthStates.delete(String(state));

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
    // The token travels in the URL fragment so it never shows up in logs.
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
if (config.allowTestLogin) {
  router.post('/auth/test-login', (req, res) => {
    const user = auth.findOrCreateTestUser((req.body || {}).username);
    if (!user) return res.status(400).json({ error: 'Bad username.' });
    res.json({ token: auth.createToken(user.id), user: auth.publicUser(user) });
  });
}

router.post('/auth/logout', (req, res) => {
  auth.deleteToken(bearer(req));
  res.json({ ok: true });
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
  return { id: list.id, name: list.name, count: list.words.length, created: list.created, updated: list.updated };
}

router.get('/lists', requireAuth, (req, res) => {
  const lists = Object.values(store.db.lists)
    .filter(l => l.ownerId === req.user.id)
    .sort((a, b) => b.updated - a.updated)
    .map(listSummary);
  res.json({ lists });
});

router.get('/lists/:id', requireAuth, (req, res) => {
  const list = store.db.lists[req.params.id];
  if (!list || list.ownerId !== req.user.id) return res.status(404).json({ error: 'List not found.' });
  res.json({ list: { ...listSummary(list), words: list.words } });
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
  const list = store.db.lists[req.params.id];
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
  const list = store.db.lists[req.params.id];
  if (!list || list.ownerId !== req.user.id) return res.status(404).json({ error: 'List not found.' });
  delete store.db.lists[req.params.id];
  store.scheduleSave();
  res.json({ ok: true });
});

router.get('/lists/:id/export', requireAuth, (req, res) => {
  const list = store.db.lists[req.params.id];
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
      url: `/api/drawings/${d.id}/image`,
    }));
  res.json({ drawings });
});

router.post('/drawings', requireAuth, (req, res) => {
  if (rateLimited(req, 'drawings', 20, 60 * 1000)) return res.status(429).json({ error: 'Slow down a little.' });
  const { dataUrl, word, artist, guessedCount, playerCount, likes } = req.body || {};
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) {
    return res.status(400).json({ error: 'Invalid image.' });
  }
  const b64 = dataUrl.slice('data:image/png;base64,'.length);
  let buf;
  try { buf = Buffer.from(b64, 'base64'); } catch (_) { return res.status(400).json({ error: 'Invalid image.' }); }
  if (buf.length === 0 || buf.length > MAX_PNG_BYTES) return res.status(400).json({ error: 'Image too large.' });
  // PNG magic bytes check.
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return res.status(400).json({ error: 'Not a PNG.' });

  const mine = Object.values(store.db.drawings).filter(d => d.ownerId === req.user.id);
  if (mine.length >= MAX_DRAWINGS_PER_USER) {
    return res.status(400).json({ error: `Gallery is full (${MAX_DRAWINGS_PER_USER} drawings) — delete some first.` });
  }

  const id = store.newId();
  store.saveDrawingFile(id, buf);
  store.db.drawings[id] = {
    id,
    ownerId: req.user.id,
    word: String(word || '').slice(0, 80),
    artist: String(artist || '').slice(0, 50),
    created: Date.now(),
    guessedCount: Math.max(0, parseInt(guessedCount, 10) || 0),
    playerCount: Math.max(0, parseInt(playerCount, 10) || 0),
    likes: Math.max(0, parseInt(likes, 10) || 0),
  };
  store.scheduleSave();
  res.json({ ok: true, id });
});

router.delete('/drawings/:id', requireAuth, (req, res) => {
  const d = store.db.drawings[req.params.id];
  if (!d || d.ownerId !== req.user.id) return res.status(404).json({ error: 'Drawing not found.' });
  store.deleteDrawingFile(d.id);
  delete store.db.drawings[d.id];
  store.scheduleSave();
  res.json({ ok: true });
});

// Images are served by unguessable random id so <img> tags work.
router.get('/drawings/:id/image', (req, res) => {
  const d = Object.prototype.hasOwnProperty.call(store.db.drawings, req.params.id)
    ? store.db.drawings[req.params.id] : null;
  if (!d) return res.status(404).end();
  const buf = store.readDrawingFile(d.id);
  if (!buf) return res.status(404).end();
  res.setHeader('Content-Type', 'image/png');
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
  const target = friends.findByCode((req.body || {}).code);
  if (!target) return res.status(404).json({ error: 'No account has that friend code.' });
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

// ═══ Community list library — upload, browse, download ═══
function librarySummary(l) {
  return { id: l.id, name: l.name, author: l.author, count: l.words.length, created: l.created, downloads: l.downloads };
}

router.get('/library', (req, res) => {
  const user = auth.userForToken(bearer(req)); // optional — marks your own uploads
  const mod = moderation.isMod(user);
  const lists = Object.values(store.db.library)
    .sort((a, b) => b.downloads - a.downloads || b.created - a.created)
    .map(l => Object.assign(
      librarySummary(l),
      { mine: !!(user && l.ownerId === user.id) },
      // Moderators need the uploader's id to be able to act on them.
      mod ? { ownerId: l.ownerId || null, canModerate: true } : null,
    ));
  res.json({ lists, isMod: mod });
});

router.get('/library/:id', (req, res) => {
  const l = Object.prototype.hasOwnProperty.call(store.db.library, req.params.id)
    ? store.db.library[req.params.id] : null;
  if (!l) return res.status(404).json({ error: 'List not found.' });
  res.json({ list: { ...librarySummary(l), words: l.words } });
});

router.get('/library/:id/download', (req, res) => {
  const l = Object.prototype.hasOwnProperty.call(store.db.library, req.params.id)
    ? store.db.library[req.params.id] : null;
  if (!l) return res.status(404).json({ error: 'List not found.' });
  if (!rateLimited(req, 'lib-dl', 60, 60 * 1000)) l.downloads++;
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
  const id = store.newId();
  store.db.library[id] = {
    id,
    ownerId: user ? user.id : null,
    author,
    name,
    words: filtered.clean,
    created: Date.now(),
    downloads: 0,
  };
  store.scheduleSave();
  res.json({ list: librarySummary(store.db.library[id]), removedBySwearFilter: filtered.removed });
});

// Rename one of your own shared lists.
router.put('/library/:id', requireAuth, (req, res) => {
  const l = Object.prototype.hasOwnProperty.call(store.db.library, req.params.id)
    ? store.db.library[req.params.id] : null;
  if (!l || l.ownerId !== req.user.id) return res.status(404).json({ error: 'List not found.' });
  const name = sanitizeListName((req.body || {}).name);
  if (!profanity.isClean(name)) return res.status(400).json({ error: 'Keep the list name family-friendly.' });
  l.name = name;
  store.scheduleSave();
  res.json({ list: librarySummary(l) });
});

router.delete('/library/:id', requireAuth, (req, res) => {
  const l = Object.prototype.hasOwnProperty.call(store.db.library, req.params.id)
    ? store.db.library[req.params.id] : null;
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
