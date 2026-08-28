# Running Mivimoose Draw as a Discord Activity

An Activity is a web app Discord loads in an iframe, launched from a voice channel. Same game, same server — it just runs inside Discord instead of a browser tab, and everyone in the voice channel lands in the same room.

Nothing here replaces the normal website. One deployment serves both.

Everything below was checked against the current docs at <https://docs.discord.com/developers/activities/overview> (the old `discord.com/developers/docs/...` URLs now 301 to `docs.discord.com`). Where the docs contradict themselves or leave something out, it says so instead of pretending.

## What you need first

- **A Discord application.** The same one you made for sign-in in the README works fine — Activities are a setting on an existing app, not a separate thing.
- **A public HTTPS URL.** Discord loads your app through its own proxy, so for any test that resembles the real thing you need a real hostname with a certificate. Two routes, both covered below: deploy it (the README covers Railway), or run a tunnel.

  Strictly speaking localhost is not impossible — the docs say "It is possible to load your application via a localhost port or other unique URL. This URL must support an HTTPS connection to load on the web/desktop Discord app (HTTPS is not required for mobile)." But that path only exists via **Application URL Override**, which takes the proxy out of the picture entirely. See the note at the end of this section.
- **Developer Mode on your Discord account**, or an app that isn't published won't show up in the launcher. Desktop/web: **User Settings → App Settings → Advanced → Developer Mode**. Mobile: your profile → **Appearance → Developer Mode**.
- **A test server** you can join a voice channel in.

Activities run on Discord desktop, web and mobile. The proxy supports HTTP and WebSockets; WebRTC is not supported and WebTransport isn't enabled yet. Mivimoose Draw only needs HTTP and a WebSocket, so that's fine.

### Route A — deploy it

Follow **Deploying it (Railway)** in the README, then use that hostname (`yourgame.up.railway.app`) everywhere this guide asks for a target. This is the only sane option for anything other people will actually play.

### Route B — tunnel, for local development

Officially supported and officially documented — both Discord's "Building Your First Activity" tutorial and its Local Development guide tell you to do exactly this. Run the server, then:

```bash
npm start                                   # localhost:3000
cloudflared tunnel --url http://localhost:3000
```

Copy the `https://something-random.trycloudflare.com` URL it prints and use it as your URL mapping target. ngrok works the same way.

Your own server stays plain HTTP — the docs are explicit that "your web server can be HTTP and your network tunnel can upgrade the connection to HTTPS", so `npm start` needs no certificate of its own.

Three things a tunnel breaks, so know them going in:

- **The URL changes every time you restart the quick tunnel.** Each restart means editing the URL mapping in the Developer Portal, updating your OAuth2 redirect, and updating `BASE_URL`. A named tunnel on a domain you own avoids this.
- **You don't own the hostname.** Discord's docs warn about this directly: on a free tier someone else can end up with that name later and serve something malicious under a mapping you left in place. Clear the mapping when you're finished.
- **Latency.** Every draw packet takes a detour. It's usable, not representative.

There is also an **Application URL Override** setting, which points Discord straight at your local server. The docs never spell out where the control lives, and it is *not* in the Developer Portal: every mention of it points at the "Launching your Application from the Discord Client" instructions, so it belongs to the **Developer Activity Shelf inside the Discord client** (the same rocket-button shelf you launch from, with Developer Mode on). That is where to go looking. It is a worse test than a tunnel, because with the override on "your application's network traffic will not pass through Discord's proxy": `/.proxy/` paths don't exist, URL mappings are ignored, and the thing you're most likely to get wrong is exactly the thing you're no longer testing. Use it to check that the app boots, then switch to a tunnel. Leave it **off** for tunnel and production runs.

## 1. Enable Activities

