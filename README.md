# lyric-gloss

Machine-translated lyrics rendered under the original line, in smaller text,
inside Spotify's own lyrics view.

A patch against [spicetify](https://github.com/spicetify/cli)'s bundled
`lyrics-plus` custom app. `lyrics-plus` already knows how to draw a translation
beneath each line — it just has no general translation source. This adds one.

## Status

| Piece | State |
|---|---|
| Translation provider | working — any source language, 12 target languages |
| Below-original styling | working — 0.55em, dimmed, active line brighter |
| Same-language skip | working — detects and skips, one request per track, cached |
| Cache | working — 30 days, per track + target, in localStorage |
| Re-apply after `spicetify upgrade` | `install.sh`, idempotent, refuses on upstream drift |
| Translation quality | adequate for prose, literal on slang — see SPEC.md |

## Install

```sh
./install.sh          # prompts for sudo, only to write /opt/spotify
```

Restart Spotify, then in the Lyrics view:

- **Translation Provider** → `<language> (auto-translate)`
- **Translation Display** → `Below original`
- **Alignment** → `Left` (gear icon; defaults to Center, which doesn't match Spotify)
- **Playbar button** → on (replaces Spotify's own lyrics button, hides the sidebar entry)

Re-run `./install.sh` after any `spicetify upgrade` or Spotify package upgrade —
both replace the files this patches.

## Uninstall

```sh
./uninstall.sh
```

Restores the stock bundle and unpatches `lyrics-plus` byte-for-byte.

## Coverage

Coverage is "any song `lyrics-plus` can find lyrics for" — LRCLIB, Musixmatch,
Netease, Genius and local files combined. There is no translation database to
be missing from: whatever lyrics are found get translated live and cached.

This is the main advantage over the stock Musixmatch translation source, which
only has translations a human contributed, for a small minority of tracks.

## Docs

- [SPEC.md](SPEC.md) — how it works and why it's built this way
- [docs/operations.md](docs/operations.md) — gotchas, with symptoms
