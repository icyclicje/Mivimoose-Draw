// ─────────────────────────────────────────────────────────────
// friends.js — friend codes, requests and the friends list.
// Pure data logic over store.db.users; presence lives in game.js.
// ─────────────────────────────────────────────────────────────
const store = require('./store');

const MAX_FRIENDS = 200;

function ensureFields(user) {
  if (!Array.isArray(user.friends)) user.friends = [];
  if (!Array.isArray(user.requestsIn)) user.requestsIn = [];
  if (!Array.isArray(user.requestsOut)) user.requestsOut = [];
  return user;
}

// Short shareable code derived from the account id.
function friendCode(user) {
  return user.id.slice(0, 6).toUpperCase();
}

function findByCode(code) {
  const c = String(code || '').trim().toLowerCase();
  if (!/^[a-f0-9]{6}$/.test(c)) return null;
  return Object.values(store.db.users).find(u => u.id.startsWith(c)) || null;
}

function userById(id) {
  return (typeof id === 'string' && Object.prototype.hasOwnProperty.call(store.db.users, id))
    ? store.db.users[id] : null;
}

function areFriends(a, b) {
  return ensureFields(a).friends.includes(b.id);
}

// Send a request from `from` to `to`. If `to` already asked `from`, the
// two become friends straight away. Returns { ok, message, accepted }.
function sendRequest(from, to) {
  ensureFields(from); ensureFields(to);
  if (from.id === to.id) return { ok: false, message: "That's you." };
  if (areFriends(from, to)) return { ok: false, message: `You and ${to.username} are already friends.` };
  if (from.friends.length >= MAX_FRIENDS) return { ok: false, message: 'Your friends list is full.' };
  if (from.requestsIn.includes(to.id)) {
    // They asked first — accept.
    accept(from, to);
    return { ok: true, accepted: true, message: `You and ${to.username} are friends now!` };
  }
  if (from.requestsOut.includes(to.id)) return { ok: true, message: `Already asked ${to.username} — waiting on them.` };
  from.requestsOut.push(to.id);
  to.requestsIn.push(from.id);
  store.scheduleSave();
  return { ok: true, message: `Friend request sent to ${to.username}.` };
}

function accept(user, other) {
  ensureFields(user); ensureFields(other);
  if (!user.requestsIn.includes(other.id)) return false;
  user.requestsIn = user.requestsIn.filter(id => id !== other.id);
  other.requestsOut = other.requestsOut.filter(id => id !== user.id);
  if (!user.friends.includes(other.id)) user.friends.push(other.id);
  if (!other.friends.includes(user.id)) other.friends.push(user.id);
  store.scheduleSave();
  return true;
}

function decline(user, other) {
  ensureFields(user); ensureFields(other);
  user.requestsIn = user.requestsIn.filter(id => id !== other.id);
  other.requestsOut = other.requestsOut.filter(id => id !== user.id);
  store.scheduleSave();
}

function remove(user, other) {
  ensureFields(user); ensureFields(other);
  user.friends = user.friends.filter(id => id !== other.id);
  other.friends = other.friends.filter(id => id !== user.id);
  store.scheduleSave();
}

function brief(u) {
  return { id: u.id, username: u.username, avatar: u.avatar, code: friendCode(u) };
}

module.exports = { ensureFields, friendCode, findByCode, userById, areFriends, sendRequest, accept, decline, remove, brief };
