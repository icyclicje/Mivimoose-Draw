// ─────────────────────────────────────────────────────────────
// smoke.js — end-to-end smoke test against a running server.
//   Usage:  set PORT=3111 && node server.js   (in one terminal)
//           node test/smoke.js                (in another)
// or just:  npm run smoke  (starts its own server on 3111)
// ─────────────────────────────────────────────────────────────
const { io } = require('socket.io-client');
const { spawn } = require('child_process');
const path = require('path');

const PORT = process.env.SMOKE_PORT || 3111;
const BASE = `http://localhost:${PORT}`;

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✔ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✘ ${name}${extra ? ' — ' + extra : ''}`); }
}

function once(sock, event, timeout = 8000) {
  if (event === 'welcome' && sock._welcome) {
    return Promise.race([sock._welcome, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout waiting for "welcome"')), timeout))]);
  }
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for "${event}"`)), timeout);
    sock.once(event, (data) => { clearTimeout(t); resolve(data); });
  });
}

function connect(auth) {
  const sock = io(BASE, { auth, transports: ['websocket'], forceNew: true, timeout: 15000 });
  sock.on('connect_error', (e) => console.log('   (connect_error: ' + e.message + ')'));
  // Capture 'welcome' immediately — two sockets connecting back-to-back would
  // otherwise race the later once() registration and lose the event.
  sock._welcome = new Promise((resolve) => sock.once('welcome', resolve));
  return sock;
}

