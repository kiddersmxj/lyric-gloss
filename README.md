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
| Playbar button | replaces Spotify's native lyrics button, by default |
| Re-apply after `spicetify upgrade` | `install.sh`, re-runnable, refuses on upstream drift |
| Translation quality | adequate for prose, literal on slang — see SPEC.md |

## Install

```sh
./install.sh          # prompts for sudo, only to write /opt/spotify
```

Restart Spotify. The lyrics button on the playbar is now this app — Spotify's
own lyrics button and the redundant sidebar entry are hidden, so there is one
control, where you'd expect it.

There is nothing to configure. The patched defaults are: auto-translate to
English, glossed below the original, source language auto-detected, mode
locked to synced, expanded view, left-aligned. All baked into the source
rather than written to localStorage, so clearing the translation cache can't
silently undo them.

The lyrics-plus chrome is hidden to match — the karaoke/synced/unsynced tabs,
the translation and adjustment menus, the cache button, and the sidebar entry
(once the playbar button is confirmed bound).

To change any of it, edit the defaults in `patch.py` and re-run `install.sh`.

Re-run `./install.sh` after any `spicetify upgrade` or Spotify package upgrade —
both replace the files this patches. Re-running is safe: it unpatches first, so
changes to the patch set are picked up rather than skipped.

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
