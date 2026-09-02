// ─────────────────────────────────────────────────────────────
// moderation.js — moderators for the shared list library.
//
// A mod can take down any shared list, ban an account from
// sharing, and hand the badge to someone else.
//
// Bootstrap: while NOBODY holds the badge, the account named
// "Silk" is treated as a mod so there is always someone who can
// start handing it out. The moment a real mod exists that rule
// switches off — so the very first thing a bootstrap mod should
// do is grant themselves the badge properly.
// ─────────────────────────────────────────────────────────────
const store = require('./store');
const config = require('./config');

const BOOTSTRAP_NAME = 'silk';

function anyMods() {
  return Object.values(store.db.users).some(u => u.mod === true);
}

// Who counts as the fallback moderator while nobody holds a granted badge.
//
// Historically this was "whoever is called Silk", which is fine on a laptop
// and dangerous on a public server: a username is something anyone can set,
// so an empty moderator list meant an open door. When MIVI_ADMIN_DISCORD_ID
// is configured the fallback binds to that Discord account instead — an id
// nobody else can claim. Without it, the old name rule still applies so
// existing installations keep working.
function isBootstrap(user) {
  if (!user || anyMods()) return false;
  if (config.adminDiscordId) return String(user.discordId || "") === config.adminDiscordId;
  return String(user.username || '').toLowerCase() === BOOTSTRAP_NAME;
}

function isMod(user) {
  if (!user) return false;
  return user.mod === true || isBootstrap(user);
}

function isBanned(user) {
  return !!(user && user.libBanned);
}

function grant(target) {
  if (!target) return false;
  target.mod = true;
  if (!target.modSince) target.modSince = Date.now();
  // The route that called this commits before it answers, so by the time
  // the moderator sees "granted" the badge is in the database.
  store.scheduleSave();
  return true;
}

function revoke(target) {
  if (!target) return false;
  delete target.mod;
  delete target.modSince;
  store.scheduleSave();
  return true;
}

// Ban an account from the shared library. Optionally pull everything
// they already shared.
function ban(target, { removeLists = true, reason = '' } = {}) {
  if (!target) return { removed: 0 };
  target.libBanned = true;
  target.libBanReason = String(reason || '').slice(0, 200);
  target.libBannedAt = Date.now();
  let removed = 0;
  if (removeLists) {
    for (const l of Object.values(store.db.library)) {
      if (l.ownerId === target.id) {
        delete store.db.library[l.id];
        removed++;
      }
    }
  }
  store.scheduleSave();
  return { removed };
}

function unban(target) {
  if (!target) return false;
  delete target.libBanned;
  delete target.libBanReason;
  delete target.libBannedAt;
  store.scheduleSave();
  return true;
}

// Compact view of an account for the mod panel.
function userRow(u) {
  const lists = Object.values(store.db.library).filter(l => l.ownerId === u.id).length;
  return {
    id: u.id,
    username: u.username,
    avatar: u.avatar,
    mod: u.mod === true,
    bootstrap: isBootstrap(u),
    banned: !!u.libBanned,
    banReason: u.libBanReason || '',
    sharedLists: lists,
    created: u.created,
  };
}

module.exports = { BOOTSTRAP_NAME, anyMods, isBootstrap, isMod, isBanned, grant, revoke, ban, unban, userRow };
