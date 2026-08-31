// ─────────────────────────────────────────────────────────────
// doodles.js — the sort of thing people actually draw in this game.
//
// Simple filled icons on a 100x100 box, used as scattered background art.
// Kept geometric and chunky so they still read when they are faint and
// small. Every one is a fill — the renderer ignores strokes.
// ─────────────────────────────────────────────────────────────

const DOODLES = {
  star: `<polygon points="50,4 62,36 96,38 69,59 78,93 50,73 22,93 31,59 4,38 38,36"/>`,

  heart: `<path d="M50 92 C10 64 6 40 20 26 C32 14 46 18 50 30 C54 18 68 14 80 26 C94 40 90 64 50 92 Z"/>`,

  house: `<path d="M50 8 L94 46 H80 V92 H20 V46 H6 Z
                   M40 62 H60 V92 H40 Z"/>`,

  bolt: `<polygon points="58,4 22,54 44,54 34,96 76,42 52,42"/>`,

  cloud: `<path d="M26 76 C12 76 4 66 4 56 C4 45 13 36 25 36 C28 22 40 12 55 12
                   C72 12 85 25 86 41 C94 44 98 52 98 60 C98 69 90 76 80 76 Z"/>`,

  moon: `<path d="M62 6 C36 10 18 32 18 56 C18 80 37 96 60 96 C72 96 82 92 90 84
                  C66 88 42 72 42 48 C42 30 50 14 62 6 Z"/>`,

  // The eye is a second subpath, so even-odd punches it out as a hole and
  // the fish works on any background. (No arc commands — the renderer's
  // path subset is M L H V C Q Z.)
  fish: `<path d="M6 50 C22 26 52 20 74 34 L96 16 L90 50 L96 84 L74 66 C52 80 22 74 6 50 Z
                  M67 43 C67 45.8 64.8 48 62 48 C59.2 48 57 45.8 57 43 C57 40.2 59.2 38 62 38
                  C64.8 38 67 40.2 67 43 Z"/>`,

  // A very plain cat head — two ears, a round face.
  cat: `<path d="M20 36 L10 4 L40 24 C46 22 54 22 60 24 L90 4 L80 36
                 C88 46 92 56 92 66 C92 83 73 95 50 95 C27 95 8 83 8 66 C8 56 12 46 20 36 Z"/>`,

  // A speech balloon — this is a guessing game, after all.
  balloon: `<path d="M50 10 C78 10 96 26 96 46 C96 66 78 82 50 82 C44 82 38 81 33 80
                     L12 92 L18 72 C10 65 4 56 4 46 C4 26 22 10 50 10 Z"/>`,

  // A pencil at an angle.
  pencil: `<g transform="rotate(38 50 50)">
             <polygon points="50,2 66,32 34,32"/>
             <rect x="34" y="32" width="32" height="13"/>
             <rect x="34" y="45" width="32" height="52" rx="10"/>
           </g>`,

  tree: `<path d="M50 4 L74 40 H62 L84 74 H58 V96 H42 V74 H16 L38 40 H26 Z"/>`,

  // A flat mountain range.
  hill: `<polygon points="4,88 32,34 52,64 68,42 96,88"/>`,
};

/**
 * One doodle as SVG, placed and scaled.
 * @param {string} name  a key of DOODLES
 * @param {object} o     { x, y, size, fill, opacity, rotate }
 */
function doodle(name, o = {}) {
  const body = DOODLES[name];
  if (!body) return '';
  const size = o.size || 100;
  const s = size / 100;
  const t = [
    `translate(${o.x || 0} ${o.y || 0})`,
    o.rotate ? `rotate(${o.rotate} ${size / 2} ${size / 2})` : '',
    `scale(${s})`,
  ].filter(Boolean).join(' ');
  const op = o.opacity !== undefined ? ` opacity="${o.opacity}"` : '';
  return `<g transform="${t}" fill="${o.fill || '#ffffff'}"${op}>${body}</g>`;
}

module.exports = { doodle, DOODLES, names: Object.keys(DOODLES) };
