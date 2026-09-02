// ─────────────────────────────────────────────────────────────
// db.js — the database driver.
//
// Two backends behind one tiny interface:
//
//   Postgres  when DATABASE_URL is set (Railway, Render, Fly, any
//             hosted Postgres). This is the one that matters in
//             production: it survives redeploys, which a container
//             filesystem does not.
//   SQLite    otherwise, via node:sqlite — built into Node, so there
//             is nothing to install and `npm start` still works on a
//             fresh clone with no setup at all.
//
// Callers write ONE dialect: SQL with `?` placeholders. Postgres gets
// the `$1, $2 …` rewrite here, and the handful of type names that
// genuinely differ come from the `T` map below.
// ─────────────────────────────────────────────────────────────
const path = require('path');
const fs = require('fs');

const DATABASE_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
// `pglite://` runs a real Postgres compiled to WebAssembly, in this process.
// It exists so the test suite can exercise the Postgres dialect — the one that
// actually runs in production — without anybody having to install a server.
const IS_PGLITE = /^pglite:/i.test(DATABASE_URL);
const IS_PG = IS_PGLITE || /^postgres(ql)?:\/\//i.test(DATABASE_URL);

// MIVI_DATA_DIR lets the smoke test (or a deployment with a volume) point
// elsewhere. Only the SQLite backend uses it.
const DATA_DIR = process.env.MIVI_DATA_DIR || path.join(__dirname, '..', 'data');
const SQLITE_FILE = process.env.MIVI_SQLITE_FILE || path.join(DATA_DIR, 'mivimoose.db');

// The two dialects disagree on exactly four things. Everything else in the
// schema is spelled the same way in both.
const T = IS_PG
  ? { int: 'BIGINT', text: 'TEXT', blob: 'BYTEA', bool: 'SMALLINT' }
  : { int: 'INTEGER', text: 'TEXT', blob: 'BLOB', bool: 'INTEGER' };

// node-postgres turns `undefined` into a parameter it cannot type, and a
// JS boolean into Postgres `true`/`false` where these columns are SMALLINT.
function pgParams(params) {
  return (params || []).map(v => {
    if (v === undefined) return null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    return v;
  });
}

// Postgres hands BYTEA back as a Buffer over the wire but as a plain
// Uint8Array under PGlite; the rest of the code wants Buffers either way.
function pgRow(row) {
  if (!row) return row;
  for (const k of Object.keys(row)) {
    const v = row[k];
    if (v instanceof Uint8Array && !Buffer.isBuffer(v)) row[k] = Buffer.from(v);
    else if (typeof v === 'bigint') row[k] = Number(v);
  }
  return row;
}

// ── Placeholder rewriting ──
// `?` is SQLite's. Postgres wants $1…$n. Question marks inside string
// literals would be rewritten too, so the scan skips quoted spans.
function toPgPlaceholders(sql) {
  let out = '';
  let n = 0;
  let quote = null;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (quote) {
      out += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; out += c; continue; }
    if (c === '?') { out += '$' + (++n); continue; }
    out += c;
  }
  return out;
}

let impl = null;

// ═══ Postgres, in-process (tests only) ═══
// Same SQL, same dialect, same driver contract as the real thing — so the
// suite catches a Postgres-only mistake before a deploy does.
async function initPglite() {
  let PGlite;
  try {
    ({ PGlite } = require('@electric-sql/pglite'));
  } catch (e) {
    throw new Error(
      'DATABASE_URL=pglite:// needs the @electric-sql/pglite dev dependency. ' +
      'Run `npm install`, or point DATABASE_URL at a real Postgres.'
    );
  }
  // `pglite://` is memory-only; `pglite:///some/dir` persists there.
  const dir = DATABASE_URL.replace(/^pglite:(\/\/)?/i, '');
  // It will not create a missing parent for itself.
  if (dir) fs.mkdirSync(dir, { recursive: true });
  const handle = await PGlite.create(dir || undefined);

  const query = async (sql, params) => handle.query(toPgPlaceholders(sql), pgParams(params));
  return {
    kind: 'postgres',
    label: 'Postgres (in-process, pglite)' + (dir ? ' at ' + dir : ''),
    async run(sql, params = []) { return { changes: (await query(sql, params)).affectedRows || 0 }; },
    async all(sql, params = []) { return (await query(sql, params)).rows.map(pgRow); },
    async get(sql, params = []) { return pgRow((await query(sql, params)).rows[0]) || null; },
    async exec(sql) { await handle.exec(sql); },
    async tx(fn) {
      return handle.transaction(async (t) => fn({
        run: async (sql, params = []) => ({
          changes: (await t.query(toPgPlaceholders(sql), pgParams(params))).affectedRows || 0,
        }),
        all: async (sql, params = []) => (await t.query(toPgPlaceholders(sql), pgParams(params))).rows.map(pgRow),
        get: async (sql, params = []) => pgRow((await t.query(toPgPlaceholders(sql), pgParams(params))).rows[0]) || null,
      }));
    },
    async close() { await handle.close(); },
  };
}

