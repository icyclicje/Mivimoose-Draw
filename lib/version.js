// ─────────────────────────────────────────────────────────────
// version.js — the number in the footer.
//
// Three parts: MAJOR.MINOR.PATCH, shown as "Beta 1.2.4".
// Bump the last number every time a batch of changes ships. When it goes
// past 9 it rolls into the middle number, and when that goes past 9 it
// rolls into the first — so the run reads 1.2.4, 1.2.5 … 1.2.9, 1.3.0,
// … 1.9.9, 2.0.0. The footer reads this from /api/auth/config, so this
// file is the only place it lives.
// ─────────────────────────────────────────────────────────────
const PARTS = [1, 2, 4];

// The rollover rule, written down once so a release never has to guess it.
function bump(parts) {
  let [major, minor, patch] = parts;
  patch++;
  if (patch > 9) { patch = 0; minor++; }
  if (minor > 9) { minor = 0; major++; }
  return [major, minor, patch];
}

const VERSION = PARTS.join('.');
const LABEL = 'Beta ' + VERSION;

module.exports = { VERSION, LABEL, PARTS, bump };