In the [Developer Portal](https://discord.com/developers/applications), open your app.

1. Left sidebar → **Activities** → **Settings**.
2. Tick the first checkbox, **Enable Activities**.
3. On the same page, tick every platform you intend to test under **Supported Platforms**.

Step 3 is not optional and it is the single easiest thing to miss. The docs are blunt about it: "the activity will not be shown on the current platform (web/ios/android) unless you have checked your platform in Settings/Supported Platforms on the developer portal." If you only tick desktop and then go looking for the activity on your phone, it will not be there, and nothing will tell you why.

Enabling Activities automatically creates a default **Entry Point command** named **Launch** — that's what makes your app appear in the App Launcher. You don't have to register a command yourself, and you don't need a bot.

While you're in the portal, open **Installation** and make sure the app is actually installed somewhere you can test: under **Installation Contexts**, both **User Install** and **Guild Install** should be ticked, then use the install link to add it to your test server.

## 2. URL Mappings — the part everyone gets wrong

**Activities → URL Mappings.**

Activities are sandboxed. Your app is not served from your domain — it's served from `https://<your-client-id>.discordsays.com`, and every request it makes is routed through Discord's proxy. A URL mapping tells the proxy which real host a path prefix belongs to.

### The root mapping

| PREFIX | TARGET |
| ------ | ------ |
| `/` | `yourgame.up.railway.app` |

That's it for basic operation. Rules for the target field:

- **No protocol.** `yourgame.up.railway.app`, not `https://yourgame.up.railway.app`.
- **Directories, not files.** Point at a path prefix, never at `/index.html`.
- **`{token}` matching is allowed** for dynamic subdomains, but the token has to appear on *both* sides. Discord's example is PREFIX `/google/{subdomain}` → TARGET `{subdomain}.google.com`; a token in the target alone matches nothing.
- **Order matters.** If two prefixes share an initial path, the shortest goes last. Your `/` mapping is the shortest possible prefix, so it always sits at the bottom of the list.

### `/.proxy/`

Inside the iframe, requests go through the proxy path — `/.proxy/api/rooms`, `/.proxy/socket.io/`. The proxy maps that back onto your root mapping and forwards to your server, which sees a normal `/api/rooms`.

The prefix used to be mandatory and is now optional. This is settled, not folklore — Discord's change log entry of **30 July 2025, "Remove .proxy/ from Discord Activity proxy path"**, says the CSP "now allows requests to `https://<app_id>.discordsays.com/*` instead of the more restrictive `https://<app_id>.discordsays.com/.proxy/*`", that "both URL patterns work identically", that there is no performance difference between them, and that "the `/.proxy/` path prefix is still fully supported and will be maintained indefinitely". The older "Activities Proxy CSP Update" entry now carries a notice saying it is outdated for exactly this reason.

That is why the current docs read the way they do: the Local Development page maps `/api` and then just requests `/api`, while the How Activities Work page and the Embedded App SDK README still show `fetch('/.proxy/api/token')`. Both are correct. Neither is stale.

This project sends the `/.proxy/` form, because it is valid under both the old and the new CSP and Discord has committed to keeping it indefinitely. Dropping it would gain nothing — same behaviour, same speed — so there is no reason to "clean it up", and no reason to panic if you see bare paths in Discord's own samples.

What actually matters — and this part has not changed — is that requests are **relative**. A relative path resolves against `https://<client-id>.discordsays.com`, which — bar the handful of exempt Discord hosts listed at the end of this step — is the only origin the sandbox CSP allows, and the mapping table decides where it goes from there. An absolute `https://yourgame.up.railway.app/api/rooms` is blocked no matter what your mappings say, because the mappings never get a chance to see it.

Two consequences worth spelling out:

- **REST calls** go out as `/.proxy/api/...`. `/api/...` would also work today; what breaks is hardcoding your own hostname.
- **Socket.io** must be told about the prefix too — the client connects with a `path` of `/.proxy/socket.io` rather than the default `/socket.io`. The WebSocket itself is fine; the proxy supports WebSockets. It's the handshake path that trips people up.

### Extra mappings for third-party hosts

Anything not on your own host needs its own mapping, otherwise the proxy blocks it. A mapping for a third-party host looks like this, with `/` kept last per the ordering rule:

| PREFIX | TARGET |
| ------ | ------ |
| `/fonts/css` | `fonts.googleapis.com` |
| `/` | `yourgame.up.railway.app` |

**Read the next paragraph before you add that one, though, because on its own it does nothing.**

A mapping only rewrites requests that are already aimed at the sandbox origin. `index.html` in this project links its two display fonts the ordinary way:

```html
<link href="https://fonts.googleapis.com/css2?family=Fredoka..." rel="stylesheet" />
```

That is an absolute URL to another host, so the sandbox CSP blocks it outright and the mapping table is never consulted. Adding `/fonts/css` → `fonts.googleapis.com` changes nothing until the `<link>` is also rewritten to the relative `/fonts/css/css2?family=...`. And even then you are not finished: the stylesheet Google returns points at `https://fonts.gstatic.com/...` in its own `src: url(...)` rules, absolutely, so the font *files* get blocked at the next hop and a `/fonts/file` mapping never sees them either.

**So, as the project stands: inside Discord the webfonts do not load, and the game falls back to system fonts.** Nothing else is affected — it looks slightly less Mivimoose and plays identically. If you care, the fix is to self-host the two families out of `public/` rather than to add mappings; that works in the browser and in the Activity, with no mappings at all.

The general lesson: mappings fix *relative* requests. For a third-party library that hardcodes absolute URLs, the Embedded App SDK's `patchUrlMappings` rewrites them at runtime instead — it patches global `fetch`, `WebSocket` and `XMLHttpRequest.prototype.open`, so expect side effects. This project has no bundler and doesn't ship the SDK, so that tool isn't available here anyway.

Some Discord hosts are exempt from the CSP and need no mapping at all. The documented list is `https://discord.com/api/` (plus the `canary.` and `ptb.` variants), and `attachments/`, `avatars/` and `icons/` under both `https://cdn.discordapp.com/` and `https://media.discordapp.net/`. The avatar exemption is the one that matters here — player avatars come straight from `cdn.discordapp.com/avatars/` and need nothing configured.

## 3. OAuth2

**OAuth2** in the left sidebar. You already did most of this if you followed the sign-in section of the README.

- **Client ID** and **Client Secret** — same pair the server already uses (`DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET`).
- **Redirects** — keep your existing `<BASE_URL>/api/auth/discord/callback` for website sign-in. An Activity doesn't use a browser redirect; it authorizes over the RPC channel. The portal still insists on at least one entry, and Discord's own tutorial uses `https://127.0.0.1` as the placeholder.

Scopes are **requested in code**, not configured in the portal — there is no scope checklist to tick for an Activity, and the portal's OAuth2 URL Generator is for bot and website installs. The list lives in the `authorize()` call in `public/js/app.js`.

| Scope | Why | Requested today? |
| ----- | --- | ---------------- |
| `identify` | who the player is — name, avatar, id | yes |
| `guilds` | the server the activity was launched in | yes |
| `applications.commands` | what Discord's own tutorial requests alongside the Entry Point flow | no |
| `rpc.activities.write` | required for custom rich presence — without it `setActivity` has nothing to write | no |

The right-hand column is the honest one: the client currently asks for `identify` and `guilds` only. That is enough for sign-in and for rooms. It is **not** enough for the custom rich presence described in step 6 — the docs are explicit that "to display custom Rich Presence data for a user, your app will need to be authorized with the `rpc.activities.write` scope for that user", so until that scope is added to the `authorize()` call, expect Discord's default presence (your app's name and icon on the profile) rather than the round and word progress. Add the scope there if you want the richer version.

