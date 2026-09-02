// ─────────────────────────────────────────────────────────────
// store.js — the game's data, backed by a real database.
//
// Shape of it: the whole (small) relational dataset is mirrored in
// memory as plain objects, exactly as the rest of the codebase has
// always seen it — `store.db.users[id]`, synchronous, no awaits in
// the middle of a socket handler. Every mutation is still followed by
// `store.scheduleSave()`, and that now diffs the mirror against what
// the database last saw and writes only what actually changed.
//
// Why a mirror and not direct SQL at every call site: game.js and
// api.js read this data thousands of times a round, from synchronous
// code paths, and Postgres is async. Reading from memory keeps all of
// that untouched; the database is what makes it *survive*, which is
// the thing a JSON file on a container filesystem could never do.
//
// Drawing pixels are the exception — those live in the database as
// blobs and are read on demand, because holding a few hundred
// megabytes of PNG in memory would be silly.
//
// Single-writer assumption: one server process owns the mirror. Run more
// than one replica against the same database and they will not see each
// other's writes. A heartbeat row in `meta` detects that and says so loudly
// at boot; MIVI_ALLOW_MULTI_INSTANCE=1 silences the warning.
// ─────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const db = require('./db');

const DATA_DIR = db.dataDir;
const LEGACY_DB_FILE = path.join(DATA_DIR, 'db.json');
const LEGACY_DRAWINGS_DIR = path.join(DATA_DIR, 'drawings');

// ── The in-memory mirror ──
// Identical shape to what every caller has always used.
const mirror = {
  users: {},     // id -> { id, discordId, username, created, avatar, settings, stats, friends[], … }
  tokens: {},    // tokenHash -> { userId, created, lastSeen }   ← hashes, never raw tokens
  lists: {},     // id -> { id, ownerId, name, words[], created, updated, shareToken? }
  drawings: {},  // id -> { id, ownerId, kind, word, artist, created, … }  (pixels live in the db)
  library: {},   // id -> { id, ownerId, author, name, description, tags[], words[], … }
  stats: { hourly: [], daily: [], accountsByDay: {} },
};

function newId() {
  return crypto.randomBytes(8).toString('hex');
}

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function rowHash(obj) {
  return crypto.createHash('sha1').update(JSON.stringify(obj)).digest('base64');
}

// Words are stored one per line. The sanitizer upstream already collapses
// whitespace, but a legacy record could still carry a newline and would
// otherwise split into two words on the way back out.
const joinWords = (arr) =>
  (Array.isArray(arr) ? arr : []).map(w => String(w).replace(/[\r\n]+/g, ' ')).join('\n');
const splitWords = (s) => (s ? String(s).split('\n').filter(Boolean) : []);

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const bit = (v) => (v ? 1 : 0);
const truthy = (v) => v === 1 || v === true || v === '1' || v === 't';

function parseJson(s, fallback) {
  if (s === null || s === undefined) return fallback;
  if (typeof s === 'object') return s;                 // Postgres json columns
  try {
    const v = JSON.parse(s);
    return v === null || v === undefined ? fallback : v;
  } catch (e) { return fallback; }
}

// ═══ Row ↔ object codecs ═══
// One per table. `toRow` is also what the change detector hashes, so it must
// be deterministic: same object in, same row out, every time.

