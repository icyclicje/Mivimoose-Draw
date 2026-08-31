# Brand assets & store copy

Everything Discord asks for when you set up the Activity, plus the copy to
paste into the portal.

## The mark

A moose with **palmate antlers** — broad blades with points along the top, the
way a moose's actually are — a narrow forehead, a heavy drooping muzzle, and a
pencil held crosswise in its mouth.

The version before this one had two vertical bars for antlers (which read as
rabbit ears), a round snout on a rounded box (which read as a hippo), and a
pencil tucked in the corner at a fifth of the mark's height. All three are
fixed: the antlers are unmistakably antlers, the muzzle has moose proportions,
and the pencil is a third of the width and the first thing you see after the
face.

It was chosen by rendering fifteen candidates at 128, 48, 24 and **16** pixels
and looking at them. Sixteen is the real test — the earlier mark's antlers
merged into a blob there.

## The files

Everything is rendered from one SVG string in `tools/make-logo.js`, through a
small dependency-free SVG rasteriser (`tools/svg-render.js`). The header mark,
the favicon and every PNG come from that same source, so they cannot drift
apart. Regenerate any time with:

```bash
node tools/make-logo.js     # the mark, SVG + PNG at 5 sizes
node tools/make-brand.js    # background art and the square cover
```

The background art is built from `tools/doodles.js` (the sort of thing people
actually draw in the game) and `tools/letters.js` (hand-built letterforms — a
font file would have been the project's first real dependency).

They land in `public/brand/`, which the server already serves — so with the
server running they're downloadable at `http://localhost:3000/brand/<file>`.

| File | Size | What it's for |
| --- | --- | --- |
| `mivimoose-logo.svg` | vector | Anywhere that takes vector — README, web, print |
| `mivimoose-mark.svg` | vector | The moose alone, no background tile |
| `mivimoose-icon-1024.png` | 1024² | **Discord app icon.** Square corners — Discord masks its own |
| `mivimoose-icon-512.png` | 512² | Same, smaller |
| `mivimoose-logo-1024.png` | 1024² | The mark with its own rounded corners |
| `mivimoose-logo-512.png` | 512² | " |
| `mivimoose-logo-256.png` | 256² | " |
| `mivimoose-logo-128.png` | 128² | " |
| `mivimoose-logo-64.png` | 64² | Favicon size |
| `mivimoose-cover-1024.png` | 1024² | **Activity shelf cover** — the mark on the background art |
| `mivimoose-cover-512.png` | 512² | Rich-presence large image |
| `mivimoose-background-1920x1080.png` | 16:9 | Splash / store hero — **DRAW!** over scattered doodles |
| `mivimoose-background-1280x720.png` | 16:9 | Smaller splash |

**Where each one goes in the Developer Portal**

- **General Information → App Icon** — `mivimoose-icon-1024.png`
- **Rich Presence → Art Assets** — upload `mivimoose-cover-512.png` (key it
  `mivimoose`; `lib/game.js` already sends that key with the presence payload)
- **App Directory → Cover / hero art** — `mivimoose-cover-1024.png` and
  `mivimoose-background-1920x1080.png`

Colours, if you need them elsewhere: `#6C5CE7` purple, `#FD79A8` pink,
`#00CEC9` teal, `#1B1D38` background.

---

## Copy for the portal

Three lengths, because Discord asks for different ones in different places.
Paste whichever fits and ignore the rest.

### Tagline (one line)

> One of you draws, everyone else yells guesses. Right in your voice channel.

### Short description (~190 characters)

> Draw something badly and watch your friends lose their minds guessing it.
> Runs straight in your voice channel — no links, no sign-up. Bring your own
> word lists or steal someone else's.

### Full description

> Someone gets a word. They get ninety seconds and a box of colours. Everyone
> else types guesses as fast as they can think of them, and whoever gets there
> first takes the most points.
>
> That's the whole game. It works because your friends cannot draw.
>
> **Start it from the channel you're already in.** Everyone who launches it
> lands in the same room — no invite links, no room codes, no "wait, say the
> code again". Your Discord name and picture come with you, and you can still
> break off into a private game whenever you want.
>
> **Play with your own words.** Write a list, paste one in, or drop a whole zip
> of them. There's a library other players have filled with theirs — search it,
> take what you like, leave something good behind.
>
> **Then make it strange.** A dozen switches change how a round works:
> - 🪞 **Mirror** — every line you draw lands flipped the other way
> - 🎨 **One colour** — the palette's gone; here's your one shade for the round
> - 🤝 **Relay** — two artists, one pen, swapping every few seconds
> - 🖌️ **Wet paint** — the page dries left to right, and once it's set you can't
>   touch it. No fixing that face later
> - 🪟 **Tile reveal** — guessers watch through twelve shutters that lift one at
>   a time, so you're guessing from half a wheel and a corner of an ear
> - ⚡ **Sudden death**, ✏️ **stroke limits**, word combinations, no clock at all…
>
> **Keep the good ones.** Every round you draw is saved to your gallery, and at
> the end you can take the whole game away as an animated GIF — every drawing,
> who guessed first, the final scores.
>
> 2 to 50 players. Free, no ads, no nagging you to sign up — an account just
> means your lists and drawings are still there next time.

### If you need it shorter still

> Draw badly, guess loudly. Custom word lists, a dozen ways to make a round
> weirder, and the whole game saves as a GIF. 2–50 players, in your voice
> channel.

---

## A note on the writing

The copy above is deliberately plain — short sentences, concrete detail, one
joke, no adjectives doing work that a fact could do. It matches the voice used
throughout the app itself ("One of you scribbles, everyone else yells guesses.
That's it, that's the game."). If you rewrite it, keep that: say what happens
rather than how it feels, and let the modes be the interesting part.
