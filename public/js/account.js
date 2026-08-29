// ─────────────────────────────────────────────────────────────
// account.js — Discord sign-in, account panel (profile, word
// lists, gallery). Exposes window.MiviAccount.
// ─────────────────────────────────────────────────────────────
(function () {
  'use strict';
  const API = window.MiviAPI;

  let user = null;           // public user object or null
  let discordAvailable = false;
  let editingListId = null;
  let changeHandlers = [];

  const $ = (id) => document.getElementById(id);

  function fireChange() { changeHandlers.forEach(fn => { try { fn(user); } catch (e) {} }); }

  // ── Remembering who you are between visits ──
  // The token already lives in localStorage, but the account itself used to be
  // re-fetched on every load — so every page start flashed "Sign in" for a
  // round-trip or two. The last known account is cached alongside the token
  // and painted immediately, then quietly revalidated against the server.
  const USER_CACHE_KEY = 'mivi_user';

  function cachedUser() {
    if (!API.token()) return null;             // no token, no claim to an account
    try {
      const raw = API.lsGet(USER_CACHE_KEY);
      if (!raw) return null;
      const u = JSON.parse(raw);
      // Only trust something that still looks like an account.
      return (u && typeof u.id === 'string' && typeof u.username === 'string' && u.avatar) ? u : null;
    } catch (e) { return null; }
  }

  // Every assignment to `user` goes through here so the cache cannot drift.
  function setUser(u) {
    user = u || null;
    try {
      if (user) API.lsSet(USER_CACHE_KEY, JSON.stringify(user));
      else API.lsDel(USER_CACHE_KEY);
    } catch (e) { /* a full or blocked localStorage is not worth a crash */ }
  }

  // ── Small DOM helper (always textContent — never innerHTML with user data) ──
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function toast(msg) { if (window.MiviApp && window.MiviApp.toast) window.MiviApp.toast(msg); }

  // Fill a circle with the account's Discord picture, or its emoji avatar.
  function paintAvatar(node, u) {
    node.textContent = '';
    node.classList.remove('has-photo');
    node.style.background = (u.avatar.color || '#6C5CE7') + '33';
    if (u.avatarUrl) {
      node.classList.add('has-photo');
      const img = document.createElement('img');
      img.src = u.avatarUrl;
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      img.onerror = () => {
        node.classList.remove('has-photo');
        node.textContent = u.avatar.emoji;
        node.style.background = (u.avatar.color || '#6C5CE7') + '33';
      };
      node.appendChild(img);
    } else {
      node.textContent = u.avatar.emoji;
    }
  }

  // ── Boot: restore session ──
  async function init() {
    // Paint the cached account before anything is awaited, so a returning
    // player is signed in the moment the page appears.
    const cached = cachedUser();
    if (cached) {
      user = cached;
      renderChip();
      fireChange();
    }

    try { discordAvailable = !!(await API.authConfig()).discord; } catch (e) { discordAvailable = false; }

    if (API.token()) {
      try {
        const data = await API.me();
        setUser(data.user);
      } catch (e) {
        if (e.status === 401) {
          // The session really is gone — forget it properly.
          API.setToken(null);
          setUser(null);
        }
        // Anything else (offline, a server hiccup) is not evidence that the
        // account is invalid, so the cached one stands.
      }
    } else {
      setUser(null);
    }
    renderChip();
    fireChange();
  }

  function renderChip() {
    const chipName = $('account-chip-name');
    const chipAvatar = $('account-chip-avatar');
    if (user) {
      chipName.textContent = user.username;
      paintAvatar(chipAvatar, user);
    } else {
      chipAvatar.classList.remove('has-photo');
      chipName.textContent = 'Sign in';
      chipAvatar.textContent = '👤';
      chipAvatar.style.background = '';
    }
  }

  // ── Auth modal (Discord only) ──
  function openAuth() {
    $('auth-discord-form').style.display = discordAvailable ? 'flex' : 'none';
    $('auth-unconfigured').style.display = discordAvailable ? 'none' : 'flex';
    const inActivity = !!(window.MiviApp && window.MiviApp.isActivity && window.MiviApp.isActivity());
    $('auth-sub').textContent = inActivity
      ? 'Use your Discord account — it takes one tap in here.'
      : 'Your lists, drawings and stats follow your Discord account.';
    $('modal-auth').style.display = 'flex';
  }

  function startDiscordLogin() {
    if (!discordAvailable) return;
    // Inside a Discord Activity the iframe may not navigate itself to
    // discord.com — that is a cross-origin navigation and the frame just goes
    // blank. Activities have to use the SDK's own authorize() instead.
    //
    // MiviDiscord.isActivity() is the detector to trust here: it is
    // synchronous and cached from the very first script, whereas the app's
    // own activityMode only flips once its async boot gets that far. Asking
    // the wrong one leaves a window where a click whitescreens the frame.
    const D = window.MiviDiscord;
    const inActivity = !!(D && D.isActivity && D.isActivity())
      || !!(window.MiviApp && window.MiviApp.isActivity && window.MiviApp.isActivity());

    if (inActivity) {
      const signIn = window.MiviApp && window.MiviApp.activitySignIn;
      if (typeof signIn === 'function') {
        Promise.resolve(signIn()).catch(() => {
          toast('Discord would not sign you in — you can keep playing as a guest.');
        });
      } else {
        // Boot has not got that far yet. Waiting beats a blank frame.
        toast('Still connecting to Discord — try that again in a second.');
      }
      return;
    }
    // Full-page redirect; we come back on /#authtoken=... (see api.js).
    if (API.beginDiscordLogin) API.beginDiscordLogin();
    else window.location.href = '/api/auth/discord';
  }

  async function signOut() {
    await API.logout();
    API.setToken(null);
    setUser(null);
    $('modal-account').style.display = 'none';
    renderChip();
    toast('Signed out. See you around!');
    fireChange();
  }

  // ── Account modal ──
  function openAccount(tab) {
    if (!user) { openAuth(); return; }
    $('acct-name').textContent = user.username;
    paintAvatar($('acct-avatar'), user);
    $('acct-since').textContent = 'Around since ' + new Date(user.created).toLocaleDateString();
    // Older records predate the setting; treat a missing value as "on".
    if (!user.settings) user.settings = {};
    if (user.settings.autosaveDrawings === undefined) user.settings.autosaveDrawings = true;
    $('acct-autosave').checked = !!user.settings.autosaveDrawings;
    $('acct-username').value = user.username;
    $('name-error').textContent = '';
    renderStats();
    refreshModPanel();
    refreshLists();
    refreshGallery();
    refreshFriends();
    showTab(typeof tab === 'string' ? tab : 'profile');
    $('modal-account').style.display = 'flex';
  }

  function renderStats() {
    const grid = $('stats-grid');
    grid.textContent = '';
    const s = user.stats || {};
    const tiles = [
      [s.games || 0, 'Games'],
      [s.wins || 0, 'Wins'],
      [(s.points || 0).toLocaleString(), 'Points'],
      [s.guesses || 0, 'Words guessed'],
      [s.wordsDrawn || 0, 'Words drawn'],
      [s.likes || 0, 'Likes received'],
    ];
    for (const [val, label] of tiles) {
      const tile = el('div', 'stat-tile');
      tile.appendChild(el('b', null, String(val)));
      tile.appendChild(el('span', null, label));
      grid.appendChild(tile);
    }
  }

  function showTab(name) {
    document.querySelectorAll('#modal-account .tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    document.querySelectorAll('#modal-account .tab-pane').forEach(p => p.classList.toggle('active', p.id === 'tab-' + name));
  }

  // ── Word lists ──
  let cachedLists = [];
  let friendsData = null;
  let modInfo = null;

  async function refreshLists() {
    try {
      const data = await API.lists();
      cachedLists = data.lists;
    } catch (e) { cachedLists = []; }
    renderLists();
    fireChange(); // lobby "my lists" dropdown may need updating
  }

  function renderLists() {
    const rows = $('lists-rows');
    rows.textContent = '';
    if (cachedLists.length === 0) {
      rows.appendChild(el('p', 'gallery-empty', 'No lists yet. Make one, or import a .txt you already have.'));
      return;
    }
    for (const list of cachedLists) {
      const row = el('div', 'list-row');
      row.appendChild(el('span', 'ln', list.name));
      row.appendChild(el('span', 'lc', list.count + ' words'));

      const editBtn = el('button', null, '✏️');
      editBtn.title = 'Edit';
      editBtn.onclick = () => openEditor(list.id);
      const exportBtn = el('button', null, '⬇️');
      exportBtn.title = 'Export as .txt';
      exportBtn.onclick = () => exportList(list.id, list.name);
      const delBtn = el('button', null, '🗑️');
      delBtn.title = 'Delete';
      delBtn.onclick = async () => {
        if (!await MiviDialog.confirm(`Delete "${list.name}"? There's no undo.`, { confirmLabel: 'Delete', danger: true })) return;
        try { await API.deleteList(list.id); toast('List deleted.'); refreshLists(); }
        catch (e) { toast('❌ ' + e.message); }
      };
      row.appendChild(editBtn);
      row.appendChild(exportBtn);
      row.appendChild(delBtn);
      rows.appendChild(row);
    }
  }

  async function exportList(id, name) {
    try {
      const res = await fetch(API.exportListUrl(id), {
        headers: { Authorization: 'Bearer ' + API.token() },
      });
      if (!res.ok) throw new Error('Export failed.');
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = (name.replace(/[^a-zA-Z0-9 _-]/g, '') || 'wordlist') + '.txt';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (e) { toast('❌ ' + e.message); }
  }

  async function openEditor(listId) {
    // Only bind the editor to a list once its content actually loaded —
    // otherwise Save could overwrite the wrong list with stale text.
    editingListId = null;
    if (listId) {
      let data;
      try {
        data = await API.getList(listId);
      } catch (e) {
        toast('❌ ' + e.message);
        $('list-editor').style.display = 'none';
        return;
      }
      editingListId = listId;
      $('le-name').value = data.list.name;
      $('le-words').value = data.list.words.join('\n');
    } else {
      $('le-name').value = '';
      $('le-words').value = '';
    }
    $('list-editor').style.display = 'flex';
    updateEditorCount();
    $('le-name').focus();
  }

  function parseEditorWords() {
    return $('le-words').value.split(/[\n,]+/).map(w => w.trim()).filter(Boolean);
  }

  function updateEditorCount() {
    $('le-count').textContent = parseEditorWords().length + ' words';
  }

  async function saveEditor() {
    const name = $('le-name').value.trim();
    const wordsArr = parseEditorWords();
    if (!name) { toast('Give the list a name first.'); return; }
    if (wordsArr.length === 0) { toast('It needs at least one word.'); return; }
    try {
      if (editingListId) await API.updateList(editingListId, { name, words: wordsArr });
      else await API.createList(name, wordsArr);
      $('list-editor').style.display = 'none';
      toast(`💾 Saved "${name}" — ${wordsArr.length} words`);
      refreshLists();
    } catch (e) { toast('❌ ' + e.message); }
  }

  function importFiles(input) {
    const files = Array.from(input.files || []);
    input.value = '';
    for (const file of files) {
      const reader = new FileReader();
      reader.onload = async (ev) => {
        const text = String(ev.target.result || '');
        const wordsArr = text.split(/[\n,]+/).map(w => w.trim()).filter(Boolean);
        const name = file.name.replace(/\.txt$/i, '').slice(0, 40).trim() || 'Imported list';
        if (wordsArr.length === 0) { toast(`"${name}" is empty — skipped it.`); return; }
        try {
          await API.createList(name, wordsArr);
          toast(`📂 Imported "${name}" — ${wordsArr.length} words`);
          refreshLists();
        } catch (e) { toast('❌ ' + e.message); }
      };
      reader.readAsText(file);
    }
  }

  // ── Your display name ──
  async function saveName() {
    const name = $('acct-username').value.trim();
    const err = $('name-error');
    err.textContent = '';
    if (!name || name === user.username) return;
    const btn = $('btn-save-name');
    btn.disabled = true;
    try {
      const data = await API.updateMe({ username: name });
      setUser(data.user);
      renderChip();
      toast('✏️ You are now ' + user.username);
      // A rename can hand over (or take away) the bootstrap mod badge.
      refreshModPanel();
      fireChange();
    } catch (e) {
      err.textContent = e.message;
      $('acct-username').value = user.username;
    } finally {
      btn.disabled = false;
    }
  }

  // ── Moderators ──
  async function refreshModPanel() {
    try { modInfo = await API.modMe(); } catch (e) { modInfo = null; }
    const isMod = !!(modInfo && modInfo.isMod);
    $('tab-btn-mods').style.display = isMod ? 'block' : 'none';
    if (!isMod) return;
    $('mod-intro').textContent = modInfo.bootstrap
      ? `Nobody holds the badge yet, so "${modInfo.bootstrapName}" has it by default. Give yourself the badge properly below and that fallback switches off.`
      : 'Take down shared lists, stop an account from sharing, and hand the badge to whoever else you trust.';
    loadModUsers('');
  }

  async function loadModUsers(q) {
    const rows = $('mod-rows');
    rows.textContent = '';
    let data;
    try { data = await API.modUsers(q); } catch (e) { toast('❌ ' + e.message); return; }
    $('mod-empty').style.display = data.users.length ? 'none' : 'block';
    for (const u of data.users) {
      const row = el('div', 'list-row mod-row');
      row.appendChild(el('span', 'ln', `${u.avatar?.emoji || '🙂'} ${u.username}`));
      if (u.mod) row.appendChild(el('span', 'badge mod', 'MOD'));
      else if (u.bootstrap) row.appendChild(el('span', 'badge boot', 'DEFAULT MOD'));
      if (u.banned) row.appendChild(el('span', 'badge banned', 'BANNED'));
      row.appendChild(el('span', 'lc', u.sharedLists + ' shared'));

      const act = async (fn, okMsg) => {
        try { await fn(); toast(okMsg); loadModUsers($('mod-search').value.trim()); refreshModPanel(); }
        catch (e) { toast('❌ ' + e.message); }
      };
      if (!u.mod) {
        const g = el('button', null, '🛡️');
        g.title = 'Make ' + u.username + ' a moderator';
        g.onclick = () => act(() => API.modGrant(u.id), '🛡️ ' + u.username + ' is a moderator');
        row.appendChild(g);
      } else {
        const rv = el('button', null, '↩️');
        rv.title = 'Take the badge back';
        rv.onclick = async () => {
          if (!await MiviDialog.confirm('Remove ' + u.username + "'s moderator badge?", { confirmLabel: 'Remove badge', danger: true })) return;
          act(() => API.modRevoke(u.id), 'Badge removed');
        };
        row.appendChild(rv);
      }
      if (u.banned) {
        const ub = el('button', null, '✅');
        ub.title = 'Let them share again';
        ub.onclick = () => act(() => API.modUnban(u.id), u.username + ' can share again');
        row.appendChild(ub);
      } else if (!u.mod) {
        const b = el('button', null, '🚫');
        b.title = 'Stop ' + u.username + ' sharing lists';
        b.onclick = async () => {
          const reason = await MiviDialog.prompt('Why is ' + u.username + ' being banned from sharing?', { title: 'Ban from sharing', placeholder: 'Reason (optional)', confirmLabel: 'Ban' });
          if (reason === null) return;
          act(() => API.modBan(u.id, reason), u.username + ' can no longer share lists');
        };
        row.appendChild(b);
      }
      rows.appendChild(row);
    }
    const note = el('p', 'mod-note', 'Banning also pulls the lists that account already shared. Moderators cannot be banned — take the badge off first.');
    rows.appendChild(note);
  }

  // ── Friends ──
  async function refreshFriends() {
    if (!user) { friendsData = null; return; }
    try { friendsData = await API.friends(); } catch (e) { friendsData = null; }
    renderFriends();
    fireChange(); // player-list ＋ buttons depend on who's already a friend
  }

  function renderFriends() {
    const codeEl = $('friend-code');
    const reqBox = $('friend-requests');
    const rows = $('friend-rows');
    if (!codeEl || !friendsData) return;
    codeEl.textContent = friendsData.code;
    reqBox.textContent = '';
    for (const r of friendsData.requestsIn) {
      const row = el('div', 'friend-req');
      row.appendChild(el('span', null, `${r.avatar?.emoji || '🙂'} ${r.username} wants to be friends`));
      const ok = el('button', 'btn btn-small', 'Accept');
      ok.onclick = async () => { try { await API.friendAccept(r.id); toast(`🤝 You and ${r.username} are friends now`); refreshFriends(); } catch (e) { toast('❌ ' + e.message); } };
      const no = el('button', 'mini-btn', 'Ignore');
      no.onclick = async () => { try { await API.friendDecline(r.id); refreshFriends(); } catch (e) {} };
      row.appendChild(ok);
      row.appendChild(no);
      reqBox.appendChild(row);
    }
    for (const r of friendsData.requestsOut) {
      const row = el('div', 'friend-req');
      row.appendChild(el('span', null, `Waiting on ${r.username} to accept…`));
      reqBox.appendChild(row);
    }
    rows.textContent = '';
    $('friends-empty').style.display = friendsData.friends.length ? 'none' : 'block';
    const inRoom = !!(window.MiviApp && window.MiviApp.inRoom && window.MiviApp.inRoom());
    for (const f of friendsData.friends) {
      const row = el('div', 'list-row friend-row');
      const dot = el('span', 'dot' + (f.online ? ' on' : ''));
      dot.title = f.online ? 'Online' : 'Offline';
      row.appendChild(dot);
      row.appendChild(el('span', 'ln', `${f.avatar?.emoji || '🙂'} ${f.username}`));
      row.appendChild(el('span', 'lc', f.online ? 'online' : 'offline'));
      if (inRoom && f.online) {
        const inv = el('button', 'btn btn-small', '🎮 Invite');
        inv.onclick = () => window.MiviApp.inviteFriend(f.id);
        row.appendChild(inv);
      }
      const rm = el('button', null, '🗑️');
      rm.title = 'Remove friend';
      rm.onclick = async () => {
        if (!await MiviDialog.confirm(`Remove ${f.username} from your friends?`, { confirmLabel: 'Remove', danger: true })) return;
        try { await API.friendRemove(f.id); refreshFriends(); } catch (e) { toast('❌ ' + e.message); }
      };
      row.appendChild(rm);
      rows.appendChild(row);
    }
  }

  async function addFriendByCode() {
    const entry = $('friend-add-code').value.trim();
    if (!entry) { toast('Type their username first.'); return; }
    try {
      // Six hex characters is the old friend code; anything else is a name.
      const r = /^[a-fA-F0-9]{6}$/.test(entry)
        ? await API.friendRequest({ code: entry })
        : await API.friendRequest({ username: entry });
      toast((r.accepted ? '🤝 ' : '📨 ') + r.message);
      $('friend-add-code').value = '';
      refreshFriends();
    } catch (e) { toast('❌ ' + e.message); }
  }

  // ── Gallery ──
  async function refreshGallery() {
    let drawings = [];
    try { drawings = (await API.drawings()).drawings; } catch (e) {}
    const grid = $('gallery-grid');
    grid.textContent = '';
    $('gallery-empty').style.display = drawings.length ? 'none' : 'block';
    for (const d of drawings) {
      const item = el('div', 'g-item');
      const img = document.createElement('img');
      img.src = API.assetUrl(d.url);
      img.alt = d.word;
      img.loading = 'lazy';
      item.appendChild(img);
      const info = el('div', 'g-info');
      info.appendChild(el('div', 'g-word', d.word || '(untitled)'));
      const meta = el('div', 'g-meta');
      meta.appendChild(el('span', null, new Date(d.created).toLocaleDateString()));
      meta.appendChild(el('span', null, `❤️${d.likes || 0} · ${d.guessedCount}/${d.playerCount}`));
      info.appendChild(meta);
      item.appendChild(info);
      const actions = el('div', 'g-actions');
      const dl = el('button', null, '⬇️');
      dl.title = 'Download';
      dl.onclick = () => {
        const a = document.createElement('a');
        a.href = API.assetUrl(d.url);
        a.download = (d.word || 'drawing').replace(/[^a-zA-Z0-9 ]/g, '-') + '.png';
        a.click();
      };
      const del = el('button', null, '🗑️');
      del.title = 'Delete';
      del.onclick = async () => {
        if (!await MiviDialog.confirm('Delete this drawing?', { confirmLabel: 'Delete', danger: true })) return;
        try { await API.deleteDrawing(d.id); refreshGallery(); } catch (e) { toast('❌ ' + e.message); }
      };
      actions.appendChild(dl);
      actions.appendChild(del);
      item.appendChild(actions);
      grid.appendChild(item);
    }
  }

  // ── Wire up DOM ──
  document.addEventListener('DOMContentLoaded', () => {
    $('account-chip').addEventListener('click', () => user ? openAccount() : openAuth());
    $('btn-auth-discord').addEventListener('click', startDiscordLogin);
    $('btn-signout').addEventListener('click', signOut);

    document.querySelectorAll('#modal-account .tab').forEach(t => t.addEventListener('click', () => showTab(t.dataset.tab)));
    document.querySelectorAll('.modal-x').forEach(x => x.addEventListener('click', () => { $(x.dataset.close).style.display = 'none'; }));
    document.querySelectorAll('.modal-backdrop').forEach(m => m.addEventListener('mousedown', (e) => {
      if (e.target === m && m.id.startsWith('modal-')) m.style.display = 'none';
    }));

    $('acct-autosave').addEventListener('change', async (e) => {
      if (!user) return;
      try {
        const data = await API.updateMe({ settings: { autosaveDrawings: e.target.checked } });
        setUser(data.user);
      } catch (err) { toast('❌ ' + err.message); }
    });

    $('btn-new-list').addEventListener('click', () => openEditor(null));
    $('btn-le-cancel').addEventListener('click', () => { $('list-editor').style.display = 'none'; });
    $('btn-le-save').addEventListener('click', saveEditor);
    $('le-words').addEventListener('input', updateEditorCount);
    $('btn-import-acct-list').addEventListener('click', () => $('acct-import-file').click());
    $('acct-import-file').addEventListener('change', (e) => importFiles(e.target));

    $('btn-save-name').addEventListener('click', saveName);
    $('acct-username').addEventListener('keydown', e => { if (e.key === 'Enter') saveName(); });
    $('btn-mod-search').addEventListener('click', () => loadModUsers($('mod-search').value.trim()));
    $('mod-search').addEventListener('keydown', e => { if (e.key === 'Enter') loadModUsers($('mod-search').value.trim()); });

    $('btn-friend-add').addEventListener('click', addFriendByCode);
    $('friend-add-code').addEventListener('keydown', e => { if (e.key === 'Enter') addFriendByCode(); });
    $('friend-code').addEventListener('click', () => {
      if (!friendsData) return;
      navigator.clipboard.writeText(friendsData.code).then(() => toast('📋 Friend code copied'));
    });
  });

  window.MiviAccount = {
    init,
    user: () => user,
    isLoggedIn: () => !!user,
    discordAvailable: () => discordAvailable,
    openAuth,
    openAccount,
    startDiscordLogin,
    myLists: () => cachedLists,
    refreshLists,
    refreshFriends,
    friendIds: () => new Set(friendsData ? friendsData.friends.map(f => f.id) : []),
    isMod: () => !!(modInfo && modInfo.isMod),
    refreshModPanel,
    onChange: (fn) => changeHandlers.push(fn),
    updateAvatar: async (avatar) => {
      if (!user) return;
      try {
        const data = await API.updateMe({ avatar });
        setUser(data.user);
        renderChip();
      } catch (e) {}
    },
  };
})();