const codecs = {
  users: {
    table: 'users',
    toRow(u) {
      const s = u.stats || {};
      return {
        id: u.id,
        discord_id: u.discordId || null,
        username: String(u.username || 'Player'),
        username_lower: String(u.username || '').toLowerCase(),
        name_set_by_user: bit(u.nameSetByUser),
        created: num(u.created),
        avatar_emoji: (u.avatar && u.avatar.emoji) || '🦌',
        avatar_color: (u.avatar && u.avatar.color) || '#6C5CE7',
        avatar_url: u.avatarUrl || null,
        settings: JSON.stringify(u.settings || {}),
        prefs: JSON.stringify(u.prefs || {}),
        prefs_updated: num(u.prefsUpdated),
        stat_games: num(s.games),
        stat_wins: num(s.wins),
        stat_points: num(s.points),
        stat_guesses: num(s.guesses),
        stat_words_drawn: num(s.wordsDrawn),
        stat_likes: num(s.likes),
        is_mod: bit(u.mod === true),
        mod_since: u.modSince || null,
        lib_banned: bit(u.libBanned),
        lib_ban_reason: u.libBanReason || null,
        lib_banned_at: u.libBannedAt || null,
        test_user: bit(u.testUser),
      };
    },
    fromRow(r) {
      const u = {
        id: r.id,
        username: r.username,
        created: num(r.created),
        avatar: { emoji: r.avatar_emoji || '🦌', color: r.avatar_color || '#6C5CE7' },
        settings: parseJson(r.settings, { autosaveDrawings: true }),
        prefs: parseJson(r.prefs, {}),
        prefsUpdated: num(r.prefs_updated),
        stats: {
          games: num(r.stat_games), wins: num(r.stat_wins), points: num(r.stat_points),
          guesses: num(r.stat_guesses), wordsDrawn: num(r.stat_words_drawn), likes: num(r.stat_likes),
        },
        friends: [], requestsIn: [], requestsOut: [],
      };
      // Optional fields stay absent rather than present-and-falsey, because
      // plenty of call sites test them with `delete` / `!== undefined`.
      if (r.discord_id) u.discordId = r.discord_id;
      if (r.avatar_url) u.avatarUrl = r.avatar_url;
      if (truthy(r.name_set_by_user)) u.nameSetByUser = true;
      if (truthy(r.is_mod)) u.mod = true;
      if (r.mod_since) u.modSince = num(r.mod_since);
      if (truthy(r.lib_banned)) u.libBanned = true;
      if (r.lib_ban_reason) u.libBanReason = r.lib_ban_reason;
      if (r.lib_banned_at) u.libBannedAt = num(r.lib_banned_at);
      if (truthy(r.test_user)) u.testUser = true;
      return u;
    },
  },

  tokens: {
    table: 'sessions',
    pk: 'token_hash',
    toRow(t, hash) {
      return {
        token_hash: hash,
        user_id: t.userId,
        created: num(t.created),
        last_seen: num(t.lastSeen),
      };
    },
    fromRow(r) {
      return { userId: r.user_id, created: num(r.created), lastSeen: num(r.last_seen) };
    },
  },

  lists: {
    table: 'lists',
    toRow(l) {
      return {
        id: l.id,
        owner_id: l.ownerId,
        name: String(l.name || ''),
        words: joinWords(l.words),
        word_count: Array.isArray(l.words) ? l.words.length : 0,
        created: num(l.created),
        updated: num(l.updated),
        share_token: l.shareToken || null,
      };
    },
    fromRow(r) {
      const l = {
        id: r.id, ownerId: r.owner_id, name: r.name,
        words: splitWords(r.words),
        created: num(r.created), updated: num(r.updated),
      };
      if (r.share_token) l.shareToken = r.share_token;
      return l;
    },
  },

  library: {
    table: 'library',
    toRow(l) {
      return {
        id: l.id,
        owner_id: l.ownerId || null,
        author: String(l.author || ''),
        name: String(l.name || ''),
        description: String(l.description || ''),
        tags: JSON.stringify(Array.isArray(l.tags) ? l.tags : []),
        words: joinWords(l.words),
        word_count: Array.isArray(l.words) ? l.words.length : 0,
        difficulty: l.difficulty || null,
        created: num(l.created),
        updated: num(l.updated),
        downloads: num(l.downloads),
      };
    },
    fromRow(r) {
      return {
        id: r.id, ownerId: r.owner_id || null, author: r.author, name: r.name,
        description: r.description || '',
        tags: parseJson(r.tags, []),
        words: splitWords(r.words),
        difficulty: r.difficulty || undefined,
        created: num(r.created), updated: num(r.updated), downloads: num(r.downloads),
      };
    },
  },

  drawings: {
    table: 'drawings',
    toRow(d) {
      return {
        id: d.id,
        owner_id: d.ownerId,
        kind: d.kind === 'gif' ? 'gif' : 'png',
        word: String(d.word || ''),
        artist: String(d.artist || ''),
        room_code: d.roomCode || null,
        created: num(d.created),
        guessed_count: num(d.guessedCount),
        player_count: num(d.playerCount),
        likes: num(d.likes),
      };
    },
    fromRow(r) {
      const d = {
        id: r.id, ownerId: r.owner_id, kind: r.kind || 'png',
        word: r.word || '', artist: r.artist || '',
        created: num(r.created),
        guessedCount: num(r.guessed_count),
        playerCount: num(r.player_count),
        likes: num(r.likes),
      };
      if (r.room_code) d.roomCode = r.room_code;
      return d;
    },
  },
};

// Column order is fixed once, so the generated SQL is stable and the
// prepared-statement cache in db.js actually hits.
const COLUMNS = {
  users: Object.keys(codecs.users.toRow({ id: '', avatar: {}, stats: {} })),
  tokens: Object.keys(codecs.tokens.toRow({}, '')),
  lists: Object.keys(codecs.lists.toRow({ id: '' })),
  library: Object.keys(codecs.library.toRow({ id: '' })),
  drawings: Object.keys(codecs.drawings.toRow({ id: '' })),
};

function upsertSql(table, cols, pk) {
  const set = cols.filter(c => c !== pk).map(c => `${c} = EXCLUDED.${c}`).join(', ');
  return `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) ` +
         `ON CONFLICT (${pk}) DO UPDATE SET ${set}`;
}

// ═══ Change tracking ═══
// Hash of the last row written for every entity, so a flush only touches
// what moved. Cleared entities are the ones missing from the mirror.
const seen = {
  users: new Map(), tokens: new Map(), lists: new Map(),
  library: new Map(), drawings: new Map(),
  friendships: new Set(),     // "a b"
  requests: new Set(),        // "from to"
  statsHourly: new Map(),     // t -> hash
  statsDaily: new Map(),
  statsAccounts: new Map(),   // day -> count
};