Nothing in the docs suggests any of these need Discord's approval.

## 4. Point the server at it

Same environment variables as a normal deployment:

```
DISCORD_CLIENT_ID=...
DISCORD_CLIENT_SECRET=...
BASE_URL=https://yourgame.up.railway.app
```

Activity support switches itself on as soon as both Discord credentials are present — there is no separate "on" switch. `MIVI_ACTIVITY=0` (or `"activity": false` in `config.json`) turns it back off if you ever want the server to behave as a plain website only.

## 5. Launch it

**Desktop and web.** Join a voice channel, then hit the rocket button — from either the RTC panel or the centre control tray — to open the Activity shelf, and pick your app. The App Launcher works too, in any voice *or* text channel; if you don't see the app there, search for it by name. With Developer Mode on, what you get is the **Developer Activity Shelf**, which lists every activity owned by you or by a team you're on.

**Mobile.** Join a voice channel, tap the activity in the shelf. Developer Mode has to be on there too, and mobile has to be ticked under Supported Platforms.

There's no "preview" button in the Developer Portal — the portal configures the app, Discord runs it. The nearest thing to a portal-side test path is the Application URL Override described above, with the caveat that it skips the proxy.

**Logs.** On desktop, open devtools in the client (**View → Developer → Toggle Developer Tools**, easiest in the PTB build) and read the console as usual.

Mobile is the catch. Discord's documented route there is **User Settings → Appearance → DEV ONLY → Debug Logs**, searching for `RpcApplicationLogger` or your application ID — but that only shows app logs because the Embedded App SDK overrides `console.log/warn/error/info/debug` and forwards them over RPC. This game talks to Discord directly instead of using the SDK, and deliberately does not install that override, so **your `console.log` calls will not appear in mobile Debug Logs.** Debug on desktop, or send something explicitly over the `CAPTURE_LOG` command if you need mobile visibility.

