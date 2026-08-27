// ─────────────────────────────────────────────────────────────
// game.js — rooms, matchmaking and the full game loop.
//
// Players are identified by a stable `key` (account id or guest
// key), NOT by socket id — so refreshing the page or dropping the
// connection briefly does not lose your seat, score or turn.
// ─────────────────────────────────────────────────────────────
const store = require('./store');
const authlib = require('./auth');
const words = require('./words');
const similarity = require('./similarity');
const friends = require('./friends');
const hints = require('./hints');
const scenes = require('../public/js/scenes');

const MAX_PLAYERS_DEFAULT = 10;
const MAX_PLAYERS_LIMIT = 20;
const CHOOSE_TIME = 20;
const ROUND_END_DELAY = 6000;
const GAME_END_DELAY = 12000;
const AUTO_START_SECONDS = 15;
const DISCONNECT_GRACE_MS = 90 * 1000;   // guessers may reconnect for 90s
const DRAWER_GRACE_MS = 20 * 1000;       // the active drawer gets 20s
const EMPTY_ROOM_TTL_MS = 60 * 1000;

const MAX_ROOMS = 500;
const MAX_CUSTOM_LISTS_PER_ROOM = 30;
const RESERVED_NAME = /^(__proto__|constructor|prototype)$/i;

const rooms = {};            // code -> room
const socketPlayers = new Map(); // socket.id -> { code, key }
const online = new Map();        // userId -> Set(socket.id)  (presence for friends)

function isOnline(userId) {
  const s = online.get(userId);
  return !!(s && s.size > 0);
}

// Emit an event to every socket a signed-in user has open.
function notifyUser(userId, event, payload) {
  const s = online.get(userId);
  if (!s) return 0;
  for (const sid of s) io.to(sid).emit(event, payload);
  return s.size;
}

let io = null;
let publicMatchCounter = 0;

// ── Helpers ──────────────────────────────────────────────────

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
function generateRoomCode() {
  for (let tries = 0; tries < 500; tries++) {
    let code = '';
    for (let i = 0; i < 4; i++) code += LETTERS[Math.floor(Math.random() * LETTERS.length)];
    if (!rooms[code]) return code;
  }
  // Practically unreachable — fall back to a longer code.
  let code = '';
  for (let i = 0; i < 6; i++) code += LETTERS[Math.floor(Math.random() * LETTERS.length)];
  return code;
}

function defaultOptions() {
  return {
    wordChoices: 5,
    roundTime: 90,
    hintCount: 5,
    rounds: 10,
    maxPlayers: MAX_PLAYERS_DEFAULT,
    combinations: false,
    hidden: false,
    autocorrectStrength: 1,   // 0 off · 1 easy · 2 normal · 3 generous (see similarity.js)
    showWordSource: false,
    lockComboParts: true,
    coopMode: false,
    spamProtection: true,     // per-player chat/guess flood + repeat guard
    textTool: false,          // lets artists type text onto the canvas
    avoidRepeats: true,       // words that came up stay out (with graceful fallback)
    canvasBackground: 'plain', // plain | grid | dots | lined
    sceneBackgrounds: false,   // lets the artist drop a scene behind their drawing
  };
}

const CANVAS_BACKGROUNDS = ['plain', 'grid', 'dots', 'lined'];

// Validate one drawing event from an artist. Returns the cleaned event,
// null to drop it silently, or { rejected } when the artist should be told.
function validateDrawEvent(room, data) {
  if (!data || typeof data !== 'object') return null;
  if (data.type === 'text') {
    if (!room.options.textTool) return null;
    const text = String(data.text || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!text) return null;
    if (room.currentWord && similarity.revealsAnswer(text, room.currentWord)) return { rejected: true };
    return {
      type: 'text',
      x: Number(data.x) || 0,
      y: Number(data.y) || 0,
      text,
      color: /^#[0-9a-fA-F]{6}$/.test(String(data.color)) ? data.color : '#111111',
      size: Math.max(2, Math.min(40, Number(data.size) || 6)),
    };
  }
  return data;
}

// ── Spam protection (toggleable per room; always on in public matches) ──
// Sliding window + repeated-message guard; offenders get a short mute.
function checkSpam(room, player, text) {
  if (!room.options.spamProtection && !room.managed) return { ok: true };
  const now = Date.now();
  const s = player.spam || (player.spam = { times: [], last: '', repeats: 0, mutedUntil: 0 });
  if (now < s.mutedUntil) return { ok: false };
  s.times = s.times.filter(t => now - t < 5000);
  s.times.push(now);
  const lower = text.toLowerCase();
  if (lower === s.last) s.repeats++;
  else { s.repeats = 0; s.last = lower; }
  if (s.times.length > 6 || s.repeats >= 3) {
    s.mutedUntil = now + 10 * 1000;
    s.times = [];
    s.repeats = 0;
    return { ok: false, justMuted: true };
  }
  return { ok: true };
}

function sanitizeName(name, fallback) {
  const clean = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 20);
  return clean || fallback;
}

function sanitizeAvatar(avatar) {
  const a = avatar || {};
  const emoji = (typeof a.emoji === 'string' && a.emoji.length > 0 && a.emoji.length <= 8) ? a.emoji : '🎨';
  const color = (typeof a.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(a.color)) ? a.color : '#6C5CE7';
  return { emoji, color };
}

function maskWord(word) {
  return maskWithReveals(word, []);
}

function maskWithReveals(word, revealedIndices) {
  return word.split('').map((c, i) => {
    if (c === ' ' || c === '+') return c;
    return revealedIndices.includes(i) ? c : '_';
  }).join('');
}

// Hint letters are chosen by lib/hints.js — spread across the words,
// biased toward informative letters, never giving away a whole sub-word.
function giveHint(word, revealedIndices, additionalCount) {
  const picked = hints.pickHintIndices(word, revealedIndices, additionalCount);
  revealedIndices.push(...picked);
  return hints.maskWord(word, revealedIndices);
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j], cur[j - 1], prev[j - 1]);
    }
    prev = cur;
  }
  return prev[n];
}

function connectedPlayers(room) {
  return room.players.filter(p => p.connected);
}

function playerByKey(room, key) {
  return room.players.find(p => p.key === key);
}

function currentDrawer(room) {
  return room.players[room.drawerIndex] || null;
}

function currentPartner(room) {
  if (!room.options.coopMode || room.coopPartnerIndex === null) return null;
  return room.players[room.coopPartnerIndex] || null;
}

function isArtistKey(room, key) {
  const d = currentDrawer(room);
  const p = currentPartner(room);
  return (d && d.key === key) || (p && p.key === key);
}

function userStats(userId) {
  const u = userId && store.db.users[userId];
  return u ? u.stats : null;
}

// ── Room lifecycle ───────────────────────────────────────────

function createRoom({ managed = false } = {}) {
  const code = generateRoomCode();
  const room = {
    code,
    name: null,
    public: managed,
    managed,
    players: [],
    hostKey: null,
    kickedKeys: new Set(),
    state: 'lobby',
    round: 0,
    drawerIndex: 0,
    coopPartnerIndex: null,
    currentWord: null,
    wordChoices: [],
    wordChoicesPart2: [],
    combinationPart1: null,
    wordChoicesSources: {},
    currentWordSource: null,
    currentWordSource2: null,
    timeLeft: 0,
    hintTimes: [],
    hintsGiven: 0,
    skipHints: false,
    revealedIndices: [],
    strokes: [],
    currentStroke: [],
    drawHistory: [],
    scores: {},           // key -> points
    guessedKeys: new Set(),
    lockedParts: {},      // key -> locked combo part
    skipVotes: new Set(),
    roundLikes: new Set(),
    roundPoints: {},
    roundArtistKeys: [],
    selectedLists: [],
    listWeights: {},
    customLists: {},
    wordUsedCount: {},
    wordOffered: new Set(),   // lower-cased words shown as choices (avoid-repeats)
    scene: null,              // backdrop id the artist picked for this round
    autoStart: null,
    transitionTimer: null,
    emptySince: null,
    options: defaultOptions(),
  };
  if (managed) {
    publicMatchCounter++;
    room.name = `Public Match #${publicMatchCounter}`;
    room.selectedLists = words.builtinLists[words.CLASSIC_LIST] ? [words.CLASSIC_LIST] : Object.keys(words.builtinLists);
  } else {
    // Default new private rooms to the classic list if present, else everything.
    room.selectedLists = words.builtinLists[words.CLASSIC_LIST] ? [words.CLASSIC_LIST] : Object.keys(words.builtinLists);
  }
  room.interval = setInterval(() => roomTick(room), 1000);
  rooms[code] = room;
  return room;
}

