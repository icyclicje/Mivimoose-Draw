// ─────────────────────────────────────────────────────────────
// hints.js — smarter hint-letter picking.
//
// During a round guessers see the answer masked ("ice cream" →
// "_ _ _   _ _ _ _ _") and the server uncovers a few letters. Picking
// those letters at random is poor: it clusters reveals together, can
// hand over a whole short word while the other stays blank, and burns
// hints on vowels that tell nobody anything.
//
// This picker instead:
//   • splits the answer on ' ' and '+' (combination mode) and always
//     feeds the sub-word with the lowest revealed/length ratio, so no
//     part gets a second letter while another still has none;
//   • never uncovers more than half of a sub-word (floor), which also
//     means a sub-word is never fully given away;
//   • pushes reveals apart — a candidate is scored on its distance to
//     the nearest already-revealed letter of the same sub-word;
//   • prefers informative letters — consonants over vowels, rare over
//     common, with a small penalty for letters the word repeats;
//   • bumps the first letter of a sub-word (and, less, the last);
//   • draws the winner from a softmax over those scores instead of a
//     plain maximum, so the best letter usually wins but the same word
//     is never hinted identically every single game.
//
// Pure, dependency-free, and safe on junk input (empty words, words of
// one letter, all-space words, over-large counts, already-full reveals).
// ─────────────────────────────────────────────────────────────

'use strict';

// Characters that are always shown and never count as a hint.
function isSeparator(ch) {
  return ch === ' ' || ch === '+';
}

// Letter usefulness. Every consonant outranks every vowel; the rare
// letters (j q x z k v w y f b) outrank the workhorses (e t a o i n s r h).
const LETTER_SCORE = {};
(function buildLetterScores() {
  const tiers = [
    ['jqxz', 1.00],   // rare consonants — a near giveaway
    ['kvwyfb', 0.85], // uncommon consonants
    ['cdglmp', 0.70], // middling consonants
    ['hnrst', 0.55],  // very common consonants
    ['u', 0.40],      // rare-ish vowel
    ['aeio', 0.30]    // very common vowels
  ];
  for (let t = 0; t < tiers.length; t++) {
    const letters = tiers[t][0], score = tiers[t][1];
    for (let i = 0; i < letters.length; i++) LETTER_SCORE[letters[i]] = score;
  }
})();

const DEFAULT_LETTER_SCORE = 0.60; // digits, accents, punctuation…

const W_SPREAD = 0.55;        // weight of the anti-clustering term
const B_FIRST = 0.30;         // bonus: first letter of a sub-word
const B_LAST = 0.12;          // bonus: last letter of a sub-word
const P_DUPLICATE = 0.08;     // penalty per extra copy of the letter in the word
const P_ALREADY_SHOWN = 0.15; // penalty if that letter is already revealed elsewhere

// Candidates are drawn with a softmax over their scores rather than by
// plain argmax, so a clear winner is picked most of the time but the
// same word is never hinted identically every game. Lower = greedier.
const TEMPERATURE = 0.18;

function toChars(word) {
  return String(word === null || word === undefined ? '' : word).split('');
}

function letterScore(ch) {
  const key = String(ch).toLowerCase();
  return Object.prototype.hasOwnProperty.call(LETTER_SCORE, key)
    ? LETTER_SCORE[key]
    : DEFAULT_LETTER_SCORE;
}

// Already-revealed indices, cleaned: integers in range that point at a
// hideable character. Anything else is ignored rather than throwing.
function toRevealedSet(chars, revealedIndices) {
  const set = new Set();
  if (!revealedIndices) return set;
  const list = (typeof revealedIndices.forEach === 'function' && !Array.isArray(revealedIndices))
    ? Array.from(revealedIndices)
    : revealedIndices;
  if (!Array.isArray(list)) return set;
  for (let i = 0; i < list.length; i++) {
    const raw = list[i];
    if (typeof raw !== 'number' && typeof raw !== 'string') continue;
    if (typeof raw === 'string' && raw.trim() === '') continue;
    const idx = Math.floor(Number(raw));
    if (!isFinite(idx) || idx < 0 || idx >= chars.length) continue;
    if (isSeparator(chars[idx])) continue;
    set.add(idx);
  }
  return set;
}

