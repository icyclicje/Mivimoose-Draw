// ─────────────────────────────────────────────────────────────
// similarity.js — the autocorrect engine.
//
// Strength levels (room option `autocorrectStrength`):
//   0 Off       exact match only
//   1 Easy      1 typo on words of 5+ letters, plurals forgiven
//   2 Normal    1 typo on 4+, 2 typos on 8+
//   3 Generous  1 typo on 3+, 2 on 5+, 3 on 10+, no first-letter guard
//
// Matching normalizes case, accents, spaces and punctuation, counts a
// swapped pair of letters as ONE typo (Damerau distance), forgives a
// trailing plural, and — on the stricter levels — requires the first
// letter to be right for short words so "cat"→"bat" isn't a hit.
// ─────────────────────────────────────────────────────────────

const STRENGTH_LABELS = ['Off', 'Easy', 'Normal', 'Generous'];

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip accents
    .replace(/[^a-z0-9]/g, '');                         // spaces, hyphens, apostrophes…
}

// Optimal string alignment (Damerau–Levenshtein) distance.
function damerau(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const d = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1); // transposition
      }
    }
  }
  return d[m][n];
}

function allowedDistance(len, strength) {
  if (strength <= 0) return 0;
  if (strength === 1) return len >= 5 ? 1 : 0;
  if (strength === 2) return len >= 8 ? 2 : len >= 4 ? 1 : 0;
  return len >= 10 ? 3 : len >= 5 ? 2 : len >= 3 ? 1 : 0;
}

function stripPlural(w) {
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 3 && w.endsWith('es')) return w.slice(0, -2);
  if (w.length > 2 && w.endsWith('s')) return w.slice(0, -1);
  return w;
}

// Compare two single words (already normalized).
function wordMatches(g, a, s) {
  if (g === a) return true;
  if (s === 0) return false;
  if (stripPlural(g) === stripPlural(a)) return true;
  const d = damerau(g, a);
  if (d > allowedDistance(a.length, s)) return false;
  // On Easy/Normal a short word must at least start right.
  if (s < 3 && a.length < 7 && g[0] !== a[0]) return false;
  return true;
}

// Does `guess` count as `answer` at this strength?
// → { ok, exact, dist }
//
// Multi-word answers are compared word by word rather than as one long
// string. Measuring "traffic light" as a single 13-character run lets a
// generous setting swallow three whole typos anywhere in the phrase, which
// made long answers far easier than short ones — the opposite of fair.
function matches(guess, answer, strength) {
  const g = normalize(guess);
  const a = normalize(answer);
  if (!g || !a) return { ok: false, exact: false, dist: Infinity };
  if (g === a) return { ok: true, exact: true, dist: 0 };
  const s = Math.max(0, Math.min(3, parseInt(strength, 10) || 0));
  if (s === 0) return { ok: false, exact: false, dist: damerau(g, a) };

  const aWords = String(answer).toLowerCase().split(/[\s-]+/).map(normalize).filter(Boolean);
  const gWords = String(guess).toLowerCase().split(/[\s-]+/).map(normalize).filter(Boolean);

  if (aWords.length > 1) {
    // Every word has to land, and each one only gets its own small budget.
    // Every word has to land, and each word must at least START right —
    // even on Generous. Otherwise a two-word answer gets two free typos
    // and effectively becomes easier than a one-word one.
    const ok = gWords.length === aWords.length
      && aWords.every((w, i) => {
        const gw = gWords[i];
        if (!gw) return false;
        if (gw[0] !== w[0]) return false;
        return wordMatches(gw, w, s);
      });
    return { ok, exact: false, dist: damerau(g, a) };
  }

  // Single word: the guess may still arrive with stray spaces ("ice cream"
  // typed for "icecream"), so compare the joined forms.
  const ok = wordMatches(g, a, s);
  return { ok, exact: false, dist: damerau(g, a) };
}

// "So close!" — near miss worth a nudge (never a hit).
function isClose(guess, answer) {
  const g = normalize(guess);
  const a = normalize(answer);
  if (g.length < 3 || !a) return false;
  const dist = damerau(g, a);
  return dist > 0 && dist <= (a.length >= 6 ? 2 : 1);
}

// Does `text` give away `answer` (for the text tool)? Any part of a
// combination, fuzzy at the most generous level, or contained outright.
function revealsAnswer(text, answer) {
  const t = normalize(text);
  if (!t) return false;
  const parts = String(answer || '').split('+');
  for (const part of parts) {
    const p = normalize(part);
    if (!p) continue;
    if (matches(t, p, 3).ok) return true;
    if (p.length >= 3 && (t.includes(p) || p.includes(t) && t.length >= 3)) return true;
  }
  return false;
}

module.exports = { STRENGTH_LABELS, normalize, damerau, allowedDistance, wordMatches, matches, isClose, revealsAnswer };
