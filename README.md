# 🦌 Mivimoose Draw

A multiplayer drawing & guessing game. One of you scribbles, everyone else yells guesses. Node.js + Socket.io, no build step, no native dependencies.

## Running it

```bash
npm install
npm start          # → http://localhost:3000
```

Dev auto-reload: `npm run dev`. End-to-end smoke test (285 checks, runs against its own temp data dir): `npm run smoke`.

Player data (accounts, lists, gallery PNGs, the shared library, friends) lives in `data/` — delete the folder to reset everything.

## Sign-in with Discord (2-minute setup)

Discord is the only way to sign in — no passwords anywhere. Guests can play everything; an account is what keeps your lists, drawings, stats and friends around, and it's required for sharing to the list library. Until you connect a Discord app the sign-in button explains that it's off.

1. Go to https://discord.com/developers/applications → **New Application** → give it a name.
2. Open **OAuth2** in the left menu. Copy the **Client ID**, then hit **Reset Secret** and copy the **Client Secret**.
3. Under **Redirects**, add exactly: `http://localhost:3000/api/auth/discord/callback` (swap in your real address/port if you host it somewhere else) and save.
4. In the project folder copy `config.example.json` to `config.json` and paste the two values in. Set `baseUrl` to wherever players reach the server (it must match the redirect above).
5. Restart the server. Done.

Environment variables work too and win over the file: `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `BASE_URL`.

> **Getting "Invalid OAuth2 redirect_uri"?** That means step 3 hasn't taken. The
> server prints the exact URL to register when it starts:
>
> ```
> 🔑 Discord redirect URI (must be registered verbatim):
>    http://localhost:3000/api/auth/discord/callback
> ```
>
> Copy that line's URL into **OAuth2 → Redirects** and press **Save Changes**.
> **[docs/DISCORD_LOGIN.md](docs/DISCORD_LOGIN.md)** covers every way the two
> strings drift apart — trailing slashes, `127.0.0.1` vs `localhost`, a changed
> port, the wrong application — and how to check what the server really sends.

## Brand assets

Logo (SVG + PNG), Discord app icon, activity cover and background art live in
`public/brand/`, and the copy for the Discord portal is in
**[docs/BRAND.md](docs/BRAND.md)**. Regenerate the artwork any time — it is
rendered from the logo geometry itself, with no dependencies:

```bash
node tools/make-logo.js
node tools/make-brand.js
```

## Run it as a Discord Activity

The game can run **inside Discord**, launched from a voice channel, as well as in a browser. Full step-by-step setup is in **[docs/DISCORD_ACTIVITY.md](docs/DISCORD_ACTIVITY.md)** — the short version is: deploy it somewhere with HTTPS, enable Activities on your Discord app, and add one URL mapping pointing at your host.

The code side is already done for you. Once Discord credentials are configured, the server switches Activity support on by itself (`MIVI_ACTIVITY=0` turns it back off) and:

- **Everyone in the same voice channel lands in the same game.** The activity instance id becomes the room, so there are no codes to share.
- **Players are signed in as their Discord account automatically** — no sign-in screen, and their lists, gallery, stats and friends are all there.
- **Requests route through Discord's proxy** (`/.proxy`) automatically, for both the REST API and the websocket.
- **Rich presence** shows what round you're on and whether you're drawing or guessing.
- **Invite** hands off to Discord's own invite dialog instead of copying a link.
- The strict anti-framing headers relax to allow Discord's iframe **only** while Activity support is on; with it off, framing is refused as before.

It stays a completely normal website at the same time — none of the above changes anything when you open it in a browser.

## Privacy policy and terms

Template documents live in [docs/PRIVACY.md](docs/PRIVACY.md) and
[docs/TERMS.md](docs/TERMS.md). They describe what this software actually stores,
but they have bracketed placeholders (operator name, contact address,
jurisdiction) you must fill in, and they are **not legal advice** — get them
reviewed before relying on them.

The markdown files are the source of truth; the server renders them into the
site's own styling and serves them at **`/privacy`** and **`/terms`** (edit the
`.md`, reload the page — no build step). They're deliberately unobtrusive: a
small line at the bottom of the home screen opens them in-app, and nothing else
links to them.

Discord's Developer Portal asks for a Terms of Service URL and a Privacy Policy
URL under **General Information** — point those at
`https://yourgame.example/terms` and `https://yourgame.example/privacy`.

## Deploying it (Railway)

Railpack builds this straight from `package.json` — no config files needed — but **`package.json` has to sit at the repo root**. If you ever see *"Railpack could not determine how to build the app"* and the contents it analyzed are just a folder name, that's a nested directory: either move the project up a level, or set the service's **Root Directory** to that subfolder.

Three things to set on the Railway service:

1. **Attach a volume, or your data will vanish.** Accounts, word lists, saved drawings, the shared library and friends all live on disk under `data/`, and Railway's filesystem resets on every redeploy. Add a volume, then point `MIVI_DATA_DIR` at its mount path (e.g. `/data`).
2. **`BASE_URL`** — your public URL, no trailing slash (e.g. `https://yourgame.up.railway.app`). Discord sign-in builds its redirect from this.
3. **`DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET`** as service variables — `config.json` is gitignored, so it never ships. Then add `https://yourgame.up.railway.app/api/auth/discord/callback` to the redirects on your Discord app.

`PORT` is injected by Railway and the server already honours it. Without the Discord variables the game still runs fine — sign-in just stays switched off and everyone plays as a guest.

## What's in it