async function rest(method, p, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(BASE + '/api' + p, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  return { status: res.status, data };
}

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Isolated data dir so test accounts/uploads never leak into the real data/.
const SMOKE_DATA = path.join(require('os').tmpdir(), 'mivimoose-smoke-' + process.pid);

async function main() {
  // ── boot server ──
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), ALLOW_TEST_LOGIN: '1', MIVI_DATA_DIR: SMOKE_DATA },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', d => process.stderr.write('[server] ' + d));
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 8000);
    server.stdout.on('data', (d) => { if (String(d).includes('running')) { clearTimeout(t); resolve(); } });
  });
  console.log('server up.\n');

  try {
    // ═══ 1. REST: accounts ═══
    console.log('— accounts —');
    const uname = 'smoke' + Math.floor(Math.random() * 1e6);
    let r = await rest('POST', '/auth/test-login', { username: uname });
    check('test login (ALLOW_TEST_LOGIN only)', r.status === 200 && r.data.token && r.data.user.username === uname, JSON.stringify(r.data));
    const token = r.data.token;

    r = await rest('GET', '/auth/config');
    check('auth config reports discord state', r.status === 200 && r.data.discord === false);

    r = await rest('POST', '/auth/register', { username: uname, password: 'x' });
    check('password sign-up no longer exists', r.status === 404);

    r = await rest('POST', '/auth/login', { username: uname, password: 'x' });
    check('password login no longer exists', r.status === 404);

    const dc = await fetch(BASE + '/api/auth/discord', { redirect: 'manual' });
    check('discord login reports unconfigured (503)', dc.status === 503);

    const hdr = await fetch(BASE + '/');
    check('security headers present', hdr.headers.get('x-frame-options') === 'DENY' && !!hdr.headers.get('content-security-policy') && !hdr.headers.get('x-powered-by'));

    r = await rest('GET', '/auth/me', undefined, token);
    check('me endpoint', r.status === 200 && r.data.user.stats.games === 0);

    // ═══ 2. REST: word lists ═══
    console.log('— word lists —');
    r = await rest('POST', '/lists', { name: 'My Cool List', words: ['alpha', 'beta', 'gamma', 'beta', '  delta  '] }, token);
    check('create list (dedup + trim)', r.status === 200 && r.data.list.count === 4, JSON.stringify(r.data));
    const listId = r.data.list.id;

    r = await rest('GET', '/lists/' + listId, undefined, token);
    check('read list', r.status === 200 && r.data.list.words.includes('delta'));

    r = await rest('PUT', '/lists/' + listId, { words: ['one', 'two', 'three', 'four', 'five', 'six'] }, token);
    check('update list', r.status === 200 && r.data.list.count === 6);

    const exp = await fetch(BASE + '/api/lists/' + listId + '/export', { headers: { Authorization: 'Bearer ' + token } });
    const expText = await exp.text();
    check('export list', exp.status === 200 && expText.includes('three') && exp.headers.get('content-disposition').includes('.txt'));

    r = await rest('GET', '/lists', undefined, 'badtoken'.repeat(4));
    check('lists require auth', r.status === 401);

    // ═══ 3. REST: drawings ═══
    console.log('— drawings —');
    r = await rest('POST', '/drawings', { dataUrl: TINY_PNG, word: 'cat', artist: uname, guessedCount: 2, playerCount: 3 }, token);
    check('save drawing', r.status === 200 && r.data.id, JSON.stringify(r.data));
    const drawingId = r.data && r.data.id;

    r = await rest('GET', '/drawings', undefined, token);
    check('gallery list', r.status === 200 && r.data.drawings.length === 1 && r.data.drawings[0].word === 'cat');

    const img = await fetch(BASE + '/api/drawings/' + drawingId + '/image');
    check('drawing image served', img.status === 200 && img.headers.get('content-type') === 'image/png');

    r = await rest('POST', '/drawings', { dataUrl: 'data:image/png;base64,AAAA', word: 'x' }, token);
    check('non-PNG rejected', r.status === 400);

    r = await rest('DELETE', '/drawings/' + drawingId, undefined, token);
    check('delete drawing', r.status === 200);

    // ═══ 4. Room flow + full round ═══
    console.log('— game round —');
    const A = connect({ token, guestKey: 'a'.repeat(32), name: 'Host' });
    const welcomeA = await once(A, 'welcome');
    check('welcome carries account identity', welcomeA.loggedIn === true && welcomeA.username === uname);

    let p = once(A, 'roomCreated');
    A.emit('createRoom', { name: 'Hosty' });
    const created = await p;
    check('letter room code', /^[A-Z]{4}$/.test(created.code), created.code);
    check('classic list selected by default', created.state.wordLists.selected.includes('classic'));
    check('only the Classic list ships', created.state.wordLists.available.filter(l => !l.custom).length === 1 && created.state.wordLists.available[0].label === 'Classic');
    const dflt = created.state.options;
    check('new defaults (10 rounds · 90s · 5 words · 5 hints · 10 players · easy)',
      dflt.rounds === 10 && dflt.roundTime === 90 && dflt.wordChoices === 5 && dflt.hintCount === 5 && dflt.maxPlayers === 10 && dflt.autocorrectStrength === 1 && dflt.textTool === false && dflt.avoidRepeats === true && dflt.canvasBackground === 'plain' && dflt.sceneBackgrounds === false,
      JSON.stringify(dflt));
    const code = created.code;

    const B = connect({ guestKey: 'b'.repeat(32), name: 'Guesser', avatar: { emoji: '🐸', color: '#00B894' } });
    await once(B, 'welcome');
    p = once(B, 'roomJoined');
    B.emit('joinRoom', { code });
    const joined = await p;
    check('guest joined', joined.state.players.length === 2);
    check('avatar carried', joined.state.players[1].avatar.emoji === '🐸');

    //

    // Attach account list + weight it (the weighting fix).
    p = once(A, 'customListAdded');
    A.emit('attachAccountList', { listId });
    const attached = await p;
    check('attach account list', attached.count === 6, JSON.stringify(attached));

    p = once(A, 'stateUpdate');
    A.emit('setWordLists', { lists: [attached.name], weights: { [attached.name]: 8 } });
    const stateWL = await p;
    check('weighting fix: custom list weight stored (1-10 range)', stateWL.wordLists.weights[attached.name] === 8, JSON.stringify(stateWL.wordLists.weights));
    check('only custom list selected', stateWL.wordLists.selected.length === 1);

    // Options
    p = once(A, 'stateUpdate');
    A.emit('setGameOptions', { options: { roundTime: 30, rounds: 1, maxPlayers: 12 } });
    const stateOpt = await p;
    check('options set', stateOpt.options.roundTime === 30 && stateOpt.options.rounds === 1 && stateOpt.options.maxPlayers === 12);

    // Start!
    const roundStartA = once(A, 'roundStart');
    const choicesA = once(A, 'wordChoices');
    const roundStartB = once(B, 'roundStart');
    A.emit('startGame');
    const rsA = await roundStartA;
    const rsB = await roundStartB;
    check('round started', rsA.state === 'choosing' && rsA.drawerId === welcomeA.key && rsB.round === 1);
    const wc = await choicesA;
    check('drawer got word choices from custom list (5 by default)', wc.words.length === 5 && wc.words.every(w => ['one','two','three','four','five','six'].includes(w)), JSON.stringify(wc.words));

    const drawingStartB = once(B, 'drawingStart');
    const yourWordA = once(A, 'yourWord');
    A.emit('chooseWord', { word: wc.words[0] });
    const ds = await drawingStartB;
    const yw = await yourWordA;
    check('drawing phase', ds.state === 'drawing' && yw.word === wc.words[0]);
    check('masked word sent', typeof ds.maskedWord === 'string' && ds.maskedWord.includes('_'));

    // Drawer draws; guesser should receive it.
    const drawB = once(B, 'draw');
    A.emit('draw', { type: 'line', x1: 0, y1: 0, x2: 100, y2: 100, color: '#111111', size: 6 });
    A.emit('strokeEnd');
    const seg = await drawB;
    check('draw relayed', seg.x2 === 100);

    // Guesser can't draw.
    let leaked = false;
    const leakCheck = (d) => { leaked = true; };
    A.on('draw', leakCheck);
    B.emit('draw', { type: 'line', x1: 5, y1: 5, x2: 6, y2: 6, color: '#111111', size: 6 });
    await sleep(300);
    A.off('draw', leakCheck);
    check('non-drawer draw blocked', !leaked);

    // Wrong guess → chat with isGuess.
    const chatB = once(B, 'chat');
    B.emit('guess', { text: 'definitely-wrong-zzz' });
    const wrong = await chatB;
    check('wrong guess echoed', wrong.isGuess === true && wrong.playerName === 'Guesser');

    // Correct guess → points, roundEnd (single guesser → everyone guessed).
    const correctB = once(B, 'correctGuess');
    const roundEndB = once(B, 'roundEnd');
    B.emit('guess', { text: yw.word });
    const cg = await correctB;
    check('correct guess scored', cg.playerId && cg.points >= 250, 'points=' + cg.points);
    const re = await roundEndB;
    check('round ended when all guessed', re.word === yw.word);
    const bRow = re.scores.find(s => s.name === 'Guesser');
    const aRow = re.scores.find(s => s.name === 'Hosty');
    check('guesser round delta', bRow && bRow.delta >= 250, JSON.stringify(re.scores));
    check('drawer paid proportionally (350 + 50 perfect)', aRow && aRow.delta === 400, JSON.stringify(re.scores));

    // rounds=1 with 2 players → after 2 turns game ends; wait for gameEnd through next round.
    const wcBP = once(B, 'wordChoices', 15000); // registered early: arrives in the same tick as roundStart
    const nextRound = await once(B, 'roundStart', 10000);
    check('rotation: guesser now draws', nextRound.drawerId === (joined.state.players[1].id));
    const wcB = await wcBP;
    check('avoid repeats: drawn word is not offered again', !wcB.words.includes(wc.words[0]), JSON.stringify(wcB.words));
    const geA = once(A, 'gameEnd', 40000);
    B.emit('chooseWord', { word: wcB.words[0] });
    // Nobody guesses; round time is 30s — vote-skip instead to keep the test fast.
    await once(A, 'drawingStart', 5000);
    A.emit('voteSkip'); // A is the only guesser → majority reached instantly
    const ge = await geA;
    check('game ended with final scores', Array.isArray(ge.finalScores) && ge.finalScores.length === 2);
    check('winner is guesser', ge.finalScores[0].name === 'Guesser');

    // Stats recorded on the account (host drew 1 word, played 1 game).
    await sleep(600);
    r = await rest('GET', '/auth/me', undefined, token);
    check('stats recorded', r.data.user.stats.games === 1 && r.data.user.stats.wordsDrawn >= 1, JSON.stringify(r.data.user.stats));

    A.disconnect();
    B.disconnect();

    // ═══ 5. Reconnect grace ═══
    console.log('— reconnect —');
    const C = connect({ guestKey: 'c'.repeat(32), name: 'Cee' });
    await once(C, 'welcome', 20000);
    p = once(C, 'roomCreated');
    C.emit('createRoom', { name: 'Cee' });
    const cRoom = (await p).code;
    const D = connect({ guestKey: 'd'.repeat(32), name: 'Dee' });
    await once(D, 'welcome');
    p = once(D, 'roomJoined');
    D.emit('joinRoom', { code: cRoom });
    await p;
    D.disconnect();
    await sleep(500);
    const D2 = connect({ guestKey: 'd'.repeat(32), name: 'Dee' });
    await once(D2, 'welcome');
    p = once(D2, 'roomJoined');
    D2.emit('joinRoom', { code: cRoom });
    const rejoined = await p;
    check('seat resumed after reconnect', rejoined.resumed === true, JSON.stringify(rejoined.resumed));
    check('no duplicate player', rejoined.state.players.length === 2);
    C.disconnect();
    D2.disconnect();

    // ═══ 6. Quick play / public rooms ═══
    console.log('— public matches —');
    const E = connect({ guestKey: 'e'.repeat(32), name: 'Ess' });
    await once(E, 'welcome');
    p = once(E, 'roomJoined');
    E.emit('quickPlay', {});
    const eJoin = await p;
    check('quickplay creates managed room', eJoin.state.managed === true && eJoin.state.public === true);
    check('managed room uses classic list', eJoin.state.wordLists.selected.length === 1 && eJoin.state.wordLists.selected[0] === 'classic');

    const F = connect({ guestKey: 'f'.repeat(32), name: 'Eff' });
    await once(F, 'welcome');
    p = once(F, 'roomJoined');
    F.emit('quickPlay', {});
    const fJoin = await p;
    check('quickplay joins same room', fJoin.code === eJoin.code);

    const auto = await once(F, 'autoStart', 5000);
    check('managed room auto-start countdown', typeof auto.seconds === 'number' && auto.seconds > 0);

    r = await rest('GET', '/rooms');
    const pub = r.data.rooms.find(x => x.code === eJoin.code);
    check('public room listed', !!pub && pub.players === 2);

    // Managed room refuses host-y commands.
    let optChanged = false;
    E.on('stateUpdate', s => { if (s.options.rounds === 9) optChanged = true; });
    E.emit('setGameOptions', { options: { rounds: 9 } });
    await sleep(400);
    check('managed room options locked', !optChanged);

    E.disconnect();
    F.disconnect();

    // ═══ 7. Autocorrect privacy: corrected word never reaches non-guessers ═══
    console.log('— corrected-word privacy —');
    const LONGWORDS = 'stone\nplant\nchair\ntiger\nbread\ncloud';
    const H2 = connect({ guestKey: '1'.repeat(32), name: 'Art' });
    await once(H2, 'welcome', 20000);
    p = once(H2, 'roomCreated');
    H2.emit('createRoom', { name: 'Art' });
    const room2 = (await p).code;
    const P1 = connect({ guestKey: '2'.repeat(32), name: 'Typo' });
    const P2 = connect({ guestKey: '3'.repeat(32), name: 'Slow' });
    await once(P1, 'welcome'); await once(P2, 'welcome');
    p = once(P1, 'roomJoined'); P1.emit('joinRoom', { code: room2 }); await p;
    p = once(P2, 'roomJoined'); P2.emit('joinRoom', { code: room2 }); await p;
    p = once(H2, 'customListAdded');
    H2.emit('addCustomList', { name: 'longwords', text: LONGWORDS });
    await p;
    H2.emit('setWordLists', { lists: ['longwords'], weights: {} });
    H2.emit('setGameOptions', { options: { rounds: 1, roundTime: 60, autocorrectStrength: 1 } });
    await sleep(200);
    const wcH2 = once(H2, 'wordChoices');
    H2.emit('startGame');
    const words2 = (await wcH2).words;
    const target = words2[0];
    const dsP1 = once(P1, 'drawingStart');
    H2.emit('chooseWord', { word: target });
    await dsP1;
    const cgP1 = once(P1, 'correctGuess');
    const cgP2 = once(P2, 'correctGuess');
    P1.emit('guess', { text: target.slice(0, -1) + 'x' }); // 1-letter typo
    const g1 = await cgP1;
    const g2 = await cgP2;
    check('typo autocorrected for guesser', g1.autocorrected === true && g1.correctedWord === target);
    check('corrected word hidden from non-guessers', g2.autocorrected === true && g2.correctedWord === null, JSON.stringify(g2.correctedWord));

    // Time drop: 60s round, 2 guessers, one left → remaining time capped at
    // ceil(60 * 1/2 * 0.6 + 8) = 26.
    const tick = await once(P2, 'timerTick');
    check('time drop caps remaining time after a guess', tick.timeLeft <= 26, 'timeLeft=' + tick.timeLeft);

    // Wrong-start words are not autocorrected on Easy; plurals are forgiven.
    let falseHit = false;
    const fh = () => { falseHit = true; };
    P2.on('correctGuess', fh);
    P2.emit('guess', { text: 'x' + target.slice(1) }); // first letter wrong
    await sleep(300);
    P2.off('correctGuess', fh);
    check('easy autocorrect rejects wrong first letter', !falseHit);
    const cgP2b = once(P2, 'correctGuess');
    const reP2 = once(P2, 'roundEnd');
    P2.emit('guess', { text: target + 's' });
    const plural = await cgP2b;
    check('plural forgiven by autocorrect', plural.autocorrected === true);
    await reP2; // everyone guessed → round over

    // Spam protection: P2 floods the chat → gets muted, later messages dropped.
    const mutedMsg = new Promise(resolve => {
      const h = (m) => { if (m.system && /muted/i.test(m.text)) { P2.off('chat', h); resolve(m); } };
      P2.on('chat', h);
      setTimeout(() => { P2.off('chat', h); resolve(null); }, 3000);
    });
    for (let i = 0; i < 9; i++) P2.emit('chat', { text: 'spam' + i });
    const muted = await mutedMsg;
    check('spam protection mutes flooders', !!muted);
    let leakedWhileMuted = false;
    const spy = (m) => { if (m.playerName === 'Slow' && m.text === 'after-mute') leakedWhileMuted = true; };
    P1.on('chat', spy);
    P2.emit('chat', { text: 'after-mute' });
    await sleep(400);
    P1.off('chat', spy);
    check('muted player messages dropped', !leakedWhileMuted);

    H2.disconnect(); P1.disconnect(); P2.disconnect();

    // ═══ 7b. Community list library ═══
    console.log('— list library —');
    r = await rest('POST', '/library', { name: 'Kitchen stuff', words: ['spoon', 'fork'] });
    check('guests cannot upload to the library', r.status === 401);
    const tokenF = (await rest('POST', '/auth/test-login', { username: 'friend' + Math.floor(Math.random() * 1e6) })).data.token;
    r = await rest('POST', '/library', { name: 'Kitchen stuff', words: ['spoon', 'fork', 'shit', 'kettle', 'f u c k', 'toaster'] }, tokenF);
    check('library upload (account)', r.status === 200 && r.data.list && r.data.list.count === 4, JSON.stringify(r.data));
    check('swear protection removed 2 words', r.data.removedBySwearFilter === 2);
    const libId = r.data.list.id;
    r = await rest('POST', '/library', { name: 'Kitchen', words: ['shit', 'crap'] }, tokenF);
    check('all-profane list rejected', r.status === 400);
    r = await rest('POST', '/library', { name: 'Bitch list', words: ['spoon'] }, tokenF);
    check('profane list name rejected', r.status === 400);
    r = await rest('GET', '/library', undefined, token);
    check('library listing', r.status === 200 && r.data.lists.some(l => l.id === libId && l.mine === false));
    const dlRes = await fetch(BASE + '/api/library/' + libId + '/download');
    const dlText = await dlRes.text();
    check('library download', dlRes.status === 200 && dlText.includes('kettle') && !dlText.includes('shit'));
    r = await rest('GET', '/library/' + libId);
    check('download counted', r.data.list.downloads === 1);
    r = await rest('DELETE', '/library/' + libId, undefined, token);
    check('cannot delete someone else\'s library list', r.status === 404);
    r = await rest('POST', '/library', { name: 'Mine', words: ['apple', 'pear'] }, token);
    check('library upload attributed to account', r.status === 200 && r.data.list.author === uname);
    r = await rest('DELETE', '/library/' + r.data.list.id, undefined, token);
    check('owner can delete own library list', r.status === 200);

    // ═══ 7c. Friends: codes, requests, presence, invites ═══
    console.log('— friends —');
    r = await rest('GET', '/friends', undefined, token);
    check('friends list + code', r.status === 200 && /^[A-F0-9]{6}$/.test(r.data.code) && Array.isArray(r.data.friends));
    const myCode = r.data.code;
    const fInfo = await rest('GET', '/friends', undefined, tokenF);
    r = await rest('POST', '/friends/request', { code: 'ZZZZZZ' }, token);
    check('unknown friend code rejected', r.status === 404);
    r = await rest('POST', '/friends/request', { code: myCode }, token);
    check('cannot friend yourself', r.status === 400);
    r = await rest('POST', '/friends/request', { code: fInfo.data.code }, token);
    check('friend request sent', r.status === 200 && r.data.accepted === false);
    r = await rest('GET', '/friends', undefined, tokenF);
    check('request shows up for the other side', r.data.requestsIn.length === 1 && r.data.requestsIn[0].code === myCode);
    const meId = (await rest('GET', '/auth/me', undefined, token)).data.user.id;
    r = await rest('POST', '/friends/accept', { userId: meId }, tokenF);
    check('request accepted', r.status === 200);
    r = await rest('GET', '/friends', undefined, token);
    check('now friends, offline', r.data.friends.length === 1 && r.data.friends[0].online === false);
    // Presence + invite: friend connects, host invites from a room.
    const FR = connect({ token: tokenF, guestKey: '6'.repeat(32), name: 'Friendo' });
    await once(FR, 'welcome');
    r = await rest('GET', '/friends', undefined, token);
    check('presence: friend shows online', r.data.friends[0].online === true);
    const HOST = connect({ token, guestKey: 'a'.repeat(32), name: 'Hosty' });
    await once(HOST, 'welcome');
    p = once(HOST, 'roomCreated');
    HOST.emit('createRoom', { name: 'Hosty' });
    const invRoom = (await p).code;
    const inviteP = once(FR, 'gameInvite');
    const resultP = once(HOST, 'inviteResult');
    HOST.emit('inviteFriend', { userId: r.data.friends[0].id });
    const inv = await inviteP;
    const invRes = await resultP;
    check('game invite delivered to friend', inv.code === invRoom && inv.from.username === uname && invRes.ok === true);
    // In-game friend request from the player list.
    p = once(FR, 'roomJoined'); FR.emit('joinRoom', { code: invRoom }); const frJoin = await p;
    const frPlayer = frJoin.state.players.find(pl => pl.name === 'Friendo');
    check('player list exposes accountId for friend adds', !!frPlayer && !!frPlayer.accountId);
    r = await rest('DELETE', '/friends/' + frPlayer.accountId, undefined, token);
    const frReqP = once(FR, 'friendRequestReceived');
    HOST.emit('friendRequest', { playerId: frPlayer.id });
    const frReq = await frReqP;
    check('in-game friend request delivered', frReq.from.username === uname);

    // ═══ 7d. Text tool ═══
    console.log('— text tool —');
    p = once(HOST, 'stateUpdate');
    HOST.emit('setGameOptions', { options: { rounds: 1, roundTime: 60, textTool: true } });
    await p;
    const wcT = once(HOST, 'wordChoices');
    HOST.emit('startGame');
    const tWord = (await wcT).words[0];
    const dsT = once(FR, 'drawingStart');
    HOST.emit('chooseWord', { word: tWord });
    await dsT;
    const errP = once(HOST, 'error');
    HOST.emit('draw', { type: 'text', x: 10, y: 10, text: tWord, color: '#111111', size: 6 });
    const err = await errP;
    check('text tool refuses the answer', /write the word/i.test(err.message));
    const relayed = once(FR, 'draw');
    HOST.emit('draw', { type: 'text', x: 10, y: 10, text: 'hello there', color: '#111111', size: 6 });
    const txt = await relayed;
    check('text tool relays harmless text', txt.type === 'text' && txt.text === 'hello there');
    const batchP = once(FR, 'drawBatch');
    HOST.emit('drawBatch', [{ type: 'line', x1: 0, y1: 0, x2: 5, y2: 5, color: '#111111', size: 6 }, { type: 'line', x1: 5, y1: 5, x2: 9, y2: 9, color: '#111111', size: 6 }]);
    const batch = await batchP;
    check('draw batches relayed', Array.isArray(batch) && batch.length === 2);
    HOST.disconnect(); FR.disconnect();

    // ═══ 7d2. Renaming a room's custom list ═══
    console.log('— list rename —');
    const RN = connect({ guestKey: '9'.repeat(32), name: 'Renamer' });
    await once(RN, 'welcome');
    p = once(RN, 'roomCreated'); RN.emit('createRoom', { name: 'Renamer' }); const roomRN = (await p).code;
    p = once(RN, 'customListAdded'); RN.emit('addCustomList', { name: 'Old name', text: 'apple\npear' }); await p;
    p = once(RN, 'stateUpdate');
    RN.emit('setWordLists', { lists: ['Old name'], weights: { 'Old name': 7 } });
    await p;
    const renP = once(RN, 'customListRenamed');
    const stRn = once(RN, 'stateUpdate');
    RN.emit('renameCustomList', { name: 'Old name', newName: 'Fresh name' });
    const ren = await renP;
    const afterRn = await stRn;
    check('custom list renamed', ren.to === 'Fresh name' && afterRn.wordLists.available.some(l => l.name === 'Fresh name'));
    check('rename keeps it selected', afterRn.wordLists.selected.includes('Fresh name') && !afterRn.wordLists.selected.includes('Old name'));
    check('rename keeps its weight', afterRn.wordLists.weights['Fresh name'] === 7, JSON.stringify(afterRn.wordLists.weights));
    // Removing a list falls back to Classic rather than leaving nothing.
    p = once(RN, 'customListRemoved');
    const stRm = once(RN, 'stateUpdate');
    RN.emit('removeCustomList', { name: 'Fresh name' });
    await p;
    const afterRm = await stRm;
    check('custom list removed', !afterRm.wordLists.available.some(l => l.name === 'Fresh name'));
    check('removal never leaves the room list-less', afterRm.wordLists.selected.length >= 1 && afterRm.wordLists.selected.includes('classic'), JSON.stringify(afterRm.wordLists.selected));
    p = once(RN, 'customListAdded'); RN.emit('addCustomList', { name: 'Fresh name', text: 'apple\npear' }); await p;

    const errRn = once(RN, 'error');
    RN.emit('renameCustomList', { name: 'Fresh name', newName: 'classic' });
    check('rename onto an existing list refused', /already a list/i.test((await errRn).message));

    // Canvas paper option
    p = once(RN, 'stateUpdate');
    RN.emit('setGameOptions', { options: { canvasBackground: 'grid' } });
    check('canvas paper set', (await p).options.canvasBackground === 'grid');
    p = once(RN, 'stateUpdate');
    RN.emit('setGameOptions', { options: { canvasBackground: 'nonsense' } });
    check('bogus canvas paper ignored', (await p).options.canvasBackground === 'grid');
    RN.disconnect();

    // ═══ 7d3. Scene backdrops + host-only skip ═══
    console.log('— backdrops & skip —');
    const SC = connect({ guestKey: 'a'.repeat(31) + 'b', name: 'Scener' });
    await once(SC, 'welcome');
    p = once(SC, 'roomCreated'); SC.emit('createRoom', { name: 'Scener' }); const roomSC = (await p).code;
    const SG = connect({ guestKey: 'a'.repeat(31) + 'c', name: 'Watcher' });
    await once(SG, 'welcome');
    p = once(SG, 'roomJoined'); SG.emit('joinRoom', { code: roomSC }); await p;
    p = once(SC, 'stateUpdate');
    SC.emit('setGameOptions', { options: { rounds: 2, roundTime: 60, sceneBackgrounds: true } });
    check('scene backdrops toggled on', (await p).options.sceneBackgrounds === true);

    let wcSC = once(SC, 'wordChoices');
    SC.emit('startGame');
    let dsSG = once(SG, 'drawingStart');
    SC.emit('chooseWord', { word: (await wcSC).words[0] });
    check('round starts with no backdrop', (await dsSG).scene === null);

    // A guesser cannot set the backdrop; the artist can.
    let stray = false;
    const straySpy = () => { stray = true; };
    SC.on('sceneSet', straySpy);
    SG.emit('setScene', { id: 'city' });
    await sleep(300);
    SC.off('sceneSet', straySpy);
    check('non-artist cannot set a backdrop', !stray);

    let sceneP = once(SG, 'sceneSet');
    SC.emit('setScene', { id: 'city' });
    check('artist sets a backdrop for everyone', (await sceneP).id === 'city');

    let bogus = false;
    const bogusSpy = () => { bogus = true; };
    SG.on('sceneSet', bogusSpy);
    SC.emit('setScene', { id: 'not-a-real-scene' });
    await sleep(300);
    SG.off('sceneSet', bogusSpy);
    check('unknown backdrop id ignored', !bogus);

    r = await rest('GET', '/rooms');
    // Skip: the guesser is not host, so they are refused…
    const skipErr = once(SG, 'error');
    SG.emit('voteSkip');
    check('non-host cannot skip', /only the host/i.test((await skipErr).message));
    // …and the host can skip even though the host is the one drawing.
    const reSkip = once(SG, 'roundEnd');
    SC.emit('voteSkip');
    await reSkip;
    check('host skips the round they are drawing', true);

    // Backdrop resets when the next round starts.
    wcSC = once(SG, 'wordChoices', 15000);
    const rsNext = await once(SG, 'roundStart', 15000);
    check('backdrop cleared for the next round', rsNext.scene === null || rsNext.scene === undefined);
    SC.disconnect(); SG.disconnect();

    // ═══ 7d4. Host ends the game / retunes it mid-flight ═══
    console.log('— end game & live settings —');
    const EG = connect({ guestKey: 'b'.repeat(31) + '1', name: 'Bossy' });
    await once(EG, 'welcome');
    p = once(EG, 'roomCreated'); EG.emit('createRoom', { name: 'Bossy' }); const roomEG = (await p).code;
    const EP = connect({ guestKey: 'b'.repeat(31) + '2', name: 'Player2' });
    await once(EP, 'welcome');
    p = once(EP, 'roomJoined'); EP.emit('joinRoom', { code: roomEG }); await p;
    p = once(EG, 'stateUpdate');
    EG.emit('setGameOptions', { options: { rounds: 5, roundTime: 120, hintCount: 1 } });
    await p;
    let wcEG = once(EG, 'wordChoices');
    EG.emit('startGame');
    let dsEP = once(EP, 'drawingStart');
    EG.emit('chooseWord', { word: (await wcEG).words[0] });
    await dsEP;

    // Options are no longer lobby-only.
    p = once(EP, 'stateUpdate');
    EG.emit('setGameOptions', { options: { hintCount: 4, autocorrectStrength: 3 } });
    const midOpts = await p;
    check('host can change settings mid-game', midOpts.options.hintCount === 4 && midOpts.options.autocorrectStrength === 3, JSON.stringify(midOpts.options.hintCount));

    // Shortening the clock must claw back the timer too.
    const tickAfter = once(EP, 'timerTick');
    EG.emit('setGameOptions', { options: { roundTime: 30 } });
    check('shortening the clock trims time left', (await tickAfter).timeLeft <= 30);

    // Word lists can be retuned mid-game as well.
    p = once(EG, 'customListAdded'); EG.emit('addCustomList', { name: 'Midgame', text: 'apple\npear\nplum' }); await p;
    p = once(EP, 'stateUpdate');
    EG.emit('setWordLists', { lists: ['Midgame'], weights: { Midgame: 4 } });
    check('host can swap word lists mid-game', (await p).wordLists.selected.includes('Midgame'));

    // A guesser cannot end the game; the host can.
    const egErr = once(EP, 'error');
    EP.emit('endGameNow');
    check('only the host can end the game', /only the host/i.test((await egErr).message));
    const geEP = once(EP, 'gameEnd');
    EG.emit('endGameNow');
    check('host ends the game on demand', Array.isArray((await geEP).finalScores));
    EG.disconnect(); EP.disconnect();

    // ═══ 7d5. Renaming your account ═══
    console.log('— rename —');
    r = await rest('PUT', '/auth/me', { username: 'Sir Draws A Lot' }, tokenF);
    check('rename works', r.status === 200 && r.data.user.username === 'Sir Draws A Lot', JSON.stringify(r.data));
    r = await rest('GET', '/library', undefined, tokenF);
    check('rename follows your shared lists', r.data.lists.every(l => !l.mine || l.author === 'Sir Draws A Lot'));
    r = await rest('PUT', '/auth/me', { username: 'x' }, tokenF);
    check('too-short name refused', r.status === 400);
    r = await rest('PUT', '/auth/me', { username: 'Shitlord' }, tokenF);
    check('rude name refused', r.status === 400);
    r = await rest('PUT', '/auth/me', { username: uname }, tokenF);
    check('name already taken refused', r.status === 409);

    // ═══ 7d6. Moderators ═══
    console.log('— mods —');
    r = await rest('GET', '/mod/me', undefined, token);
    check('ordinary account is not a mod', r.status === 200 && r.data.isMod === false && r.data.anyMods === false);
    r = await rest('GET', '/mod/users', undefined, token);
    check('mod routes are closed to non-mods', r.status === 403);

    // Bootstrap: with nobody holding the badge, "Silk" has it.
    const tokenS = (await rest('POST', '/auth/test-login', { username: 'tempsilk' + Math.floor(Math.random() * 1e5) })).data.token;
    r = await rest('PUT', '/auth/me', { username: 'Silk' }, tokenS);
    check('claimed the name Silk', r.status === 200);
    const silkId = r.data.user.id;
    r = await rest('GET', '/mod/me', undefined, tokenS);
    check('bootstrap: Silk is a mod while nobody else is', r.data.isMod === true && r.data.bootstrap === true);

    // Silk hands the badge to someone, which switches the fallback off.
    // (meId is the same account the friends section already looked up.)
    r = await rest('POST', '/mod/grant', { userId: meId }, tokenS);
    check('a mod can hand out the badge', r.status === 200 && r.data.user.mod === true);
    r = await rest('GET', '/mod/me', undefined, tokenS);
    check('bootstrap switches off once a real mod exists', r.data.bootstrap === false && r.data.anyMods === true);
    r = await rest('GET', '/mod/me', undefined, token);
    check('the granted account is a mod', r.data.isMod === true);

    // A mod can take down anyone's list and ban the uploader.
    r = await rest('POST', '/library', { name: 'Doomed list', words: ['apple', 'pear'] }, tokenF);
    const doomedId = r.data.list.id;
    const ownerF = (await rest('GET', '/auth/me', undefined, tokenF)).data.user.id;
    r = await rest('GET', '/library', undefined, token);
    const doomedRow = r.data.lists.find(l => l.id === doomedId);
    check('mods see the uploader on library rows', r.data.isMod === true && doomedRow && doomedRow.ownerId === ownerF);
    r = await rest('DELETE', '/library/' + doomedId, undefined, token);
    check('mod takes down someone else\'s list', r.status === 200);
    r = await rest('POST', '/library', { name: 'Another one', words: ['apple', 'pear'] }, tokenF);
    check('uploader can still share before the ban', r.status === 200);
    r = await rest('POST', '/mod/ban', { userId: ownerF, reason: 'spam' }, token);
    check('mod bans an account and pulls its lists', r.status === 200 && r.data.removedLists >= 1, JSON.stringify(r.data));
    r = await rest('POST', '/library', { name: 'Nope', words: ['apple', 'pear'] }, tokenF);
    check('banned account cannot share', r.status === 403);
    r = await rest('POST', '/mod/ban', { userId: silkId }, token);
    check('mods cannot be banned', r.status === 400);
    r = await rest('POST', '/mod/unban', { userId: ownerF }, token);
    check('mod lifts a ban', r.status === 200);
    r = await rest('POST', '/library', { name: 'Back again', words: ['apple', 'pear'] }, tokenF);
    check('unbanned account can share again', r.status === 200);
    r = await rest('POST', '/mod/revoke', { userId: meId }, tokenS);
    check('a mod can take the badge back', r.status === 200);
    r = await rest('GET', '/mod/me', undefined, token);
    check('revoked account is no longer a mod', r.data.isMod === false);

    // ═══ 7e. Avoid repeats never strands a tiny list ═══
    console.log('— avoid repeats —');
    const H4 = connect({ guestKey: '7'.repeat(32), name: 'Tiny' });
    await once(H4, 'welcome');
    p = once(H4, 'roomCreated'); H4.emit('createRoom', { name: 'Tiny' }); const room4 = (await p).code;
    const G4 = connect({ guestKey: '8'.repeat(32), name: 'Guessy' });
    await once(G4, 'welcome');
    p = once(G4, 'roomJoined'); G4.emit('joinRoom', { code: room4 }); await p;
    p = once(H4, 'customListAdded'); H4.emit('addCustomList', { name: 'tiny', text: 'apple\nbanana\ncherry' }); await p;
    H4.emit('setWordLists', { lists: ['tiny'], weights: {} });
    p = once(H4, 'stateUpdate');
    H4.emit('setGameOptions', { options: { rounds: 2, roundTime: 30, autocorrectStrength: 0 } });
    const st4 = await p;
    check('lobby reports the unused pool', st4.wordPool && st4.wordPool.total === 3 && st4.wordPool.unused === 3, JSON.stringify(st4.wordPool));
    const wc4a = once(H4, 'wordChoices');
    const wc4bP = once(G4, 'wordChoices', 20000);
    H4.emit('startGame');
    const first = (await wc4a).words;
    check('tiny list still offers choices', first.length === 3, JSON.stringify(first));
    const ds4 = once(G4, 'drawingStart');
    H4.emit('chooseWord', { word: first[0] });
    await ds4;
    G4.emit('guess', { text: first[0] });
    const second = (await wc4bP).words;
    const others = first.filter(w => w !== first[0]);
    check('round 2 still gets a full set from a 3-word list', second.length === 3, JSON.stringify(second));
    check('unused words come back before the drawn one', others.every(w => second.includes(w)) && second.filter(w => w === first[0]).length === 1, JSON.stringify(second));
    H4.disconnect(); G4.disconnect();

    // ═══ 7f. Hint picker spreads letters sensibly ═══
    console.log('— hints —');
    {
      const hints = require('../lib/hints');
      let spreadOk = true, halfOk = true, validOk = true, varied = new Set();
      for (let i = 0; i < 200; i++) {
        const word = ['ice cream', 'boat+coat', 'traffic light', 'a b', 'x'][i % 5];
        const revealed = [];
        for (let step = 0; step < 4; step++) {
          const picked = hints.pickHintIndices(word, revealed, 1);
          for (const idx of picked) {
            if (revealed.includes(idx) || word[idx] === ' ' || word[idx] === '+') validOk = false;
          }
          revealed.push(...picked);
        }
        const parts = word.split(/[ +]/).filter(Boolean);
        const masked = hints.maskWord(word, revealed);
        const mparts = masked.split(/[ +]/).filter(Boolean);
        mparts.forEach((mp, pi) => {
          const shown = mp.split('').filter(c => c !== '_').length;
          if (shown > Math.max(1, Math.floor(parts[pi].length / 2))) halfOk = false;
          if (shown === parts[pi].length && parts[pi].length > 1 && mparts.some(o => !o.split('').some(c => c !== '_'))) spreadOk = false;
        });
        if (word === 'ice cream') varied.add(revealed.slice().sort((a, b) => a - b).join(','));
      }
      check('hints only ever reveal real, unrevealed letters', validOk);
      check('hints never exceed half of a word', halfOk);
      check('hints never finish one word while another is blank', spreadOk);
      check('hints are not identical every game', varied.size > 1, 'variants=' + varied.size);
    }

    // ═══ 8. Combo lock: full answer accepted after locking a part ═══
    console.log('— combo lock —');
    const H3 = connect({ guestKey: '4'.repeat(32), name: 'Combo' });
    await once(H3, 'welcome');
    p = once(H3, 'roomCreated');
    H3.emit('createRoom', { name: 'Combo' });
    const room3 = (await p).code;
    const G3 = connect({ guestKey: '5'.repeat(32), name: 'Locky' });
    await once(G3, 'welcome');
    p = once(G3, 'roomJoined'); G3.emit('joinRoom', { code: room3 }); await p;
    p = once(H3, 'customListAdded');
    H3.emit('addCustomList', { name: 'longwords', text: LONGWORDS });
    await p;
    H3.emit('setWordLists', { lists: ['longwords'], weights: {} });
    H3.emit('setGameOptions', { options: { rounds: 1, roundTime: 60, combinations: true, lockComboParts: true } });
    await sleep(200);
    const wc1P = once(H3, 'wordChoices');
    H3.emit('startGame');
    const part1 = (await wc1P).words[0];
    const wc2P = once(H3, 'wordChoices');
    H3.emit('chooseWord', { word: part1 });
    const part2 = (await wc2P).words[0];
    const dsG3 = once(G3, 'drawingStart');
    H3.emit('chooseWord', { word: part2 });
    await dsG3;
    const lockP = once(G3, 'partLocked');
    G3.emit('guess', { text: part1 });
    const lock = await lockP;
    check('part locked', lock.lockedPart === part1.toLowerCase());
    // Re-typing the locked part must NOT win the round.
    let wrongWin = false;
    const winSpy = () => { wrongWin = true; };
    G3.on('correctGuess', winSpy);
    G3.emit('guess', { text: part1 });
    await sleep(400);
    G3.off('correctGuess', winSpy);
    check('re-typing locked part rejected', !wrongWin);
    // The full two-part answer must be accepted.
    const cgG3 = once(G3, 'correctGuess');
    G3.emit('guess', { text: `${part1}+${part2}` });
    const win = await cgG3;
    check('full combo answer accepted after lock', win.playerId && win.points > 0);
    H3.disconnect(); G3.disconnect();
  } catch (e) {
    fail++;
    failures.push('EXCEPTION: ' + e.message);
    console.error('\n💥 ' + e.stack);
  } finally {
    server.kill();
    setTimeout(() => { try { require('fs').rmSync(SMOKE_DATA, { recursive: true, force: true }); } catch (e) {} }, 300);
  }

  console.log(`\n══ ${pass} passed, ${fail} failed ══`);
  if (failures.length) { console.log('Failures:'); failures.forEach(f => console.log('  - ' + f)); }
  process.exit(fail > 0 ? 1 : 0);
}

main();
