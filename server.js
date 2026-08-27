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

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e6, // 1MB per socket message is plenty for draw events
});

app.disable('x-powered-by');

// Security headers on everything we serve.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "connect-src 'self' ws: wss:",
    "frame-ancestors 'none'",
  ].join('; '));
  next();
});

app.use(compression()); // gzip/br for HTML, CSS, JS, JSON
app.use(express.json({ limit: '8mb' })); // drawings arrive as base64 PNGs
app.use('/api', api);
// Static assets: short cache with revalidation, so updates still land quickly.
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '10m', etag: true }));

// Invite links (/?join=CODE) and everything else land on the app.
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

game.init(io);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎨 Mivimoose Draw running on http://localhost:${PORT}`);
});