const pendingBlobWrites = new Map(); // id -> Buffer
const pendingBlobDeletes = new Set(); // id

let dirty = false;
let saveTimer = null;
let flushing = null;
let retryTimer = null;
let closed = false;
let consecutiveFailures = 0;
let ready = false;

let warnedEarlyWrite = false;
function scheduleSave() {
  dirty = true;
  if (!ready) {
    // server.js gates listening on init(), so this should be unreachable.
    // If it ever is not, silence would look exactly like the data loss this
    // whole layer exists to prevent.
    if (!warnedEarlyWrite && !closed) {
      warnedEarlyWrite = true;
      console.warn("⚠️  Something wrote to the store before the database was open.");
    }
    return;
  }
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveNow().catch(() => {});
  }, 300);
}

// ── Building the write plan ──
function planEntities(name, pk = 'id') {
  const codec = codecs[name];
  const previous = seen[name];
  const upserts = [];
  const live = new Set();

  const source = mirror[name];
  for (const key of Object.keys(source)) {
    const entity = source[key];
    if (!entity) continue;
    const row = name === 'tokens' ? codec.toRow(entity, key) : codec.toRow(entity);
    if (!row[pk]) continue;                       // a record with no primary key is not storable
    live.add(row[pk]);
    const h = rowHash(row);
    if (previous.get(row[pk]) !== h) upserts.push({ row, hash: h });
  }

  const deletes = [];
  for (const id of previous.keys()) if (!live.has(id)) deletes.push(id);
  return { upserts, deletes, codec, pk };
}

// Friends and requests are arrays inside the user objects; on disk they are
// their own tables. Rebuild both edge sets and diff them wholesale — with a
// 200-friend cap per account this stays trivially small.
function planEdges() {
  const friendships = new Set();
  const requests = new Set();
  for (const u of Object.values(mirror.users)) {
    if (!u || !u.id) continue;
    for (const f of (u.friends || [])) if (f) friendships.add(u.id + ' ' + f);
    for (const to of (u.requestsOut || [])) if (to) requests.add(u.id + ' ' + to);
    // requestsIn is the same edge seen from the other end — storing it too
    // would double every row, so only the outgoing half is persisted.
  }
  const addF = [...friendships].filter(k => !seen.friendships.has(k));
  const delF = [...seen.friendships].filter(k => !friendships.has(k));
  const addR = [...requests].filter(k => !seen.requests.has(k));
  const delR = [...seen.requests].filter(k => !requests.has(k));
  return { friendships, requests, addF, delF, addR, delR };
}

// stats.js keeps its buckets as { t, peak, sum, n, rooms }; the table spells
// the last two `total` and `samples`. One converter, used by both the loader
// and the writer, so the change hashes on either side always agree.
function statRow(b) {
  return {
    t: num(b.t), peak: num(b.peak), total: num(b.sum),
    samples: num(b.n), rooms: num(b.rooms),
  };
}
const STAT_COLS = ['t', 'peak', 'total', 'samples', 'rooms'];

function planStats() {
  const s = mirror.stats || {};
  const hourly = [], daily = [], accounts = [];
  const liveH = new Set(), liveD = new Set(), liveA = new Set();

  for (const b of (s.hourly || [])) {
    if (!b || !Number.isFinite(b.t)) continue;
    liveH.add(b.t);
    const row = statRow(b);
    const h = rowHash(row);
    if (seen.statsHourly.get(b.t) !== h) hourly.push({ row, hash: h });
  }
  for (const b of (s.daily || [])) {
    if (!b || !Number.isFinite(b.t)) continue;
    liveD.add(b.t);
    const row = statRow(b);
    const h = rowHash(row);
    if (seen.statsDaily.get(b.t) !== h) daily.push({ row, hash: h });
  }
  for (const [day, count] of Object.entries(s.accountsByDay || {})) {
    const d = Number(day);
    if (!Number.isFinite(d)) continue;
    liveA.add(d);
    if (seen.statsAccounts.get(d) !== num(count)) accounts.push({ day: d, count: num(count) });
  }

  return {
    hourly, daily, accounts,
    delH: [...seen.statsHourly.keys()].filter(t => !liveH.has(t)),
    delD: [...seen.statsDaily.keys()].filter(t => !liveD.has(t)),
    delA: [...seen.statsAccounts.keys()].filter(d => !liveA.has(d)),
  };
}

/**
 * Push every pending change to the database.
 * Safe to call at any time; concurrent calls share one in-flight write.
 */
