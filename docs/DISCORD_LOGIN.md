# Discord sign-in — setup and the redirect_uri error

Mivimoose Draw uses Discord as its only sign-in method. There are no passwords
anywhere. Guests can play everything; an account is what keeps your word lists,
drawings, stats and friends, and it's required to share to the list library.

---

## Setup

### 1. Make a Discord application

Go to <https://discord.com/developers/applications> → **New Application** →
name it (this name is what players see on the consent screen).

### 2. Copy the credentials

Open **OAuth2** in the left menu.

- **Client ID** — copy it.
- **Client Secret** — press **Reset Secret**, then copy it.

Treat the secret like a password. If it ever ends up in a screenshot, a chat
message, a commit or a support ticket, reset it — resetting is free and takes
two seconds.

### 3. Register the redirect URL — this is the step people miss

Still on the **OAuth2** page, find **Redirects** → **Add Redirect**, and paste
the callback URL **exactly**:

```
http://localhost:3000/api/auth/discord/callback
```

Then press **Save Changes** at the bottom of the page. The save bar is easy to
miss and nothing is registered until you press it.

> **The server prints the exact string you need.** Start it and look for:
>
> ```
> 🔑 Discord redirect URI (must be registered verbatim):
>    http://localhost:3000/api/auth/discord/callback
> ```
>
> Copy that line's URL straight into Discord. Don't retype it.

### 4. Give the server the credentials

Copy `config.example.json` to `config.json` and fill it in:

```json
{
  "discordClientId": "your client id",
  "discordClientSecret": "your client secret",
  "baseUrl": "http://localhost:3000"
}
```

`config.json` is gitignored, so it never gets committed.

Environment variables work too and take priority over the file:
`DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `BASE_URL`.

### 5. Restart the server

Sign-in is live. Until a Discord app is connected, the sign-in button says so
rather than failing silently.

---

## "Invalid OAuth2 redirect_uri"

Discord shows this when the `redirect_uri` the server sent is **not** in that
application's **Redirects** list. It is always a mismatch between two strings —
the one the server sends and the one Discord has on file.

**Fix it in two steps:**

1. Start the server and copy the URL it prints under
   `🔑 Discord redirect URI (must be registered verbatim)`.
2. Paste that into **OAuth2 → Redirects** on the *same* Discord application
   whose client ID you configured, and press **Save Changes**.

### The mismatches that actually happen

The comparison is byte-for-byte. All of these are different URLs to Discord:

| You registered | Server sends | Why it fails |
| --- | --- | --- |
| `http://localhost:3000/api/auth/discord/callback/` | `…/callback` | trailing slash |
| `https://localhost:3000/…` | `http://localhost:3000/…` | `https` vs `http` |
| `http://127.0.0.1:3000/…` | `http://localhost:3000/…` | not the same host |
| `http://localhost:3000/auth/discord/callback` | `…/api/auth/…` | missing `/api` |
| `http://localhost:8080/…` | `http://localhost:3000/…` | `PORT` changed |
| *(registered on a second app)* | — | wrong application |

A few more worth knowing:

- **`baseUrl` with a trailing slash.** The server trims these now, so
  `http://localhost:3000/` and `http://localhost:3000///` both produce the
  correct URI. Older builds would silently generate `…3000//api/…`.
- **You changed `PORT` or `BASE_URL`.** The redirect is derived from
  `baseUrl`, so changing either changes the URI. Register the new one.
- **You edited `config.json` but didn't restart.** Config is read once at
  startup.
- **Two applications open in two browser tabs.** Check the Client ID on the
  page you're editing matches the one in your config.

### Deploying

Production has a different `baseUrl`, so it needs its own redirect entry:

```
https://your-host.example.com/api/auth/discord/callback
```

Discord accepts several redirects on one application, so keep the localhost
entry alongside it and both environments work. Add the production one *before*
your first deploy, not after someone reports a broken login.

### Checking what the server actually sends

If you want to see it rather than trust it:

```bash
curl -si http://localhost:3000/api/auth/discord | grep -i '^location:'
```

The `redirect_uri=` parameter in that URL (percent-encoded) is the exact string
Discord is comparing against. Decode it and it must equal a registered redirect
character for character.

---

## Inside a Discord Activity

Activities **do not use a redirect URI at all**. The iframe can't navigate to
`discord.com`, so sign-in goes through the SDK's `authorize()` command instead
and the whole redirect flow is skipped.

So: this error can only come from the browser sign-in path. If you hit it while
playing inside Discord, something has fallen through to the website flow —
see [DISCORD_ACTIVITY.md](DISCORD_ACTIVITY.md), and set
`window.MIVI_DISCORD_DEBUG = true` in the console to trace what the SDK shim is
doing.
