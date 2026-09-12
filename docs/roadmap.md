# Roadmap

What is missing, roughly in the order it is worth doing. Everything in the
[status table](../README.md#status) works; this is the rest.

## Before making the repo public

**A screenshot.** The README describes the rendering in text because there is
no image of it. One capture of the lyrics page with a glossed song is the
single biggest thing missing for anyone deciding whether they want this.

## Worth doing next

**Notice when a Spotify update has undone the install.** Today it fails
silently: the patch is simply not loaded, so nothing of ours can report it, and
the first sign is missing translations. A pacman hook on the `spotify` package
that re-runs `install.sh`, or at least says it needs re-running, would close
that — as would deriving the spicetify version floor from the installed Spotify
instead of hard-coding it, since that floor moves with every client update.

**Move the cooldown key out of the cache prefix.** `clearCache()` deletes
everything under `lyrics-plus:auto-translate:`, and the circuit breaker's
`until`/`step` live at `lyrics-plus:auto-translate:cooldown` — so clearing the
cache also forgets that the endpoint is throttling us. Harmless in practice
today (the cache button is hidden, so `clearCache()` is console-only), but it
is the one action that makes the provider resume asking during a cooldown.

**Test the playbar extension.** `src/lyric-gloss-playbar.js` is the least
covered file: button binding, nav hiding and route marking are all DOM work,
verified only against the running client. A jsdom harness with a fixture of the
relevant Spotify DOM would catch selector regressions before an install cycle
does. Note that Spotify serves UI experiments per session, so a fixture is a
snapshot of one variant, not the truth.

**Verify against a fresh spicetify.** The patch is only ever exercised against
one machine's `lyrics-plus`. The test fixture deliberately does not track
upstream, so nothing catches an anchor moving until someone installs. A CI job
that fetches a pinned spicetify release and runs `patch.py apply` against the
real app would close that gap.

## Bigger changes

**An LLM translation backend.** Sentence-level MT renders idiom literally and
gets register wrong, which is the failure mode most likely to mislead someone
learning the language. Prompting a model with "these are song lyrics, in
<language>, from <artist>" would fix most of it. The change is confined to
`translateBlock()` — chunking, alignment, caching and the skip logic are all
transport-agnostic and stay as they are. Costs an API key, which is why it is
not the default.

**Per-line rather than per-song language detection.** The skip is decided by
the first chunk's detected language, so a mostly-English track with a Spanish
chorus is skipped wholesale.

**Click-a-word-to-define.** A permanently visible translation is a
comprehension aid, not a learning aid — the eye goes to the language it knows.
Definition on demand would teach more. This is a different product rather than
an increment, and the always-visible version is what was wanted; noted because
the objection is a fair one. See [SPEC.md](../SPEC.md).

## Platforms

**macOS and Windows.** `install.sh` assumes `/opt/spotify` and restores
`root:root` ownership, both Linux-specific. `SPOTIFY_DIR` covers the path but
not the permission handling.

**Flatpak and Snap.** Untested. spicetify can work with them via a different
`spotify_path`, but the sudo window and permission restore in `install.sh`
assume a system package layout.