- **Play online** — drops you straight into a public game that's already going (or starts one if nobody's playing). Classic word list, rounds auto-start.
- **Private rooms** — 4-letter codes, invite links (`/?join=CODE`), public listing toggle, kick, host migration.
- **Friends** — usernames are unique, so you add people by name (the old 6-character code still works if someone has one saved). Or hit ＋ next to anyone you're playing with. Friends show online status and can be invited straight into your room — they get a pop-up with a Join button.
- **Word lists** — ships with the 1,300+ word Classic list; drop more `.txt` files into `words/` if you want. Hosts can add lists on the fly, attach lists saved on their account, weight lists 1–10, and check **ℹ️ Odds** to see the exact chance of each list showing up.
- **List library** — share a list with everyone, or drop in a whole **folder** of `.txt` files and each one becomes its own list. Browse what others shared, download as `.txt`, save to your account, or pull one straight into the room you're hosting. Rename or take down your own uploads any time. Sharing needs an account, and swear protection runs on every upload.
- **Room lists** — anything you add to a room can be renamed or removed on the spot; removing the last one falls back to Classic rather than leaving the room with nothing to draw. The host can also grab **every list in the room as a single .zip** ("Download all"), with the ones currently in play first and unused ones prefixed so you can tell them apart.
- **Scene backdrops** — switch this on as host and whoever's drawing gets a 🖼️ button with 22 ready-made scenes to draw over: city, city at night, beach, forest, mountains, space, desert, underwater, farm, open road, snow, sunset, rain, castle, race track, football pitch, classroom, kitchen, stage, meadow, clouds and a lined page. They're drawn in code (nothing to download), identical for everyone, and the eraser restores the scene rather than smearing over it.
- **Save the game as a GIF** — at the final scoreboard, one button turns every drawing from that game into an animated GIF, each frame captioned with the word, the artist and the Mivimoose mark. Encoded right in the browser.
- **Accounts** — pick your display name, unlimited saved lists (import/export), a gallery of your drawings (auto-save optional), stats, friends.
- **Host controls, mid-game** — the 🎛️ button opens the full settings while a game is running: rounds, clock, hints, word lists, everything. Most of it lands on the next round; shortening the clock trims the current one, and cutting the round count to where you already are ends the game. 🏁 **End game** jumps straight to the final scoreboard.
- **Moderators** — mods can take down any shared list, ban an account from sharing (which also pulls what it already shared), and hand the badge to someone else. While *nobody* holds the badge, the account named **Silk** has it by default; the first time that account actually uses the powers the badge sticks properly and the fallback switches off.
- **Avoid repeats** (on by default) — words that were drawn, or even offered as a choice, stay out of the rotation for the room until the host changes lists. Tiny lists never get stuck: when the list runs dry, previously offered words come back first, then drawn ones. The lobby shows how much of the pool is still unused.
- **Works on phones** — canvas-first layout, a scrolling player strip, chunky touch tools, bottom-sheet modals, and no accidental zoom or long-press menus while drawing.
- **Game settings** — every setting has a **?** that explains it. Defaults: 10 rounds, 90s draw time, 5 word choices, 5 hints, 10 players, Easy autocorrect. Modes: combinations (two words at once, with optional lock-in of guessed halves), co-op drawing, hidden mode, text tool (artists can type on the canvas — but not the answer), spam protection.
- **Autocorrect** — four levels. Off is exact spelling only. Easy forgives one typo on longer words and plurals. Normal allows a typo on most words and two on long ones. Generous accepts pretty much anything close. Swapped letters count as one typo, accents and punctuation are ignored, and on the stricter levels short words still have to start with the right letter.
- **Quality of life** — a Leave button, host migration (with a 👑 next to whoever's host), reconnect keeps your seat and score, vote-to-skip, ❤️ likes, avatar picker, fullscreen focus mode (`F`), tool hotkeys, chat status pills, smoothed brush strokes, an anti-alias-aware paint bucket, a canvas that sizes itself to your screen, synthesized sound effects and background music, and eight colour themes — Midnight, Ocean, Forest, Sunset, Noir, Daylight, Candy and Parchment. Dark is the default; the 🌙 button in the header cycles through them (or pick one directly in Settings).
- **Moderation & safety** — per-room spam protection (always on in public games), socket flood limits, per-IP rate limits on the API, security headers/CSP, XSS-safe rendering, the answer is never sent to players who haven't guessed.
- **Performance** — gzip on everything, cached static assets, pointer-event coalescing for smooth strokes, and freehand drawing batched into ~30 packets a second instead of one per mouse move.

## How scoring works

Guessers get 250–500 points depending on how much time is left, minus a little for each person who beat them to it. The artist gets paid once, at the end of the round, in proportion to how many people guessed — up to 350, plus 50 if everyone got it.

After each correct guess the cock gets capped based on how many guessers are still working: in a 4-guesser 90s round the first correct guess caps it at 49s, then 35s, then 22s, and the last person always keeps at least 12 seconds.

## Project layout

```
server.js            entry — express + socket.io + security headers + gzip
lib/
  game.js            rooms, matchmaking, game loop, spam protection, presence
  similarity.js      the autocorrect engine
  friends.js         friends list, requests, lookup by username
  words.js           word lists + weighted picking
  api.js             REST: Discord auth, lists, gallery, library, friends, rooms
  auth.js            account records & session tokens
  config.js          config.json / env loading
  store.js           JSON persistence + drawing files
public/
  index.html         the app
  css/style.css      styling
  js/app.js          game client
  js/account.js      sign-in, account panel, friends
  js/api.js          REST client + identity
  js/audio.js        synthesized SFX + generative music
  js/profanity.js    shared swear filter (server uses it too)
words/classic.txt    the built-in list (add more .txt files here)
legacy/              the pre-2.0 client and the old word lists
test/smoke.js        end-to-end smoke test
```