function destroyRoom(room) {
  clearInterval(room.interval);
  if (room.transitionTimer) { clearTimeout(room.transitionTimer); room.transitionTimer = null; }
  delete rooms[room.code];
}

function getRoomPublicState(room) {
  return {
    code: room.code,
    name: room.name,
    public: room.public,
    managed: room.managed,
    state: room.state,
    round: room.round,
    totalRounds: room.options.rounds,
    players: room.players.map(p => ({
      id: p.key,
      name: p.name,
      avatar: p.avatar,
      accountId: p.userId || null,
      score: room.scores[p.key] || 0,
      connected: p.connected,
      guessed: room.guessedKeys.has(p.key),
    })),
    host: room.hostKey,
    currentDrawerId: currentDrawer(room)?.key || null,
    coopPartnerId: currentPartner(room)?.key || null,
    timeLeft: room.timeLeft,
    autoStart: room.autoStart,
    wordSpaces: (room.currentWord && !room.options.hidden && room.state === 'drawing')
      ? maskWithReveals(room.currentWord, room.revealedIndices) : null,
    hiddenMode: !!room.options.hidden,
    likeCount: room.roundLikes.size,
    scene: room.scene,
    wordPool: room.state === 'lobby' ? words.poolStats(room) : null,
    wordLists: {
      available: words.catalog(room),
      selected: room.selectedLists,
      weights: room.listWeights,
    },
    options: { ...room.options },
  };
}

function broadcastState(room) {
  io.to(room.code).emit('stateUpdate', getRoomPublicState(room));
}

function listPublicRooms() {
  return Object.values(rooms)
    .filter(r => r.public)
    .map(r => ({
      code: r.code,
      name: r.name || 'Room',
      managed: r.managed,
      state: r.state,
      players: connectedPlayers(r).length,
      maxPlayers: r.options.maxPlayers,
      round: r.round,
      totalRounds: r.options.rounds,
      lists: r.selectedLists.slice(0, 4),
    }))
    .sort((a, b) => b.players - a.players);
}

// ── The per-second room tick ─────────────────────────────────

function roomTick(room) {
  // Prune players whose disconnect grace expired.
  const now = Date.now();
  for (const p of [...room.players]) {
    if (!p.connected && p.disconnectedAt) {
      const isDrawing = (room.state === 'choosing' || room.state === 'drawing');
      const grace = (isDrawing && isArtistKey(room, p.key)) ? DRAWER_GRACE_MS : DISCONNECT_GRACE_MS;
      if (now - p.disconnectedAt > grace) {
        removePlayer(room, p.key, { reason: 'timeout' });
        if (!rooms[room.code]) return; // room destroyed
      }
    }
  }

  // Destroy rooms that have been empty (no connected players) too long.
  if (connectedPlayers(room).length === 0) {
    if (!room.emptySince) room.emptySince = now;
    if (now - room.emptySince > EMPTY_ROOM_TTL_MS) { destroyRoom(room); return; }
  } else {
    room.emptySince = null;
  }

  // Managed rooms: automatic start countdown in the lobby.
  if (room.managed && room.state === 'lobby') {
    const n = connectedPlayers(room).length;
    if (n >= 2) {
      if (room.autoStart === null) {
        room.autoStart = AUTO_START_SECONDS;
        io.to(room.code).emit('autoStart', { seconds: room.autoStart });
      } else {
        room.autoStart--;
        io.to(room.code).emit('autoStart', { seconds: room.autoStart });
        if (room.autoStart <= 0) {
          room.autoStart = null;
          beginGame(room);
          return;
        }
      }
    } else if (room.autoStart !== null) {
      room.autoStart = null;
      io.to(room.code).emit('autoStart', { seconds: null });
    }
  }

  // Phase countdowns.
  if (room.state === 'choosing') {
    room.timeLeft = Math.max(0, room.timeLeft - 1);
    io.to(room.code).emit('timerTick', { timeLeft: room.timeLeft });
    if (room.timeLeft <= 0) autoPickWord(room);
  } else if (room.state === 'drawing') {
    room.timeLeft = Math.max(0, room.timeLeft - 1);

    if (!room.skipHints) {
      for (let i = 0; i < room.hintTimes.length; i++) {
        if (room.timeLeft === room.hintTimes[i] && room.hintsGiven === i) {
          room.hintsGiven = i + 1;
          const hint = giveHint(room.currentWord, room.revealedIndices, 1);
          io.to(room.code).emit('hint', { hint });
          break;
        }
      }
    }

    io.to(room.code).emit('timerTick', { timeLeft: room.timeLeft });
    if (room.timeLeft <= 0) endDrawingRound(room);
  }
}

// ── Join / leave / reconnect ─────────────────────────────────

function addPlayer(room, socket, identity) {
  const player = {
    key: identity.key,
    socketId: socket.id,
    userId: identity.userId || null,
    name: identity.name,
    avatar: identity.avatar,
    connected: true,
    disconnectedAt: null,
  };
  room.players.push(player);
  if (!(player.key in room.scores)) room.scores[player.key] = 0;
  if (!room.managed && !room.hostKey) room.hostKey = player.key;
  socketPlayers.set(socket.id, { code: room.code, key: player.key });
  socket.join(room.code);
  return player;
}

function removePlayer(room, key, { reason } = {}) {
  const idx = room.players.findIndex(p => p.key === key);
  if (idx === -1) return;
  const player = room.players[idx];
  const wasDrawer = idx === room.drawerIndex && (room.state === 'choosing' || room.state === 'drawing');
  const wasPartner = idx === room.coopPartnerIndex && (room.state === 'choosing' || room.state === 'drawing');

  room.players.splice(idx, 1);
  delete room.scores[key];
  room.guessedKeys.delete(key);
  room.skipVotes.delete(key);
  delete room.lockedParts[key];
  if (player.socketId) socketPlayers.delete(player.socketId);

  // Keep drawer/partner indices pointing at the same players.
  if (idx < room.drawerIndex) room.drawerIndex--;
  if (room.coopPartnerIndex !== null) {
    if (idx < room.coopPartnerIndex) room.coopPartnerIndex--;
    else if (idx === room.coopPartnerIndex) room.coopPartnerIndex = null;
  }

  if (room.players.length === 0) { destroyRoom(room); return; }

  // Host migration.
  if (!room.managed && room.hostKey === key) {
    const next = connectedPlayers(room)[0] || room.players[0];
    room.hostKey = next ? next.key : null;
    if (next) io.to(room.code).emit('chat', { system: true, text: `👑 ${next.name} is now the host.` });
  }

  io.to(room.code).emit('playerLeft', {
    playerName: player.name,
    kicked: reason === 'kicked',
    state: getRoomPublicState(room),
  });

  if (room.state === 'choosing' || room.state === 'drawing') {
    if (connectedPlayers(room).length < 2) {
      // Not enough players to continue.
      resetToLobby(room, 'Not enough players — back to the lobby.');
      return;
    }
    if (wasDrawer) {
      abortRound(room, `${player.name} left — the word was`);
      return;
    }
    if (wasPartner) {
      io.to(room.code).emit('chat', { system: true, text: `🎨 ${player.name} left — solo drawing now!` });
      // If the departed partner held the word choices, hand them to the drawer.
      if (room.state === 'choosing') {
        const d = currentDrawer(room);
        const dSocket = d?.socketId && io.sockets.sockets.get(d.socketId);
        if (dSocket) resendChoices(room, d, dSocket);
      }
      broadcastState(room);
    }
    // A guesser leaving may mean everyone remaining has guessed,
    // or that standing skip votes now reach the (smaller) majority.
    maybeEndOnAllGuessed(room);
    maybeSkipOnVotes(room);
  }
  broadcastState(room);
}

function resumePlayer(room, player, socket) {
  player.socketId = socket.id;
  player.connected = true;
  player.disconnectedAt = null;
  socketPlayers.set(socket.id, { code: room.code, key: player.key });
  socket.join(room.code);

  socket.emit('roomJoined', { code: room.code, state: getRoomPublicState(room), resumed: true });
  // Restore role-specific info.
  if (room.state === 'drawing' || room.state === 'choosing') {
    if (room.drawHistory.length > 0) socket.emit('drawHistory', { history: room.drawHistory });
  }
  if (room.state === 'drawing' && isArtistKey(room, player.key)) {
    socket.emit('yourWord', { word: room.currentWord, sourceList: room.currentWordSource, sourceList2: room.currentWordSource2 });
  }
  if (room.state === 'choosing') {
    resendChoices(room, player, socket);
  }
  if (room.state === 'drawing' && room.lockedParts[player.key]) {
    const aParts = room.currentWord.split('+').map(p => p.trim());
    const lockedPart = room.lockedParts[player.key];
    const remaining = aParts.find(p => p !== lockedPart) || '';
    socket.emit('partLocked', {
      lockedPart,
      remainingMask: maskWord(remaining),
      lockedIsFirst: aParts[0] === lockedPart,
    });
  }
  io.to(room.code).emit('chat', { system: true, text: `🔌 ${player.name} reconnected!` });
  broadcastState(room);
}