function saveNow() {
  if (!ready || closed) return Promise.resolve();
  if (flushing) {
    // A write is already going out. Chain so the caller's changes are not
    // stranded behind the flush that started before them.
    return flushing.then(() => (dirty ? saveNow() : undefined));
  }
  if (!dirty && !pendingBlobWrites.size && !pendingBlobDeletes.size) return Promise.resolve();

  dirty = false;
  const blobWrites = [...pendingBlobWrites.entries()];
  const blobDeletes = [...pendingBlobDeletes];
  pendingBlobWrites.clear();
  pendingBlobDeletes.clear();

  flushing = (async () => {
    const plans = {
      users: planEntities('users'),
      tokens: planEntities('tokens', 'token_hash'),
      lists: planEntities('lists'),
      library: planEntities('library'),
      drawings: planEntities('drawings'),
    };
    const edges = planEdges();
    const st = planStats();

    await db.tx(async (t) => {
      // Users first: everything else points at them.
      for (const name of ['users', 'tokens', 'lists', 'library', 'drawings']) {
        const plan = plans[name];
        const cols = COLUMNS[name];
        const sql = upsertSql(plan.codec.table, cols, plan.pk);
        for (const { row } of plan.upserts) await t.run(sql, cols.map(c => row[c]));
      }

      for (const key of edges.delF) {
        const [a, b] = key.split(' ');
        await t.run('DELETE FROM friendships WHERE user_id = ? AND friend_id = ?', [a, b]);
      }
      for (const key of edges.addF) {
        const [a, b] = key.split(' ');
        await t.run(
          'INSERT INTO friendships (user_id, friend_id) VALUES (?, ?) ON CONFLICT (user_id, friend_id) DO NOTHING',
          [a, b]
        );
      }
      for (const key of edges.delR) {
        const [a, b] = key.split(' ');
        await t.run('DELETE FROM friend_requests WHERE from_id = ? AND to_id = ?', [a, b]);
      }
      for (const key of edges.addR) {
        const [a, b] = key.split(' ');
        await t.run(
          'INSERT INTO friend_requests (from_id, to_id) VALUES (?, ?) ON CONFLICT (from_id, to_id) DO NOTHING',
          [a, b]
        );
      }

      for (const { row } of st.hourly) {
        await t.run(upsertSql('stats_hourly', STAT_COLS, 't'), STAT_COLS.map(c => row[c]));
      }
      for (const { row } of st.daily) {
        await t.run(upsertSql('stats_daily', STAT_COLS, 't'), STAT_COLS.map(c => row[c]));
      }
      for (const { day, count } of st.accounts) {
        await t.run(upsertSql('stats_accounts', ['day_ms', 'signups'], 'day_ms'), [day, count]);
      }
      for (const tt of st.delH) await t.run('DELETE FROM stats_hourly   WHERE t = ?', [tt]);
      for (const tt of st.delD) await t.run('DELETE FROM stats_daily    WHERE t = ?', [tt]);
      for (const dd of st.delA) await t.run('DELETE FROM stats_accounts WHERE day_ms = ?', [dd]);

      // Pixels. Written after the metadata row so a blob never exists
      // without the drawing it belongs to.
      for (const [id, buf] of blobWrites) {
        await t.run(
          'INSERT INTO drawing_blobs (id, bytes) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET bytes = EXCLUDED.bytes',
          [id, buf]
        );
      }
      for (const id of blobDeletes) await t.run('DELETE FROM drawing_blobs WHERE id = ?', [id]);

      // Deletes come last so a row is never removed before a replacement
      // that reuses part of it has landed.
      for (const name of ['drawings', 'library', 'lists', 'tokens', 'users']) {
        const plan = plans[name];
        for (const id of plan.deletes) {
          await t.run(`DELETE FROM ${plan.codec.table} WHERE ${plan.pk} = ?`, [id]);
        }
      }
      // A deleted account leaves no dangling edges behind.
      // A removed account takes its data with it. There are no foreign keys
      // to cascade for us (the schema has to be creatable on a database that
      // already holds rows), so the cascade is spelled out here.
      for (const id of plans.users.deletes) {
        await t.run('DELETE FROM friendships     WHERE user_id = ? OR friend_id = ?', [id, id]);
        await t.run('DELETE FROM friend_requests WHERE from_id = ? OR to_id = ?', [id, id]);
        await t.run('DELETE FROM sessions        WHERE user_id = ?', [id]);
        await t.run('DELETE FROM drawing_blobs   WHERE id IN (SELECT id FROM drawings WHERE owner_id = ?)', [id]);
        await t.run('DELETE FROM drawings        WHERE owner_id = ?', [id]);
        await t.run('DELETE FROM lists           WHERE owner_id = ?', [id]);
        // Shared library rows outlive their author — they are public content
        // other people may be using — but stop pointing at a gone account.
        await t.run('UPDATE library SET owner_id = NULL WHERE owner_id = ?', [id]);
      }
    });

    // Only once the transaction has committed does the "what the database
    // has" bookkeeping move. A failure above leaves it untouched, so the
    // next flush retries exactly the same work.
    for (const name of ['users', 'tokens', 'lists', 'library', 'drawings']) {
      const plan = plans[name];
      for (const { row, hash } of plan.upserts) seen[name].set(row[plan.pk], hash);
      for (const id of plan.deletes) seen[name].delete(id);
    }
    seen.friendships = edges.friendships;
    seen.requests = edges.requests;
    for (const { row, hash } of st.hourly) seen.statsHourly.set(row.t, hash);
    for (const { row, hash } of st.daily) seen.statsDaily.set(row.t, hash);
    for (const { day, count } of st.accounts) seen.statsAccounts.set(day, count);
    for (const tt of st.delH) seen.statsHourly.delete(tt);
    for (const tt of st.delD) seen.statsDaily.delete(tt);
    for (const dd of st.delA) seen.statsAccounts.delete(dd);
    for (const id of blobDeletes) blobCache.delete(id);

    consecutiveFailures = 0;
  })()
    .catch((e) => {
      // Put the work back so nothing is lost, and let the retry timer have it.
      dirty = true;
      for (const [id, buf] of blobWrites) if (!pendingBlobWrites.has(id)) pendingBlobWrites.set(id, buf);
      for (const id of blobDeletes) pendingBlobDeletes.add(id);
      consecutiveFailures++;
      console.error(
        `⚠️  Could not save to the database (attempt ${consecutiveFailures}): ${e.message}`
      );
      const backoff = Math.min(30_000, 500 * 2 ** Math.min(consecutiveFailures, 6));
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(() => { retryTimer = null; saveNow().catch(() => {}); }, backoff);
      retryTimer.unref();
    })
    .finally(() => { flushing = null; });

  return flushing;
}

