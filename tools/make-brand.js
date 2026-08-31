// ─────────────────────────────────────────────────────────────
// make-brand.js — the artwork Discord asks for around the activity.
//
//   node tools/make-brand.js
//
// A mesh-gradient ground is computed per pixel, then an SVG layer of
// doodles and the word DRAW! is rendered on top of it. Nothing to install:
// the gradient is arithmetic and the SVG goes through tools/svg-render.js.
//
// Output: public/brand/
// ─────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { crc32 } = require('../lib/zip');
const { render: renderMark } = require('./make-logo');
const { rasterize } = require('./svg-render');
const { doodle } = require('./doodles');
const { word, measure } = require('./letters');

const OUT_DIR = path.join(__dirname, '..', 'public', 'brand');

// ── palette ──
const BASE_TOP = [0x1B, 0x1D, 0x38];
const BASE_BOTTOM = [0x12, 0x13, 0x26];

// Big soft lights. Their overlap is what stops this looking like a flat
// two-stop gradient.
const BLOBS = [
  { x: 0.14, y: 0.16, r: 0.78, c: [0x6C, 0x5C, 0xE7], i: 1.05 },
  { x: 0.88, y: 0.26, r: 0.66, c: [0xFD, 0x79, 0xA8], i: 0.88 },
  { x: 0.72, y: 0.90, r: 0.70, c: [0x00, 0xCE, 0xC9], i: 0.50 },
  { x: 0.30, y: 0.82, r: 0.60, c: [0x8E, 0x6C, 0xFF], i: 0.60 },
  { x: 0.52, y: 0.48, r: 0.62, c: [0x7A, 0x5F, 0xE0], i: 0.42 },
];

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

function falloff(d, r) {
  if (d >= r) return 0;
  const t = d / r;
  return Math.pow(1 - t * t, 2);
}

// ── the ground ──
function renderGround(w, h) {
  const px = Buffer.alloc(w * h * 4);
  const unit = Math.min(w, h);

  for (let y = 0; y < h; y++) {
    const fy = y / h;
    for (let x = 0; x < w; x++) {
      const fx = x / w;

      let r = BASE_TOP[0] + (BASE_BOTTOM[0] - BASE_TOP[0]) * fy;
      let g = BASE_TOP[1] + (BASE_BOTTOM[1] - BASE_TOP[1]) * fy;
      let b = BASE_TOP[2] + (BASE_BOTTOM[2] - BASE_TOP[2]) * fy;

      for (const bl of BLOBS) {
        const dx = (fx - bl.x) * w;
        const dy = (fy - bl.y) * h;
        const k = falloff(Math.sqrt(dx * dx + dy * dy), bl.r * unit) * bl.i;
        if (k <= 0) continue;
        r += bl.c[0] * k * 0.72;
        g += bl.c[1] * k * 0.72;
        b += bl.c[2] * k * 0.72;
      }

      // A dot grid, like the paper the game draws on, fading at the edges.
      const gridStep = unit / 26;
      const gx = Math.abs(((x % gridStep) + gridStep) % gridStep - gridStep / 2);
      const gy = Math.abs(((y % gridStep) + gridStep) % gridStep - gridStep / 2);
      const dotD = Math.sqrt(gx * gx + gy * gy);
      const dotR = Math.max(1, unit / 900);
      if (dotD < dotR) {
        const fade = 1 - Math.min(1, Math.hypot(fx - 0.5, fy - 0.5) * 1.7);
        const k = (1 - dotD / dotR) * 0.30 * fade;
        r += 255 * k; g += 255 * k; b += 255 * k;
      }

      const vig = 1 - Math.min(1, Math.hypot((fx - 0.5) * 1.15, (fy - 0.5) * 1.15)) * 0.16;
      r *= vig; g *= vig; b *= vig;

      const n = (Math.random() - 0.5) * 2.2;   // dither, or it bands badly

      const i = (y * w + x) * 4;
      px[i] = clamp255(r + n);
      px[i + 1] = clamp255(g + n);
      px[i + 2] = clamp255(b + n);
      px[i + 3] = 255;
    }
  }
  return px;
}

// ── the artwork layer ──
// Where the doodles sit, as fractions of the canvas, so the same layout
// works at any size. Kept clear of the middle, which the word occupies.
const SCATTER = [
  { n: 'star', x: 0.06, y: 0.13, s: 0.11, rot: -12, o: 0.16 },
  { n: 'cat', x: 0.13, y: 0.76, s: 0.12, rot: 8, o: 0.14 },
  { n: 'house', x: 0.05, y: 0.74, s: 0.10, rot: -6, o: 0.11 },
  { n: 'bolt', x: 0.29, y: 0.16, s: 0.09, rot: 14, o: 0.13 },
  { n: 'fish', x: 0.80, y: 0.70, s: 0.14, rot: -10, o: 0.15 },
  { n: 'balloon', x: 0.86, y: 0.14, s: 0.12, rot: 7, o: 0.13 },
  { n: 'moon', x: 0.71, y: 0.10, s: 0.08, rot: -18, o: 0.12 },
  { n: 'tree', x: 0.63, y: 0.78, s: 0.10, rot: 5, o: 0.12 },
  { n: 'cloud', x: 0.42, y: 0.06, s: 0.12, rot: 0, o: 0.10 },
  { n: 'heart', x: 0.93, y: 0.44, s: 0.09, rot: 12, o: 0.13 },
  { n: 'hill', x: 0.36, y: 0.84, s: 0.13, rot: 0, o: 0.10 },
  { n: 'pencil', x: 0.04, y: 0.28, s: 0.11, rot: -20, o: 0.15 },
];