// Re-send the word-choice UI to a player who reconnected mid-choosing.
function resendChoices(room, player, socket) {
  const drawer = currentDrawer(room);
  const partner = currentPartner(room);
  if (!drawer) return;
  const isCombo = room.options.combinations;
  if (isCombo) {
    if (!room.combinationPart1 && drawer.key === player.key) {
      socket.emit('wordChoices', { words: room.wordChoices, part: 1, isCoopCombo: !!partner, coopPartnerName: partner?.name || null });
    } else if (room.combinationPart1) {
      const recipient = (room.options.coopMode && partner) ? partner : drawer;
      if (recipient.key === player.key) {
        socket.emit('wordChoices', { words: room.wordChoicesPart2, part: 2, firstWord: room.combinationPart1, coopPart2: !!(room.options.coopMode && partner), firstPickerName: drawer.name });
      }
    }
  } else {
    const picker = wordPickerFor(room);
    if (picker && picker.key === player.key) {
      socket.emit('wordChoices', { words: room.wordChoices });
    } else if (isArtistKey(room, player.key)) {
      socket.emit('wordChoices', { words: room.wordChoices, readOnly: true, pickerName: picker?.name || 'Partner' });
    }
  }
}

// ── Game flow ────────────────────────────────────────────────

function beginGame(room) {
  room.round = 1;
  room.drawerIndex = 0;
  // Word history deliberately survives across games in the same room —
  // it resets when the host changes lists or toggles "avoid repeats".
  room.players.forEach(p => { room.scores[p.key] = 0; });
  room.autoStart = null;
  startRound(room);
}

function wordPickerFor(room) {
  const drawer = currentDrawer(room);
  const partner = currentPartner(room);
  if (!drawer) return null;
  if (partner && !room.options.combinations) {
    const ds = room.scores[drawer.key] || 0;
    const ps = room.scores[partner.key] || 0;
    if (ps > ds) return partner;
  }
  return drawer;
}

function startRound(room) {
  if (room.transitionTimer) { clearTimeout(room.transitionTimer); room.transitionTimer = null; }

  // A player may have left/timed out during the round-end screen.
  if (connectedPlayers(room).length < 2) {
    resetToLobby(room, 'Not enough players — back to the lobby.');
    return;
  }

  room.roundArtistKeys = [];
  room.strokes = [];
  room.currentStroke = [];
  room.drawHistory = [];
  room.guessedKeys = new Set();
  room.skipVotes = new Set();
  room.roundLikes = new Set();
  room.roundPoints = {};
  room.hintsGiven = 0;
  room.revealedIndices = [];
  room.currentWord = null;
  room.lockedParts = {};
  room.combinationPart1 = null;
  room.wordChoicesPart2 = [];
  room.wordChoicesSources = {};
  room.currentWordSource = null;
  room.currentWordSource2 = null;
  room.coopPartnerIndex = null;
  room.scene = null;

  // Skip disconnected drawers.
  let guard = 0;
  while (guard++ < room.players.length + 2) {
    if (room.drawerIndex >= room.players.length) {
      room.drawerIndex = 0;
      room.round++;
    }
    if (room.round > room.options.rounds) { endGame(room); return; }
    const candidate = room.players[room.drawerIndex];
    if (!candidate) { endGame(room); return; }
    if (candidate.connected) break;
    room.drawerIndex++;
  }
  if (room.round > room.options.rounds) { endGame(room); return; }

  const drawer = currentDrawer(room);
  if (!drawer) { endGame(room); return; }
  if (!drawer.connected) { resetToLobby(room, 'Not enough connected players.'); return; }

  // Co-op partner: random other connected player (needs a guesser left over).
  let partner = null;
  if (room.options.coopMode && connectedPlayers(room).length >= 3) {
    const others = room.players
      .map((p, i) => ({ p, i }))
      .filter(({ p, i }) => i !== room.drawerIndex && p.connected);
    if (others.length > 0) {
      const pick = others[Math.floor(Math.random() * others.length)];
      room.coopPartnerIndex = pick.i;
      partner = pick.p;
    }
  }

  const withSource = words.getWordChoicesWithSource(room, room.options.wordChoices);
  if (withSource.length === 0) {
    resetToLobby(room, 'No words available — check the word list selection.');
    return;
  }
  room.wordChoices = withSource.map(w => w.word);
  withSource.forEach(w => room.wordOffered.add(w.word.toLowerCase()));
  room.wordChoicesSources = {};
  withSource.forEach(({ word, listName }) => { room.wordChoicesSources[word] = listName; });
  room.state = 'choosing';
  room.timeLeft = CHOOSE_TIME;

  const picker = wordPickerFor(room);

  io.to(room.code).emit('roundStart', {
    ...getRoomPublicState(room),
    drawerId: drawer.key,
    drawerName: drawer.name,
    coopPartnerId: partner?.key || null,
    coopPartnerName: partner?.name || null,
    wordPickerId: picker.key,
  });

  const emitTo = (player, payload) => {
    if (player && player.socketId) io.to(player.socketId).emit('wordChoices', payload);
  };

  if (room.options.combinations) {
    emitTo(drawer, { words: room.wordChoices, part: 1, isCoopCombo: !!partner, coopPartnerName: partner?.name || null });
    if (partner) emitTo(partner, { words: room.wordChoices, part: 1, readOnly: true, pickerName: drawer.name });
  } else {
    emitTo(picker, { words: room.wordChoices });
    if (partner) {
      const nonPicker = (picker.key === drawer.key) ? partner : drawer;
      emitTo(nonPicker, { words: room.wordChoices, readOnly: true, pickerName: picker.name });
    }
  }
}

function autoPickWord(room) {
  if (room.state !== 'choosing') return;
  if (room.options.combinations && !room.combinationPart1) {
    const p1 = room.wordChoices[0] || 'word';
    const p2arr = words.getWordChoices(room, 1, new Set([p1]));
    wordChosen(room, `${p1}+${p2arr[0] || 'other'}`);
  } else if (room.options.combinations && room.combinationPart1) {
    const p2 = room.wordChoicesPart2[0]
      || words.getWordChoices(room, 1, new Set([room.combinationPart1]))[0]
      || 'other';
    wordChosen(room, `${room.combinationPart1}+${p2}`);
  } else {
    wordChosen(room, room.wordChoices[0]);
  }
}

function wordChosen(room, word) {
  room.currentWord = word;
  for (const part of word.split('+')) {
    room.wordUsedCount[part] = (room.wordUsedCount[part] || 0) + 1;
  }
  const wordParts = word.split('+');
  room.currentWordSource = room.wordChoicesSources[wordParts[0]] || null;
  room.currentWordSource2 = wordParts.length > 1 ? (room.wordChoicesSources[wordParts[1]] || null) : null;
  room.state = 'drawing';
  room.lockedParts = {};
  room.combinationPart1 = null;
  room.wordChoicesPart2 = [];
  room.timeLeft = room.options.roundTime;
  room.strokes = [];
  room.currentStroke = [];
  room.drawHistory = [];
  room.revealedIndices = [];
  room.hintsGiven = 0;

  const drawer = currentDrawer(room);
  const partner = currentPartner(room);
  // Snapshot the round's artists — likeRound needs them after drawerIndex advances.
  room.roundArtistKeys = [drawer?.key, partner?.key].filter(Boolean);

  io.to(room.code).emit('drawingStart', {
    ...getRoomPublicState(room),
    maskedWord: maskWord(word),
    scene: room.scene,
    drawerId: drawer?.key || null,
    drawerName: drawer?.name || '?',
    coopPartnerId: partner?.key || null,
    coopPartnerName: partner?.name || null,
    wordSource: room.options.showWordSource ? room.currentWordSource : null,
    wordSource2: room.options.showWordSource ? room.currentWordSource2 : null,
  });

  const wordPayload = { word, sourceList: room.currentWordSource, sourceList2: room.currentWordSource2 };
  if (drawer?.socketId) io.to(drawer.socketId).emit('yourWord', wordPayload);
  if (partner?.socketId) io.to(partner.socketId).emit('yourWord', wordPayload);

  // Hints: reveal 1 letter each, spread across the round. Ask the hint picker
  // how many reveals this word can actually give up — counting all the letters
  // together over-schedules multi-word answers ("ice cream" allows 3, not 4)
  // and the surplus ticks would fire with an unchanged mask.
  const skipHints = room.options.hidden || room.options.combinations;
  const effectiveHintCount = Math.min(room.options.hintCount, hints.hintPlan(word, room.options.hintCount).length);
  const hintTimes = [];
  if (!skipHints && effectiveHintCount > 0) {
    for (let i = 1; i <= effectiveHintCount; i++) {
      hintTimes.push(Math.floor(room.options.roundTime * (effectiveHintCount - i + 1) / (effectiveHintCount + 1)));
    }
  }
  room.hintTimes = hintTimes;
  room.skipHints = skipHints;
}

