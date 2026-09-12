# lyric-gloss

[![tests](https://github.com/kiddersmxj/lyric-gloss/actions/workflows/ci.yml/badge.svg)](https://github.com/kiddersmxj/lyric-gloss/actions/workflows/ci.yml)

Machine-translated lyrics rendered under the original line, in smaller text,
inside Spotify's own lyrics view.

```
        Y nos dieron las diez y las once
        And they gave us ten and eleven

        Las doce y la una y las dos y las tres
        Twelve and one and two and three
```

Every song, every language, live — not just the small minority of tracks that
happen to have a human-contributed translation.

## Why it exists

Spotify's own translation covers a handful of tracks. So does lyrics-plus's
Musixmatch source, because both depend on someone having sat down and typed a
translation out. `lyrics-plus` already knows how to *draw* a translation under
each line — it just has no general translation source. This adds one, so
coverage becomes "any song lyrics-plus can find lyrics for" (LRCLIB,
Musixmatch, Netease, Genius, and local files, combined).

It is a patch against [spicetify](https://github.com/spicetify/cli)'s bundled
`lyrics-plus` custom app, plus one small extension. There is no separate
window, no browser tab and no overlay: the text appears in Spotify's own
lyrics page, where you already look for it.

## Status

Everything below is working and in daily use.

| Piece | State |
|---|---|
| Translation provider | any source language, 12 target languages |
| Below-original styling | 0.55em, dimmed, active line brighter |
| Same-language skip | detected on the first request, cached, one request per track |
| Cache | 30 days, per track + target, in `localStorage` |
| Rate limiting | circuit breaker, 2m → 2h backoff, persisted across restarts |
| Playbar button | Spotify's own lyrics button opens this page |
| Scroll | follows the active line, snaps to top on track change, follows scrubs |
| Re-apply after upgrades | automatic on Arch via a pacman hook; `install.sh` is re-runnable and refuses on upstream drift |
| Translation quality | adequate for prose, literal on slang — see [Limits](#limits) |

## Requirements

| | |
|---|---|
| OS | Linux. Tested on Arch with the native `spotify` package. |
| Spotify | The desktop client, installed at `/opt/spotify` (override with `SPOTIFY_DIR`). Flatpak and Snap are untested. |
| [spicetify](https://spicetify.app) | **2.45.0 or newer**, at `~/.spicetify` (override with `SPICETIFY_HOME`). `install.sh` upgrades it if it is older. |
| Also | `python3`, `bash`, and `sudo` — see below for exactly what the sudo is for. |

**Spotify and spicetify are not installed for you.** `install.sh` checks for
both and stops with instructions if either is missing. It will, however,
`spicetify upgrade` an existing spicetify that is older than 2.45.0 — an older
one throws inside the lyrics route and can take the client down with it.

## Install

```sh
git clone https://github.com/kiddersmxj/lyric-gloss
cd lyric-gloss
./install.sh
```

Then restart Spotify. That's it — there is nothing to configure.

The playbar lyrics button now opens this page. Spotify's own lyrics panel and
the redundant sidebar entry are hidden, so there is one control, where you'd
expect it.

### What it does to your machine

Worth knowing before you run a script that asks for your password:

- Patches `~/.spicetify/CustomApps/lyrics-plus` — reversibly, and verified
  byte-for-byte by the test suite.
- Installs a theme (`~/.spicetify/Themes/lyric-gloss`) and an extension
  (`~/.spicetify/Extensions/lyric-gloss-playbar.js`).
- Runs `spicetify backup apply`, which rewrites Spotify's JS bundle in
  `/opt/spotify`. **That is the only thing sudo is used for.** The directory is
  made writable for the duration of the apply and restored to `root:root`
  755/644 by an `EXIT` trap, so it is never left world-writable.
- Sets a few spicetify config keys, including `experimental_features 0` —
  which matters, see [docs/operations.md](docs/operations.md).

It does not touch your Spotify account, and it sends nothing anywhere except
the lyrics themselves, to the translation endpoint, to be translated.

## Uninstall

```sh
./uninstall.sh
```

Restores the stock bundle and unpatches `lyrics-plus` byte-for-byte. It prints
the two `localStorage` keys that a restore cannot reach, and how to clear them.

## After an upgrade

Every Spotify update silently turns the gloss off: the package puts the stock
app files back, and Spotify loads those instead of the patch.

**On Arch, install the pacman hook once and forget about it:**

```sh
./install-hook.sh
```

From then on, every upgrade of the `spotify` package — including AUR helper
updates, which still go through pacman — re-applies lyric-gloss automatically,
upgrading spicetify first if a newer release exists. Nothing prompts during the
upgrade. Afterwards, quit Spotify and start it from your launcher. The hook runs
the installer from wherever this repository was when you installed it, so re-run
`./install-hook.sh` if you move it.

**Otherwise,** re-run `./install.sh` after any Spotify package upgrade or
`spicetify upgrade`. Re-running is always safe: it unpatches first, so changes
to the patch set are picked up rather than skipped.

If `lyrics-plus` has changed upstream in a way that moves the code this patches,
`install.sh` refuses and tells you which anchor moved, rather than producing a
half-patched app.

## Changing the target language

Translation is to English by default. The lyrics-plus settings menus are hidden
(the whole point is that there is nothing to configure), so the target lives in
the source:

```sh
# in patch.py, find this replacement and change the language code:
'\t\t"translate:translated-lyrics-source": "autoTranslation:en",'
```

Then `./install.sh` again. Twelve targets are available — `en`, `es`, `fr`,
`de`, `it`, `pt`, `nl`, `ja`, `ko`, `zh`, `ru`, `ar` — listed in `TARGETS` in
`src/ProviderAutoTranslate.js`. The other baked-in defaults (below-original
gloss, left alignment, synced mode, expanded view) are adjacent in `patch.py`
and change the same way.

## How it works

Lyrics are sent to `translate.googleapis.com/translate_a/single` (`client=gtx`,
no API key), newline-joined so the response comes back one segment per line —
which is what keeps the translation aligned to the right lyric. Results are
cached in `localStorage` for 30 days, keyed by track *and* target language.

A song already in your target language is detected on the first request and
skipped, with the skip cached: an English track costs exactly one request,
ever, and then nothing.

[SPEC.md](SPEC.md) has the reasoning behind all of it, including the parts that
look over-engineered and aren't.

## Limits

**The endpoint is unofficial.** It has no published terms for this use, no key
and no quota, and it throttles by IP. The provider is deliberately frugal —
one request per song, aggressive caching, and a circuit breaker that backs off
2m → 10m → 30m → 2h while requests keep failing — but if you hammer it from a
shared address you can still get temporarily cut off. Cached tracks keep
rendering throughout.

**Translation quality is sentence-level MT.** Straight lines translate well.
Idiom goes literal, and register is often wrong — which is the hard kind of
wrong to notice if you are still learning the language. Swapping the backend
for an LLM is a change confined to one function; see SPEC.md.

**Same-language detection is per song, not per line.** A mostly-English track
with a Spanish chorus is skipped wholesale.

**It patches a proprietary client.** Spotify has no plugin API; spicetify is
the only way in, and Spotify does not support it. Nothing here is affiliated
with or endorsed by Spotify.

## Development

```sh
./test              # the whole suite: patch round-trip, provider, shell syntax
./test patch        # patch.py only
./test provider     # the translation provider only
```

Everything runs offline — no spicetify install, no Spotify, no network. The
patch runs against a synthetic `lyrics-plus` fixture and the provider against a
fake endpoint.

- [docs/development.md](docs/development.md) — layout, commands, conventions
- [docs/operations.md](docs/operations.md) — failure modes, each with its symptom
- [docs/roadmap.md](docs/roadmap.md) — what is missing, prioritised
- [SPEC.md](SPEC.md) — design, and why it is built this way
- [CLAUDE.md](CLAUDE.md) — orientation for coding agents; the invariants not to break

Contributions welcome. The one thing to know before touching `patch.py`: an
edit that has shipped and is later dropped goes in `RETIRED` rather than being
deleted, or already-patched installs can never be cleaned up. The test suite
enforces this.

## Credits

Built on [spicetify](https://github.com/spicetify/cli) and its `lyrics-plus`
custom app, which does the hard parts — lyric fetching, sync, and the
below-original rendering this fills in.

## License

[MIT](LICENSE) © Maxamilian X J Kidd-May
