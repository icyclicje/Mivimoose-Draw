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

const BOOTSTRAP_NAME = 'silk';

function anyMods() {
  return Object.values(store.db.users).some(u => u.mod === true);
}

function isBootstrap(user) {
  return !!user && String(user.username || '').toLowerCase() === BOOTSTRAP_NAME && !anyMods();
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
  store.scheduleSave();
  store.saveNow();          // a badge must survive an abrupt shutdown
  return true;
}

function revoke(target) {
  if (!target) return false;
  delete target.mod;
  delete target.modSince;
  store.scheduleSave();
  store.saveNow();
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