function maybeEndOnAllGuessed(room) {
  if (room.state !== 'drawing') return;
  const drawer = currentDrawer(room);
  const partner = currentPartner(room);
  const guessers = connectedPlayers(room).filter(p => p.key !== drawer?.key && p.key !== partner?.key);
  if (guessers.length > 0 && guessers.every(p => room.guessedKeys.has(p.key))) {
    endDrawingRound(room);
  }
}

function maybeSkipOnVotes(room) {
  if (room.state !== 'drawing') return;
  const eligible = connectedPlayers(room).filter(p => !isArtistKey(room, p.key));
  if (eligible.length === 0) return;
  const votes = [...room.skipVotes].filter(k => eligible.some(p => p.key === k)).length;
  const needed = Math.floor(eligible.length / 2) + 1;
  if (votes >= needed) {
    io.to(room.code).emit('chat', { system: true, text: '⏭️ Vote passed — skipping this round!' });
    endDrawingRound(room);
  }
}

function endDrawingRound(room) {
  if (room.state !== 'drawing') return;
  awardArtists(room);
  room.state = 'roundEnd';

  const drawer = currentDrawer(room);
  const partner = currentPartner(room);

  // Credit "words drawn" stats for logged-in artists.
  for (const artist of [drawer, partner]) {
    const stats = artist && userStats(artist.userId);
    if (stats) { stats.wordsDrawn++; store.scheduleSave(); }
  }

  io.to(room.code).emit('roundEnd', {
    word: room.currentWord,
    wordSource: room.options.showWordSource ? room.currentWordSource : null,
    wordSource2: room.options.showWordSource ? room.currentWordSource2 : null,
    drawerName: drawer?.name || '?',
    coopPartnerName: partner?.name || null,
    guessedCount: room.guessedKeys.size,
    guesserCount: Math.max(0, connectedPlayers(room).length - (partner ? 2 : 1)),
    likeCount: room.roundLikes.size,
    scores: room.players.map(p => ({
      id: p.key, name: p.name,
      score: room.scores[p.key] || 0,
      delta: room.roundPoints[p.key] || 0,
    })),
  });

  room.drawerIndex++;
  room.transitionTimer = setTimeout(() => {
    room.transitionTimer = null;
    if (rooms[room.code]) startRound(room);
  }, ROUND_END_DELAY);
}

// Round aborted (drawer left / vote skipped) — drawerIndex has already
// been adjusted by removePlayer when the drawer left, so don't advance.
function abortRound(room, reasonPrefix) {
  if (room.state !== 'choosing' && room.state !== 'drawing') return;
  const word = room.currentWord;
  room.state = 'roundEnd';
  io.to(room.code).emit('roundEnd', {
    word: word || null,
    aborted: true,
    drawerName: null,
    coopPartnerName: null,
    guessedCount: room.guessedKeys.size,
    guesserCount: Math.max(0, connectedPlayers(room).length - 1),
    likeCount: room.roundLikes.size,
    reason: word ? `${reasonPrefix} "${word}"` : `${reasonPrefix.replace(' — the word was', '')}`,
    scores: room.players.map(p => ({
      id: p.key, name: p.name,
      score: room.scores[p.key] || 0,
      delta: room.roundPoints[p.key] || 0,
    })),
  });
  room.transitionTimer = setTimeout(() => {
    room.transitionTimer = null;
    if (rooms[room.code]) startRound(room);
  }, ROUND_END_DELAY);
}

function endGame(room) {
  room.state = 'gameEnd';
  room.currentWord = null;

  const finalScores = room.players
    .map(p => ({ id: p.key, name: p.name, avatar: p.avatar, score: room.scores[p.key] || 0 }))
    .sort((a, b) => b.score - a.score);

  // Account stats.
  const topScore = finalScores[0]?.score || 0;
  for (const p of room.players) {
    const stats = userStats(p.userId);
    if (!stats) continue;
    stats.games++;
    stats.points += room.scores[p.key] || 0;
    if (topScore > 0 && (room.scores[p.key] || 0) === topScore) stats.wins++;
  }
  store.scheduleSave();

  io.to(room.code).emit('gameEnd', { finalScores });

  room.transitionTimer = setTimeout(() => {
    room.transitionTimer = null;
    if (rooms[room.code]) backToLobby(room);
  }, GAME_END_DELAY);
}

function backToLobby(room) {
  if (room.transitionTimer) { clearTimeout(room.transitionTimer); room.transitionTimer = null; }
  room.state = 'lobby';
  room.round = 0;
  room.drawerIndex = 0;
  room.coopPartnerIndex = null;
  room.currentWord = null;
  room.players.forEach(p => { room.scores[p.key] = 0; });
  io.to(room.code).emit('backToLobby', getRoomPublicState(room));
}

function resetToLobby(room, message) {
  if (room.transitionTimer) { clearTimeout(room.transitionTimer); room.transitionTimer = null; }
  room.state = 'lobby';
  room.round = 0;
  room.drawerIndex = 0;
  room.coopPartnerIndex = null;
  room.currentWord = null;
  if (message) io.to(room.code).emit('chat', { system: true, text: `ℹ️ ${message}` });
  io.to(room.code).emit('backToLobby', getRoomPublicState(room));
}

// ── Scoring ──────────────────────────────────────────────────
//
// Fixed point algorithm:
//  • Guessers earn 250–500 depending on remaining time, reduced ~8%
//    per player who guessed before them (never below 60% / 50 pts).
//  • Artists are paid once, at round end, proportionally to how many
//    guessers got the word (up to 350, +50 perfect-round bonus) — so
//    big rooms no longer inflate drawer scores and skipped rounds
//    pay fairly.

const round5 = n => Math.round(n / 5) * 5;

function awardCorrectGuess(room, guesser) {
  const timeFrac = room.options.roundTime > 0 ? room.timeLeft / room.options.roundTime : 0;
  const rank = room.guessedKeys.size; // guesser was already added — 1 = first
  const rankFactor = Math.max(0.6, 1 - 0.08 * (rank - 1));
  const points = Math.max(50, round5((250 + 250 * timeFrac) * rankFactor));
  room.scores[guesser.key] = (room.scores[guesser.key] || 0) + points;
  room.roundPoints[guesser.key] = (room.roundPoints[guesser.key] || 0) + points;

  const stats = userStats(guesser.userId);
  if (stats) { stats.guesses++; store.scheduleSave(); }

  return points;
}

function awardArtists(room) {
  const drawer = currentDrawer(room);
  const partner = currentPartner(room);
  // Denominator matches the all-guessed trigger: connected guessers, plus
  // anyone who guessed correctly before disconnecting.
  const guessers = room.players.filter(p =>
    p.key !== drawer?.key && p.key !== partner?.key &&
    (p.connected || room.guessedKeys.has(p.key)));
  const guessed = [...room.guessedKeys].filter(k => guessers.some(p => p.key === k)).length;
  const denom = Math.max(1, guessers.length);
  const frac = Math.min(1, guessed / denom);
  let pts = round5(350 * frac);
  if (frac >= 1 && guessed > 0) pts += 50;
  for (const artist of [drawer, partner]) {
    if (!artist || pts <= 0) continue;
    room.scores[artist.key] = (room.scores[artist.key] || 0) + pts;
    room.roundPoints[artist.key] = (room.roundPoints[artist.key] || 0) + pts;
  }
}

// ── Socket wiring ────────────────────────────────────────────

function resolveIdentity(socket) {
  const auth = socket.handshake.auth || {};
  const user = authlib.userForToken(auth.token);
  if (user) {
    return {
      key: 'u:' + user.id,
      userId: user.id,
      name: sanitizeName(auth.name, user.username),
      avatar: sanitizeAvatar(auth.avatar || user.avatar),
      username: user.username,
    };
  }
  const guestKey = (typeof auth.guestKey === 'string' && /^[a-f0-9]{8,64}$/.test(auth.guestKey))
    ? auth.guestKey
    : socket.id.replace(/[^a-zA-Z0-9]/g, '').toLowerCase().padEnd(8, '0').slice(0, 16);
  return {
    key: 'g:' + guestKey,
    userId: null,
    name: sanitizeName(auth.name, 'Player'),
    avatar: sanitizeAvatar(auth.avatar),
    username: null,
  };
}

