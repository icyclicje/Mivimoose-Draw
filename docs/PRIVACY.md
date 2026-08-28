# Privacy Policy — Mivimoose Draw

**Last updated:** 28 August 2026

> **Before you publish this:** it describes what the software in this repository
> actually does, but it is a starting point, not legal advice. Fill in the
> bracketed placeholders, and if you run this for a real audience — especially
> one that may include children, or people in the EU/UK/California — have
> someone qualified read it over. If you modify the code, re-check that this
> still matches what your build collects.

This policy covers **[SERVICE NAME]** at **[YOUR URL]**, run by **[OPERATOR NAME]**
("we", "us"). Contact: **[CONTACT EMAIL]**.

## The short version

You can play without an account and we store nothing about you that outlives the
game. If you sign in with Discord, we keep your Discord user ID, display name and
avatar, plus the things you make in the game — word lists, saved drawings, stats
and your friends list. We do not sell any of it, we run no advertising, and there
are no third-party analytics or tracking pixels anywhere in the app.

## What we collect

**If you play as a guest**

- A random identifier generated in your own browser and kept in `localStorage`.
  It exists so that if your connection drops you get your seat and score back. It
  is not linked to you, and we never see any other identifier for you.
- Your chosen nickname and emoji avatar, held only for as long as you are in a
  room.

**If you sign in with Discord**

We ask Discord only for the `identify` scope (plus `guilds` and, where granted,
`rpc.activities.write` when running as a Discord Activity). From that we store:

- Your Discord user ID
- Your Discord display name
- The URL of your Discord avatar image

We do **not** receive or store your email address, your password, your Discord
friends, your messages, or the contents of any server you are in.

**Things you create in the game**

- Word lists you save, import or share to the public library
- Drawings you save to your gallery (stored as image files)
- Game statistics: games played, wins, points, words guessed, words drawn, likes
  received
- Your friends list and pending friend requests
- If a moderator takes action on your account, the fact of that action and any
  reason they recorded

**Things we deliberately do not keep**

- Chat messages and guesses. These pass through the server to the other players
  in your room and are never written to disk.
- Drawings from rounds you did not choose to save.
- IP addresses are not stored. They are held in memory only, briefly, for rate
  limiting, and are discarded automatically.

## Discord Activities

When the game is launched inside a Discord voice channel, Discord passes the app
an activity instance ID, channel ID and guild ID. We use the instance ID to put
everyone in that voice channel into the same game. These are kept in memory for
the life of the session and are never written to disk.

If the `rpc.activities.write` permission is granted, the game tells Discord what
round you are on so it can show it on your profile. That information goes to
Discord, not to us.

## Where it is stored and for how long

Everything is stored on the server that runs this game — a JSON file and a folder
of image files. There is no third-party database, analytics service, advertising
network or CDN involved in storing your data.

- Sign-in sessions expire after **90 days**.
- Everything else is kept until you delete it or ask us to delete your account.
- Lists you shared to the public library stay visible to everyone until you (or a
  moderator) take them down.

## What you can do

- **See it** — everything we hold about you is visible in the account panel.
- **Change it** — rename yourself, change your avatar, edit or export your lists.
- **Delete it** — delete individual lists and drawings from the account panel, or
  remove a shared list from the library. Signing out ends the session.
- **Delete everything** — email **[CONTACT EMAIL]** and we will remove your
  account and everything attached to it. [STATE YOUR TARGET, e.g. "within 30 days".]
- **Take it with you** — every word list can be exported as a `.txt`, and hosts
  can download a room's lists as a `.zip`.

Depending on where you live you may have further rights (access, correction,
erasure, portability, objection, or to complain to a data protection authority).
Use the contact address above.

## Children

Discord requires its users to be at least 13, or older where local law says so.
This game is not directed at children under that age and we do not knowingly keep
data from them. If you believe a child has given us data, contact us and we will
remove it.

## Public things

Anything you share to the list library is public: the list name, its words, and
the display name of the account that shared it. An automatic filter removes
profanity from shared lists, and moderators can remove lists or stop an account
from sharing. Do not put anything private in a shared list.

## Security

Sessions use random tokens rather than passwords — we never see or store a
password, because sign-in happens entirely through Discord. The server sets
standard protective headers and rate-limits its API. No system is perfectly
secure, and we cannot guarantee absolute security.

## Changes

If this policy changes we will update the date at the top. Significant changes
will be announced in the game.

## Contact

**[OPERATOR NAME]** — **[CONTACT EMAIL]**