// ═══ Drawing pixels ═══
// Small LRU so a gallery page does not hit the database once per thumbnail.
const BLOB_CACHE_MAX = 40;
const blobCache = new Map();

function cacheBlob(id, buf) {
  blobCache.delete(id);
  blobCache.set(id, buf);
  while (blobCache.size > BLOB_CACHE_MAX) blobCache.delete(blobCache.keys().next().value);
}

function saveDrawingFile(id, buffer, _ext) {
  pendingBlobWrites.set(id, Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer));
  pendingBlobDeletes.delete(id);
  cacheBlob(id, pendingBlobWrites.get(id));
  scheduleSave();
}

/** Pixels for one drawing, or null. Async — the bytes live in the database. */
async function readDrawingFile(id) {
  if (typeof id !== 'string' || !id) return null;
  if (blobCache.has(id)) {
    const hit = blobCache.get(id);
    cacheBlob(id, hit);                       // touch it, keep it warm
    return hit;
  }
  if (pendingBlobWrites.has(id)) return pendingBlobWrites.get(id);
  const row = await db.get('SELECT bytes FROM drawing_blobs WHERE id = ?', [id]);
  if (!row || !row.bytes) return null;
  const buf = Buffer.isBuffer(row.bytes) ? row.bytes : Buffer.from(row.bytes);
  cacheBlob(id, buf);
  return buf;
}

function deleteDrawingFile(id, _ext) {
  pendingBlobWrites.delete(id);
  pendingBlobDeletes.add(id);
  blobCache.delete(id);
  scheduleSave();
}

// ═══ Loading ═══
async function loadAll() {
  const [users, sessions, lists, library, drawings, friendRows, requestRows,
         hourly, daily, accounts] = await Promise.all([
    db.all('SELECT * FROM users'),
    db.all('SELECT * FROM sessions'),
    db.all('SELECT * FROM lists'),
    db.all('SELECT * FROM library'),
    db.all('SELECT * FROM drawings'),
    db.all('SELECT * FROM friendships'),
    db.all('SELECT * FROM friend_requests'),
    db.all('SELECT * FROM stats_hourly ORDER BY t ASC'),
    db.all('SELECT * FROM stats_daily ORDER BY t ASC'),
    db.all('SELECT * FROM stats_accounts'),
  ]);

  for (const key of ['users', 'tokens', 'lists', 'library', 'drawings']) {
    mirror[key] = {};
    seen[key].clear();
  }

  const load = (name, rows, keyOf) => {
    const codec = codecs[name];
    for (const r of rows) {
      const entity = codec.fromRow(r);
      const key = keyOf(r, entity);
      mirror[name][key] = entity;
      seen[name].set(key, rowHash(name === 'tokens' ? codec.toRow(entity, key) : codec.toRow(entity)));
    }
  };

  load('users', users, (r) => r.id);
  load('tokens', sessions, (r) => r.token_hash);
  load('lists', lists, (r) => r.id);
  load('library', library, (r) => r.id);
  load('drawings', drawings, (r) => r.id);

  seen.friendships = new Set();
  for (const r of friendRows) {
    const u = mirror.users[r.user_id];
    if (u && !u.friends.includes(r.friend_id)) u.friends.push(r.friend_id);
    seen.friendships.add(r.user_id + ' ' + r.friend_id);
  }
  seen.requests = new Set();
  for (const r of requestRows) {
    const from = mirror.users[r.from_id];
    const to = mirror.users[r.to_id];
    if (from && !from.requestsOut.includes(r.to_id)) from.requestsOut.push(r.to_id);
    if (to && !to.requestsIn.includes(r.from_id)) to.requestsIn.push(r.from_id);
    seen.requests.add(r.from_id + ' ' + r.to_id);
  }

  mirror.stats = { hourly: [], daily: [], accountsByDay: {} };
  seen.statsHourly.clear(); seen.statsDaily.clear(); seen.statsAccounts.clear();
  for (const r of hourly) {
    const b = { t: num(r.t), peak: num(r.peak), sum: num(r.total), n: num(r.samples), rooms: num(r.rooms) };
    mirror.stats.hourly.push(b);
    seen.statsHourly.set(b.t, rowHash(statRow(b)));
  }
  for (const r of daily) {
    const b = { t: num(r.t), peak: num(r.peak), sum: num(r.total), n: num(r.samples), rooms: num(r.rooms) };
    mirror.stats.daily.push(b);
    seen.statsDaily.set(b.t, rowHash(statRow(b)));
  }
  for (const r of accounts) {
    mirror.stats.accountsByDay[String(num(r.day_ms))] = num(r.signups);
    seen.statsAccounts.set(num(r.day_ms), num(r.signups));
  }
}