function getContext(socket) {
  const ref = socketPlayers.get(socket.id);
  if (!ref) return null;
  const room = rooms[ref.code];
  if (!room) { socketPlayers.delete(socket.id); return null; }
  const player = playerByKey(room, ref.key);
  if (!player || player.socketId !== socket.id) return null;
  return { room, player };
}

function joinRoomFlow(socket, identity, room, { quiet = false } = {}) {
  const fail = (message) => {
    if (quiet) socket.emit('joinFailed', { code: room.code, message });
    else socket.emit('error', { message });
  };

  if (room.kickedKeys.has(identity.key)) return fail('You were kicked from this room.');

  const existing = playerByKey(room, identity.key);
  if (existing) {
    if (existing.connected && io.sockets.sockets.get(existing.socketId)) {
      return fail('You are already in this room in another tab.');
    }
    // Refresh identity details, then resume the seat.
    existing.name = identity.name || existing.name;
    existing.avatar = identity.avatar || existing.avatar;
    resumePlayer(room, existing, socket);
    return;
  }

  if (room.players.length >= room.options.maxPlayers) return fail('Room is full.');

  const player = addPlayer(room, socket, identity);
  socket.emit('roomJoined', { code: room.code, state: getRoomPublicState(room) });
  socket.to(room.code).emit('playerJoined', {
    player: { id: player.key, name: player.name, avatar: player.avatar },
    state: getRoomPublicState(room),
  });
  if (room.state === 'drawing' && room.drawHistory.length > 0) {
    socket.emit('drawHistory', { history: room.drawHistory });
  }
}

