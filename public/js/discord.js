/*!
 * Mivimoose Draw - discord.js
 * A dependency-free shim for the Discord Embedded App SDK ("Activities").
 * Plain ES2019 browser script (no modules, no npm, no CDN, CSP script-src 'self').
 *
 * Exposes: window.MiviDiscord
 *
 * ─── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 * The official @discord/embedded-app-sdk is an npm/ESM package that needs a
 * bundler. This project is deliberately buildless, so instead of shipping the
 * SDK we speak the same window.postMessage RPC protocol it speaks. Everything
 * below was read out of the SDK's own source rather than guessed - see the
 * "VERIFIED AGAINST" list at the bottom of this block.
 *
 * ─── THE PROTOCOL ────────────────────────────────────────────────────────────
 * 1. Discord loads your app in an <iframe> served from
 *      https://<application_id>.discordsays.com/...
 *    and appends query params to the iframe URL. The names (exact) are:
 *      frame_id, instance_id, platform, guild_id, channel_id, location_id,
 *      custom_id, referrer_id, mobile_app_version
 *    frame_id / instance_id / platform are the ones the SDK treats as required;
 *    guild_id is null in DM/GDM contexts. platform is 'desktop' | 'mobile'.
 *
 * 2. The RPC "server" is the Discord client window, NOT the iframe. The SDK
 *    targets `window.parent.opener || window.parent` (the opener case covers
 *    the popped-out activity window) and uses `document.referrer` as the
 *    postMessage targetOrigin, falling back to '*'.
 *
 * 3. Every message in BOTH directions is a 2-element array: [opcode, payload].
 *      Opcodes: HANDSHAKE = 0, FRAME = 1, CLOSE = 2, HELLO = 3
 *    HELLO is a legacy frame the client still sends to old apps; ignore it.
 *
 * 4. Handshake - the iframe posts, unprompted, on load:
 *      [0, { v: 1, encoding: 'json', client_id: '<oauth2 client id>',
 *            frame_id: '<frame_id from the URL>', sdk_version?: '2.5.0' }]
 *    sdk_version is optional; the real SDK only includes it on desktop, or on
 *    mobile when mobile_app_version's major is >= 250 (older mobile clients
 *    choke on the extra key). Set window.MIVI_DISCORD_SDK_VERSION = null to
 *    suppress it entirely.
 *
 * 5. The client replies with a FRAME carrying the READY dispatch:
 *      [1, { cmd: 'DISPATCH', evt: 'READY', nonce: null, data: {...} }]
 *    That is the signal the connection is live (the SDK's `ready()` promise).
 *
 * 6. Commands - iframe -> client:
 *      [1, { cmd: '<COMMAND>', nonce: '<uuid>', args: {...} }]
 *    Replies come back keyed by the same nonce:
 *      success: [1, { cmd: '<COMMAND>', evt: null,     nonce, data: <result> }]
 *      failure: [1, { cmd: '<COMMAND>', evt: 'ERROR',  nonce, data: { code, message } }]
 *    Events (after SUBSCRIBE) arrive as:
 *      [1, { cmd: 'DISPATCH', evt: '<EVENT>', nonce: null, data: {...} }]
 *    SUBSCRIBE/UNSUBSCRIBE are ordinary commands that additionally carry an
 *    `evt` key naming the event:
 *      [1, { cmd: 'SUBSCRIBE', evt: 'ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE',
 *            nonce, args: undefined }]
 *
 * 7. CLOSE - either side may send [2, { code, message }]. Receiving one means
 *    the connection is gone; we drop pending commands and stop.
 *
 * ─── COMMANDS USED HERE (exact names + arg shapes) ───────────────────────────
 *   AUTHORIZE
 *     args { client_id, scope: string[], response_type: 'code', state: '', prompt: 'none' }
 *     data { code }
 *   AUTHENTICATE
 *     args { access_token }
 *     data { access_token, user { id, username, discriminator, avatar,
 *            global_name, public_flags }, scopes, expires, application }
 *   SET_ACTIVITY                       (needs the rpc.activities.write scope)
 *     args { activity: { type?, details?, state?, party?: { id?, size?: [cur, max] },
 *                        timestamps?, assets?, secrets?, instance? } }
 *     NOTE: party.size is an ARRAY [current, max], not two fields.
 *     timestamps { start?, end? }   - integers (see "TIMESTAMP UNITS" below)
 *     assets     { large_image?, large_text?, large_url?,
 *                  small_image?, small_text?, small_url? }
 *     SET_ACTIVITY only accepts activity type 0 (Playing), 2 (Listening),
 *     3 (Watching) or 5 (Competing); we always send 0.
 *   GET_ACTIVITY_INSTANCE_CONNECTED_PARTICIPANTS       (no args)
 *     data { participants: [{ id, username, global_name, discriminator, avatar,
 *                             flags, bot, nickname, ... }] }
 *     (older SDKs called this getInstanceConnectedParticipants; the wire name
 *      has always been the long one.)
 *   OPEN_INVITE_DIALOG                 (no args; errors in DMs, and errors
 *                                       without CREATE_INSTANT_INVITE)
 *   OPEN_EXTERNAL_LINK                 args { url } - shows a "trust this
 *                                       domain?" modal to the user
 *   GET_CHANNEL                        args { channel_id }
 *   GET_CHANNEL_PERMISSIONS            (no args) data { permissions } - a
 *                                       bigint/string bitfield; always 0 in DMs.
 *                                       Docs: needs the guilds.members.read scope.
 *   SUBSCRIBE / UNSUBSCRIBE            evt: '<EVENT>'
 *
 * Participant-change event name: ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE
 * with data { participants: [...] } (same element shape as the GET_ command).
 *
 * ─── LAYOUT MODE (added) ─────────────────────────────────────────────────────
 * An activity is presented in one of three layouts: full-size ("focused"), a
 * small floating window ("picture-in-picture"), or a small tile in the voice
 * call's grid ("grid"). Exposed here as layoutMode() / onLayoutChange() /
 * isSmall().
 *
 * IMPORTANT - THERE IS NO GETTER COMMAND. This was checked, not assumed:
 * the SDK's Commands enum (src/schema/common.ts) has 41 entries and none of
 * them is GET_ACTIVITY_LAYOUT_MODE; src/commands/ has no getActivityLayoutMode
 * module; the SDK reference doc lists no such command. Layout mode is
 * EVENT-ONLY - you SUBSCRIBE and wait. Discord's own playground example
 * (embedded-app-sdk-examples sdk-playground .../pages/LayoutMode.tsx) renders
 * an empty string until the first event arrives, for exactly this reason.
 * So layoutMode() is null until Discord first tells us. It is NOT invented RPC.
 *
 *   EVENT  ACTIVITY_LAYOUT_MODE_UPDATE      data { layout_mode: <int> }
 *     LayoutModeTypeObject: UNHANDLED -1, FOCUSED 0, PIP 1, GRID 2
 *     -> normalised to 'focused' | 'pip' | 'grid'; UNHANDLED (-1) -> null.
 *   EVENT  ACTIVITY_PIP_MODE_UPDATE         (LEGACY - old clients only)
 *     The Layout dev-guide says old clients support only this event and new
 *     clients support both, and points at the SDK helpers
 *     subscribeToLayoutModeUpdatesCompat/unsubscribeFromLayoutModeUpdatesCompat.
 *     Those helpers DO NOT EXIST in the SDK source (not in Discord.ts, not in
 *     interface.ts, not exported from index.ts) and the event is not in the
 *     Events enum nor in the SDK reference's event list - the docs and the
 *     source disagree here. We still SUBSCRIBE to it as a cheap best-effort
 *     (an unsupported event just answers with an ERROR frame, which we
 *     swallow), read its boolean defensively, and IGNORE it entirely once a
 *     real ACTIVITY_LAYOUT_MODE_UPDATE has been seen so the two cannot
 *     fight over the value. Its payload shape is not documented anywhere we
 *     could find; we accept is_pip_mode / pip_mode / a bare boolean.
 *
 * The subscription is LAZY: it is armed by the first call to layoutMode(),
 * isSmall() or onLayoutChange(), and (like the participants one) is deferred
 * until READY if it is asked for early, and re-armed after a CLOSE.
 *
 * VIEWPORT FALLBACK. Because there is no getter, there is a window - possibly
 * a permanent one on a client that emits neither event - where layoutMode() is
 * null. isSmall() therefore falls back to the iframe's own dimensions while the
 * mode is unknown: small means innerWidth <= 480 AND innerHeight <= 400 (both,
 * so a full-screen phone in portrait is not mistaken for a PIP). Tune with
 * window.MIVI_DISCORD_SMALL_MAX_W / _H. Once Discord has told us the real mode,
 * the RPC value wins and the dimensions are ignored. isSmall() is true for
 * 'pip' AND 'grid' - both are small presentations.
 *
 * ─── TIMESTAMP UNITS (setActivity startedAt) ─────────────────────────────────
 * The docs contradict each other: the Activity object structure says
 * timestamps.start is "Unix time (in MILLISECONDS)", while the Rich Presence /
 * Embedded App SDK guide's own worked example passes `start: 1723137832`, which
 * is plainly SECONDS. We normalise: a Date, a seconds epoch and a milliseconds
 * epoch are all accepted and we emit MILLISECONDS (the structure doc wins).
 * Values below 1e11 are treated as seconds - a ms epoch that small would be
 * before 1973, and a seconds epoch that large would be year 5138.
 *

 * ─── ORDERING NOTES ──────────────────────────────────────────────────────────
 * onParticipantsChange(cb) may be called at ANY time - before init(), while the
 * handshake is in flight, or long after. If we are not connected yet the SUBSCRIBE
 * is deferred and sent the moment READY lands, so an early listener still works.
 * participants() is NOT deferred: called before READY it resolves [] immediately
 * rather than waiting, so call it after init() resolves { ok: true }.
 * On CLOSE the subscription is torn down and re-armed, so if a fresh READY ever
 * arrives the SUBSCRIBE is re-sent instead of being assumed still live.
 *
 * ─── THE "/.proxy/" RULE ─────────────────────────────────────────────────────
 * Activities are sandboxed behind Discord's proxy at
 * https://<application_id>.discordsays.com. Historically EVERY network request
 * had to go through a path prefixed with `/.proxy/` (so `/api/rooms` had to be
 * written `/.proxy/api/rooms`) or the CSP blocked it.
 * As of the Discord change-log entry dated 2025-07-30 ("Remove .proxy/ from
 * Discord Activity proxy path") the CSP now allows `https://<app_id>.discordsays.com/*`
 * and the prefix is OPTIONAL: "/.proxy/api" and "/api" behave identically, and
 * the prefix "is still fully supported and will be maintained indefinitely".
 * We therefore still emit '/.proxy' from proxyPrefix(): it works on both old
 * and new Discord clients, which is exactly what a shim wants.
 * Apply it by PREPENDING to a root-relative path only:
 *     fetch(MiviDiscord.proxyPrefix() + '/api/rooms')
 * Outside an activity proxyPrefix() is '' and the same line is unchanged.
 * (Absolute URLs to other hosts still need a URL Mapping in the dev portal.)
 *
 * ─── VERIFIED AGAINST (re-check these if something misbehaves) ───────────────
 *   SDK source, v2.5.0 (the authority for everything on the wire):
 *     https://github.com/discord/embedded-app-sdk/blob/main/src/Discord.ts
 *       - Opcodes enum, getRPCServerSource(), handshake(), handleFrame(),
 *         the URL query-param names, the allowed-origin list
 *     https://github.com/discord/embedded-app-sdk/blob/main/src/schema/common.ts
 *       - Commands enum, ReceiveFramePayload, Activity/party shape
 *     https://github.com/discord/embedded-app-sdk/blob/main/src/schema/events.ts
 *       - Events enum, DispatchEventFrame, ErrorEvent
 *       - ACTIVITY_LAYOUT_MODE_UPDATE -> data { layout_mode }
 *         (confirmed present at v1.2.0, v1.4.3, v2.0.0 and main;
 *          ACTIVITY_PIP_MODE_UPDATE is absent from all of them)
 *     https://github.com/discord/embedded-app-sdk/blob/main/src/schema/common.ts
 *       - LayoutModeTypeObject { UNHANDLED:-1, FOCUSED:0, PIP:1, GRID:2 }
 *         and its siblings OrientationTypeObject { UNHANDLED:-1, PORTRAIT:0,
 *         LANDSCAPE:1 }, OrientationLockStateTypeObject { UNHANDLED:-1,
 *         UNLOCKED:1, PORTRAIT:2, LANDSCAPE:3 }, ThermalStateTypeObject
 *         { UNHANDLED:-1, NOMINAL:0, FAIR:1, SERIOUS:2, CRITICAL:3 }
 *       - Activity.assets { large_image, large_text, large_url, small_image,
 *         small_text, small_url } and Activity.timestamps { start, end }
 *     https://github.com/discord/embedded-app-sdk/blob/main/src/commands/setActivity.ts
 *       - "Required scopes: [rpc.activities.write]"; SetActivity picks
 *         state/state_url/details/details_url/timestamps/assets/party/
 *         secrets/instance/type off the Activity schema
 *     https://github.com/discord/embedded-app-sdk-examples/blob/main/sdk-playground/packages/client/src/pages/LayoutMode.tsx
 *       - the only official way to read layout mode: subscribe + switch on
 *         Common.LayoutModeTypeObject
 *     https://github.com/discord/embedded-app-sdk/blob/main/src/generated/schemas.ts
 *       - AUTHENTICATE + GET_ACTIVITY_INSTANCE_CONNECTED_PARTICIPANTS payloads
 *     https://github.com/discord/embedded-app-sdk/blob/main/src/commands/
 *       - per-command arg shapes
 *   Official docs:
 *     https://docs.discord.com/developers/activities/overview
 *     https://docs.discord.com/developers/activities/how-activities-work
 *       - lifecycle, "[FRAME, {evt: 'READY', ...}]", "[CLOSE, {message, code}]"
 *     https://docs.discord.com/developers/activities/building-an-activity
 *       - authorize/authenticate flow, fetch('/.proxy/api/token')
 *     https://docs.discord.com/developers/activities/development-guides/user-actions
 *       - openExternalLink, openInviteDialog + getChannelPermissions guidance
 *     https://docs.discord.com/developers/activities/development-guides/multiplayer-experience
 *       - participants fetch + subscribe, avatar/name rendering
 *     https://docs.discord.com/developers/change-log  (2025-07-30 entry)
 *       - the /.proxy/ CSP change quoted above
 *     https://docs.discord.com/developers/activities/development-guides/layout
 *       - the three layout modes; the PIP-compat paragraph quoted above;
 *         "Discord will publish the current orientation upon event
 *         subscription" (said of ORIENTATION_UPDATE only - see uncertainties)
 *     https://docs.discord.com/developers/developer-tools/embedded-app-sdk
 *       - setActivity: "Required Scopes - rpc.activities.write"
 *       - ACTIVITY_LAYOUT_MODE_UPDATE: "No scopes required",
 *         sample payload { "layout_mode": 1 }
 *       - LayoutModeTypeObject value table
 *     https://docs.discord.com/developers/rich-presence/using-with-the-embedded-app-sdk
 *       - the assets/timestamps/party worked example
 *       - "Uploading Custom Assets": Developer Portal -> Rich Presence ->
 *         Art Assets, up to 300 assets, 1024x1024 recommended, and asset keys
 *         are LOWERCASED on upload ("Main-Game-Image" -> "main-game-image")
 *       - "Using External Custom Assets": large_image / small_image may
 *         instead be an external image URL, and such URLs do NOT need a URL
 *         Mapping or the /.proxy/ prefix
 *     https://docs.discord.com/developers/events/gateway-events (Activity object)
 *       - Activity Timestamps "Unix time (in milliseconds)"; Activity Assets
 *         field list
 *     https://docs.discord.com/developers/topics/rpc
 *       - SET_ACTIVITY argument structure, and: "In order to call any commands
 *         over RPC, you must be authenticated or you will receive a code 4006
 *         error response" (4006 = INVALID_PERMISSIONS in the SDK's
 *         RPCErrorCodes). A missing scope is an ERROR FRAME, not a silent
 *         no-op - setActivity()'s promise REJECTS.
 *
 * ─── SAFETY CONTRACT ─────────────────────────────────────────────────────────
 * Nothing here touches the page unless we are demonstrably inside a Discord
 * iframe. Outside an activity every method is an immediately-resolving no-op,
 * so the plain website is byte-for-byte unaffected. No method throws
 * synchronously. Methods only reject when we ARE connected and Discord itself
 * returned an error / timed out.
 *
 * Set window.MIVI_DISCORD_DEBUG = true (before init) for console tracing.
 * Note: unlike the real SDK we do NOT override console.* / send CAPTURE_LOG,
 * so logging here can never feed back into the RPC channel.
 */