// ═══ Postgres ═══
async function initPostgres() {
  let pg;
  try {
    pg = require('pg');
  } catch (e) {
    throw new Error(
      'DATABASE_URL is set but the "pg" package could not be loaded. Run `npm install` ' +
      '(pg is a dependency in package.json), or unset DATABASE_URL to fall back to SQLite.'
    );
  }

  // node-postgres hands BIGINT back as a string so it cannot lose precision.
  // Every bigint in this schema is a millisecond timestamp or a counter, both
  // far inside Number.MAX_SAFE_INTEGER, so read them as numbers.
  pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
  pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v))); // NUMERIC, from SUM()

  // Hosted Postgres almost always terminates TLS with a certificate the
  // container does not have a root for. `sslmode=disable` in the URL opts out.
  const wantsSsl = !/[?&]sslmode=disable/i.test(DATABASE_URL);
  const pool = new pg.Pool({
    connectionString: DATABASE_URL,
    ssl: wantsSsl ? { rejectUnauthorized: false } : false,
    max: Number(process.env.MIVI_PG_POOL) || 8,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
  });

  // A pooled client dying in the background must never take the server with it.
  pool.on('error', (err) => {
    console.error('⚠️  Postgres pool error:', err.message);
  });

  // Fail fast and loudly if the URL is wrong, rather than on the first write.
  const probe = await pool.connect();
  probe.release();

  return {
    kind: 'postgres',
    label: 'Postgres',
    async run(sql, params = []) {
      const r = await pool.query(toPgPlaceholders(sql), pgParams(params));
      return { changes: r.rowCount || 0 };
    },
    async all(sql, params = []) {
      const r = await pool.query(toPgPlaceholders(sql), pgParams(params));
      return r.rows.map(pgRow);
    },
    async get(sql, params = []) {
      const r = await pool.query(toPgPlaceholders(sql), pgParams(params));
      return pgRow(r.rows[0]) || null;
    },
    async exec(sql) {
      await pool.query(sql);
    },
    // One connection, one transaction — the pool would otherwise scatter the
    // statements across different clients and BEGIN would mean nothing.
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const api = {
          run: async (sql, params = []) => {
            const r = await client.query(toPgPlaceholders(sql), pgParams(params));
            return { changes: r.rowCount || 0 };
          },
          all: async (sql, params = []) => (await client.query(toPgPlaceholders(sql), pgParams(params))).rows.map(pgRow),
          get: async (sql, params = []) => pgRow((await client.query(toPgPlaceholders(sql), pgParams(params))).rows[0]) || null,
        };
        const out = await fn(api);
        await client.query('COMMIT');
        return out;
      } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        throw e;
      } finally {
        client.release();
      }
    },
    async close() { await pool.end(); },
  };
}

