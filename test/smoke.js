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

const fs = require('fs');
let pass = 0, fail = 0;
const failures = [];

// An un-awaited once() promise used to kill the run outright, at whichever
// section its timer happened to fire in — which made it look like a random
// flake. Record it as a real failure instead.
process.on('unhandledRejection', (err) => {
  fail++;
  failures.push('UNHANDLED: ' + ((err && err.message) || err) + ' (an orphaned once() promise — nothing awaited it)');
  console.log('  ✘ UNHANDLED: ' + ((err && err.message) || err));
});
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
    env: { ...process.env, PORT: String(PORT), ALLOW_TEST_LOGIN: '1', MIVI_DATA_DIR: SMOKE_DATA, MIVI_NO_CONFIG: '1' },
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
      dflt.rounds === 10 && dflt.roundTime === 90 && dflt.wordChoices === 5 && dflt.hintCount === 5 && dflt.maxPlayers === 10 && dflt.autocorrectStrength === 1 && dflt.avoidRepeats === true,
      JSON.stringify(dflt));
    check('word-pick time defaults to 20s', dflt.pickTime === 20, String(dflt.pickTime));
    check('text/emoji tools and backdrops are on by default',
      dflt.textTool === true && dflt.sceneBackgrounds === true,
      JSON.stringify({ t: dflt.textTool, s: dflt.sceneBackgrounds }));
    check('custom modes default off',
      dflt.mirrorMode === false && dflt.oneColorMode === false && dflt.suddenDeath === false && dflt.strokeLimit === 0,
      JSON.stringify({ m: dflt.mirrorMode, o: dflt.oneColorMode, s: dflt.suddenDeath, l: dflt.strokeLimit }));
    check('canvas paper is gone', dflt.canvasBackground === undefined);
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

    // ═══ 7d7. Discord Activity: one room per voice channel ═══
    console.log('— discord activity —');
    const INST = 'instance-' + Math.floor(Math.random() * 1e9);
    const AC1 = connect({ guestKey: 'c'.repeat(31) + '1', name: 'Chan1' });
    await once(AC1, 'welcome');
    p = once(AC1, 'roomJoined');
    AC1.emit('joinActivity', { instanceId: INST, name: 'Chan1' });
    const act1 = await p;
    check('activity launch creates a room', /^[A-Z]{4}$/.test(act1.code) && act1.state.activity === true, JSON.stringify(act1.code));

    const AC2 = connect({ guestKey: 'c'.repeat(31) + '2', name: 'Chan2' });
    await once(AC2, 'welcome');
    p = once(AC2, 'roomJoined');
    AC2.emit('joinActivity', { instanceId: INST, name: 'Chan2' });
    const act2 = await p;
    check('same channel lands in the same room', act2.code === act1.code, act2.code + ' vs ' + act1.code);
    check('both players are in it', act2.state.players.length === 2);

    const AC3 = connect({ guestKey: 'c'.repeat(31) + '3', name: 'Other' });
    await once(AC3, 'welcome');
    p = once(AC3, 'roomJoined');
    AC3.emit('joinActivity', { instanceId: INST + '-different', name: 'Other' });
    const act3 = await p;
    check('a different channel gets its own room', act3.code !== act1.code);

    const AC4 = connect({ guestKey: 'c'.repeat(31) + '4', name: 'Nope' });
    await once(AC4, 'welcome');
    const badErr = once(AC4, 'error');
    AC4.emit('joinActivity', {});
    check('missing instance id refused', /which channel/i.test((await badErr).message));
    AC1.disconnect(); AC2.disconnect(); AC3.disconnect(); AC4.disconnect();

    // The Discord SDK shim must stay inert outside Discord, or the plain
    // website breaks for everyone.
    {
      const sandbox = { window: { location: { search: '', href: 'http://x/' }, addEventListener() {}, parent: { postMessage() {} } }, document: { referrer: '' } };
      const src = require('fs').readFileSync(path.join(__dirname, '..', 'public', 'js', 'discord.js'), 'utf8');
      require('vm').runInNewContext(src, sandbox);
      const D = sandbox.window.MiviDiscord;
      const api = ['isActivity','proxyPrefix','context','init','authorize','authenticate','participants','onParticipantsChange','setActivity','openInvite','openExternalLink'];
      check('discord shim exposes the whole contract', !!D && api.every(k => typeof D[k] === 'function'), D ? api.filter(k => typeof D[k] !== 'function').join(',') : 'no global');
      check('discord shim is inert outside Discord', D.isActivity() === false && D.proxyPrefix() === '');
      check('discord shim init resolves instead of throwing', (await D.init('x')).ok === false);
      check('discord shim no-ops resolve safely', (await D.participants()).length === 0 && (await D.setActivity({})) === undefined);
    }

    // ═══ 7d8. Activity mode headers + endpoints (server with Discord set up) ═══
    {
      const APORT = Number(PORT) + 7;
      const act = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
        env: {
          ...process.env, PORT: String(APORT), MIVI_NO_CONFIG: '1',
          MIVI_DATA_DIR: SMOKE_DATA + '-activity',
          DISCORD_CLIENT_ID: 'test-client-id', DISCORD_CLIENT_SECRET: 'test-secret',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      try {
        await new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(new Error('activity server did not start')), 8000);
          act.stdout.on('data', d => { if (String(d).includes('running')) { clearTimeout(t); resolve(); } });
        });
        const ABASE = `http://localhost:${APORT}`;
        const cfg = await (await fetch(ABASE + '/api/auth/config')).json();
        check('auth config advertises the activity', cfg.discord === true && cfg.activity === true && cfg.clientId === 'test-client-id', JSON.stringify(cfg));

        const head = await fetch(ABASE + '/');
        const csp = head.headers.get('content-security-policy') || '';
        check('CSP lets Discord embed the page', csp.includes('frame-ancestors') && csp.includes('discordsays.com') && csp.includes('https://discord.com'), csp.slice(0, 120));
        check('X-Frame-Options dropped in activity mode', !head.headers.get('x-frame-options'), String(head.headers.get('x-frame-options')));

        const noCode = await fetch(ABASE + '/api/auth/discord/activity', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
        check('activity sign-in needs a code', noCode.status === 400);

        // And with Discord switched off the strict headers come back.
        const OFFPORT = Number(PORT) + 8;
        const off = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
          env: { ...process.env, PORT: String(OFFPORT), MIVI_NO_CONFIG: '1', MIVI_DATA_DIR: SMOKE_DATA + '-off' },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        try {
          await new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('plain server did not start')), 8000);
            off.stdout.on('data', d => { if (String(d).includes('running')) { clearTimeout(t); resolve(); } });
          });
          const offHead = await fetch(`http://localhost:${OFFPORT}/`);
          check('without Discord the page still refuses framing',
            offHead.headers.get('x-frame-options') === 'DENY' &&
            (offHead.headers.get('content-security-policy') || '').includes("frame-ancestors 'none'"));
        } finally { off.kill(); }
      } finally { act.kill(); }
    }

    // ═══ 7d9. Backdrops keep the drawing; word-choice extremes ═══
    console.log('— backdrops keep art, choice extremes —');
    const KA = connect({ guestKey: 'd'.repeat(31) + '1', name: 'Keeper' });
    await once(KA, 'welcome');
    p = once(KA, 'roomCreated'); KA.emit('createRoom', { name: 'Keeper' }); const roomKA = (await p).code;
    const KB = connect({ guestKey: 'd'.repeat(31) + '2', name: 'Watcher2' });
    await once(KB, 'welcome');
    p = once(KB, 'roomJoined'); KB.emit('joinRoom', { code: roomKA }); await p;
    p = once(KA, 'stateUpdate');
    KA.emit('setGameOptions', { options: { rounds: 3, roundTime: 60, sceneBackgrounds: true, wordChoices: 25 } });
    const kaOpts = await p;
    check('word choices can go up to 25', kaOpts.options.wordChoices === 25);

    let wcKA = once(KA, 'wordChoices');
    KA.emit('startGame');
    const manyWords = (await wcKA).words;
    check('25 choices are actually offered', manyWords.length === 25, 'got ' + manyWords.length);
    let dsKB = once(KB, 'drawingStart');
    KA.emit('chooseWord', { word: manyWords[0] });
    await dsKB;

    // Draw something, then change the backdrop: the strokes must survive.
    KA.emit('draw', { type: 'line', x1: 10, y1: 10, x2: 90, y2: 90, color: '#111111', size: 6 });
    KA.emit('strokeEnd');
    await sleep(200);
    const sceneKeep = once(KB, 'sceneSet');
    KA.emit('setScene', { id: 'beach' });
    const kept = await sceneKeep;
    check('backdrop change keeps the drawing', kept.id === 'beach' && Array.isArray(kept.history) && kept.history.length >= 1,
      'history=' + (kept.history ? kept.history.length : 'none'));
    KA.disconnect(); KB.disconnect();

    // ═══ 7d10. No word choices → the word is dealt automatically ═══
    console.log('— dealt words & unlimited rounds —');
    const ZA = connect({ guestKey: 'd'.repeat(31) + '3', name: 'Dealt' });
    await once(ZA, 'welcome');
    p = once(ZA, 'roomCreated'); ZA.emit('createRoom', { name: 'Dealt' }); const roomZA = (await p).code;
    const ZB = connect({ guestKey: 'd'.repeat(31) + '4', name: 'Dealt2' });
    await once(ZB, 'welcome');
    p = once(ZB, 'roomJoined'); ZB.emit('joinRoom', { code: roomZA }); await p;
    p = once(ZA, 'stateUpdate');
    ZA.emit('setGameOptions', { options: { wordChoices: 0, rounds: 0, roundTime: 60 } });
    const zOpts = await p;
    check('word choices can be 0', zOpts.options.wordChoices === 0);
    check('rounds can be unlimited (0)', zOpts.options.rounds === 0);

    const yourWordZ = once(ZA, 'yourWord');
    const dsZB = once(ZB, 'drawingStart');
    let sawChoices = false;
    ZA.on('wordChoices', () => { sawChoices = true; });
    ZA.emit('startGame');
    const dealt = await yourWordZ;
    const dsz = await dsZB;
    check('a word is dealt with no picking step', !!dealt.word && !sawChoices, JSON.stringify(dealt.word));
    check('drawing starts straight away', dsz.state === 'drawing');
    ZA.disconnect(); ZB.disconnect();

    // ═══ 7d10b. Pens down: the canvas freezes on the first guess ═══
    console.log('— pens down —');
    const LA = connect({ guestKey: 'e'.repeat(31) + '1', name: 'Locker' });
    await once(LA, 'welcome');
    p = once(LA, 'roomCreated'); LA.emit('createRoom', { name: 'Locker' }); const roomLA = (await p).code;
    const LB = connect({ guestKey: 'e'.repeat(31) + '2', name: 'Guesser2' });
    const LC = connect({ guestKey: 'e'.repeat(31) + '3', name: 'Guesser3' });
    await once(LB, 'welcome'); await once(LC, 'welcome');
    p = once(LB, 'roomJoined'); LB.emit('joinRoom', { code: roomLA }); await p;
    p = once(LC, 'roomJoined'); LC.emit('joinRoom', { code: roomLA }); await p;
    p = once(LA, 'customListAdded'); LA.emit('addCustomList', { name: 'locky', text: 'stone\nplant\nchair\nbread' }); await p;
    p = once(LA, 'stateUpdate');
    LA.emit('setWordLists', { lists: ['locky'], weights: {} });
    await p;                       // let that broadcast land before the next
    p = once(LA, 'stateUpdate');
    LA.emit('setGameOptions', { options: { rounds: 1, roundTime: 60, lockOnGuess: true, autocorrectStrength: 0 } });
    check('pens-down option set', (await p).options.lockOnGuess === true);
    const wcLA = once(LA, 'wordChoices');
    LA.emit('startGame');
    const lockWord = (await wcLA).words[0];
    const dsLB = once(LB, 'drawingStart');
    LA.emit('chooseWord', { word: lockWord });
    await dsLB;
    LA.emit('draw', { type: 'line', x1: 1, y1: 1, x2: 9, y2: 9, color: '#111111', size: 6 });
    LA.emit('strokeEnd');
    await sleep(150);
    const lockedP = once(LC, 'canvasLocked');
    LB.emit('guess', { text: lockWord });
    const locked = await lockedP;
    check('first correct guess locks the canvas', locked.by === 'Guesser2', JSON.stringify(locked));
    let drewWhileLocked = false;
    const drawSpy = () => { drewWhileLocked = true; };
    LC.on('draw', drawSpy);
    LA.emit('draw', { type: 'line', x1: 20, y1: 20, x2: 40, y2: 40, color: '#111111', size: 6 });
    LA.emit('clearCanvas');
    await sleep(400);
    LC.off('draw', drawSpy);
    check('locked canvas refuses new strokes', !drewWhileLocked);
    LA.disconnect(); LB.disconnect(); LC.disconnect();

    // ═══ 7d11. Multi-word autocorrect is no longer a free pass ═══
    console.log('— multi-word autocorrect —');
    {
      const S = require('../lib/similarity');
      check('a real typo in a phrase still counts', S.matches('trafic light', 'traffic light', 3).ok);
      check('one typo per word is fine', S.matches('traffic ligth', 'traffic light', 2).ok);
      check('plurals still forgiven in phrases', S.matches('traffic lights', 'traffic light', 1).ok);
      check('wrong first letters are refused even on Generous', !S.matches('xraffic xight', 'traffic light', 3).ok);
      check('a wrong word is refused', !S.matches('traffic bight', 'traffic light', 3).ok);
      check('half a phrase is refused', !S.matches('traffic', 'traffic light', 3).ok);
      check('single words behave as before', S.matches('elephnat', 'elephant', 1).ok && !S.matches('cat', 'bat', 1).ok);
    }

    // ═══ 7d11b. Discord profile pictures + player counts ═══
    console.log('— profile pictures —');
    { const auth = require('../lib/auth');
      check('avatar url from a hash', auth.discordAvatarUrl('123456789012345678','abc') === 'https://cdn.discordapp.com/avatars/123456789012345678/abc.png?size=128');
      check('animated avatars use .gif', auth.discordAvatarUrl('123456789012345678', 'a_abc').endsWith('a_abc.gif?size=128'));
      const dfltAvatar = auth.discordAvatarUrl('123456789012345678', null);
      check('no avatar falls back to a default',
        dfltAvatar.startsWith('https://cdn.discordapp.com/embed/avatars/') && dfltAvatar.endsWith('.png'), dfltAvatar);
    }
    const PA = connect({ token, guestKey: '7'.repeat(32), name: 'Pictured' });
    await once(PA, 'welcome');
    p = once(PA, 'roomCreated'); PA.emit('createRoom', { name: 'Pictured' }); const paState = (await p).state;
    check('room state carries avatarUrl for players', 'avatarUrl' in paState.players[0], JSON.stringify(Object.keys(paState.players[0])));
    check('a guest-created account has no picture', paState.players[0].avatarUrl === null || typeof paState.players[0].avatarUrl === 'string');
    PA.disconnect();

    // ═══ 7d11c. Legal pages + global player totals ═══
    console.log('— legal pages & totals —');
    for (const doc of ['privacy', 'terms']) {
      const pageRes = await fetch(BASE + '/' + doc);
      const pageHtml = await pageRes.text();
      check(doc + ' page renders as html', pageRes.status === 200
        && (pageRes.headers.get('content-type') || '').includes('text/html')
        && /<h1>/.test(pageHtml) && pageHtml.includes('style.css'), pageRes.status + ' ' + pageHtml.slice(0, 60));
      check(doc + ' page escapes raw html', !/<script>alert/i.test(pageHtml));
      r = await rest('GET', '/legal/' + doc);
      check(doc + ' available to the in-app reader', r.status === 200 && typeof r.data.html === 'string' && r.data.html.length > 500 && !!r.data.title);
    }
    r = await rest('GET', '/legal/nonsense');
    check('unknown legal doc 404s', r.status === 404);

    // Totals count private rooms too, not just listed ones.
    r = await rest('GET', '/rooms');
    const before = r.data.totals.players;
    check('room totals are reported', typeof before === 'number' && typeof r.data.totals.rooms === 'number', JSON.stringify(r.data.totals));
    const TA = connect({ guestKey: '8'.repeat(32), name: 'Counted' });
    await once(TA, 'welcome');
    p = once(TA, 'roomCreated'); TA.emit('createRoom', { name: 'Counted' }); await p;
    await sleep(150);
    r = await rest('GET', '/rooms');
    check('a private room still counts toward the total', r.data.totals.players === before + 1, before + ' -> ' + r.data.totals.players);
    check('the private room is not listed publicly', !r.data.rooms.some(x => x.name === 'Counted'));
    TA.disconnect();

    // ═══ 7d12. Host downloads every list as a zip ═══
    console.log('— list zip —');
    const ZH = connect({ guestKey: 'f'.repeat(31) + '1', name: 'Zipper' });
    await once(ZH, 'welcome');
    p = once(ZH, 'roomCreated'); ZH.emit('createRoom', { name: 'Zipper' }); const roomZH = (await p).code;
    const ZG = connect({ guestKey: 'f'.repeat(31) + '2', name: 'NotHost' });
    await once(ZG, 'welcome');
    p = once(ZG, 'roomJoined'); ZG.emit('joinRoom', { code: roomZH }); await p;

    // A guest may not have them.
    const zipErr = once(ZG, 'error');
    ZG.emit('exportRoomLists');
    check('only the host can zip the lists', /only the host/i.test((await zipErr).message));

    // Add a custom list and leave it unselected, so both branches are covered.
    p = once(ZH, 'customListAdded');
    ZH.emit('addCustomList', { name: 'Zip Test', text: 'alpha\nbeta\ngamma' });
    await p;
    p = once(ZH, 'stateUpdate');
    ZH.emit('setWordLists', { lists: ['classic'], weights: {} });
    await p;

    const zipReady = once(ZH, 'roomListsReady');
    ZH.emit('exportRoomLists');
    const zipInfo = await zipReady;
    check('zip is offered to the host', /^\/api\/download\/[a-f0-9]{32}$/.test(zipInfo.url) && zipInfo.count === 2,
      JSON.stringify({ url: zipInfo.url, count: zipInfo.count }));

    const zipRes = await fetch(BASE + zipInfo.url);
    const zipBuf = Buffer.from(await zipRes.arrayBuffer());
    check('zip downloads as an attachment', zipRes.status === 200
      && (zipRes.headers.get('content-type') || '').includes('zip')
      && (zipRes.headers.get('content-disposition') || '').includes('.zip'));
    check('zip has the right shape', zipBuf.readUInt32LE(0) === 0x04034b50
      && zipBuf.readUInt32LE(zipBuf.length - 22) === 0x06054b50
      && zipBuf.readUInt16LE(zipBuf.length - 12) === 2,
      'entries=' + zipBuf.readUInt16LE(zipBuf.length - 12));

    // Unpack it for real to prove the bytes are a usable archive.
    {
      const os = require('os');
      const fs = require('fs');
      const zdir = path.join(os.tmpdir(), 'mivi-zip-' + process.pid);
      fs.mkdirSync(zdir, { recursive: true });
      const zfile = path.join(zdir, 'lists.zip');
      fs.writeFileSync(zfile, zipBuf);
      let names = [];
      let classicText = '';
      try {
        const { execFileSync } = require('child_process');
        execFileSync('powershell', ['-NoProfile', '-Command',
          `Expand-Archive -LiteralPath '${zfile}' -DestinationPath '${zdir}\\out' -Force`],
          { stdio: 'ignore' });
        names = fs.readdirSync(path.join(zdir, 'out'));
        const classic = names.find(n => /^Classic/i.test(n));
        if (classic) classicText = fs.readFileSync(path.join(zdir, 'out', classic), 'utf8');
      } catch (e) { names = ['<extract failed: ' + e.message + '>']; }
      check('zip extracts to real .txt files', names.length === 2 && names.every(n => n.endsWith('.txt')), names.join(', '));
      check('unselected lists are labelled', names.some(n => /^unused - Zip Test/.test(n)), names.join(', '));
      check('word list survives the round trip', classicText.split(/\r?\n/).filter(Boolean).length > 1000,
        'lines=' + classicText.split(/\r?\n/).filter(Boolean).length);
      try { fs.rmSync(zdir, { recursive: true, force: true }); } catch (e) {}
    }

    const badTok = await fetch(BASE + '/api/download/' + '0'.repeat(32));
    check('an unknown download token 404s', badTok.status === 404);
    ZH.disconnect(); ZG.disconnect();

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

    // ═══ 19. Batch 18: limits, spectators, relay, punctuation, import ═══
    console.log('— option limits —');
    {
      const H = connect({ guestKey: 'g-lim-' + Date.now() });
      await once(H, 'welcome');
      const joined = once(H, 'roomCreated');
      H.emit('createRoom', { name: 'Limits', avatar: '🎨' });
      const room = await joined;

      let up = once(H, 'stateUpdate');
      H.emit('setGameOptions', { options: { rounds: 0, wordChoices: 25 } });
      let st = await up;
      check('rounds 0 accepted (unlimited)', st.options.rounds === 0, String(st.options.rounds));
      check('wordChoices 25 accepted', st.options.wordChoices === 25, String(st.options.wordChoices));

      up = once(H, 'stateUpdate');
      H.emit('setGameOptions', { options: { rounds: 999, wordChoices: 99 } });
      st = await up;
      check('rounds clamped to 50', st.options.rounds === 50, String(st.options.rounds));
      check('wordChoices clamped to 25', st.options.wordChoices === 25, String(st.options.wordChoices));

      check('lock combo parts defaults off', st.options.lockComboParts === false, String(st.options.lockComboParts));
      check('show punctuation defaults on', st.options.showPunctuation === true, String(st.options.showPunctuation));

      // Relay depends on co-op.
      up = once(H, 'stateUpdate');
      H.emit('setGameOptions', { options: { coopMode: false, relayMode: true } });
      st = await up;
      check('relay refused without co-op', st.options.relayMode === false, String(st.options.relayMode));

      up = once(H, 'stateUpdate');
      H.emit('setGameOptions', { options: { coopMode: true, relayMode: true } });
      st = await up;
      check('relay accepted with co-op', st.options.relayMode === true);

      // The new custom modes, and the clamps around them.
      up = once(H, 'stateUpdate');
      H.emit('setGameOptions', { options: { mirrorMode: true, oneColorMode: true, suddenDeath: true, strokeLimit: 8, pickTime: 45, roundTime: 0 } });
      st = await up;
      check('custom modes stick', st.options.mirrorMode && st.options.oneColorMode && st.options.suddenDeath);
      check('stroke limit stored', st.options.strokeLimit === 8, String(st.options.strokeLimit));
      check('pick time stored', st.options.pickTime === 45, String(st.options.pickTime));
      check('draw time 0 accepted (no clock)', st.options.roundTime === 0, String(st.options.roundTime));

      up = once(H, 'stateUpdate');
      H.emit('setGameOptions', { options: { strokeLimit: 999, pickTime: 999 } });
      st = await up;
      check('stroke limit clamped to 50', st.options.strokeLimit === 50, String(st.options.strokeLimit));
      check('pick time clamped to 60', st.options.pickTime === 60, String(st.options.pickTime));

      up = once(H, 'stateUpdate');
      H.emit('setGameOptions', { options: { maxPlayers: 50 } });
      st = await up;
      check('rooms can seat up to 50', st.options.maxPlayers === 50, String(st.options.maxPlayers));
      up = once(H, 'stateUpdate');
      H.emit('setGameOptions', { options: { maxPlayers: 500 } });
      st = await up;
      check('max players clamped at 50', st.options.maxPlayers === 50, String(st.options.maxPlayers));

      H.disconnect();
      await sleep(150);
    }

    console.log('— punctuation in the blanks —');
    {
      const H = connect({ guestKey: 'g-punc-h-' + Date.now() });
      await once(H, 'welcome');
      const joined = once(H, 'roomCreated');
      H.emit('createRoom', { name: 'PuncHost', avatar: '🎨' });
      const code = (await joined).code;
      const G = connect({ guestKey: 'g-punc-g-' + Date.now() });
      await once(G, 'welcome');
      const gJoin = once(G, 'roomJoined');
      G.emit('joinRoom', { code, name: 'Guesser', avatar: '🐱' });
      await gJoin;

      let up = once(H, 'stateUpdate');
      H.emit('addCustomList', { name: 'Punct', text: "t-shirt" });
      await up;
      up = once(H, 'stateUpdate');
      H.emit('setWordLists', { lists: ['Punct'], weights: { Punct: 1 } });
      await up;
      up = once(H, 'stateUpdate');
      H.emit('setGameOptions', { options: { roundTime: 40, hintCount: 0, wordChoices: 0, showPunctuation: true } });
      await up;

      const drawing = once(G, 'drawingStart', 12000);
      H.emit('startGame');
      const ds = await drawing;
      check('hyphen shown for free when punctuation is on', ds.maskedWord.indexOf('-') !== -1, ds.maskedWord);
      check('letters still hidden', ds.maskedWord.indexOf('_') !== -1, ds.maskedWord);
      H.disconnect(); G.disconnect();
      await sleep(200);
    }

    console.log('— public match numbering —');
    {
      // Public matches should number by what is live, not by a counter that
      // only ever climbs.
      const A = connect({ guestKey: 'g-num-a-' + Date.now() });
      await once(A, 'welcome');
      const aJoin = once(A, 'roomJoined');
      A.emit('quickPlay', { name: 'Numbered', avatar: '🎨' });
      const aState = await aJoin;
      check('public match is named', /^Public Match #\d+$/.test(aState.state.name || ''), String(aState.state.name));
      A.disconnect();
      await sleep(150);
    }


    console.log('— relay drawing —');
    {
      // Three players, co-op + blind relay: the pen alternates between the
      // two artists and only the holder's strokes are accepted.
      const RH = connect({ guestKey: 'g-relay-h-' + Date.now() });
      await once(RH, 'welcome');
      let rp = once(RH, 'roomCreated');
      RH.emit('createRoom', { name: 'RelayHost', avatar: '🎨' });
      const rCode = (await rp).code;

      const R2 = connect({ guestKey: 'g-relay-2-' + Date.now() });
      await once(R2, 'welcome');
      rp = once(R2, 'roomJoined');
      R2.emit('joinRoom', { code: rCode, name: 'Partner', avatar: '🐱' });
      await rp;
      const R3 = connect({ guestKey: 'g-relay-3-' + Date.now() });
      await once(R3, 'welcome');
      rp = once(R3, 'roomJoined');
      R3.emit('joinRoom', { code: rCode, name: 'Guesser', avatar: '🐶' });
      await rp;

      let up = once(RH, 'stateUpdate');
      RH.emit('addCustomList', { name: 'Relay', text: 'rocket' });
      await up;
      up = once(RH, 'stateUpdate');
      RH.emit('setWordLists', { lists: ['Relay'], weights: { Relay: 1 } });
      await up;
      up = once(RH, 'stateUpdate');
      // roundTime 36 -> a 3-second slice, so the baton swaps quickly.
      RH.emit('setGameOptions', { options: {
        roundTime: 36, hintCount: 0, wordChoices: 0,
        coopMode: true, relayMode: true,
      } });
      const opts = await up;
      check('relay options stick', opts.options.relayMode === true);

      // Collect the baton events from the guesser's socket (everyone gets them).
      const holders = [];
      R3.on('relayTurn', (info) => {
        if (!holders.length || holders[holders.length - 1] !== info.holderId) holders.push(info.holderId);
      });

      // The co-op partner is drawn at random from everyone else, so watch
      // all three sockets rather than guessing who it will be.
      const cast = [[RH, 'RelayHost'], [R2, 'Partner'], [R3, 'Guesser']];
      const wordSeenBy = [];
      for (const [sock, who] of cast) {
        sock.on('yourWord', () => wordSeenBy.push(who));
      }

      const ds = await (async () => {
        const p2 = once(R3, 'drawingStart', 14000);
        RH.emit('startGame');
        return p2;
      })();
      check('relay round starts with two artists', !!ds.drawerId && !!ds.coopPartnerId, JSON.stringify({ d: ds.drawerId, p: ds.coopPartnerId }));

      await sleep(400);
      const nameOf = (id) => (ds.players.find(p => p.id === id) || {}).name;
      const drawerName = nameOf(ds.drawerId);
      const partnerName = nameOf(ds.coopPartnerId);
      check('both artists are told the word', wordSeenBy.length === 2
        && wordSeenBy.indexOf(drawerName) !== -1 && wordSeenBy.indexOf(partnerName) !== -1,
        JSON.stringify({ wordSeenBy, drawerName, partnerName }));
      const guesserName = nameOf(ds.players.find(p => p.id !== ds.drawerId && p.id !== ds.coopPartnerId).id);
      check('the guesser is never told the word', wordSeenBy.indexOf(guesserName) === -1, JSON.stringify(wordSeenBy));
      check('the baton starts with someone', holders.length >= 1, JSON.stringify(holders));

      // The artist who does NOT hold the pen must not be able to draw.
      const firstHolder = holders[0];
      const idleName = firstHolder === ds.drawerId ? partnerName : drawerName;
      const idle = (cast.find(([, who]) => who === idleName) || [])[0];
      if (idle) {
        let leaked = false;
        const spy = () => { leaked = true; };
        R3.on('draw', spy);
        idle.emit('draw', { type: 'line', x1: 1, y1: 1, x2: 9, y2: 9, color: '#111111', size: 6 });
        await sleep(400);
        R3.off('draw', spy);
        check('the artist without the pen cannot draw', !leaked);
      } else {
        check('the artist without the pen cannot draw', false, 'could not identify the idle artist');
      }

      // Wait out a slice and confirm the baton actually moves.
      await sleep(4200);
      check('the pen changes hands', holders.length >= 2, JSON.stringify(holders));

      RH.disconnect(); R2.disconnect(); R3.disconnect();
      await sleep(200);
    }

    console.log('— zip import —');
    {
      const zip = require('../lib/zip');
      const tokenZ = (await rest('POST', '/auth/test-login', { username: 'zipper' + Math.floor(Math.random() * 1e6) })).data.token;
      const buf = zip.zipTextFiles([
        { name: 'Fruit', content: 'apple\nbanana\ncherry' },
        { name: 'Tools', content: 'hammer\nsaw' },
      ]);
      let z = await rest('POST', '/lists/import-zip', { zip: buf.toString('base64') }, tokenZ);
      check('zip import creates the lists', z.status === 200 && z.data.lists.length === 2, JSON.stringify(z.data).slice(0, 160));
      check('imported list keeps its words', z.data.lists.some(l => l.name === 'Fruit' && l.count === 3), JSON.stringify(z.data.lists));

      z = await rest('POST', '/lists/import-zip', { zip: Buffer.from('not a zip').toString('base64') }, tokenZ);
      check('a non-zip is rejected', z.status === 400, JSON.stringify(z.data));

      z = await rest('POST', '/lists/import-zip', { zip: buf.toString('base64') });
      check('guests cannot import zips', z.status === 401);

      z = await rest('POST', '/lists/import-zip', {}, tokenZ);
      check('an empty import is rejected', z.status === 400);
    }

    console.log('— AI generator —');
    {
      // Moderators only, and it needs a key before it will do anything.
      const tokenN = (await rest('POST', '/auth/test-login', { username: 'notamod' + Math.floor(Math.random() * 1e6) })).data.token;
      let g = await rest('POST', '/mod/generate-list', { apiKey: 'sk-x', topic: 'kitchen' }, tokenN);
      check('non-moderators cannot generate lists', g.status === 403, JSON.stringify(g.data));
      g = await rest('POST', '/mod/generate-list', { apiKey: 'sk-x', topic: 'kitchen' });
      check('signed-out users cannot generate lists', g.status === 401);

      // 'Silk' is the bootstrap moderator when nobody holds the badge.
      const tokenM = (await rest('POST', '/auth/test-login', { username: 'Silk' })).data.token;
      g = await rest('POST', '/mod/generate-list', { topic: 'kitchen' }, tokenM);
      check('a moderator needs an API key', g.status === 400 && /API key/i.test(g.data.error || ''), JSON.stringify(g.data));
      g = await rest('POST', '/mod/generate-list', { apiKey: 'sk-x' }, tokenM);
      check('a moderator needs a topic', g.status === 400 && /topic/i.test(g.data.error || ''), JSON.stringify(g.data));
    }


    console.log('— one lobby at a time —');
    {
      const sharedKey = 'ab' + Date.now().toString(16).padStart(14, '0');
      const A1 = connect({ guestKey: sharedKey });
      await once(A1, 'welcome');
      let rp = once(A1, 'roomCreated');
      A1.emit('createRoom', { name: 'Solo', avatar: '🎨' });
      const firstCode = (await rp).code;

      // A second room, same identity, from a second socket.
      const A2 = connect({ guestKey: sharedKey });
      await once(A2, 'welcome');
      const failed = once(A2, 'error', 4000).catch(() => null);
      A2.emit('createRoom', { name: 'Solo', avatar: '🎨' });
      const err = await failed;
      check('you cannot sit in two rooms at once', !!err && /another tab/i.test(err.message || ''), JSON.stringify(err));

      // Once the first seat is gone, the room is free to take.
      A1.disconnect();
      await sleep(300);
      const okRoom = once(A2, 'roomCreated', 6000).catch(() => null);
      A2.emit('createRoom', { name: 'Solo', avatar: '🎨' });
      check('a stale seat is given up', !!(await okRoom));
      A2.disconnect();
      await sleep(150);
    }

    console.log('— custom modes —');
    {
      const MH = connect({ guestKey: 'g-mode-h-' + Date.now() });
      await once(MH, 'welcome');
      let rp = once(MH, 'roomCreated');
      MH.emit('createRoom', { name: 'ModeHost', avatar: '🎨' });
      const mCode = (await rp).code;
      const MG = connect({ guestKey: 'g-mode-g-' + Date.now() });
      await once(MG, 'welcome');
      rp = once(MG, 'roomJoined');
      MG.emit('joinRoom', { code: mCode, name: 'ModeGuesser', avatar: '🐱' });
      await rp;

      let up = once(MH, 'stateUpdate');
      MH.emit('addCustomList', { name: 'Modes', text: 'rocket' });
      await up;
      up = once(MH, 'stateUpdate');
      MH.emit('setWordLists', { lists: ['Modes'], weights: { Modes: 1 } });
      await up;
      up = once(MH, 'stateUpdate');
      MH.emit('setGameOptions', { options: {
        roundTime: 60, hintCount: 0, wordChoices: 0,
        mirrorMode: true, oneColorMode: true, strokeLimit: 2,
      } });
      await up;

      const ds = await (async () => {
        const p2 = once(MG, 'drawingStart', 12000);
        MH.emit('startGame');
        return p2;
      })();
      check('one colour picks a colour for the round', /^#[0-9a-f]{6}$/i.test(ds.roundColor || ''), String(ds.roundColor));
      check('the stroke limit reaches the client', ds.strokeLimit === 2, String(ds.strokeLimit));

      // Mirror: what the guesser receives is flipped from what was sent.
      const seen = once(MG, 'draw', 5000);
      MH.emit('draw', { type: 'line', x1: 100, y1: 50, x2: 200, y2: 60, color: '#123456', size: 6 });
      const ev = await seen;
      check('mirror flips the x coordinates', ev.x1 === 900 && ev.x2 === 800, JSON.stringify({ x1: ev.x1, x2: ev.x2 }));
      check('mirror leaves y alone', ev.y1 === 50 && ev.y2 === 60, JSON.stringify({ y1: ev.y1, y2: ev.y2 }));
      check('one colour overrides what the artist sent', ev.color === ds.roundColor, ev.color + ' vs ' + ds.roundColor);

      // Stroke budget: two strokes, then nothing more gets through.
      const b1 = once(MG, 'strokeBudget', 4000);
      MH.emit('strokeEnd');
      const budget1 = await b1;
      check('strokes are counted', budget1.used === 1 && budget1.limit === 2, JSON.stringify(budget1));
      const b2 = once(MG, 'strokeBudget', 4000);
      MH.emit('draw', { type: 'line', x1: 10, y1: 10, x2: 20, y2: 20, color: '#123456', size: 6 });
      MH.emit('strokeEnd');
      const budget2 = await b2;
      check('the budget runs down', budget2.used === 2, JSON.stringify(budget2));

      let leaked = false;
      const spy = () => { leaked = true; };
      MG.on('draw', spy);
      MH.emit('draw', { type: 'line', x1: 30, y1: 30, x2: 40, y2: 40, color: '#123456', size: 6 });
      await sleep(400);
      MG.off('draw', spy);
      check('drawing stops once the strokes run out', !leaked);

      MH.disconnect(); MG.disconnect();
      await sleep(200);
    }

    console.log('— sudden death & no clock —');
    {
      const SH = connect({ guestKey: 'g-sd-h-' + Date.now() });
      await once(SH, 'welcome');
      let rp = once(SH, 'roomCreated');
      SH.emit('createRoom', { name: 'SDHost', avatar: '🎨' });
      const sCode = (await rp).code;
      const S2 = connect({ guestKey: 'g-sd-2-' + Date.now() });
      await once(S2, 'welcome');
      rp = once(S2, 'roomJoined');
      S2.emit('joinRoom', { code: sCode, name: 'SD2', avatar: '🐱' });
      await rp;
      const S3 = connect({ guestKey: 'g-sd-3-' + Date.now() });
      await once(S3, 'welcome');
      rp = once(S3, 'roomJoined');
      S3.emit('joinRoom', { code: sCode, name: 'SD3', avatar: '🐶' });
      await rp;

      let up = once(SH, 'stateUpdate');
      SH.emit('addCustomList', { name: 'SD', text: 'rocket' });
      await up;
      up = once(SH, 'stateUpdate');
      SH.emit('setWordLists', { lists: ['SD'], weights: { SD: 1 } });
      await up;
      up = once(SH, 'stateUpdate');
      // No clock at all, and the first guess takes the round.
      SH.emit('setGameOptions', { options: { roundTime: 0, hintCount: 0, wordChoices: 0, suddenDeath: true } });
      await up;

      const ds = await (async () => {
        const p2 = once(S2, 'drawingStart', 12000);
        SH.emit('startGame');
        return p2;
      })();
      check('an untimed round reports no clock', ds.roundSeconds === 0, String(ds.roundSeconds));

      // With no clock, the timer must not tick down to an early finish.
      const t1 = await once(S2, 'timerTick', 4000);
      check('the clock does not run', t1.untimed === true && t1.timeLeft === 0, JSON.stringify(t1));

      // Only one of the two guessers needs to get it.
      const ended = once(S2, 'roundEnd', 8000);
      S2.emit('guess', { text: 'rocket' });
      const re = await ended;
      check('sudden death ends the round on the first guess', !!re && re.word === 'rocket', JSON.stringify(re && re.word));

      SH.disconnect(); S2.disconnect(); S3.disconnect();
      await sleep(200);
    }

    console.log('— public-match voting —');
    {
      // Three in a public match so a vote can actually carry.
      const socks = [];
      for (let i = 0; i < 3; i++) {
        const s = connect({ guestKey: 'g-vote-' + i + '-' + Date.now() });
        await once(s, 'welcome');
        const j = once(s, 'roomJoined');
        s.emit('quickPlay', { name: 'Voter' + i, avatar: '🎨' });
        await j;
        socks.push(s);
      }
      const [V0, V1, V2] = socks;

      // Private-room rules do not apply here — there is no host to ask.
      const started = once(V1, 'poll', 5000);
      V0.emit('startPoll', { kind: 'addList', name: 'Voted list', text: 'apple\nbanana\ncherry' });
      const poll = await started;
      check('a vote starts', !!poll && poll.kind === 'addList', JSON.stringify(poll));
      check('the proposer counts as a yes', poll.yes === 1, String(poll.yes));
      check('the vote says what it needs', poll.needed >= 2, JSON.stringify({ needed: poll.needed, eligible: poll.eligible }));

      // One more yes carries it.
      const stateAfter = once(V0, 'stateUpdate', 6000);
      V1.emit('votePoll', { yes: true });
      const st = await stateAfter;
      check('a carried vote adds the list',
        st.wordLists.available.some(l => l.name === 'Voted list'),
        JSON.stringify(st.wordLists.available.map(l => l.name)));

      // A second vote from the same person is refused while cooling down.
      const cool = once(V0, 'error', 4000).catch(() => null);
      V0.emit('startPoll', { kind: 'kick', playerId: 'nobody' });
      check('proposers have a cooldown', !!(await cool));

      for (const s of socks) s.disconnect();
      await sleep(200);
    }

    console.log('— unique usernames & friends by name —');
    {
      const n = Math.floor(Math.random() * 1e6);
      const t1 = (await rest('POST', '/auth/test-login', { username: 'Twin' + n })).data;
      check('first account keeps the name', t1.user.username === 'Twin' + n, t1.user.username);

      // A rename onto a taken name is refused.
      const t2 = (await rest('POST', '/auth/test-login', { username: 'Other' + n })).data;
      let r = await rest('PUT', '/auth/me', { username: 'Twin' + n }, t2.token);
      check('a taken username is refused', r.status === 409, JSON.stringify(r.data));

      // Friend requests work by username.
      r = await rest('POST', '/friends/request', { username: 'Twin' + n }, t2.token);
      check('friend request by username', r.status === 200 && r.data.ok, JSON.stringify(r.data));
      r = await rest('POST', '/friends/request', { username: 'nobody-at-all-' + n }, t2.token);
      check('an unknown username is a clear 404', r.status === 404 && /username/i.test(r.data.error || ''), JSON.stringify(r.data));
    }

    console.log('— library hub —');
    {
      const tokenL = (await rest('POST', '/auth/test-login', { username: 'librarian' + Math.floor(Math.random() * 1e6) })).data.token;
      let r = await rest('POST', '/library', {
        name: 'Deep sea things',
        description: 'Creatures and objects from the bottom of the ocean.',
        tags: ['animals', 'nature', 'nonsense-tag'],
        words: ['squid', 'anglerfish', 'shipwreck', 'coral'],
      }, tokenL);
      check('a shared list keeps its description', r.status === 200 && r.data.list.description.startsWith('Creatures'), JSON.stringify(r.data.list));
      check('only real tags survive', JSON.stringify(r.data.list.tags) === '["animals","nature"]', JSON.stringify(r.data.list.tags));
      check('difficulty is worked out', ['easy', 'medium', 'hard'].includes(r.data.list.difficulty), r.data.list.difficulty);
      check('a preview comes back', Array.isArray(r.data.list.preview) && r.data.list.preview.length > 0);
      const libId = r.data.list.id;

      r = await rest('GET', '/library?q=anglerfish');
      check('search finds a list by a word inside it', r.data.lists.some(l => l.id === libId), JSON.stringify(r.data.total));
      r = await rest('GET', '/library?q=bottom of the ocean');
      check('search reads the description', r.data.lists.some(l => l.id === libId));
      r = await rest('GET', '/library?tag=animals');
      check('filtering by tag works', r.data.lists.some(l => l.id === libId));
      r = await rest('GET', '/library?tag=sport');
      check('a tag with no matches returns nothing', !r.data.lists.some(l => l.id === libId));
      r = await rest('GET', '/library?minWords=99');
      check('the word-count filter applies', !r.data.lists.some(l => l.id === libId));
      r = await rest('GET', '/library');
      check('facets come back for the filter UI', Array.isArray(r.data.facets.tags) && Array.isArray(r.data.facets.authors));

      r = await rest('PUT', '/library/' + libId, {
        description: 'Updated description here.',
        tags: ['places'],
        words: ['squid', 'kraken'],
      }, tokenL);
      check('an owner can edit their list', r.status === 200 && r.data.list.count === 2, JSON.stringify(r.data.list));
      check('the edit updates the description', r.data.list.description === 'Updated description here.');
      check('the edit updates the tags', JSON.stringify(r.data.list.tags) === '["places"]');

      const tokenX = (await rest('POST', '/auth/test-login', { username: 'stranger' + Math.floor(Math.random() * 1e6) })).data.token;
      r = await rest('PUT', '/library/' + libId, { name: 'Hijacked' }, tokenX);
      check('somebody else cannot edit it', r.status === 404, JSON.stringify(r.data));

      // Sharing a zip straight to the library.
      const zip = require('../lib/zip');
      const buf = zip.zipTextFiles([{ name: 'Shared A', content: 'one\ntwo' }, { name: 'Shared B', content: 'three' }]);
      r = await rest('POST', '/library/import-zip', { zip: buf.toString('base64'), description: 'From a zip', tags: ['games'] }, tokenL);
      check('a zip can be shared to the library', r.status === 200 && r.data.lists.length === 2, JSON.stringify(r.data).slice(0, 140));
      check('zipped lists carry the description', r.data.lists.every(l => l.description === 'From a zip'));
      r = await rest('POST', '/library/import-zip', { zip: buf.toString('base64') });
      check('guests cannot share a zip', r.status === 401);
    }

    console.log('— gallery holds GIFs —');
    {
      const tokenG = (await rest('POST', '/auth/test-login', { username: 'giffer' + Math.floor(Math.random() * 1e6) })).data.token;
      // A minimal but real GIF89a header.
      const gifBytes = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(20, 1)]);
      let r = await rest('POST', '/drawings', {
        dataUrl: 'data:image/gif;base64,' + gifBytes.toString('base64'),
        word: 'Game recap · 4 rounds', artist: 'giffer',
      }, tokenG);
      check('a GIF can be saved to the gallery', r.status === 200 && r.data.ok, JSON.stringify(r.data));
      const gifId = r.data.id;
      r = await rest('GET', '/drawings', undefined, tokenG);
      check('the gallery marks it as a gif', r.data.drawings.some(d => d.id === gifId && d.kind === 'gif'), JSON.stringify(r.data.drawings));

      const img = await fetch(BASE + '/api/drawings/' + gifId + '/image');
      check('it is served as image/gif', (img.headers.get('content-type') || '').includes('image/gif'), img.headers.get('content-type'));

      r = await rest('POST', '/drawings', { dataUrl: 'data:image/gif;base64,' + Buffer.from('NOTAGIF').toString('base64') }, tokenG);
      check('something that is not a GIF is refused', r.status === 400, JSON.stringify(r.data));
    }


    console.log('— wet paint —');
    {
      const WH = connect({ guestKey: 'cc' + Date.now().toString(16).padStart(14, '0') });
      await once(WH, 'welcome');
      let rp = once(WH, 'roomCreated');
      WH.emit('createRoom', { name: 'WetHost', avatar: '🎨' });
      const wCode = (await rp).code;
      const WG = connect({ guestKey: 'cd' + Date.now().toString(16).padStart(14, '0') });
      await once(WG, 'welcome');
      rp = once(WG, 'roomJoined');
      WG.emit('joinRoom', { code: wCode, name: 'WetGuesser', avatar: '🐱' });
      await rp;

      let up = once(WH, 'stateUpdate');
      WH.emit('addCustomList', { name: 'Wet', text: 'rocket' });
      await up;
      up = once(WH, 'stateUpdate');
      WH.emit('setWordLists', { lists: ['Wet'], weights: { Wet: 1 } });
      await up;
      up = once(WH, 'stateUpdate');
      // A 30s round: the line starts moving at 20% (6s) and is right across by 95%.
      WH.emit('setGameOptions', { options: { roundTime: 30, hintCount: 0, wordChoices: 0, wetPaint: true } });
      const wOpts = await up;
      check('wet paint option sticks', wOpts.options.wetPaint === true);

      const ds = await (async () => {
        const p2 = once(WG, 'drawingStart', 12000);
        WH.emit('startGame');
        return p2;
      })();
      check('the round starts with the page still wet', ds.dryLine === 0, String(ds.dryLine));

      // Nothing has set yet, so a mark at the far left must land.
      const early = once(WG, 'draw', 5000);
      WH.emit('draw', { type: 'line', x1: 20, y1: 100, x2: 60, y2: 120, color: '#111111', size: 6 });
      const gotEarly = await early;
      check('you can paint anywhere while it is wet', gotEarly.x1 === 20, JSON.stringify(gotEarly.x1));

      // Wait for the line to move well past the left edge.
      let dry = { x: 0 };
      for (let i = 0; i < 20 && dry.x < 200; i++) dry = await once(WH, 'dryLine', 4000);
      check('the dry line sweeps across', dry.x > 0, 'x=' + dry.x);

      // A mark behind the line must reach nobody.
      let leaked = false;
      const spy = () => { leaked = true; };
      WG.on('draw', spy);
      const blocked = once(WH, 'drawBlocked', 4000);
      WH.emit('draw', { type: 'line', x1: 5, y1: 200, x2: 30, y2: 210, color: '#111111', size: 6 });
      const why = await blocked;
      await sleep(300);
      WG.off('draw', spy);
      check('set paint refuses a new mark', why && why.reason === 'dry', JSON.stringify(why));
      check('a blocked mark reaches nobody', !leaked);

      // Ahead of the line still works.
      const ahead = once(WG, 'draw', 5000);
      WH.emit('draw', { type: 'line', x1: 960, y1: 300, x2: 980, y2: 320, color: '#111111', size: 6 });
      check('you can still paint ahead of the line', !!(await ahead));

      // Clearing would wipe dried paint, so it is refused too.
      const clearBlocked = once(WH, 'drawBlocked', 4000);
      WH.emit('clearCanvas');
      const cb = await clearBlocked;
      check('clearing is refused once paint has set', cb && cb.reason === 'dryClear', JSON.stringify(cb));

      WH.disconnect(); WG.disconnect();
      await sleep(200);
    }

    console.log('— tile reveal —');
    {
      const TH = connect({ guestKey: 'ce' + Date.now().toString(16).padStart(14, '0') });
      await once(TH, 'welcome');
      let rp = once(TH, 'roomCreated');
      TH.emit('createRoom', { name: 'TileHost', avatar: '🎨' });
      const tCode = (await rp).code;
      const TG = connect({ guestKey: 'cf' + Date.now().toString(16).padStart(14, '0') });
      await once(TG, 'welcome');
      rp = once(TG, 'roomJoined');
      TG.emit('joinRoom', { code: tCode, name: 'TileGuesser', avatar: '🐱' });
      await rp;

      let up = once(TH, 'stateUpdate');
      TH.emit('addCustomList', { name: 'Tiles', text: 'rocket' });
      await up;
      up = once(TH, 'stateUpdate');
      TH.emit('setWordLists', { lists: ['Tiles'], weights: { Tiles: 1 } });
      await up;
      up = once(TH, 'stateUpdate');
      TH.emit('setGameOptions', { options: { roundTime: 60, hintCount: 0, wordChoices: 0, tileReveal: true } });
      await up;

      const ds = await (async () => {
        const p2 = once(TG, 'drawingStart', 12000);
        TH.emit('startGame');
        return p2;
      })();
      check('two shutters start up', Array.isArray(ds.tilesOpen) && ds.tilesOpen.length === 2, JSON.stringify(ds.tilesOpen));

      // Find a tile that is definitely still shut, and one that is open.
      const open = new Set(ds.tilesOpen);
      let shutTile = -1;
      for (let i = 0; i < 12; i++) if (!open.has(i)) { shutTile = i; break; }
      const openTile = ds.tilesOpen[0];
      const centreOf = (t) => ({ x: (t % 4) * 250 + 125, y: Math.floor(t / 4) * 250 + 125 });

      // A mark behind a closed shutter must not reach the guesser at all.
      let leaked = false;
      const spy = () => { leaked = true; };
      TG.on('draw', spy);
      TG.on('drawBatch', spy);
      const hidden = centreOf(shutTile);
      TH.emit('draw', { type: 'line', x1: hidden.x, y1: hidden.y, x2: hidden.x + 10, y2: hidden.y + 10, color: '#111111', size: 6 });
      await sleep(400);
      TG.off('draw', spy);
      TG.off('drawBatch', spy);
      check('a mark behind a shutter is never sent', !leaked);

      // A mark in an open tile arrives immediately.
      const shown = centreOf(openTile);
      const seen = once(TG, 'draw', 5000);
      TH.emit('draw', { type: 'line', x1: shown.x, y1: shown.y, x2: shown.x + 10, y2: shown.y + 10, color: '#111111', size: 6 });
      check('a mark in an open tile arrives', !!(await seen));

      // A reconnecting guesser must not be replayed the hidden marks either.
      const resync = once(TG, 'drawHistory', 5000);
      TG.emit('requestState');
      const hist = await resync;
      const sawHidden = (hist.history || []).some(ev =>
        Math.floor((ev.x1 ?? ev.x ?? 0) / 250) + Math.floor((ev.y1 ?? ev.y ?? 0) / 250) * 4 === shutTile);
      check('a resync does not leak hidden marks', !sawHidden, JSON.stringify((hist.history || []).length));

      // The bucket would bleed under the shutters, so it is refused.
      const fillErr = once(TH, 'error', 4000);
      TH.emit('draw', { type: 'fill', x: 500, y: 300, color: '#ff0000' });
      const fe = await fillErr;
      check('the bucket is held back until the last shutter', !!fe && /bucket|shutter/i.test(fe.message || ''), JSON.stringify(fe));

      // Everything is revealed when the round ends.
      const revealed = once(TG, 'tilesOpen', 8000);
      const ended = once(TG, 'roundEnd', 8000);
      TG.emit('guess', { text: 'rocket' });
      const rv = await revealed;
      check('every shutter lifts at the end', rv.all === true && rv.open.length === 12, JSON.stringify(rv.open.length));
      await ended;

      TH.disconnect(); TG.disconnect();
      await sleep(200);
    }


    console.log('— draw event validation —');
    {
      const VH = connect({ guestKey: 'da' + Date.now().toString(16).padStart(14, '0') });
      await once(VH, 'welcome');
      let rp = once(VH, 'roomCreated');
      VH.emit('createRoom', { name: 'ValHost', avatar: '🎨' });
      const vCode = (await rp).code;
      const VG = connect({ guestKey: 'db' + Date.now().toString(16).padStart(14, '0') });
      await once(VG, 'welcome');
      rp = once(VG, 'roomJoined');
      VG.emit('joinRoom', { code: vCode, name: 'ValGuess', avatar: '🐱' });
      await rp;

      let up = once(VH, 'stateUpdate');
      VH.emit('addCustomList', { name: 'Val', text: 'rocket' });
      await up;
      up = once(VH, 'stateUpdate');
      VH.emit('setWordLists', { lists: ['Val'], weights: { Val: 1 } });
      await up;
      up = once(VH, 'stateUpdate');
      VH.emit('setGameOptions', { options: { roundTime: 90, hintCount: 0, wordChoices: 0 } });
      await up;

      await (async () => { const p2 = once(VG, 'drawingStart', 12000); VH.emit('startGame'); return p2; })();

      // The arrow is a real shape now.
      const arrow = once(VG, 'draw', 5000);
      VH.emit('draw', { type: 'arrow', x1: 100, y1: 100, x2: 300, y2: 200, color: '#112233', size: 8 });
      const a = await arrow;
      check('arrow shapes are relayed', a.type === 'arrow' && a.x2 === 300, JSON.stringify(a));

      // Junk fields are stripped rather than relayed.
      const clean = once(VG, 'draw', 5000);
      VH.emit('draw', { type: 'line', x1: 10, y1: 10, x2: 20, y2: 20, color: 'javascript:evil', size: 9999, evil: 'x' });
      const c = await clean;
      check('a bad colour falls back', /^#[0-9a-f]{6}$/i.test(c.color), String(c.color));
      check('size is clamped', c.size <= 80, String(c.size));
      check('unknown fields are dropped', c.evil === undefined, JSON.stringify(Object.keys(c)));

      // Coordinates cannot run miles off canvas.
      const far = once(VG, 'draw', 5000);
      VH.emit('draw', { type: 'line', x1: -99999, y1: 99999, x2: 5, y2: 5, color: '#000000', size: 4 });
      const f = await far;
      check('coordinates are clamped', f.x1 >= -200 && f.y1 <= 950, JSON.stringify({ x1: f.x1, y1: f.y1 }));

      // An unknown shape reaches nobody.
      let leaked = false;
      const spy = () => { leaked = true; };
      VG.on('draw', spy);
      VH.emit('draw', { type: 'nonsense', x1: 1, y1: 1, x2: 2, y2: 2 });
      await sleep(350);
      VG.off('draw', spy);
      check('unknown shapes are dropped', !leaked);

      VH.disconnect(); VG.disconnect();
      await sleep(200);
    }

    console.log('— moderator statistics —');
    {
      const tokenN = (await rest('POST', '/auth/test-login', { username: 'plain' + Math.floor(Math.random() * 1e6) })).data.token;
      let r = await rest('GET', '/mod/stats', undefined, tokenN);
      check('statistics are moderators-only', r.status === 403, JSON.stringify(r.data));
      r = await rest('GET', '/mod/stats');
      check('statistics need a sign-in', r.status === 401);

      const tokenM = (await rest('POST', '/auth/test-login', { username: 'Silk' })).data.token;
      r = await rest('GET', '/mod/stats?range=7d', undefined, tokenM);
      check('a moderator gets statistics', r.status === 200 && !!r.data.players && !!r.data.totals, JSON.stringify(r.data).slice(0, 120));
      check('the requested range comes back', r.data.players.range === '7d', String(r.data.players.range));
      check('accounts-per-day series is present', Array.isArray(r.data.accounts.points) && r.data.accounts.points.length > 0);
      check('account totals are counted', typeof r.data.totals.accounts === 'number' && r.data.totals.accounts > 0, String(r.data.totals.accounts));
      check('moderation summary is present', Array.isArray(r.data.moderation.moderators) && Array.isArray(r.data.moderation.banned));
      check('library figures are present', typeof r.data.totals.librarySharedLists === 'number');

      r = await rest('GET', '/mod/stats?range=nonsense', undefined, tokenM);
      check('a bogus range falls back to 24h', r.data.players.range === '24h', String(r.data.players.range));
    }

    console.log('— private lists & share links —');
    {
      const tokenS = (await rest('POST', '/auth/test-login', { username: 'sharer' + Math.floor(Math.random() * 1e6) })).data.token;
      let r = await rest('POST', '/lists', { name: 'Secret things', words: ['ghost', 'attic'] }, tokenS);
      check('a personal list is created', r.status === 200, JSON.stringify(r.data));
      const listId = r.data.list.id;
      check('personal lists are private by default', r.data.list.shared === false, JSON.stringify(r.data.list));

      r = await rest('POST', '/lists/' + listId + '/share', { shared: true }, tokenS);
      check('sharing can be switched on', r.status === 200 && r.data.shared === true && !!r.data.token, JSON.stringify(r.data));
      const shareToken = r.data.token;
      check('the share url points at the site', String(r.data.url || '').indexOf('/?list=') !== -1, String(r.data.url));

      // The link works without signing in, and only exposes the list.
      r = await rest('GET', '/share/' + shareToken);
      check('anyone with the link can read it', r.status === 200 && r.data.list.name === 'Secret things', JSON.stringify(r.data).slice(0, 120));
      check('the link carries the words', Array.isArray(r.data.list.words) && r.data.list.words.length === 2);
      check('the link names the author', typeof r.data.list.author === 'string' && r.data.list.author.length > 0);

      // Someone else cannot toggle sharing on your list.
      const tokenO = (await rest('POST', '/auth/test-login', { username: 'other' + Math.floor(Math.random() * 1e6) })).data.token;
      r = await rest('POST', '/lists/' + listId + '/share', { shared: false }, tokenO);
      check('only the owner can change sharing', r.status === 404, JSON.stringify(r.data));

      // And it can be turned back off.
      r = await rest('POST', '/lists/' + listId + '/share', { shared: false }, tokenS);
      check('sharing can be revoked', r.status === 200 && r.data.shared === false);
      r = await rest('GET', '/share/' + shareToken);
      check('a revoked link stops working', r.status === 404, JSON.stringify(r.data));

      r = await rest('GET', '/share/not-a-real-token');
      check('a bogus token 404s', r.status === 404);
    }

    console.log('— word balance —');
    {
      // Strict round-robin: no word may be drawn N+1 times while a
      // list-mate is still on N.
      const wordsLib = require('../lib/words');
      const roomStub = {
        customLists: { Bal: ['alpha', 'beta', 'gamma', 'delta'] },
        selectedLists: ['Bal'],
        listWeights: {},
        options: { avoidRepeats: false },
        wordUsedCount: {},
        wordOffered: new Set(),
      };
      let balanced = true;
      for (let i = 0; i < 40; i++) {
        const picks = wordsLib.getWordChoicesWithSource(roomStub, 1);
        const w = picks[0].word;
        roomStub.wordUsedCount[w] = (roomStub.wordUsedCount[w] || 0) + 1;
        const counts = ['alpha', 'beta', 'gamma', 'delta'].map(x => roomStub.wordUsedCount[x] || 0);
        if (Math.max(...counts) - Math.min(...counts) > 1) balanced = false;
      }
      check('words are drawn in strict rotation', balanced, JSON.stringify(roomStub.wordUsedCount));
    }

    console.log('— the odds shown next to each list are honest —');
    {
      // The UI shows weight / total weight. That must be what actually
      // happens: a list's SIZE must not move its share.
      const wordsLib = require('../lib/words');
      const mk = (n, tag) => Array.from({ length: n }, (_, i) => tag + i);
      const lists = { Big: mk(300, 'b'), Tiny: mk(4, 't') };
      const runShare = (weights, N) => {
        const room = {
          customLists: lists,
          selectedLists: ['Big', 'Tiny'],
          listWeights: weights,
          options: { avoidRepeats: false },
          wordUsedCount: {},
          wordOffered: new Set(),
        };
        let tiny = 0;
        for (let i = 0; i < N; i++) {
          const pick = wordsLib.getWordChoicesWithSource(room, 1);
          if (pick.length && pick[0].listName === 'Tiny') tiny++;
        }
        return (tiny / N) * 100;
      };

      const evenShare = runShare({ Big: 1, Tiny: 1 }, 4000);
      check('equal weights split evenly however big the lists are',
        Math.abs(evenShare - 50) < 4, evenShare.toFixed(1) + '% from the 4-word list');

      const heavyShare = runShare({ Big: 1, Tiny: 3 }, 4000);
      check('a 3x weight really is a 75% share',
        Math.abs(heavyShare - 75) < 4, heavyShare.toFixed(1) + '%');
    }

    console.log('— list ownership survives a host transfer —');
    {
      const OH = connect({ guestKey: 'ea' + Date.now().toString(16).padStart(14, '0') });
      await once(OH, 'welcome');
      let rp = once(OH, 'roomCreated');
      OH.emit('createRoom', { name: 'Owner', avatar: '🎨' });
      const oCode = (await rp).code;
      const OG = connect({ guestKey: 'eb' + Date.now().toString(16).padStart(14, '0') });
      await once(OG, 'welcome');
      rp = once(OG, 'roomJoined');
      OG.emit('joinRoom', { code: oCode, name: 'NextHost', avatar: '🐱' });
      await rp;

      let up = once(OH, 'stateUpdate');
      OH.emit('addCustomList', { name: 'MySecrets', text: 'unicorn\ndragon' });
      await up;

      // The person who added it can read it…
      const mine = once(OH, 'customListWords', 5000);
      OH.emit('getCustomList', { name: 'MySecrets' });
      check('the contributor can read their list', (await mine).words.length === 2);

      // …a room-mate cannot, host or not.
      const refused = once(OG, 'error', 4000);
      OG.emit('getCustomList', { name: 'MySecrets' });
      check('someone else cannot read it', /added that list/i.test((await refused).message || ''));
      const refused2 = once(OG, 'error', 4000);
      OG.emit('exportCustomList', { name: 'MySecrets' });
      check('someone else cannot export it', /added that list/i.test((await refused2).message || ''));

      // Built-ins are open to everyone.
      const classic = once(OG, 'customListWords', 5000);
      OG.emit('getCustomList', { name: 'classic' });
      check('built-in lists are readable by anyone', (await classic).words.length > 10);

      // The list is flagged with its owner in the room state.
      const st = once(OH, 'stateUpdate', 5000);
      OH.emit('requestState');
      const stData = await st;
      const entry = stData.wordLists.available.find(l => l.name === 'MySecrets');
      check('the state names the list owner', !!entry && typeof entry.owner === 'string', JSON.stringify(entry && entry.owner));

      OH.disconnect(); OG.disconnect();
      await sleep(200);
    }

    console.log('— leaderboard & version —');
    {
      let r = await rest('GET', '/auth/config');
      check('the config carries the version', /^Beta /.test(r.data.versionLabel || ''), JSON.stringify(r.data.versionLabel));
      check('the version reads major.minor.patch', /^Beta \d+\.\d+\.\d+$/.test(r.data.versionLabel || ''), JSON.stringify(r.data.versionLabel));
      {
        // The rollover rule: the last number carries into the middle one at
        // 9, and the middle one into the first.
        const ver = require('../lib/version');
        const seq = (start, n) => { let p = start, out = []; for (let i = 0; i < n; i++) { p = ver.bump(p); out.push(p.join('.')); } return out; };
        check('a normal release bumps the last number', ver.bump([1, 2, 4]).join('.') === '1.2.5', ver.bump([1, 2, 4]).join('.'));
        check('past nine it carries into the middle number', ver.bump([1, 2, 9]).join('.') === '1.3.0', ver.bump([1, 2, 9]).join('.'));
        check('past nine again it carries into the first', ver.bump([1, 9, 9]).join('.') === '2.0.0', ver.bump([1, 9, 9]).join('.'));
        check('the run is unbroken across a carry',
          seq([1, 2, 7], 5).join(' ') === '1.2.8 1.2.9 1.3.0 1.3.1 1.3.2', seq([1, 2, 7], 5).join(' '));
        check('the shipped version matches its own parts', ver.PARTS.join('.') === ver.VERSION);
      }

      r = await rest('GET', '/leaderboard');
      check('the leaderboard is public', r.status === 200 && r.data.categories, JSON.stringify(r.status));
      const cats = ['games', 'wins', 'points', 'guesses', 'drawn', 'likes'];
      check('all six categories are there', cats.every(c => r.data.categories[c] && Array.isArray(r.data.categories[c].rows)));
      const pts = r.data.categories.points.rows;
      const sorted = pts.every((row, i) => i === 0 || pts[i - 1].value >= row.value);
      check('rows are ranked high to low', sorted);
      check('total player count reported', typeof r.data.players === 'number');
    }

    console.log('— mod status is stored & reported —');
    {
      const tokenM = (await rest('POST', '/auth/test-login', { username: 'Silk' })).data.token;
      // Touching a mod power makes the bootstrap badge permanent (stored).
      await rest('GET', '/mod/users', undefined, tokenM);
      const r = await rest('GET', '/mod/stats?range=24h', undefined, tokenM);
      check('the moderator list is not empty', r.data.moderation.moderators.length >= 1, JSON.stringify(r.data.moderation.moderators));
      check('Silk holds a stored badge', r.data.moderation.moderators.some(m => m.username === 'Silk'));
      check('total accounts on the site are reported', r.data.totals.accounts >= 1, String(r.data.totals.accounts));
    }

    console.log('— a moderator can test a room solo —');
    {
      const hex = () => Date.now().toString(16).padStart(16, '0') + Math.floor(Math.random() * 1e6).toString(16).padStart(8, '0');

      // An ordinary host alone is still refused.
      const tokenN = (await rest('POST', '/auth/test-login', { username: 'solonot' + Math.floor(Math.random() * 1e6) })).data.token;
      const SN = connect({ token: tokenN, guestKey: hex(), name: 'Alone' });
      await once(SN, 'welcome');
      let rp = once(SN, 'roomCreated');
      SN.emit('createRoom', { name: 'Alone', avatar: '🎨' });
      await rp;
      const refused = once(SN, 'error', 5000);
      SN.emit('startGame');
      check('an ordinary host still cannot start alone', /at least 2 players/i.test((await refused).message || ''));
      SN.disconnect();

      // A moderator can — Silk's badge is stored by the section above.
      const tokenM = (await rest('POST', '/auth/test-login', { username: 'Silk' })).data.token;
      await rest('GET', '/mod/users', undefined, tokenM);
      const SM = connect({ token: tokenM, guestKey: hex(), name: 'Modtest' });
      await once(SM, 'welcome');
      rp = once(SM, 'roomCreated');
      SM.emit('createRoom', { name: 'Modtest', avatar: '🛡️' });
      await rp;
      let up = once(SM, 'stateUpdate');
      SM.emit('setGameOptions', { options: { rounds: 2, roundTime: 60, hintCount: 0, wordChoices: 0 } });
      await up;

      const dsM = once(SM, 'drawingStart', 12000);
      SM.emit('startGame');
      const dM = await dsM;
      check('a moderator can start a game alone', !!dM.drawerId, JSON.stringify(dM.drawerId));

      // …and it keeps running instead of bouncing straight back to the lobby.
      await sleep(700);
      let st = once(SM, 'stateUpdate', 6000);
      SM.emit('requestState');
      const s1 = await st;
      check('the solo test game keeps running', s1.state === 'drawing' || s1.state === 'choosing', s1.state);

      // The round loop survives a hand-off to the next round on its own.
      const reM = once(SM, 'roundEnd', 8000);
      SM.emit('voteSkip');
      await reM;
      await sleep(7000);   // the round-end screen holds for ROUND_END_DELAY (6s)
      st = once(SM, 'stateUpdate', 6000);
      SM.emit('requestState');
      const s2 = await st;
      check('a solo round rolls on to the next one', s2.state === 'drawing' || s2.state === 'choosing', s2.state);
      SM.disconnect();
      await sleep(200);
    }

    console.log('— renaming a list keeps every word —');
    {
      const hexk = () => Date.now().toString(16).padStart(16, '0') + Math.floor(Math.random() * 1e6).toString(16).padStart(8, '0');
      const N = 4000;
      const bigWords = Array.from({ length: N }, (_, i) => 'rw' + i);

      const RH = connect({ guestKey: hexk(), name: 'Renamer' });
      await once(RH, 'welcome');
      let rp = once(RH, 'roomCreated');
      RH.emit('createRoom', { name: 'Renamer', avatar: '🎨' });
      await rp;

      let up = once(RH, 'stateUpdate', 12000);
      RH.emit('addCustomList', { name: 'BigList', text: bigWords.join('\n') });
      const st1 = await up;
      const before = st1.wordLists.available.find(l => l.name === 'BigList');
      check('a big list is stored whole', before && before.count === N, before && String(before.count));

      up = once(RH, 'stateUpdate', 12000);
      RH.emit('renameCustomList', { name: 'BigList', newName: 'RenamedBig' });
      const st2 = await up;
      const after = st2.wordLists.available.find(l => l.name === 'RenamedBig');
      check('renaming keeps every word', after && after.count === N, after && String(after.count));
      check('renaming does not leave a second list',
        !st2.wordLists.available.some(l => l.name === 'BigList'));

      const back = once(RH, 'customListWords', 8000);
      RH.emit('getCustomList', { name: 'RenamedBig' });
      check('the renamed list reads back in full', (await back).words.length === N);
      RH.disconnect();
      await sleep(200);
    }

    console.log('— the device copy of a list is never a partial one —');
    {
      // Exercise the real functions out of app.js: a cached list is what
      // gets re-added to the next room, so a truncated copy would quietly
      // replace a big list with a short one.
      const appSrc = fs.readFileSync(require('path').join(__dirname, '../public/js/app.js'), 'utf8');
      const grab = (name) => {
        const start = appSrc.indexOf('  function ' + name + '(');
        if (start < 0) throw new Error('missing ' + name);
        let i = appSrc.indexOf('{', start), depth = 0;
        for (; i < appSrc.length; i++) {
          if (appSrc[i] === '{') depth++;
          else if (appSrc[i] === '}') { depth--; if (!depth) break; }
        }
        return appSrc.slice(start, i + 1);
      };
      const consts = appSrc.match(/const MY_LISTS_KEY = [^\n]+\n[\s\S]{0,200}?const MY_LIST_WORDS_MAX = [^\n]+/)[0];
      let store = {};
      const FakeAPI = {
        lsGet: (k) => (k in store ? store[k] : null),
        lsSet: (k, v) => { store[k] = v; },
        lsTrySet: (k, v) => { if (v.length > 200 * 1024) return false; store[k] = v; return true; },
      };
      const mod = new Function('API', 'renderDeviceLists',
        consts + '\n' + grab('deviceLists') + '\n' + grab('rememberList') + '\n' + grab('renameDeviceList') +
        '\nreturn { deviceLists, rememberList, renameDeviceList };')(FakeAPI, () => {});

      const mkw = (n) => Array.from({ length: n }, (_, i) => 'dw' + i);
      mod.rememberList('BigList', mkw(5000));
      let cached = mod.deviceLists().find(l => l.name === 'BigList');
      check('a 5000-word list is cached whole', cached && cached.words.length === 5000, cached && String(cached.words.length));

      mod.renameDeviceList('BigList', 'MyWords');
      const all = mod.deviceLists();
      check('the renamed device copy drops the old name', !all.some(l => l.name === 'BigList'));
      cached = all.find(l => l.name === 'MyWords');
      check('the renamed device copy keeps every word', cached && cached.words.length === 5000);
      check('renaming leaves no duplicate device copy', all.length === 1, String(all.length));

      // Too big for storage: cache nothing rather than half of it.
      store = {};
      mod.rememberList('Huge', mkw(60000));
      const huge = mod.deviceLists().find(l => l.name === 'Huge');
      check('a list that will not fit is skipped, not truncated',
        !huge || huge.words.length === 60000, huge ? String(huge.words.length) : 'not cached');
    }

    console.log('— random word count spreads at every setting —');
    {
      // The complaint was "any setting but 5 only ever gives you two".
      // The roll must span 2..setting whatever the slider says.
      const g = fs.readFileSync(require('path').join(__dirname, '../lib/game.js'), 'utf8');
      const grabFn = (src, name) => {
        const start = src.indexOf('function ' + name + '(');
        let k = src.indexOf('{', start), depth = 0;
        for (; k < src.length; k++) {
          if (src[k] === '{') depth++;
          else if (src[k] === '}') { depth--; if (!depth) break; }
        }
        return src.slice(start, k + 1);
      };
      const rollSrc = grabFn(g, 'rollWordChoices');
      const roll = new Function('room', rollSrc + '; return rollWordChoices(room);');
      let allGood = true, detail = [];
      for (const set of [3, 4, 5, 8, 12, 25]) {
        const room = { options: { wordChoices: set, randomWordChoices: true } };
        const seen = new Set();
        for (let i = 0; i < 4000; i++) seen.add(roll(room));
        const lo = Math.min(...seen), hi = Math.max(...seen);
        if (lo !== 2 || hi !== set || seen.size !== set - 1) { allGood = false; detail.push(set + '->' + lo + '..' + hi); }
      }
      check('random word count spans 2..setting for every slider value', allGood, detail.join(' '));

      const fixed = { options: { wordChoices: 9, randomWordChoices: false } };
      check('with random off the setting is used exactly', roll(fixed) === 9, String(roll(fixed)));

      const timeSrc = grabFn(g, 'rollRoundTime');
      // rollRoundTime leans on a module constant, so bring it along.
      // rollRoundTime leans on a module constant, so bring it along.
      const ci = g.indexOf('const RANDOM_TIME_MIN');
      const minConst = ci < 0 ? 'const RANDOM_TIME_MIN = 30;' : g.slice(ci, g.indexOf(';', ci) + 1);
      const rollT = new Function('room', minConst + ' ' + timeSrc + '; return rollRoundTime(room);');
      const t = new Set();
      for (let i = 0; i < 4000; i++) t.add(rollT({ options: { roundTime: 120, randomRoundTime: true } }));
      const tl = Math.min(...t), th = Math.max(...t);
      check('random draw time stays inside its band', tl >= 30 && th <= 120 && t.size > 3, tl + '..' + th);
      check('an untimed round stays untimed when rolling',
        rollT({ options: { roundTime: 0, randomRoundTime: true } }) === 0);
    }

    console.log('— smart fill —');
    {
      const MiviFill = require('../public/js/fill.js');
      check('smartFill ships alongside floodFill', typeof MiviFill.smartFill === 'function' && typeof MiviFill.floodFill === 'function');

      // The backing store is 2x, and getImageData works in DEVICE pixels
      // regardless of the ctx transform — so a fill point must be scaled.
      // The artist's own click once skipped that while the replayed event
      // did not, so the drawer flooded the background while everyone else
      // saw the object filled.
      const SC = 2;
      const W = 400 * SC, H = 300 * SC;
      const mkCtx = () => {
        const data = new Uint8ClampedArray(W * H * 4).fill(255);
        return {
          canvas: { width: W, height: H },
          getImageData: () => ({ data, width: W, height: H }),
          putImageData: () => {},
          _d: data,
        };
      };
      const at = (c, x, y) => { const i = (y * W + x) * 4; return c._d[i] + ',' + c._d[i + 1] + ',' + c._d[i + 2]; };
      // A closed box at drawing coords (200,120)-(320,220).
      const box = (c) => {
        const x1 = 200 * SC, y1 = 120 * SC, x2 = 320 * SC, y2 = 220 * SC;
        const ink = (x, y) => { const i = (y * W + x) * 4; c._d[i] = c._d[i + 1] = c._d[i + 2] = 0; };
        for (let t = 0; t < 6; t++) {
          for (let x = x1; x <= x2; x++) { ink(x, y1 + t); ink(x, y2 - t); }
          for (let y = y1; y <= y2; y++) { ink(x1 + t, y); ink(x2 - t, y); }
        }
      };
      const click = { x: 260, y: 170 };   // drawing coords, inside the box

      const good = mkCtx(); box(good);
      MiviFill.smartFill(good, click.x * SC, click.y * SC, '#ff0000', { tolerance: 40, seal: 7 * SC });
      check('a fill scaled to device pixels lands inside the shape',
        at(good, click.x * SC, click.y * SC) === '255,0,0', at(good, click.x * SC, click.y * SC));
      check('...and leaves the background alone', at(good, 20, 20) === '255,255,255', at(good, 20, 20));

      // The bug, pinned: unscaled coordinates miss the shape entirely.
      const bad = mkCtx(); box(bad);
      MiviFill.smartFill(bad, click.x, click.y, '#ff0000', { tolerance: 40, seal: 7 * SC });
      check('unscaled coordinates would flood the background (the old bug)',
        at(bad, 20, 20) === '255,0,0' && at(bad, click.x * SC, click.y * SC) !== '255,0,0');

      // Both call sites in app.js must hand fillAt drawing coordinates, so
      // the artist and the replay can never disagree again.
      const appSrc = fs.readFileSync(require('path').join(__dirname, '../public/js/app.js'), 'utf8');
      const calls = appSrc.match(/fillAt\(ctx,[^)]*\)/g) || [];
      check('every fillAt call passes drawing coordinates', calls.length === 2 && calls.every(c => !/CANVAS_SCALE/.test(c)), JSON.stringify(calls));
      check('fillAt converts to device pixels itself', /function fillAt[\s\S]{0,320}x \* CANVAS_SCALE/.test(appSrc));
    }
  } catch (e) {
    fail++;
    failures.push('EXCEPTION: ' + e.message);
    console.error('\n💥 ' + e.stack);
  } finally {
    server.kill();
    setTimeout(() => {
      for (const d of [SMOKE_DATA, SMOKE_DATA + '-activity', SMOKE_DATA + '-off']) {
        try { require('fs').rmSync(d, { recursive: true, force: true }); } catch (e) {}
      }
    }, 300);
  }

  console.log(`\n══ ${pass} passed, ${fail} failed ══`);
  if (failures.length) { console.log('Failures:'); failures.forEach(f => console.log('  - ' + f)); }
  process.exit(fail > 0 ? 1 : 0);
}

main();
