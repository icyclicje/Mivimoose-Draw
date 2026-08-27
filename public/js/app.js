// ─────────────────────────────────────────────────────────────
// app.js — Mivimoose Draw client: screens, game loop, canvas,
// chat, sounds, fullscreen focus mode.
// ─────────────────────────────────────────────────────────────
(function () {
  'use strict';
  const API = window.MiviAPI;
  const Audio = window.MiviAudio;
  const $ = (id) => document.getElementById(id);

  // ── State ──
  let socket = null;
  let socketToken = null;          // auth token the socket was built with
  let myId = null;                 // stable player key from server
  let gameState = null;            // last room state
  let roomCode = null;
  let isArtist = false;
  let hasGuessed = false;
  let myLockedPart = null;
  let phaseTotal = 80;             // for the timer ring
  let currentTimeLeft = 0;
  let guessedSet = new Set();
  let pendingJoin = null;          // code from invite link
  let roomsPoll = null;
  let voteSkipUsed = false;
  let likeUsed = false;
  let wasArtistThisRound = false;  // survives setArtistMode(false) at round end
  let curWordSource = null, curWordSource2 = null;

  // Round-end snapshot
  let snap = null; // {dataUrl, word, artist, guessedCount, playerCount, likes, savedToGallery}

  // Drawing state
  const CANVAS_W = 1000, CANVAS_H = 750;
  let ctx, pctx;
  let canvasBg = '#ffffff';
  let currentTool = 'pen';
  let currentColor = '#111111';
  let brushSize = 6;
  let drawing = false;
  let lastX = 0, lastY = 0;
  let shape = null; // {x1,y1}
  let strokeEvents = [];

  const SIZES = [3, 6, 10, 16, 26, 38];
  // Two rows: a bold tone on top, its lighter sibling underneath.
  const PALETTE = [
    '#111111', '#606060', '#c62828', '#ef6c00', '#f9a825', '#2e7d32', '#00897b', '#0277bd', '#1a237e', '#6a1b9a', '#ad1457', '#5d4037', '#b07b4f', '#ffffff',
    '#424242', '#bdbdbd', '#ff5252', '#ffab40', '#fff176', '#69f0ae', '#64ffda', '#40c4ff', '#7986cb', '#b388ff', '#ff80ab', '#8d6e63', '#f5cba7', '#fbe9d7',
  ];
  const EMOJIS = ['🎨','🦌','🐱','🐶','🦊','🐻','🐼','🐸','🐙','🦄','🐝','🦖','🐢','🐧','🦉','🐳','🍕','🌵','👻','🤖','👽','🧙','🥷','🦩'];
  const COLORS = ['#6C5CE7','#FD79A8','#00CEC9','#FDCB6E','#00B894','#E17055','#0984E3','#B33771','#6D214F','#3B3B98'];
  const ADJ = ['Sneaky','Sleepy','Speedy','Wobbly','Mighty','Dizzy','Jolly','Fuzzy','Zesty','Brave'];
  const NOUN = ['Moose','Fox','Panda','Otter','Llama','Crab','Owl','Yeti','Duck','Newt'];

  // ── Utilities ──
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._h);
    t._h = setTimeout(() => t.classList.remove('show'), 2600);
  }

  function el(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function sfx(name) { try { Audio.sfx(name); } catch (e) {} }

  function myName() { return ($('home-name').value || '').trim() || API.lsGet('mivi_name') || ''; }
  function ensureName() {
    let n = myName();
    if (!n) {
      n = ADJ[Math.floor(Math.random() * ADJ.length)] + NOUN[Math.floor(Math.random() * NOUN.length)];
      $('home-name').value = n;
    }
    API.lsSet('mivi_name', n);
    return n;
  }
  function myAvatar() {
    try { return JSON.parse(API.lsGet('mivi_avatar')) || { emoji: '🎨', color: '#6C5CE7' }; }
    catch (e) { return { emoji: '🎨', color: '#6C5CE7' }; }
  }
  function setAvatar(av) {
    API.lsSet('mivi_avatar', JSON.stringify(av));
    renderAvatarBubble();
    if (socket && socket.connected) socket.emit('updateProfile', { avatar: av });
    if (window.MiviAccount.isLoggedIn()) window.MiviAccount.updateAvatar(av);
  }

  function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    $(id).classList.add('active');
    const onHome = id === 'screen-home';
    if (onHome) startRoomsPoll(); else stopRoomsPoll();
    if (id !== 'screen-game') exitFocusMode();
  }

  // ── Socket ──
  function connectSocket() {
    if (socket) { socket.removeAllListeners(); socket.disconnect(); }
    socketToken = API.token();
    socket = io({
      auth: {
        token: API.token(),
        guestKey: API.guestKey(),
        name: myName() || undefined,
        avatar: myAvatar(),
      },
    });
    bindSocket();
  }

  function bindSocket() {
    socket.on('connect', () => {});
    socket.on('welcome', (data) => {
      myId = data.key;
      // Try to resume a room after a refresh/server hiccup, or follow an invite link.
      if (pendingJoin) {
        const code = pendingJoin; pendingJoin = null;
        socket.emit('joinRoom', { code, name: ensureName(), avatar: myAvatar() });
      } else {
        const target = roomCode || API.lsGet('mivi_room');
        if (target) socket.emit('joinRoom', { code: target, name: myName() || 'Player', avatar: myAvatar(), quiet: true });
      }
    });

    socket.on('joinFailed', ({ code }) => {
      // A quiet rejoin failed — the room is gone (or full/kicked).
      if (API.lsGet('mivi_room') === code) API.lsDel('mivi_room');
      if (roomCode === code) {
        toast("ℹ️ That room's gone now.");
        leaveToHome(false);
      }
    });
    socket.on('disconnect', () => {
      if (roomCode) toast('⚠️ Lost the connection — trying to get back in…');
    });

    socket.on('error', ({ message }) => {
      toast('❌ ' + message);
      if ($('screen-home').classList.contains('active')) $('home-error').textContent = message;
      sfx('error');
    });

    socket.on('roomCreated', ({ code, state }) => enterRoom(code, state));
    socket.on('roomJoined', ({ code, state, resumed }) => {
      enterRoom(code, state, resumed);
      if (resumed) toast('🔌 Welcome back — we kept your seat warm.');
    });

    socket.on('playerJoined', ({ player, state }) => {
      gameState = state;
      sfx('join');
      addAnyChat({ system: true, text: `👋 ${player.name} joined!` });
      refreshRoomUI();
    });

    socket.on('playerLeft', ({ playerName, kicked, state }) => {
      gameState = state;
      sfx('leave');
      addAnyChat({ system: true, text: kicked ? `🚫 ${playerName} was kicked.` : `👋 ${playerName} left.` });
      refreshRoomUI();
    });

    socket.on('stateUpdate', (state) => {
      gameState = state;
      refreshRoomUI();
    });

    socket.on('autoStart', ({ seconds }) => {
      const banner = $('autostart-banner');
      if (seconds === null || seconds === undefined) {
        banner.style.display = 'none';
      } else {
        banner.style.display = 'block';
        banner.textContent = seconds > 0 ? `🚀 Game starts in ${seconds}s…` : '🚀 Starting!';
        if (seconds <= 5 && seconds > 0) sfx('countdown');
      }
    });

    socket.on('roundStart', (state) => {
      gameState = state;
      roomToGameScreen();
      guessedSet = new Set();
      hasGuessed = false;
      myLockedPart = null;
      voteSkipUsed = false;
      likeUsed = false;
      snap = null;
      curWordSource = null;
      curWordSource2 = null;
      hideOverlay('overlay-roundend');
      phaseTotal = 20;
      setTimer(state.timeLeft ?? 20);
      $('overlay-choice').style.display = 'none';
      clearCanvasLocal();
      setArtistMode(false);
      $('game-chat').textContent = '';
      updateLikeSkipUI();

      const amPicker = state.wordPickerId === myId;
      const amArtist = state.drawerId === myId || state.coopPartnerId === myId;
      if (!amArtist && !amPicker) {
        $('overlay-choosing').style.display = 'flex';
        $('overlay-wait').style.display = 'none';
        const nm = state.coopPartnerName
          ? `${state.drawerName} & ${state.coopPartnerName}`
          : state.drawerName;
        $('choosing-name').textContent = nm;
      }
      renderWordTiles(null, { placeholder: true });
      updatePlayers();
      updateRoundPill();
      addAnyChat({
        system: true,
        text: state.coopPartnerName
          ? `🎨 Round ${state.round} — ${state.drawerName} & ${state.coopPartnerName} are choosing!`
          : `🎨 Round ${state.round} — ${state.drawerName} is choosing a word!`,
      });
      if (amArtist) sfx('yourTurn'); else sfx('roundStart');
    });

    socket.on('wordChoices', (payload) => {
      roomToGameScreen();
      $('overlay-choosing').style.display = 'none';
      $('overlay-wait').style.display = 'none';
      renderWordChoices(payload);
    });

    socket.on('drawingStart', (state) => {
      gameState = state;
      roomToGameScreen();
      $('overlay-choice').style.display = 'none';
      $('overlay-choosing').style.display = 'none';
      $('overlay-wait').style.display = 'none';
      phaseTotal = state.options.roundTime;
      setTimer(state.timeLeft);
      const amArtist = state.drawerId === myId || state.coopPartnerId === myId;
      setArtistMode(amArtist);
      updatePlayers();
      updateLikeSkipUI();

      curWordSource = state.wordSource || null;
      curWordSource2 = state.wordSource2 || null;
      if (!amArtist) {
        if (state.hiddenMode) renderWordTiles(null, { hidden: true });
        else renderWordTiles(state.maskedWord);
        setWordMeta(state.maskedWord, curWordSource, curWordSource2);
        const label = state.coopPartnerName ? `${state.drawerName} & ${state.coopPartnerName}` : state.drawerName;
        addAnyChat({
          system: true,
          text: state.options.combinations
            ? `🖌️ ${label} — guess as word1+word2!`
            : `🖌️ ${label} is drawing!`,
        });
        sfx('roundStart');
      }
    });

    socket.on('yourWord', ({ word, sourceList, sourceList2 }) => {
      curWordSource = sourceList || null;
      curWordSource2 = sourceList2 || null;
      renderWordTiles(word, { revealed: true });
      setWordMeta(word, curWordSource, curWordSource2);
    });

    socket.on('hint', ({ hint }) => {
      if (gameState?.options?.hidden) return;
      if (isArtist) return;
      if (myLockedPart) return; // locked view is better than the plain hint
      renderWordTiles(hint);
      setWordMeta(hint, curWordSource, curWordSource2); // keep the 📚 source line
      sfx('hint');
    });

    socket.on('timerTick', ({ timeLeft }) => {
      setTimer(timeLeft);
      if (gameState && (gameState.state === 'drawing' || $('overlay-choice').style.display === 'flex')) {
        if (timeLeft <= 10 && timeLeft > 0) {
          sfx('tick');
          try { Audio.duck(1.2); } catch (e) {}
        }
      }
    });

    socket.on('draw', (data) => applyDraw(data));
    socket.on('drawBatch', (events) => { if (Array.isArray(events)) events.forEach(applyDraw); });
    socket.on('clearCanvas', () => clearCanvasLocal());
    socket.on('drawHistory', ({ history }) => { history.forEach(d => applyDraw(d)); });
    socket.on('redrawAll', ({ history }) => {
      clearCanvasLocal();
      history.forEach(d => applyDraw(d));
    });

    socket.on('chat', (msg) => addAnyChat({
      playerId: msg.playerId, playerName: msg.playerName, text: msg.text,
      close: msg.isClose, system: msg.system, whisper: msg.whisper,
    }));

    socket.on('closeGuess', () => {
      toast('🔥 So close!');
      sfx('close');
    });

    socket.on('correctGuess', ({ playerId, playerName, points, autocorrected, correctedWord, scores }) => {
      sfx('correct');
      const wasMe = playerId === myId;
      const alreadyGuessed = guessedSet.has(myId);
      guessedSet.add(playerId);
      if (wasMe) {
        hasGuessed = true;
        confetti(60);
        toast(autocorrected ? `🎉 Close enough! +${points}` : `🎉 Correct! +${points}`);
        $('game-chat-input').placeholder = 'Chat with others who guessed…';
      }
      const canSeeWord = autocorrected && correctedWord && (wasMe || isArtist || alreadyGuessed);
      addAnyChat({
        playerId, playerName, correct: true,
        text: `guessed it! ${autocorrected ? `(autocorrected${canSeeWord ? ` → "${correctedWord}"` : ''}) ` : ''}(+${points})`,
      });
      if (gameState) {
        gameState.players = gameState.players.map(p => {
          const u = scores.find(s => s.id === p.id);
          return u ? { ...p, score: u.score, guessed: p.id === playerId ? true : p.guessed } : p;
        });
        updatePlayers({ bumpId: playerId, bumpPts: points });
      }
    });

    socket.on('partLocked', ({ lockedPart, remainingMask, lockedIsFirst }) => {
      sfx('lock');
      myLockedPart = { lockedPart, remainingMask, lockedIsFirst };
      renderLockedWord();
      toast(`🔒 "${lockedPart}" locked in — get the other word!`);
      $('game-chat-input').placeholder = `Got "${lockedPart}" — type the other word…`;
    });

    socket.on('skipVoteUpdate', ({ votes, needed, playerName }) => {
      $('skip-count').textContent = ` ${votes}/${needed}`;
      addAnyChat({ system: true, text: `⏭️ ${playerName} voted to skip (${votes}/${needed})` });
    });

    socket.on('likeUpdate', ({ count, playerName }) => {
      $('like-count').textContent = ' ' + count;
      $('re-like-count').textContent = count;
      if (snap) snap.likes = count;
      sfx('like');
    });

    socket.on('roundEnd', (payload) => {
      if (gameState) gameState.state = 'roundEnd'; // so chat isn't routed as a dead guess
      wasArtistThisRound = isArtist;
      sfx('roundEnd');
      showRoundEnd(payload);
      setArtistMode(false);
      hasGuessed = false;
      $('game-chat-input').placeholder = 'Type your guess…';
      renderWordTiles(payload.word, { revealed: true });
    });

    socket.on('gameEnd', ({ finalScores }) => {
      if (gameState) gameState.state = 'gameEnd';
      hideOverlay('overlay-roundend');
      sfx('gameOver');
      confetti(160);
      showGameEnd(finalScores);
    });

    socket.on('backToLobby', (state) => {
      gameState = state;
      hideOverlay('overlay-roundend');
      hideOverlay('overlay-gameend');
      hasGuessed = false;
      guessedSet = new Set();
      enterRoom(roomCode, state);
    });

    socket.on('kicked', () => {
      toast('🚫 The host kicked you out.');
      leaveToHome(false);
    });

    // ── Friends & invites ──
    socket.on('gameInvite', (inv) => {
      sfx('join');
      showInviteToast(inv);
    });
    socket.on('inviteResult', ({ ok, message }) => toast((ok ? '📨 ' : 'ℹ️ ') + message));
    socket.on('friendRequestSent', ({ message }) => { toast('📨 ' + message); window.MiviAccount.refreshFriends(); });
    socket.on('friendRequestReceived', ({ from, accepted }) => {
      sfx('pop');
      toast(accepted ? `🤝 You and ${from.username} are friends now` : `👋 ${from.username} wants to be friends — check the Friends tab`);
      window.MiviAccount.refreshFriends();
    });
    socket.on('friendAccepted', ({ by }) => {
      sfx('pop');
      toast(`🤝 ${by.username} accepted — you're friends now`);
      window.MiviAccount.refreshFriends();
    });

    socket.on('customListAdded', ({ name, count }) => {
      toast(`✅ Added "${name}" (${count} words)`);
      $('cl-name').value = '';
      $('cl-words').value = '';
    });

    socket.on('customListExport', ({ name, text }) => {
      const blob = new Blob([text], { type: 'text/plain' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name + '.txt';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    });
  }

  // ── Rooms & screens ──
  function enterRoom(code, state, resumed) {
    roomCode = code;
    gameState = state;
    API.lsSet('mivi_room', code);
    $('room-pill').style.display = 'flex';
    $('room-pill-code').textContent = code;
    $('home-error').textContent = '';

    if (state.state === 'lobby') {
      showScreen('screen-lobby');
      updateLobby();
    } else {
      // Mid-game join or resume.
      roomToGameScreen();
      $('overlay-choice').style.display = 'none';
      $('overlay-choosing').style.display = 'none';
      updatePlayers();
      updateRoundPill();
      guessedSet = new Set(state.players.filter(p => p.guessed).map(p => p.id));
      hasGuessed = guessedSet.has(myId);
      if (state.state === 'choosing') {
        phaseTotal = 20; // server CHOOSE_TIME
        setTimer(state.timeLeft);
      }
      if (state.state === 'drawing') {
        phaseTotal = state.options.roundTime || 80;
        setTimer(state.timeLeft);
        $('overlay-wait').style.display = 'none';
        if (state.hiddenMode) renderWordTiles(null, { hidden: true });
        else if (state.wordSpaces) renderWordTiles(state.wordSpaces);
        const amArtist = state.currentDrawerId === myId || state.coopPartnerId === myId;
        setArtistMode(amArtist);
        if (!resumed) addAnyChat({ system: true, text: 'You joined mid-game — good luck!' });
      } else {
        $('overlay-wait').style.display = 'flex';
      }
      updateLikeSkipUI();
    }
  }

  function roomToGameScreen() {
    if (!$('screen-game').classList.contains('active')) showScreen('screen-game');
    requestAnimationFrame(fitCanvas);
  }

  // Size the canvas so the whole thing (plus toolbar) fits the viewport
  // height — wide screens no longer get a canvas that runs off the bottom.
  function fitCanvas() {
    const frame = $('canvas-frame');
    if (!$('screen-game').classList.contains('active') || document.body.classList.contains('focus-mode')) {
      frame.style.removeProperty('--canvas-max');
      return;
    }
    const card = $('canvas-card');
    const toolbar = $('toolbar');
    const toolbarH = toolbar.style.display !== 'none' ? toolbar.offsetHeight + 10 : 0;
    const top = card.getBoundingClientRect().top;
    const avail = window.innerHeight - top - toolbarH - 40;
    const maxW = Math.max(360, Math.floor(avail * 4 / 3));
    frame.style.setProperty('--canvas-max', maxW + 'px');
  }

  function leaveToHome(emitLeave = true) {
    if (emitLeave && socket && roomCode) socket.emit('leaveRoom');
    roomCode = null;
    gameState = null;
    API.lsDel('mivi_room');
    $('room-pill').style.display = 'none';
    hideOverlay('overlay-roundend');
    hideOverlay('overlay-gameend');
    $('overlay-choice').style.display = 'none';
    $('overlay-choosing').style.display = 'none';
    showScreen('screen-home');
    // Apply a sign-in/out that happened while we were seated in a room.
    if (API.token() !== socketToken) connectSocket();
    fetchRooms();
  }

  function refreshRoomUI() {
    if (!gameState) return;
    if (gameState.state === 'lobby' && $('screen-lobby').classList.contains('active')) {
      updateLobby();
    } else if ($('screen-game').classList.contains('active')) {
      guessedSet = new Set(gameState.players.filter(p => p.guessed).map(p => p.id));
      updatePlayers();
      updateRoundPill();
    }
  }

  // ── Home / public rooms ──
  async function fetchRooms() {
    try {
      const data = await API.publicRooms();
      const list = $('rooms-list');
      list.textContent = '';
      if (!data.rooms.length) {
        list.appendChild(el('div', 'rooms-empty', 'No public rooms right now — start one with Play Online!'));
        return;
      }
      for (const r of data.rooms) {
        const row = el('div', 'room-row');
        row.appendChild(el('span', 'rr-name', r.name));
        row.appendChild(el('span', 'rr-state' + (r.state === 'lobby' ? '' : ' playing'), r.state === 'lobby' ? 'waiting' : `round ${r.round}/${r.totalRounds}`));
        row.appendChild(el('span', 'rr-meta', `${r.players}/${r.maxPlayers}`));
        const btn = el('button', 'btn btn-small', 'Join');
        btn.disabled = r.players >= r.maxPlayers;
        if (btn.disabled) btn.style.opacity = '.4';
        btn.onclick = () => {
          const name = ensureName();
          socket.emit('joinRoom', { code: r.code, name, avatar: myAvatar() });
        };
        row.appendChild(btn);
        list.appendChild(row);
      }
    } catch (e) {}
  }

  function startRoomsPoll() {
    stopRoomsPoll();
    fetchRooms();
    roomsPoll = setInterval(fetchRooms, 8000);
  }
  function stopRoomsPoll() { if (roomsPoll) { clearInterval(roomsPoll); roomsPoll = null; } }

  // ── Lobby ──
  function updateLobby() {
    const s = gameState;
    if (!s) return;
    const isHost = s.host === myId && !s.managed;
    $('lobby-code').textContent = s.code;
    $('lobby-count').textContent = `${s.players.length}/${s.options.maxPlayers}`;

    const grid = $('lobby-players');
    grid.textContent = '';
    for (const p of s.players) {
      const chip = el('div', 'p-chip' + (p.id === s.host ? ' host' : '') + (p.connected ? '' : ' dc'));
      const av = el('span', 'p-avatar', p.avatar?.emoji || '🎨');
      av.style.background = (p.avatar?.color || '#6C5CE7') + '33';
      chip.appendChild(av);
      chip.appendChild(el('span', 'nm', p.name + (p.id === myId ? ' (you)' : '')));
      if (p.id === s.host) chip.appendChild(el('span', null, '👑'));
      if (isHost && p.id !== myId) {
        const kick = el('button', 'kick', '✕');
        kick.title = 'Kick';
        kick.onclick = () => socket.emit('kickPlayer', { playerId: p.id });
        chip.appendChild(kick);
      }
      grid.appendChild(chip);
    }

    $('public-toggle-row').style.display = isHost ? 'flex' : 'none';
    $('btn-lobby-friends').style.display = window.MiviAccount.isLoggedIn() ? 'block' : 'none';
    $('toggle-public').checked = !!s.public;
    $('btn-start').style.display = isHost ? 'flex' : 'none';
    $('waiting-msg').style.display = isHost ? 'none' : 'block';
    $('waiting-msg').textContent = s.managed
      ? 'Public game — it kicks off by itself once there are two of you.'
      : 'Waiting on the host to hit start…';
    // Always hidden until a fresh autoStart event re-shows it — a stale
    // "Starting!" banner would otherwise stick in managed lobbies.
    $('autostart-banner').style.display = 'none';

    $('words-panel').style.display = isHost ? 'block' : 'none';
    $('options-panel').style.display = isHost ? 'block' : 'none';
    $('options-readonly').style.display = isHost ? 'none' : 'block';
    if (isHost) {
      renderWordLists(s.wordLists);
      syncOptions(s.options);
      renderMyLists();
      if (s.wordPool) {
        $('avoid-hint').textContent = s.options.avoidRepeats
          ? `${s.wordPool.unused.toLocaleString()} of ${s.wordPool.total.toLocaleString()} words still unused in this room`
          : 'Words that already came up stay out of the rotation';
      }
    } else {
      renderReadonlyOptions(s);
    }
  }

  function renderReadonlyOptions(s) {
    const grid = $('options-readonly-grid');
    grid.textContent = '';
    const o = s.options;
    const items = [
      ['Rounds', o.rounds],
      ['Draw time', o.roundTime + 's'],
      ['Hints', o.hidden ? '—' : o.hintCount],
      ['Max players', o.maxPlayers],
      ['Lists', s.wordLists.selected.length],
      ['Mode', o.combinations ? 'Combos' : o.coopMode ? 'Co-op' : o.hidden ? 'Hidden' : 'Classic'],
      ['Spam guard', o.spamProtection ? 'On' : 'Off'],
      ['Repeats', o.avoidRepeats ? 'Avoided' : 'Allowed'],
    ];
    for (const [label, val] of items) {
      const item = el('div', 'ro-item');
      item.appendChild(el('b', null, String(val)));
      item.appendChild(document.createTextNode(label));
      grid.appendChild(item);
    }
  }

  let wlDebounce = null;
  function sendWordLists() {
    renderListOdds();
    clearTimeout(wlDebounce);
    wlDebounce = setTimeout(() => {
      const lists = [];
      const weights = {};
      document.querySelectorAll('#wl-grid .wl-item').forEach(item => {
        const cb = item.querySelector('input[type=checkbox]');
        const slider = item.querySelector('input[type=range]');
        if (cb.checked) {
          lists.push(cb.value);
          weights[cb.value] = parseInt(slider.value, 10) || 1;
        }
      });
      if (lists.length === 0) { toast('Keep at least one list ticked.'); return; }
      socket.emit('setWordLists', { lists, weights });
    }, 250);
  }

  function renderWordLists(wl) {
    const grid = $('wl-grid');
    // Preserve slider/checkbox state during re-render.
    const prev = {};
    grid.querySelectorAll('.wl-item').forEach(item => {
      const cb = item.querySelector('input[type=checkbox]');
      const sl = item.querySelector('input[type=range]');
      prev[cb.value] = { checked: cb.checked, weight: sl.value };
    });
    grid.textContent = '';
    for (const info of wl.available) {
      const p = prev[info.name];
      const checked = p ? p.checked : wl.selected.includes(info.name);
      const weight = p ? p.weight : (wl.weights?.[info.name] || 1);

      const item = el('div', 'wl-item' + (checked ? ' on' : ''));
      const top = el('label', 'wl-top');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = info.name;
      cb.checked = checked;
      top.appendChild(cb);
      top.appendChild(el('span', null, info.label || info.name));
      if (info.custom) top.appendChild(el('span', 'wl-badge', 'CUSTOM'));
      top.appendChild(el('span', 'cnt', String(info.count)));
      item.appendChild(top);

      const wrow = el('div', 'wl-weight');
      wrow.appendChild(document.createTextNode('Weight'));
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = '1'; slider.max = '10'; slider.value = String(weight);
      slider.disabled = !checked;
      wrow.appendChild(slider);
      const wv = el('span', 'wv', String(weight));
      wrow.appendChild(wv);
      if (info.custom) {
        const ex = el('button', 'wl-export', '⬇️');
        ex.title = 'Export as .txt';
        ex.onclick = (e) => { e.preventDefault(); socket.emit('exportCustomList', { name: info.name }); };
        wrow.appendChild(ex);
      }
      item.appendChild(wrow);

      cb.addEventListener('change', () => {
        item.classList.toggle('on', cb.checked);
        slider.disabled = !cb.checked;
        sendWordLists();
      });
      slider.addEventListener('input', () => { wv.textContent = slider.value; sendWordLists(); });
      grid.appendChild(item);
    }
    renderListOdds();
  }

  // "Odds" breakdown: the chance the next word comes from each selected list.
  // Only the weight moves this — list size doesn't (a word is picked from the
  // chosen list afterwards).
  function renderListOdds() {
    const box = $('list-odds');
    if (!box || box.style.display === 'none') return;
    const items = [];
    document.querySelectorAll('#wl-grid .wl-item').forEach(item => {
      const cb = item.querySelector('input[type=checkbox]');
      const sl = item.querySelector('input[type=range]');
      if (cb.checked) items.push({ name: cb.value, w: parseInt(sl.value, 10) || 1 });
    });
    box.textContent = '';
    if (!items.length) {
      box.appendChild(el('div', 'odds-note', 'Nothing ticked — pick at least one list.'));
      return;
    }
    const total = items.reduce((s, i) => s + i.w, 0);
    items.sort((a, b) => b.w - a.w);
    for (const i of items) {
      const pct = (i.w / total) * 100;
      const row = el('div', 'odds-row');
      row.appendChild(el('span', 'on', labelFor(i.name)));
      const bar = el('div', 'odds-bar');
      const fill = document.createElement('i');
      fill.style.width = pct.toFixed(1) + '%';
      bar.appendChild(fill);
      row.appendChild(bar);
      row.appendChild(el('span', 'opct', pct.toFixed(pct < 10 ? 1 : 0) + '%'));
      box.appendChild(row);
    }
    box.appendChild(el('div', 'odds-note', "How likely each word is to come from that list. The weight slider is what moves this — how big the list is doesn't matter."));
  }

  function renderMyLists() {
    const wrap = $('wl-mylists');
    const acct = window.MiviAccount;
    if (!acct.isLoggedIn()) { wrap.style.display = 'none'; return; }
    const lists = acct.myLists();
    if (!lists.length) { wrap.style.display = 'none'; return; }
    wrap.style.display = 'flex';
    const sel = $('mylists-select');
    sel.textContent = '';
    for (const l of lists) {
      const opt = document.createElement('option');
      opt.value = l.id;
      opt.textContent = `${l.name} (${l.count})`;
      sel.appendChild(opt);
    }
  }

  const OPT_KEYS = ['rounds', 'roundTime', 'wordChoices', 'hintCount', 'maxPlayers', 'autocorrectStrength'];
  const OPT_TOGGLES = ['combinations', 'lockComboParts', 'hidden', 'coopMode', 'showWordSource', 'spamProtection', 'textTool', 'avoidRepeats'];

  // Plain-language explanations shown when you tap the ? next to a setting.
  const HELP = {
    rounds: 'How many times everyone gets to draw. Ten rounds with eight players is about 40 minutes.',
    roundTime: 'How long the artist has per word. Time also shrinks once people start guessing right, so 90s rarely runs the full 90.',
    wordChoices: 'How many words the artist picks from at the start of their turn. More choices means fewer "I can\'t draw that" moments.',
    hintCount: 'Letters revealed over the round, spread out evenly. Never more than half the word.',
    maxPlayers: 'Seat limit for the room. Big rooms are fun but mean more waiting between your turns.',
    autocorrectStrength: 'How forgiving guessing is. Off: exact spelling only. Easy: one typo on longer words, plurals forgiven. Normal: a typo on most words, two on long ones. Generous: pretty much anything close counts.',
    combinations: 'Every word is actually two words glued together, like "boat+coat". Guess them as word1+word2.',
    lockComboParts: 'In Combinations, guessing one half correctly locks it in so you only need the other. Only does anything when Combinations is on.',
    hidden: 'Guessers see no letter count and get no hints. Brutal, but fun with good artists.',
    coopMode: 'Two people draw at the same time on the same canvas. Needs at least three players so someone is left to guess.',
    textTool: 'Lets artists type text onto the canvas with the T tool. Writing the actual word (or anything close to it) is blocked.',
    showWordSource: 'After each round, show which list the word came from.',
    avoidRepeats: "Words that have already been drawn — or even shown as a choice — stay out of the rotation for this room, across games, until you change lists. Tiny lists can't get stuck: if the list runs dry, words that were only offered come back first, then ones that were drawn.",
    spamProtection: 'Anyone sending more than six messages in five seconds, or the same thing three times in a row, gets muted for ten seconds. Always on in public games.',
  };

  function buildOptionHelp() {
    document.querySelectorAll('[data-help]').forEach(wrap => {
      const key = wrap.dataset.help;
      if (!HELP[key]) return;
      const btn = el('button', 'opt-help-btn', '?');
      btn.type = 'button';
      btn.title = 'What does this do?';
      const box = el('div', wrap.classList.contains('opt') ? 'opt-help' : 'toggle-help', HELP[key]);
      box.style.display = 'none';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const show = box.style.display === 'none';
        box.style.display = show ? 'block' : 'none';
        btn.classList.toggle('on', show);
      });
      const label = wrap.querySelector('label, span');
      if (wrap.classList.contains('opt')) label.after(btn); else wrap.appendChild(btn);
      wrap.appendChild(box);
    });
  }

  // "Lock combo parts" only means something when Combinations is on.
  function gateComboLock() {
    const combos = $('opt-combinations').checked;
    const lock = $('opt-lockComboParts');
    lock.disabled = !combos;
    lock.closest('.toggle-row').classList.toggle('dim', !combos);
  }
  const AC_LABELS = ['Off', 'Easy', 'Normal', 'Generous'];

  function optLabel(key, v) {
    if (key === 'roundTime') return v + 's';
    if (key === 'autocorrectStrength') return AC_LABELS[v] || v;
    return String(v);
  }

  function syncOptions(o) {
    for (const key of OPT_KEYS) {
      const input = $('opt-' + key);
      if (!input) continue;
      // Don't fight the host mid-drag — the echo would snap the thumb back.
      if (document.activeElement === input) continue;
      input.value = String(o[key]);
      $('opt-' + key + '-val').textContent = optLabel(key, o[key]);
    }
    for (const key of OPT_TOGGLES) {
      const input = $('opt-' + key);
      if (input) input.checked = !!o[key];
    }
    gateComboLock();
  }

  // ── Game screen widgets ──
  function updateRoundPill() {
    if (!gameState) return;
    $('round-pill').textContent = `Round ${gameState.round || 1}/${gameState.totalRounds || 3}`;
  }

  function updatePlayers(opts = {}) {
    const s = gameState;
    if (!s) return;
    const list = $('players-list');
    list.textContent = '';
    const sorted = [...s.players].sort((a, b) => b.score - a.score);
    sorted.forEach((p, i) => {
      const isDrawing = p.id === s.currentDrawerId || p.id === s.coopPartnerId;
      const guessed = guessedSet.has(p.id) || p.guessed;
      const row = el('div', 'p-row' + (isDrawing ? ' drawing' : '') + (guessed ? ' guessed' : '') + (p.connected === false ? ' dc' : ''));
      row.appendChild(el('span', 'rk', '#' + (i + 1)));
      const av = el('span', 'p-avatar', p.avatar?.emoji || '🎨');
      av.style.background = (p.avatar?.color || '#6C5CE7') + '33';
      row.appendChild(av);
      row.appendChild(el('span', 'nm', p.name + (p.id === myId ? ' (you)' : '')));
      if (isDrawing) row.appendChild(el('span', 'flag', '🖌️'));
      else if (guessed) row.appendChild(el('span', 'flag', '✅'));
      // ＋ = send a friend request (both of you need accounts).
      const acct = window.MiviAccount;
      if (p.id !== myId && p.accountId && acct.isLoggedIn() && !acct.friendIds().has(p.accountId) && p.accountId !== acct.user().id) {
        const add = el('button', 'addf', '＋');
        add.title = 'Add ' + p.name + ' as a friend';
        add.onclick = (ev) => { ev.stopPropagation(); socket.emit('friendRequest', { playerId: p.id }); };
        row.appendChild(add);
      }
      row.appendChild(el('span', 'sc', String(p.score)));
      if (opts.bumpId === p.id) row.appendChild(el('span', 'bump', '+' + opts.bumpPts));
      list.appendChild(row);
    });
  }

  // Timer ring
  const RING_C = 2 * Math.PI * 19;
  function setTimer(t) {
    currentTimeLeft = t;
    $('timer-num').textContent = t;
    const frac = phaseTotal > 0 ? Math.max(0, Math.min(1, t / phaseTotal)) : 0;
    $('timer-ring-fg').style.strokeDashoffset = String(RING_C * (1 - frac));
    $('timer-wrap').classList.toggle('urgent', t <= 10 && t > 0);
  }

  // Word tiles
  function renderWordTiles(word, opts = {}) {
    const box = $('word-tiles');
    box.textContent = '';
    if (opts.placeholder) { box.appendChild(el('span', 'word-meta', ' ')); setWordMetaText(''); return; }
    if (opts.hidden) {
      for (let i = 0; i < 3; i++) box.appendChild(el('span', 'tile filled', '?'));
      setWordMetaText('hidden mode');
      return;
    }
    if (!word) return;
    for (const ch of word) {
      if (ch === ' ') box.appendChild(el('span', 'tile-gap'));
      else if (ch === '+') box.appendChild(el('span', 'tile-plus', '+'));
      else if (ch === '_') box.appendChild(el('span', 'tile', ''));
      else box.appendChild(el('span', 'tile filled', ch));
    }
    if (!opts.revealed) setWordMeta(word);
  }

  function renderLockedWord() {
    if (!myLockedPart) return;
    const { lockedPart, remainingMask, lockedIsFirst } = myLockedPart;
    const box = $('word-tiles');
    box.textContent = '';
    const addPart = (text, mine) => {
      for (const ch of text) {
        if (ch === ' ') box.appendChild(el('span', 'tile-gap'));
        else if (ch === '_') box.appendChild(el('span', 'tile', ''));
        else box.appendChild(el('span', 'tile ' + (mine ? 'mine' : 'filled'), ch));
      }
    };
    if (lockedIsFirst) {
      addPart(lockedPart, true);
      box.appendChild(el('span', 'tile-plus', '+'));
      addPart(remainingMask, false);
    } else {
      addPart(remainingMask, false);
      box.appendChild(el('span', 'tile-plus', '+'));
      addPart(lockedPart, true);
    }
    const counts = remainingMask.split(' ').filter(Boolean).map(p => p.length).join(' · ');
    setWordMetaText(counts + ' letters left');
  }

  // Pretty name for a list ("classic" → "Classic"; custom lists keep theirs).
  function labelFor(name) {
    const avail = gameState && gameState.wordLists && gameState.wordLists.available;
    const hit = avail && avail.find(l => l.name === name);
    return hit ? (hit.label || hit.name) : name;
  }

  function setWordMeta(word, src, src2) {
    if (!word) { setWordMetaText(''); return; }
    const counts = word.replace(/\+/g, ' ').split(' ').filter(Boolean).map(p => p.length).join(' · ');
    let txt = counts;
    if (src) txt += `  ·  📚 ${labelFor(src)}${src2 && src2 !== src ? ' + ' + labelFor(src2) : ''}`;
    setWordMetaText(txt);
  }
  function setWordMetaText(t) { $('word-meta').textContent = t; }

  function renderWordChoices({ words, part, firstWord, coopPart2, firstPickerName, isCoopCombo, coopPartnerName, readOnly, pickerName }) {
    const overlay = $('overlay-choice');
    const title = $('choice-title');
    const grid = $('choice-grid');
    grid.textContent = '';

    if (readOnly) {
      title.textContent = `👀 ${pickerName || 'Your partner'} is picking…`;
      for (const w of words) {
        const b = el('button', 'word-choice', w);
        b.disabled = true;
        grid.appendChild(b);
      }
      overlay.style.display = 'flex';
      return;
    }

    if (part === 2 && coopPart2) title.textContent = `${firstPickerName} picked "${firstWord}" — pick the second word!`;
    else if (part === 2) title.textContent = `"${firstWord}" — now pick the second word!`;
    else if (part === 1 && isCoopCombo) title.textContent = `Pick the first word — ${coopPartnerName} picks the second!`;
    else title.textContent = '🖌️ Choose a word to draw!';

    for (const w of words) {
      const b = el('button', 'word-choice', w);
      b.onclick = () => {
        sfx('pop');
        if (part === 1) {
          title.textContent = `⏳ Picked "${w}"…`;
          grid.textContent = '';
        } else {
          overlay.style.display = 'none';
        }
        socket.emit('chooseWord', { word: w });
      };
      grid.appendChild(b);
    }
    overlay.style.display = 'flex';
  }

  function setArtistMode(artist) {
    isArtist = artist;
    $('toolbar').style.display = artist ? 'flex' : 'none';
    const textOn = !!(gameState && gameState.options && gameState.options.textTool);
    $('tool-text').style.display = textOn ? 'flex' : 'none';
    if (!textOn && currentTool === 'text') setTool('pen');
    closeTextInput();
    requestAnimationFrame(fitCanvas);
    $('game-chat-input').placeholder = artist ? 'Chat with guessers who got it…' : 'Type your guess…';
    if (artist) {
      $('overlay-wait').style.display = 'none';
      $('overlay-choosing').style.display = 'none';
    }
    updateLikeSkipUI();
  }

  function updateLikeSkipUI() {
    const inDrawing = gameState && gameState.state === 'drawing';
    const show = inDrawing && !isArtist;
    $('float-actions').style.display = show ? 'flex' : 'none';
    $('btn-like').classList.toggle('used', likeUsed);
    $('btn-voteskip').classList.toggle('used', voteSkipUsed);
    if (!inDrawing) { $('like-count').textContent = ''; $('skip-count').textContent = ''; }
  }

  // ── Chat ──
  function inLobbyScreen() { return $('screen-lobby').classList.contains('active'); }

  function addAnyChat(msg) {
    const target = inLobbyScreen() ? $('lobby-chat') : $('game-chat');
    const node = el('div', 'msg'
      + (msg.system ? ' sys' : '')
      + (msg.correct ? ' ok' : '')
      + (msg.close ? ' close' : '')
      + (msg.whisper ? ' whisper' : ''));
    if (msg.system) {
      node.textContent = msg.text;
    } else {
      const au = el('span', 'au', (msg.playerName || '?') + ':');
      const p = gameState?.players?.find(pl => pl.id === msg.playerId);
      au.style.color = p?.avatar?.color || 'var(--brand)';
      node.appendChild(au);
      node.appendChild(document.createTextNode(msg.text));
    }
    target.appendChild(node);
    while (target.children.length > 200) target.removeChild(target.firstChild);
    target.scrollTop = target.scrollHeight;

    // Chat badge in focus mode.
    if (!inLobbyScreen() && document.body.classList.contains('focus-mode') && !$('chat-card').classList.contains('open') && !msg.system) {
      const badge = $('chat-badge');
      badge.style.display = 'block';
      badge.textContent = String(Math.min(99, (parseInt(badge.textContent, 10) || 0) + 1));
    }
  }

  function sendGameChat() {
    const input = $('game-chat-input');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    if (gameState?.state === 'drawing' && !isArtist && !hasGuessed) {
      socket.emit('guess', { text });
    } else {
      socket.emit('chat', { text });
    }
  }

  function sendLobbyChat() {
    const input = $('lobby-chat-input');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    socket.emit('chat', { text });
  }

  // ── Canvas ──
  function setupCanvas() {
    const canvas = $('canvas');
    ctx = canvas.getContext('2d', { willReadFrequently: true });
    canvas.width = CANVAS_W;
    canvas.height = CANVAS_H;
    const preview = $('canvas-preview');
    pctx = preview.getContext('2d');
    preview.width = CANVAS_W;
    preview.height = CANVAS_H;
    clearCanvasLocal();

    canvas.addEventListener('contextmenu', (e) => e.preventDefault()); // long-press on phones
    canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture(e.pointerId); startDraw(e); });
    canvas.addEventListener('pointermove', draw);
    canvas.addEventListener('pointerup', endDraw);
    canvas.addEventListener('pointercancel', endDraw);
  }

  function clearCanvasLocal() {
    if (!ctx) return;
    ctx.fillStyle = canvasBg;
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  }

  function pos(e) {
    const canvas = $('canvas');
    const r = canvas.getBoundingClientRect();
    return {
      x: Math.round((e.clientX - r.left) * (CANVAS_W / r.width)),
      y: Math.round((e.clientY - r.top) * (CANVAS_H / r.height)),
    };
  }

  function emitDraw(data) {
    flushBatch();
    strokeEvents.push(data);
    socket.emit('draw', data);
  }

  // Freehand segments are batched and flushed every ~30ms — far fewer
  // packets than one per pointer event, with no visible lag.
  let batch = [];
  let batchTimer = null;
  function queueDraw(data) {
    strokeEvents.push(data);
    batch.push(data);
    if (!batchTimer) batchTimer = setTimeout(flushBatch, 30);
  }
  function flushBatch() {
    if (batchTimer) { clearTimeout(batchTimer); batchTimer = null; }
    if (batch.length) { socket.emit('drawBatch', batch); batch = []; }
  }

  // ── Text tool ──
  let textInput = null;
  function openTextInput(p) {
    closeTextInput();
    const frame = $('canvas-frame');
    const r = frame.getBoundingClientRect();
    const input = document.createElement('input');
    input.className = 'text-tool-input';
    input.maxLength = 40;
    input.placeholder = 'Type, then Enter';
    input.style.left = (p.x / CANVAS_W * 100) + '%';
    input.style.top = (p.y / CANVAS_H * 100) + '%';
    input.style.color = currentColor;
    input.style.fontSize = Math.max(12, Math.round((brushSize * 3 + 14) * r.width / CANVAS_W)) + 'px';
    const commit = () => {
      const text = input.value.trim();
      closeTextInput();
      if (!text) return;
      const data = { type: 'text', x: p.x, y: p.y, text, color: currentColor, size: brushSize };
      applyDraw(data);
      flushBatch();
      socket.emit('draw', data);
      socket.emit('strokeEnd');
    };
    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') commit();
      else if (ev.key === 'Escape') closeTextInput();
    });
    input.addEventListener('blur', () => setTimeout(() => { if (textInput === input) closeTextInput(); }, 200));
    frame.appendChild(input);
    textInput = input;
    setTimeout(() => input.focus(), 0);
  }
  function closeTextInput() {
    if (textInput) { textInput.remove(); textInput = null; }
  }

  function startDraw(e) {
    if (!isArtist || gameState?.state !== 'drawing') return;
    const p = pos(e);

    if (currentTool === 'text') {
      openTextInput(p);
      return;
    }
    if (currentTool === 'fill') {
      const data = { type: 'fill', x: p.x, y: p.y, color: currentColor };
      floodFill(ctx, p.x, p.y, currentColor);
      flushBatch();
      socket.emit('draw', data);
      socket.emit('strokeEnd');
      return;
    }

    drawing = true;
    if (['line', 'rect', 'circle', 'triangle'].includes(currentTool)) {
      shape = { x1: p.x, y1: p.y };
      return;
    }
    lastX = p.x; lastY = p.y;
    const color = currentTool === 'eraser' ? canvasBg : currentColor;
    const size = currentTool === 'eraser' ? brushSize * 2 : brushSize;
    ctx.beginPath();
    ctx.arc(p.x, p.y, size / 2, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    queueDraw({ type: 'dot', x: p.x, y: p.y, color, size, tool: currentTool });
  }

  function draw(e) {
    if (!drawing || !isArtist) return;
    if (shape) {
      const p = pos(e);
      drawShapePreview(shape.x1, shape.y1, p.x, p.y);
      return;
    }
    const color = currentTool === 'eraser' ? canvasBg : currentColor;
    const size = currentTool === 'eraser' ? brushSize * 2 : brushSize;
    // Coalesced events give every intermediate pointer position → smoother lines.
    const evs = (e.getCoalescedEvents && e.getCoalescedEvents()) || [];
    const list = evs.length ? evs : [e];
    for (const ce of list) {
      const p = pos(ce);
      if (p.x === lastX && p.y === lastY) continue;
      drawSeg(ctx, lastX, lastY, p.x, p.y, color, size);
      queueDraw({ type: 'line', x1: lastX, y1: lastY, x2: p.x, y2: p.y, color, size, tool: currentTool });
      lastX = p.x; lastY = p.y;
    }
  }

  function endDraw(e) {
    if (!drawing) return;
    drawing = false;
    if (shape) {
      const p = pos(e);
      pctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
      let data;
      if (currentTool === 'line') {
        data = { type: 'line', x1: shape.x1, y1: shape.y1, x2: p.x, y2: p.y, color: currentColor, size: brushSize, tool: 'pen' };
      } else {
        data = { type: currentTool, x1: shape.x1, y1: shape.y1, x2: p.x, y2: p.y, color: currentColor, size: brushSize };
      }
      shape = null;
      applyDraw(data);
      flushBatch();
      socket.emit('draw', data);
      socket.emit('strokeEnd');
      return;
    }
    pctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    flushBatch();
    if (strokeEvents.length > 0) {
      strokeEvents = [];
      socket.emit('strokeEnd');
    }
  }

  function drawShapePreview(x1, y1, x2, y2) {
    pctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    pctx.strokeStyle = currentColor;
    pctx.lineWidth = brushSize;
    pctx.lineCap = 'round';
    pctx.lineJoin = 'round';
    pctx.beginPath();
    if (currentTool === 'line') {
      pctx.moveTo(x1, y1); pctx.lineTo(x2, y2);
    } else if (currentTool === 'rect') {
      pctx.rect(x1, y1, x2 - x1, y2 - y1);
    } else if (currentTool === 'triangle') {
      const cx = (x1 + x2) / 2;
      pctx.moveTo(cx, y1); pctx.lineTo(x1, y2); pctx.lineTo(x2, y2); pctx.closePath();
    } else if (currentTool === 'circle') {
      const rx = Math.abs(x2 - x1) / 2, ry = Math.abs(y2 - y1) / 2;
      if (rx > 0 && ry > 0) pctx.ellipse((x1 + x2) / 2, (y1 + y2) / 2, rx, ry, 0, 0, Math.PI * 2);
    }
    pctx.stroke();
  }

  function drawSeg(c, x1, y1, x2, y2, color, size) {
    c.beginPath();
    c.moveTo(x1, y1);
    c.lineTo(x2, y2);
    c.strokeStyle = color;
    c.lineWidth = size;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.stroke();
  }

  function applyDraw(d) {
    if (!ctx) return;
    // Eraser strokes always erase to the LOCAL canvas background — the wire
    // color is the artist's background, which may differ from ours.
    const col = d.tool === 'eraser' ? canvasBg : d.color;
    if (d.type === 'dot') {
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.size / 2, 0, Math.PI * 2);
      ctx.fillStyle = col;
      ctx.fill();
    } else if (d.type === 'line') {
      drawSeg(ctx, d.x1, d.y1, d.x2, d.y2, col, d.size);
    } else if (d.type === 'text') {
      ctx.font = `800 ${Math.round((d.size || 6) * 3 + 14)}px 'Plus Jakarta Sans', system-ui, sans-serif`;
      ctx.fillStyle = d.color;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.fillText(String(d.text || '').slice(0, 40), d.x, d.y);
    } else if (d.type === 'fill') {
      floodFill(ctx, Math.round(d.x), Math.round(d.y), d.color);
    } else if (d.type === 'rect') {
      ctx.beginPath();
      ctx.strokeStyle = d.color; ctx.lineWidth = d.size; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.strokeRect(d.x1, d.y1, d.x2 - d.x1, d.y2 - d.y1);
    } else if (d.type === 'circle') {
      const rx = Math.abs(d.x2 - d.x1) / 2, ry = Math.abs(d.y2 - d.y1) / 2;
      if (rx > 0 && ry > 0) {
        ctx.beginPath();
        ctx.ellipse((d.x1 + d.x2) / 2, (d.y1 + d.y2) / 2, rx, ry, 0, 0, Math.PI * 2);
        ctx.strokeStyle = d.color; ctx.lineWidth = d.size; ctx.lineCap = 'round';
        ctx.stroke();
      }
    } else if (d.type === 'triangle') {
      const cx = (d.x1 + d.x2) / 2;
      ctx.beginPath();
      ctx.moveTo(cx, d.y1); ctx.lineTo(d.x1, d.y2); ctx.lineTo(d.x2, d.y2); ctx.closePath();
      ctx.strokeStyle = d.color; ctx.lineWidth = d.size; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.stroke();
    }
  }

  function floodFill(targetCtx, startX, startY, fillHex) {
    const canvas = targetCtx.canvas;
    const imageData = targetCtx.getImageData(0, 0, canvas.width, canvas.height);
    const d = imageData.data;
    const W = canvas.width, H = canvas.height;
    startX = Math.max(0, Math.min(W - 1, startX));
    startY = Math.max(0, Math.min(H - 1, startY));
    const fillR = parseInt(fillHex.slice(1, 3), 16);
    const fillG = parseInt(fillHex.slice(3, 5), 16);
    const fillB = parseInt(fillHex.slice(5, 7), 16);
    const si = (startY * W + startX) * 4;
    const tR = d[si], tG = d[si + 1], tB = d[si + 2];
    if (tR === fillR && tG === fillG && tB === fillB) return;
    const TOL = 80;
    const matches = (i) => Math.abs(d[i] - tR) + Math.abs(d[i + 1] - tG) + Math.abs(d[i + 2] - tB) <= TOL;
    const visited = new Uint8Array(W * H);
    const stack = [startX + startY * W];
    while (stack.length > 0) {
      const pos = stack.pop();
      if (visited[pos]) continue;
      const x = pos % W, y = (pos / W) | 0;
      const i = pos * 4;
      if (!matches(i)) continue;
      visited[pos] = 1;
      d[i] = fillR; d[i + 1] = fillG; d[i + 2] = fillB; d[i + 3] = 255;
      if (x > 0) stack.push(pos - 1);
      if (x < W - 1) stack.push(pos + 1);
      if (y > 0) stack.push(pos - W);
      if (y < H - 1) stack.push(pos + W);
    }
    targetCtx.putImageData(imageData, 0, 0);
  }

  // ── Tools UI ──
  function buildToolsUI() {
    document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
      btn.addEventListener('click', () => setTool(btn.dataset.tool));
    });
    $('btn-undo').addEventListener('click', () => { if (isArtist) { flushBatch(); socket.emit('undo'); } });
    $('btn-clear').addEventListener('click', () => {
      if (!isArtist) return;
      flushBatch();
      clearCanvasLocal();
      socket.emit('clearCanvas');
    });

    const dots = $('size-dots');
    SIZES.forEach((s, i) => {
      const d = el('button', 'size-dot' + (s === brushSize ? ' active' : ''));
      d.title = s + 'px';
      const inner = document.createElement('i');
      const px = Math.max(4, Math.min(24, s * 0.65));
      inner.style.width = px + 'px';
      inner.style.height = px + 'px';
      d.appendChild(inner);
      d.addEventListener('click', () => {
        brushSize = s;
        dots.querySelectorAll('.size-dot').forEach(x => x.classList.remove('active'));
        d.classList.add('active');
      });
      dots.appendChild(d);
    });

    const pal = $('palette');
    PALETTE.forEach(c => {
      const sw = el('button', 'swatch' + (c === currentColor ? ' active' : ''));
      sw.style.background = c;
      sw.addEventListener('click', () => selectColor(c));
      pal.appendChild(sw);
    });
    const rainbow = el('button', 'swatch rainbow');
    rainbow.title = 'Custom color';
    const picker = document.createElement('input');
    picker.type = 'color';
    picker.style.cssText = 'position:absolute;opacity:0;width:0;height:0;pointer-events:none';
    picker.addEventListener('input', (e) => selectColor(e.target.value));
    rainbow.appendChild(picker);
    rainbow.addEventListener('click', () => picker.click());
    pal.appendChild(rainbow);
  }

  function selectColor(c) {
    currentColor = c;
    if (currentTool === 'eraser') setTool('pen');
    document.querySelectorAll('.palette .swatch').forEach(sw => {
      sw.classList.toggle('active', sw.style.background && rgbToHex(sw.style.background) === c.toLowerCase());
    });
  }

  function rgbToHex(rgb) {
    const m = rgb.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/);
    if (!m) return rgb.toLowerCase();
    return '#' + [m[1], m[2], m[3]].map(n => parseInt(n, 10).toString(16).padStart(2, '0')).join('');
  }

  function setTool(tool) {
    if (tool === 'text' && !(gameState && gameState.options && gameState.options.textTool)) return;
    if (tool !== 'text') closeTextInput();
    currentTool = tool;
    document.querySelectorAll('.tool-btn[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === tool));
  }

  // ── Fullscreen focus mode ──
  function toggleFocusMode() {
    if (document.body.classList.contains('focus-mode')) exitFocusMode();
    else enterFocusMode();
  }
  function enterFocusMode() {
    document.body.classList.add('focus-mode');
    $('chat-badge').style.display = 'none';
    $('chat-badge').textContent = '0';
    try { document.documentElement.requestFullscreen && document.documentElement.requestFullscreen().catch(() => {}); } catch (e) {}
    $('btn-fullscreen').textContent = '🗗';
    requestAnimationFrame(fitCanvas);
  }
  function exitFocusMode() {
    if (!document.body.classList.contains('focus-mode')) return;
    document.body.classList.remove('focus-mode');
    $('chat-card').classList.remove('open');
    try { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); } catch (e) {}
    $('btn-fullscreen').textContent = '⛶';
    requestAnimationFrame(fitCanvas);
  }

  // ── Round end / game end ──
  function showRoundEnd(p) {
    // Snapshot the canvas before anything resets it.
    const dataUrl = $('canvas').toDataURL('image/png');
    const artist = p.coopPartnerName ? `${p.drawerName} & ${p.coopPartnerName}` : (p.drawerName || '?');
    snap = {
      dataUrl,
      word: p.word || '',
      artist,
      guessedCount: p.guessedCount || 0,
      playerCount: p.guesserCount || 0,
      likes: p.likeCount || 0,
      saved: false,
    };

    $('re-title').textContent = p.aborted ? '⚠️ Round over' : '⏱️ Round over!';
    const wordEl = $('re-word');
    wordEl.textContent = '';
    if (p.aborted && p.reason) {
      wordEl.appendChild(document.createTextNode(p.reason));
    } else {
      wordEl.appendChild(document.createTextNode(`The word was “${p.word}”`));
      if (p.wordSource) {
        wordEl.appendChild(el('small', null, `from: ${labelFor(p.wordSource)}${p.wordSource2 && p.wordSource2 !== p.wordSource ? ' + ' + labelFor(p.wordSource2) : ''}`));
      }
    }
    $('re-image').src = dataUrl;
    $('re-stats').textContent = `Drawn by ${artist} · ${snap.guessedCount}/${snap.playerCount} guessed it`;
    $('re-like-count').textContent = String(snap.likes);
    $('btn-re-like').classList.toggle('used', likeUsed || wasArtistThisRound);
    $('btn-re-save').style.display = window.MiviAccount.isLoggedIn() ? 'inline-block' : 'none';
    $('btn-re-save').textContent = '💾 Save to gallery';
    $('btn-re-save').disabled = false;

    const scoresBox = $('re-scores');
    scoresBox.textContent = '';
    [...p.scores].sort((a, b) => b.score - a.score).forEach(s => {
      const row = el('div', 're-score-row');
      row.appendChild(el('span', null, s.name + (s.id === myId ? ' (you)' : '')));
      const right = el('span');
      const delta = el('span', 'd' + (s.delta ? '' : ' zero'), s.delta ? `+${s.delta} ` : '+0 ');
      right.appendChild(delta);
      right.appendChild(el('span', 't', String(s.score)));
      row.appendChild(right);
      scoresBox.appendChild(row);
    });

    $('overlay-roundend').style.display = 'flex';
    clearTimeout(showRoundEnd._h);
    showRoundEnd._h = setTimeout(() => hideOverlay('overlay-roundend'), 5600);

    // Auto-save for logged-in artists.
    const acct = window.MiviAccount;
    if (wasArtistThisRound && acct.isLoggedIn() && acct.user()?.settings?.autosaveDrawings && !p.aborted) {
      saveSnapToGallery(true);
    }
  }

  async function saveSnapToGallery(auto) {
    if (!snap || snap.saved) return;
    try {
      await API.saveDrawing({
        dataUrl: snap.dataUrl,
        word: snap.word,
        artist: snap.artist,
        guessedCount: snap.guessedCount,
        playerCount: snap.playerCount,
        likes: snap.likes,
      });
      snap.saved = true;
      sfx('save');
      $('btn-re-save').textContent = '✅ Saved!';
      $('btn-re-save').disabled = true;
      if (!auto) toast('💾 Saved to your gallery!');
      else toast('💾 Drawing auto-saved to your gallery');
    } catch (e) {
      if (!auto) toast('❌ ' + e.message);
    }
  }

  function downloadSnap() {
    if (!snap) return;
    const img = new Image();
    img.onload = () => {
      const off = document.createElement('canvas');
      off.width = img.width;
      off.height = img.height;
      const c = off.getContext('2d');
      c.drawImage(img, 0, 0);
      const bannerH = 110;
      const y0 = off.height - bannerH;
      c.fillStyle = 'rgba(20,21,39,0.78)';
      c.fillRect(0, y0, off.width, bannerH);
      c.textAlign = 'center';
      c.fillStyle = '#fff';
      c.font = 'bold 36px sans-serif';
      c.fillText(snap.word || '', off.width / 2, y0 + 42);
      c.font = '20px sans-serif';
      c.fillStyle = '#b9b3f5';
      c.fillText(`drawn by ${snap.artist} · ${snap.guessedCount}/${snap.playerCount} guessed it`, off.width / 2, y0 + 78);
      const a = document.createElement('a');
      a.href = off.toDataURL('image/png');
      a.download = (snap.word || 'drawing').replace(/[^a-zA-Z0-9 ]/g, '-').trim() + '.png';
      a.click();
    };
    img.src = snap.dataUrl;
  }

  let geTimer = null;
  function showGameEnd(finalScores) {
    const podium = $('podium');
    podium.textContent = '';
    const medals = ['🥇', '🥈', '🥉'];
    const heights = [110, 78, 56];
    const order = [1, 0, 2]; // silver, gold, bronze arrangement
    const top3 = finalScores.slice(0, 3);
    order.forEach(i => {
      const p = top3[i];
      if (!p) return;
      const e = el('div', 'podium-e');
      e.appendChild(el('div', 'medal', medals[i]));
      e.appendChild(el('div', 'pn', p.name));
      e.appendChild(el('div', 'pp', p.score + ' pts'));
      const bar = el('div', 'bar');
      bar.style.height = heights[i] + 'px';
      e.appendChild(bar);
      podium.appendChild(e);
    });
    const list = $('final-list');
    list.textContent = '';
    finalScores.forEach((p, i) => {
      const row = el('div', 'final-row');
      row.appendChild(el('span', null, `${i + 1}. ${p.name}${p.id === myId ? ' (you)' : ''}`));
      row.appendChild(el('span', 'pts', p.score + ' pts'));
      list.appendChild(row);
    });
    $('btn-skip-lobby').style.display = (gameState && gameState.host === myId && !gameState.managed) ? 'inline-block' : 'none';
    let count = 12;
    $('ge-count').textContent = count;
    clearInterval(geTimer);
    geTimer = setInterval(() => {
      count--;
      $('ge-count').textContent = Math.max(0, count);
      if (count <= 0) clearInterval(geTimer);
    }, 1000);
    $('overlay-gameend').style.display = 'flex';
  }

  function hideOverlay(id) { $(id).style.display = 'none'; }

  // ── Invite toast (a friend asked you to join their room) ──
  let pendingInvite = null;
  function showInviteToast(inv) {
    pendingInvite = inv;
    $('invite-text').textContent = `${inv.from.avatar?.emoji || '🎮'} ${inv.from.username} invited you to ${inv.roomName}`;
    $('invite-toast').style.display = 'flex';
    clearTimeout(showInviteToast._h);
    showInviteToast._h = setTimeout(hideInviteToast, 30000);
  }
  function hideInviteToast() {
    $('invite-toast').style.display = 'none';
    pendingInvite = null;
  }
  function acceptInvite() {
    if (!pendingInvite) return;
    const code = pendingInvite.code;
    hideInviteToast();
    if (roomCode === code) return;
    if (roomCode) {
      socket.emit('leaveRoom');
      roomCode = null;
      gameState = null;
      API.lsDel('mivi_room');
      exitFocusMode();
    }
    socket.emit('joinRoom', { code, name: ensureName(), avatar: myAvatar() });
  }

  // ── Confetti ──
  const confettiParts = [];
  let confettiRunning = false;
  function confetti(n) {
    const cv = $('confetti');
    cv.width = innerWidth;
    cv.height = innerHeight;
    const colors = ['#6C5CE7', '#FD79A8', '#00CEC9', '#FDCB6E', '#00B894'];
    for (let i = 0; i < n; i++) {
      confettiParts.push({
        x: Math.random() * cv.width,
        y: -20 - Math.random() * cv.height * 0.3,
        vx: (Math.random() - 0.5) * 3,
        vy: 2 + Math.random() * 4,
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.25,
        w: 6 + Math.random() * 7,
        h: 4 + Math.random() * 5,
        color: colors[i % colors.length],
      });
    }
    if (!confettiRunning) { confettiRunning = true; requestAnimationFrame(confettiFrame); }
  }
  function confettiFrame() {
    const cv = $('confetti');
    const c = cv.getContext('2d');
    c.clearRect(0, 0, cv.width, cv.height);
    for (let i = confettiParts.length - 1; i >= 0; i--) {
      const p = confettiParts[i];
      p.x += p.vx; p.y += p.vy; p.rot += p.vr; p.vy += 0.05;
      if (p.y > cv.height + 30) { confettiParts.splice(i, 1); continue; }
      c.save();
      c.translate(p.x, p.y);
      c.rotate(p.rot);
      c.fillStyle = p.color;
      c.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      c.restore();
    }
    if (confettiParts.length > 0) requestAnimationFrame(confettiFrame);
    else { confettiRunning = false; c.clearRect(0, 0, cv.width, cv.height); cv.width = 0; cv.height = 0; }
  }

  // ── Avatar picker ──
  function renderAvatarBubble() {
    const av = myAvatar();
    const b = $('avatar-bubble');
    b.textContent = av.emoji;
    b.style.background = av.color + '33';
    b.style.borderColor = av.color;
  }

  function buildAvatarPicker() {
    const emojis = $('avatar-emojis');
    const colors = $('avatar-colors');
    const current = myAvatar();
    EMOJIS.forEach(e => {
      const b = el('button', current.emoji === e ? 'sel' : '', e);
      b.addEventListener('click', () => {
        const av = { ...myAvatar(), emoji: e };
        setAvatar(av);
        emojis.querySelectorAll('button').forEach(x => x.classList.toggle('sel', x.textContent === e));
      });
      emojis.appendChild(b);
    });
    COLORS.forEach(c => {
      const b = el('button', current.color === c ? 'sel' : '');
      b.style.background = c;
      b.addEventListener('click', () => {
        const av = { ...myAvatar(), color: c };
        setAvatar(av);
        colors.querySelectorAll('button').forEach(x => x.classList.remove('sel'));
        b.classList.add('sel');
      });
      colors.appendChild(b);
    });
  }

  // ── Settings ──
  function applyTheme(theme) {
    if (theme === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
    API.lsSet('mivi_theme', theme);
    $('btn-theme').textContent = theme === 'dark' ? '☀️' : '🌙';
    document.querySelectorAll('#seg-theme .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.themeOpt === theme));
  }

  function applyScale(v) {
    document.documentElement.style.fontSize = (16 * v / 100) + 'px';
    $('set-scale-val').textContent = v + '%';
    API.lsSet('mivi_scale', String(v));
  }

  function syncAudioUI() {
    const st = Audio.getState();
    $('set-music-on').checked = st.musicEnabled;
    $('set-sfx-on').checked = st.sfxEnabled;
    $('set-music-vol').value = Math.round(st.musicVolume * 100);
    $('set-sfx-vol').value = Math.round(st.sfxVolume * 100);
    $('btn-music').classList.toggle('off', !st.musicEnabled);
  }

  // ── Invite links ──
  function inviteUrl() { return location.origin + '/?join=' + roomCode; }
  function copyInvite() {
    if (!roomCode) return;
    const url = inviteUrl();
    if (navigator.share) {
      navigator.share({ title: 'Mivimoose Draw', text: 'Come draw with me!', url }).catch(() => {
        navigator.clipboard.writeText(url).then(() => toast('🔗 Invite link copied!'));
      });
    } else {
      navigator.clipboard.writeText(url).then(() => toast('🔗 Invite link copied!'));
    }
  }

  // ── List library ──
  function showLibTab(name) {
    document.querySelectorAll('#modal-library .tab').forEach(t => t.classList.toggle('active', t.dataset.libtab === name));
    document.querySelectorAll('#modal-library .tab-pane').forEach(p => p.classList.toggle('active', p.id === 'libtab-' + name));
    if (name === 'upload') syncLibraryUploadForm();
  }

  function openLibrary() {
    $('modal-library').style.display = 'flex';
    showLibTab('browse');
    refreshLibrary();
  }

  function syncLibraryUploadForm() {
    const acct = window.MiviAccount;
    const needLogin = !acct.isLoggedIn(); // sharing always needs an account
    $('lib-upload-form').style.display = needLogin ? 'none' : 'flex';
    $('lib-need-login').style.display = needLogin ? 'flex' : 'none';
    $('lib-author').style.display = 'none';
  }

  async function refreshLibrary() {
    const rows = $('lib-rows');
    rows.textContent = '';
    let lists = [];
    try { lists = (await API.library()).lists; } catch (e) { toast('❌ ' + e.message); }
    $('lib-empty').style.display = lists.length ? 'none' : 'block';
    for (const l of lists) {
      const row = el('div', 'list-row');
      row.appendChild(el('span', 'ln', l.name));
      row.appendChild(el('span', 'lc', `${l.count} words · by ${l.author} · ${l.downloads} downloads`));
      const dl = el('button', null, '⬇️');
      dl.title = 'Download as .txt';
      dl.onclick = () => {
        const a = document.createElement('a');
        a.href = API.libraryDownloadUrl(l.id);
        a.download = '';
        a.click();
      };
      row.appendChild(dl);
      if (window.MiviAccount.isLoggedIn()) {
        const save = el('button', null, '💾');
        save.title = 'Save to my lists';
        save.onclick = async () => {
          try {
            const d = await API.libraryList(l.id);
            await API.createList(d.list.name, d.list.words);
            toast(`💾 "${d.list.name}" is in your lists now`);
            window.MiviAccount.refreshLists();
          } catch (e) { toast('❌ ' + e.message); }
        };
        row.appendChild(save);
      }
      if (window.MiviApp && window.MiviApp.canAddRoomList && window.MiviApp.canAddRoomList()) {
        const use = el('button', null, '🎮');
        use.title = 'Use in my room';
        use.onclick = async () => {
          try {
            const d = await API.libraryList(l.id);
            window.MiviApp.addRoomList(d.list.name, d.list.words.join('\n'));
            $('modal-library').style.display = 'none';
            toast(`🎮 "${d.list.name}" is in your room's lists now`);
          } catch (e) { toast('❌ ' + e.message); }
        };
        row.appendChild(use);
      }
      if (l.mine) {
        const del = el('button', null, '🗑️');
        del.title = 'Take it down';
        del.onclick = async () => {
          if (!confirm(`Take "${l.name}" out of the library?`)) return;
          try { await API.libraryDelete(l.id); refreshLibrary(); } catch (e) { toast('❌ ' + e.message); }
        };
        row.appendChild(del);
      }
      rows.appendChild(row);
    }
  }

  function libWords() {
    return $('lib-words').value.split(/[\n,]+/).map(w => w.trim()).filter(Boolean);
  }

  async function uploadToLibrary() {
    const name = $('lib-name').value.trim();
    const words = libWords();
    const errEl = $('lib-error');
    errEl.textContent = '';
    if (!name) { errEl.textContent = 'Give it a name first.'; return; }
    if (!words.length) { errEl.textContent = 'Add some words first.'; return; }
    const pre = window.MiviProfanity ? window.MiviProfanity.filter(words) : { clean: words, removed: 0 };
    if (!pre.clean.length) { errEl.textContent = "Swear protection would drop every single word — that's a no."; return; }
    const btn = $('btn-lib-upload');
    btn.disabled = true;
    try {
      const res = await API.libraryUpload({ name, words, author: $('lib-author').value.trim() });
      const removed = res.removedBySwearFilter || 0;
      toast(removed
        ? `📚 Shared! Swear protection dropped ${removed} word${removed === 1 ? '' : 's'}.`
        : `📚 "${res.list.name}" is in the library!`);
      $('lib-name').value = '';
      $('lib-words').value = '';
      $('lib-count').textContent = '0 words';
      showLibTab('browse');
      refreshLibrary();
    } catch (e) {
      errEl.textContent = e.message;
    } finally {
      btn.disabled = false;
    }
  }

  // ── Boot ──
  document.addEventListener('DOMContentLoaded', async () => {
    // Restore prefs.
    applyTheme(API.lsGet('mivi_theme') || 'light');
    const scale = parseInt(API.lsGet('mivi_scale'), 10);
    if (scale) { $('set-scale').value = scale; applyScale(scale); }
    $('home-name').value = API.lsGet('mivi_name') || '';

    setupCanvas();
    buildToolsUI();
    buildAvatarPicker();
    renderAvatarBubble();
    syncAudioUI();

    // Invite link?
    const params = new URLSearchParams(location.search);
    if (params.get('join')) {
      pendingJoin = params.get('join').toUpperCase();
      $('home-code').value = pendingJoin;
      history.replaceState(null, '', '/');
    }

    // Audio unlock on first interaction.
    const unlock = () => {
      Audio.init();
      Audio.startMusic();
      document.removeEventListener('pointerdown', unlock);
      document.removeEventListener('keydown', unlock);
    };
    document.addEventListener('pointerdown', unlock);
    document.addEventListener('keydown', unlock);

    // Account → then socket (token must be known before connecting).
    await window.MiviAccount.init();
    if (window.__miviJustSignedIn && window.MiviAccount.isLoggedIn()) {
      toast(`👋 Hey ${window.MiviAccount.user().username}, you're signed in.`);
    } else if (window.__miviAuthError) {
      toast('❌ ' + window.__miviAuthError);
    }
    connectSocket();
    window.MiviAccount.onChange(() => {
      // Reconnect only when the auth token actually changed (list refreshes
      // fire this too) and we're not seated in a room.
      if (!roomCode && API.token() !== socketToken) connectSocket();
      if (gameState?.state === 'lobby') updateLobby();
      // Prefill name from account.
      const u = window.MiviAccount.user();
      if (u && !$('home-name').value) $('home-name').value = u.username;
    });
    if (window.MiviAccount.isLoggedIn()) window.MiviAccount.refreshLists();

    // ── Wire home ──
    $('brand-home').addEventListener('click', () => {
      if (roomCode && !confirm('Leave the current room?')) return;
      leaveToHome();
    });
    $('btn-quickplay').addEventListener('click', () => {
      sfx('click');
      socket.emit('quickPlay', { name: ensureName(), avatar: myAvatar() });
    });
    $('btn-create').addEventListener('click', () => {
      sfx('click');
      socket.emit('createRoom', { name: ensureName(), avatar: myAvatar() });
    });
    $('btn-join').addEventListener('click', joinFromInput);
    $('home-code').addEventListener('keydown', e => { if (e.key === 'Enter') joinFromInput(); });
    function joinFromInput() {
      const code = $('home-code').value.trim().toUpperCase();
      if (!code) { $('home-error').textContent = 'Type a room code first.'; return; }
      socket.emit('joinRoom', { code, name: ensureName(), avatar: myAvatar() });
    }
    $('home-name').addEventListener('change', () => {
      const n = myName();
      if (n) { API.lsSet('mivi_name', n); socket.emit('updateProfile', { name: n }); }
    });
    $('avatar-bubble').addEventListener('click', () => {
      const p = $('avatar-picker');
      p.style.display = p.style.display === 'none' ? 'block' : 'none';
    });
    $('btn-refresh-rooms').addEventListener('click', fetchRooms);

    // ── Wire lobby ──
    $('lobby-code').addEventListener('click', () => {
      navigator.clipboard.writeText(roomCode).then(() => toast('📋 Code copied!'));
    });
    $('btn-copy-code').addEventListener('click', () => {
      navigator.clipboard.writeText(roomCode).then(() => toast('📋 Code copied!'));
    });
    $('btn-copy-invite').addEventListener('click', copyInvite);
    $('btn-invite-top').addEventListener('click', copyInvite);
    $('toggle-public').addEventListener('change', (e) => socket.emit('setRoomPublic', { public: e.target.checked }));
    $('btn-start').addEventListener('click', () => socket.emit('startGame'));
    $('lobby-chat-send').addEventListener('click', sendLobbyChat);
    $('lobby-chat-input').addEventListener('keydown', e => { if (e.key === 'Enter') sendLobbyChat(); });

    $('btn-add-list').addEventListener('click', () => {
      const name = $('cl-name').value.trim();
      const text = $('cl-words').value.trim();
      if (!name) { toast('Name the list first.'); return; }
      if (!text) { toast('It needs some words first.'); return; }
      socket.emit('addCustomList', { name, text });
    });
    $('btn-import-list').addEventListener('click', () => $('import-file').click());
    $('import-file').addEventListener('change', (e) => {
      Array.from(e.target.files || []).forEach(file => {
        const reader = new FileReader();
        reader.onload = (ev) => {
          const text = String(ev.target.result || '').trim();
          const name = file.name.replace(/\.txt$/i, '');
          if (!text) { toast(`"${name}" is empty — skipped.`); return; }
          socket.emit('addCustomList', { name, text });
        };
        reader.readAsText(file);
      });
      e.target.value = '';
    });
    $('btn-attach-list').addEventListener('click', () => {
      const id = $('mylists-select').value;
      if (id) socket.emit('attachAccountList', { listId: id });
    });

    // Options
    for (const key of OPT_KEYS) {
      const input = $('opt-' + key);
      if (!input) continue;
      input.addEventListener('input', () => {
        const v = parseInt(input.value, 10); // capture now — a stateUpdate echo may rewrite input.value
        $('opt-' + key + '-val').textContent = optLabel(key, v);
        clearTimeout(input._h);
        input._h = setTimeout(() => socket.emit('setGameOptions', { options: { [key]: v } }), 200);
      });
    }
    for (const key of OPT_TOGGLES) {
      const input = $('opt-' + key);
      if (!input) continue;
      input.addEventListener('change', () => {
        socket.emit('setGameOptions', { options: { [key]: input.checked } });
        if (key === 'combinations') gateComboLock();
      });
    }

    // ── Wire game ──
    $('game-chat-send').addEventListener('click', sendGameChat);
    $('game-chat-input').addEventListener('keydown', e => { if (e.key === 'Enter') sendGameChat(); });
    $('btn-fullscreen').addEventListener('click', toggleFocusMode);
    $('btn-chat-toggle').addEventListener('click', () => {
      $('chat-card').classList.add('open');
      $('chat-badge').style.display = 'none';
      $('chat-badge').textContent = '0';
    });
    $('btn-chat-close').addEventListener('click', () => $('chat-card').classList.remove('open'));
    $('btn-like').addEventListener('click', () => { likeUsed = true; updateLikeSkipUI(); socket.emit('likeRound'); });
    $('btn-re-like').addEventListener('click', () => {
      if (wasArtistThisRound || likeUsed) return;
      likeUsed = true;
      $('btn-re-like').classList.add('used');
      socket.emit('likeRound');
    });
    $('btn-voteskip').addEventListener('click', () => { voteSkipUsed = true; updateLikeSkipUI(); socket.emit('voteSkip'); });
    $('btn-re-download').addEventListener('click', downloadSnap);
    $('btn-re-save').addEventListener('click', () => saveSnapToGallery(false));
    $('btn-skip-lobby').addEventListener('click', () => socket.emit('skipToLobby'));

    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement && document.body.classList.contains('focus-mode')) {
        // Leaving browser fullscreen exits focus layout too.
        document.body.classList.remove('focus-mode');
        $('chat-card').classList.remove('open');
        $('btn-fullscreen').textContent = '⛶';
      }
    });

    // Keyboard shortcuts.
    document.addEventListener('keydown', (e) => {
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        if (isArtist) { e.preventDefault(); flushBatch(); socket.emit('undo'); }
        return;
      }
      if (typing) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return; // don't hijack browser shortcuts
      const inGame = $('screen-game').classList.contains('active');
      if (!inGame) return;
      const k = e.key.toLowerCase();
      if (k === 'f') { e.preventDefault(); toggleFocusMode(); }
      if (k === 'escape') exitFocusMode();
      if (!isArtist) return;
      const toolMap = { b: 'pen', e: 'eraser', g: 'fill', l: 'line', r: 'rect', c: 'circle', t: 'triangle', x: 'text' };
      if (toolMap[k]) setTool(toolMap[k]);
    });

    // ── Topbar buttons ──
    $('btn-theme').addEventListener('click', () => {
      applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
    });
    $('btn-music').addEventListener('click', () => {
      Audio.init();
      const st = Audio.getState();
      Audio.setMusicEnabled(!st.musicEnabled);
      if (!st.musicEnabled) Audio.startMusic();
      syncAudioUI();
    });
    $('btn-settings').addEventListener('click', () => { syncAudioUI(); $('modal-settings').style.display = 'flex'; });
    document.querySelectorAll('#seg-theme .seg-btn').forEach(b => {
      b.addEventListener('click', () => applyTheme(b.dataset.themeOpt));
    });
    $('set-music-on').addEventListener('change', e => { Audio.init(); Audio.setMusicEnabled(e.target.checked); if (e.target.checked) Audio.startMusic(); syncAudioUI(); });
    $('set-sfx-on').addEventListener('change', e => { Audio.setSfxEnabled(e.target.checked); });
    $('set-music-vol').addEventListener('input', e => Audio.setMusicVolume(e.target.value / 100));
    $('set-sfx-vol').addEventListener('input', e => Audio.setSfxVolume(e.target.value / 100));
    $('set-scale').addEventListener('input', e => applyScale(parseInt(e.target.value, 10)));

    // ── List odds (lobby) ──
    $('btn-list-odds').addEventListener('click', () => {
      const box = $('list-odds');
      const show = box.style.display === 'none';
      box.style.display = show ? 'flex' : 'none';
      $('btn-list-odds').textContent = show ? 'ℹ️ Hide odds' : 'ℹ️ Odds';
      if (show) renderListOdds();
    });

    // ── List library ──
    $('btn-library').addEventListener('click', openLibrary);
    $('btn-lobby-library').addEventListener('click', openLibrary);
    document.querySelectorAll('#modal-library .tab').forEach(t => t.addEventListener('click', () => showLibTab(t.dataset.libtab)));
    $('btn-lib-upload').addEventListener('click', uploadToLibrary);
    $('lib-words').addEventListener('input', () => { $('lib-count').textContent = libWords().length + ' words'; });
    $('btn-lib-import').addEventListener('click', () => $('lib-file').click());
    $('lib-file').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!f) return;
      const r = new FileReader();
      r.onload = (ev) => {
        $('lib-words').value = String(ev.target.result || '');
        if (!$('lib-name').value) $('lib-name').value = f.name.replace(/\.txt$/i, '').slice(0, 40);
        $('lib-count').textContent = libWords().length + ' words';
      };
      r.readAsText(f);
    });
    $('btn-lib-signin').addEventListener('click', () => {
      $('modal-library').style.display = 'none';
      window.MiviAccount.openAuth();
    });

    buildOptionHelp();
    gateComboLock();
    window.addEventListener('resize', () => requestAnimationFrame(fitCanvas));
    $('btn-lobby-friends').addEventListener('click', () => window.MiviAccount.openAccount('friends'));
    $('invite-join').addEventListener('click', acceptInvite);
    $('invite-dismiss').addEventListener('click', hideInviteToast);

    startRoomsPoll();
  });

  window.MiviApp = {
    toast,
    // Used by the list library: can the current player drop a list into a room?
    canAddRoomList: () => !!roomCode && !!gameState && gameState.state === 'lobby' && gameState.host === myId && !gameState.managed,
    addRoomList: (name, text) => { if (socket) socket.emit('addCustomList', { name, text }); },
    inRoom: () => !!roomCode,
    inviteFriend: (userId) => { if (socket && roomCode) socket.emit('inviteFriend', { userId }); },
  };
})();
