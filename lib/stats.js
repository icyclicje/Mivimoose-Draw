// ─────────────────────────────────────────────────────────────
// stats.js — how busy the game has been, over time.
//
// The home screen already shows how many people are playing right now.
// This keeps a history of that number so moderators can see the shape of
// a day, a week, a month or a year, alongside how many accounts are being
// created and what the library and moderation queues look like.
//
// Two buckets, both stored in db.stats:
//   hourly — one sample per hour, kept for ~14 months
//   daily  — one roll-up per day, kept for ~3 years
//
// A sample is the PEAK and the MEAN concurrent players in that hour, not a
// running total: "how many were on at once" is the number people mean when
// they ask how busy something is.
// ─────────────────────────────────────────────────────────────
const store = require('./store');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// Enough hourly detail for a month view, and enough daily for a year.
const KEEP_HOURLY = 24 * 430;
const KEEP_DAILY = 365 * 3;

function ensure() {
  if (!store.db.stats || typeof store.db.stats !== 'object') {
    store.db.stats = { hourly: [], daily: [], accountsByDay: {} };
  }
  const s = store.db.stats;
  if (!Array.isArray(s.hourly)) s.hourly = [];
  if (!Array.isArray(s.daily)) s.daily = [];
  if (!s.accountsByDay || typeof s.accountsByDay !== 'object') s.accountsByDay = {};
  return s;
}

const hourKey = (t) => Math.floor(t / HOUR) * HOUR;
const dayKey = (t) => Math.floor(t / DAY) * DAY;

/**
 * Fold one live reading into the current hour's bucket.
 * Called once a minute from the server; cheap and idempotent.
 *
 * @param {object} totals  { players, playing, rooms } from game.totals()
 */
function sample(totals, now = Date.now()) {
  const s = ensure();
  const h = hourKey(now);
  let bucket = s.hourly.length ? s.hourly[s.hourly.length - 1] : null;

  if (!bucket || bucket.t !== h) {
    bucket = { t: h, peak: 0, sum: 0, n: 0, rooms: 0 };
    s.hourly.push(bucket);
    if (s.hourly.length > KEEP_HOURLY) s.hourly.splice(0, s.hourly.length - KEEP_HOURLY);
    rollUpDays(now);
  }

  const players = Math.max(0, Number(totals && totals.players) || 0);
  const rooms = Math.max(0, Number(totals && totals.rooms) || 0);
  bucket.peak = Math.max(bucket.peak, players);
  bucket.sum += players;
  bucket.n += 1;
  bucket.rooms = Math.max(bucket.rooms, rooms);
  store.scheduleSave();
}

// Once a day's hours are complete, condense them into one daily row so the
// year view does not have to walk 8,760 hourly samples.
function rollUpDays(now = Date.now()) {
  const s = ensure();
  const today = dayKey(now);
  const seen = new Set(s.daily.map(d => d.t));

  const byDay = new Map();
  for (const h of s.hourly) {
    const d = dayKey(h.t);
    if (d >= today || seen.has(d)) continue;      // today is still filling up
    const cur = byDay.get(d) || { t: d, peak: 0, sum: 0, n: 0, rooms: 0 };
    cur.peak = Math.max(cur.peak, h.peak);
    cur.sum += h.sum;
    cur.n += h.n;
    cur.rooms = Math.max(cur.rooms, h.rooms);
    byDay.set(d, cur);
  }
  for (const d of byDay.values()) s.daily.push(d);
  s.daily.sort((a, b) => a.t - b.t);
  if (s.daily.length > KEEP_DAILY) s.daily.splice(0, s.daily.length - KEEP_DAILY);
}

// A new account was created — count it against today.
function countAccount(now = Date.now()) {
  const s = ensure();
  const d = String(dayKey(now));
  s.accountsByDay[d] = (s.accountsByDay[d] || 0) + 1;
  // Keep three years of days; anything older is noise.
  const cutoff = dayKey(now) - KEEP_DAILY * DAY;
  for (const k of Object.keys(s.accountsByDay)) {
    if (Number(k) < cutoff) delete s.accountsByDay[k];
  }
  store.scheduleSave();
}

const RANGES = {
  '24h': { span: DAY, bucket: HOUR, label: 'Last 24 hours' },
  '7d': { span: 7 * DAY, bucket: HOUR * 6, label: 'Last 7 days' },
  '30d': { span: 30 * DAY, bucket: DAY, label: 'Last 30 days' },
  '1y': { span: 365 * DAY, bucket: 7 * DAY, label: 'Last year' },
};

/**
 * The player-count series for one range, bucketed for plotting.
 * Returns { label, points: [{ t, peak, avg }], peak, avg }.
 */
function series(range, now = Date.now()) {
  const s = ensure();
  const spec = RANGES[range] || RANGES['24h'];
  const from = now - spec.span;

  // Hours are the finer source; days cover anything older than we keep hourly.
  const rows = [];
  for (const h of s.hourly) if (h.t >= from) rows.push(h);
  const earliestHour = s.hourly.length ? s.hourly[0].t : Infinity;
  for (const d of s.daily) if (d.t >= from && d.t < earliestHour) rows.push(d);
  rows.sort((a, b) => a.t - b.t);

  const buckets = new Map();
  for (const r of rows) {
    const key = Math.floor(r.t / spec.bucket) * spec.bucket;
    const cur = buckets.get(key) || { t: key, peak: 0, sum: 0, n: 0 };
    cur.peak = Math.max(cur.peak, r.peak);
    cur.sum += r.sum;
    cur.n += r.n;
    buckets.set(key, cur);
  }

  const points = [...buckets.values()]
    .sort((a, b) => a.t - b.t)
    .map(b => ({ t: b.t, peak: b.peak, avg: b.n ? +(b.sum / b.n).toFixed(1) : 0 }));

  const peak = points.reduce((m, p) => Math.max(m, p.peak), 0);
  const totalN = rows.reduce((a, r) => a + r.n, 0);
  const totalSum = rows.reduce((a, r) => a + r.sum, 0);

  return {
    range,
    label: spec.label,
    bucketMs: spec.bucket,
    points,
    peak,
    avg: totalN ? +(totalSum / totalN).toFixed(1) : 0,
    samples: totalN,
  };
}

/** New accounts per day across the range. */
function accounts(range, now = Date.now()) {
  const s = ensure();
  const spec = RANGES[range] || RANGES['30d'];
  const from = dayKey(now - spec.span);
  const points = [];
  for (let d = from; d <= dayKey(now); d += DAY) {
    points.push({ t: d, count: s.accountsByDay[String(d)] || 0 });
  }
  const total = points.reduce((a, p) => a + p.count, 0);
  return { range, points, total, perDay: points.length ? +(total / points.length).toFixed(1) : 0 };
}

module.exports = { sample, series, accounts, countAccount, rollUpDays, RANGES };