// ═══ Integrity repair ═══
// Years of a schema-less JSON file leave behind things SQL would never have
// allowed: two accounts holding the same name, a friendship recorded on one
// side only, a download counter that went NaN. Fix them in the mirror before
// the unique indexes go on, and say what was fixed rather than doing it
// silently — a rename somebody did not ask for should not be a surprise.
function repairIntegrity() {
  const fixes = [];
  const byAge = Object.values(mirror.users).sort((a, b) => num(a.created) - num(b.created));

  // One account per Discord id. The oldest keeps the link; the others keep
  // their data but stop claiming it, so the next sign-in lands on one account.
  const byDiscord = new Map();
  for (const u of byAge) {
    if (!u.discordId) continue;
    if (byDiscord.has(u.discordId)) {
      delete u.discordId;
      fixes.push(`unlinked a duplicate Discord account: "${u.username}" (${u.id})`);
    } else byDiscord.set(u.discordId, u);
  }

  // Usernames are compared case-insensitively everywhere, so they have to be
  // unique that way too.
  const byName = new Map();
  for (const u of byAge) {
    let lower = String(u.username || "").toLowerCase();
    if (!lower) { u.username = "Player"; lower = "player"; }
    if (byName.has(lower)) {
      const before = u.username;
      u.username = uniqueNameAmong(u.username, byName);
      fixes.push(`renamed a duplicate username: "${before}" → "${u.username}"`);
      lower = u.username.toLowerCase();
    }
    byName.set(lower, u);
  }

  // Friendship is mutual by definition; a half-recorded pair shows one person
  // a friend who cannot see them back.
  for (const u of byAge) {
    for (const id of [...(u.friends || [])]) {
      const other = mirror.users[id];
      if (!other) {
        u.friends = u.friends.filter(f => f !== id);
        fixes.push(`dropped ${u.username}'s friendship with a deleted account`);
        continue;
      }
      if (!other.friends.includes(u.id)) {
        other.friends.push(u.id);
        fixes.push(`restored the other half of ${u.username} ↔ ${other.username}`);
      }
    }
    // A pending request between two people who are already friends is stale.
    u.requestsOut = (u.requestsOut || []).filter(id => mirror.users[id] && !u.friends.includes(id));
    u.requestsIn = (u.requestsIn || []).filter(id => mirror.users[id] && !u.friends.includes(id));
  }

  // Counters that reached the mirror as undefined sort as garbage.
  for (const l of Object.values(mirror.library)) {
    if (!Number.isFinite(Number(l.downloads))) {
      l.downloads = 0;
      fixes.push(`reset a broken download count on "${l.name}"`);
    }
  }

  // A share token is the whole address of a list, so two lists cannot hold one.
  const tokens = new Set();
  for (const l of Object.values(mirror.lists)) {
    if (!l.shareToken) continue;
    if (tokens.has(l.shareToken)) {
      l.shareToken = crypto.randomBytes(9).toString("base64url");
      fixes.push(`reissued a colliding share link for "${l.name}"`);
    }
    tokens.add(l.shareToken);
  }

  if (fixes.length) {
    dirty = true;
    console.log(`🩹 Repaired ${fixes.length} inconsistency(ies) carried over from the old store:`);
    for (const f of fixes.slice(0, 20)) console.log("   • " + f);
    if (fixes.length > 20) console.log(`   • …and ${fixes.length - 20} more`);
  }
  return fixes.length;
}

