// ─────────────────────────────────────────────────────────────
// Mivimoose Draw — server entry point.
// Express serves the client + REST API; Socket.io runs the game.
// ─────────────────────────────────────────────────────────────
const express = require('express');
const compression = require('compression');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const api = require('./lib/api');
const game = require('./lib/game');
const store = require('./lib/store');
const config = require('./lib/config');
const fonts = require('./lib/fonts');
const legal = require('./lib/legal');

// Discord embeds an Activity in an iframe served from *.discordsays.com, so
// the anti-framing headers have to make room for it. Everything else stays.
const FRAME_ANCESTORS = config.activityEnabled
  ? "frame-ancestors https://discord.com https://*.discord.com https://*.discordsays.com"
  : "frame-ancestors 'none'";

const stats = require('./lib/stats');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e6, // 1MB per socket message is plenty for draw events
});

app.disable('x-powered-by');
// Railway (and every other PaaS) puts a proxy in front of us. Without this,
// req.ip is the proxy's address for everyone, so the per-IP rate limits in
// lib/api.js become one shared bucket for the entire server — which reads to
// players as "it randomly refuses to save my drawing".
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS) || 1);

// Security headers on everything we serve.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // X-Frame-Options cannot express an allow-list, so when the Activity is
  // enabled we rely on the CSP frame-ancestors directive alone.
  if (!config.activityEnabled) res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    // Discord profile pictures (their CDN is exempt from the Activity's own
    // sandbox CSP, and this covers the plain website).
    "img-src 'self' data: blob: https://cdn.discordapp.com https://media.discordapp.net",
    "connect-src 'self' ws: wss:",
    FRAME_ANCESTORS,
  ].join('; '));
  next();
});

// Webfonts are proxied through our own origin. Google's URLs are absolute and
// cross-origin, which the Discord Activity sandbox blocks outright — serving
// them ourselves is what keeps the game's typography inside Discord.
app.use('/fonts', fonts.router);

app.use(compression()); // gzip/br for HTML, CSS, JS, JSON
// Drawings, game-recap GIFs and .zip imports all arrive as base64 inside JSON,
// which inflates them by a third. The limit has to clear the largest thing the
// API actually accepts (a 12 MB GIF → ~16 MB of base64) or express rejects it
// with a bare 413 before any handler gets to explain why.
app.use(express.json({ limit: '20mb' }));
app.use('/api', api);
// Static assets: short cache with revalidation, so updates still land quickly.
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '10m', etag: true }));

// The policy and terms, rendered into the site's own styling. Real URLs so
// they can go in Discord's Developer Portal, but nothing links to them from
// the game except a small line at the bottom of the home screen.
app.get('/:doc(privacy|terms)', (req, res, next) => {
  const html = legal.page(req.params.doc);
  if (!html) return next();
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.send(html);
});

// Invite links (/?join=CODE) and everything else land on the app.
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Anything the body parser or a handler throws lands here, so the client gets
// a JSON error it can show instead of express's HTML stack page.
app.use('/api', (err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err && (err.type === 'entity.too.large' || err.status === 413)) {
    return res.status(413).json({ error: 'That file is too large to upload.' });
  }
  if (err && (err.type === 'entity.parse.failed' || err.status === 400)) {
    return res.status(400).json({ error: 'That request could not be read.' });
  }
  console.error('API error:', err && err.message);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

const PORT = process.env.PORT || 3000;
// One reading a minute is plenty of resolution for an hourly bucket, and
// keeps the JSON store from being rewritten constantly.
const STATS_EVERY_MS = 60 * 1000;
setInterval(() => {
  try { stats.sample(game.totals()); } catch (e) { /* never take the server down for a metric */ }
}, STATS_EVERY_MS).unref();

// Nothing is served until the database is open, migrated and loaded — a
// request answered from a half-loaded store would look exactly like the data
// loss this whole layer exists to stop.
store.init().then(() => {
  game.init(io);
  server.listen(PORT, onListening);
}).catch((e) => {
  console.error('💥 Could not open the database, so the server did not start.');
  console.error('   ' + e.message);
  console.error('   Set DATABASE_URL to a Postgres connection string, or leave it unset');
  console.error('   to use a local SQLite file under data/. See the README.');
  process.exit(1);
});

function onListening() {
  console.log(`🎨 Mivimoose Draw running on http://localhost:${PORT}`);
  console.log(`🗄️  Database: ${store.backend}`);
  if (config.activityEnabled) console.log('🎮 Discord Activity support is on — see docs/DISCORD_ACTIVITY.md');
  if (config.discordConfigured) {
    // Sign-in fails with 'Invalid OAuth2 redirect_uri' unless this exact
    // string is listed under OAuth2 → Redirects on the Discord app.
    console.log('🔑 Discord redirect URI (must be registered verbatim):');
    console.log('   ' + config.discordRedirectUri);
  }
  // Pull the font files down once up front so the first player does not wait.
  fonts.warm();
}