## 6. What this project already handles

Don't re-implement any of this:

- **CSP.** The server relaxes its `frame-ancestors` policy for Discord automatically once Discord credentials are configured, so the iframe is allowed to load. `MIVI_ACTIVITY=0` switches that back off.
- **Proxy routing.** The client detects that it's running as an Activity and routes both its REST calls and its Socket.io connection through `/.proxy`. You don't set a flag.
- **Sign-in.** Players are signed in with their Discord account automatically. No sign-in screen, no OAuth popup, no guest prompt.
- **Rooms.** **Everyone who launches the activity from the same voice channel lands in the same game room automatically**, keyed off the activity instance id. No room codes, no invite links, no "what's the code again".
- **Rich presence.** The client pushes the round and word progress to your profile with `SET_ACTIVITY` (throttled client-side to one update every five seconds). One caveat, per step 3: custom presence needs the `rpc.activities.write` scope, which the `authorize()` call does not currently request — so until it does, expect Discord's default presence instead.
- **Invites and downloads.** There are buttons that open Discord's own invite dialog, and downloads (drawings, GIFs, word lists) go out through Discord's external-link handler instead of dying silently in the sandbox.

## 7. Troubleshooting

| Symptom | Cause | Fix |
| ------- | ----- | --- |
| Blank or black iframe, nothing loads | The page is refusing to be framed, or the root mapping is wrong | Confirm `DISCORD_CLIENT_ID`/`DISCORD_CLIENT_SECRET` are set and `MIVI_ACTIVITY` isn't `0` — that's what relaxes `frame-ancestors` and drops `X-Frame-Options`. Then check the `/` mapping target: no protocol, no trailing slash, no path. |
| App loads, then everything 404s | Requests aren't reaching your server through the mapping | Check they're relative (`/.proxy/api/...` or `/api/...`, either is fine) and not absolute to your own hostname — an absolute URL is CSP-blocked before mappings apply. Then check the `/` mapping target resolves publicly. |
| Requests blocked with `blocked:csp` in the console | Absolute URL to a host outside the sandbox | Same cause as above, seen from the other end. Make the request relative and add a mapping for the host, or self-host the asset. |
| Stuck on connecting; no game state | Socket.io handshake going to the wrong path | The client must connect with `path: '/.proxy/socket.io'`. Check the network tab for a 404 on `/socket.io/?EIO=4`. Polling and WebSocket both go through the proxy — WebSockets are supported, WebRTC is not. |
| OAuth "invalid redirect" / "redirect_uri mismatch" | Redirect list doesn't match | Add both `<BASE_URL>/api/auth/discord/callback` (website) and the `https://127.0.0.1` placeholder (activity) under **OAuth2 → Redirects**, and make sure `BASE_URL` matches your real host exactly, no trailing slash. |
| Fonts look wrong / requests to fonts.googleapis.com blocked | `index.html` links Google Fonts by absolute URL, which the sandbox blocks | Expected, not a misconfiguration — see step 2. A mapping alone won't fix it. Ignore it (system fonts are a fine fallback) or self-host the two families under `public/`. |
| Works in a browser, fails in Discord | Something is bypassing the proxy | Check for absolute URLs to your own host, hardcoded `https://` links, or a third-party asset with no mapping. Also confirm **Application URL Override** is off — with it on you're not testing the proxy at all. |
| App doesn't appear in the launcher | Platform not ticked, not installed, or Developer Mode off | In order of how often it's the culprit: tick your platform under **Activities → Settings → Supported Platforms** (the activity is hidden on any platform you haven't checked); turn on Developer Mode; install the app to the test server (**Installation → Installation Contexts**, both boxes); confirm **Enable Activities** is ticked, since the "Launch" entry point command only exists once it is. |
| Stale JavaScript after a deploy | Your own cache headers | Not the proxy's doing: it strips cache headers only for `text/html`, so `index.html` is always fresh while your JS and CSS are cached exactly as your `Cache-Control` tells the browser to cache them. Ship changed filenames or shorten the header — Discord lists cache busting as a production-readiness item for this reason. |
| Tunnel worked yesterday, dead today | Quick tunnel URL rotated | Restart `cloudflared`, then update the URL mapping and `BASE_URL` to the new hostname. |
