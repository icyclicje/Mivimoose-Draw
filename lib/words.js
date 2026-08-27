// ─────────────────────────────────────────────────────────────
// words.js — built-in word lists + weighted word selection.
//
// Weighting fix: list weights now apply to EVERY selected list
// (built-in, session-custom and account lists alike). The old
// implementation silently dropped weights for custom lists.
// ─────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const WORDS_DIR = path.join(__dirname, '..', 'words');
const CLASSIC_LIST = 'classic';

const builtinLists = {}; // name -> words[]

function loadBuiltinLists() {
  for (const key of Object.keys(builtinLists)) delete builtinLists[key];
  if (!fs.existsSync(WORDS_DIR)) return;
  const files = fs.readdirSync(WORDS_DIR).filter(f => f.endsWith('.txt'));
  for (const file of files) {
    const name = path.basename(file, '.txt');
    try {
      const content = fs.readFileSync(path.join(WORDS_DIR, file), 'utf8');
      const seen = new Set();
      const words = [];
      for (const line of content.split('\n')) {
        const w = line.trim();
        if (!w) continue;
        const lower = w.toLowerCase();
        if (seen.has(lower)) continue;
        seen.add(lower);
        words.push(w);
      }
      if (words.length > 0) builtinLists[name] = words;
    } catch (e) {
      console.error(`⚠️  Could not load word list "${file}":`, e.message);
    }
  }
  console.log(`📚 Loaded word lists: ${Object.keys(builtinLists).join(', ') || '(none)'}`);
}

// All lists available to a room: built-ins + session/account lists.
function availableLists(room) {
  return { ...builtinLists, ...(room.customLists || {}) };
}

// Weighted random word selection with source tracking.
// 1. Pick a list — probability proportional to its weight (1-5).
// 2. Pick a word from the list — words used fewer times this game
//    are strongly preferred.
function getWordChoicesWithSource(room, count, exclude = new Set()) {
  const all = availableLists(room);
  const selected = (room.selectedLists && room.selectedLists.length > 0)
    ? room.selectedLists.filter(l => all[l] && all[l].length > 0)
    : Object.keys(all).filter(l => all[l].length > 0);

  if (selected.length === 0) return [];

  const weights = room.listWeights || {};
  const weightOf = (name) => {
    const w = Number(weights[name]);
    return (Number.isFinite(w) && w >= 1) ? Math.min(10, w) : 1;
  };

  const lower = w => String(w).toLowerCase();
  const usedCount = room.wordUsedCount || {};
  const usedLower = new Set(Object.keys(usedCount).map(lower));
  const offered = room.wordOffered || new Set();

  function varietyWeight(word) {
    const uses = usedCount[word] || 0;
    if (uses === 0) return 4;
    if (uses === 1) return 2;
    return 1;
  }

  // Avoid-repeats tiers: never-seen words first, then words that were only
  // offered (not drawn), then anything at all — so even a tiny list keeps
  // filling the choices instead of stalling the round.
  const tiers = (room.options && room.options.avoidRepeats)
    ? [w => !usedLower.has(lower(w)) && !offered.has(lower(w)), w => !usedLower.has(lower(w)), () => true]
    : [() => true];

  const result = [];
  const taken = new Set([...exclude].map(lower));

  for (const passes of tiers) {
    if (result.length >= count) break;
    // Per-list candidate pools for this tier.
    const pools = {};
    for (const name of selected) {
      const c = all[name].filter(w => passes(w) && !taken.has(lower(w)));
      if (c.length) pools[name] = c;
    }
    let guard = 0;
    while (result.length < count && guard++ < 2000) {
      const names = Object.keys(pools);
      if (!names.length) break;
      // Pick a list by weight (only lists that still have candidates)…
      const totalWeight = names.reduce((s, n) => s + weightOf(n), 0);
      let r = Math.random() * totalWeight;
      let listName = names[names.length - 1];
      for (const n of names) { r -= weightOf(n); if (r <= 0) { listName = n; break; } }
      // …then a word from it, least-used first.
      const pool = pools[listName];
      const totalW = pool.reduce((s, w) => s + varietyWeight(w), 0);
      let r2 = Math.random() * totalW;
      let idx = pool.length - 1;
      for (let i = 0; i < pool.length; i++) { r2 -= varietyWeight(pool[i]); if (r2 <= 0) { idx = i; break; } }
      const word = pool[idx];
      pool.splice(idx, 1);
      if (!pool.length) delete pools[listName];
      taken.add(lower(word));
      result.push({ word, listName });
    }
  }
  return result;
}

// How much of the selected word pool is still unused (for the lobby hint).
function poolStats(room) {
  const all = availableLists(room);
  const used = new Set(Object.keys(room.wordUsedCount || {}).map(w => w.toLowerCase()));
  const seen = new Set();
  let unused = 0;
  for (const name of room.selectedLists || []) {
    for (const w of (all[name] || [])) {
      const l = w.toLowerCase();
      if (seen.has(l)) continue;
      seen.add(l);
      if (!used.has(l)) unused++;
    }
  }
  return { total: seen.size, unused };
}

function getWordChoices(room, count, exclude = new Set()) {
  return getWordChoicesWithSource(room, count, exclude).map(w => w.word);
}

// Catalog for lobby UI.
// Display name for a built-in list file ("classic" → "Classic").
function titleCase(name) {
  return String(name).replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function catalog(room) {
  return [
    ...Object.keys(builtinLists).sort((a, b) => {
      // Classic first, then alphabetical.
      if (a === CLASSIC_LIST) return -1;
      if (b === CLASSIC_LIST) return 1;
      return a.localeCompare(b);
    }).map(name => ({ name, label: titleCase(name), count: builtinLists[name].length })),
    ...Object.keys(room.customLists || {}).map(name => ({
      name, label: name, count: room.customLists[name].length, custom: true,
    })),
  ];
}

loadBuiltinLists();

module.exports = {
  builtinLists,
  loadBuiltinLists,
  availableLists,
  getWordChoices,
  getWordChoicesWithSource,
  catalog,
  poolStats,
  titleCase,
  CLASSIC_LIST,
};