// ═══ SQLite (node:sqlite) ═══
async function initSqlite() {
  let sqlite;
  try {
    sqlite = require('node:sqlite');
  } catch (e) {
    throw new Error(
      'This Node build has no node:sqlite (needs Node 22.5+, and 24+ is what we test on). ' +
      'Either upgrade Node or set DATABASE_URL to a Postgres connection string.'
    );
  }

  fs.mkdirSync(path.dirname(SQLITE_FILE), { recursive: true });
  const handle = new sqlite.DatabaseSync(SQLITE_FILE);

  // WAL survives an abrupt kill far better than the rollback journal, and
  // lets reads continue while a write is in flight.
  handle.exec('PRAGMA journal_mode = WAL');
  handle.exec('PRAGMA synchronous = NORMAL');
  handle.exec('PRAGMA foreign_keys = ON');
  handle.exec('PRAGMA busy_timeout = 5000');

  // node:sqlite hands BLOBs back as Uint8Array; the rest of the code wants
  // Buffers, and bigints appear when a column was written as one.
  function normalize(row) {
    if (!row) return row;
    for (const k of Object.keys(row)) {
      const v = row[k];
      if (v instanceof Uint8Array && !Buffer.isBuffer(v)) row[k] = Buffer.from(v);
      else if (typeof v === 'bigint') row[k] = Number(v);
    }
    return row;
  }

  // Prepared statements are cached: the same handful of upserts run on every
  // flush, and re-preparing them each time is pure waste.
  const cache = new Map();
  function prep(sql) {
    let s = cache.get(sql);
    if (!s) {
      s = handle.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  }

  // node:sqlite refuses `undefined` and plain booleans as parameters.
  function bind(params) {
    return params.map(v => {
      if (v === undefined) return null;
      if (typeof v === 'boolean') return v ? 1 : 0;
      return v;
    });
  }

  return {
    kind: 'sqlite',
    label: 'SQLite (' + SQLITE_FILE + ')',
    async run(sql, params = []) {
      const r = prep(sql).run(...bind(params));
      return { changes: Number(r.changes) || 0 };
    },
    async all(sql, params = []) {
      return prep(sql).all(...bind(params)).map(normalize);
    },
    async get(sql, params = []) {
      return normalize(prep(sql).get(...bind(params))) || null;
    },
    async exec(sql) {
      handle.exec(sql);
    },
    async tx(fn) {
      handle.exec('BEGIN');
      try {
        const api = {
          run: async (sql, params = []) => {
            const r = prep(sql).run(...bind(params));
            return { changes: Number(r.changes) || 0 };
          },
          all: async (sql, params = []) => prep(sql).all(...bind(params)).map(normalize),
          get: async (sql, params = []) => normalize(prep(sql).get(...bind(params))) || null,
        };
        const out = await fn(api);
        handle.exec('COMMIT');
        return out;
      } catch (e) {
        try { handle.exec('ROLLBACK'); } catch (_) {}
        throw e;
      }
    },
    async close() {
      cache.clear();
      try { handle.close(); } catch (_) {}
    },
  };
}

// ═══ Schema ═══
// Additive only. Every statement is IF NOT EXISTS, so booting an old
// database against a newer build just adds what is missing.
const SCHEMA = () => [
  `CREATE TABLE IF NOT EXISTS meta (
     key   ${T.text} PRIMARY KEY,
     value ${T.text}
   )`,

  // ── Accounts ──
  `CREATE TABLE IF NOT EXISTS users (
     id               ${T.text} PRIMARY KEY,
     discord_id       ${T.text},
     username         ${T.text} NOT NULL,
     username_lower   ${T.text} NOT NULL,
     name_set_by_user ${T.bool} NOT NULL DEFAULT 0,
     created          ${T.int}  NOT NULL,
     avatar_emoji     ${T.text} NOT NULL DEFAULT '🦌',
     avatar_color     ${T.text} NOT NULL DEFAULT '#6C5CE7',
     avatar_url       ${T.text},
     settings         ${T.text} NOT NULL DEFAULT '{}',
     prefs            ${T.text} NOT NULL DEFAULT '{}',
     prefs_updated    ${T.int}  NOT NULL DEFAULT 0,
     stat_games       ${T.int}  NOT NULL DEFAULT 0,
     stat_wins        ${T.int}  NOT NULL DEFAULT 0,
     stat_points      ${T.int}  NOT NULL DEFAULT 0,
     stat_guesses     ${T.int}  NOT NULL DEFAULT 0,
     stat_words_drawn ${T.int}  NOT NULL DEFAULT 0,
     stat_likes       ${T.int}  NOT NULL DEFAULT 0,
     is_mod           ${T.bool} NOT NULL DEFAULT 0,
     mod_since        ${T.int},
     lib_banned       ${T.bool} NOT NULL DEFAULT 0,
     lib_ban_reason   ${T.text},
     lib_banned_at    ${T.int},
     test_user        ${T.bool} NOT NULL DEFAULT 0
   )`,
  `CREATE INDEX IF NOT EXISTS users_discord_id_idx  ON users (discord_id)`,
  `CREATE INDEX IF NOT EXISTS users_username_idx    ON users (username_lower)`,
  `CREATE INDEX IF NOT EXISTS users_created_idx     ON users (created)`,

  // ── Sessions ──
  // Only the SHA-256 of a session token is stored. A dump of this table
  // cannot be replayed as a login.
  `CREATE TABLE IF NOT EXISTS sessions (
     token_hash ${T.text} PRIMARY KEY,
     user_id    ${T.text} NOT NULL,
     created    ${T.int}  NOT NULL,
     last_seen  ${T.int}  NOT NULL DEFAULT 0
   )`,
  `CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id)`,

  // ── Friends ──
  // Stored as the two directed halves of the pair, which is what the game
  // reads (one user's list) and keeps deletes trivial.
  `CREATE TABLE IF NOT EXISTS friendships (
     user_id   ${T.text} NOT NULL,
     friend_id ${T.text} NOT NULL,
     PRIMARY KEY (user_id, friend_id)
   )`,
  `CREATE TABLE IF NOT EXISTS friend_requests (
     from_id ${T.text} NOT NULL,
     to_id   ${T.text} NOT NULL,
     PRIMARY KEY (from_id, to_id)
   )`,
  `CREATE INDEX IF NOT EXISTS friend_requests_to_idx ON friend_requests (to_id)`,

  // ── Personal word lists ──
  // Words live in one newline-joined blob: they are always read and written
  // whole, and 50 000 rows per list would buy nothing.
  `CREATE TABLE IF NOT EXISTS lists (
     id          ${T.text} PRIMARY KEY,
     owner_id    ${T.text} NOT NULL,
     name        ${T.text} NOT NULL,
     words       ${T.text} NOT NULL DEFAULT '',
     word_count  ${T.int}  NOT NULL DEFAULT 0,
     created     ${T.int}  NOT NULL,
     updated     ${T.int}  NOT NULL,
     share_token ${T.text}
   )`,
  `CREATE INDEX IF NOT EXISTS lists_owner_idx ON lists (owner_id)`,
  `CREATE INDEX IF NOT EXISTS lists_share_idx ON lists (share_token)`,

  // ── The shared list library ──
  `CREATE TABLE IF NOT EXISTS library (
     id          ${T.text} PRIMARY KEY,
     owner_id    ${T.text},
     author      ${T.text} NOT NULL DEFAULT '',
     name        ${T.text} NOT NULL,
     description ${T.text} NOT NULL DEFAULT '',
     tags        ${T.text} NOT NULL DEFAULT '[]',
     words       ${T.text} NOT NULL DEFAULT '',
     word_count  ${T.int}  NOT NULL DEFAULT 0,
     difficulty  ${T.text},
     created     ${T.int}  NOT NULL,
     updated     ${T.int}  NOT NULL,
     downloads   ${T.int}  NOT NULL DEFAULT 0
   )`,
  `CREATE INDEX IF NOT EXISTS library_owner_idx     ON library (owner_id)`,
  `CREATE INDEX IF NOT EXISTS library_created_idx   ON library (created)`,
  `CREATE INDEX IF NOT EXISTS library_downloads_idx ON library (downloads)`,

  // ── Gallery ──
  // Metadata and pixels are split so listing a gallery never drags megabytes
  // of image data through the driver.
  `CREATE TABLE IF NOT EXISTS drawings (
     id            ${T.text} PRIMARY KEY,
     owner_id      ${T.text} NOT NULL,
     kind          ${T.text} NOT NULL DEFAULT 'png',
     word          ${T.text} NOT NULL DEFAULT '',
     artist        ${T.text} NOT NULL DEFAULT '',
     room_code     ${T.text},
     created       ${T.int}  NOT NULL,
     guessed_count ${T.int}  NOT NULL DEFAULT 0,
     player_count  ${T.int}  NOT NULL DEFAULT 0,
     likes         ${T.int}  NOT NULL DEFAULT 0
   )`,
  `CREATE INDEX IF NOT EXISTS drawings_owner_idx ON drawings (owner_id, created)`,
  `CREATE TABLE IF NOT EXISTS drawing_blobs (
     id    ${T.text} PRIMARY KEY,
     bytes ${T.blob} NOT NULL
   )`,

  // ── Traffic history (lib/stats.js) ──
  // `total`/`samples` rather than `sum`/`n`, and `day_ms`/`signups` rather
  // than `day`/`count`: all four of the short names are keywords or function
  // names in one dialect or the other, and quoting them everywhere is worse.
  `CREATE TABLE IF NOT EXISTS stats_hourly (
     t       ${T.int} PRIMARY KEY,
     peak    ${T.int} NOT NULL DEFAULT 0,
     total   ${T.int} NOT NULL DEFAULT 0,
     samples ${T.int} NOT NULL DEFAULT 0,
     rooms   ${T.int} NOT NULL DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS stats_daily (
     t       ${T.int} PRIMARY KEY,
     peak    ${T.int} NOT NULL DEFAULT 0,
     total   ${T.int} NOT NULL DEFAULT 0,
     samples ${T.int} NOT NULL DEFAULT 0,
     rooms   ${T.int} NOT NULL DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS stats_accounts (
     day_ms  ${T.int} PRIMARY KEY,
     signups ${T.int} NOT NULL DEFAULT 0
   )`,
];

// Columns added after the first release. Postgres and SQLite both accept
// ADD COLUMN IF NOT EXISTS as of the versions we target, but SQLite only
// gained it recently, so failures are swallowed — the column already exists.
const LATE_COLUMNS = [
  ['users', 'prefs', `${T.text} NOT NULL DEFAULT '{}'`],
  ['users', 'prefs_updated', `${T.int} NOT NULL DEFAULT 0`],
  ['drawings', 'room_code', `${T.text}`],
];

async function migrate(d) {
  for (const stmt of SCHEMA()) await d.exec(stmt);
  for (const [table, column, type] of LATE_COLUMNS) {
    try {
      await d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    } catch (e) {
      // Already there. That is the normal path on every boot after the first.
    }
  }
}

// ── Constraints that legacy data might violate ──
// These cannot go in SCHEMA(): CREATE UNIQUE INDEX fails outright if the table
// already holds duplicates, and a boot that dies on somebody's old data is
// worse than the duplicate. store.js repairs the data first, then calls this,
// and a still-failing index is reported rather than fatal.
const UNIQUE_INDEXES = [
  {
    name: 'users_discord_id_uidx',
    // One account per Discord user. Without this, two simultaneous sign-ins
    // can split somebody's stats and gallery across two accounts.
    sql: () => IS_PG
      ? 'CREATE UNIQUE INDEX IF NOT EXISTS users_discord_id_uidx ON users (discord_id) WHERE discord_id IS NOT NULL'
      : 'CREATE UNIQUE INDEX IF NOT EXISTS users_discord_id_uidx ON users (discord_id) WHERE discord_id IS NOT NULL',
    why: 'two accounts share one Discord id',
  },
  {
    name: 'users_username_lower_uidx',
    sql: () => 'CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_uidx ON users (username_lower)',
    why: 'two accounts share a username',
  },
  {
    name: 'lists_share_token_uidx',
    sql: () => IS_PG
      ? 'CREATE UNIQUE INDEX IF NOT EXISTS lists_share_token_uidx ON lists (share_token) WHERE share_token IS NOT NULL'
      : 'CREATE UNIQUE INDEX IF NOT EXISTS lists_share_token_uidx ON lists (share_token) WHERE share_token IS NOT NULL',
    why: 'two lists share a link token',
  },
];

/** Returns the names of the constraints that could NOT be applied. */
async function ensureConstraints() {
  const failed = [];
  for (const idx of UNIQUE_INDEXES) {
    try {
      await need().exec(idx.sql());
    } catch (e) {
      failed.push({ name: idx.name, why: idx.why, message: e.message });
    }
  }
  return failed;
}

// Blobs whose drawing is gone keep their bytes forever otherwise — there is
// no foreign key to cascade for them.
async function sweepOrphanBlobs() {
  const r = await need().run('DELETE FROM drawing_blobs WHERE id NOT IN (SELECT id FROM drawings)');
  return r.changes || 0;
}

let readyPromise = null;

/** Connect, create the schema, and hand back the driver. Idempotent. */
function init() {
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    impl = IS_PGLITE ? await initPglite() : (IS_PG ? await initPostgres() : await initSqlite());
    await migrate(impl);
    return impl;
  })();
  return readyPromise;
}

function need() {
  if (!impl) throw new Error('db.init() has not finished yet.');
  return impl;
}

module.exports = {
  init,
  ensureConstraints,
  sweepOrphanBlobs,
  isPostgres: IS_PG,
  get kind() { return impl ? impl.kind : (IS_PG ? 'postgres' : 'sqlite'); },
  get label() { return impl ? impl.label : (IS_PG ? 'Postgres' : 'SQLite'); },
  sqliteFile: SQLITE_FILE,
  dataDir: DATA_DIR,
  run: (sql, params) => need().run(sql, params),
  all: (sql, params) => need().all(sql, params),
  get: (sql, params) => need().get(sql, params),
  exec: (sql) => need().exec(sql),
  tx: (fn) => need().tx(fn),
  close: async () => { if (impl) await impl.close(); impl = null; readyPromise = null; },
};