(function () {
  'use strict';

  // ── constants ──────────────────────────────────────────────────────────────

  var OP_HANDSHAKE = 0;
  var OP_FRAME = 1;
  var OP_CLOSE = 2;
  var OP_HELLO = 3;

  var RPC_VERSION = 1;
  var COMMAND_TIMEOUT_MS = 10000;
  var HANDSHAKE_TIMEOUT_MS = 10000;

  // Mirrors HANDSHAKE_SDK_VERSION_MINIMUM_MOBILE_VERSION in the SDK.
  var MIN_MOBILE_MAJOR_FOR_SDK_VERSION = 250;
  var DEFAULT_SDK_VERSION = '2.5.0';

  var CMD_DISPATCH = 'DISPATCH';
  var CMD_SUBSCRIBE = 'SUBSCRIBE';
  var CMD_AUTHORIZE = 'AUTHORIZE';
  var CMD_AUTHENTICATE = 'AUTHENTICATE';
  var CMD_SET_ACTIVITY = 'SET_ACTIVITY';
  var CMD_GET_PARTICIPANTS = 'GET_ACTIVITY_INSTANCE_CONNECTED_PARTICIPANTS';
  var CMD_OPEN_INVITE_DIALOG = 'OPEN_INVITE_DIALOG';
  var CMD_OPEN_EXTERNAL_LINK = 'OPEN_EXTERNAL_LINK';
  var CMD_GET_CHANNEL = 'GET_CHANNEL';
  var CMD_GET_CHANNEL_PERMISSIONS = 'GET_CHANNEL_PERMISSIONS';

  var EVT_READY = 'READY';
  var EVT_ERROR = 'ERROR';
  var EVT_PARTICIPANTS_UPDATE = 'ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE';
  var EVT_LAYOUT_MODE_UPDATE = 'ACTIVITY_LAYOUT_MODE_UPDATE';
  var EVT_PIP_MODE_UPDATE = 'ACTIVITY_PIP_MODE_UPDATE';   // legacy, old clients

  // LayoutModeTypeObject from the SDK's src/schema/common.ts, mapped to the
  // lowercase names this shim exposes. -1 (UNHANDLED) deliberately has no name.
  var LAYOUT_MODE_FOCUSED = 'focused';
  var LAYOUT_MODE_PIP = 'pip';
  var LAYOUT_MODE_GRID = 'grid';

  // Viewport fallback used only while the RPC layout mode is unknown.
  var SMALL_MAX_W = 480;
  var SMALL_MAX_H = 400;
  var RESIZE_DEBOUNCE_MS = 150;

  // Rich-presence field caps. Hover texts truncate harmlessly; image refs are
  // DROPPED rather than truncated, because half a URL is worse than no image.
  var PRESENCE_TEXT_MAX = 128;
  var ASSET_REF_MAX = 512;

  // A ms epoch below this would be before 1973; a seconds epoch above it would
  // be year 5138. Anything under it is therefore seconds and gets promoted.
  var SECONDS_EPOCH_CEILING = 1e11;

  var PROXY_PREFIX = '/.proxy';

  // Same list the SDK accepts. 'null' covers sandboxed/opaque-origin clients.
  var DISCORD_ORIGINS = [
    'https://discord.com',
    'https://discordapp.com',
    'https://ptb.discord.com',
    'https://ptb.discordapp.com',
    'https://canary.discord.com',
    'https://canary.discordapp.com',
    'https://staging.discord.co',
    'https://pax.discord.com',
    'http://localhost:3333',
    'null'
  ];

  // ── tiny helpers ───────────────────────────────────────────────────────────

  var hasWindow = (typeof window !== 'undefined' && window !== null);
  var hasDocument = (typeof document !== 'undefined' && document !== null);

  function debug() {
    if (!hasWindow || !window.MIVI_DISCORD_DEBUG) return;
    try {
      var args = ['[MiviDiscord]'].concat(Array.prototype.slice.call(arguments));
      // eslint-disable-next-line no-console
      (console.debug || console.log).apply(console, args);
    } catch (e) { /* logging must never break anything */ }
  }

  function err(message, code) {
    var e = new Error(message);
    e.name = 'MiviDiscordError';
    if (code !== undefined && code !== null) e.code = code;
    return e;
  }

  function isObject(v) { return v !== null && typeof v === 'object'; }
  function isStr(v) { return typeof v === 'string'; }
  function str(v) { return isStr(v) ? v : null; }

  function clampText(v, max) {
    if (!isStr(v)) return null;
    var s = v.trim();
    if (!s) return null;
    return s.length > max ? s.slice(0, max) : s;
  }

  function posInt(v) {
    var n = typeof v === 'number' ? v : parseInt(v, 10);
    if (!isFinite(n) || n <= 0) return 0;
    return Math.floor(n);
  }

  // An asset key ("main-game-image") or an external image URL. Never truncated:
  // a chopped URL/key would silently resolve to nothing, so an over-long value
  // is dropped instead. Returns null when there is nothing usable.
  function assetRef(v) {
    if (!isStr(v)) return null;
    var s = v.trim();
    if (!s || s.length > ASSET_REF_MAX) return null;
    return s;
  }

  // Accepts a Date, a ms epoch, a seconds epoch, or a parseable date string;
  // returns MILLISECONDS (see "TIMESTAMP UNITS" in the header), or 0.
  function epochMillis(v) {
    var n;
    if (Object.prototype.toString.call(v) === '[object Date]') {
      // valueOf rather than getTime so a cross-realm Date still works.
      n = v.valueOf();
    } else if (typeof v === 'number') {
      n = v;
    } else if (isStr(v)) {
      var t = v.trim();
      if (!t) return 0;
      n = /^[0-9]+$/.test(t) ? parseInt(t, 10) : Date.parse(t);
    } else {
      return 0;
    }
    if (typeof n !== 'number' || !isFinite(n) || n <= 0) return 0;
    n = Math.floor(n);
    if (n < SECONDS_EPOCH_CEILING) n = n * 1000;
    return n;
  }

  // LayoutModeTypeObject -> our lowercase names. UNHANDLED (-1) and anything
  // unrecognised become null, i.e. "we do not know", which lets isSmall() fall
  // back to the viewport instead of guessing.
  function layoutModeName(v) {
    var n = typeof v === 'number' ? v : (isStr(v) ? parseInt(v, 10) : NaN);
    if (n === 0) return LAYOUT_MODE_FOCUSED;
    if (n === 1) return LAYOUT_MODE_PIP;
    if (n === 2) return LAYOUT_MODE_GRID;
    return null;
  }

  // The legacy ACTIVITY_PIP_MODE_UPDATE payload is undocumented; be liberal.
  function readPipFlag(data) {
    if (typeof data === 'boolean') return data;
    if (!isObject(data)) return null;
    if (typeof data.is_pip_mode === 'boolean') return data.is_pip_mode;
    if (typeof data.pip_mode === 'boolean') return data.pip_mode;
    if (typeof data.is_pip === 'boolean') return data.is_pip;
    return null;
  }

  function smallLimit(name, fallback) {
    var v;
    try { v = hasWindow ? window[name] : undefined; } catch (e) { return fallback; }
    if (typeof v !== 'number' || !isFinite(v) || v <= 0) return fallback;
    return v;
  }

  // Fallback for "is this a small presentation?" while the RPC mode is unknown.
  // BOTH dimensions must be small, so a full-screen phone in portrait (narrow
  // but tall) is not mistaken for a picture-in-picture window.
  function viewportLooksSmall() {
    if (!hasWindow) return false;
    var w, h;
    try {
      w = window.innerWidth;
      h = window.innerHeight;
    } catch (e) { return false; }
    if (typeof w !== 'number' || typeof h !== 'number') return false;
    if (!isFinite(w) || !isFinite(h) || w <= 0 || h <= 0) return false;
    return w <= smallLimit('MIVI_DISCORD_SMALL_MAX_W', SMALL_MAX_W) &&
           h <= smallLimit('MIVI_DISCORD_SMALL_MAX_H', SMALL_MAX_H);
  }

  function makeNonce() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') {
        return window.crypto.randomUUID();
      }
      if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
        var b = new Uint8Array(16);
        window.crypto.getRandomValues(b);
        b[6] = (b[6] & 0x0f) | 0x40;   // version 4
        b[8] = (b[8] & 0x3f) | 0x80;   // variant 10
        var hex = [];
        for (var i = 0; i < 16; i++) hex.push((b[i] + 0x100).toString(16).slice(1));
        return hex.slice(0, 4).join('') + '-' + hex.slice(4, 6).join('') + '-' +
               hex.slice(6, 8).join('') + '-' + hex.slice(8, 10).join('') + '-' +
               hex.slice(10, 16).join('');
      }
    } catch (e) { /* fall through */ }
    return 'n-' + Date.now().toString(36) + '-' +
           Math.random().toString(36).slice(2, 10) +
           Math.random().toString(36).slice(2, 10);
  }

  function searchParams() {
    var search = '';
    try { search = (hasWindow && window.location && window.location.search) || ''; } catch (e) { search = ''; }
    try {
      return new URLSearchParams(search);
    } catch (e) {
      // Ancient / exotic engine: hand-roll it rather than blow up.
      var map = {};
      var raw = search.charAt(0) === '?' ? search.slice(1) : search;
      raw.split('&').forEach(function (pair) {
        if (!pair) return;
        var idx = pair.indexOf('=');
        var k = idx < 0 ? pair : pair.slice(0, idx);
        var v = idx < 0 ? '' : pair.slice(idx + 1);
        try { map[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, ' ')); }
        catch (e2) { map[k] = v; }
      });
      return { get: function (k) { return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null; } };
    }
  }

  // Reads an id-ish query param, treating a literal "null"/"undefined"/blank as
  // absent. Discord is EXPECTED to simply omit guild_id in (G)DM launches (that is
  // what the SDK's own `discordSdk.guildId == null` guidance assumes), but this was
  // never confirmed against a live client, and the cost of being wrong is real:
  // openInvite()'s DM guard - and any `if (context().guildId)` in caller code -
  // would treat the string "null" as a guild and fire OPEN_INVITE_DIALOG, which
  // errors with INVALID_CHANNEL (4005). A snowflake is never one of these strings,
  // so normalising here is free insurance.
  function qparam(p, name) {
    var v;
    try { v = p.get(name); } catch (e) { return null; }
    if (!isStr(v)) return null;
    v = v.trim();
    if (!v || v === 'null' || v === 'undefined') return null;
    return v;
  }

  function originOf(url) {
    try {
      var u = new URL(url);
      return u.protocol + '//' + u.host;
    } catch (e) { return null; }
  }

  // ── activity detection (synchronous, safe before init) ─────────────────────

  var activityFlag = null;

  function computeIsActivity() {
    if (!hasWindow) return false;
    var p = searchParams();
    var frameId = qparam(p, 'frame_id');
    var instanceId = qparam(p, 'instance_id');
    if (frameId && instanceId) return true;

    // Served through the Discord proxy even if the params were stripped
    // (e.g. a client-side route change ate the query string).
    try {
      var host = (window.location && window.location.hostname) || '';
      if (/(^|\.)discordsays\.com$/i.test(host)) return true;
    } catch (e) { /* ignore */ }

    // Last resort: framed by a Discord client AND carrying a frame_id.
    try {
      if (frameId && hasDocument && document.referrer) {
        var o = originOf(document.referrer);
        if (o && DISCORD_ORIGINS.indexOf(o) !== -1) return true;
      }
    } catch (e) { /* ignore */ }

    return false;
  }

  function isActivity() {
    if (activityFlag === null) {
      try { activityFlag = computeIsActivity(); }
      catch (e) { activityFlag = false; }
    }
    return activityFlag;
  }

  function proxyPrefix() {
    return isActivity() ? PROXY_PREFIX : '';
  }

  // ── connection state ───────────────────────────────────────────────────────

  var ctx = null;              // { instanceId, channelId, guildId, platform, frameId }
  var rawParams = null;        // extra params we captured but don't expose in ctx
  var lastClientId = null;     // remembered from init(), needed again by AUTHORIZE
  var readyWaiters = [];       // resolved when the READY dispatch lands
  var rpcSource = null;        // the Discord client Window
  var rpcOrigin = '*';         // postMessage targetOrigin
  var connected = false;       // READY seen
  var listening = false;
  var initPromise = null;
  var pending = Object.create(null);   // nonce -> { resolve, reject, timer, cmd }
  var allowedOrigins = null;

  var participantCache = null;         // normalised array, or null before first fetch
  var participantListeners = [];
  var participantsFetched = false;
  var subscribed = false;
  var subscribing = null;
  var subscribeWanted = false;   // a SUBSCRIBE was asked for before READY landed

  var layoutModeValue = null;          // 'focused' | 'pip' | 'grid' | null (unknown)
  var layoutListeners = [];
  var layoutSubscribed = false;
  var layoutSubscribing = null;
  var layoutSubscribeWanted = false;
  var sawLayoutEvent = false;          // once true, the legacy PIP event is ignored
  var layoutEmitted = null;            // { mode, small } last broadcast to listeners
  var resizeBound = false;
  var resizeTimer = null;

  function buildAllowedOrigins() {
    if (allowedOrigins) return allowedOrigins;
    allowedOrigins = Object.create(null);
    var list = DISCORD_ORIGINS.slice();
    try { if (window.location && window.location.origin) list.push(window.location.origin); }
    catch (e) { /* ignore */ }
    for (var i = 0; i < list.length; i++) if (list[i]) allowedOrigins[list[i]] = true;
    return allowedOrigins;
  }

  function getRpcTarget() {
    // The RPC server always lives in the main Discord client window. When the
    // activity is popped out, that window is our parent's opener.
    var target = null;
    try { target = window.parent; } catch (e) { target = null; }
    try { if (target && target.opener) target = target.opener; } catch (e) { /* cross-origin: keep parent */ }
    var origin = '*';
    try { if (hasDocument && document.referrer) origin = document.referrer; } catch (e) { origin = '*'; }
    return [target, origin];
  }

  function post(opcode, payload) {
    if (!rpcSource) return false;
    try {
      rpcSource.postMessage([opcode, payload], rpcOrigin);
      return true;
    } catch (e) {
      debug('postMessage failed', e);
      return false;
    }
  }

  function settle(nonce, ok, value) {
    var entry = pending[nonce];
    if (!entry) return;
    delete pending[nonce];
    try { clearTimeout(entry.timer); } catch (e) { /* ignore */ }
    if (ok) entry.resolve(value); else entry.reject(value);
  }

  function failAllPending(reason) {
    var keys = Object.keys(pending);
    for (var i = 0; i < keys.length; i++) settle(keys[i], false, reason);
  }

  // ── low-level command send ─────────────────────────────────────────────────

  function sendCommand(cmd, args, evt) {
    return new Promise(function (resolve, reject) {
      if (!connected || !rpcSource) {
        reject(err('discord rpc is not connected (cmd ' + cmd + ')'));
        return;
      }
      var nonce = makeNonce();
      var payload = { cmd: cmd, nonce: nonce };
      if (args !== undefined) payload.args = args;
      if (evt !== undefined) payload.evt = evt;

      var timer = setTimeout(function () {
        settle(nonce, false, err('discord command timed out after ' + COMMAND_TIMEOUT_MS + 'ms: ' + cmd));
      }, COMMAND_TIMEOUT_MS);

      pending[nonce] = { resolve: resolve, reject: reject, timer: timer, cmd: cmd };
      debug('->', cmd, payload);

      if (!post(OP_FRAME, payload)) {
        settle(nonce, false, err('failed to post command to discord: ' + cmd));
      }
    });
  }

  // ── inbound frames ─────────────────────────────────────────────────────────

  function emitParticipants(list) {
    // Snapshot: a listener is allowed to register another one from inside the
    // callback without changing who this round notifies.
    var snapshot = participantListeners.slice();
    for (var i = 0; i < snapshot.length; i++) {
      var cb = snapshot[i];
      try { cb(list.slice()); }
      catch (e) { debug('participants listener threw', e); }
    }
  }

  function normaliseParticipant(p) {
    if (!isObject(p)) return null;
    var id = isStr(p.id) ? p.id : (typeof p.id === 'number' ? String(p.id) : null);
    if (!id) return null;
    return {
      id: id,
      username: isStr(p.username) ? p.username : '',
      globalName: str(p.global_name),
      avatar: str(p.avatar),
      nickname: str(p.nickname)
    };
  }

  function normaliseParticipants(raw) {
    var out = [];
    if (!raw || Object.prototype.toString.call(raw) !== '[object Array]') return out;
    for (var i = 0; i < raw.length; i++) {
      var n = normaliseParticipant(raw[i]);
      if (n) out.push(n);
    }
    return out;
  }

  function handleDispatch(evt, data) {
    if (evt === EVT_READY) {
      if (!connected) {
        connected = true;
        debug('READY', data);
        readyWaiters.forEach(function (fn) { try { fn(); } catch (e) { /* ignore */ } });
        readyWaiters = [];
        // Flush subscriptions that were requested before the connection existed.
        if (subscribeWanted) { try { ensureSubscribed(); } catch (e) { debug('deferred subscribe failed', e); } }
        if (layoutSubscribeWanted) { try { ensureLayoutSubscribed(); } catch (e) { debug('deferred layout subscribe failed', e); } }
      }
      return;
    }
    if (evt === EVT_LAYOUT_MODE_UPDATE) {
      sawLayoutEvent = true;
      applyLayoutMode(layoutModeName(isObject(data) ? data.layout_mode : null));
      return;
    }
    if (evt === EVT_PIP_MODE_UPDATE) {
      // The modern event is authoritative: once we have seen one, ignore this
      // legacy one entirely so the two cannot disagree (it cannot express grid).
      if (sawLayoutEvent) { debug('ignoring legacy pip event; layout event is live'); return; }
      var pip = readPipFlag(data);
      if (pip === null) { debug('unreadable legacy pip payload', data); return; }
      applyLayoutMode(pip ? LAYOUT_MODE_PIP : LAYOUT_MODE_FOCUSED);
      return;
    }
    if (evt === EVT_PARTICIPANTS_UPDATE) {
      var list = normaliseParticipants(isObject(data) ? data.participants : null);
      participantCache = list;
      debug('participants update', list.length);
      emitParticipants(list);
      return;
    }
    debug('unhandled dispatch', evt);
  }

  function handleFrame(payload) {
    if (!isObject(payload)) return;
    var cmd = payload.cmd;
    if (!isStr(cmd)) return;

    var evt = isStr(payload.evt) ? payload.evt : null;
    var nonce = isStr(payload.nonce) ? payload.nonce : null;

    if (cmd === CMD_DISPATCH) {
      handleDispatch(evt, payload.data);
      return;
    }

    if (evt === EVT_ERROR) {
      var d = isObject(payload.data) ? payload.data : {};
      var e = err(
        'discord rpc error on ' + cmd + ': ' + (isStr(d.message) ? d.message : 'unknown error'),
        typeof d.code === 'number' ? d.code : null
      );
      if (nonce) { settle(nonce, false, e); return; }
      debug('untagged rpc error', e);
      return;
    }

    if (!nonce) { debug('frame without nonce, ignoring', cmd); return; }
    settle(nonce, true, payload.data);
  }

  function handleMessage(event) {
    // 1. origin must be the discord client (or ourselves)
    if (!event || !buildAllowedOrigins()[event.origin]) return;

    // 2. shape must be the [opcode, payload] tuple
    var tuple = event.data;
    if (Object.prototype.toString.call(tuple) !== '[object Array]') return;
    if (tuple.length < 1) return;

    var opcode = tuple[0];
    if (typeof opcode !== 'number') return;
    var payload = tuple[1];

    switch (opcode) {
      case OP_HELLO:
        return;                       // legacy; the SDK ignores it too
      case OP_HANDSHAKE:
        return;                       // echo of our own handshake; nothing to do
      case OP_CLOSE:
        debug('CLOSE', payload);
        connected = false;
        // The subscription died with the connection; re-arm it so a fresh READY
        // (or a later participants() call) resubscribes instead of assuming it holds.
        subscribed = false;
        subscribeWanted = participantListeners.length > 0;
        // Same for the layout subscription. We keep the last known mode (the
        // presentation did not change just because the socket died) but re-arm
        // if anyone still cares, or if anyone had already asked for it.
        layoutSubscribed = false;
        layoutSubscribeWanted = layoutSubscribeWanted || layoutListeners.length > 0 || sawLayoutEvent;
        failAllPending(err(
          'discord closed the rpc connection' +
          (isObject(payload) && isStr(payload.message) ? ': ' + payload.message : ''),
          isObject(payload) && typeof payload.code === 'number' ? payload.code : null
        ));
        return;
      case OP_FRAME:
        return handleFrame(payload);
      default:
        return;                       // unknown opcode: ignore, never throw
    }
  }

  // ── init / handshake ───────────────────────────────────────────────────────

  function sdkVersionForHandshake(platform, mobileAppVersion) {
    var v = DEFAULT_SDK_VERSION;
    if (hasWindow && Object.prototype.hasOwnProperty.call(window, 'MIVI_DISCORD_SDK_VERSION')) {
      v = window.MIVI_DISCORD_SDK_VERSION;
    }
    if (!isStr(v) || !v) return null;
    if (platform !== 'mobile') return v;
    // Old mobile clients reject the extra key; the SDK gates it the same way.
    var major = -1;
    if (isStr(mobileAppVersion) && mobileAppVersion.indexOf('.') !== -1) {
      var parsed = parseInt(mobileAppVersion.split('.')[0], 10);
      if (isFinite(parsed)) major = parsed;
    }
    return major >= MIN_MOBILE_MAJOR_FOR_SDK_VERSION ? v : null;
  }

  function doInit(clientId) {
    if (!isActivity()) {
      debug('not running inside a discord activity - init is a no-op');
      return Promise.resolve({ ok: false, error: 'not_an_activity' });
    }
    if (!isStr(clientId) || !clientId) {
      return Promise.resolve({ ok: false, error: 'missing_client_id' });
    }

    var p = searchParams();
    var frameId = qparam(p, 'frame_id');
    var instanceId = qparam(p, 'instance_id');
    var platform = qparam(p, 'platform');
    if (!frameId) {
      return Promise.resolve({ ok: false, error: 'missing_frame_id' });
    }
    if (platform !== 'desktop' && platform !== 'mobile') platform = 'desktop';

    rawParams = {
      customId: qparam(p, 'custom_id'),
      referrerId: qparam(p, 'referrer_id'),
      locationId: qparam(p, 'location_id'),
      mobileAppVersion: qparam(p, 'mobile_app_version')
    };

    // Context is useful even if the handshake later stalls, so publish it as
    // soon as the params validate (still strictly "after init was called").
    ctx = {
      instanceId: instanceId,
      channelId: qparam(p, 'channel_id'),
      guildId: qparam(p, 'guild_id'),
      platform: platform,
      frameId: frameId
    };

    var target = getRpcTarget();
    rpcSource = target[0];
    rpcOrigin = target[1];
    if (!rpcSource) {
      return Promise.resolve({ ok: false, error: 'no_rpc_target' });
    }

    if (!listening) {
      try { window.addEventListener('message', handleMessage); listening = true; }
      catch (e) { return Promise.resolve({ ok: false, error: 'cannot_listen' }); }
    }

    var handshake = {
      v: RPC_VERSION,
      encoding: 'json',
      client_id: clientId,
      frame_id: frameId
    };
    var sv = sdkVersionForHandshake(platform, rawParams.mobileAppVersion);
    if (sv) handshake.sdk_version = sv;

    debug('handshake ->', handshake, 'origin', rpcOrigin);

    return new Promise(function (resolve) {
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        debug('handshake timed out');
        resolve({ ok: false, error: 'handshake_timeout' });
      }, HANDSHAKE_TIMEOUT_MS);

      readyWaiters.push(function () {
        if (done) return;
        done = true;
        try { clearTimeout(timer); } catch (e) { /* ignore */ }
        resolve({ ok: true });
      });

      if (!post(OP_HANDSHAKE, handshake)) {
        if (done) return;
        done = true;
        try { clearTimeout(timer); } catch (e) { /* ignore */ }
        resolve({ ok: false, error: 'handshake_post_failed' });
      }
    });
  }

  function init(clientId) {
    try {
      if (isStr(clientId) && clientId && !lastClientId) lastClientId = clientId;
      if (initPromise) return initPromise;
      initPromise = doInit(clientId).catch(function (e) {
        debug('init failed', e);
        return { ok: false, error: (e && e.message) ? e.message : 'init_failed' };
      });
      return initPromise;
    } catch (e) {
      // Belt and braces: init() must never throw synchronously.
      return Promise.resolve({ ok: false, error: (e && e.message) ? e.message : 'init_failed' });
    }
  }

  // ── public commands ────────────────────────────────────────────────────────

  function live() { return isActivity() && connected && !!rpcSource; }

  // opts.prompt lets the caller retry with a visible consent screen when the
  // silent attempt (the default, prompt:'none') comes back with no code.
  function authorize(scopes, opts) {
    try {
      if (!live()) return Promise.resolve({ code: '' });
      var list = [];
      if (Object.prototype.toString.call(scopes) === '[object Array]') {
        for (var i = 0; i < scopes.length; i++) if (isStr(scopes[i]) && scopes[i]) list.push(scopes[i]);
      }
      if (!list.length) list = ['identify'];
      // AUTHORIZE needs the client id again; we kept the one passed to init().
      if (!lastClientId) return Promise.resolve({ code: '' });

      var promptMode = (opts && isStr(opts.prompt)) ? opts.prompt : 'none';
      return sendCommand(CMD_AUTHORIZE, {
        client_id: lastClientId,
        scope: list,
        response_type: 'code',
        state: '',
        prompt: promptMode
      }).then(function (data) {
        var code = (isObject(data) && isStr(data.code)) ? data.code : '';
        return { code: code };
      });
    } catch (e) {
      return Promise.reject(e);
    }
  }

  function authenticate(accessToken) {
    try {
      if (!live()) return Promise.resolve({});
      if (!isStr(accessToken) || !accessToken) return Promise.resolve({});
      return sendCommand(CMD_AUTHENTICATE, { access_token: accessToken })
        .then(function (data) { return isObject(data) ? data : {}; });
    } catch (e) {
      return Promise.reject(e);
    }
  }

  function ensureSubscribed() {
    if (subscribed) return Promise.resolve();
    if (!live()) {
      // Not connected yet - init() may still be in flight, or the caller
      // registered a listener before calling it at all. Remember the intent so
      // the SUBSCRIBE goes out the instant READY lands; without this a listener
      // registered early is silently never subscribed and never fires.
      if (isActivity()) subscribeWanted = true;
      return Promise.resolve();
    }
    subscribeWanted = false;
    if (subscribing) return subscribing;
    subscribing = sendCommand(CMD_SUBSCRIBE, undefined, EVT_PARTICIPANTS_UPDATE)
      .then(function () { subscribed = true; debug('subscribed to ' + EVT_PARTICIPANTS_UPDATE); })
      .catch(function (e) { debug('subscribe failed', e); })
      .then(function () { subscribing = null; });
    return subscribing;
  }

  function participants() {
    try {
      if (!live()) return Promise.resolve([]);
      ensureSubscribed();
      return sendCommand(CMD_GET_PARTICIPANTS)
        .then(function (data) {
          var list = normaliseParticipants(isObject(data) ? data.participants : null);
          participantCache = list;
          if (!participantsFetched) {
            participantsFetched = true;
            emitParticipants(list);
          }
          return list.slice();
        })
        .catch(function (e) {
          debug('participants failed', e);
          return participantCache ? participantCache.slice() : [];
        });
    } catch (e) {
      return Promise.resolve([]);
    }
  }

  function onParticipantsChange(cb) {
    if (typeof cb !== 'function') return;
    if (participantListeners.indexOf(cb) === -1) participantListeners.push(cb);
    if (!isActivity()) return;
    ensureSubscribed();
    // If we already have a list, hand it over on the next tick so the caller
    // never has to special-case "registered too late".
    if (participantCache) {
      var snapshot = participantCache.slice();
      setTimeout(function () { try { cb(snapshot); } catch (e) { debug('listener threw', e); } }, 0);
    }
  }

  // ── layout mode ────────────────────────────────────────────────────────────

  function getLayoutMode() {
    try {
      if (!isActivity()) return null;
      ensureLayoutSubscribed();          // lazy-arm; harmless if already armed
    } catch (e) { debug('layoutMode arm failed', e); }
    return layoutModeValue;
  }

  function isSmall() {
    try {
      if (!isActivity()) return false;
      try { ensureLayoutSubscribed(); } catch (e) { debug('isSmall arm failed', e); }
      if (layoutModeValue === LAYOUT_MODE_PIP || layoutModeValue === LAYOUT_MODE_GRID) return true;
      if (layoutModeValue === LAYOUT_MODE_FOCUSED) return false;
      // Mode still unknown - fall back to our own dimensions.
      return viewportLooksSmall();
    } catch (e) {
      return false;
    }
  }

  function emitLayout() {
    var mode = layoutModeValue;
    var small = isSmall();
    if (layoutEmitted && layoutEmitted.mode === mode && layoutEmitted.small === small) return;
    layoutEmitted = { mode: mode, small: small };
    // Snapshot, so a listener may register another one without joining this round.
    var snapshot = layoutListeners.slice();
    for (var i = 0; i < snapshot.length; i++) {
      try { snapshot[i](mode, small); }
      catch (e) { debug('layout listener threw', e); }
    }
  }

  function applyLayoutMode(mode) {
    layoutModeValue = mode;
    debug('layout mode ->', mode);
    emitLayout();
  }

  function onResize() {
    try { clearTimeout(resizeTimer); } catch (e) { /* ignore */ }
    resizeTimer = setTimeout(function () {
      // Only meaningful while Discord has not told us the real mode; once it
      // has, isSmall() ignores the viewport and emitLayout() dedupes anyway.
      try { emitLayout(); } catch (e) { debug('resize emit failed', e); }
    }, RESIZE_DEBOUNCE_MS);
  }

  function bindResize() {
    if (resizeBound || !hasWindow || !isActivity()) return;
    try { window.addEventListener('resize', onResize); resizeBound = true; }
    catch (e) { debug('cannot listen for resize', e); }
  }

  function ensureLayoutSubscribed() {
    if (layoutSubscribed) return Promise.resolve();
    if (!live()) {
      // Same deferral as the participants subscription: remember the intent so
      // the SUBSCRIBE goes out the moment READY lands.
      if (isActivity()) layoutSubscribeWanted = true;
      return Promise.resolve();
    }
    layoutSubscribeWanted = false;
    if (layoutSubscribing) return layoutSubscribing;

    layoutSubscribing = sendCommand(CMD_SUBSCRIBE, undefined, EVT_LAYOUT_MODE_UPDATE)
      .then(function () { layoutSubscribed = true; debug('subscribed to ' + EVT_LAYOUT_MODE_UPDATE); })
      .catch(function (e) { debug('layout subscribe failed', e); })
      .then(function () {
        // Best-effort legacy subscription for old clients that only know the
        // PIP event. On a client that does not know it this just comes back as
        // an ERROR frame (INVALID_EVENT 4004), which we swallow.
        return sendCommand(CMD_SUBSCRIBE, undefined, EVT_PIP_MODE_UPDATE)
          .then(function () { debug('subscribed to legacy ' + EVT_PIP_MODE_UPDATE); })
          .catch(function (e) { debug('legacy pip subscribe declined (expected on new clients)', e); });
      })
      .then(function () { layoutSubscribing = null; });

    return layoutSubscribing;
  }

  function onLayoutChange(cb) {
    if (typeof cb !== 'function') return;
    if (layoutListeners.indexOf(cb) === -1) layoutListeners.push(cb);
    if (!isActivity()) return;           // outside Discord: registered, never fires
    ensureLayoutSubscribed();
    bindResize();
    // If we already know something, hand it over on the next tick so the caller
    // never has to special-case "registered too late". layoutEmitted covers the
    // case where the mode itself is unknown but the viewport fallback has
    // already produced an answer for earlier listeners.
    if (layoutModeValue !== null || layoutEmitted !== null) {
      var mode = layoutModeValue;
      var small = isSmall();
      setTimeout(function () {
        try { cb(mode, small); } catch (e) { debug('layout listener threw', e); }
      }, 0);
    }
  }

  function setActivity(opts) {
    try {
      if (!live()) return Promise.resolve(undefined);
      opts = isObject(opts) ? opts : {};

      var activity = { type: 0 };            // 0 = Playing
      var details = clampText(opts.details, PRESENCE_TEXT_MAX);
      var state = clampText(opts.state, PRESENCE_TEXT_MAX);
      if (details) activity.details = details;
      if (state) activity.state = state;

      var size = posInt(opts.partySize);
      if (size) {
        var max = posInt(opts.partyMax);
        if (!max || max < size) max = size;
        activity.party = { size: [size, max] };
        if (ctx && ctx.instanceId) activity.party.id = ctx.instanceId;
      }

      // timestamps.start - "Playing for 12:34" on the profile.
      var startedAt = epochMillis(opts.startedAt);
      if (startedAt) activity.timestamps = { start: startedAt };

      // assets.* - large_image / small_image are either a Rich Presence art
      // asset KEY uploaded in the Developer Portal (lowercased on upload) or an
      // external image URL; either way they are passed through verbatim.
      var assets = {};
      var largeImage = assetRef(opts.largeImage);
      var largeText = clampText(opts.largeText, PRESENCE_TEXT_MAX);
      var smallImage = assetRef(opts.smallImage);
      var smallText = clampText(opts.smallText, PRESENCE_TEXT_MAX);
      if (largeImage) assets.large_image = largeImage;
      if (largeText) assets.large_text = largeText;
      if (smallImage) assets.small_image = smallImage;
      if (smallText) assets.small_text = smallText;
      for (var k in assets) {
        if (Object.prototype.hasOwnProperty.call(assets, k)) { activity.assets = assets; break; }
      }

      activity.instance = true;

      return sendCommand(CMD_SET_ACTIVITY, { activity: activity })
        .then(function () { return undefined; });
    } catch (e) {
      return Promise.reject(e);
    }
  }

  function openInvite() {
    try {
      if (!live()) return Promise.resolve(undefined);
      // OPEN_INVITE_DIALOG errors in (G)DM contexts, so don't even try there.
      if (!ctx || !ctx.guildId) {
        debug('openInvite skipped: no guild context');
        return Promise.resolve(undefined);
      }
      return sendCommand(CMD_OPEN_INVITE_DIALOG).then(function () { return undefined; });
    } catch (e) {
      return Promise.reject(e);
    }
  }

  function openExternalLink(url) {
    try {
      if (!live()) return Promise.resolve(undefined);
      if (!isStr(url) || !url) return Promise.resolve(undefined);
      return sendCommand(CMD_OPEN_EXTERNAL_LINK, { url: url })
        .then(function () { return undefined; });
    } catch (e) {
      return Promise.reject(e);
    }
  }

  // ── wiring ─────────────────────────────────────────────────────────────────

  window.MiviDiscord = {
    isActivity: isActivity,
    proxyPrefix: proxyPrefix,
    context: function () { return ctx ? {
      instanceId: ctx.instanceId,
      channelId: ctx.channelId,
      guildId: ctx.guildId,
      platform: ctx.platform,
      frameId: ctx.frameId
    } : null; },
    init: function (clientId) { return init(clientId); },
    authorize: authorize,
    authenticate: authenticate,
    participants: participants,
    onParticipantsChange: onParticipantsChange,
    setActivity: setActivity,
    openInvite: openInvite,
    openExternalLink: openExternalLink,

    // ── layout / size awareness ─────────────────────────────────────────────
    // layoutMode()      -> 'focused' | 'pip' | 'grid' | null  (null = not in an
    //                      activity, or Discord has not told us yet - there is
    //                      no getter command, only the event)
    // isSmall()         -> true in pip/grid; while the mode is unknown, falls
    //                      back to the iframe's own dimensions. Always false
    //                      outside an activity.
    // onLayoutChange(cb)-> cb(mode, small) on every change, plus once with the
    //                      current value if it is already known. Outside an
    //                      activity it registers and never fires.
    layoutMode: getLayoutMode,
    isSmall: isSmall,
    onLayoutChange: onLayoutChange,

    // ── extras (not part of the required contract, handy for wiring) ─────────
    // Root-relative URL helper: url('/api/rooms') -> '/.proxy/api/rooms' inside
    // an activity, '/api/rooms' outside.
    url: function (path) {
      if (!isStr(path) || path.charAt(0) !== '/') return path;
      var pre = proxyPrefix();
      if (!pre) return path;
      if (path.indexOf(PROXY_PREFIX + '/') === 0 || path === PROXY_PREFIX) return path;
      return pre + path;
    },
    isReady: function () { return connected; },
    // Extra launch params Discord passes that aren't in context().
    params: function () { return rawParams ? {
      customId: rawParams.customId,
      referrerId: rawParams.referrerId,
      locationId: rawParams.locationId,
      mobileAppVersion: rawParams.mobileAppVersion
    } : null; },
    // GET_CHANNEL / GET_CHANNEL_PERMISSIONS - useful before openInvite().
    channel: function () {
      try {
        if (!live() || !ctx || !ctx.channelId) return Promise.resolve(null);
        return sendCommand(CMD_GET_CHANNEL, { channel_id: ctx.channelId })
          .then(function (d) { return isObject(d) ? d : null; })
          .catch(function () { return null; });
      } catch (e) { return Promise.resolve(null); }
    },
    channelPermissions: function () {
      try {
        if (!live()) return Promise.resolve(null);
        return sendCommand(CMD_GET_CHANNEL_PERMISSIONS)
          .then(function (d) { return (isObject(d) && d.permissions !== undefined) ? String(d.permissions) : null; })
          .catch(function () { return null; });
      } catch (e) { return Promise.resolve(null); }
    }
  };

  // Expose the constant so callers can build CDN/avatar URLs consistently.
  window.MiviDiscord.PROXY_PREFIX = PROXY_PREFIX;

  debug('loaded; isActivity =', isActivity());
})();
