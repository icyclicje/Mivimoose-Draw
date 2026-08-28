// ─────────────────────────────────────────────────────────────
// profanity.js — shared swear-protection filter (browser + node).
// Normalizes leetspeak, then checks exact words against a block
// list and a small set of never-innocent substrings.
// ─────────────────────────────────────────────────────────────
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MiviProfanity = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Exact-match words (after normalization). Matched per whole word so
  // innocent words that merely contain them ("class", "bassoon") pass.
  var BLOCKED_WORDS = [
    'fuck', 'fucker', 'fucking', 'fucked', 'motherfucker', 'shit', 'shitty',
    'bullshit', 'ass', 'asshole', 'arse', 'arsehole', 'bitch', 'bitches',
    'bastard', 'dick', 'dickhead', 'cock', 'pussy', 'cunt', 'twat', 'wank',
    'wanker', 'slut', 'whore', 'hoe', 'douche', 'douchebag', 'jackass',
    'dumbass', 'prick', 'bollocks', 'crap', 'piss', 'pissed', 'tit', 'tits',
    'boob', 'boobs', 'penis', 'vagina', 'cum', 'jizz', 'blowjob', 'handjob',
    'porn', 'porno', 'sex', 'sexy', 'nude', 'naked', 'orgasm', 'anal',
    'rape', 'rapist', 'nazi', 'hitler', 'terrorist',
  ];

  // Substrings that are effectively never part of an innocent word.
  var BLOCKED_FRAGMENTS = [
    'nigg', 'fagg', 'kike', 'spic ', 'wetback', 'chink', 'tranny',
    'retard', 'kys',
  ];

  var LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's', '!': 'i', '+': 't' };

  function normalize(text) {
    var s = String(text).toLowerCase();
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      out += LEET[c] !== undefined ? LEET[c] : c;
    }
    // Collapse repeated letters ("fuuuck" -> "fuck") for the word check.
    return out;
  }

  function collapseRepeats(word) {
    return word.replace(/(.)\1+/g, '$1$1'); // keep doubles ("poop" stays)
  }

  // Full collapse ('fuuuck' -> 'fuck') for stretched-out spellings.
  function collapseAll(word) {
    return word.replace(/(.)\1+/g, '$1');
  }

  var wordSet = {};
  for (var i = 0; i < BLOCKED_WORDS.length; i++) {
    wordSet[BLOCKED_WORDS[i]] = true;
    wordSet[collapseRepeats(BLOCKED_WORDS[i])] = true;
  }

  // Is a single list entry (may be a multi-word phrase) clean?
  function isClean(entry) {
    var norm = normalize(entry);
    for (var f = 0; f < BLOCKED_FRAGMENTS.length; f++) {
      if (norm.indexOf(BLOCKED_FRAGMENTS[f].trim()) !== -1) return false;
    }
    // Spaced/dotted-out evasions ('f u c k', 'f.u.c.k'): squash to letters
    // only and require an exact hit, so multi-word phrases stay innocent.
    var squashed = norm.replace(/[^a-z]/g, '');
    if (wordSet[squashed] || wordSet[collapseRepeats(squashed)] || wordSet[collapseAll(squashed)]) return false;
    var tokens = norm.split(/[^a-z]+/);
    for (var t = 0; t < tokens.length; t++) {
      if (!tokens[t]) continue;
      if (wordSet[tokens[t]] || wordSet[collapseRepeats(tokens[t])] || wordSet[collapseAll(tokens[t])]) return false;
    }
    return true;
  }

  // Names get a stricter test than word-list entries: these are matched
  // anywhere in the string, so "Shitlord" is caught even though "shit"
  // is not a whole word in it. Kept deliberately short — broad substrings
  // catch innocent words ("grape" contains "rape").
  var NAME_SUBSTRINGS = [
    'fuck', 'shit', 'cunt', 'whore', 'slut', 'wank', 'bitch', 'bastard',
    'nigg', 'fagg', 'kike', 'chink', 'tranny', 'retard', 'nazi', 'hitler',
    'penis', 'vagina', 'blowjob', 'handjob', 'porn', 'pedo', 'rapist',
  ];

  function isCleanName(text) {
    if (!isClean(text)) return false;
    var squashed = normalize(text).replace(/[^a-z]/g, '');
    for (var i = 0; i < NAME_SUBSTRINGS.length; i++) {
      if (squashed.indexOf(NAME_SUBSTRINGS[i]) !== -1) return false;
    }
    return true;
  }

  // Filter a list of words → { clean: [...], removed: n }
  function filter(words) {
    var clean = [];
    var removed = 0;
    for (var i = 0; i < words.length; i++) {
      if (isClean(words[i])) clean.push(words[i]);
      else removed++;
    }
    return { clean: clean, removed: removed };
  }

  return { isClean: isClean, isCleanName: isCleanName, filter: filter };
});
