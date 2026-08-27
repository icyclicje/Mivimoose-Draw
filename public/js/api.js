// ─────────────────────────────────────────────────────────────
// api.js — REST client + local identity (token / guest key).
// Exposes window.MiviAPI.
// ─────────────────────────────────────────────────────────────
(function () {
  'use strict';

  function lsGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function lsSet(key, val) { try { localStorage.setItem(key, val); } catch (e) {} }
  function lsDel(key) { try { localStorage.removeItem(key); } catch (e) {} }

  // Stable guest key so reconnects keep your seat even when signed out.
  // Cached in-memory too, so it stays stable for the page's lifetime even
  // when localStorage is unavailable (private mode, blocked site data).
  let guestKeyCache = null;
  function guestKey() {
    if (guestKeyCache) return guestKeyCache;
    let k = lsGet('mivi_guest_key');
    if (!k || !/^[a-f0-9]{16,64}$/.test(k)) {
      k = Array.from(crypto.getRandomValues(new Uint8Array(16)))
        .map(b => b.toString(16).padStart(2, '0')).join('');
      lsSet('mivi_guest_key', k);
    }
    guestKeyCache = k;
    return k;
  }

  function token() { return lsGet('mivi_token') || null; }
  function setToken(t) { if (t) lsSet('mivi_token', t); else lsDel('mivi_token'); }

  // Where to come back to after the Discord round-trip (an invite link's
  // ?join=CODE would otherwise be lost, since OAuth returns to baseUrl).
  const RETURN_KEY = 'mivi_return_search';
  function beginDiscordLogin() {
    try { sessionStorage.setItem(RETURN_KEY, location.search); } catch (e) {}
    location.href = '/api/auth/discord';
  }

  // Discord sign-in lands back on /#authtoken=... — grab it before anything
  // else boots so MiviAccount.init() sees the fresh session.
  (function pickupAuthFromHash() {
    try {
      if (location.hash.indexOf('#authtoken=') === 0) {
        setToken(location.hash.slice('#authtoken='.length));
        window.__miviJustSignedIn = true;
        let search = location.search;
        try {
          const back = sessionStorage.getItem(RETURN_KEY);
          sessionStorage.removeItem(RETURN_KEY);
          if (!search && back) search = back;
        } catch (e) {}
        history.replaceState(null, '', location.pathname + search);
      } else if (location.hash.indexOf('#autherr=') === 0) {
        window.__miviAuthError = decodeURIComponent(location.hash.slice('#autherr='.length));
        history.replaceState(null, '', location.pathname + location.search);
      }
    } catch (e) {}
  })();

  async function req(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    const t = token();
    if (t) headers['Authorization'] = 'Bearer ' + t;
    let res;
    try {
      res = await fetch('/api' + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new Error('Network error — is the server running?');
    }
    let data = null;
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) {
      const msg = (data && data.error) || ('Request failed (' + res.status + ')');
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  window.MiviAPI = {
    guestKey,
    token,
    setToken,
    lsGet, lsSet, lsDel,

    authConfig: () => req('GET', '/auth/config'),
    beginDiscordLogin,
    logout: () => req('POST', '/auth/logout').catch(() => {}),
    me: () => req('GET', '/auth/me'),
    updateMe: (patch) => req('PUT', '/auth/me', patch),

    lists: () => req('GET', '/lists'),
    getList: (id) => req('GET', '/lists/' + id),
    createList: (name, words) => req('POST', '/lists', { name, words }),
    updateList: (id, patch) => req('PUT', '/lists/' + id, patch),
    deleteList: (id) => req('DELETE', '/lists/' + id),
    exportListUrl: (id) => '/api/lists/' + id + '/export',

    drawings: () => req('GET', '/drawings'),
    saveDrawing: (payload) => req('POST', '/drawings', payload),
    deleteDrawing: (id) => req('DELETE', '/drawings/' + id),

    publicRooms: () => req('GET', '/rooms'),

    library: () => req('GET', '/library'),
    libraryList: (id) => req('GET', '/library/' + id),
    libraryUpload: (payload) => req('POST', '/library', payload),
    libraryDelete: (id) => req('DELETE', '/library/' + id),
    libraryRename: (id, name) => req('PUT', '/library/' + id, { name }),
    libraryDownloadUrl: (id) => '/api/library/' + id + '/download',

    friends: () => req('GET', '/friends'),
    friendRequest: (code) => req('POST', '/friends/request', { code }),
    friendAccept: (userId) => req('POST', '/friends/accept', { userId }),
    friendDecline: (userId) => req('POST', '/friends/decline', { userId }),
    friendRemove: (userId) => req('DELETE', '/friends/' + userId),
  };
})();