function uniqueNameAmong(base, taken) {
  const root = String(base || "Player").slice(0, 20) || "Player";
  for (let n = 2; n < 10000; n++) {
    const suffix = String(n);
    const candidate = root.slice(0, 20 - suffix.length) + suffix;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return root.slice(0, 12) + crypto.randomBytes(3).toString("hex");
}

// ═══ One-time import from the old data/db.json ═══
// Everything anybody had before this build gets carried across on the first
// boot: accounts, sessions (so nobody is signed out), lists, the library,
// friends, saved drawings and the traffic history.
async function importLegacyJson() {
  const done = await db.get('SELECT value FROM meta WHERE key = ?', ['legacy_import']);
  if (done) return null;

  if (!fs.existsSync(LEGACY_DB_FILE)) {
    await db.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING',
      ['legacy_import', 'nothing-to-import']);
    return null;
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(LEGACY_DB_FILE, 'utf8'));
  } catch (e) {
    console.error('⚠️  data/db.json could not be read, so nothing was imported:', e.message);
    return null;
  }

  const counts = { users: 0, sessions: 0, lists: 0, library: 0, drawings: 0, blobs: 0 };

  for (const u of Object.values(raw.users || {})) {
    if (!u || !u.id) continue;
    mirror.users[u.id] = {
      ...u,
      avatar: u.avatar || { emoji: '🦌', color: '#6C5CE7' },
      settings: u.settings || { autosaveDrawings: true },
      prefs: u.prefs || {},
      prefsUpdated: num(u.prefsUpdated),
      stats: u.stats || { games: 0, wins: 0, points: 0, guesses: 0, wordsDrawn: 0, likes: 0 },
      friends: Array.isArray(u.friends) ? u.friends : [],
      requestsIn: Array.isArray(u.requestsIn) ? u.requestsIn : [],
      requestsOut: Array.isArray(u.requestsOut) ? u.requestsOut : [],
    };
    counts.users++;
  }

  // Old sessions were stored as the raw token. Carry them over as hashes so
  // everyone stays signed in without the plaintext ever landing in the new db.
  for (const [token, info] of Object.entries(raw.tokens || {})) {
    if (!info || !info.userId || !mirror.users[info.userId]) continue;
    mirror.tokens[sha256(token)] = {
      userId: info.userId,
      created: num(info.created, Date.now()),
      lastSeen: num(info.lastSeen),
    };
    counts.sessions++;
  }

  for (const l of Object.values(raw.lists || {})) {
    if (!l || !l.id) continue;
    mirror.lists[l.id] = { ...l, words: Array.isArray(l.words) ? l.words : [] };
    counts.lists++;
  }
  for (const l of Object.values(raw.library || {})) {
    if (!l || !l.id) continue;
    mirror.library[l.id] = {
      ...l,
      words: Array.isArray(l.words) ? l.words : [],
      tags: Array.isArray(l.tags) ? l.tags : [],
    };
    counts.library++;
  }

  for (const d of Object.values(raw.drawings || {})) {
    if (!d || !d.id) continue;
    mirror.drawings[d.id] = { ...d, kind: d.kind === 'gif' ? 'gif' : 'png' };
    counts.drawings++;
    // Pull the pixels off disk and into the database, which is the whole
    // point — the container filesystem is what kept losing them.
    const safe = String(d.id).replace(/[^a-f0-9]/g, '');
    for (const ext of [d.kind === 'gif' ? 'gif' : 'png', 'png', 'gif']) {
      const p = path.join(LEGACY_DRAWINGS_DIR, safe + '.' + ext);
      try {
        if (fs.existsSync(p)) {
          pendingBlobWrites.set(d.id, fs.readFileSync(p));
          counts.blobs++;
          break;
        }
      } catch (e) { /* an unreadable file is not worth failing the import over */ }
    }
  }

  const s = raw.stats || {};
  mirror.stats = {
    hourly: Array.isArray(s.hourly) ? s.hourly : [],
    daily: Array.isArray(s.daily) ? s.daily : [],
    accountsByDay: (s.accountsByDay && typeof s.accountsByDay === 'object') ? s.accountsByDay : {},
  };

  dirty = true;
  await saveNowUnguarded();
  await db.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING',
    ['legacy_import', new Date().toISOString()]);

  // The JSON file is left exactly where it is. The import is recorded in the
  // database, so a restart will not run it twice, and the old file remains a
  // perfectly good backup.
  return counts;
}

// The import runs before `ready` is set, and saveNow() short-circuits until
// then, so it needs a way in.
async function saveNowUnguarded() {
  const was = ready;
  ready = true;
  try { await saveNow(); } finally { ready = was; }
}

// ═══ Housekeeping ═══
// Sessions expire after 90 days of not being used.
const SESSION_TTL_MS = 90 * 24 * 3600 * 1000;

function pruneTokens() {
  const cutoff = Date.now() - SESSION_TTL_MS;
  let removed = 0;
  for (const [hash, info] of Object.entries(mirror.tokens)) {
    const age = Math.max(num(info && info.lastSeen), num(info && info.created));
    if (!info || age < cutoff || !mirror.users[info.userId]) {
      delete mirror.tokens[hash];
      removed++;
    }
  }
  if (removed > 0) scheduleSave();
  return removed;
}

