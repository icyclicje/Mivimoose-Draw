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
  let gameFrames = [];             // one snapshot per finished round, for the GIF
  // Words we just sent up, kept until the server confirms the list so the
  // device copy is only written for lists that actually took.
  const pendingListWords = {};
  let gifJustSaved = false;        // don't bin the frames the instant a new game starts
  let relayHolderId = null;        // in relay mode, the artist holding the pen
  let blindWord = null;            // blind relay: the blanks we draw from
  let roundClockStart = 0;         // when the drawing phase began (wall clock)
  let roundFirstGuesser = null;    // who got it first this round
  let firstGuessTally = {};        // name -> how many rounds they got in first
  let lastFinalScores = null;      // for the GIF's closing card
  let canvasLocked = false;
  let activityMode = false;        // running inside a Discord voice channel
  let activityCtx = null;          // { instanceId, channelId, guildId, … }
  let presenceAllowed = false;     // did Discord grant rpc.activities.write?
  let presenceStartedAt = 0;       // when this player joined, for the presence timer
  let activityClientId = null;     // needed to retry sign-in from the account modal
  let uiBusyUntil = 0;             // don't rebuild lobby panels while they're being used

  // Skip expensive re-renders for a moment after the host touches a control.
  function markUiBusy(ms) { uiBusyUntil = Date.now() + (ms || 900); }

  // Round-end snapshot
  let snap = null; // {dataUrl, word, artist, guessedCount, playerCount, likes, savedToGallery}

  // Drawing state
  const CANVAS_W = 1000, CANVAS_H = 750;
  const CANVAS_SCALE = 2;   // backing-store multiplier — see setupCanvas()
  let ctx, pctx;
  let canvasBg = '#ffffff';   // wire value for eraser events (receivers use their own paper)
  let bgStyle = '#ffffff';    // what we actually paint the paper with (colour or CanvasPattern)
  let bgKind = 'plain';
  // Stroke smoothing: how fast the pen catches up to the cursor (1 = instant),
  // and the smallest move worth drawing.
  const SMOOTHING = 0.55;
  const MIN_STEP_SQ = 0.6 * 0.6;
  let smoothX = 0, smoothY = 0;
  let sceneId = null;         // backdrop chosen for this round (null = plain paper)
  let bgSceneId = null;       // which backdrop bgStyle was built from

  // The paper is baked into the canvas, so it lands in downloads and the GIF
  // too. The eraser paints with this same style, which restores the pattern
  // exactly (patterns are anchored to the canvas origin).
  function makeBgStyle(kind) {
    if (kind === 'plain' || !ctx) return '#ffffff';
    const tile = document.createElement('canvas');
    const S = 40;
    tile.width = tile.height = S;
    const c = tile.getContext('2d');
    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, S, S);
    if (kind === 'grid') {
      c.strokeStyle = '#dde3ef'; c.lineWidth = 1;
      c.beginPath(); c.moveTo(0.5, 0); c.lineTo(0.5, S); c.moveTo(0, 0.5); c.lineTo(S, 0.5); c.stroke();
    } else if (kind === 'dots') {
      c.fillStyle = '#ccd4e4';
      c.beginPath(); c.arc(S / 2, S / 2, 2, 0, Math.PI * 2); c.fill();
    } else if (kind === 'lined') {
      c.strokeStyle = '#e2e8f3'; c.lineWidth = 1;
      c.beginPath(); c.moveTo(0, S - 0.5); c.lineTo(S, S - 0.5); c.stroke();
    }
    return ctx.createPattern(tile, 'repeat') || '#ffffff';
  }

  function syncCanvasBackground() {
    const opts = (gameState && gameState.options) || {};
    const wantScene = opts.sceneBackgrounds ? sceneId : null;
    if (wantScene && window.MiviScenes && window.MiviScenes.has(wantScene)) {
      if (bgSceneId === wantScene) return;
      // A full-size, non-repeating pattern: the eraser paints with this too,
      // so rubbing something out puts the backdrop back exactly.
      const sc = document.createElement('canvas');
      sc.width = CANVAS_W;
      sc.height = CANVAS_H;
      const scx = sc.getContext('2d');
      scx.fillStyle = '#ffffff';
      scx.fillRect(0, 0, CANVAS_W, CANVAS_H);
      window.MiviScenes.draw(scx, wantScene, CANVAS_W, CANVAS_H);
      bgStyle = (ctx && ctx.createPattern(sc, 'no-repeat')) || '#ffffff';
      bgSceneId = wantScene;
      bgKind = null;
      return;
    }
    if (bgKind !== 'plain' || bgSceneId !== null) {
      bgKind = 'plain';
      bgSceneId = null;
      bgStyle = makeBgStyle('plain');
    }
  }

  // ── Backdrop picker ──
  function buildSceneGrid() {
    const grid = $('scene-grid');
    if (!grid || grid.dataset.built === '1' || !window.MiviScenes) return;
    grid.dataset.built = '1';

    const addCard = (id, name, painter) => {
      const card = el('div', 'scene-card');
      card.dataset.scene = id === null ? '' : id;
      const thumb = document.createElement('canvas');
      thumb.width = 200;
      thumb.height = 150;
      painter(thumb.getContext('2d'));
      card.appendChild(thumb);
      card.appendChild(el('span', 'sn', name));
      card.addEventListener('click', () => {
        socket.emit('setScene', { id });
        $('modal-scenes').style.display = 'none';
        sfx('pop');
      });
      grid.appendChild(card);
    };

    addCard(null, 'No backdrop', (c) => {
      c.fillStyle = '#ffffff';
      c.fillRect(0, 0, 200, 150);
      c.strokeStyle = '#c9d2e3';
      c.lineWidth = 3;
      c.beginPath();
      c.moveTo(30, 120); c.lineTo(170, 30);
      c.stroke();
    });
    for (const s of window.MiviScenes.list()) {
      addCard(s.id, s.emoji + ' ' + s.name, (c) => window.MiviScenes.draw(c, s.id, 200, 150));
    }
  }

  function openScenePicker() {
    buildSceneGrid();
    document.querySelectorAll('#scene-grid .scene-card').forEach(c => {
      c.classList.toggle('active', c.dataset.scene === (sceneId || ''));
    });
    $('modal-scenes').style.display = 'flex';
  }
  let currentTool = 'pen';
  let currentColor = '#111111';
  let brushSize = 6;
  let drawing = false;
  let lastX = 0, lastY = 0;
  let shape = null; // {x1,y1}
  let midX = 0, midY = 0;   // running midpoint for smoothed strokes
  let strokeEvents = [];

  const SIZES = [3, 6, 10, 16, 26, 38];
  // Two rows: a bold tone on top, its lighter sibling underneath.
  // Three rows: neutrals, then a full hue wheel at a strong value, then the
  // same hues light. Every hue you would reach for is one click away, and the
  // light row covers skin, sky and pastel fills that the old palette missed.
  const PALETTE = [
    '#000000', '#4a4a4a', '#9e9e9e', '#d6d6d6', '#ffffff',
    '#7c2d12', '#b45309', '#a16207', '#4d7c0f', '#065f46',
    '#0e7490', '#1d4ed8', '#4338ca', '#6d28d9', '#a21caf',

    '#dc2626', '#ea580c', '#f59e0b', '#eab308', '#84cc16',
    '#22c55e', '#10b981', '#14b8a6', '#06b6d4', '#3b82f6',
    '#6366f1', '#8b5cf6', '#a855f7', '#d946ef', '#ec4899',

    '#fca5a5', '#fdba74', '#fcd34d', '#fde68a', '#bef264',
    '#86efac', '#6ee7b7', '#5eead4', '#a5f3fc', '#93c5fd',
    '#c7d2fe', '#ddd6fe', '#e9d5ff', '#f5d0fe', '#fbcfe8',
  ];
  const EMOJIS = ['🎨','🦌','🐱','🐶','🦊','🐻','🐼','🐸','🐙','🦄','🐝','🦖','🐢','🐧','🦉','🐳','🍕','🌵','👻','🤖','👽','🧙','🥷','🦩','🗿','🦆','🐌','🫠','🤡','💀','🐔','🦥','🧌','🥸','🫡','🐊'];
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

  // A player's bubble: their Discord picture when we have one, otherwise the
  // emoji avatar they picked.
  function avatarNode(p, className) {
    const node = document.createElement('span');
    node.className = className || 'p-avatar';
    if (p && p.avatarUrl) {
      node.classList.add('has-photo');
      const img = document.createElement('img');
      img.src = p.avatarUrl;
      img.alt = '';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      // If the picture will not load, fall back to the emoji rather than a gap.
      img.onerror = () => {
        node.classList.remove('has-photo');
        node.textContent = (p.avatar && p.avatar.emoji) || '🎨';
        node.style.background = ((p.avatar && p.avatar.color) || '#6C5CE7') + '33';
      };
      node.appendChild(img);
    } else {
      node.textContent = (p && p.avatar && p.avatar.emoji) || '🎨';
      node.style.background = ((p && p.avatar && p.avatar.color) || '#6C5CE7') + '33';
    }
    return node;
  }

  function el(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function sfx(name) { try { Audio.sfx(name); } catch (e) {} }

  function myName() { return ($('home-name').value || '').trim() || API.lsGet('mivi_name') || ''; }
  // Signed in? Your account name is your name — the box follows it unless
  // you have deliberately typed something else this session.
  let nameTouched = false;
  function syncNameFromAccount() {
    const acct = window.MiviAccount;
    const box = $('home-name');
    if (!box || !acct || !acct.isLoggedIn()) return;
    const username = acct.user() && acct.user().username;
    if (!username) return;
    if (nameTouched && box.value.trim() && box.value.trim() !== username) return;
    box.value = username;
    API.lsSet('mivi_name', username);
  }

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
    document.body.classList.toggle('in-game', id === 'screen-game');
    if (activityMode) scheduleActivityLayout();
    const onHome = id === 'screen-home';
    if (onHome) startRoomsPoll(); else stopRoomsPoll();
    if (id !== 'screen-game') exitFocusMode();
  }

  // ── Socket ──
  function connectSocket() {
    if (socket) { socket.removeAllListeners(); socket.disconnect(); }
    socketToken = API.token();
    // Inside an Activity the websocket has to go through Discord's proxy too.
    const sockPath = API.proxyPrefix() + '/socket.io';
    socket = io({
      path: sockPath,
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
      } else if (activityMode && !roomCode) {
        // Deliberately nothing: the activity opens on the home screen so the
        // player can pick the channel game, a public match, or their own room.
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

    socket.on('roomCreated', ({ code, state }) => {
      enterRoom(code, state);
      // Your last setup follows the browser, so a new room starts the way
      // you like it rather than at the defaults every time.
      applyRememberedOptions();
    });
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
      // A fresh game clears last game's GIF material — not the trip back to
      // the lobby, where people still want to save it.
      if ((state.round || 1) === 1 && gameFrames.length && !gifJustSaved) {
        gameFrames = [];
        firstGuessTally = {};
        lastFinalScores = null;
      }
      gifJustSaved = false;
      roomToGameScreen();
      guessedSet = new Set();
      hasGuessed = false;
      myLockedPart = null;
      voteSkipUsed = false;
      likeUsed = false;
      snap = null;
      curWordSource = null;
      curWordSource2 = null;
      sceneId = null;
      hideOverlay('overlay-roundend');
      roundColor = null;
      strokeBudget = null;
      clearModeOverlays();
      applyRoundColor();
      renderModeBanner();
      phaseTotal = state.options.pickTime || 20;
      setTimer(state.timeLeft ?? 20);
      $('overlay-choice').style.display = 'none';
      clearCanvasLocal();
      setArtistMode(false);
      $('game-chat').textContent = '';
      updateLikeSkipUI();

      const amPicker = state.wordPickerId === myId;
      const amArtist = state.drawerId === myId || state.coopPartnerId === myId;
      // With word choices set to 0 the server deals a word straight away, so
      // there is no picking phase to show anybody.
      if (state.autoWord) {
        $('overlay-choosing').style.display = 'none';
        $('overlay-choice').style.display = 'none';
      } else if (!amArtist && !amPicker) {
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
      sceneId = state.scene || null;
      syncCanvasBackground();
      roundClockStart = Date.now();
      roundFirstGuesser = null;
      setCanvasLocked(false);
      renderRelayBar(null);
      roundColor = state.roundColor || null;
      strokeBudget = state.strokeLimit > 0 ? { used: 0, limit: state.strokeLimit } : null;
      clearModeOverlays();
      if (state.dryLine !== null && state.dryLine !== undefined) renderDryLine(state.dryLine);
      if (state.tilesOpen) renderShutters(state.tilesOpen, []);
      applyRoundColor();
      renderModeBanner();
      phaseTotal = state.roundSeconds || state.options.roundTime;
      setTimer(state.timeLeft);
      syncFinishButton();
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
        // The clock gets louder as it runs out: one warning chime, then a
        // steady tick, then an urgent countdown for the last five seconds.
        if (timeLeft === 30) {
          sfx('timeLow');
          try { Audio.duck(1.4); } catch (e) {}
        } else if (timeLeft <= 5 && timeLeft > 0) {
          sfx('countdown');
          try { Audio.duck(1.2); } catch (e) {}
        } else if (timeLeft <= 10 && timeLeft > 0) {
          sfx('tick');
          try { Audio.duck(1.2); } catch (e) {}
        }
      }
      $('timer-wrap').classList.toggle('urgent', timeLeft <= 10 && timeLeft > 0);
    });

    // The relay baton moved (or ticked down a second).
    socket.on('relayTurn', (info) => {
      const wasMine = relayHolderId === myId;
      renderRelayBar(info);
      if (info && info.holderId === myId && !wasMine) sfx('yourTurn');
    });

    // Blind relay: we are drawing, but nobody is telling us what. All we get
    // is the same row of blanks the guessers see.
    socket.on('blindArtist', ({ maskedWord }) => {
      blindWord = maskedWord || null;
      if (blindWord) {
        renderWordTiles(blindWord);
        setWordMetaText('you are drawing blind — follow your partner');
      }
    });

    socket.on('dryLine', ({ x }) => renderDryLine(x));

    socket.on('tilesOpen', ({ open, justOpened }) => {
      const before = openTiles ? openTiles.size : 0;
      renderShutters(open, justOpened);
      if (open && open.length > before && !isArtist) sfx('pop');
    });

    // The server refused a mark — say why rather than leaving them puzzled.
    socket.on('drawBlocked', ({ reason }) => {
      const said = {
        dry: 'That part has dried — you can only paint ahead of the line.',
        dryUndo: "That stroke has set. You can't take it back now.",
        dryClear: "The paint has started setting — you can't clear it.",
        dryScene: 'Too late for a backdrop — pick one before the paint sets.',
      }[reason];
      if (said) toast('🖌️ ' + said);
    });

    socket.on('strokeBudget', (b) => {
      strokeBudget = b;
      renderModeBanner();
      if (b.limit > 0 && b.used >= b.limit) toast('✏️ That was your last stroke.');
    });

    socket.on('poll', (poll) => {
      const had = !!currentPoll;
      renderPoll(poll);
      if (poll && !had) sfx('pop');
    });

    // Somebody else is typing — show it as a ghost on the preview layer.
    socket.on('textPreview', ({ x, y, text, color, size }) => {
      if (!pctx || isArtist) return;
      pctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
      if (!text) return;
      pctx.save();
      pctx.font = `800 ${Math.round((size || 6) * 3 + 14)}px 'Plus Jakarta Sans', system-ui, sans-serif`;
      pctx.fillStyle = color || '#111111';
      pctx.textBaseline = 'middle';
      pctx.textAlign = 'left';
      pctx.globalAlpha = 0.45;
      pctx.fillText(String(text).slice(0, 40), x, y);
      pctx.restore();
    });

    socket.on('canvasLocked', ({ by }) => {
      setCanvasLocked(true);
      flashLock(by);
      sfx('lock');
    });

    socket.on('sceneSet', ({ id, history }) => {
      sceneId = id || null;
      syncCanvasBackground();
      // Repaint the backdrop, then put the drawing back on top of it.
      clearCanvasLocal();
      if (Array.isArray(history)) history.forEach(applyDraw);
      closeTextInput();
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

    socket.on('closeGuess', ({ combo, part } = {}) => {
      let msg = "🔥 So close — check the spelling!";
      if (combo) {
        msg = part === 0 ? '🔥 That is almost the FIRST word!'
          : part === 1 ? '🔥 That is almost the SECOND word!'
          : '🔥 One half of it is nearly right!';
      }
      showCloseBar(msg);
      sfx('close');
    });

    socket.on('correctGuess', ({ playerId, playerName, points, autocorrected, correctedWord, typedWord, scores }) => {
      sfx('correct');
      const wasMe = playerId === myId;
      const alreadyGuessed = guessedSet.has(myId);
      if (!roundFirstGuesser) {
        roundFirstGuesser = playerName;
        firstGuessTally[playerName] = (firstGuessTally[playerName] || 0) + 1;
      }
      guessedSet.add(playerId);
      if (wasMe) {
        hasGuessed = true;
        confetti(60);
        toast(autocorrected ? `🎉 Close enough! +${points}` : `🎉 Correct! +${points}`);
        $('game-chat-input').placeholder = 'Chat with others who guessed…';
      }
      const canSeeWord = autocorrected && correctedWord && (wasMe || isArtist || alreadyGuessed);
      // The artist knows the word already; what they cannot see is the near
      // miss that got accepted, so show them that instead.
      const note = !autocorrected ? ''
        : (isArtist && typedWord) ? `(autocorrected from "${typedWord}") `
        : canSeeWord ? `(autocorrected → "${correctedWord}") `
        : '(autocorrected) ';
      addAnyChat({
        playerId, playerName, correct: true,
        text: `guessed it! ${note}(+${points})`,
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
      addAnyChat({ system: true, text: `❤️ ${playerName || 'Someone'} liked the drawing` });
      // A little nudge for the artist, who is the one being complimented.
      if (isArtist || wasArtistThisRound) {
        toast(`❤️ ${playerName || 'Someone'} liked your drawing!`);
        const btn = $('btn-like');
        if (btn) { btn.classList.remove('pop'); void btn.offsetWidth; btn.classList.add('pop'); }
      }
    });

    socket.on('roundEnd', (payload) => {
      if (gameState) gameState.state = 'roundEnd'; // so chat isn't routed as a dead guess
      syncHostGameButtons();
      wasArtistThisRound = isArtist;
      setCanvasLocked(false);
      renderRelayBar(null);
      roundColor = null;
      strokeBudget = null;
      clearModeOverlays();
      applyRoundColor();
      renderModeBanner();
      syncFinishButton();
      sfx('roundEnd');
      showRoundEnd(payload);
      setArtistMode(false);
      hasGuessed = false;
      $('game-chat-input').placeholder = 'Type your guess…';
      renderWordTiles(payload.word, { revealed: true });
    });

    socket.on('gameEnd', ({ finalScores }) => {
      if (gameState) gameState.state = 'gameEnd';
      syncHostGameButtons();
      hideOverlay('overlay-roundend');
      sfx('gameOver');
      confetti(160);
      showGameEnd(finalScores);
    });

    socket.on('backToLobby', (state) => {
      closeGameSettings();
      gameState = state;
      // Keep the frames, the tally and the scores: the end-of-game screen
      // only sticks around a few seconds and people want the GIF after they
      // have finished reading the table.
      syncLobbyGifButton();
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

    socket.on('roomListsReady', ({ url, filename, count, bytes }) => {
      const btn = $('btn-zip-lists');
      clearTimeout(btn._h);
      btn.disabled = false;
      btn.textContent = '⬇️ Download all';
      const a = document.createElement('a');
      a.href = API.assetUrl(url);
      a.download = filename;
      a.click();
      const kb = Math.max(1, Math.round(bytes / 1024));
      toast(`📦 ${count} list${count === 1 ? '' : 's'} zipped (${kb} KB)`);
      sfx('save');
    });

    socket.on('customListRenamed', ({ to }) => toast(`✏️ Renamed to "${to}"`));
    socket.on('customListRemoved', ({ name }) => {
      toast(`🗑️ Removed "${name}"`);
      uiBusyUntil = 0;                    // let the repaint through immediately
      refreshGameSettingsPanels();
      if (gameState && gameState.wordLists) renderWordLists(gameState.wordLists);
    });

    socket.on('customListRenamed', ({ name, newName }) => {
      toast(`✏️ "${name}" is now "${newName}"`);
      uiBusyUntil = 0;
      refreshGameSettingsPanels();
      if (gameState && gameState.wordLists) renderWordLists(gameState.wordLists);
    });

    socket.on('customListAdded', ({ name, count }) => {
      // Keep a copy on this device so it is one click away next time,
      // whichever account is signed in.
      if (pendingListWords[name]) {
        rememberList(name, pendingListWords[name]);
        delete pendingListWords[name];
      }
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
    $('btn-leave').style.display = 'inline-block';
    $('room-pill-code').textContent = code;
    $('gt-code').textContent = code;
    syncHostGameButtons();
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
        sceneId = state.scene || null;
        syncCanvasBackground();
        setCanvasLocked(!!state.canvasLocked);
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
    const main = $('main');
    if (!$('screen-game').classList.contains('active')) {
      frame.style.removeProperty('--canvas-max');
      main.style.removeProperty('height');
      return;
    }
    // In fullscreen the flex/aspect-ratio rules already size the canvas to
    // the space left over beside the panels — don't fight them.
    if (document.body.classList.contains('focus-mode')) {
      frame.style.removeProperty('--canvas-max');
      return;
    }
    const card = $('canvas-card');
    const toolbar = $('toolbar');
    const z = uiZoom();
    // Pin the page height in real pixels: 100dvh inside a zoomed body is
    // browser-dependent, and it kept leaving a dead band at the bottom.
    const vhL = ((window.visualViewport && window.visualViewport.height) || window.innerHeight) / z;
    main.style.height = Math.floor(vhL) + 'px';
    const cs = getComputedStyle(card);
    const rowGap = parseFloat(cs.rowGap) || 10;

    // Everything in the canvas column that is not the canvas itself: the
    // card's padding and border, plus the toolbar / mode banner / finish
    // button whenever they are shown.
    let chrome = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0) + 2;
    for (const el of [$('mode-banner'), $('btn-finish-drawing'), toolbar]) {
      if (el && el.style.display !== 'none' && el.offsetHeight) chrome += el.offsetHeight + rowGap;
    }
    const chromeX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0) + 2;

    let availH;
    if (window.innerWidth / z >= 1081) {
      // On desktop the card runs from under the word bar to the bottom of
      // the screen (the grid stretches it), so its own height is the whole
      // budget — the canvas gets all of it minus the chrome.
      availH = card.getBoundingClientRect().height / z - chrome;
    } else {
      // Stacked layouts size the card by its content, so asking the card
      // would be circular — measure down from the viewport instead.
      const top = card.getBoundingClientRect().top;   // viewport (zoomed) px
      const vh = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
      availH = (vh - top) / z - chrome - 8;
    }
    const byHeight = Math.floor(Math.max(240, availH) * 4 / 3);

    // Let the grid hand the middle column enough width for that height —
    // squeezing the side panels toward their minimums if that is what it
    // takes — then fit the canvas into whatever the column actually got.
    const middle = balanceGameGrid(byHeight + chromeX);
    const byWidth = (middle != null ? middle : card.clientWidth) - chromeX;
    frame.style.setProperty('--canvas-max', Math.max(320, Math.min(byHeight, byWidth)) + 'px');

    if (toolbar.style.display !== 'none') {
      const h0 = toolbar.offsetHeight;
      requestAnimationFrame(() => { if (toolbar.offsetHeight > h0) fitCanvas(); });
    }
  }

  // The canvas is locked to 4:3 (the drawing coordinate space is 1000x750)
  // and it owns the middle of the screen: the middle column is sized FIRST,
  // big enough for a canvas that runs from the word bar down to the toolbar,
  // taking width back from the side panels when it must. Only what is left
  // over goes to the players list and the chat.
  const SIDE_MIN_PLAYERS = 160;
  const SIDE_MIN_CHAT = 220;
  const SIDE_BASE_PLAYERS = 200;
  const SIDE_BASE_CHAT = 280;
  const SIDE_MAX_PLAYERS = 260;
  const SIDE_MAX_CHAT = 360;

  // Returns the middle column's width in layout px, or null when the grid
  // is stacked / fullscreen and CSS is in charge.
  function balanceGameGrid(needW) {
    const grid = $('game-grid');
    if (!grid) return null;
    // Narrow layouts stack, and fullscreen has its own rules — leave both be.
    if (window.innerWidth / uiZoom() < 1081 || document.body.classList.contains('focus-mode')) {
      grid.style.removeProperty('grid-template-columns');
      return null;
    }
    const total = grid.clientWidth;
    if (!total) return null;
    const gap = parseFloat(getComputedStyle(grid).columnGap) || 12;
    const usable = total - gap * 2;

    // The canvas column gets what it asked for, down to the panels' floor…
    const middle = Math.max(320, Math.min(needW, usable - SIDE_MIN_PLAYERS - SIDE_MIN_CHAT));
    const spare = usable - middle - SIDE_MIN_PLAYERS - SIDE_MIN_CHAT;

    // …then the panels climb back toward their comfortable sizes — but
    // both are capped now, so any width beyond that stays with the canvas
    // column and becomes breathing room around the drawing.
    let players = SIDE_MIN_PLAYERS + Math.min(SIDE_BASE_PLAYERS - SIDE_MIN_PLAYERS, spare * 0.45);
    let chat = SIDE_MIN_CHAT + Math.min(SIDE_BASE_CHAT - SIDE_MIN_CHAT, spare * 0.55);
    const left = spare - (players - SIDE_MIN_PLAYERS) - (chat - SIDE_MIN_CHAT);
    if (left > 0) {
      const growP = Math.min(Math.max(0, SIDE_MAX_PLAYERS - players), left * 0.4);
      players += growP;
      chat += Math.min(Math.max(0, SIDE_MAX_CHAT - chat), left - growP);
    }
    players = Math.round(players);
    chat = Math.round(chat);
    grid.style.gridTemplateColumns = `${players}px minmax(0, 1fr) ${chat}px`;
    return usable - players - chat;
  }

  function resetGameGrid() {
    const grid = $('game-grid');
    if (grid) grid.style.removeProperty('grid-template-columns');
  }

  function leaveToHome(emitLeave = true) {
    resetGameGrid();
    if (emitLeave && socket && roomCode) socket.emit('leaveRoom');
    roomCode = null;
    gameState = null;
    API.lsDel('mivi_room');
    $('room-pill').style.display = 'none';
    $('btn-leave').style.display = 'none';
    $('btn-endgame').style.display = 'none';
    $('btn-gamesettings').style.display = 'none';
    closeGameSettings();
    gameFrames = [];
    hideOverlay('overlay-roundend');
    hideOverlay('overlay-gameend');
    $('overlay-choice').style.display = 'none';
    $('overlay-choosing').style.display = 'none';
    showScreen('screen-home');
    // Apply a sign-in/out that happened while we were seated in a room.
    if (API.token() !== socketToken) connectSocket();
    fetchRooms();
  }

  // The host's in-game controls only make sense while a game is running.
  function syncHostGameButtons() {
    const s = gameState;
    const isHost = !!(s && s.host === myId && !s.managed);
    const playing = !!(s && s.state !== 'lobby');
    $('btn-endgame').style.display = (isHost && playing && s.state !== 'gameEnd') ? 'inline-block' : 'none';
    $('btn-gamesettings').style.display = (isHost && playing) ? 'flex' : 'none';
    $('gt-endgame').style.display = (isHost && playing && s.state !== 'gameEnd') ? 'flex' : 'none';
    $('gt-settings').style.display = (isHost && playing) ? 'flex' : 'none';
  }

  function refreshRoomUI() {
    if (!gameState) return;
    syncHostGameButtons();
    pushPresence();
    renderActivityNote();
    if (gameState.state === 'lobby' && $('screen-lobby').classList.contains('active')) {
      updateLobby();
    } else if ($('screen-game').classList.contains('active')) {
      guessedSet = new Set(gameState.players.filter(p => p.guessed).map(p => p.id));
      updatePlayers();
      updateRoundPill();
      refreshGameSettingsPanels();
    }
  }

  // Mid-game, #words-panel and #options-panel are moved into the settings
  // modal. updateLobby() is the only thing that repaints them and it does not
  // run in-game, so they are repainted here instead.
  function refreshGameSettingsPanels() {
    if (!settingsMoved || !gameState) return;
    if (Date.now() > uiBusyUntil) renderWordLists(gameState.wordLists);
    syncOptions(gameState.options);
    $('gs-toggle-public').checked = !!gameState.public;
    renderDeviceLists();
  }

  // ── Home / public rooms ──
  // "24 people playing in 6 rooms" — counts every room, listed or not.
  function renderOnlineTotals(totals) {
    const strip = $('online-strip');
    if (!strip) return;
    const box = $('online-text');
    const people = (totals && totals.players) || 0;
    strip.style.display = 'inline-flex';
    strip.classList.toggle('quiet', people === 0);
    box.textContent = '';
    if (!people) {
      box.textContent = 'Nobody playing yet — start one';
      return;
    }
    // One number, said plainly. The room browser below has the detail.
    const n = document.createElement('b');
    n.textContent = String(people);
    box.appendChild(n);
    box.appendChild(document.createTextNode(people === 1 ? ' person playing' : ' people playing'));
    strip.title = (totals.rooms || 0) + (totals.rooms === 1 ? ' room' : ' rooms')
      + (totals.playing ? ' · ' + totals.playing + ' mid-game' : '');
  }
  async function fetchRooms() {
    try {
      const data = await API.publicRooms();
      renderOnlineTotals(data.totals);
      const list = $('rooms-list');
      list.textContent = '';
      if (!data.rooms.length) {
        list.appendChild(el('div', 'rooms-empty', 'No public rooms right now — start one with Play Online!'));
        return;
      }
      for (const r of data.rooms) {
        const row = el('div', 'room-row');
        row.appendChild(el('span', 'rr-name', r.name));
        row.appendChild(el('span', 'rr-state' + (r.state === 'lobby' ? '' : ' playing'), r.state === 'lobby' ? 'waiting' : (r.totalRounds > 0 ? `round ${r.round}/${r.totalRounds}` : `round ${r.round}`)));
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
    // Connected players, with a quiet note when someone is mid-reconnect.
    const connected = s.players.filter(p => p.connected !== false).length;
    $('lobby-count').textContent = connected === s.players.length
      ? `${connected}/${s.options.maxPlayers}`
      : `${connected}/${s.options.maxPlayers} · ${s.players.length - connected} away`;
    renderPlayerCount();

    const grid = $('lobby-players');
    grid.textContent = '';
    for (const p of s.players) {
      const chip = el('div', 'p-chip' + (p.id === s.host ? ' host' : '') + (p.connected ? '' : ' dc'));
      chip.appendChild(avatarNode(p, 'p-avatar'));
      const chipName = el('span', 'nm', p.name + (p.id === myId ? ' (you)' : ''));
      chipName.title = p.name;
      chip.appendChild(chipName);
      if (p.id === s.host) chip.appendChild(el('span', null, '👑'));
      if (p.mod) {
        const m = el('span', 'mod-chip', 'M');
        m.title = 'Moderator';
        chip.appendChild(m);
      }
      if (isHost && p.id !== myId) {
        const kick = el('button', 'kick', '✕');
        kick.title = 'Kick';
        kick.onclick = () => socket.emit('kickPlayer', { playerId: p.id });
        chip.appendChild(kick);
      }
      grid.appendChild(chip);
    }

    syncHostGameButtons();
    document.querySelector('.lobby-grid').classList.toggle('guest', !isHost);
    $('public-toggle-row').style.display = isHost ? 'flex' : 'none';
    $('btn-lobby-friends').style.display = window.MiviAccount.isLoggedIn() ? 'block' : 'none';
    if (activityMode) {
      // In a channel game the room code is noise — Discord's own invite is
      // what people actually want.
      const inChannelGame = !!s.activity;
      $('btn-copy-invite').textContent = inChannelGame ? '📣 Invite to the channel' : '🔗 Invite link';
      // Anyone can break off into their own room, and get back afterwards.
      $('btn-activity-custom').style.display = 'block';
      $('btn-activity-back').style.display = inChannelGame ? 'none' : 'block';
      renderActivityNote();
    }
    $('toggle-public').checked = !!s.public;
    syncLobbyGifButton();
    syncAiPanel();
    const voteList = $('btn-vote-list');
    if (voteList) voteList.style.display = s.managed ? 'inline-block' : 'none';
    $('btn-start').style.display = isHost ? 'flex' : 'none';
    // A moderator can start a private room alone to test it — say so, rather
    // than letting the button look like it will just refuse.
    const meRow = (s.players || []).find(p => p.id === myId);
    const soloOk = !!(meRow && meRow.mod) && !s.managed
      && (s.players || []).filter(p => p.connected).length < 2;
    $('btn-start').textContent = soloOk ? '🚀 Start Game (solo test)' : '🚀 Start Game';
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
      // Rebuilding these while a slider is being dragged is what made the
      // controls feel laggy — skip it until the host stops fiddling.
      if (Date.now() > uiBusyUntil) renderWordLists(s.wordLists);
      syncOptions(s.options);
      renderMyLists();
      renderDeviceLists();
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
      ['Pens down', o.lockOnGuess ? 'On' : 'Off'],
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
    markUiBusy();
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
    if (wl) wlCacheSave(roomCode, wl);
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
      // Only the tickable part is a <label>. The buttons used to live inside
      // it too, which overflowed the row and let the label swallow clicks —
      // they get their own row now.
      const top = el('label', 'wl-top');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = info.name;
      cb.checked = checked;
      top.appendChild(cb);
      const nameEl = el('span', 'wl-name', info.label || info.name);
      nameEl.title = info.label || info.name;
      top.appendChild(nameEl);
      if (info.custom) top.appendChild(el('span', 'wl-badge', 'CUSTOM'));
      item.appendChild(top);

      const meta = el('div', 'wl-meta');
      meta.appendChild(el('span', 'cnt', info.count + (info.count === 1 ? ' word' : ' words')));
      // How often the next word comes from this list — filled in by
      // renderListOddsNow so it tracks the ticks and weights live.
      const oddsPill = el('span', 'wl-odds');
      oddsPill.dataset.list = info.name;
      meta.appendChild(oddsPill);
      const actions = el('span', 'wl-actions');
      // Your own contribution (or a built-in) opens for reading; a list a
      // room-mate added stays theirs, crown or no crown.
      const mineToRead = !info.custom || info.owner === myId;
      if (mineToRead) {
        const infoBtn = el('button', 'wl-info', 'ℹ️');
        infoBtn.title = 'See every word in ' + (info.label || info.name);
        infoBtn.onclick = async (e) => {
          e.preventDefault();
          e.stopPropagation();
          try {
            const ws = await roomListWords(info.name);
            openWordsModal(info.label || info.name, ws);
          } catch (err) { toast('❌ ' + err.message); }
        };
        actions.appendChild(infoBtn);
      }
      meta.appendChild(actions);
      item.appendChild(meta);

      if (info.custom && info.owner === myId) {
        const ex2 = el('button', 'wl-export', '⬇️');
        ex2.title = 'Export as .txt';
        ex2.onclick = (e) => { e.preventDefault(); socket.emit('exportCustomList', { name: info.name }); };
        actions.appendChild(ex2);

        const keep2 = el('button', 'wl-keep', '📥');
        keep2.title = 'Save this list to my account';
        keep2.onclick = async (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (!window.MiviAccount.isLoggedIn()) { toast('📚 Sign in to keep lists on your account.'); return; }
          keep2.disabled = true;
          try {
            const ws = await roomListWords(info.name);
            if (!ws.length) throw new Error('That list came back empty.');
            await API.createList(info.name, ws);
            toast(`📥 "${info.name}" saved to your lists`);
            renderMyLists();
            window.MiviAccount.refreshLists();
          } catch (err) { toast('❌ ' + err.message); }
          finally { keep2.disabled = false; }
        };
        actions.appendChild(keep2);
      }
      if (info.custom) {
        const ren = el('button', 'wl-rename', '✏️');
        ren.title = 'Rename this list';
        ren.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          markUiBusy(8000);
          const inp = document.createElement('input');
          inp.className = 'wl-name-input';
          inp.value = info.name;
          inp.maxLength = 40;
          let finished = false;
          const finish = (save) => {
            if (finished) return;           // blur fires again after Enter
            finished = true;
            const v = inp.value.trim();
            if (inp.parentNode) inp.replaceWith(nameEl);
            uiBusyUntil = 0;
            if (save && v && v !== info.name) {
              nameEl.textContent = v;       // show it straight away
              socket.emit('renameCustomList', { name: info.name, newName: v });
            }
          };
          inp.addEventListener('keydown', (ev) => {
            ev.stopPropagation();
            if (ev.key === 'Enter') finish(true);
            else if (ev.key === 'Escape') finish(false);
          });
          inp.addEventListener('blur', () => finish(true));
          nameEl.replaceWith(inp);
          inp.focus();
          inp.select();
        };
        actions.appendChild(ren);


        const rm = el('button', 'wl-remove', '🗑️');
        rm.title = 'Remove this list from the room';
        rm.onclick = async (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (!await MiviDialog.confirm(`Remove "${info.name}" from this room?`, { confirmLabel: 'Remove', danger: true })) return;
          markUiBusy(0);
          socket.emit('removeCustomList', { name: info.name });
        };
        actions.appendChild(rm);
      }

      const wrow = el('div', 'wl-weight');
      wrow.appendChild(el('span', 'wl-weight-label', 'Weight'));
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = '1'; slider.max = '10'; slider.value = String(weight);
      slider.disabled = !checked;
      wrow.appendChild(slider);
      const wv = el('span', 'wv', String(weight));
      wrow.appendChild(wv);
      item.appendChild(wrow);

      slider.addEventListener('pointerdown', () => markUiBusy(4000));
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
  let oddsFrame = null;
  function renderListOdds() {
    if (oddsFrame) return;              // at most one rebuild per frame
    oddsFrame = requestAnimationFrame(() => { oddsFrame = null; renderListOddsNow(); });
  }

  // 12.5% reads better than 13% at the low end, and 40% better than 40.0%.
  function fmtPct(pct) {
    return pct.toFixed(pct < 10 ? 1 : 0) + '%';
  }

  function renderListOddsNow() {
    const items = [];
    document.querySelectorAll('#wl-grid .wl-item').forEach(item => {
      const cb = item.querySelector('input[type=checkbox]');
      const sl = item.querySelector('input[type=range]');
      if (cb.checked) items.push({ name: cb.value, w: parseInt(sl.value, 10) || 1 });
    });
    const total = items.reduce((s, i) => s + i.w, 0);
    const share = {};
    for (const i of items) share[i.name] = (i.w / total) * 100;

    // The pill beside each word count. An unticked list is not in the draw
    // at all, so it shows nothing rather than a misleading 0%.
    document.querySelectorAll('#wl-grid .wl-odds').forEach(pill => {
      const pct = share[pill.dataset.list];
      if (pct === undefined) { pill.textContent = ''; pill.title = ''; return; }
      pill.textContent = fmtPct(pct) + ' chance';
      pill.title = 'How often the next word comes from this list. Its weight sets this — the number of words in it does not.';
    });

    const box = $('list-odds');
    if (!box || box.style.display === 'none') return;
    box.textContent = '';
    if (!items.length) {
      box.appendChild(el('div', 'odds-note', 'Nothing ticked — pick at least one list.'));
      return;
    }
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
      row.appendChild(el('span', 'opct', fmtPct(pct)));
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

  const OPT_KEYS = ['rounds', 'roundTime', 'pickTime', 'wordChoices', 'hintCount', 'hintSpeed', 'maxPlayers', 'autocorrectStrength', 'strokeLimit'];
  const OPT_TOGGLES = ['combinations', 'lockComboParts', 'hidden', 'coopMode', 'relayMode', 'mirrorMode', 'oneColorMode', 'suddenDeath', 'wetPaint', 'tileReveal', 'randomRoundTime', 'randomWordChoices', 'showWordSource', 'spamProtection', 'textTool', 'avoidRepeats', 'sceneBackgrounds', 'lockOnGuess', 'showPunctuation'];

  // Plain-language explanations shown when you tap the ? next to a setting.
  const HELP = {
    rounds: 'How many times everyone gets to draw. Ten rounds with eight players is about 40 minutes.',
    roundTime: 'How long the artist has per word. Time also shrinks once people start guessing right, so 90s rarely runs the full 90.',
    wordChoices: 'How many words the artist picks from at the start of their turn. More choices means fewer "I can\'t draw that" moments.',
    hintCount: 'Letters revealed over the round, spread out evenly. Never more than half the word.',
    maxPlayers: 'Seat limit for the room, up to 50. Big rooms are fun but mean more waiting between your turns — past about 16 people, expect a long gap before you draw again.',
    autocorrectStrength: 'How forgiving guessing is. Off: exact spelling only. Easy: one typo on longer words, plurals forgiven. Normal: a typo on most words, two on long ones. Generous: pretty much anything close counts.',
    combinations: 'Every word is actually two words glued together, like "boat+coat". Guess them as word1+word2.',
    lockComboParts: 'In Combinations, guessing one half correctly locks it in so you only need the other. Only does anything when Combinations is on.',
    hidden: 'Guessers see no letter count and get no hints. Brutal, but fun with good artists.',
    coopMode: 'Two people draw at the same time on the same canvas. Needs at least three players so someone is left to guess.',
    textTool: 'Lets artists type text onto the canvas with the T tool. Writing the actual word (or anything close to it) is blocked.',
    showWordSource: 'After each round, show which list the word came from.',
    avoidRepeats: "Words that have already been drawn — or even shown as a choice — stay out of the rotation for this room, across games, until you change lists. Tiny lists can't get stuck: if the list runs dry, words that were only offered come back first, then ones that were drawn.",
    lockOnGuess: 'The moment the first person guesses the word, the drawing freezes — no more strokes, no erasing, no clearing. Everyone else has to work out what is already on the canvas. A big lock drops in so nobody misses it.',
    sceneBackgrounds: "Gives whoever is drawing a 🖼️ button with ready-made backdrops — a city, a beach, space, a football pitch and plenty more. Handy when the word needs a setting; picking one clears the canvas, so pick it first.",
    spamProtection: 'Anyone sending more than six messages in five seconds, or the same thing three times in a row, gets muted for ten seconds. Always on in public games.',
    relayMode: 'The two co-op artists share one pen. It swaps between them every few seconds — longer rounds get longer turns — so you are always finishing someone else\'s line. Needs Co-op drawing on.',
    mirrorMode: 'Every mark lands flipped left-to-right. Your hand goes one way, the line goes the other. Chaos, and much funnier than it sounds.',
    oneColorMode: 'The palette is taken away and one colour is picked for you, fresh each round. No shading your way out of it — the eraser still works.',
    suddenDeath: 'The very first correct guess ends the round immediately. Nobody gets a leisurely second look, and the artist has to be readable fast.',
    wetPaint: "A dry line sweeps left to right across the canvas. Paint behind it has set: no new marks, no eraser, no undo, no clearing. You get a fifth of the round free before it starts moving, and it reaches the right edge just before time. It forces you to compose in reading order — drawing the outline first, which is everyone's instinct, is exactly what it forbids.",
    tileReveal: 'The guessers watch through twelve shutters. Two are up to start with, the rest lift in a random order, and the last is up three-quarters of the way through — so the round ends as a normal one. Marks behind a closed shutter are held on the server and arrive when it lifts, so people are guessing from a corner of an ear and half a wheel. The artist sees everything and has no idea what is still covered. The bucket fill unlocks with the last shutter.',
    strokeLimit: 'How many separate strokes the artist gets for the whole round — lift the pen too often and you run out. Off means unlimited. Around 10 is a good, painful number.',
    pickTime: 'How long the artist has to choose their word before one is picked for them.',
    hintSpeed: 'When the letters arrive. Early front-loads them so guessers get going sooner; Late holds them back for a tougher round; Even spreads them across the clock.',
    randomRoundTime: 'Rolls a fresh clock every round instead of using the slider — anywhere from about 40% of it up to the full number. Keeps people from pacing themselves.',
    randomWordChoices: 'Rolls how many words the artist gets to choose from each turn, from two up to the slider.',
    showPunctuation: 'Hyphens and apostrophes show up in the blanks straight away, so "t-shirt" reads as _-_ _ _ _ _ instead of one long run. Turn it off to keep the shape of the word secret too.',
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
      if (wrap.classList.contains('opt')) label.appendChild(btn); else wrap.appendChild(btn);
      wrap.appendChild(box);
    });
  }

  // Some toggles only mean anything when their parent is on. Dim and
  // disable the children rather than letting people set dead settings.
  function gateComboLock() {
    const dep = (childId, on) => {
      const child = $(childId);
      if (!child) return;
      child.disabled = !on;
      const row = child.closest('.toggle-row');
      if (row) row.classList.toggle('dim', !on);
      if (!on) child.checked = false;
    };
    dep('opt-lockComboParts', $('opt-combinations').checked);
    dep('opt-relayMode', $('opt-coopMode').checked);
    // Random draw time means nothing when there is no clock to randomise.
    dep('opt-randomRoundTime', Number($('opt-roundTime').value) > 0);
    dep('opt-randomWordChoices', Number($('opt-wordChoices').value) > 0);
  }
  const AC_LABELS = ['Off', 'Easy', 'Normal', 'Generous'];

  function optLabel(key, v) {
    if (key === 'roundTime') return v + 's';
    if (key === 'autocorrectStrength') return AC_LABELS[v] || v;
    // 0 means something different for several of these, so say what it means.
    if (key === 'rounds' && Number(v) === 0) return '∞';
    if (key === 'wordChoices' && Number(v) === 0) return 'Random';
    if (key === 'roundTime') return Number(v) === 0 ? '∞ no clock' : v + 's';
    if (key === 'pickTime') return v + 's';
    if (key === 'strokeLimit') return Number(v) === 0 ? 'Off' : String(v);
    if (key === 'hintSpeed') return HINT_SPEED_LABELS[v] || v;
    return String(v);
  }
  const HINT_SPEED_LABELS = ['Late', 'Even', 'Early'];

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
    // Only the host's own view drives what this device remembers.
    if (gameState && !gameState.managed && gameState.host === myId) rememberOptions(o);
  }

  // ── Game screen widgets ──
  function updateRoundPill() {
    if (!gameState) return;
    const round = gameState.round || 1;
    // rounds === 0 means unlimited. `|| 3` used to turn that into a total,
    // which is how an unlimited game ended up announcing "Round 4/3".
    const total = gameState.totalRounds;
    $('round-pill').textContent = (total > 0)
      ? `Round ${round}/${total}`
      : `Round ${round} · ∞`;
  }

  function updatePlayers(opts = {}) {
    const s = gameState;
    if (!s) return;
    // The host's in-game buttons live in the top bar, and this is the one
    // function that runs on every state change — keep them in step here.
    syncHostGameButtons();
    renderPlayerCount();
    const list = $('players-list');
    list.textContent = '';
    const sorted = [...s.players].sort((a, b) => b.score - a.score);
    sorted.forEach((p, i) => {
      const isDrawing = p.id === s.currentDrawerId || p.id === s.coopPartnerId;
      const guessed = guessedSet.has(p.id) || p.guessed;
      const row = el('div', 'p-row' + (isDrawing ? ' drawing' : '') + (guessed ? ' guessed' : '') + (p.connected === false ? ' dc' : ''));
      row.appendChild(el('span', 'rk', '#' + (i + 1)));
      row.appendChild(avatarNode(p, 'p-avatar'));
      const nm = el('span', 'nm', p.name + (p.id === myId ? ' (you)' : ''));
      nm.title = p.name;
      row.appendChild(nm);
      if (p.id === s.host && !s.managed) {
        const crown = el('span', 'crown', '👑');
        crown.title = 'Host';
        row.appendChild(crown);
      }
      if (p.mod) {
        const m = el('span', 'mod-chip', 'M');
        m.title = 'Moderator';
        row.appendChild(m);
      }
      if (isDrawing) row.appendChild(el('span', 'flag', '🖌️'));
      else if (guessed) row.appendChild(el('span', 'flag', '✅'));
      // Public matches have no host, so kicking goes to a vote instead.
      if (s.managed && p.id !== myId && s.players.length >= 3) {
        const vk = el('button', 'votekick', '🥾');
        vk.title = 'Start a vote to kick ' + p.name;
        vk.onclick = (ev) => { ev.stopPropagation(); startVoteKick(p.id, p.name); };
        row.appendChild(vk);
      }
      // ＋ = send a friend request (both of you need accounts).
      const acct = window.MiviAccount;
      if (p.id !== myId && p.accountId && acct.isLoggedIn() && !acct.friendIds().has(p.accountId) && p.accountId !== acct.user().id) {
        const add = el('button', 'addf', '＋');
        add.title = 'Add ' + p.name + ' as a friend';
        add.onclick = (ev) => { ev.stopPropagation(); socket.emit('friendRequest', { playerId: p.id }); };
        row.appendChild(add);
      }
      row.appendChild(el('span', 'sc', p.score + ' pts'));
      if (opts.bumpId === p.id) row.appendChild(el('span', 'bump', '+' + opts.bumpPts));
      list.appendChild(row);
    });
  }

  // How many people are in this game, wherever it is being played.
  function renderPlayerCount() {
    const s = gameState;
    const box = $('player-count');
    if (!box) return;
    if (!s) { box.style.display = 'none'; return; }
    const here = s.players.filter(p => p.connected !== false).length;
    const max = (s.options && s.options.maxPlayers) || here;
    box.style.display = 'inline-flex';
    $('player-count-num').innerHTML = '';
    const strong = document.createElement('b');
    strong.textContent = String(here);
    $('player-count-num').appendChild(strong);
    $('player-count-num').appendChild(document.createTextNode(' / ' + max + (here === 1 ? ' player' : ' players')));
    box.title = s.managed
      ? here + ' in this public game'
      : here + ' in this room' + (s.players.length > here ? ' (' + (s.players.length - here) + ' reconnecting)' : '');
  }

  // Timer ring
  const RING_C = 2 * Math.PI * 19;
  function setTimer(t) {
    currentTimeLeft = t;
    // No clock at all: show it rather than a frozen zero.
    if (gameState && gameState.roundSeconds === 0 && gameState.state === 'drawing') {
      $('timer-num').textContent = '∞';
      const ring = $('timer-ring-fg');
      if (ring) ring.style.strokeDashoffset = '0';
      $('timer-wrap').classList.remove('urgent');
      return;
    }
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
    // 25 options must not spill off the canvas — shrink them instead.
    grid.classList.toggle('many', words.length > 8);
    grid.classList.toggle('lots', words.length > 15);

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
    // The emoji stamp shares the text tool's switch.
    $('tool-emoji').style.display = (artist && textOn) ? 'flex' : 'none';
    if (!textOn && currentTool === 'emoji') setTool('pen');
    const sceneOn = !!(gameState && gameState.options && gameState.options.sceneBackgrounds);
    $('tool-scene').style.display = (artist && sceneOn) ? 'flex' : 'none';
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
    const inDrawing = !!(gameState && gameState.state === 'drawing');
    const isHost = !!(gameState && gameState.host === myId && !gameState.managed);
    // Liking is for anyone but the artist. Skipping is the host's call in a
    // private room (whoever is drawing), or a majority vote in a public one.
    const canLike = inDrawing && !isArtist;
    const canSkip = inDrawing && (gameState.managed ? !isArtist : isHost);
    $('btn-like').style.display = canLike ? 'flex' : 'none';
    $('btn-voteskip').style.display = canSkip ? 'flex' : 'none';
    $('btn-voteskip').title = gameState && gameState.managed ? 'Vote to skip this round' : 'Skip this round (host)';
    $('float-actions').style.display = (canLike || canSkip) ? 'flex' : 'none';
    $('btn-like').classList.toggle('used', likeUsed);
    $('btn-voteskip').classList.toggle('used', gameState && gameState.managed ? voteSkipUsed : false);
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
      // "👋 Ada joined!" → an icon bubble plus the text, tinted by what happened.
      const m = String(msg.text).match(/^(\S{1,3})\s+(.*)$/u);
      const rest = m ? m[2] : String(msg.text);
      if (m && /\p{Extended_Pictographic}/u.test(m[1])) {
        node.appendChild(el('span', 'sys-icon', m[1]));
        node.appendChild(el('span', 'sys-text', rest));
      } else {
        node.appendChild(el('span', 'sys-text', String(msg.text)));
      }
      const t = rest.toLowerCase();
      if (/joined|reconnected|friends now/.test(t)) node.classList.add('sys-in');
      else if (/left|disconnected|kicked/.test(t)) node.classList.add('sys-out');
      else if (/host|got the|skipping/.test(t)) node.classList.add('sys-star');
      else if (/muted|not enough/.test(t)) node.classList.add('sys-warn');
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

  // A bar over the guess box beats a toast in the corner nobody watches.
  let closeBarTimer = null;
  function showCloseBar(msg) {
    let bar = $('close-bar');
    if (!bar) {
      bar = el('div', 'close-bar');
      bar.id = 'close-bar';
      const row = $('game-chat-input').parentNode;
      row.parentNode.insertBefore(bar, row);
    }
    bar.textContent = msg;
    bar.classList.remove('show');
    void bar.offsetWidth;
    bar.classList.add('show');
    clearTimeout(closeBarTimer);
    closeBarTimer = setTimeout(() => bar.classList.remove('show'), 2600);
  }

  function sendGameChat() {
    const input = $('game-chat-input');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    rememberSent('game', text);
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
    rememberSent('lobby', text);
    socket.emit('chat', { text });
  }

  // ── Canvas ──
  function setupCanvas() {
    const canvas = $('canvas');
    ctx = canvas.getContext('2d', { willReadFrequently: true });
    canvas.width = CANVAS_W * CANVAS_SCALE;
    canvas.height = CANVAS_H * CANVAS_SCALE;
    ctx.setTransform(CANVAS_SCALE, 0, 0, CANVAS_SCALE, 0, 0);
    const preview = $('canvas-preview');
    pctx = preview.getContext('2d');
    preview.width = CANVAS_W * CANVAS_SCALE;
    preview.height = CANVAS_H * CANVAS_SCALE;
    pctx.setTransform(CANVAS_SCALE, 0, 0, CANVAS_SCALE, 0, 0);
    clearCanvasLocal();

    canvas.addEventListener('contextmenu', (e) => e.preventDefault()); // long-press on phones
    canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture(e.pointerId); startDraw(e); });
    canvas.addEventListener('pointermove', draw);
    canvas.addEventListener('pointerup', endDraw);
    canvas.addEventListener('pointercancel', endDraw);
  }

  function clearCanvasLocal() {
    if (!ctx) return;
    syncCanvasBackground();
    ctx.save();
    ctx.fillStyle = bgStyle;
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.restore();
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

  // ── Emoji stamp ──
  // Rides on the text tool: the same room option turns both on, and a stamp
  // is just a text event whose content happens to be an emoji.
  const EMOJI_GROUPS = [
    // The ones people actually reach for when a drawing is going badly.
    ['Funny', ['💀','🗿','🤡','🫠','🥸','😭','🤨','🫡','😳','🤪','😵‍💫','🙃','🤌','👁️','👄','🧌','🦧','🐌','🫥','😤','🤓','🥴','😬','🫨','🤮','👺','💩','🍆','🐸','🤏','🧠','🚽']],
    ['Faces', ['😀','😂','🥹','😍','😎','🤔','😴','🤯','😭','😡','🥳','🤠','👻','💀','🤖','👽','🎃','😇','🥶','🤢']],
    ['People', ['👋','👍','👎','👏','🙏','💪','🫶','🤝','🧠','👀','👑','🧙','🥷','🧜','🧑‍🚀','🕺','💃','🤹','🏃','🧗']],
    ['Animals', ['🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🐔','🐧','🦆','🦉','🦇','🐺','🐗','🐴','🦄','🐝','🐛','🦋','🐌','🐞','🐢','🐍','🦎','🐙','🦑','🦀','🐠','🐬','🐳','🦈','🐊']],
    ['Food', ['🍏','🍎','🍐','🍊','🍋','🍌','🍉','🍇','🍓','🥝','🍅','🥕','🌽','🥔','🍞','🧀','🥚','🥓','🍔','🍟','🍕','🌭','🌮','🍿','🍩','🍪','🎂','🍰','🍫','🍭','☕','🍺']],
    ['Nature', ['🌵','🌲','🌳','🌴','🌱','🌿','🍀','🍁','🍄','🌸','🌻','🌹','🌊','🔥','❄️','⭐','🌙','☀️','☁️','⚡','🌈','💧']],
    ['Things', ['⚽','🏀','🏈','🎾','🎱','🎮','🎲','🎸','🎺','🥁','🎨','✏️','📚','💡','🔑','🔒','💰','💎','🎁','🎈','🚗','🚕','🚌','🚲','✈️','🚀','⛵','🏠','🏰','⏰','📱','💻','🛒','🧲','🪄','🗿']],
    ['Symbols', ['❤️','💔','✨','💥','💤','❓','❗','✅','❌','➕','➖','🔴','🟠','🟡','🟢','🔵','🟣','⚫','⚪','🟤']],
  ];

  // The full Unicode emoji blocks, on top of the curated groups. Built
  // lazily the first time the picker opens; ~1,800 glyphs.
  const EMOJI_RANGES = [
    [0x1F600, 0x1F64F], [0x1F300, 0x1F5FF], [0x1F680, 0x1F6FF],
    [0x1F90D, 0x1F9FF], [0x1FA70, 0x1FAC5], [0x1FAD0, 0x1FADB],
    [0x1FAE0, 0x1FAE8], [0x1FAF0, 0x1FAF8], [0x2600, 0x26FF], [0x2700, 0x27BF],
  ];

  function allEmoji() {
    const seen = new Set();
    const out = [];
    const curated = new Set();
    for (const [, list] of EMOJI_GROUPS) for (const e of list) curated.add(e);
    for (const [a, b] of EMOJI_RANGES) {
      for (let cp = a; cp <= b; cp++) {
        const ch = String.fromCodePoint(cp);
        if (seen.has(ch) || curated.has(ch)) continue;
        seen.add(ch);
        out.push(ch);
      }
    }
    return out;
  }

  let pendingEmoji = null;

  function buildEmojiPicker() {
    const box = $('emoji-picker');
    if (!box || box.dataset.built === '1') return;
    box.dataset.built = '1';

    // A filter box at the top — with this many glyphs you need one.
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'input emoji-search';
    search.placeholder = 'Filter groups, or paste an emoji';
    search.addEventListener('input', () => filterEmojiPicker(search.value));
    search.addEventListener('keydown', (e) => e.stopPropagation());
    box.appendChild(search);
    for (const [label, list] of EMOJI_GROUPS.concat([['Everything', allEmoji()]])) {
      const head = el('div', 'emoji-group-label', label);
      head.dataset.group = label.toLowerCase();
      box.appendChild(head);
      for (const e of list) {
        const b = el('button', '', e);
        b.type = 'button';
        b.dataset.group = label.toLowerCase();
        b.title = e;
        b.addEventListener('click', () => chooseEmoji(e));
        box.appendChild(b);
      }
    }
  }

  function filterEmoji(q) {
    const term = String(q || '').trim().toLowerCase();
    document.querySelectorAll('#emoji-picker [data-group]').forEach(node => {
      const hit = !term || node.dataset.group.includes(term);
      node.style.display = hit ? '' : 'none';
    });
  }

  function chooseEmoji(e) {
    pendingEmoji = e;
    setTool('emoji');
    $('tool-emoji').textContent = e;
    $('tool-emoji').classList.add('emoji-armed');
    $('modal-emoji').style.display = 'none';
    sfx('pop');
    toast('Click the canvas to stamp ' + e);
  }

  function openEmojiPicker() {
    buildEmojiPicker();
    filterEmoji($('emoji-search').value);
    $('modal-emoji').style.display = 'flex';
    setTimeout(() => $('emoji-search').focus(), 0);
  }

  // Emoji are placed by pressing where you want them and dragging outwards
  // to choose how big — release to stamp. A plain tap uses the brush size.
  function filterEmojiPicker(q) {
    const box = $('emoji-picker');
    const query = String(q || '').trim().toLowerCase();
    let currentLabel = '';
    for (const node of box.children) {
      if (node.classList && node.classList.contains('emoji-group-label')) {
        currentLabel = node.textContent.toLowerCase();
        node.style.display = !query || currentLabel.includes(query) ? '' : 'none';
      } else if (node.tagName === 'BUTTON') {
        const hit = !query || currentLabel.includes(query) || node.textContent === q.trim();
        node.style.display = hit ? '' : 'none';
      }
    }
  }

  let emojiDrag = null;
  const EMOJI_MIN = 12, EMOJI_MAX = 320;

  function emojiSizeFor(dist) {
    if (dist < 4) return Math.max(EMOJI_MIN, brushSize * 4);
    return Math.max(EMOJI_MIN, Math.min(EMOJI_MAX, Math.round(dist * 2)));
  }

  function beginEmojiDrag(p) {
    if (!pendingEmoji) { openEmojiPicker(); return false; }
    emojiDrag = { x: p.x, y: p.y, size: emojiSizeFor(0) };
    drawEmojiPreview();
    return true;
  }

  function updateEmojiDrag(p) {
    if (!emojiDrag) return;
    const dx = p.x - emojiDrag.x, dy = p.y - emojiDrag.y;
    emojiDrag.size = emojiSizeFor(Math.sqrt(dx * dx + dy * dy));
    drawEmojiPreview();
  }

  function drawEmojiPreview() {
    if (!emojiDrag || !pctx) return;
    pctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    pctx.save();
    pctx.globalAlpha = 0.75;
    pctx.font = emojiDrag.size + 'px system-ui, "Segoe UI Emoji", "Apple Color Emoji", sans-serif';
    pctx.textAlign = 'center';
    pctx.textBaseline = 'middle';
    pctx.fillText(pendingEmoji, emojiDrag.x, emojiDrag.y);
    // A faint ring showing the size you are dialling in.
    pctx.globalAlpha = 0.35;
    pctx.strokeStyle = '#6C5CE7';
    pctx.lineWidth = 1.5;
    pctx.setLineDash([5, 4]);
    pctx.beginPath();
    pctx.arc(emojiDrag.x, emojiDrag.y, emojiDrag.size / 2, 0, Math.PI * 2);
    pctx.stroke();
    pctx.restore();
  }

  function endEmojiDrag() {
    if (!emojiDrag) return;
    const { x, y, size } = emojiDrag;
    emojiDrag = null;
    if (pctx) pctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    const data = { type: 'emoji', x, y, text: pendingEmoji, size };
    applyDraw(data);
    flushBatch();
    socket.emit('draw', data);
    socket.emit('strokeEnd');
  }

  // ── Text tool ──
  let textInput = null;
  const textPx = () => Math.round(brushSize * 3 + 14);
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
    // Match the drawn text exactly, so the input IS the preview.
    input.style.font = `800 ${Math.round(textPx() * r.width / CANVAS_W)}px 'Plus Jakarta Sans', system-ui, sans-serif`;
    // …and mirror it onto the canvas preview layer as they type.
    let previewTimer = null;
    const shareTyping = (value) => {
      clearTimeout(previewTimer);
      previewTimer = setTimeout(() => {
        socket.emit('textPreview', { x: p.x, y: p.y, text: value, color: currentColor, size: brushSize });
      }, 120);
    };
    input._shareTyping = shareTyping;
    input.addEventListener('input', () => {
      shareTyping(input.value);
      pctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
      const v = input.value;
      if (!v) return;
      pctx.font = `800 ${textPx()}px 'Plus Jakarta Sans', system-ui, sans-serif`;
      pctx.fillStyle = currentColor;
      pctx.textBaseline = 'middle';
      pctx.textAlign = 'left';
      pctx.globalAlpha = 0.45;
      pctx.fillText(v.slice(0, 40), p.x, p.y);
      pctx.globalAlpha = 1;
    });
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
    if (textInput) {
      // Tell everyone the ghost text is gone, or it hangs on their canvas.
      if (textInput._shareTyping) textInput._shareTyping('');
      textInput.remove();
      textInput = null;
    }
    if (pctx) pctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
  }

  function startDraw(e) {
    if (!isArtist || gameState?.state !== 'drawing') return;
    if (canvasLocked) return;
    if (relayBlocksMe()) return;
    const p = pos(e);
    // Wet Paint: the server would drop these anyway — refusing here means the
    // artist sees the boundary instead of a stroke that silently vanishes.
    if (inDryZone(p)) {
      toast('🖌️ That part has dried — paint ahead of the line.');
      return;
    }

    if (currentTool === 'emoji') {
      if (beginEmojiDrag(p)) drawing = true;
      return;
    }
    if (currentTool === 'text') {
      openTextInput(p);
      return;
    }
    if (currentTool === 'fill') {
      const data = { type: 'fill', x: p.x, y: p.y, color: currentColor };
      fillAt(ctx, p.x, p.y, currentColor);
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
    midX = p.x; midY = p.y;
    smoothX = p.x; smoothY = p.y;
    const erasing = currentTool === 'eraser';
    const paint = erasing ? bgStyle : currentColor;
    const size = erasing ? brushSize * 2 : brushSize;
    ctx.beginPath();
    ctx.arc(p.x, p.y, size / 2, 0, Math.PI * 2);
    ctx.fillStyle = paint;
    ctx.fill();
    queueDraw({ type: 'dot', x: p.x, y: p.y, color: erasing ? canvasBg : currentColor, size, tool: currentTool });
  }

  function draw(e) {
    if (!drawing || !isArtist) return;
    if (emojiDrag) { updateEmojiDrag(pos(e)); return; }
    if (shape) {
      const p = pos(e);
      drawShapePreview(shape.x1, shape.y1, p.x, p.y);
      return;
    }
    const erasing = currentTool === 'eraser';
    const wireColor = erasing ? canvasBg : currentColor;
    const size = erasing ? brushSize * 2 : brushSize;
    // Coalesced events give every intermediate pointer position, and each pair
    // of points becomes a quadratic through their midpoints — no more visible
    // corners at every sample.
    const evs = (e.getCoalescedEvents && e.getCoalescedEvents()) || [];
    const list = evs.length ? evs : [e];
    for (const ce of list) {
      const raw = pos(ce);
      if (inDryZone(raw)) continue;
      // A light low-pass on the pointer takes the tremble out of a slow hand
      // without adding any lag you can feel. Fast strokes barely notice it.
      smoothX += (raw.x - smoothX) * SMOOTHING;
      smoothY += (raw.y - smoothY) * SMOOTHING;
      const p = { x: smoothX, y: smoothY };
      // Sub-pixel wobble is not worth a packet, or a curve.
      const dx = p.x - lastX, dy = p.y - lastY;
      if (dx * dx + dy * dy < MIN_STEP_SQ) continue;
      const mx = (lastX + p.x) / 2;
      const my = (lastY + p.y) / 2;
      const ev = { type: 'quad', x1: midX, y1: midY, cx: lastX, cy: lastY, x2: mx, y2: my, color: wireColor, size, tool: currentTool };
      applyDraw(ev);
      queueDraw(ev);
      midX = mx; midY = my;
      lastX = p.x; lastY = p.y;
    }
  }

  function endDraw(e) {
    if (!drawing) return;
    drawing = false;
    if (emojiDrag) { endEmojiDrag(); return; }
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
    // Close the stroke off at the true last point (the smoothing stops at the
    // final midpoint, which would otherwise leave a short gap).
    if (strokeEvents.length > 0 && (midX !== lastX || midY !== lastY)) {
      const erasing = currentTool === 'eraser';
      const tail = {
        type: 'line', x1: midX, y1: midY, x2: lastX, y2: lastY,
        color: erasing ? canvasBg : currentColor,
        size: erasing ? brushSize * 2 : brushSize,
        tool: currentTool,
      };
      applyDraw(tail);
      queueDraw(tail);
    }
    flushBatch();
    if (strokeEvents.length > 0) {
      strokeEvents = [];
      socket.emit('strokeEnd');
    }
  }

  // A triangle with rounded corners rather than mitred points — a sharp
  // mitre at a thick brush size is what made the "spike" look ragged.
  function traceTriangle(c, x1, y1, x2, y2, size) {
    const cx = (x1 + x2) / 2;
    const pts = [[cx, y1], [x2, y2], [x1, y2]];
    const r = Math.min(size * 1.2, Math.abs(x2 - x1) / 4, Math.abs(y2 - y1) / 4);
    if (!(r > 0.5)) {
      c.moveTo(cx, y1); c.lineTo(x1, y2); c.lineTo(x2, y2); c.closePath();
      return;
    }
    // arcTo does the corner rounding; start on the first edge's midpoint so
    // the path closes cleanly.
    const mid = [(pts[0][0] + pts[2][0]) / 2, (pts[0][1] + pts[2][1]) / 2];
    c.moveTo(mid[0], mid[1]);
    for (let i = 0; i < 3; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % 3];
      c.arcTo(a[0], a[1], b[0], b[1], r);
    }
    c.closePath();
  }

  // An arrow: the shaft, plus two barbs scaled to the brush so they stay
  // readable at any thickness.
  function traceArrow(c, x1, y1, x2, y2, size) {
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (len < 1) return;
    const ux = dx / len, uy = dy / len;
    // Barbs are proportional to the line, but never longer than the line.
    const head = Math.min(len * 0.42, Math.max(14, size * 3.4));
    const spread = 0.45;                     // radians off the shaft
    const cos = Math.cos(spread), sin = Math.sin(spread);
    // Stop the shaft just short of the tip so the join stays clean.
    const backX = x2 - ux * head * 0.55;
    const backY = y2 - uy * head * 0.55;
    c.moveTo(x1, y1);
    c.lineTo(backX, backY);
    c.moveTo(x2, y2);
    c.lineTo(x2 - (ux * cos - uy * sin) * head, y2 - (uy * cos + ux * sin) * head);
    c.moveTo(x2, y2);
    c.lineTo(x2 - (ux * cos + uy * sin) * head, y2 - (uy * cos - ux * sin) * head);
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
      traceTriangle(pctx, x1, y1, x2, y2, brushSize);
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
    // Eraser strokes always restore OUR paper — the wire colour is only a
    // placeholder, and the artist may be on a different background.
    const col = d.tool === 'eraser' ? bgStyle : d.color;
    if (d.type === 'dot') {
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.size / 2, 0, Math.PI * 2);
      ctx.fillStyle = col;
      ctx.fill();
    } else if (d.type === 'line') {
      drawSeg(ctx, d.x1, d.y1, d.x2, d.y2, col, d.size);
    } else if (d.type === 'quad') {
      ctx.beginPath();
      ctx.moveTo(d.x1, d.y1);
      ctx.quadraticCurveTo(d.cx, d.cy, d.x2, d.y2);
      ctx.strokeStyle = col;
      ctx.lineWidth = d.size;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke();
    } else if (d.type === 'emoji') {
      ctx.font = Math.round(d.size || 48) + 'px system-ui, "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(d.text || '').slice(0, 8), d.x, d.y);
      ctx.textAlign = 'left';
    } else if (d.type === 'text') {
      ctx.font = `800 ${Math.round((d.size || 6) * 3 + 14)}px 'Plus Jakarta Sans', system-ui, sans-serif`;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.fillStyle = d.color;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.fillText(String(d.text || '').slice(0, 40), d.x, d.y);
    } else if (d.type === 'fill') {
      fillAt(ctx, d.x, d.y, d.color);
    } else if (d.type === 'rect') {
      ctx.beginPath();
      ctx.strokeStyle = d.color; ctx.lineWidth = d.size; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.strokeRect(d.x1, d.y1, d.x2 - d.x1, d.y2 - d.y1);
    } else if (d.type === 'circle') {
      const rx = Math.abs(d.x2 - d.x1) / 2, ry = Math.abs(d.y2 - d.y1) / 2;
      if (rx > 0 && ry > 0) {
        ctx.beginPath();
        ctx.ellipse((d.x1 + d.x2) / 2, (d.y1 + d.y2) / 2, rx, ry, 0, 0, Math.PI * 2);
        ctx.strokeStyle = d.color; ctx.lineWidth = d.size;
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.stroke();
      }
    } else if (d.type === 'triangle') {
      ctx.beginPath();
      traceTriangle(ctx, d.x1, d.y1, d.x2, d.y2, d.size);
      ctx.strokeStyle = d.color; ctx.lineWidth = d.size;
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.stroke();
    } else if (d.type === 'arrow') {
      ctx.beginPath();
      traceArrow(ctx, d.x1, d.y1, d.x2, d.y2, d.size);
      ctx.strokeStyle = d.color; ctx.lineWidth = d.size;
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.stroke();
    }
  }

  // The good fill (anti-alias aware, scanline) lives in fill.js; this keeps
  // working if that file ever fails to load.
  //
  // x/y are drawing coordinates (the 1000x750 space), the same as every
  // other draw helper. The pixel routines below read the backing store, so
  // they need device pixels — converting here, once, keeps the artist's own
  // click and the replayed event landing on the same spot.
  function fillAt(targetCtx, x, y, hex) {
    const dx = Math.round(x * CANVAS_SCALE);
    const dy = Math.round(y * CANVAS_SCALE);
    if (window.MiviFill && window.MiviFill.smartFill) {
      // Generous: a wider tolerance for anti-aliased edges, and gaps up to
      // ~7 canvas pixels get sealed instead of flooding the page.
      return window.MiviFill.smartFill(targetCtx, dx, dy, hex, { tolerance: 40, seal: 7 * CANVAS_SCALE });
    }
    if (window.MiviFill && window.MiviFill.floodFill) {
      return window.MiviFill.floodFill(targetCtx, dx, dy, hex, { tolerance: 40 });
    }
    return floodFill(targetCtx, dx, dy, hex);
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
    if ((tool === 'text' || tool === 'emoji') && !(gameState && gameState.options && gameState.options.textTool)) return;
    if (tool !== 'emoji') $('tool-emoji').classList.remove('emoji-armed');
    if (tool !== 'text') closeTextInput();
    currentTool = tool;
    document.querySelectorAll('.tool-btn[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === tool));
  }

  // ── Fullscreen focus mode ──
  function toggleFocusMode() {
    autoFocusOn = false;   // you asked for this; stop second-guessing it
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
    resetGameGrid();
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
    $('re-stats').textContent = `Drawn by ${artist} · ${guessPhrase(snap.guessedCount, snap.playerCount)}`;
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
      right.appendChild(el('span', 't', s.score + ' pts'));
      row.appendChild(right);
      scoresBox.appendChild(row);
    });

    // Keep the round's drawing for the end-of-game GIF.
    if (!p.aborted && snap.word) {
      gameFrames.push({
        dataUrl: snap.dataUrl, word: snap.word, artist: snap.artist,
        guessed: snap.guessedCount, total: snap.playerCount,
        seconds: roundClockStart ? Math.max(1, Math.round((Date.now() - roundClockStart) / 1000)) : null,
        first: roundFirstGuesser,
      });
      if (gameFrames.length > 40) gameFrames.shift();
    }
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

  // "3 of 5 guessed it" reads better than "3/5", and the ends deserve
  // their own wording.
  function guessPhrase(guessed, total) {
    if (!total) return 'nobody was guessing';
    if (guessed === 0) return `nobody got it (0 of ${total})`;
    if (guessed === total) return total === 1 ? 'the one guesser got it' : `everyone got it (${total} of ${total})`;
    return `${guessed} of ${total} guessed it`;
  }

  // Rounded rectangle path, with a fallback for older canvas engines.
  function roundRectPath(c, x, y, w, h, r) {
    if (c.roundRect) { c.beginPath(); c.roundRect(x, y, w, h, r); return; }
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  // The saved PNG is a proper little card: the drawing matted on a dark
  // board, a gradient rule, then the word, who drew it and how it went.
  async function downloadSnap() {
    if (!snap) return;
    let img;
    try { img = await loadImage(snap.dataUrl); } catch (e) { toast('❌ ' + e.message); return; }
    const logo = await loadLogo();

    const PAD = 30, FOOT = 148, RULE = 5;
    const W = img.width + PAD * 2;
    const H = img.height + PAD + RULE + FOOT;
    const off = document.createElement('canvas');
    off.width = W;
    off.height = H;
    const c = off.getContext('2d');

    // Board.
    c.fillStyle = '#16172C';
    c.fillRect(0, 0, W, H);

    // The drawing, matted with rounded corners and a soft shadow.
    c.save();
    c.shadowColor = 'rgba(0,0,0,0.45)';
    c.shadowBlur = 22;
    c.shadowOffsetY = 6;
    roundRectPath(c, PAD, PAD, img.width, img.height, 16);
    c.fillStyle = '#ffffff';
    c.fill();
    c.restore();
    c.save();
    roundRectPath(c, PAD, PAD, img.width, img.height, 16);
    c.clip();
    c.drawImage(img, PAD, PAD);
    c.restore();

    // Gradient rule under the art.
    const ruleY = PAD + img.height + 22;
    const grad = c.createLinearGradient(PAD, 0, W - PAD, 0);
    grad.addColorStop(0, '#6C5CE7');
    grad.addColorStop(1, '#FD79A8');
    c.fillStyle = grad;
    roundRectPath(c, PAD, ruleY, W - PAD * 2, RULE, RULE / 2);
    c.fill();

    // Footer: mark, the word, who drew it — then the round's stats on the right.
    const textX = PAD + (logo ? 76 : 0);
    const baseY = ruleY + 54;
    if (logo) c.drawImage(logo, PAD, baseY - 30, 60, 60);

    c.textBaseline = 'middle';
    c.textAlign = 'left';
    c.fillStyle = '#FFFFFF';
    c.font = "800 40px 'Plus Jakarta Sans', system-ui, sans-serif";
    const word = String(snap.word || '');
    // Shrink the word until it clears the stats column.
    let size = 40;
    const room = W - textX - PAD - 190;
    while (size > 20 && c.measureText(word).width > room) {
      size -= 2;
      c.font = `800 ${size}px 'Plus Jakarta Sans', system-ui, sans-serif`;
    }
    c.fillText(word, textX, baseY);
    c.fillStyle = '#9A9DBF';
    c.font = "600 19px 'Plus Jakarta Sans', system-ui, sans-serif";
    c.fillText('drawn by ' + String(snap.artist || 'someone'), textX, baseY + 34);

    c.textAlign = 'right';
    c.fillStyle = '#B9B3F5';
    c.font = "800 22px 'Plus Jakarta Sans', system-ui, sans-serif";
    c.fillText(guessPhrase(snap.guessedCount, snap.playerCount), W - PAD, baseY - 6);
    c.fillStyle = '#6C6F91';
    c.font = "700 17px 'Plus Jakarta Sans', system-ui, sans-serif";
    const likes = snap.likes ? `❤️ ${snap.likes}   ·   ` : '';
    c.fillText(likes + 'Mivimoose Draw', W - PAD, baseY + 30);

    const a = document.createElement('a');
    a.href = off.toDataURL('image/png');
    a.download = (snap.word || 'drawing').replace(/[^a-zA-Z0-9 ]/g, '-').trim() + '.png';
    a.click();
    sfx('save');
    toast(activityMode
      ? '⬇️ Saved — if Discord blocked it, open the game in your browser'
      : '⬇️ Saved to your downloads');
  }

  let geTimer = null;
  function showGameEnd(finalScores) {
    lastFinalScores = finalScores;
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
    const gifBtn = $('btn-gif');
    gifBtn.style.display = (gameFrames.length && window.MiviGIF) ? 'inline-block' : 'none';
    gifBtn.disabled = false;
    gifBtn.textContent = `🎬 Save all ${gameFrames.length} drawings as a GIF`;
    $('gif-progress').style.display = 'none';
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

  // ── Whole-game GIF ──
  // Each round's drawing gets a caption strip and the Mivimoose mark, then
  // the frames are encoded to an animated GIF in the browser.
  // The caption strip is deep enough for three lines on the right, so the
  // wordmark never lands on top of the "first guess" line.
  const GIF_W = 640, GIF_H = 536, STRIP_H = 96;

  // Trim a string to fit a pixel width, with an ellipsis if it had to give.
  function ellipsize(c, text, maxWidth) {
    let s = String(text);
    if (c.measureText(s).width <= maxWidth) return s;
    while (s.length > 1 && c.measureText(s + '…').width > maxWidth) s = s.slice(0, -1);
    return s + '…';
  }

  function loadLogo() {
    return new Promise((resolve) => {
      const link = document.querySelector('link[rel="icon"]');
      if (!link) return resolve(null);
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = link.href;
    });
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result || ''));
      r.onerror = () => reject(new Error('Could not read the GIF.'));
      r.readAsDataURL(blob);
    });
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Could not read a drawing.'));
      img.src = src;
    });
  }

  async function buildGifFrames() {
    const logo = await loadLogo();
    const frames = [];
    for (const f of gameFrames) {
      const img = await loadImage(f.dataUrl);
      const cv = document.createElement('canvas');
      cv.width = GIF_W;
      cv.height = GIF_H;
      const c = cv.getContext('2d');
      c.fillStyle = '#ffffff';
      c.fillRect(0, 0, GIF_W, GIF_H);
      // The drawing, letterboxed into the top area.
      const artH = GIF_H - STRIP_H;
      const scale = Math.min(GIF_W / img.width, artH / img.height);
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      c.drawImage(img, Math.round((GIF_W - w) / 2), Math.round((artH - h) / 2), w, h);

      // Caption strip. It is laid out as two columns that never overlap:
      // the logo and word on the left, the round's stats on the right, and
      // the wordmark tucked into the bottom-right corner on its own line.
      const top = GIF_H - STRIP_H;
      c.fillStyle = '#1D1F3A';
      c.fillRect(0, top, GIF_W, STRIP_H);
      c.textBaseline = 'middle';

      const RIGHT_W = 208;                    // reserved for the stats column
      const leftX = 76;
      const leftW = GIF_W - RIGHT_W - leftX - 18;

      c.textAlign = 'left';
      c.fillStyle = '#ffffff';
      c.font = "800 29px 'Plus Jakarta Sans', system-ui, sans-serif";
      c.fillText(ellipsize(c, String(f.word), leftW), leftX, top + 30);

      c.fillStyle = '#B9B3F5';
      c.font = "600 17px 'Plus Jakarta Sans', system-ui, sans-serif";
      let sub = 'drawn by ' + f.artist;
      if (f.seconds) sub += '  ·  ' + f.seconds + 's';
      c.fillText(ellipsize(c, sub, leftW), leftX, top + 60);

      c.textAlign = 'right';
      c.fillStyle = '#8E93B8';
      c.font = "700 16px 'Plus Jakarta Sans', system-ui, sans-serif";
      c.fillText(ellipsize(c, guessPhrase(f.guessed, f.total), RIGHT_W), GIF_W - 18, top + 26);
      if (f.first) {
        c.fillStyle = '#7BE0C0';
        c.font = "700 15px 'Plus Jakarta Sans', system-ui, sans-serif";
        c.fillText(ellipsize(c, '⚡ ' + f.first + ' first', RIGHT_W), GIF_W - 18, top + 50);
      }
      // Its own line at the bottom, clear of everything above it.
      c.fillStyle = '#6C6F91';
      c.font = "700 14px 'Plus Jakarta Sans', system-ui, sans-serif";
      c.fillText('Mivimoose Draw', GIF_W - 18, top + STRIP_H - 16);

      if (logo) c.drawImage(logo, 16, top + 22, 48, 48);
      frames.push(cv);
    }

    // Closing card: the final table and who was quickest on the buzzer.
    // It is pushed several times so it lingers instead of blinking past.
    const summary = buildSummaryFrame(logo);
    if (summary) for (let i = 0; i < 4; i++) frames.push(summary);
    return frames;
  }

  function buildSummaryFrame(logo) {
    const scores = lastFinalScores;
    if (!scores || !scores.length) return null;
    const cv = document.createElement('canvas');
    cv.width = GIF_W;
    cv.height = GIF_H;
    const c = cv.getContext('2d');

    c.fillStyle = '#16172C';
    c.fillRect(0, 0, GIF_W, GIF_H);
    const grad = c.createLinearGradient(0, 0, GIF_W, 0);
    grad.addColorStop(0, '#6C5CE7');
    grad.addColorStop(1, '#FD79A8');
    c.fillStyle = grad;
    c.fillRect(0, 0, GIF_W, 6);

    c.textBaseline = 'middle';
    c.textAlign = 'center';
    c.fillStyle = '#FFFFFF';
    c.font = "800 38px 'Plus Jakarta Sans', system-ui, sans-serif";
    c.fillText('Final scores', GIF_W / 2, 58);

    const medals = ['🥇', '🥈', '🥉'];
    const top = scores.slice(0, 6);
    const rowH = 46;
    const startY = 118;
    top.forEach((p, i) => {
      const y = startY + i * rowH;
      c.fillStyle = i % 2 ? '#1D1F3A' : '#20223F';
      c.fillRect(48, y - 18, GIF_W - 96, 38);
      c.textAlign = 'left';
      c.fillStyle = i < 3 ? '#FFFFFF' : '#C9CCE8';
      c.font = "700 22px 'Plus Jakarta Sans', system-ui, sans-serif";
      c.fillText((medals[i] || ' ' + (i + 1) + ' ') + '  ' + String(p.name).slice(0, 20), 66, y);
      c.textAlign = 'right';
      c.fillStyle = '#B9B3F5';
      c.font = "800 22px 'Plus Jakarta Sans', system-ui, sans-serif";
      c.fillText(p.score + ' pts', GIF_W - 66, y);
    });

    // Fastest on the buzzer.
    const names = Object.keys(firstGuessTally);
    let bestName = null, bestCount = 0;
    for (const n of names) if (firstGuessTally[n] > bestCount) { bestCount = firstGuessTally[n]; bestName = n; }
    const footY = GIF_H - 62;
    c.textAlign = 'center';
    if (bestName) {
      c.fillStyle = '#7BE0C0';
      c.font = "800 22px 'Plus Jakarta Sans', system-ui, sans-serif";
      c.fillText('⚡ Quickest on the buzzer: ' + String(bestName).slice(0, 22), GIF_W / 2, footY);
      c.fillStyle = '#8E93B8';
      c.font = "600 17px 'Plus Jakarta Sans', system-ui, sans-serif";
      c.fillText('first to guess in ' + bestCount + (bestCount === 1 ? ' round' : ' rounds'), GIF_W / 2, footY + 26);
    }
    if (logo) c.drawImage(logo, 16, GIF_H - 60, 44, 44);
    c.textAlign = 'right';
    c.fillStyle = '#6C6F91';
    c.font = "700 15px 'Plus Jakarta Sans', system-ui, sans-serif";
    c.fillText('Mivimoose Draw', GIF_W - 18, GIF_H - 20);
    return cv;
  }

  // Called from the end-of-game screen and from the lobby. Only the former
  // has the progress bar, so the lobby button narrates on itself instead.
  async function exportGameGif(fromBtn) {
    if (!gameFrames.length) return;
    if (!window.MiviGIF) { toast("The GIF maker didn't load — try a refresh."); return; }
    const btn = fromBtn || $('btn-gif');
    const inOverlay = btn === $('btn-gif');
    const prog = $('gif-progress');
    const fill = $('gif-bar-fill');
    const label = btn.textContent;
    const say = (text) => {
      if (inOverlay) $('gif-status').textContent = text;
      else btn.textContent = '🎬 ' + text;
    };
    btn.disabled = true;
    if (inOverlay) {
      prog.style.display = 'flex';
      fill.style.width = '0%';
    }
    say('Collecting drawings…');
    try {
      const frames = await buildGifFrames();
      say('Encoding…');
      const blob = await window.MiviGIF.encode(frames, {
        width: GIF_W,
        height: GIF_H,
        delay: 250,
        repeat: 0,
        onProgress: (f) => {
          if (inOverlay) fill.style.width = Math.round(f * 100) + '%';
          say('Encoding… ' + Math.round(f * 100) + '%');
        },
      });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'mivimoose-game.gif';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      // Signed in? Keep a copy in the gallery as well as on disk.
      if (window.MiviAccount.isLoggedIn()) {
        say('Saving to your gallery…');
        try {
          const dataUrl = await blobToDataUrl(blob);
          await API.saveDrawing({
            dataUrl,
            word: 'Game recap · ' + gameFrames.length + ' rounds',
            artist: window.MiviAccount.user().username,
            guessedCount: 0,
            playerCount: (gameState && gameState.players.length) || 0,
            likes: 0,
          });
          toast('🎬 Saved to your gallery too');
        } catch (e) {
          toast('Saved the file — the gallery copy failed: ' + e.message);
        }
      }
      say('Saved!');
      if (inOverlay) fill.style.width = '100%';
      sfx('save');
      if (!inOverlay) setTimeout(() => { btn.textContent = label; }, 2500);
    } catch (e) {
      say('That did not work: ' + e.message);
      if (!inOverlay) setTimeout(() => { btn.textContent = label; }, 4000);
    } finally {
      btn.disabled = false;
    }
  }

  // ── "Pens down" lock ──
  function setCanvasLocked(on) {
    canvasLocked = !!on;
    $('canvas-frame').classList.toggle('locked', canvasLocked);
    // The flash is a moment; this stays for as long as the canvas is frozen,
    // so anyone who looked away still knows why nothing is moving.
    const badge = $('lock-badge');
    if (badge) badge.style.display = canvasLocked ? 'flex' : 'none';
    // Tools go away for the artist; there is nothing left to do with them.
    if (isArtist) $('toolbar').style.display = canvasLocked ? 'none' : 'flex';
    if (canvasLocked) closeTextInput();
  }

  function flashLock(byName) {
    const box = $('lock-flash');
    $('lock-text').textContent = byName ? `Pens down — ${byName} got it!` : 'Pens down!';
    box.classList.remove('show');
    void box.offsetWidth;          // restart the animation
    box.classList.add('show');
    clearTimeout(flashLock._h);
    flashLock._h = setTimeout(() => box.classList.remove('show'), 2600);
  }

  // ── Discord Activity ──
  // Everything here is a no-op on the normal website; the whole block only
  // wakes up when the page is running inside Discord.
  // Sign the player in as their Discord account, from inside the iframe.
  //
  // Two things to know about authorize(): it RESOLVES with an empty code
  // rather than rejecting when Discord declines, and asking for a scope the
  // app is not approved for takes the whole request down with it. So we try
  // the richest scope set first and step down, treating "no code" as failure.
  async function activitySignIn() {
    const D = window.MiviDiscord;
    if (!D || !D.isActivity() || !activityClientId) return false;

    const scopeSets = [
      ['identify', 'guilds', 'rpc.activities.write'],  // …with rich presence
      ['identify', 'guilds'],                          // …without it
      ['identify'],                                    // …bare minimum
    ];
    // 'none' asks Discord to do it silently, which only works for a player who
    // has authorised this app before. The first time round that comes back
    // empty, so we ask again and let Discord show its consent screen.
    const prompts = ['none', 'consent'];
    let code = '';
    let granted = null;
    outer:
    for (const promptMode of prompts) {
      for (const scopes of scopeSets) {
        try {
          const res = await D.authorize(scopes, { prompt: promptMode });
          if (res && res.code) { code = res.code; granted = scopes; break outer; }
        } catch (e) {
          if (window.MIVI_DISCORD_DEBUG) console.warn('authorize failed', promptMode, scopes, e);
        }
      }
    }
    if (!code) return false;

    presenceAllowed = granted.indexOf('rpc.activities.write') !== -1;
    const data = await API.activityLogin(code);
    API.setToken(data.token);
    try { await D.authenticate(data.accessToken); } catch (e) {}

    if (data.user) {
      if (data.user.username) {
        API.lsSet('mivi_name', data.user.username);
        $('home-name').value = data.user.username;
      }
      // Their Discord picture comes back with the account; the server is the
      // one that hands it to everybody else in a room.
      if (data.user.avatarUrl) API.lsSet('mivi_avatar_url', data.user.avatarUrl);
    }
    await window.MiviAccount.init();      // repaint the account chip
    return true;
  }

  // Called by the account modal when someone taps "Continue with Discord"
  // inside the activity — the redirect flow cannot work in an iframe.
  async function retryActivitySignIn() {
    $('modal-auth').style.display = 'none';
    try {
      const ok = await activitySignIn();
      if (!ok) { toast('Discord would not sign you in — you can still play as a guest.'); return; }
      toast('👋 Signed in as ' + (window.MiviAccount.user()?.username || 'you'));
      // Pick the new token up on the socket, unless we are mid-game.
      if (!roomCode) connectSocket();
    } catch (e) {
      toast('❌ ' + (e.message || 'Sign-in failed.'));
    }
  }

  async function bootActivity() {
    const D = window.MiviDiscord;
    if (!D || !D.isActivity()) return false;
    activityMode = true;
    document.body.classList.add('in-activity');

    let cfg = null;
    try { cfg = await API.authConfig(); } catch (e) {}
    if (!cfg || !cfg.clientId) {
      toast('This server has no Discord app configured.');
      return false;
    }

    activityClientId = cfg.clientId;
    const started = await D.init(cfg.clientId);
    if (!started || !started.ok) {
      toast('Could not talk to Discord — playing as a guest.');
      return true; // still an activity, just unauthenticated
    }
    activityCtx = D.context();
    presenceStartedAt = Date.now();

    // Sign them in automatically. If Discord refuses, they carry on as a
    // guest and can retry from the account button — no dead end.
    try {
      const ok = await activitySignIn();
      if (!ok) toast('Playing as a guest — tap your name to sign in with Discord.');
    } catch (e) {
      if (window.MIVI_DISCORD_DEBUG) console.warn('activity sign-in failed', e);
      toast('Playing as a guest — tap your name to sign in with Discord.');
    }

    loadChannelName();
    // Who else is in the voice channel but not yet in the game?
    D.onParticipantsChange(renderActivityNote);
    D.participants().then(renderActivityNote).catch(() => {});
    // Follow Discord's own layout changes when the SDK reports them, and the
    // frame size either way.
    if (typeof D.onLayoutChange === 'function') {
      try { D.onLayoutChange(scheduleActivityLayout); } catch (e) {}
    }
    window.addEventListener('resize', scheduleActivityLayout);
    scheduleActivityLayout();
    return true;
  }

  // Ask Discord what this voice channel is called, so the room card says
  // "#general" rather than a code nobody typed.
  let channelName = null;
  async function loadChannelName() {
    if (!activityMode || !window.MiviDiscord || typeof window.MiviDiscord.channel !== 'function') return;
    try {
      const ch = await window.MiviDiscord.channel();
      if (ch && ch.name) {
        channelName = String(ch.name).slice(0, 40);
        renderActivityNote();
      }
    } catch (e) { /* the permission may not be granted — no harm */ }
  }

  let channelPeople = [];
  function renderActivityNote(list) {
    if (Array.isArray(list)) channelPeople = list;
    const note = $('activity-note');
    if (!activityMode || !note) return;
    // Only meaningful while we are actually in the channel's own game.
    if (gameState && gameState.activity === false) { note.style.display = 'none'; return; }
    const here = gameState ? gameState.players.length : 0;
    const inChannel = channelPeople.length;
    note.style.display = 'block';
    const where = channelName ? `#${channelName}: ` : '';
    note.textContent = where + (inChannel > here
      ? `${here} of ${inChannel} people in the channel are playing — the rest just need to launch the activity.`
      : 'Everyone in the channel is in the game.');
  }

  // Discord shows this on the player's profile while they play.
  let presenceAt = 0;
  let presenceTimer = null;
  function pushPresence() {
    if (!activityMode || !window.MiviDiscord || !presenceAllowed) return;
    const now = Date.now();
    if (now - presenceAt < 5000) {           // Discord rate-limits presence updates
      clearTimeout(presenceTimer);
      presenceTimer = setTimeout(pushPresence, 5000 - (now - presenceAt));
      return;
    }
    presenceAt = now;
    const s = gameState;
    if (!s) return;
    let details = 'In the lobby';
    let state = '';
    if (s.state === 'choosing') {
      details = `Round ${s.round}/${s.totalRounds}`;
      state = 'Picking a word';
    } else if (s.state === 'drawing') {
      details = `Round ${s.round}/${s.totalRounds}`;
      if (isArtist && relayHolderId) state = relayHolderId === myId ? 'Drawing (relay)' : 'Waiting for the pen';
      else state = isArtist ? 'Drawing' : 'Guessing';
    } else if (s.state === 'roundEnd') {
      details = `Round ${s.round}/${s.totalRounds}`;
      state = 'Between rounds';
    } else if (s.state === 'gameEnd') {
      details = 'Final scores';
    }
    // Unlimited games have no "of N" to show.
    if (s.totalRounds === 0 && details.indexOf('Round') === 0) details = `Round ${s.round}`;
    window.MiviDiscord.setActivity({
      details,
      state,
      partySize: s.players.filter(p => p.connected !== false).length,
      partyMax: s.options.maxPlayers,
      // "Playing for 12:34" on the profile, counted from when we joined.
      startedAt: presenceStartedAt,
      largeText: s.managed ? 'Public match' : 'Room ' + s.code,
    });
  }

  function createCustomFromActivity() {
    if (!socket) return;
    sfx('click');
    if (roomCode) socket.emit('leaveRoom');
    roomCode = null;
    gameState = null;
    API.lsDel('mivi_room');
    exitFocusMode();
    socket.emit('createRoom', { name: ensureName(), avatar: myAvatar() });
  }

  // Discord can pop the activity out into a small window. When it is that
  // small there is no room for the side panels, so the drawing takes over —
  // and it goes back to normal when the frame grows again. A manual toggle
  // wins until the size changes again.
  let autoFocusOn = false;
  let autoFocusTimer = null;

  function activityIsSmall() {
    if (window.MiviDiscord && typeof window.MiviDiscord.isSmall === 'function') {
      try { if (window.MiviDiscord.isSmall()) return true; } catch (e) {}
    }
    const h = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
    const w = (window.visualViewport && window.visualViewport.width) || window.innerWidth;
    return h < 620 || w < 900;
  }

  function syncActivityLayout() {
    if (!activityMode) return;
    const inGame = $('screen-game').classList.contains('active');
    const small = inGame && activityIsSmall();
    if (small && !document.body.classList.contains('focus-mode')) {
      autoFocusOn = true;
      enterFocusMode();
    } else if (!small && autoFocusOn && document.body.classList.contains('focus-mode')) {
      autoFocusOn = false;
      exitFocusMode();
    }
  }

  function scheduleActivityLayout() {
    clearTimeout(autoFocusTimer);
    autoFocusTimer = setTimeout(syncActivityLayout, 120);
  }

  function rejoinActivityGame() {
    if (!activityMode || !activityCtx || !socket) return;
    socket.emit('joinActivity', {
      instanceId: activityCtx.instanceId,
      name: ensureName(),
      avatar: myAvatar(),
    });
  }

  // ── Policy / terms reader ──
  // Tucked away: a small line at the bottom of the home screen and nothing
  // else, but it opens inside the app rather than throwing you out to a file.
  async function openLegal(doc) {
    const modal = $('modal-legal');
    $('legal-title').textContent = doc === 'terms' ? 'Terms of Service' : 'Privacy Policy';
    $('legal-body').textContent = 'Loading…';
    modal.style.display = 'flex';
    try {
      const data = await API.legal(doc);
      $('legal-title').textContent = data.title;
      // Server-rendered from our own markdown, with everything escaped there.
      $('legal-body').innerHTML = data.html;
      $('legal-body').scrollTop = 0;
    } catch (e) {
      $('legal-body').textContent = 'Could not load that right now.';
    }
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
  // Themes, in the order the theme button cycles through them.
  // 'midnight' is the default and lives on :root (no data-theme attribute).
  // Each chip is painted in its own theme's colours, so the light themes
  // read as light and always keep their own legible text colour.
  const THEMES = [
    { id: 'midnight', name: 'Midnight',  emoji: '🌙', dot: '#6C5CE7', bg: '#1A1C2E', ink: '#F1F2F9' },
    { id: 'ocean',    name: 'Ocean',     emoji: '🌊', dot: '#1E7FC2', bg: '#101F2E', ink: '#E8F2FA' },
    { id: 'forest',   name: 'Forest',    emoji: '🌲', dot: '#24814F', bg: '#111F18', ink: '#E7F3EB' },
    { id: 'sunset',   name: 'Sunset',    emoji: '🌇', dot: '#D9457C', bg: '#241426', ink: '#FBE9F1' },
    { id: 'noir',     name: 'Noir',      emoji: '🖤', dot: '#55565E', bg: '#141416', ink: '#EDEDEF' },
    { id: 'light',    name: 'Daylight',  emoji: '☀️', dot: '#6C5CE7', bg: '#FFFFFF', ink: '#23263B' },
    { id: 'candy',    name: 'Candy',     emoji: '🍬', dot: '#EC4899', bg: '#FFF5F8', ink: '#4A2437' },
    { id: 'sepia',    name: 'Parchment', emoji: '📜', dot: '#B45309', bg: '#F5EFE3', ink: '#3B3229' },
  ];
  const DEFAULT_THEME = 'midnight';

  function themeById(id) {
    return THEMES.find(t => t.id === id) || THEMES[0];
  }

  function currentTheme() {
    return document.documentElement.getAttribute('data-theme') || DEFAULT_THEME;
  }

  function applyTheme(id, opts) {
    const t = themeById(id);
    if (t.id === DEFAULT_THEME) document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t.id);
    API.lsSet('mivi_theme', t.id);

    const next = THEMES[(THEMES.indexOf(t) + 1) % THEMES.length];
    const btn = $('btn-theme');
    btn.textContent = t.emoji;
    btn.title = `Theme: ${t.name} — click for ${next.name}`;
    document.querySelectorAll('#theme-grid .theme-chip').forEach(c => c.classList.toggle('active', c.dataset.theme === t.id));
    if (opts && opts.announce) toast(`${t.emoji} ${t.name}`);
  }

  function cycleTheme() {
    const i = THEMES.indexOf(themeById(currentTheme()));
    applyTheme(THEMES[(i + 1) % THEMES.length].id, { announce: true });
    sfx('click');
  }

  function buildThemePicker() {
    const grid = $('theme-grid');
    grid.textContent = '';
    for (const t of THEMES) {
      const chip = el('button', 'theme-chip');
      chip.dataset.theme = t.id;
      // Paint the chip in the theme it offers — a swatch you can read.
      chip.style.background = t.bg;
      chip.style.color = t.ink;
      const dot = el('span', 'theme-dot');
      dot.style.background = t.dot;
      chip.appendChild(dot);
      chip.appendChild(el('span', null, t.name));
      chip.addEventListener('click', () => { applyTheme(t.id); sfx('click'); });
      grid.appendChild(chip);
    }
  }

  function applyScale(v) {
    // zoom scales boxes and text together; the old font-size approach only
    // shrank the words and left every card the same size.
    document.body.style.zoom = String(v / 100);
    $('set-scale-val').textContent = v + '%';
    API.lsSet('mivi_scale', String(v));
  }

  function uiZoom() {
    const z = parseFloat(document.body.style.zoom);
    return Number.isFinite(z) && z > 0 ? z : 1;
  }

  // 100% browser zoom on a desktop was visibly oversized; 80% is where the
  // whole site sits comfortably. First visit only; the slider wins after
  // that.
  function defaultScale() {
    return window.innerWidth >= 1100 ? 85 : 100;
  }

  function syncAudioUI() {
    const st = Audio.getState();
    $('set-music-on').checked = st.musicEnabled;
    $('set-sfx-on').checked = st.sfxEnabled;
    $('set-music-vol').value = Math.round(st.musicVolume * 100);
    $('set-sfx-vol').value = Math.round(st.sfxVolume * 100);
    $('btn-music').classList.toggle('off', !st.musicEnabled);
    $('set-music-vol-val').textContent = Math.round(st.musicVolume * 100) + '%';
    $('set-sfx-vol-val').textContent = Math.round(st.sfxVolume * 100) + '%';
  }

  // ── Invite links ──
  function inviteUrl() { return location.origin + '/?join=' + roomCode; }
  function copyInvite() {
    if (!roomCode) return;
    // Inside Discord, hand off to the real invite dialog instead.
    if (activityMode && window.MiviDiscord) {
      window.MiviDiscord.openInvite().catch(() => {});
      return;
    }
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
  // ── In-game settings ──
  // Rather than duplicate every control, the lobby's own panels are moved
  // into the modal and put back afterwards, so all the wiring still applies.
  let settingsMoved = false;

  function openGameSettings() {
    if (!gameState || gameState.managed || gameState.host !== myId) return;
    const body = $('gamesettings-body');
    const wl = $('words-panel');
    const opt = $('options-panel');
    wl.style.display = 'block';
    opt.style.display = 'block';
    body.appendChild(wl);
    body.appendChild(opt);
    settingsMoved = true;
    renderWordLists(gameState.wordLists);
    syncOptions(gameState.options);
    renderMyLists();
    $('gs-toggle-public').checked = !!gameState.public;
    $('modal-gamesettings').style.display = 'flex';
  }

  function closeGameSettings() {
    if (!settingsMoved) { $('modal-gamesettings').style.display = 'none'; return; }
    const right = document.querySelector('.lobby-right');
    const anchor = $('options-readonly');
    if (right && anchor) {
      right.insertBefore($('words-panel'), anchor);
      right.insertBefore($('options-panel'), anchor);
    }
    settingsMoved = false;
    $('modal-gamesettings').style.display = 'none';
  }


  // ══════════ This device remembers your lists and your setup ══════════
  // Both are kept in localStorage rather than on the account, so they follow
  // the browser: sign out, switch accounts, play as a guest — the lists you
  // built and the options you like are still here.
  const MY_LISTS_KEY = 'mivi_device_lists';
  const MY_OPTS_KEY = 'mivi_device_options';
  const MY_LISTS_MAX = 40;
  const MY_LIST_WORDS_MAX = 3000;

  function deviceLists() {
    try {
      const raw = JSON.parse(API.lsGet(MY_LISTS_KEY) || '[]');
      return Array.isArray(raw) ? raw.filter(l => l && l.name && Array.isArray(l.words)) : [];
    } catch (e) { return []; }
  }

  function rememberList(name, words) {
    if (!name || !Array.isArray(words) || !words.length) return;
    try {
      const all = deviceLists().filter(l => l.name.toLowerCase() !== String(name).toLowerCase());
      all.unshift({ name: String(name).slice(0, 40), words: words.slice(0, MY_LIST_WORDS_MAX), at: Date.now() });
      API.lsSet(MY_LISTS_KEY, JSON.stringify(all.slice(0, MY_LISTS_MAX)));
      renderDeviceLists();
    } catch (e) { /* storage full or blocked — not worth interrupting a game */ }
  }

  function forgetList(name) {
    try {
      const all = deviceLists().filter(l => l.name !== name);
      API.lsSet(MY_LISTS_KEY, JSON.stringify(all));
      renderDeviceLists();
    } catch (e) {}
  }

  // Options are remembered as a whole and re-applied when you make a room.
  const REMEMBERED_OPTS = [
    'rounds', 'roundTime', 'pickTime', 'wordChoices', 'hintCount', 'hintSpeed',
    'maxPlayers', 'autocorrectStrength', 'strokeLimit',
    'combinations', 'lockComboParts', 'hidden', 'coopMode', 'relayMode',
    'mirrorMode', 'oneColorMode', 'suddenDeath', 'wetPaint', 'tileReveal',
    'randomRoundTime', 'randomWordChoices', 'showWordSource', 'showPunctuation',
    'avoidRepeats', 'spamProtection', 'textTool', 'sceneBackgrounds', 'lockOnGuess',
  ];

  function rememberOptions(options) {
    if (!options) return;
    try {
      const keep = {};
      for (const k of REMEMBERED_OPTS) if (options[k] !== undefined) keep[k] = options[k];
      API.lsSet(MY_OPTS_KEY, JSON.stringify(keep));
    } catch (e) {}
  }

  function rememberedOptions() {
    try {
      const o = JSON.parse(API.lsGet(MY_OPTS_KEY) || 'null');
      return (o && typeof o === 'object') ? o : null;
    } catch (e) { return null; }
  }

  // Push the remembered setup at a room we have just made.
  function applyRememberedOptions() {
    const o = rememberedOptions();
    if (!o || !gameState || gameState.managed || gameState.host !== myId) return;
    socket.emit('setGameOptions', { options: o });
  }

  // The strip of lists this browser has collected. One click puts one back
  // in the room; the × forgets it.
  function renderDeviceLists() {
    const box = $('wl-saved');
    const row = $('wl-saved-row');
    if (!box || !row) return;
    const mine = deviceLists();
    const canAdd = !!(gameState && !gameState.managed && gameState.host === myId);
    box.style.display = (mine.length && canAdd) ? 'block' : 'none';
    if (!mine.length || !canAdd) return;

    row.textContent = '';
    const inRoom = new Set(
      ((gameState.wordLists && gameState.wordLists.available) || [])
        .map(l => String(l.name).toLowerCase()),
    );

    for (const l of mine) {
      const chip = el('div', 'saved-chip' + (inRoom.has(l.name.toLowerCase()) ? ' in-room' : ''));
      const use = el('button', 'saved-use');
      use.appendChild(el('span', 'saved-name', l.name));
      use.appendChild(el('span', 'saved-count', l.words.length + ''));
      use.title = inRoom.has(l.name.toLowerCase())
        ? l.name + ' is already in this room'
        : 'Add ' + l.name + ' to this room';
      use.disabled = inRoom.has(l.name.toLowerCase());
      use.onclick = () => {
        socket.emit('addCustomList', { name: l.name, text: l.words.join('\n') });
        sfx('click');
      };
      chip.appendChild(use);

      const drop = el('button', 'saved-drop', '✕');
      drop.title = 'Forget ' + l.name + ' on this device';
      drop.onclick = async () => {
        if (!await MiviDialog.confirm(`Forget "${l.name}" on this device? It stays in any room that already has it.`, { confirmLabel: 'Forget', danger: true })) return;
        forgetList(l.name);
      };
      chip.appendChild(drop);
      row.appendChild(chip);
    }
  }

  // ══════════ Word-list cache ══════════
  // The room's catalogue is re-sent on every state update. Remembering the
  // last one per room means a reconnect (or a refresh) paints the lists
  // straight away instead of flashing empty while the socket settles.
  const WL_CACHE_KEY = 'mivi_wl_cache';
  const WL_CACHE_MAX = 8;

  function wlCacheRead() {
    try { return JSON.parse(API.lsGet(WL_CACHE_KEY) || '{}') || {}; } catch (e) { return {}; }
  }

  function wlCacheSave(code, wl) {
    if (!code || !wl) return;
    try {
      const all = wlCacheRead();
      all[code] = { at: Date.now(), wl };
      // Keep the cache small — the handful of rooms you actually revisit.
      const codes = Object.keys(all).sort((a, b) => (all[b].at || 0) - (all[a].at || 0));
      for (const old of codes.slice(WL_CACHE_MAX)) delete all[old];
      API.lsSet(WL_CACHE_KEY, JSON.stringify(all));
    } catch (e) { /* a full or blocked localStorage is not worth a crash */ }
  }

  function wlCacheGet(code) {
    const entry = wlCacheRead()[code];
    // A day old is plenty — beyond that the room has almost certainly moved on.
    if (!entry || Date.now() - (entry.at || 0) > 24 * 60 * 60 * 1000) return null;
    return entry.wl || null;
  }


  // Read a File into a bare base64 string (no data: prefix).
  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || '').replace(/^data:[^,]*,/, ''));
      reader.onerror = () => reject(new Error('That file could not be read.'));
      reader.readAsDataURL(file);
    });
  }

  // ── The moderator word-list generator ──
  function aiStatus(kind, text) {
    const box = $('ai-status');
    box.style.display = text ? 'block' : 'none';
    box.className = 'ai-status ' + kind;
    box.textContent = text || '';
  }

  async function generateAiList() {
    const key = $('ai-key').value.trim();
    const topic = $('ai-topic').value.trim();
    if (!key) return aiStatus('bad', 'Paste a Gemini API key first — aistudio.google.com/apikey.');
    if (!topic) return aiStatus('bad', 'What should the list be about?');

    // Only ever kept if they asked for it.
    if ($('ai-remember').checked) API.lsSet('mivi_gemini_key', key);
    else API.lsDel('mivi_gemini_key');

    const btn = $('btn-ai-generate');
    btn.disabled = true;
    aiStatus('work', '✨ Writing a list about "' + topic + '" — this takes a few seconds…');
    try {
      const res = await API.modGenerateList({ apiKey: key, topic, targetChars: 2000 });
      const name = topic.charAt(0).toUpperCase() + topic.slice(1);
      socket.emit('addCustomList', { name, text: res.words.join('\n') });
      aiStatus('good', `✅ ${res.words.length} words (${res.chars} characters) added as "${name}"` +
        (res.removed ? ` · ${res.removed} filtered out` : ''));
      $('ai-topic').value = '';
      sfx('save');
    } catch (e) {
      aiStatus('bad', '❌ ' + e.message);
    } finally {
      btn.disabled = false;
    }
  }

  // The generator is a moderator tool, so it only appears for moderators.
  // updateLobby() runs on every state update, so the answer is cached per
  // signed-in account rather than asking the server each time.
  let modCheck = { for: undefined, isMod: false };

  // Resolves to true/false and remembers the answer per signed-in account.
  async function amModerator() {
    const acct = window.MiviAccount;
    const who = acct.isLoggedIn() ? acct.user().id : null;
    if (!who) { modCheck = { for: null, isMod: false }; return false; }
    if (modCheck.for === who) return modCheck.isMod;
    modCheck = { for: who, isMod: false };   // assume no until told otherwise
    try {
      const me = await API.modMe();
      if (modCheck.for !== who) return false;   // they signed out mid-flight
      modCheck.isMod = !!me.isMod;
    } catch (e) { /* not a moderator, or offline */ }
    return modCheck.isMod;
  }

  async function syncAiPanel() {
    const box = $('wl-ai');
    if (!box) return;
    box.style.display = (await amModerator()) ? 'flex' : 'none';
  }

  // Offer last game's GIF in the lobby, so ending a game early (or just
  // missing the countdown) does not throw the drawings away.
  function syncLobbyGifButton() {
    const btn = $('btn-lobby-gif');
    if (!btn) return;
    const can = gameFrames.length > 0 && !!window.MiviGIF;
    btn.style.display = can ? 'block' : 'none';
    if (can) btn.textContent = `🎬 Save last game's ${gameFrames.length} drawing${gameFrames.length === 1 ? '' : 's'} as a GIF`;
  }



  // ══════════ Back button closes what's open ══════════
  // On a phone, Back is the natural "get me out of this" gesture. Rather
  // than leaving the game, it dismisses the topmost thing on screen.
  let overlayDepth = 0;

  function pushOverlayState() {
    overlayDepth++;
    try { history.pushState({ mivi: overlayDepth }, ''); } catch (e) {}
  }

  // In closing order — the most recently opened kind of thing goes first.
  function closeTopOverlay() {
    if (textInput) { closeTextInput(); return true; }
    if (typeof emojiDrag !== 'undefined' && emojiDrag) {
      emojiDrag = null;
      if (pctx) pctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
      return true;
    }
    const picker = $('emoji-picker');
    if (picker && picker.style.display !== 'none' && picker.style.display) { picker.style.display = 'none'; return true; }
    const openModal = [...document.querySelectorAll('.modal-backdrop')]
      .reverse()
      .find(m => m.style.display === 'flex' || (m.style.display && m.style.display !== 'none'));
    if (openModal) { openModal.style.display = 'none'; return true; }
    return false;
  }

  function wireBackButton() {
    // Seed one state so the first Back has something to pop.
    try { history.replaceState({ mivi: 0 }, ''); } catch (e) {}
    window.addEventListener('popstate', () => {
      if (closeTopOverlay()) {
        // Keep a state in the stack so the next Back also lands here.
        pushOverlayState();
      }
    });
    // Anything that opens over the page registers a state to pop.
    document.addEventListener('click', (e) => {
      const opener = e.target.closest('[data-opens-overlay]');
      if (opener) pushOverlayState();
    }, true);
  }

  // ══════════ Click an empty patch to start typing ══════════
  // Anywhere that isn't a control, in a room, puts the caret in the chat box.
  function wireClickToType() {
    document.addEventListener('mousedown', (e) => {
      if (!roomCode) return;
      const t = e.target;
      if (t.closest('input, textarea, button, select, a, label, .modal-backdrop, canvas, .swatch, [contenteditable]')) return;
      // Never steal a real text selection.
      const sel = window.getSelection();
      if (sel && String(sel).length > 0) return;
      const box = $('screen-game').classList.contains('active') ? $('game-chat-input') : $('lobby-chat-input');
      if (box && box.offsetParent !== null && document.activeElement !== box) box.focus();
    });
  }

  // ══════════ Drag a list onto the room ══════════
  // Dropping .txt or .zip files on the word-list panel adds them, so nobody
  // has to hunt for the right button.
  function wireListDrop() {
    const zone = $('words-panel');
    if (!zone) return;
    const stop = (e) => { e.preventDefault(); e.stopPropagation(); };

    ['dragenter', 'dragover'].forEach(ev => zone.addEventListener(ev, (e) => {
      if (!canEditRoomLists()) return;
      stop(e);
      e.dataTransfer.dropEffect = 'copy';
      zone.classList.add('drop-target');
    }));
    ['dragleave', 'dragend'].forEach(ev => zone.addEventListener(ev, (e) => {
      if (e.target !== zone && zone.contains(e.relatedTarget)) return;
      zone.classList.remove('drop-target');
    }));

    zone.addEventListener('drop', async (e) => {
      if (!canEditRoomLists()) return;
      stop(e);
      zone.classList.remove('drop-target');
      const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
      if (!files.length) return;
      let added = 0;
      for (const file of files) {
        const lower = file.name.toLowerCase();
        if (lower.endsWith('.zip')) {
          if (!window.MiviAccount.isLoggedIn()) { toast('📚 Sign in to import a zip.'); continue; }
          try {
            const res = await API.importZip(await fileToBase64(file));
            for (const l of res.lists) socket.emit('attachAccountList', { listId: l.id });
            added += res.lists.length;
            renderMyLists();
          } catch (err) { toast('❌ ' + err.message); }
        } else if (lower.endsWith('.txt')) {
          const text = await file.text();
          if (!text.trim()) { toast(`"${file.name}" is empty — skipped.`); continue; }
          socket.emit('addCustomList', { name: file.name.replace(/\.txt$/i, ''), text });
          added++;
        } else {
          toast(`${file.name} isn't a .txt or .zip — skipped.`);
        }
      }
      if (added) sfx('save');
    });
  }

  function canEditRoomLists() {
    const s = gameState;
    return !!(s && !s.managed && s.host === myId);
  }


  // A list somebody sent us by link. Show what is in it and offer to keep it.
  async function openSharedList(token) {
    let list;
    try {
      list = (await API.sharedList(token)).list;
    } catch (e) {
      toast('❌ ' + e.message);
      return;
    }
    const preview = list.words.slice(0, 10).join(', ');
    const keep = await MiviDialog.confirm(
      `${list.author} shared "${list.name}" — ${list.count} words.\n\n${preview}${list.count > 10 ? '…' : ''}`,
      { title: '🔗 A word list for you', confirmLabel: 'Save to my lists' },
    );
    if (!keep) return;
    if (!window.MiviAccount.isLoggedIn()) {
      // Nothing to save it to yet — hold it until they sign in.
      rememberList(list.name, list.words);
      toast('💾 Kept on this device — sign in to save it to your account.');
      return;
    }
    try {
      await API.createList(list.name, list.words);
      rememberList(list.name, list.words);
      toast(`📥 "${list.name}" is in your lists now`);
      window.MiviAccount.refreshLists();
    } catch (e) {
      toast('❌ ' + e.message);
    }
  }


  // ══════════ Leaderboard ══════════
  let lbData = null;
  let lbCat = 'points';

  async function openLeaderboard() {
    sfx('pop');
    $('modal-leaderboard').style.display = 'flex';
    try {
      lbData = await API.leaderboard();
    } catch (e) {
      toast('❌ ' + e.message);
      return;
    }
    renderLeaderboard();
  }

  function renderLeaderboard() {
    if (!lbData) return;
    const cat = lbData.categories[lbCat];
    const rows = $('lb-rows');
    rows.textContent = '';
    if (!cat || !cat.rows.length) {
      rows.appendChild(el('p', 'gallery-empty', 'Nobody on the board yet — stats start counting the first game a signed-in player finishes.'));
    }
    const medals = ['🥇', '🥈', '🥉'];
    for (const r of (cat ? cat.rows : [])) {
      const row = el('div', 'lb-row' + (r.me ? ' me' : ''));
      row.appendChild(el('span', 'lb-rank', r.rank <= 3 ? medals[r.rank - 1] : '#' + r.rank));
      row.appendChild(avatarNode({ avatar: r.avatar || { emoji: '🎨', color: '#6C5CE7' }, avatarUrl: r.avatarUrl }, 'p-avatar'));
      const nm = el('span', 'lb-name', r.username + (r.me ? ' (you)' : ''));
      nm.title = r.username;
      row.appendChild(nm);
      row.appendChild(el('span', 'lb-value', r.value.toLocaleString()));
      rows.appendChild(row);
    }
    const me = $('lb-me');
    if (cat && cat.myRank && !cat.rows.some(r => r.me)) {
      me.style.display = 'flex';
      me.textContent = '';
      me.appendChild(el('span', 'lb-rank', '#' + cat.myRank));
      me.appendChild(el('span', 'lb-name', 'You'));
      me.appendChild(el('span', 'lb-value', (cat.myValue || 0).toLocaleString()));
    } else {
      me.style.display = 'none';
    }
    $('lb-sub').textContent = (cat ? cat.label : '') + ' · ' + lbData.players + ' players with stats';
  }

  // ══════════ Moderator statistics ══════════
  // Charts are plain divs — a charting library would be the first real
  // dependency this project has, for four bar charts.
  let statsRange = '24h';
  let statsData = null;

  function statTile(label, value, hint) {
    const t = el('div', 'stat-tile');
    t.appendChild(el('div', 'stat-value', String(value)));
    t.appendChild(el('div', 'stat-label', label));
    if (hint) t.appendChild(el('div', 'stat-hint', hint));
    return t;
  }

  // Bars, scaled to the tallest value, with the time axis under them.
  function renderBars(host, points, opts = {}) {
    host.textContent = '';
    if (!points || !points.length) {
      host.appendChild(el('p', 'gallery-empty', opts.empty || 'Nothing recorded yet — check back once people have played.'));
      return;
    }
    const valueOf = opts.value || (p => p.peak);
    const max = Math.max(1, ...points.map(valueOf));

    // One line with the area under it — SVG, no library.
    const CW = 1000, CH = 260, PADL = 8, PADB = 8;
    const stepX = points.length > 1 ? (CW - PADL * 2) / (points.length - 1) : 0;
    const yOf = (v) => CH - PADB - (v / max) * (CH - PADB * 2);
    let lineD = '';
    let dots = '';
    points.forEach((p, i) => {
      const x = PADL + i * stepX;
      const y = yOf(valueOf(p));
      lineD += (i ? ' L ' : 'M ') + x.toFixed(1) + ' ' + y.toFixed(1);
      dots += '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="4" class="chart-dot">'
        + '<title>' + (opts.label || 'Peak') + ': ' + valueOf(p) + (opts.fmt ? ' · ' + opts.fmt(p.t) : '') + '</title></circle>';
    });
    const single = points.length === 1;
    const areaD = single ? '' : lineD
      + ' L ' + (PADL + (points.length - 1) * stepX).toFixed(1) + ' ' + (CH - PADB)
      + ' L ' + PADL + ' ' + (CH - PADB) + ' Z';
    const wrap = el('div', 'chart-line');
    wrap.innerHTML =
      '<svg viewBox="0 0 ' + CW + ' ' + CH + '" preserveAspectRatio="none" class="chart-svg">'
      + (areaD ? '<path d="' + areaD + '" class="chart-area"/>' : '')
      + (single ? '' : '<path d="' + lineD + '" class="chart-stroke"/>')
      + '</svg>'
      + '<svg viewBox="0 0 ' + CW + ' ' + CH + '" class="chart-svg chart-dots">' + dots + '</svg>';
    host.appendChild(wrap);

    // A handful of labels along the bottom — more than about six is mush.
    const axis = el('div', 'bar-axis');
    const step = Math.max(1, Math.ceil(points.length / 6));
    for (let i = 0; i < points.length; i += step) {
      axis.appendChild(el('span', null, opts.fmt ? opts.fmt(points[i].t) : ''));
    }
    host.appendChild(axis);

    const scale = el('div', 'bar-scale');
    scale.appendChild(el('span', null, '0'));
    scale.appendChild(el('span', null, String(max)));
    host.appendChild(scale);
  }

  const fmtHour = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric' });
  const fmtDay = (t) => new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
  const fmtMonth = (t) => new Date(t).toLocaleDateString([], { month: 'short' });

  function showStatTab(name) {
    document.querySelectorAll('#stats-tabs .tab').forEach(t => t.classList.toggle('active', t.dataset.stab === name));
    document.querySelectorAll('#modal-stats .tab-pane').forEach(p => p.classList.toggle('active', p.id === 'stab-' + name));
  }

  async function openStats() {
    $('modal-stats').style.display = 'flex';
    showStatTab('players');
    await loadStats();
  }

  async function loadStats() {
    try {
      statsData = await API.modStats(statsRange);
    } catch (e) {
      toast('❌ ' + e.message);
      return;
    }
    renderStats();
  }

  function renderStats() {
    const d = statsData;
    if (!d) return;

    // ── players ──
    const live = d.live || {};
    const tiles = $('stat-tiles-players');
    tiles.textContent = '';
    tiles.appendChild(statTile('Playing right now', live.players || 0, (live.rooms || 0) + ' rooms'));
    tiles.appendChild(statTile('Peak', d.players.peak, 'at once, this range'));
    tiles.appendChild(statTile('Average', d.players.avg, 'concurrent'));
    tiles.appendChild(statTile('Samples', d.players.samples, 'one a minute'));

    const fmt = statsRange === '24h' ? fmtHour : (statsRange === '1y' ? fmtMonth : fmtDay);
    renderBars($('stat-chart-players'), d.players.points, {
      value: p => p.peak, label: 'Peak', fmt,
      empty: 'No readings for this range yet. The server takes one a minute, so a fresh install starts empty.',
    });
    $('stat-players-note').textContent =
      `${d.players.label} — each bar is the highest number of people playing at once in that period.`;

    // ── accounts ──
    const at = $('stat-tiles-accounts');
    at.textContent = '';
    at.appendChild(statTile('Accounts', d.totals.accounts, 'all time'));
    at.appendChild(statTile('Today', d.totals.accountsToday, 'new'));
    at.appendChild(statTile('This week', d.totals.accounts7d, 'new'));
    at.appendChild(statTile('Per day', d.accounts.perDay, 'average'));
    renderBars($('stat-chart-accounts'), d.accounts.points, {
      value: p => p.count, label: 'New accounts', fmt: fmtDay,
      empty: 'No accounts created in this range.',
    });

    // ── moderation ──
    const mt = $('stat-tiles-mods');
    mt.textContent = '';
    mt.appendChild(statTile('Moderators', d.moderation.moderators.length, d.moderation.anyMods ? '' : 'using the ' + d.moderation.bootstrapName + ' fallback'));
    mt.appendChild(statTile('Banned', d.moderation.banned.length, 'from sharing'));
    mt.appendChild(statTile('Shared lists', d.totals.librarySharedLists, d.totals.libraryWords.toLocaleString() + ' words'));
    mt.appendChild(statTile('Downloads', d.totals.libraryDownloads, 'from the library'));
    mt.appendChild(statTile('Personal lists', d.totals.privateLists, 'across all accounts'));
    mt.appendChild(statTile('Drawings kept', d.totals.drawingsSaved, 'in galleries'));

    const fill = (host, rows, render) => {
      host.textContent = '';
      if (!rows.length) { host.appendChild(el('p', 'gallery-empty', 'Nothing here.')); return; }
      for (const r of rows) host.appendChild(render(r));
    };
    fill($('stat-mods'), d.moderation.moderators, (m) => {
      const row = el('div', 'stat-row');
      row.appendChild(el('span', 'stat-row-name', m.username));
      row.appendChild(el('span', 'stat-row-meta', m.since ? new Date(m.since).toLocaleDateString() : ''));
      return row;
    });
    fill($('stat-banned'), d.moderation.banned, (b) => {
      const row = el('div', 'stat-row');
      row.appendChild(el('span', 'stat-row-name', b.username));
      row.appendChild(el('span', 'stat-row-meta', b.reason || 'no reason given'));
      return row;
    });
    fill($('stat-recent'), d.recentShares, (l) => {
      const row = el('div', 'stat-row');
      row.appendChild(el('span', 'stat-row-name', l.name));
      row.appendChild(el('span', 'stat-row-meta', `${l.author} · ${l.count} words`));
      return row;
    });
    fill($('stat-top'), d.topShares, (l) => {
      const row = el('div', 'stat-row');
      row.appendChild(el('span', 'stat-row-name', l.name));
      row.appendChild(el('span', 'stat-row-meta', l.downloads + ' downloads'));
      return row;
    });
  }

  // The whole group only exists for moderators.
  async function syncStatsPanel() {
    const group = $('set-stats-group');
    if (!group) return;
    group.style.display = (await amModerator()) ? 'block' : 'none';
  }

  // ══════════ Public-match voting ══════════
  let currentPoll = null;

  function renderPoll(poll) {
    currentPoll = poll;
    const card = $('poll-card');
    if (!card) return;
    if (!poll) { card.style.display = 'none'; return; }
    card.style.display = 'block';
    $('poll-icon').textContent = poll.kind === 'kick' ? '🥾' : '📋';
    $('poll-q').textContent = poll.proposerName + ' wants to ' + poll.question;
    const detail = $('poll-detail');
    detail.textContent = poll.detail || '';
    detail.style.display = poll.detail ? 'block' : 'none';
    $('poll-clock').textContent = poll.endsIn + 's';
    const pct = poll.needed > 0 ? Math.min(100, (poll.yes / poll.needed) * 100) : 0;
    $('poll-bar-fill').style.width = pct + '%';
    $('poll-tally').textContent = `${poll.yes} of ${poll.needed} needed · ${poll.no} against`;
    // You do not get a vote on your own removal.
    $('poll-actions').style.display = poll.targetKey === myId ? 'none' : 'flex';
  }

  function startVoteKick(playerId, name) {
    MiviDialog.confirm(`Start a vote to kick ${name}?`, { confirmLabel: 'Start vote' }).then(ok => {
      if (ok) socket.emit('startPoll', { kind: 'kick', playerId });
    });
  }

  async function startVoteAddList() {
    const name = await MiviDialog.prompt('What should the list be called?', { placeholder: 'e.g. Cursed objects' });
    if (!name) return;
    const text = await MiviDialog.prompt('Paste the words — one per line, or commas between them.', { multiline: true, placeholder: 'apple\nbanana\ncherry' });
    if (!text) return;
    socket.emit('startPoll', { kind: 'addList', name, text });
  }

  // ══════════ The round's modes, on screen ══════════
  let strokeBudget = null;   // { used, limit } while a stroke limit is on

  function renderModeBanner() {
    const box = $('mode-banner');
    if (!box) return;
    const s = gameState;
    const bits = [];
    if (s && s.state === 'drawing') {
      if (s.options.mirrorMode) bits.push('🪞 Mirrored');
      if (s.options.oneColorMode && roundColor) bits.push('🎨 One colour');
      if (s.options.suddenDeath) bits.push('⚡ Sudden death');
      if (s.options.wetPaint) bits.push(isArtist ? '🖌️ Wet paint — work right' : '🖌️ Wet paint');
      if (s.options.tileReveal && openTiles) {
        const shut = TILE_COLS * TILE_ROWS - openTiles.size;
        if (shut > 0 && !isArtist) bits.push(`🪟 ${shut} shutter${shut === 1 ? '' : 's'} still down`);
      }
      if (strokeBudget && strokeBudget.limit > 0) {
        const left = Math.max(0, strokeBudget.limit - strokeBudget.used);
        bits.push(`✏️ ${left} stroke${left === 1 ? '' : 's'} left`);
      }
    }
    box.textContent = bits.join('  ·  ');
    box.style.display = bits.length ? 'block' : 'none';
    box.classList.toggle('spent', !!(strokeBudget && strokeBudget.limit > 0 && strokeBudget.used >= strokeBudget.limit));
  }

  // One Colour hands the artist a single shade and takes the palette away.
  let roundColor = null;
  function applyRoundColor() {
    const box = $('palette');
    if (!box) return;
    const locked = !!roundColor;
    box.classList.toggle('one-color', locked);
    box.querySelectorAll('.swatch').forEach(sw => { sw.disabled = locked; });
    if (locked) {
      currentColor = roundColor;
      box.style.setProperty('--locked-color', roundColor);
      // The one swatch that still means anything is the round's own colour.
      box.querySelectorAll('.swatch').forEach(sw => sw.classList.remove('active'));
    }
  }


  // ══════════ Wet Paint ══════════
  // A dry line sweeps across the canvas; anything behind it has set. The
  // server is what actually refuses the marks — this is the artist's warning
  // so they are not drawing into a void and wondering why nothing appears.
  let dryX = 0;

  function renderDryLine(x) {
    dryX = Math.max(0, Math.min(CANVAS_W, x || 0));
    const box = $('dry-overlay');
    if (!box) return;
    const on = !!(gameState && gameState.options.wetPaint && gameState.state === 'drawing');
    box.style.display = on ? 'block' : 'none';
    if (on) box.style.setProperty('--dry', (dryX / CANVAS_W * 100) + '%');
  }

  // True when this point is in paint that has already set.
  function inDryZone(p) {
    if (!gameState || !gameState.options.wetPaint) return false;
    return dryX > 0 && p.x < dryX + (brushSize / 2);
  }

  // ══════════ Tile Reveal ══════════
  // Guessers watch the canvas through twelve shutters that lift one at a
  // time. The hidden marks are never sent to them, so this is only the
  // frosting over ground that was never painted.
  const TILE_COLS = 4, TILE_ROWS = 3;
  let openTiles = null;      // null = the mode is off

  function buildShutters() {
    const box = $('tile-shutters');
    if (!box || box.dataset.built === '1') return;
    box.dataset.built = '1';
    for (let i = 0; i < TILE_COLS * TILE_ROWS; i++) {
      const t = el('i', 'shutter');
      t.dataset.tile = String(i);
      t.style.left = ((i % TILE_COLS) / TILE_COLS * 100) + '%';
      t.style.top = (Math.floor(i / TILE_COLS) / TILE_ROWS * 100) + '%';
      t.style.width = (100 / TILE_COLS) + '%';
      t.style.height = (100 / TILE_ROWS) + '%';
      box.appendChild(t);
    }
  }

  function renderShutters(open, justOpened) {
    const box = $('tile-shutters');
    if (!box) return;
    buildShutters();
    openTiles = open ? new Set(open) : null;
    // The artist sees their own canvas whole — the shutters are the guessers'
    // problem, and covering the artist's work would make the mode unplayable.
    const on = !!(openTiles && gameState && gameState.state === 'drawing' && !isArtist);
    box.style.display = on ? 'block' : 'none';
    if (!on) return;
    box.querySelectorAll('.shutter').forEach(node => {
      const i = Number(node.dataset.tile);
      const isOpen = openTiles.has(i);
      node.classList.toggle('open', isOpen);
      if (isOpen && justOpened && justOpened.indexOf(i) !== -1) {
        node.classList.remove('lifting');
        void node.offsetWidth;                 // restart the animation
        node.classList.add('lifting');
      }
    });
  }

  function clearModeOverlays() {
    dryX = 0;
    openTiles = null;
    const dry = $('dry-overlay');
    if (dry) dry.style.display = 'none';
    const sh = $('tile-shutters');
    if (sh) sh.style.display = 'none';
  }

  // ══════════ Untimed rounds ══════════
  function syncFinishButton() {
    const btn = $('btn-finish-drawing');
    if (!btn) return;
    const s = gameState;
    const untimed = !!(s && s.roundSeconds === 0);
    btn.style.display = (untimed && isArtist && s.state === 'drawing' && !canvasLocked && !relayBlocksMe())
      ? 'block' : 'none';
  }

  // ══════════ Chat history (↑ recalls what you last said) ══════════
  const chatHistory = { game: [], lobby: [] };
  let chatCursor = { game: -1, lobby: -1 };

  function rememberSent(which, text) {
    const h = chatHistory[which];
    if (!text || h[h.length - 1] === text) { chatCursor[which] = -1; return; }
    h.push(text);
    if (h.length > 50) h.shift();
    chatCursor[which] = -1;
  }

  // ↑ walks back through what you sent, ↓ walks forward again.
  function wireChatHistory(input, which) {
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      const h = chatHistory[which];
      if (!h.length) return;
      // Only hijack the arrows when the caret has nowhere else to go.
      if (e.key === 'ArrowUp' && input.selectionStart !== 0 && input.value) return;
      e.preventDefault();
      if (e.key === 'ArrowUp') {
        chatCursor[which] = chatCursor[which] < 0 ? h.length - 1 : Math.max(0, chatCursor[which] - 1);
      } else {
        if (chatCursor[which] < 0) return;
        chatCursor[which]++;
        if (chatCursor[which] >= h.length) {   // past the newest — back to a blank line
          chatCursor[which] = -1;
          input.value = '';
          return;
        }
      }
      input.value = h[chatCursor[which]];
      requestAnimationFrame(() => { input.selectionStart = input.selectionEnd = input.value.length; });
    });
  }

  // ══════════ Relay pen ══════════
  function renderRelayBar(info) {
    let bar = $('relay-bar');
    if (!info || !info.holderId) {
      if (bar) bar.remove();
      relayHolderId = null;
      return;
    }
    relayHolderId = info.holderId;
    if (!bar) {
      bar = el('div', 'relay-bar');
      bar.id = 'relay-bar';
      bar.innerHTML = '<span class="relay-who"></span>'
        + '<span class="relay-meter"><i></i></span>'
        + '<span class="relay-secs"></span>';
      const card = $('canvas-card');
      card.insertBefore(bar, card.firstChild);
    }
    const mine = info.holderId === myId;
    bar.classList.toggle('mine', mine);
    bar.querySelector('.relay-who').textContent = mine
      ? '✏️ Your turn with the pen'
      : '⏳ ' + info.holderName + ' has the pen';
    const pct = Math.max(0, Math.min(100, (info.seconds / (info.slice || 1)) * 100));
    bar.querySelector('.relay-meter i').style.width = pct + '%';
    bar.querySelector('.relay-secs').textContent = info.seconds + 's';
    // Only the artist holding the baton may actually draw.
    if (isArtist) $('toolbar').style.display = (canvasLocked || relayBlocksMe()) ? 'none' : 'flex';
    $('canvas-frame').classList.toggle('relay-waiting', relayBlocksMe());
  }

  // Whether this client is allowed to put marks on the canvas right now.
  function relayBlocksMe() {
    return !!(relayHolderId && isArtist && relayHolderId !== myId);
  }

  // ── List library ──
  function showLibTab(name) {
    document.querySelectorAll('#modal-library .tab').forEach(t => t.classList.toggle('active', t.dataset.libtab === name));
    document.querySelectorAll('#modal-library .tab-pane').forEach(p => p.classList.toggle('active', p.id === 'libtab-' + name));
    if (name === 'upload') syncLibraryUploadForm();
    if (name === 'mine') refreshMyLibraryLists();
    if (name === 'browse') refreshLibrary();
  }

  function openLibrary() {
    sfx('pop');
    $('modal-library').style.display = 'flex';
    showLibTab('browse');
    // Paint the last visit's shelf immediately; the fresh fetch replaces it.
    try {
      const cached = JSON.parse(API.lsGet('mivi_lib_cache') || 'null');
      if (cached && Array.isArray(cached.lists) && !$('lib-rows').children.length) {
        for (const l of cached.lists) $('lib-rows').appendChild(libCard(l));
      }
    } catch (e) {}
    refreshLibrary();
    setTimeout(() => { const q = $('lib-q'); if (q) q.focus(); }, 60);
  }

  let uploadTags = [];

  function syncLibraryUploadForm() {
    renderTagPicker($('lib-tagpick'), uploadTags);
    const acct = window.MiviAccount;
    const needLogin = !acct.isLoggedIn(); // sharing always needs an account
    $('lib-upload-form').style.display = needLogin ? 'none' : 'flex';
    $('lib-need-login').style.display = needLogin ? 'flex' : 'none';
  }

  // ══════════ The list library ══════════
  // A browser with search, filters and detail cards. The server does the
  // matching so the whole library never has to come down the wire.
  const LIB_PAGE = 30;
  let libState = { q: '', sort: 'popular', tag: '', difficulty: '', author: '', minWords: '', maxWords: '', offset: 0 };
  let libTags = [];
  let libSelected = null;      // the list open in the detail modal

  function libQuery(extra) {
    return Object.assign({
      q: libState.q,
      sort: libState.sort,
      tag: libState.tag,
      difficulty: libState.difficulty,
      author: libState.author,
      minWords: libState.minWords,
      maxWords: libState.maxWords,
      limit: LIB_PAGE,
      offset: libState.offset,
    }, extra || {});
  }

  const DIFF_BADGE = { easy: ['Easy', 'good'], medium: ['Medium', 'warn'], hard: ['Hard', 'bad'] };

  function libCard(l, opts = {}) {
    const card = el('div', 'lib-card');

    const head = el('div', 'lib-card-head');
    const name = el('div', 'lib-card-name', l.name);
    name.title = l.name;
    head.appendChild(name);
    const diff = DIFF_BADGE[l.difficulty];
    if (diff) head.appendChild(el('span', 'lib-badge ' + diff[1], diff[0]));
    card.appendChild(head);

    card.appendChild(el('div', 'lib-card-by', `${l.count} words · by ${l.author}`));

    if (l.description) {
      const d = el('div', 'lib-card-desc', l.description);
      card.appendChild(d);
    } else {
      card.appendChild(el('div', 'lib-card-desc muted', 'No description yet.'));
    }

    if (l.preview && l.preview.length) {
      card.appendChild(el('div', 'lib-card-preview', l.preview.slice(0, 6).join(' · ')));
    }

    if (l.tags && l.tags.length) {
      const tags = el('div', 'lib-card-tags');
      for (const t of l.tags) {
        const chip = el('button', 'lib-tag', t);
        chip.onclick = () => { libState.tag = t; libState.offset = 0; syncTagBar(); refreshLibrary(); };
        tags.appendChild(chip);
      }
      card.appendChild(tags);
    }

    const foot = el('div', 'lib-card-foot');
    foot.appendChild(el('span', 'lib-dl', '⬇️ ' + l.downloads));

    const info = el('button', 'lib-act', 'ℹ️');
    info.title = 'What is in this list?';
    info.onclick = () => openListInfo(l.id);
    foot.appendChild(info);

    const dl = el('button', 'lib-act', '💾');
    dl.title = 'Download as .txt';
    dl.onclick = () => {
      const a = document.createElement('a');
      a.href = API.libraryDownloadUrl(l.id);
      a.download = '';
      a.click();
    };
    foot.appendChild(dl);

    if (window.MiviApp && window.MiviApp.canAddRoomList && window.MiviApp.canAddRoomList()) {
      const use = el('button', 'lib-act primary', '🎮');
      use.title = 'Use in my room';
      use.onclick = () => useListInRoom(l.id);
      foot.appendChild(use);
    }

    if (l.mine || opts.mine) {
      const edit = el('button', 'lib-act', '✏️');
      edit.title = 'Edit this list';
      edit.onclick = () => openListInfo(l.id, { edit: true });
      foot.appendChild(edit);
    }

    if (l.canModerate && !l.mine) {
      const take = el('button', 'lib-act danger', '🚫');
      take.title = 'Moderator: take it down';
      take.onclick = () => moderateList(l);
      foot.appendChild(take);
    }

    card.appendChild(foot);
    return card;
  }

  async function useListInRoom(id) {
    try {
      const d = await API.libraryList(id);
      window.MiviApp.addRoomList(d.list.name, d.list.words.join('\n'));
      $('modal-library').style.display = 'none';
      $('modal-listinfo').style.display = 'none';
      toast(`🎮 "${d.list.name}" is in your room's lists now`);
    } catch (e) { toast('❌ ' + e.message); }
  }

  async function moderateList(l) {
    if (!await MiviDialog.confirm(`Take "${l.name}" down? It disappears for everyone.`, { confirmLabel: 'Take it down', danger: true })) return;
    try { await API.libraryDelete(l.id); toast('🗑️ Taken down'); refreshLibrary(); }
    catch (e) { toast('❌ ' + e.message); }
  }

  function syncTagBar() {
    const bar = $('lib-tagbar');
    if (!bar) return;
    bar.textContent = '';
    const all = el('button', 'lib-tag' + (libState.tag ? '' : ' on'), 'All');
    all.onclick = () => { libState.tag = ''; libState.offset = 0; syncTagBar(); refreshLibrary(); };
    bar.appendChild(all);
    for (const f of libTags) {
      const chip = el('button', 'lib-tag' + (libState.tag === f.tag ? ' on' : ''), `${f.tag} ${f.count}`);
      chip.onclick = () => {
        libState.tag = libState.tag === f.tag ? '' : f.tag;
        libState.offset = 0;
        syncTagBar();
        refreshLibrary();
      };
      bar.appendChild(chip);
    }
  }

  let libSeq = 0;
  async function refreshLibrary(append) {
    const rows = $('lib-rows');
    const seq = ++libSeq;
    if (!append) { rows.textContent = ''; libState.offset = 0; }
    let data;
    try {
      data = await API.library(libQuery());
    } catch (e) {
      toast('❌ ' + e.message);
      return;
    }
    if (seq !== libSeq) return;              // a newer search overtook this one

    // Remember an unfiltered first page for the instant paint next visit.
    if (!append && !libState.q && !libState.tag && !libState.difficulty && !libState.author) {
      try { API.lsSet('mivi_lib_cache', JSON.stringify({ lists: data.lists.slice(0, 30) })); } catch (e) {}
    }

    if (!append) rows.textContent = '';
    for (const l of data.lists) rows.appendChild(libCard(l));

    libTags = data.facets ? data.facets.tags : [];
    syncTagBar();

    const authors = $('lib-authors');
    if (authors && data.facets) {
      authors.textContent = '';
      for (const a of data.facets.authors) {
        const o = document.createElement('option');
        o.value = a;
        authors.appendChild(o);
      }
    }

    const shown = rows.children.length;
    $('lib-empty').style.display = shown ? 'none' : 'block';
    $('btn-lib-more').style.display = shown < data.total ? 'block' : 'none';
    $('lib-count-note').textContent = data.total
      ? `${shown} of ${data.total} list${data.total === 1 ? '' : 's'}` + (data.total < data.libraryTotal ? ` (${data.libraryTotal} in all)` : '')
      : '';
  }

  async function refreshMyLibraryLists() {
    const rows = $('lib-mine-rows');
    if (!rows) return;
    rows.textContent = '';
    if (!window.MiviAccount.isLoggedIn()) {
      $('lib-mine-empty').style.display = 'block';
      $('lib-mine-empty').textContent = 'Sign in to see the lists you have shared.';
      return;
    }
    let data;
    try { data = await API.library({ mine: 1, limit: 200, sort: 'newest' }); }
    catch (e) { toast('❌ ' + e.message); return; }
    for (const l of data.lists) rows.appendChild(libCard(l, { mine: true }));
    $('lib-mine-empty').style.display = data.lists.length ? 'none' : 'block';
  }

  // ── One list, up close ──
  function renderTagPicker(box, selected, onChange) {
    box.textContent = '';
    const all = libTags.length ? libTags.map(f => f.tag) : LIB_ALL_TAGS;
    for (const t of LIB_ALL_TAGS) {
      const chip = el('button', 'lib-tag' + (selected.includes(t) ? ' on' : ''), t);
      chip.onclick = () => {
        const i = selected.indexOf(t);
        if (i >= 0) selected.splice(i, 1);
        else if (selected.length < 4) selected.push(t);
        else { toast('Four tags is the limit.'); return; }
        renderTagPicker(box, selected, onChange);
        if (onChange) onChange(selected);
      };
      box.appendChild(chip);
    }
  }

  const LIB_ALL_TAGS = [
    'general', 'animals', 'food', 'objects', 'places', 'people',
    'nature', 'science', 'sport', 'music', 'film-tv', 'games',
    'anime', 'memes', 'hard', 'easy', 'kids', 'other',
  ];

  async function openListInfo(id, opts = {}) {
    let list;
    try { list = (await API.libraryList(id)).list; }
    catch (e) { toast('❌ ' + e.message); return; }
    libSelected = list;

    $('li-title').textContent = list.name;
    $('li-byline').textContent = `by ${list.author} · shared ${new Date(list.created).toLocaleDateString()}`;

    const badges = $('li-badges');
    badges.textContent = '';
    const diff = DIFF_BADGE[list.difficulty];
    if (diff) badges.appendChild(el('span', 'lib-badge ' + diff[1], diff[0]));
    for (const t of (list.tags || [])) badges.appendChild(el('span', 'lib-badge', t));

    $('li-desc').textContent = list.description || 'The author has not written a description for this one.';
    $('li-desc').classList.toggle('muted', !list.description);

    $('li-stats').textContent = `${list.count} words · ${list.downloads} download${list.downloads === 1 ? '' : 's'}`;

    // A generous sample, not the whole thing — the point is to judge it.
    const words = $('li-words');
    words.textContent = '';
    for (const w of list.words.slice(0, 120)) words.appendChild(el('span', 'li-word', w));
    if (list.words.length > 120) words.appendChild(el('span', 'li-word muted', `+${list.words.length - 120} more`));

    const canUse = !!(window.MiviApp && window.MiviApp.canAddRoomList && window.MiviApp.canAddRoomList());
    $('btn-li-use').style.display = canUse ? 'inline-block' : 'none';
    $('btn-li-edit').style.display = list.mine ? 'inline-block' : 'none';
    $('btn-li-delete').style.display = list.mine ? 'inline-block' : 'none';
    $('li-edit').style.display = 'none';
    $('li-edit-error').textContent = '';

    $('modal-listinfo').style.display = 'flex';
    if (opts.edit && list.mine) startListEdit();
  }

  let editTags = [];
  function startListEdit() {
    const l = libSelected;
    if (!l) return;
    editTags = [...(l.tags || [])];
    $('li-edit-name').value = l.name;
    $('li-edit-desc').value = l.description || '';
    $('li-edit-words').value = l.words.join('\n');
    renderTagPicker($('li-edit-tags'), editTags);
    updateEditCount();
    $('li-edit').style.display = 'block';
    $('li-edit-name').focus();
  }

  function updateEditCount() {
    const n = $('li-edit-words').value.split(/[\n,]+/).map(w => w.trim()).filter(Boolean).length;
    $('li-edit-count').textContent = n + (n === 1 ? ' word' : ' words');
  }

  async function saveListEdit() {
    const l = libSelected;
    if (!l) return;
    const words = $('li-edit-words').value.split(/[\n,]+/).map(w => w.trim()).filter(Boolean);
    if (!words.length) { $('li-edit-error').textContent = 'A list needs at least one word.'; return; }
    const btn = $('btn-li-save');
    btn.disabled = true;
    try {
      await API.libraryUpdate(l.id, {
        name: $('li-edit-name').value.trim(),
        description: $('li-edit-desc').value.trim(),
        tags: editTags,
        words,
      });
      toast('💾 List updated');
      $('modal-listinfo').style.display = 'none';
      refreshLibrary();
      refreshMyLibraryLists();
    } catch (e) {
      $('li-edit-error').textContent = e.message;
    } finally {
      btn.disabled = false;
    }
  }

  // A plain viewer: every word in a list, with a filter box.
  let wordsModalWords = [];
  function openWordsModal(title, ws) {
    wordsModalWords = ws || [];
    $('mw-title').textContent = title;
    $('mw-sub').textContent = wordsModalWords.length + (wordsModalWords.length === 1 ? ' word' : ' words');
    $('mw-search').value = '';
    renderWordsModal('');
    $('modal-words').style.display = 'flex';
    setTimeout(() => $('mw-search').focus(), 50);
  }

  function renderWordsModal(q) {
    const box = $('mw-words');
    box.textContent = '';
    const query = String(q || '').trim().toLowerCase();
    let shown = 0;
    for (const w of wordsModalWords) {
      if (query && w.toLowerCase().indexOf(query) === -1) continue;
      box.appendChild(el('span', 'li-word', w));
      shown++;
    }
    if (!shown) box.appendChild(el('span', 'li-word muted', query ? 'nothing matches' : 'empty list'));
  }

  // Same splitting rule the server uses, so what we cache matches what the
  // room actually got.
  function parseWordText(text) {
    const seen = new Set();
    const out = [];
    for (const raw of String(text || '').split(/[\r\n,]+/)) {
      const w = raw.replace(/\s+/g, ' ').trim().slice(0, 64);
      if (!w) continue;
      const k = w.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(w);
    }
    return out;
  }

  // The words behind a room list, fetched once and cached for the round.
  const roomListCache = {};
  function roomListWords(name) {
    if (roomListCache[name]) return Promise.resolve(roomListCache[name]);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { socket.off('customListWords', on); reject(new Error('The server did not answer.')); }, 6000);
      const on = (payload) => {
        if (!payload || payload.name !== name) return;
        clearTimeout(t);
        socket.off('customListWords', on);
        roomListCache[name] = payload.words || [];
        resolve(roomListCache[name]);
      };
      socket.on('customListWords', on);
      socket.emit('getCustomList', { name });
    });
  }

  function libWords() {
    return $('lib-words').value.split(/[\n,]+/).map(w => w.trim()).filter(Boolean);
  }

  // Share every .txt in a folder as its own list. The file name becomes the
  // list name; anything empty or rejected is reported at the end.
  async function uploadFolder(fileList) {
    const files = Array.from(fileList || []).filter(f => /\.txt$/i.test(f.name));
    if (!files.length) { toast('No .txt files in there.'); return; }
    if (!window.MiviAccount.isLoggedIn()) { showLibTab('upload'); return; }
    if (files.length > 40) { toast('That is a lot — 40 lists at a time, max.'); return; }
    const note = $('lib-count-note');
    let done = 0, skipped = 0, cleaned = 0;
    for (const file of files) {
      note.textContent = `Sharing ${done + skipped + 1} of ${files.length}…`;
      const text = await file.text().catch(() => '');
      const words = text.split(/[\n,]+/).map(w => w.trim()).filter(Boolean);
      const name = file.name.replace(/\.txt$/i, '').slice(0, 40).trim() || 'Imported list';
      if (!words.length) { skipped++; continue; }
      try {
        const res = await API.libraryUpload({ name, words, description: $('lib-desc').value.trim(), tags: uploadTags });
        cleaned += res.removedBySwearFilter || 0;
        done++;
      } catch (e) { skipped++; }
    }
    note.textContent = '';
    toast(`📁 Shared ${done} list${done === 1 ? '' : 's'}${skipped ? `, skipped ${skipped}` : ''}${cleaned ? `, filtered ${cleaned} word${cleaned === 1 ? '' : 's'}` : ''}`);
    refreshLibrary();
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
      const res = await API.libraryUpload({
        name, words,
        description: $('lib-desc').value.trim(),
        tags: uploadTags,
      });
      const removed = res.removedBySwearFilter || 0;
      toast(removed
        ? `📚 Shared! Swear protection dropped ${removed} word${removed === 1 ? '' : 's'}.`
        : `📚 "${res.list.name}" is in the library!`);
      $('lib-name').value = '';
      $('lib-desc').value = '';
      $('lib-words').value = '';
      uploadTags = [];
      renderTagPicker($('lib-tagpick'), uploadTags);
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
    buildThemePicker();
    // 'dark' was the old id for what is now Midnight.
    const savedTheme = API.lsGet('mivi_theme');
    applyTheme(savedTheme === 'dark' ? 'midnight' : (savedTheme || DEFAULT_THEME));
    let scale = parseInt(API.lsGet('mivi_scale'), 10) || defaultScale();
    if (scale === 90 && window.innerWidth >= 1100 && !API.lsGet('mivi_scale_v2')) scale = 80;
    API.lsSet('mivi_scale_v2', '1');
    if (scale === 80 && window.innerWidth >= 1100 && !API.lsGet('mivi_scale_v3')) scale = 85;
    API.lsSet('mivi_scale_v3', '1');
    $('set-scale').value = scale;
    applyScale(scale);
    $('home-name').value = API.lsGet('mivi_name') || '';

    setupCanvas();
    buildToolsUI();
    buildAvatarPicker();
    renderAvatarBubble();
    syncAudioUI();

    // Somebody shared a word list with us?
    const params = new URLSearchParams(location.search);
    const sharedToken = params.get('list');
    if (sharedToken) {
      history.replaceState(null, '', location.pathname);
      openSharedList(sharedToken);
    }

    // Invite link?
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

    // Discord Activity, if that is where we are. This may sign the player in,
    // so it has to happen before the account check and the socket connect.
    await bootActivity();

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
    $('brand-home').addEventListener('click', async () => {
      if (roomCode && !await MiviDialog.confirm('Leave the current room?', { confirmLabel: 'Leave' })) return;
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
    document.querySelectorAll('.home-legal a').forEach(a => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        openLegal(a.dataset.doc || 'privacy');
      });
    });

    // ── Wire lobby ──
    $('lobby-code').addEventListener('click', () => {
      navigator.clipboard.writeText(roomCode).then(() => toast('📋 Code copied!'));
    });
    $('btn-copy-code').addEventListener('click', () => {
      navigator.clipboard.writeText(roomCode).then(() => toast('📋 Code copied!'));
    });
    $('btn-copy-invite').addEventListener('click', copyInvite);
    $('btn-invite-top').addEventListener('click', copyInvite);
    $('gt-invite').addEventListener('click', copyInvite);
    $('gt-code').addEventListener('click', copyInvite);
    $('gt-leave').addEventListener('click', () => $('btn-leave').click());
    $('gt-endgame').addEventListener('click', () => $('btn-endgame').click());
    $('gt-settings').addEventListener('click', openGameSettings);
    $('gs-toggle-public').addEventListener('change', (e) => socket.emit('setRoomPublic', { public: e.target.checked }));
    $('toggle-public').addEventListener('change', (e) => socket.emit('setRoomPublic', { public: e.target.checked }));
    $('btn-start').addEventListener('click', () => socket.emit('startGame'));
    $('lobby-chat-send').addEventListener('click', sendLobbyChat);
    $('lobby-chat-input').addEventListener('keydown', e => { if (e.key === 'Enter') sendLobbyChat(); });

    $('btn-add-list').addEventListener('click', () => {
      const name = $('cl-name').value.trim();
      const text = $('cl-words').value.trim();
      if (!name) { toast('Name the list first.'); return; }
      if (!text) { toast('It needs some words first.'); return; }
      pendingListWords[name] = parseWordText(text);
      socket.emit('addCustomList', { name, text });
      $('cl-name').value = '';
      $('cl-words').value = '';
    });
    $('btn-import-list').addEventListener('click', () => $('import-file').click());
    $('import-file').addEventListener('change', (e) => {
      Array.from(e.target.files || []).forEach(file => {
        const reader = new FileReader();
        reader.onload = (ev) => {
          const text = String(ev.target.result || '').trim();
          const name = file.name.replace(/\.txt$/i, '');
          if (!text) { toast(`"${name}" is empty — skipped.`); return; }
          pendingListWords[name] = parseWordText(text);
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
        markUiBusy();
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
    $('btn-voteskip').addEventListener('click', () => {
      if (gameState && gameState.managed) { voteSkipUsed = true; updateLikeSkipUI(); }
      socket.emit('voteSkip');
    });
    $('tool-scene').addEventListener('click', openScenePicker);
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
      const toolMap = { b: 'pen', e: 'eraser', g: 'fill', l: 'line', r: 'rect', c: 'circle', t: 'triangle', x: 'text', m: 'emoji' };
      if (toolMap[k]) setTool(toolMap[k]);
    });

    // ── Topbar buttons ──
    $('btn-theme').addEventListener('click', cycleTheme);
    $('btn-music').addEventListener('click', () => {
      Audio.init();
      const st = Audio.getState();
      Audio.setMusicEnabled(!st.musicEnabled);
      if (!st.musicEnabled) Audio.startMusic();
      syncAudioUI();
    });
    $('btn-settings').addEventListener('click', () => {
      syncAudioUI();
      syncStatsPanel();
      $('modal-settings').style.display = 'flex';
    });
    $('set-music-on').addEventListener('change', e => { Audio.init(); Audio.setMusicEnabled(e.target.checked); if (e.target.checked) Audio.startMusic(); syncAudioUI(); });
    $('set-sfx-on').addEventListener('change', e => { Audio.setSfxEnabled(e.target.checked); });
    $('set-music-vol').addEventListener('input', e => {
      Audio.setMusicVolume(e.target.value / 100);
      $('set-music-vol-val').textContent = e.target.value + '%';
    });
    $('set-sfx-vol').addEventListener('input', e => {
      Audio.setSfxVolume(e.target.value / 100);
      $('set-sfx-vol-val').textContent = e.target.value + '%';
    });
    $('set-scale').addEventListener('input', e => applyScale(parseInt(e.target.value, 10)));

    // ── List odds (lobby) ──
    $('btn-list-odds').addEventListener('click', () => {
      const box = $('list-odds');
      const show = box.style.display === 'none';
      box.style.display = show ? 'flex' : 'none';
      $('btn-list-odds').textContent = show ? 'ℹ️ Hide odds' : 'ℹ️ Odds';
      if (show) renderListOdds();
    });

    $('btn-zip-lists').addEventListener('click', () => {
      const btn = $('btn-zip-lists');
      btn.disabled = true;
      btn.textContent = '⏳ Zipping…';
      socket.emit('exportRoomLists');
      // The button comes back either way — the server answers with the file
      // or with an error toast.
      clearTimeout(btn._h);
      btn._h = setTimeout(() => { btn.disabled = false; btn.textContent = '⬇️ Download all'; }, 8000);
    });

    // ── List library ──

    // ── The library hub ──
    let libSearchTimer = null;
    $('lib-q').addEventListener('input', (e) => {
      const v = e.target.value;
      $('lib-q-clear').style.display = v ? 'block' : 'none';
      clearTimeout(libSearchTimer);
      libSearchTimer = setTimeout(() => { libState.q = v.trim(); refreshLibrary(); }, 250);
    });
    $('lib-q-clear').addEventListener('click', () => {
      $('lib-q').value = '';
      $('lib-q-clear').style.display = 'none';
      libState.q = '';
      refreshLibrary();
      $('lib-q').focus();
    });
    $('lib-sort').addEventListener('change', (e) => { libState.sort = e.target.value; refreshLibrary(); });
    $('btn-lib-filters').addEventListener('click', () => {
      const box = $('lib-filters');
      const open = box.style.display !== 'none';
      box.style.display = open ? 'none' : 'grid';
      $('btn-lib-filters').classList.toggle('on', !open);
    });
    const filterChanged = () => {
      libState.difficulty = $('lib-difficulty').value;
      libState.author = $('lib-author-filter').value.trim();
      libState.minWords = $('lib-min').value;
      libState.maxWords = $('lib-max').value;
      refreshLibrary();
    };
    $('lib-difficulty').addEventListener('change', filterChanged);
    $('lib-author-filter').addEventListener('change', filterChanged);
    $('lib-min').addEventListener('change', filterChanged);
    $('lib-max').addEventListener('change', filterChanged);
    $('btn-lib-reset').addEventListener('click', () => {
      libState = { q: '', sort: 'popular', tag: '', difficulty: '', author: '', minWords: '', maxWords: '', offset: 0 };
      $('lib-q').value = '';
      $('lib-q-clear').style.display = 'none';
      $('lib-sort').value = 'popular';
      $('lib-difficulty').value = '';
      $('lib-author-filter').value = '';
      $('lib-min').value = '';
      $('lib-max').value = '';
      syncTagBar();
      refreshLibrary();
    });
    $('btn-lib-more').addEventListener('click', () => {
      libState.offset += LIB_PAGE;
      refreshLibrary(true);
    });

    // ── One list, up close ──
    $('btn-li-use').addEventListener('click', () => { if (libSelected) useListInRoom(libSelected.id); });
    $('btn-li-download').addEventListener('click', () => {
      if (!libSelected) return;
      const a = document.createElement('a');
      a.href = API.libraryDownloadUrl(libSelected.id);
      a.download = '';
      a.click();
    });
    $('btn-li-edit').addEventListener('click', startListEdit);
    $('btn-li-cancel').addEventListener('click', () => { $('li-edit').style.display = 'none'; });
    $('btn-li-save').addEventListener('click', saveListEdit);
    $('li-edit-words').addEventListener('input', updateEditCount);
    $('btn-li-delete').addEventListener('click', async () => {
      if (!libSelected) return;
      if (!await MiviDialog.confirm(`Take "${libSelected.name}" out of the library?`, { confirmLabel: 'Remove', danger: true })) return;
      try {
        await API.libraryDelete(libSelected.id);
        $('modal-listinfo').style.display = 'none';
        toast('🗑️ Removed from the library');
        refreshLibrary();
        refreshMyLibraryLists();
      } catch (e) { toast('❌ ' + e.message); }
    });

    // ── Share a whole zip to the library ──
    $('btn-lib-zip').addEventListener('click', () => {
      if (!window.MiviAccount.isLoggedIn()) { showLibTab('upload'); return; }
      $('lib-zip-file').click();
    });
    $('lib-zip-file').addEventListener('change', async (e) => {
      const file = (e.target.files || [])[0];
      e.target.value = '';
      if (!file) return;
      if (file.size > 8 * 1024 * 1024) { toast('❌ That zip is over the 8 MB limit.'); return; }
      const btn = $('btn-lib-zip');
      btn.disabled = true;
      const errEl = $('lib-error');
      errEl.textContent = '';
      try {
        const res = await API.libraryImportZip({
          zip: await fileToBase64(file),
          description: $('lib-desc').value.trim(),
          tags: uploadTags,
        });
        const n = res.lists.length;
        toast(`📚 Shared ${n} list${n === 1 ? '' : 's'}` + (res.skipped.length ? ` · ${res.skipped.length} skipped` : ''));
        showLibTab('browse');
        refreshLibrary();
      } catch (err) {
        errEl.textContent = err.message;
      } finally {
        btn.disabled = false;
      }
    });

    $('btn-library').addEventListener('click', openLibrary);
    $('btn-lobby-library').addEventListener('click', openLibrary);
    document.querySelectorAll('#modal-library .tab').forEach(t => t.addEventListener('click', () => showLibTab(t.dataset.libtab)));
    $('btn-lib-upload').addEventListener('click', uploadToLibrary);
    $('btn-lib-new').addEventListener('click', () => showLibTab('upload'));
    const pickFolder = () => {
      if (!window.MiviAccount.isLoggedIn()) { showLibTab('upload'); return; }
      $('lib-folder-input').click();
    };
    $('btn-lib-folder').addEventListener('click', pickFolder);
    $('btn-lib-folder2').addEventListener('click', pickFolder);
    $('lib-folder-input').addEventListener('change', (e) => {
      const files = e.target.files;
      e.target.value = '';
      uploadFolder(files);
    });
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
    $('btn-leave').addEventListener('click', async () => {
      if (!roomCode) return;
      if (gameState && gameState.state !== 'lobby'
        && !await MiviDialog.confirm('Leave the game?', { confirmLabel: 'Leave', danger: true })) return;
      sfx('click');
      leaveToHome();
    });
    $('btn-gif').addEventListener('click', () => exportGameGif());
    // ── Public-match voting ──
    $('btn-poll-yes').addEventListener('click', () => { sfx('click'); socket.emit('votePoll', { yes: true }); });
    $('btn-poll-no').addEventListener('click', () => { sfx('click'); socket.emit('votePoll', { yes: false }); });

    // ── The artist calls time when there is no clock ──
    $('btn-finish-drawing').addEventListener('click', () => {
      sfx('click');
      socket.emit('finishDrawing');
    });

    // ── Last game's GIF, from the lobby ──
    $('btn-lobby-gif').addEventListener('click', () => {
      gifJustSaved = true;
      exportGameGif($('btn-lobby-gif'));
    });

    // ── Import a zip of .txt lists ──
    $('btn-import-zip').addEventListener('click', () => {
      if (!window.MiviAccount.isLoggedIn()) {
        toast('📚 Sign in with Discord to import lists to your account.');
        return;
      }
      $('import-zip-file').click();
    });
    $('import-zip-file').addEventListener('change', async (e) => {
      const file = (e.target.files || [])[0];
      e.target.value = '';
      if (!file) return;
      if (file.size > 8 * 1024 * 1024) { toast('❌ That zip is over the 8 MB limit.'); return; }
      toast('🗜️ Reading ' + file.name + '…');
      try {
        const b64 = await fileToBase64(file);
        const res = await API.importZip(b64);
        const n = res.lists.length;
        toast(`✅ Imported ${n} list${n === 1 ? '' : 's'}` + (res.skipped.length ? ` · ${res.skipped.length} skipped` : ''));
        // They land in your account, so offer them to the room right away.
        renderMyLists();
        for (const l of res.lists) socket.emit('attachAccountList', { listId: l.id });
      } catch (err) {
        toast('❌ ' + err.message);
      }
    });

    // ── Generate a list with Gemini (moderators) ──
    $('btn-ai-generate').addEventListener('click', generateAiList);
    $('ai-key').value = API.lsGet('mivi_gemini_key') || '';
    $('ai-remember').checked = !!API.lsGet('mivi_gemini_key');

    $('btn-endgame').addEventListener('click', async () => {
      if (!await MiviDialog.confirm('End the game now and jump to the final scores?', { title: 'End the game', confirmLabel: 'End it', danger: true })) return;
      sfx('click');
      socket.emit('endGameNow');
    });
    $('btn-gamesettings').addEventListener('click', openGameSettings);
    $('tool-emoji').addEventListener('click', (e) => {
      // Clicking the tool again re-opens the picker so you can swap emoji.
      if (currentTool === 'emoji' || !pendingEmoji) { e.preventDefault(); openEmojiPicker(); }
    });
    $('emoji-search').addEventListener('input', (e) => filterEmoji(e.target.value));
    if (activityMode) {
      $('btn-rejoin-activity').style.display = 'block';
      $('btn-rejoin-activity').textContent = "🎮 Play with this channel";
      $('btn-rejoin-activity').classList.add('btn-hero-lite');
      $('btn-rejoin-activity').addEventListener('click', rejoinActivityGame);
      $('btn-activity-custom').addEventListener('click', createCustomFromActivity);
      $('btn-activity-back').addEventListener('click', rejoinActivityGame);
    }
    $('modal-gamesettings').addEventListener('mousedown', (e) => {
      if (e.target === $('modal-gamesettings')) closeGameSettings();
    });
    $('modal-gamesettings').querySelector('.modal-x').addEventListener('click', closeGameSettings);
    window.addEventListener('resize', () => requestAnimationFrame(fitCanvas));
    $('btn-lobby-friends').addEventListener('click', () => window.MiviAccount.openAccount('friends'));
    $('invite-join').addEventListener('click', acceptInvite);
    $('invite-dismiss').addEventListener('click', hideInviteToast);

    // ── statistics (moderators) ──
    $('btn-open-stats').addEventListener('click', openStats);
    $('btn-leaderboard').addEventListener('click', openLeaderboard);
    document.querySelectorAll('#lb-tabs [data-cat]').forEach(b =>
      b.addEventListener('click', () => {
        lbCat = b.dataset.cat;
        document.querySelectorAll('#lb-tabs [data-cat]').forEach(x => x.classList.toggle('on', x === b));
        renderLeaderboard();
      }));
    $('mw-search').addEventListener('input', (e) => renderWordsModal(e.target.value));
    document.querySelectorAll('#stats-tabs .tab').forEach(t =>
      t.addEventListener('click', () => showStatTab(t.dataset.stab)));
    document.querySelectorAll('#stat-ranges [data-range]').forEach(b =>
      b.addEventListener('click', () => {
        statsRange = b.dataset.range;
        document.querySelectorAll('#stat-ranges [data-range]').forEach(x => x.classList.toggle('on', x === b));
        loadStats();
      }));

    wireBackButton();
    wireClickToType();
    wireListDrop();
    wireChatHistory($('game-chat-input'), 'game');
    wireChatHistory($('lobby-chat-input'), 'lobby');
    $('btn-vote-list').addEventListener('click', startVoteAddList);

    // The like/skip pair are drawn icons now, not emoji at the mercy of the
    // platform's font.
    const HEART_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21C5.5 16.3 2 12.8 2 8.9 2 6 4.2 4 6.9 4c1.8 0 3.5.9 4.4 2.4h1.4C13.6 4.9 15.3 4 17.1 4 19.8 4 22 6 22 8.9c0 3.9-3.5 7.4-10 12.1z"/></svg>';
    const SKIP_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5v13c0 .8.9 1.3 1.6.9l9.9-6.5c.6-.4.6-1.4 0-1.8L5.6 4.6C4.9 4.2 4 4.7 4 5.5z"/><rect x="17" y="4" width="3" height="16" rx="1.2"/></svg>';
    const likeBtn = $('btn-like');
    const skipBtn = $('btn-voteskip');
    likeBtn.innerHTML = HEART_SVG + '<span id="like-count"></span>';
    skipBtn.innerHTML = SKIP_SVG + '<span id="skip-count"></span>';
    likeBtn.classList.add('icon-float');
    skipBtn.classList.add('icon-float');

    // Light UI sounds in one delegated place.
    document.addEventListener('click', (e) => {
      if (e.target.closest('.tab, .lib-tag')) sfx('click');
      else if (e.target.closest('.modal-x')) sfx('pop');
    });

    startRoomsPoll();
  });

  window.MiviApp = {
    toast,
    sfx,
    // Used by the list library: can the current player drop a list into a room?
    canAddRoomList: () => !!roomCode && !!gameState && gameState.state === 'lobby' && gameState.host === myId && !gameState.managed,
    addRoomList: (name, text) => { if (socket) socket.emit('addCustomList', { name, text }); },
    inRoom: () => !!roomCode,
    isActivity: () => activityMode,
    activitySignIn: retryActivitySignIn,
    inviteFriend: (userId) => { if (socket && roomCode) socket.emit('inviteFriend', { userId }); },
  };
})();
