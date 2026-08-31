// ─────────────────────────────────────────────────────────────
// make-logo.js — render the Mivimoose Draw mark to SVG + PNG.
//
//   node tools/make-logo.js
//
// The mark is defined once, here, as SVG. Everything else — the PNGs, the
// favicon, the brand artwork — is rendered from this one string through
// tools/svg-render.js, so nothing can drift out of step with it.
//
// The moose: palmate antlers (broad blades with points, the way a moose
// actually has them), a narrow forehead, a heavy drooping muzzle, and a
// pencil held crosswise in its mouth.
//
// Output: public/brand/
// ─────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const { rasterize, toPng } = require('./svg-render');

const OUT_DIR = path.join(__dirname, '..', 'public', 'brand');

// The mark's own shapes, without a background — reused for the flat icon
// and for anywhere the mark sits on artwork of its own.
const FIGURE = `  <g fill="#ffffff">
    <path d="M27 27 L14 24 L5 15 L11 15 L8 7 L15 13 L16 4 L21 12 L25 6 L26 15 L28 19 Z"/>
    <path d="M37 27 L50 24 L59 15 L53 15 L56 7 L49 13 L48 4 L43 12 L39 6 L38 15 L36 19 Z"/>
    <path d="M32 20 C38 20 40 25 40 31 L40 38 L24 38 L24 31 C24 25 26 20 32 20 Z"/>
    <ellipse cx="32" cy="45" rx="13" ry="11"/>
  </g>
  <circle cx="27.5" cy="31" r="2.2" fill="#2D2A55"/>
  <circle cx="36.5" cy="31" r="2.2" fill="#2D2A55"/>
  <ellipse cx="28" cy="44" rx="2.4" ry="1.8" fill="#B9B3F5"/>
  <ellipse cx="36" cy="44" rx="2.4" ry="1.8" fill="#B9B3F5"/>`;

const PENCIL = `  <g transform="rotate(-9 32 55)">
    <rect x="14" y="52" width="29" height="6.6" rx="3.3" fill="#2D2A55"/>
    <rect x="40" y="52" width="5.2" height="6.6" fill="#FDCB6E"/>
    <polygon points="45.2,52 54,55.3 45.2,58.6" fill="#FD79A8"/>
  </g>`;

const DEFS = `  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#6C5CE7"/>
      <stop offset="100%" stop-color="#FD79A8"/>
    </linearGradient>
  </defs>`;

/**
 * The complete mark.
 * @param {object} o  { radius } — corner radius in user units. 0 gives a
 *                    full-bleed square, which is what Discord wants since
 *                    it applies its own mask.
 */
function logoSvg({ radius = 14, size = 512 } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}" role="img" aria-label="Mivimoose Draw">
${DEFS}
  <rect width="64" height="64" rx="${radius}" fill="url(#g)"/>
${FIGURE}
${PENCIL}
</svg>
`;
}

// The figure alone, on whatever is behind it.
function figureSvg({ size = 512 } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}">
${FIGURE}
${PENCIL}
</svg>
`;
}

/** Rasterise the mark at `size` px square. Returns an RGBA buffer. */
function render(size, { radius = 14 } = {}) {
  return rasterize(logoSvg({ radius }), size).data;
}

const TARGETS = [
  // Discord's app icon slot — square, it masks its own corners.
  { file: 'mivimoose-icon-1024.png', size: 1024, radius: 0 },
  { file: 'mivimoose-icon-512.png', size: 512, radius: 0 },
  // The mark with its own corners, for everywhere else.
  { file: 'mivimoose-logo-1024.png', size: 1024, radius: 14 },
  { file: 'mivimoose-logo-512.png', size: 512, radius: 14 },
  { file: 'mivimoose-logo-256.png', size: 256, radius: 14 },
  { file: 'mivimoose-logo-128.png', size: 128, radius: 14 },
  { file: 'mivimoose-logo-64.png', size: 64, radius: 14 },
];

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  fs.writeFileSync(path.join(OUT_DIR, 'mivimoose-logo.svg'), logoSvg({ radius: 14 }));
  console.log('  mivimoose-logo.svg');
  fs.writeFileSync(path.join(OUT_DIR, 'mivimoose-mark.svg'), figureSvg());
  console.log('  mivimoose-mark.svg  (no background)');

  for (const t of TARGETS) {
    const png = toPng(rasterize(logoSvg({ radius: t.radius }), t.size));
    fs.writeFileSync(path.join(OUT_DIR, t.file), png);
    console.log(`  ${t.file}  ${t.size}x${t.size}  ${(png.length / 1024).toFixed(1)} KB`);
  }
  console.log(`\nWritten to ${OUT_DIR}`);
}

if (require.main === module) main();
module.exports = { render, logoSvg, figureSvg, FIGURE, PENCIL, DEFS };
