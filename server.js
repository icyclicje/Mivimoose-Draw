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
const config = require('./lib/config');
const fonts = require('./lib/fonts');

// Discord embeds an Activity in an iframe served from *.discordsays.com, so
// the anti-framing headers have to make room for it. Everything else stays.
const FRAME_ANCESTORS = config.activityEnabled
  ? "frame-ancestors https://discord.com https://*.discord.com https://*.discordsays.com"
  : "frame-ancestors 'none'";

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e6, // 1MB per socket message is plenty for draw events
});

app.disable('x-powered-by');

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
app.use(express.json({ limit: '8mb' })); // drawings arrive as base64 PNGs
app.use('/api', api);
// Static assets: short cache with revalidation, so updates still land quickly.
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '10m', etag: true }));
// The privacy policy and terms, so the in-app links (and Discord's Developer
// Portal fields) can point at a real URL.
app.use('/docs', express.static(path.join(__dirname, 'docs'), {
  maxAge: '1h',
  extensions: ['md'],
  setHeaders: (res) => res.setHeader('Content-Type', 'text/plain; charset=utf-8'),
}));

// Invite links (/?join=CODE) and everything else land on the app.
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

game.init(io);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎨 Mivimoose Draw running on http://localhost:${PORT}`);
  if (config.activityEnabled) console.log('🎮 Discord Activity support is on — see docs/DISCORD_ACTIVITY.md');
  // Pull the font files down once up front so the first player does not wait.
  fonts.warm();
});