// ── Single-writer heartbeat ──
// Two processes sharing one database each hold their own copy of the mirror,
// and each one's flush overwrites the other's rows. Nothing in SQL prevents
// it, so at least make it impossible to do by accident without being told.
const INSTANCE_ID = crypto.randomBytes(6).toString('hex');
const HEARTBEAT_MS = 20_000;
const STALE_AFTER_MS = 70_000;
let heartbeatTimer = null;

async function claimInstance() {
  try {
    const row = await db.get('SELECT value FROM meta WHERE key = ?', ['writer']);
    const prev = row && row.value ? parseJson(row.value, null) : null;
    if (prev && prev.id !== INSTANCE_ID && Date.now() - num(prev.at) < STALE_AFTER_MS
        && process.env.MIVI_ALLOW_MULTI_INSTANCE !== '1') {
      console.warn([
        '⚠️  Another Mivimoose server is already writing to this database.',
        '    Both processes keep their own copy of the data in memory, so they',
        '    will overwrite each other. Scale the service back to a single',
        '    instance, or set MIVI_ALLOW_MULTI_INSTANCE=1 if that is deliberate.',
      ].join('\n'));
    }
    await beat();
    heartbeatTimer = setInterval(() => { beat().catch(() => {}); }, HEARTBEAT_MS);
    heartbeatTimer.unref();
  } catch (e) { /* a missing heartbeat must never stop the server booting */ }
}

function beat() {
  return db.run(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
    ['writer', JSON.stringify({ id: INSTANCE_ID, at: Date.now(), pid: process.pid })]
  );
}

let exitHooksInstalled = false;
function installExitHooks() {
  if (exitHooksInstalled) return;
  exitHooksInstalled = true;
  let closing = false;
  const shutdown = (signal) => async () => {
    if (closing) return;
    closing = true;
    try { await saveNow(); } catch (e) { console.error('⚠️  Final save failed:', e.message); }
    try { await db.close(); } catch (_) {}
    process.exit(signal === 'SIGINT' ? 0 : 0);
  };
  process.on('SIGINT', shutdown('SIGINT'));
  process.on('SIGTERM', shutdown('SIGTERM'));
}

let initPromise = null;
let flushInterval = null;
let pruneInterval = null;

/**
 * Open the database, run migrations, import any legacy JSON and load the
 * mirror. Must finish before the server starts serving.
 */
function init() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    await db.init();
    await loadAll();
    const imported = await importLegacyJson();
    if (imported) {
      await loadAll();  // re-read so the mirror matches what actually landed
      console.log(
        `📦 Imported from data/db.json — ${imported.users} accounts, ${imported.lists} lists, ` +
        `${imported.library} shared lists, ${imported.drawings} drawings ` +
        `(${imported.blobs} images), ${imported.sessions} sessions.`
      );
    }
    ready = true;
    repairIntegrity();
    pruneTokens();
    await saveNow();

    // Only now, with the data known-consistent, are the unique indexes safe
    // to create. Anything that still will not apply is reported rather than
    // taking the server down over somebody's historical data.
    const failed = await db.ensureConstraints();
    for (const f of failed) {
      console.warn(`⚠️  Could not enforce ${f.name} (${f.why}) — ${f.message}`);
    }
    try {
      const swept = await db.sweepOrphanBlobs();
      if (swept) console.log(`🧹 Removed ${swept} image(s) whose drawing no longer exists.`);
    } catch (e) { /* a stale blob is not worth failing a boot over */ }

    await claimInstance();

    // A backstop flush, so an idle-but-changed mirror still lands, and a
    // periodic prune of expired sessions.
    flushInterval = setInterval(() => { saveNow().catch(() => {}); }, 15_000);
    flushInterval.unref();
    pruneInterval = setInterval(pruneTokens, 60 * 60 * 1000);
    pruneInterval.unref();

    installExitHooks();
    return module.exports;
  })();
  return initPromise;
}

/** Shut everything down — used by the test harness. */
async function close() {
  if (flushInterval) clearInterval(flushInterval);
  if (pruneInterval) clearInterval(pruneInterval);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  // Cancel the backoff retry BEFORE the pool shuts, or it wakes against a
  // closed connection and re-arms itself forever.
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  await saveNow().catch(() => {});
  const clean = consecutiveFailures === 0;
  closed = true;
  if (flushing) { try { await flushing; } catch (_) {} }
  await db.close();
  ready = false;
  initPromise = null;
  if (!clean) throw new Error("The final save did not reach the database — recent changes were lost.");
}

module.exports = {
  init,
  close,
  db: mirror,
  newId,
  sha256,
  scheduleSave,
  saveNow,
  flush: saveNow,
  pruneTokens,
  saveDrawingFile,
  readDrawingFile,
  deleteDrawingFile,
  get backend() { return db.label; },
  get isReady() { return ready; },
  // False once a flush has failed and not yet succeeded on retry. The REST
  // layer turns this into a 503 rather than telling a player their change
  // was saved when it was not.
  get healthy() { return consecutiveFailures === 0; },
};