// Runs of hideable characters, in order. "boat+coat" → [[0..3], [5..8]].
function splitSegments(chars) {
  const segments = [];
  let current = null;
  for (let i = 0; i < chars.length; i++) {
    if (isSeparator(chars[i])) { current = null; continue; }
    if (!current) { current = { indices: [], cap: 0 }; segments.push(current); }
    current.indices.push(i);
  }
  for (let s = 0; s < segments.length; s++) {
    segments[s].cap = segmentCap(segments[s].indices.length);
  }
  return segments;
}

// Most letters we may ever uncover in a sub-word: half, rounded down —
// so a sub-word is never fully revealed. One-letter parts stay hidden.
function segmentCap(len) {
  if (len < 2) return 0;
  return Math.max(1, Math.floor(len / 2));
}

// How often each (lower-cased) hideable character occurs in the word.
function countOccurrences(chars) {
  const counts = Object.create(null);
  for (let i = 0; i < chars.length; i++) {
    if (isSeparator(chars[i])) continue;
    const key = chars[i].toLowerCase();
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

// Which lower-cased characters are already visible somewhere.
function shownLetters(chars, revealed, chosen) {
  const shown = new Set();
  for (let i = 0; i < chars.length; i++) {
    if (isSeparator(chars[i])) continue;
    if (revealed.has(i) || chosen.has(i)) shown.add(chars[i].toLowerCase());
  }
  return shown;
}

// Pick the single best next index, or -1 when nothing may be revealed.
function pickOne(chars, segments, revealed, chosen, occurrences) {
  // 1. Which sub-words may still take a letter?
  const eligible = [];
  for (let s = 0; s < segments.length; s++) {
    const seg = segments[s];
    if (seg.cap <= 0) continue;
    let used = 0, free = 0;
    for (let p = 0; p < seg.indices.length; p++) {
      const gi = seg.indices[p];
      if (revealed.has(gi) || chosen.has(gi)) used++; else free++;
    }
    if (free === 0 || used >= seg.cap) continue;
    eligible.push({ seg: seg, ratio: used / seg.indices.length });
  }
  if (eligible.length === 0) return -1;

  // 2. Feed the hungriest sub-words. A part with nothing revealed has
  //    ratio 0, which is below any part that already has a letter — so
  //    "one each before anyone gets two" falls out of this comparison.
  let minRatio = Infinity;
  for (let e = 0; e < eligible.length; e++) minRatio = Math.min(minRatio, eligible[e].ratio);

  const shown = shownLetters(chars, revealed, chosen);

  // 3. Score every candidate letter inside those sub-words.
  const candidates = [];
  let bestScore = -Infinity;
  for (let e = 0; e < eligible.length; e++) {
    if (eligible[e].ratio > minRatio + 1e-9) continue;
    const indices = eligible[e].seg.indices;
    const len = indices.length;

    const revealedPositions = [];
    for (let p = 0; p < len; p++) {
      const gi = indices[p];
      if (revealed.has(gi) || chosen.has(gi)) revealedPositions.push(p);
    }

    for (let p = 0; p < len; p++) {
      const gi = indices[p];
      if (revealed.has(gi) || chosen.has(gi)) continue;
      const ch = chars[gi];
      const key = ch.toLowerCase();

      let score = letterScore(ch);
      if (p === 0) score += B_FIRST;
      if (p === len - 1) score += B_LAST;
      score -= P_DUPLICATE * Math.max(0, (occurrences[key] || 1) - 1);
      if (shown.has(key)) score -= P_ALREADY_SHOWN;

      // Distance to the nearest revealed letter of the same sub-word:
      // untouched parts score full, neighbours of a reveal score zero.
      let spread = 1;
      if (revealedPositions.length) {
        let nearest = Infinity;
        for (let r = 0; r < revealedPositions.length; r++) {
          nearest = Math.min(nearest, Math.abs(p - revealedPositions[r]));
        }
        spread = 1 - 1 / nearest;
      }
      score += W_SPREAD * spread;

      candidates.push({ index: gi, score: score });
      if (score > bestScore) bestScore = score;
    }
  }
  if (candidates.length === 0) return -1;

  // 4. Draw one. exp((score - best) / T) keeps the best letter the most
  //    likely by far while leaving near-ties a real chance, so hints
  //    stay informative without ever being fully deterministic.
  let total = 0;
  for (let c = 0; c < candidates.length; c++) {
    candidates[c].weight = Math.exp((candidates[c].score - bestScore) / TEMPERATURE);
    total += candidates[c].weight;
  }
  let roll = Math.random() * total;
  for (let c = 0; c < candidates.length; c++) {
    roll -= candidates[c].weight;
    if (roll <= 0) return candidates[c].index;
  }
  return candidates[candidates.length - 1].index;
}

// ── Public API ───────────────────────────────────────────────

// New indices to reveal, ascending. Never mutates its arguments, never
// returns an already-revealed index, a duplicate, or a ' ' / '+'.
// Returns fewer than `count` (possibly none) when the caps are reached.
function pickHintIndices(word, revealedIndices, count) {
  const chars = toChars(word);
  let want = Number(count);
  if (!(want > 0) || chars.length === 0) return [];
  want = Math.min(Math.floor(want), chars.length);

  const revealed = toRevealedSet(chars, revealedIndices);
  const segments = splitSegments(chars);
  if (segments.length === 0) return [];

  const occurrences = countOccurrences(chars);
  const chosen = new Set();
  const picked = [];
  for (let n = 0; n < want; n++) {
    const idx = pickOne(chars, segments, revealed, chosen, occurrences);
    if (idx < 0) break;
    chosen.add(idx);
    picked.push(idx);
  }
  return picked.sort(function (a, b) { return a - b; });
}

// "ice cream" + [0, 5] → "i_ _   c_ _ _ _" style masking: revealed
// characters as-is, everything else '_', separators passed through.
// Hyphens and apostrophes are shape rather than substance; hosts can hand
// them over so "t-shirt" reads "_-_ _ _ _ _" instead of one long run.
const FREE_PUNCTUATION = /['’.\-]/;

function maskWord(word, revealedIndices, showPunctuation) {
  const chars = toChars(word);
  const revealed = toRevealedSet(chars, revealedIndices);
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (isSeparator(ch)) out += ch;
    else if (showPunctuation && FREE_PUNCTUATION.test(ch)) out += ch;
    else out += revealed.has(i) ? ch : '_';
  }
  return out;
}

// Convenience: the successive one-letter batches a whole round would
// reveal. Stops early once no more letters may be uncovered, so the
// result may be shorter than `hintCount`.
function hintPlan(word, hintCount) {
  const plan = [];
  let total = Math.floor(Number(hintCount));
  if (!(total > 0)) return plan;
  // A batch is one letter, and no word can yield more batches than it has
  // characters, so clamping here bounds the loop for Infinity / huge counts
  // without changing the result for any ordinary count — same rule
  // pickHintIndices applies, so the two agree on over-large `count`s.
  const maxSteps = toChars(word).length;
  if (!(total <= maxSteps)) total = maxSteps;
  const revealed = [];
  for (let i = 0; i < total; i++) {
    const batch = pickHintIndices(word, revealed, 1);
    if (batch.length === 0) break;
    plan.push(batch);
    for (let b = 0; b < batch.length; b++) revealed.push(batch[b]);
  }
  return plan;
}

module.exports = { pickHintIndices, maskWord, hintPlan };