/**
 * The SVG that goes over the gradient: scattered doodles, and DRAW! set
 * large across the middle.
 *
 * @param {number} w, h    pixel size
 * @param {object} o       { headline: boolean, headlineScale, reserve }
 */
function artLayer(w, h, o = {}) {
  const unit = Math.min(w, h);
  const parts = [];

  for (const d of SCATTER) {
    parts.push(doodle(d.n, {
      x: d.x * w,
      y: d.y * h,
      size: d.s * unit,
      rotate: d.rot,
      fill: '#ffffff',
      opacity: d.o,
    }));
  }

  if (o.headline !== false) {
    // DRAW! centred, with a soft shadow copy behind it for separation.
    const capH = unit * (o.headlineScale || 0.20);
    const textW = measure('DRAW!', { size: capH });
    const x = (w - textW) / 2;
    const y = (h - capH) / 2 + (o.headlineOffsetY || 0) * h;
    parts.push(word('DRAW!', { x: x + capH * 0.035, y: y + capH * 0.05, size: capH, fill: '#000000', opacity: 0.22 }));
    parts.push(word('DRAW!', { x, y, size: capH, fill: '#ffffff', opacity: 0.97 }));
  }

  return `<svg viewBox="0 0 ${w} ${h}">${parts.join('\n')}</svg>`;
}

// Alpha-composite an RGBA layer over the ground, in place.
function over(ground, layer, w, h) {
  for (let i = 0; i < w * h; i++) {
    const a = layer[i * 4 + 3] / 255;
    if (a <= 0) continue;
    ground[i * 4] = clamp255(layer[i * 4] * a + ground[i * 4] * (1 - a));
    ground[i * 4 + 1] = clamp255(layer[i * 4 + 1] * a + ground[i * 4 + 1] * (1 - a));
    ground[i * 4 + 2] = clamp255(layer[i * 4 + 2] * a + ground[i * 4 + 2] * (1 - a));
  }
  return ground;
}

// Drop the app mark in, centred, with a soft shadow under it.
function placeMark(bg, w, h, markFrac, offsetY = 0) {
  const unit = Math.min(w, h);
  const size = Math.round(unit * markFrac);
  const mark = renderMark(size, { radius: 16 });
  const ox = Math.round((w - size) / 2);
  const oy = Math.round((h - size) / 2 + offsetY * h);

  const cx = w / 2, cy = h / 2 + offsetY * h;
  const shadowR = size * 0.78;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = Math.hypot(x - cx, y - cy + size * 0.04);
      if (d > shadowR) continue;
      const k = falloff(d, shadowR) * 0.26;
      const i = (y * w + x) * 4;
      bg[i] = clamp255(bg[i] * (1 - k));
      bg[i + 1] = clamp255(bg[i + 1] * (1 - k));
      bg[i + 2] = clamp255(bg[i + 2] * (1 - k));
    }
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const s = (y * size + x) * 4;
      const a = mark[s + 3] / 255;
      if (a <= 0) continue;
      const px = ox + x, py = oy + y;
      if (px < 0 || py < 0 || px >= w || py >= h) continue;
      const d = (py * w + px) * 4;
      bg[d] = clamp255(mark[s] * a + bg[d] * (1 - a));
      bg[d + 1] = clamp255(mark[s + 1] * a + bg[d + 1] * (1 - a));
      bg[d + 2] = clamp255(mark[s + 2] * a + bg[d + 2] * (1 - a));
    }
  }
  return bg;
}

// ── PNG ──
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePngRect(rgba, w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    const src = y * w * 4;
    const dst = y * (w * 4 + 1);
    raw[dst] = 0;
    rgba.copy(raw, dst + 1, src, src + w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const TARGETS = [
  // Splash / hero art: doodles and the word, no app mark.
  { file: 'mivimoose-background-1920x1080.png', w: 1920, h: 1080, headline: true, headlineScale: 0.26 },
  { file: 'mivimoose-background-1280x720.png', w: 1280, h: 720, headline: true, headlineScale: 0.26 },
  // Square cover: the mark up top, the word beneath it.
  { file: 'mivimoose-cover-1024.png', w: 1024, h: 1024, headline: true, headlineScale: 0.15, headlineOffsetY: 0.27, mark: 0.44, markOffsetY: -0.06 },
  { file: 'mivimoose-cover-512.png', w: 512, h: 512, headline: true, headlineScale: 0.15, headlineOffsetY: 0.27, mark: 0.44, markOffsetY: -0.06 },
];

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const t of TARGETS) {
    let buf = renderGround(t.w, t.h);
    const art = rasterize(artLayer(t.w, t.h, t), t.w);
    buf = over(buf, art.data, t.w, t.h);
    if (t.mark) buf = placeMark(buf, t.w, t.h, t.mark, t.markOffsetY || 0);
    const png = encodePngRect(buf, t.w, t.h);
    fs.writeFileSync(path.join(OUT_DIR, t.file), png);
    console.log(`  ${t.file}  ${t.w}x${t.h}  ${(png.length / 1024).toFixed(1)} KB`);
  }
  console.log(`\nWritten to ${OUT_DIR}`);
}

if (require.main === module) main();
module.exports = { renderGround, artLayer, encodePngRect, over };
