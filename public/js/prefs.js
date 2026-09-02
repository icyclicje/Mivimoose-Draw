// ─────────────────────────────────────────────────────────────
// prefs.js — the settings that follow you, not the browser.
//
// Theme, UI scale, sound, the name and avatar you play under and the
// lobby setup you last used all used to live only in localStorage, so
// signing in on your phone gave you a stranger's defaults. They are now
// kept on the account as well.
//
// The browser copy has not gone anywhere: it is still written first and
// read first, so the page paints instantly, guests keep everything they
// had, and a server that is down or slow changes nothing. The account
// copy is the thing that travels.
//
// Conflicts are settled by a timestamp — whichever side was written
// most recently wins the whole blob. Two devices editing settings
// simultaneously is not a case worth a merge algorithm; the last one to
// touch a setting is the one who meant it.
//
// Exposes window.MiviPrefs.
// ─────────────────────────────────────────────────────────────
(function () {
  'use strict';

  const API = window.MiviAPI;

  // Every synced setting, and the localStorage key it has always used.
  // Keeping the old keys means the rest of the app can go on reading
  // localStorage directly and still see the right value.
  const FIELDS = {
    theme:       { key: 'mivi_theme', type: 'string' },
    scale:       { key: 'mivi_scale', type: 'number' },
    musicOn:     { key: 'mivi_audio_music_on', type: 'boolean' },
    sfxOn:       { key: 'mivi_audio_sfx_on', type: 'boolean' },
    musicVol:    { key: 'mivi_audio_music_vol', type: 'number' },
    sfxVol:      { key: 'mivi_audio_sfx_vol', type: 'number' },
    name:        { key: 'mivi_name', type: 'string' },
    avatar:      { key: 'mivi_avatar', type: 'json' },
    gameOptions: { key: 'mivi_device_options', type: 'json' },
  };

  const STAMP_KEY = 'mivi_prefs_updated';

  let signedIn = false;
  let pushTimer = null;
  let pending = false;
  const adoptHandlers = [];

  function readOne(name) {
    const spec = FIELDS[name];
    if (!spec) return undefined;
    const raw = API.lsGet(spec.key);
    if (raw === null || raw === undefined) return undefined;
    if (spec.type === 'number') {
      const n = Number(raw);
      return Number.isFinite(n) ? n : undefined;
    }
    if (spec.type === 'boolean') return raw === 'true' || raw === '1';
    if (spec.type === 'json') {
      try {
        const v = JSON.parse(raw);
        return (v && typeof v === 'object') ? v : undefined;
      } catch (e) { return undefined; }
    }
    return raw;
  }

  function writeOne(name, value) {
    const spec = FIELDS[name];
    if (!spec || value === undefined || value === null) return;
    if (spec.type === 'json') API.lsSet(spec.key, JSON.stringify(value));
    else API.lsSet(spec.key, String(value));
  }

  /** Everything this browser currently holds. */
  function snapshot() {
    const out = {};
    for (const name of Object.keys(FIELDS)) {
      const v = readOne(name);
      if (v !== undefined) out[name] = v;
    }
    return out;
  }

  function localStamp() {
    const n = Number(API.lsGet(STAMP_KEY));
    return Number.isFinite(n) ? n : 0;
  }

  function touch() {
    API.lsSet(STAMP_KEY, String(Date.now()));
  }

  // ── Writing ──
  // Local first, always. The account copy is caught up in the background,
  // batched, so dragging a volume slider is one request rather than fifty.
  function set(name, value) {
    if (!(name in FIELDS)) return;
    writeOne(name, value);
    touch();
    schedulePush();
  }

  function setMany(obj) {
    let any = false;
    for (const [name, value] of Object.entries(obj || {})) {
      if (!(name in FIELDS)) continue;
      writeOne(name, value);
      any = true;
    }
    if (!any) return;
    touch();
    schedulePush();
  }

  function get(name, fallback) {
    const v = readOne(name);
    return v === undefined ? fallback : v;
  }

  function schedulePush() {
    pending = true;
    if (!signedIn || pushTimer) return;
    pushTimer = setTimeout(() => { pushTimer = null; push(); }, 800);
  }

  async function push() {
    if (!signedIn || !pending) return;
    pending = false;
    const stamp = localStamp() || Date.now();
    try {
      const res = await API.putPrefs(snapshot(), stamp);
      // Another device saved something newer while this one was typing.
      // Their copy is the current one; take it.
      if (res && res.stale && res.prefs) adopt(res.prefs, res.updated);
    } catch (e) {
      // Offline, or the server is having a moment. The browser copy is
      // already correct, so nothing is lost — try again on the next change.
      pending = true;
    }
  }

  /** Force the account copy up to date now (used before the page unloads). */
  function flush() {
    if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
    return push();
  }

  // ── Reading ──
  // Take the account's copy, write it into the browser, and tell the app to
  // repaint. Called when the account's copy is the newer of the two.
  function adopt(prefs, updated) {
    if (!prefs || typeof prefs !== 'object') return;
    const changed = [];
    for (const [name, value] of Object.entries(prefs)) {
      if (!(name in FIELDS)) continue;
      const before = JSON.stringify(readOne(name));
      writeOne(name, value);
      if (JSON.stringify(readOne(name)) !== before) changed.push(name);
    }
    API.lsSet(STAMP_KEY, String(Number(updated) || Date.now()));
    if (changed.length) {
      for (const fn of adoptHandlers) {
        try { fn(changed); } catch (e) { /* one bad listener must not stop the rest */ }
      }
    }
  }

  /**
   * Called by account.js whenever the signed-in account changes (including
   * to null on sign-out). `user` is the public account object from /auth/me,
   * which carries `prefs` and `prefsUpdated`.
   */
  function attachAccount(user) {
    const wasSignedIn = signedIn;
    signedIn = !!user;

    if (!signedIn) {
      // Signed out. Everything stays exactly as it is in this browser —
      // that is the whole point of keeping the local copy.
      if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
      return;
    }

    const accountAt = Number(user.prefsUpdated) || 0;
    const localAt = localStamp();
    const accountPrefs = user.prefs || {};
    const hasAccountPrefs = Object.keys(accountPrefs).length > 0;

    if (hasAccountPrefs && accountAt > localAt) {
      // The account knows something this browser does not — a setting changed
      // on another device, or this is a fresh browser entirely.
      adopt(accountPrefs, accountAt);
    } else if (!hasAccountPrefs || localAt > accountAt) {
      // This browser is ahead (or the account has never saved any settings).
      // Signing in should carry what you have up with you, not wipe it.
      pending = true;
      if (!wasSignedIn) touch();
      push();
    }
  }

  window.MiviPrefs = {
    get, set, setMany, snapshot, flush, attachAccount,
    onAdopt: (fn) => adoptHandlers.push(fn),
    isSyncing: () => signedIn,
    FIELDS,
  };

  // A tab closing mid-change should still get its last setting up.
  window.addEventListener('pagehide', () => { try { flush(); } catch (e) {} });
})();
