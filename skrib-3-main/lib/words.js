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

  function pickList() {
    const totalWeight = selected.reduce((s, n) => s + weightOf(n), 0);
    let r = Math.random() * totalWeight;
    for (const name of selected) {
      r -= weightOf(name);
      if (r <= 0) return name;
    }
    return selected[selected.length - 1];
  }

  function varietyWeight(word) {
    const uses = (room.wordUsedCount && room.wordUsedCount[word]) || 0;
    if (uses === 0) return 4;
    if (uses === 1) return 2;
    return 1;
  }

  function pickWordFromList(listName) {
    const list = all[listName];
    const totalW = list.reduce((s, w) => s + varietyWeight(w), 0);
    let r = Math.random() * totalW;
    for (const word of list) {
      r -= varietyWeight(word);
      if (r <= 0) return word;
    }
    return list[list.length - 1];
  }

  const result = [];
  const used = new Set([...exclude].map(w => String(w).toLowerCase()));
  let attempts = 0;
  while (result.length < count && attempts < 400) {
    attempts++;
    const listName = pickList();
    const word = pickWordFromList(listName);
    if (!used.has(word.toLowerCase())) {
      used.add(word.toLowerCase());
      result.push({ word, listName });
    }
  }
  return result;
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
  titleCase,
  CLASSIC_LIST,
};
