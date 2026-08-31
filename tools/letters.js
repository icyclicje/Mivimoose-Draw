// ─────────────────────────────────────────────────────────────
// letters.js — a handful of letterforms as SVG paths.
//
// The background art needs the word DRAW! set large, and the renderer has
// no font engine (nor should it — a font file would be the first real
// dependency in the project). These are hand-built geometric caps on a
// 100-unit cap height, in the same heavy weight as the UI's display font.
//
// Each glyph is drawn in its own box starting at x=0, y=0, and reports the
// width it occupies so words can be laid out.
// ─────────────────────────────────────────────────────────────

const CAP = 100;      // cap height every glyph is drawn to
const STEM = 26;      // stem thickness

// D — a stem plus a bowl, with the counter cut out (even-odd does the hole).
const D = {
  width: 86,
  path: `M0 0 H46 C70 0 86 20 86 50 C86 80 70 100 46 100 H0 Z
         M${STEM} ${STEM} V${100 - STEM} H44 C56 ${100 - STEM} 60 66 60 50 C60 34 56 ${STEM} 44 ${STEM} Z`,
};

// R — bowl on top, leg kicking out from the join.
const R = {
  width: 84,
  path: `M0 0 H48 C70 0 82 12 82 30 C82 43 75 52 64 57 L84 100 H56 L40 62 H${STEM} V100 H0 Z
         M${STEM} ${STEM} V40 H45 C53 40 57 36 57 30 C57 24 53 ${STEM} 45 ${STEM} Z`,
};

// A — two diagonals and a crossbar, with a triangular counter.
const A = {
  width: 88,
  path: `M44 0 H44 L88 100 H61 L54 82 H34 L27 100 H0 L44 0 Z
         M44 34 L38 60 H50 Z`,
};

// W — four diagonals meeting at two low points and one middle peak.
const W = {
  width: 122,
  path: `M0 0 H26 L37 62 L50 18 H72 L85 62 L96 0 H122 L104 100 H78 L61 46 L44 100 H18 L0 0 Z`,
};

// ! — a tapered bar and a dot.
const BANG = {
  width: 30,
  path: `M2 0 H28 L24 68 H6 L2 0 Z
         M4 78 H26 V100 H4 Z`,
};

const GLYPHS = { D, R, A, W, '!': BANG };

/**
 * Lay a word out as SVG path elements.
 *
 * @param {string} word    letters present in GLYPHS
 * @param {object} opts    { x, y, size, fill, tracking, opacity, rotate }
 * @returns {string}       SVG markup
 */
function word(text, opts = {}) {
  const size = opts.size || 100;
  const scale = size / CAP;
  const tracking = opts.tracking === undefined ? 10 : opts.tracking;
  const fill = opts.fill || '#ffffff';

  let cursor = 0;
  const parts = [];
  for (const ch of String(text).toUpperCase()) {
    if (ch === ' ') { cursor += 40 + tracking; continue; }
    const g = GLYPHS[ch];
    if (!g) continue;
    parts.push(
      `<path d="${g.path.replace(/\s+/g, ' ').trim()}" fill="${fill}" transform="translate(${cursor} 0)"/>`,
    );
    cursor += g.width + tracking;
  }

  const inner = parts.join('\n    ');
  const t = [
    `translate(${opts.x || 0} ${opts.y || 0})`,
    opts.rotate ? `rotate(${opts.rotate})` : '',
    `scale(${scale})`,
  ].filter(Boolean).join(' ');

  const op = opts.opacity !== undefined ? ` opacity="${opts.opacity}"` : '';
  return `<g transform="${t}"${op}>\n    ${inner}\n  </g>`;
}

// How wide `text` will be once laid out at `size`.
function measure(text, opts = {}) {
  const size = opts.size || 100;
  const tracking = opts.tracking === undefined ? 10 : opts.tracking;
  let w = 0;
  const chars = String(text).toUpperCase().split('');
  for (const ch of chars) {
    if (ch === ' ') { w += 40 + tracking; continue; }
    const g = GLYPHS[ch];
    if (g) w += g.width + tracking;
  }
  if (w > 0) w -= tracking;                 // no trailing gap
  return (w * size) / CAP;
}

module.exports = { word, measure, CAP, GLYPHS };