function init(_io) {
  io = _io;

  io.on('connection', (socket) => {
    // Per-socket flood guards: drawing gets its own generous budget,
    // everything else shares a small one. Excess packets are dropped.
    let genTimes = [];
    let drawTimes = [];
    socket.use((packet, next) => {
      const now = Date.now();
      if (packet[0] === 'draw' || packet[0] === 'drawBatch') {
        drawTimes = drawTimes.filter(t => now - t < 1000);
        if (drawTimes.length >= 400) return;
        drawTimes.push(now);
      } else {
        genTimes = genTimes.filter(t => now - t < 1000);
        if (genTimes.length >= 25) return;
        genTimes.push(now);
      }
      next();
    });

    let identity = resolveIdentity(socket);
    if (identity.userId) {
      if (!online.has(identity.userId)) online.set(identity.userId, new Set());
      online.get(identity.userId).add(socket.id);
    }
    socket.emit('welcome', {
      key: identity.key,
      name: identity.name,
      avatar: identity.avatar,
      loggedIn: !!identity.userId,
      username: identity.username,
    });

    socket.on('createRoom', ({ name, avatar } = {}) => {
      if (getContext(socket)) return;
      // Throttle room creation (and cap total live rooms).
      const now = Date.now();
      if (socket.data.lastRoomCreate && now - socket.data.lastRoomCreate < 3000) return;
      socket.data.lastRoomCreate = now;
      if (Object.keys(rooms).length >= MAX_ROOMS) {
        return socket.emit('error', { message: 'The server is full right now — try again soon.' });
      }
      identity.name = sanitizeName(name, identity.name);
      if (avatar) identity.avatar = sanitizeAvatar(avatar);
      const room = createRoom({ managed: false });
      addPlayer(room, socket, identity);
      socket.emit('roomCreated', { code: room.code, state: getRoomPublicState(room) });
    });

    socket.on('joinRoom', ({ code, name, avatar, quiet } = {}) => {
      if (getContext(socket)) return;
      const cleanCode = String(code || '').trim().toUpperCase();
      const room = rooms[cleanCode];
      if (!room) {
        if (quiet) socket.emit('joinFailed', { code: cleanCode, message: 'Room not found.' });
        else socket.emit('error', { message: 'Room not found — check the code.' });
        return;
      }
      identity.name = sanitizeName(name, identity.name);
      if (avatar) identity.avatar = sanitizeAvatar(avatar);
      joinRoomFlow(socket, identity, room, { quiet: !!quiet });
    });

    // Quick play: hop into a public managed match, creating one if needed.
    socket.on('quickPlay', ({ name, avatar } = {}) => {
      if (getContext(socket)) return;
      identity.name = sanitizeName(name, identity.name);
      if (avatar) identity.avatar = sanitizeAvatar(avatar);
      let room = Object.values(rooms)
        .filter(r => r.managed && r.players.length < r.options.maxPlayers && !r.kickedKeys.has(identity.key) && !playerByKey(r, identity.key))
        .sort((a, b) => {
          // Prefer matches already in progress (jump straight into the
          // action), then waiting lobbies; fullest first in each group.
          const stateRank = s => (s === 'lobby' ? 1 : 0);
          return stateRank(a.state) - stateRank(b.state) || b.players.length - a.players.length;
        })[0];
      if (!room) {
        if (Object.keys(rooms).length >= MAX_ROOMS) {
          return socket.emit('error', { message: 'The server is full right now — try again soon.' });
        }
        room = createRoom({ managed: true });
      }
      joinRoomFlow(socket, identity, room);
    });

    socket.on('listRooms', () => {
      socket.emit('roomList', { rooms: listPublicRooms() });
    });

    socket.on('startGame', () => {
      const ctx = getContext(socket);
      if (!ctx) return;
      const { room, player } = ctx;
      if (room.managed) return;
      if (room.hostKey !== player.key) return socket.emit('error', { message: 'Only the host can start.' });
      if (room.state !== 'lobby') return;
      if (connectedPlayers(room).length < 2) return socket.emit('error', { message: 'Need at least 2 players.' });
      if (room.options.coopMode && connectedPlayers(room).length < 3) {
        return socket.emit('error', { message: 'Co-op mode needs at least 3 players.' });
      }
      beginGame(room);
    });

    socket.on('setRoomPublic', ({ public: isPublic } = {}) => {
      const ctx = getContext(socket);
      if (!ctx) return;
      const { room, player } = ctx;
      if (room.managed || room.hostKey !== player.key) return;
      room.public = !!isPublic;
      if (room.public && !room.name) room.name = `${player.name}'s room`;
      broadcastState(room);
    });

    socket.on('setWordLists', ({ lists, weights } = {}) => {
      const ctx = getContext(socket);
      if (!ctx) return;
      const { room, player } = ctx;
      if (room.managed || room.hostKey !== player.key || room.state !== 'lobby') return;
      const all = words.availableLists(room);
      const valid = Array.isArray(lists) ? lists.filter(l => all[l]) : [];
      const before = JSON.stringify([...room.selectedLists].sort());
      room.selectedLists = valid.length > 0 ? valid : Object.keys(all);
      if (JSON.stringify([...room.selectedLists].sort()) !== before) {
        room.wordUsedCount = {};
        room.wordOffered = new Set();
      }
      room.listWeights = {};
      if (weights && typeof weights === 'object') {
        for (const [lname, w] of Object.entries(weights)) {
          // Weighting fix: custom lists get weights too.
          if (all[lname]) room.listWeights[lname] = Math.max(1, Math.min(10, Number(w) || 1));
        }
      }
      broadcastState(room);
    });

    socket.on('addCustomList', ({ name, text } = {}) => {
      const ctx = getContext(socket);
      if (!ctx) return;
      const { room, player } = ctx;
      if (room.managed || room.hostKey !== player.key || room.state !== 'lobby') return;
      if (typeof name !== 'string' || typeof text !== 'string' || !text.trim()) return;
      let cleanName = name.trim().slice(0, 40).replace(/[^\p{L}\p{N} _\-']/gu, '').trim();
      if (!cleanName || RESERVED_NAME.test(cleanName)) cleanName = 'Custom list';
      if (!Object.prototype.hasOwnProperty.call(room.customLists, cleanName)
          && Object.keys(room.customLists).length >= MAX_CUSTOM_LISTS_PER_ROOM) {
        return socket.emit('error', { message: 'This room has too many custom lists.' });
      }
      const wordsArr = parseWordText(text);
      if (wordsArr.length === 0) return socket.emit('error', { message: 'No words found in that list.' });
      room.customLists[cleanName] = wordsArr;
      if (!room.selectedLists.includes(cleanName)) room.selectedLists.push(cleanName);
      broadcastState(room);
      socket.emit('customListAdded', { name: cleanName, count: wordsArr.length });
    });

    // Rename a custom list already added to this room.
    socket.on('renameCustomList', ({ name, newName } = {}) => {
      const ctx = getContext(socket);
      if (!ctx) return;
      const { room, player } = ctx;
      if (room.managed || room.hostKey !== player.key || room.state !== 'lobby') return;
      if (typeof name !== 'string' || typeof newName !== 'string') return;
      if (!Object.prototype.hasOwnProperty.call(room.customLists, name)) return;
      let clean = newName.trim().slice(0, 40).replace(/[^\p{L}\p{N} _\-']/gu, '').trim();
      if (!clean || RESERVED_NAME.test(clean)) return socket.emit('error', { message: 'That name will not work — try another.' });
      if (clean === name) return;
      if (Object.prototype.hasOwnProperty.call(room.customLists, clean) || words.builtinLists[clean]) {
        return socket.emit('error', { message: 'There is already a list with that name.' });
      }
      // Move the words, the selection slot and the weight across to the new key.
      room.customLists[clean] = room.customLists[name];
      delete room.customLists[name];
      room.selectedLists = room.selectedLists.map(l => (l === name ? clean : l));
      if (room.listWeights[name] !== undefined) {
        room.listWeights[clean] = room.listWeights[name];
        delete room.listWeights[name];
      }
      broadcastState(room);
      socket.emit('customListRenamed', { from: name, to: clean });
    });

    // Drop a custom list from this room entirely.
    socket.on('removeCustomList', ({ name } = {}) => {
      const ctx = getContext(socket);
      if (!ctx) return;
      const { room, player } = ctx;
      if (room.managed || room.hostKey !== player.key || room.state !== 'lobby') return;
      if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(room.customLists, name)) return;
      delete room.customLists[name];
      delete room.listWeights[name];
      room.selectedLists = room.selectedLists.filter(l => l !== name);
      // Never leave the room with nothing to draw from.
      if (room.selectedLists.length === 0) {
        const fallback = words.builtinLists[words.CLASSIC_LIST] ? words.CLASSIC_LIST : Object.keys(words.availableLists(room))[0];
        if (fallback) room.selectedLists = [fallback];
      }
      broadcastState(room);
      socket.emit('customListRemoved', { name });
    });

    // Attach one of your saved account lists to the room.
    socket.on('attachAccountList', ({ listId } = {}) => {
      const ctx = getContext(socket);
      if (!ctx) return;
      const { room, player } = ctx;
      if (room.managed || room.hostKey !== player.key || room.state !== 'lobby') return;
      if (!player.userId) return socket.emit('error', { message: 'Sign in to use your saved lists.' });
      const list = typeof listId === 'string' && Object.prototype.hasOwnProperty.call(store.db.lists, listId)
        ? store.db.lists[listId] : null;
      if (!list || list.ownerId !== player.userId) return socket.emit('error', { message: 'List not found.' });
      let lname = list.name;
      // Avoid clobbering a built-in list (or a reserved object key).
      if (words.builtinLists[lname]) lname = `${lname} (mine)`;
      if (RESERVED_NAME.test(lname)) lname = 'My list';
      if (!Object.prototype.hasOwnProperty.call(room.customLists, lname)
          && Object.keys(room.customLists).length >= MAX_CUSTOM_LISTS_PER_ROOM) {
        return socket.emit('error', { message: 'This room has too many custom lists.' });
      }
      room.customLists[lname] = [...list.words];
      if (!room.selectedLists.includes(lname)) room.selectedLists.push(lname);
      broadcastState(room);
      socket.emit('customListAdded', { name: lname, count: list.words.length });
    });

    socket.on('exportCustomList', ({ name } = {}) => {
      const ctx = getContext(socket);
      if (!ctx) return;
      const { room, player } = ctx;
      if (room.hostKey !== player.key) return;
      const list = typeof name === 'string' && Object.prototype.hasOwnProperty.call(room.customLists, name)
        ? room.customLists[name] : null;
      if (!list) return;
      socket.emit('customListExport', { name, text: list.join('\n') });
    });

    socket.on('setGameOptions', ({ options } = {}) => {
      const ctx = getContext(socket);
      if (!ctx || !options || typeof options !== 'object') return;
      const { room, player } = ctx;
      if (room.managed || room.hostKey !== player.key) return;
      if (options.showWordSource !== undefined) room.options.showWordSource = !!options.showWordSource;
      if (room.state === 'lobby') {
        const o = room.options;
        if (options.wordChoices !== undefined) o.wordChoices = clampInt(options.wordChoices, 2, 6, 3);
        if (options.roundTime !== undefined) o.roundTime = clampInt(options.roundTime, 15, 240, 80);
        if (options.hintCount !== undefined) o.hintCount = clampInt(options.hintCount, 0, 5, 2);
        if (options.rounds !== undefined) o.rounds = clampInt(options.rounds, 1, 10, 3);
        if (options.maxPlayers !== undefined) o.maxPlayers = clampInt(options.maxPlayers, 2, MAX_PLAYERS_LIMIT, MAX_PLAYERS_DEFAULT);
        if (options.combinations !== undefined) o.combinations = !!options.combinations;
        if (options.hidden !== undefined) o.hidden = !!options.hidden;
        if (options.autocorrectStrength !== undefined) o.autocorrectStrength = clampInt(options.autocorrectStrength, 0, 3, 1);
        if (options.textTool !== undefined) o.textTool = !!options.textTool;
        if (options.avoidRepeats !== undefined) {
          const v = !!options.avoidRepeats;
          if (v !== o.avoidRepeats) { room.wordUsedCount = {}; room.wordOffered = new Set(); }
          o.avoidRepeats = v;
        }
        if (options.lockComboParts !== undefined) o.lockComboParts = !!options.lockComboParts;
        if (options.coopMode !== undefined) o.coopMode = !!options.coopMode;
        if (options.spamProtection !== undefined) o.spamProtection = !!options.spamProtection;
        if (options.canvasBackground !== undefined && CANVAS_BACKGROUNDS.includes(options.canvasBackground)) {
          o.canvasBackground = options.canvasBackground;
        }
        if (options.sceneBackgrounds !== undefined) o.sceneBackgrounds = !!options.sceneBackgrounds;
      }
      broadcastState(room);
    });

    socket.on('chooseWord', ({ word } = {}) => {
      const ctx = getContext(socket);
      if (!ctx || typeof word !== 'string') return;
      const { room, player } = ctx;
      if (room.state !== 'choosing') return;
      const drawer = currentDrawer(room);
      const partner = currentPartner(room);

      if (room.options.combinations) {
        if (!room.combinationPart1) {
          if (!drawer || drawer.key !== player.key) return;
          if (!room.wordChoices.includes(word)) return;
          room.combinationPart1 = word;
          const p2 = words.getWordChoicesWithSource(room, room.options.wordChoices, new Set([word]));
          room.wordChoicesPart2 = p2.map(w => w.word);
          p2.forEach(w => room.wordOffered.add(w.word.toLowerCase()));
          p2.forEach(({ word: w, listName }) => { room.wordChoicesSources[w] = listName; });
          const recipient = (room.options.coopMode && partner) ? partner : drawer;
          const coopPart2 = !!(room.options.coopMode && partner);
          if (recipient.socketId) {
            io.to(recipient.socketId).emit('wordChoices', {
              words: room.wordChoicesPart2,
              part: 2,
              firstWord: word,
              coopPart2,
              firstPickerName: coopPart2 ? drawer.name : undefined,
            });
          }
        } else {
          const part2Picker = (room.options.coopMode && partner) ? partner : drawer;
          if (!part2Picker || part2Picker.key !== player.key) return;
          if (!room.wordChoicesPart2.includes(word)) return;
          wordChosen(room, `${room.combinationPart1}+${word}`);
        }
      } else {
        const picker = wordPickerFor(room);
        if (!picker || picker.key !== player.key) return;
        if (!room.wordChoices.includes(word)) return;
        wordChosen(room, word);
      }
    });

    socket.on('draw', (data) => {
      const ctx = getContext(socket);
      if (!ctx) return;
      const { room, player } = ctx;
      if (room.state !== 'drawing' || !isArtistKey(room, player.key)) return;
      if (room.drawHistory.length > 40000) return; // sanity cap
      const ev = validateDrawEvent(room, data);
      if (!ev) return;
      if (ev.rejected) return socket.emit('error', { message: "Nice try — you can't write the word." });
      room.currentStroke.push(ev);
      room.drawHistory.push(ev);
      socket.to(room.code).emit('draw', ev);
    });

    // Batched freehand segments (the client flushes every ~30ms).
    socket.on('drawBatch', (events) => {
      const ctx = getContext(socket);
      if (!ctx || !Array.isArray(events) || events.length === 0 || events.length > 300) return;
      const { room, player } = ctx;
      if (room.state !== 'drawing' || !isArtistKey(room, player.key)) return;
      if (room.drawHistory.length > 40000) return;
      const clean = [];
      for (const e of events) {
        const ev = validateDrawEvent(room, e);
        if (ev && !ev.rejected && ev.type !== 'text') clean.push(ev);
      }
      if (!clean.length) return;
      room.currentStroke.push(...clean);
      room.drawHistory.push(...clean);
      socket.to(room.code).emit('drawBatch', clean);
    });

    socket.on('strokeEnd', () => {
      const ctx = getContext(socket);
      if (!ctx) return;
      const { room, player } = ctx;
      if (room.state !== 'drawing' || !isArtistKey(room, player.key)) return;
      if (room.currentStroke.length > 0) {
        room.strokes.push({ events: room.currentStroke, drawerKey: player.key });
        room.currentStroke = [];
      }
    });

    socket.on('undo', () => {
      const ctx = getContext(socket);
      if (!ctx) return;
      const { room, player } = ctx;
      if (room.state !== 'drawing' || !isArtistKey(room, player.key)) return;
      room.currentStroke = [];
      // Remove only this artist's most recent stroke.
      let lastIdx = -1;
      for (let i = room.strokes.length - 1; i >= 0; i--) {
        if (room.strokes[i] && !room.strokes[i].clear && room.strokes[i].drawerKey === player.key) {
          lastIdx = i;
          break;
        }
      }
      if (lastIdx !== -1) room.strokes.splice(lastIdx, 1);
      room.drawHistory = buildDrawHistory(room.strokes);
      io.to(room.code).emit('redrawAll', { history: room.drawHistory });
    });

    // The artist picks a backdrop to draw over. It replaces whatever is on
    // the canvas, so the strokes reset with it.
    socket.on('setScene', ({ id } = {}) => {
      const ctx = getContext(socket);
      if (!ctx) return;
      const { room, player } = ctx;
      if (room.state !== 'drawing' || !isArtistKey(room, player.key)) return;
      if (!room.options.sceneBackgrounds) return;
      if (id !== null && !scenes.has(id)) return;
      room.scene = id === null ? null : id;
      room.strokes = [];
      room.currentStroke = [];
      room.drawHistory = [];
      io.to(room.code).emit('sceneSet', { id: room.scene });
    });

    socket.on('clearCanvas', () => {
      const ctx = getContext(socket);
      if (!ctx) return;
      const { room, player } = ctx;
      if (room.state !== 'drawing' || !isArtistKey(room, player.key)) return;
      room.strokes.push({ clear: true });
      room.currentStroke = [];
      room.drawHistory = [];
      socket.to(room.code).emit('clearCanvas');
    });

    socket.on('guess', ({ text } = {}) => {
      const ctx = getContext(socket);
      if (!ctx || typeof text !== 'string') return;
      const { room, player } = ctx;
      if (room.state !== 'drawing' || !room.currentWord) return;
      if (isArtistKey(room, player.key)) return;
      if (room.guessedKeys.has(player.key)) return;
      const raw = text.trim().slice(0, 100);
      if (!raw) return;

      const spam = checkSpam(room, player, raw);
      if (!spam.ok) {
        if (spam.justMuted) socket.emit('chat', { system: true, text: '🤫 Easy there — muted for 10 seconds.' });
        return;
      }

      const guess = raw.toLowerCase();
      const answer = room.currentWord.toLowerCase();
      const strength = room.options.autocorrectStrength ?? 1;
      let isCorrect = false;
      let wasAutocorrected = false;
      let dist = Infinity;

      const fuzzyEq = (g, a) => similarity.matches(g, a, strength).ok;

      if (room.options.combinations && answer.includes('+')) {
        const aParts = answer.split('+').map(p => p.trim());
        const lockedPart = room.lockedParts[player.key];

        if (lockedPart) {
          const remaining = aParts.find(p => p !== lockedPart);
          const gParts = guess.split('+').map(p => p.trim());
          // Accept the full "word1+word2" answer too — otherwise a locked
          // player typing the complete answer would be rejected AND leak it
          // to the whole room as a chat guess.
          const fullMatch = gParts.length === 2 && (
            (fuzzyEq(gParts[0], aParts[0]) && fuzzyEq(gParts[1], aParts[1])) ||
            (fuzzyEq(gParts[0], aParts[1]) && fuzzyEq(gParts[1], aParts[0]))
          );
          if (fullMatch) {
            isCorrect = true;
          } else if (fuzzyEq(guess, lockedPart)) {
            // Re-typing the part you already have never wins the round —
            // similar-looking combo parts would otherwise fuzzy-match.
            isCorrect = false;
          } else {
            isCorrect = remaining !== undefined && fuzzyEq(guess, remaining);
          }
          wasAutocorrected = isCorrect && guess !== remaining && guess !== answer;
        } else {
          const matchedPart = aParts.find(p => fuzzyEq(guess, p));
          if (matchedPart && !guess.includes('+')) {
            if (room.options.lockComboParts !== false) {
              room.lockedParts[player.key] = matchedPart;
              const remaining = aParts.find(p => p !== matchedPart) || '';
              socket.emit('partLocked', {
                lockedPart: matchedPart,
                remainingMask: maskWord(remaining),
                lockedIsFirst: aParts[0] === matchedPart,
              });
              io.to(room.code).emit('chat', {
                system: true,
                text: `🔒 ${player.name} got the ${aParts[0] === matchedPart ? 'first' : 'second'} word!`,
              });
            } else {
              socket.emit('closeGuess', {});
              socket.to(room.code).emit('chat', { playerId: player.key, playerName: player.name, text: raw, isGuess: true });
              socket.emit('chat', { playerId: player.key, playerName: player.name, text: raw, isClose: true, isGuess: true });
            }
            return;
          }
          const gParts = guess.split('+').map(p => p.trim());
          isCorrect = gParts.length === 2 && (
            (fuzzyEq(gParts[0], aParts[0]) && fuzzyEq(gParts[1], aParts[1])) ||
            (fuzzyEq(gParts[0], aParts[1]) && fuzzyEq(gParts[1], aParts[0]))
          );
          wasAutocorrected = isCorrect && guess !== answer;
        }
      } else {
        const m = similarity.matches(guess, answer, strength);
        dist = m.dist;
        isCorrect = m.ok;
        wasAutocorrected = isCorrect && !m.exact;
      }

      if (isCorrect) {
        room.guessedKeys.add(player.key);
        const points = awardCorrectGuess(room, player);

        // The corrected word is only revealed to sockets that may know the
        // answer (artists + players who already guessed) — never broadcast
        // it room-wide where a modified client could read it early.
        const payload = {
          playerId: player.key,
          playerName: player.name,
          points,
          autocorrected: wasAutocorrected,
          correctedWord: null,
          scores: room.players.map(p => ({ id: p.key, name: p.name, score: room.scores[p.key] || 0 })),
        };
        for (const p of room.players) {
          if (!p.connected || !p.socketId) continue;
          const privileged = wasAutocorrected && (isArtistKey(room, p.key) || room.guessedKeys.has(p.key));
          io.to(p.socketId).emit('correctGuess', privileged ? { ...payload, correctedWord: room.currentWord } : payload);
        }

        const drawer = currentDrawer(room);
        const partner = currentPartner(room);
        const guessers = connectedPlayers(room).filter(p => p.key !== drawer?.key && p.key !== partner?.key);
        if (guessers.every(p => room.guessedKeys.has(p.key))) {
          endDrawingRound(room);
        } else {
          // Time drop: cap what's left by how many guessers still need it.
          // A 4-guesser 90s round → ≤49s after the first guess, then ≤35s,
          // then ≤22s; the last guesser always keeps at least 12s.
          const remaining = guessers.filter(p => !room.guessedKeys.has(p.key)).length;
          const cap = Math.max(12, Math.ceil(room.options.roundTime * (remaining / Math.max(1, guessers.length)) * 0.6 + 8));
          room.timeLeft = Math.max(0, Math.min(room.timeLeft, cap));
          const remainingHints = room.hintTimes.length - room.hintsGiven;
          if (remainingHints > 0) {
            const newTimes = [];
            for (let j = 0; j < remainingHints; j++) {
              newTimes.push(Math.floor(room.timeLeft * (remainingHints - j) / (remainingHints + 1)));
            }
            room.hintTimes = [...room.hintTimes.slice(0, room.hintsGiven), ...newTimes];
          }
          io.to(room.code).emit('timerTick', { timeLeft: room.timeLeft });
        }
      } else {
        const isClose = answer.includes('+')
          ? answer.split('+').some(p => similarity.isClose(guess, p))
          : similarity.isClose(guess, answer);
        socket.to(room.code).emit('chat', { playerId: player.key, playerName: player.name, text: raw, isGuess: true });
        socket.emit('chat', { playerId: player.key, playerName: player.name, text: raw, isClose, isGuess: true });
        if (isClose && room.options.autocorrectStrength < 2) {
          socket.emit('closeGuess', {});
        }
      }
    });

    socket.on('chat', ({ text } = {}) => {
      const ctx = getContext(socket);
      if (!ctx || typeof text !== 'string') return;
      const { room, player } = ctx;
      const clean = text.trim().slice(0, 120);
      if (!clean) return;

      const spam = checkSpam(room, player, clean);
      if (!spam.ok) {
        if (spam.justMuted) socket.emit('chat', { system: true, text: '🤫 Easy there — muted for 10 seconds.' });
        return;
      }

      // During a drawing round, artists and players who already guessed can
      // only talk to each other (so the word can't be leaked).
      if (room.state === 'drawing') {
        const privileged = isArtistKey(room, player.key) || room.guessedKeys.has(player.key);
        if (privileged) {
          const audience = room.players.filter(p =>
            p.connected && (isArtistKey(room, p.key) || room.guessedKeys.has(p.key)));
          for (const p of audience) {
            if (p.socketId) io.to(p.socketId).emit('chat', {
              playerId: player.key, playerName: player.name, text: clean, whisper: true,
            });
          }
          return;
        }
      }
      io.to(room.code).emit('chat', { playerId: player.key, playerName: player.name, text: clean });
    });

    // Guessers can vote to skip a hopeless round.
    socket.on('voteSkip', () => {
      const ctx = getContext(socket);
      if (!ctx) return;
      const { room, player } = ctx;
      if (room.state !== 'drawing') return;
      // Private rooms: only the host may skip, and they can do it whoever is
      // drawing — including themselves. Public matches have no host, so those
      // keep the majority vote.
      if (!room.managed) {
        if (room.hostKey !== player.key) {
          return socket.emit('error', { message: 'Only the host can skip a round.' });
        }
        io.to(room.code).emit('chat', { system: true, text: '⏭️ The host skipped this round.' });
        endDrawingRound(room);
        return;
      }
      if (isArtistKey(room, player.key)) return;
      if (room.skipVotes.has(player.key)) return;
      room.skipVotes.add(player.key);
      const eligible = connectedPlayers(room).filter(p => !isArtistKey(room, p.key));
      const votes = [...room.skipVotes].filter(k => eligible.some(p => p.key === k)).length;
      const needed = Math.floor(eligible.length / 2) + 1;
      io.to(room.code).emit('skipVoteUpdate', { votes, needed, playerName: player.name });
      maybeSkipOnVotes(room);
    });

    // Like the current drawing (during the round or the round-end screen).
    socket.on('likeRound', () => {
      const ctx = getContext(socket);
      if (!ctx) return;
      const { room, player } = ctx;
      if (room.state !== 'drawing' && room.state !== 'roundEnd') return;
      // Use the round snapshot — drawerIndex already points at the NEXT
      // drawer during the round-end screen.
      const artistKeys = room.roundArtistKeys || [];
      if (artistKeys.includes(player.key)) return;
      if (room.roundLikes.has(player.key)) return;
      room.roundLikes.add(player.key);
      for (const key of artistKeys) {
        const artist = playerByKey(room, key);
        const stats = artist && userStats(artist.userId);
        if (stats) { stats.likes++; store.scheduleSave(); }
      }
      io.to(room.code).emit('likeUpdate', { count: room.roundLikes.size, playerName: player.name });
    });

    // ── Friends ──
    // Invite a friend (must be online) to the room you're in.
    socket.on('inviteFriend', ({ userId } = {}) => {
      const ctx = getContext(socket);
      if (!ctx || !identity.userId) return;
      const { room, player } = ctx;
      const me = store.db.users[identity.userId];
      const target = friends.userById(userId);
      if (!me || !target || !friends.areFriends(me, target)) return socket.emit('error', { message: 'You can only invite friends.' });
      if (!isOnline(target.id)) return socket.emit('inviteResult', { ok: false, message: `${target.username} isn't online right now.` });
      notifyUser(target.id, 'gameInvite', {
        from: { id: me.id, username: me.username, avatar: player.avatar },
        code: room.code,
        roomName: room.name || `${player.name}'s room`,
        public: room.public,
      });
      socket.emit('inviteResult', { ok: true, message: `Invite sent to ${target.username}!` });
    });

    // Add someone you're playing with as a friend (both need accounts).
    socket.on('friendRequest', ({ playerId } = {}) => {
      const ctx = getContext(socket);
      if (!ctx) return;
      if (!identity.userId) return socket.emit('error', { message: 'Sign in to add friends.' });
      const { room } = ctx;
      const target = playerByKey(room, playerId);
      if (!target) return;
      if (!target.userId) return socket.emit('error', { message: `${target.name} is playing as a guest — they'd need to sign in first.` });
      const me = store.db.users[identity.userId];
      const other = friends.userById(target.userId);
      if (!me || !other) return;
      const r = friends.sendRequest(me, other);
      if (!r.ok) return socket.emit('error', { message: r.message });
      notifyUser(other.id, 'friendRequestReceived', { from: friends.brief(me), accepted: !!r.accepted });
      socket.emit('friendRequestSent', { message: r.message, accepted: !!r.accepted, userId: other.id });
    });

    socket.on('requestState', () => {
      const ctx = getContext(socket);
      if (!ctx) return;
      const { room } = ctx;
      socket.emit('stateUpdate', getRoomPublicState(room));
      if (room.drawHistory.length > 0) socket.emit('drawHistory', { history: room.drawHistory });
    });

    socket.on('updateProfile', ({ name, avatar } = {}) => {
      const ctx = getContext(socket);
      if (name !== undefined) identity.name = sanitizeName(name, identity.name);
      if (avatar !== undefined) identity.avatar = sanitizeAvatar(avatar);
      if (ctx) {
        const { room, player } = ctx;
        if (name !== undefined) player.name = identity.name;
        if (avatar !== undefined) player.avatar = identity.avatar;
        broadcastState(room);
      }
      // Persist avatar on the account.
      if (identity.userId && avatar !== undefined) {
        const user = store.db.users[identity.userId];
        if (user) { user.avatar = identity.avatar; store.scheduleSave(); }
      }
    });

    socket.on('kickPlayer', ({ playerId } = {}) => {
      const ctx = getContext(socket);
      if (!ctx) return;
      const { room, player } = ctx;
      if (room.managed || room.hostKey !== player.key) return;
      if (playerId === player.key) return;
      const target = playerByKey(room, playerId);
      if (!target) return;
      room.kickedKeys.add(target.key);
      const targetSocket = io.sockets.sockets.get(target.socketId);
      if (targetSocket) {
        targetSocket.emit('kicked');
        targetSocket.leave(room.code);
      }
      removePlayer(room, target.key, { reason: 'kicked' });
    });

    socket.on('leaveRoom', () => {
      const ctx = getContext(socket);
      if (!ctx) return;
      const { room, player } = ctx;
      socket.leave(room.code);
      socketPlayers.delete(socket.id);
      removePlayer(room, player.key);
    });

    socket.on('skipToLobby', () => {
      const ctx = getContext(socket);
      if (!ctx) return;
      const { room, player } = ctx;
      if (room.managed || room.hostKey !== player.key || room.state !== 'gameEnd') return;
      backToLobby(room);
    });

    socket.on('disconnect', () => {
      if (identity.userId && online.has(identity.userId)) {
        online.get(identity.userId).delete(socket.id);
        if (online.get(identity.userId).size === 0) online.delete(identity.userId);
      }
      const ctx = getContext(socket);
      socketPlayers.delete(socket.id);
      if (!ctx) return;
      const { room, player } = ctx;
      player.connected = false;
      player.disconnectedAt = Date.now();
      player.socketId = null;
      io.to(room.code).emit('chat', { system: true, text: `👋 ${player.name} disconnected...` });
      broadcastState(room);

      // In the lobby there is nothing to hold a seat for — shorter cleanup
      // happens via roomTick; games keep the seat for the grace period.
    });
  });
}

// ── Utilities ────────────────────────────────────────────────

function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

function parseWordText(text) {
  const seen = new Set();
  const out = [];
  for (const piece of String(text).split(/[\n,]+/)) {
    const w = piece.replace(/\s+/g, ' ').trim().slice(0, 64);
    if (!w) continue;
    const lower = w.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(w);
    if (out.length >= 50000) break; // sanity cap, effectively unlimited
  }
  return out;
}

function buildDrawHistory(strokes) {
  let startIdx = -1;
  for (let i = strokes.length - 1; i >= 0; i--) {
    if (strokes[i] && strokes[i].clear) { startIdx = i; break; }
  }
  const events = [];
  for (const s of strokes.slice(startIdx + 1)) {
    if (s && Array.isArray(s.events)) events.push(...s.events);
  }
  return events;
}

module.exports = { init, listPublicRooms, rooms, isOnline, notifyUser };
