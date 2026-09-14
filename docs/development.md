# Development

## Layout

```
CLAUDE.md                       agent orientation — invariants and hard-won rules
README.md                       what it is, install, status
SPEC.md                         design and the reasoning behind it
docs/operations.md              failure modes, each with its symptom
docs/development.md             this file
docs/roadmap.md                 what is missing, prioritised
patch.py                        text edits against vendored lyrics-plus
install.sh, uninstall.sh        orchestration
install-hook.sh                 installs the pacman hook (Arch)
hooks/                          the hook trigger and its root-side action
Makefile                        every command; `make help`
test                            test runner — patch, provider, shell
scripts/                        status, developer mode, LRCLIB comparison
tests/test_patch.py             patch round-trip, atomicity, retired sweep
tests/provider.test.mjs         provider behaviour against a fake endpoint
tests/fixtures/lyrics-plus/     synthetic stand-in for the upstream app
src/ProviderAutoTranslate.js    translation source, copied into lyrics-plus
src/lyric-gloss-playbar.js      spicetify extension: playbar button + nav hiding
src/gloss.css                   spicetify theme: gloss styling + chrome removal
```

## Where the code ends up

| Source | Installed to |
|---|---|
| `src/ProviderAutoTranslate.js` | `~/.spicetify/CustomApps/lyrics-plus/` |
| `src/lyric-gloss-playbar.js` | `~/.spicetify/Extensions/` |
| `src/gloss.css` | `~/.spicetify/Themes/lyric-gloss/user.css` |
| all of the above, after apply | `/opt/spotify/Apps/xpui/` |

Nothing installed is the source of truth — `CustomApps/` and `Extensions/` are
overwritten by `spicetify upgrade` and by this repo's `install.sh`. Edit here,
re-run `install.sh`. If `~/.spicetify` is a symlink into a dotfiles repo, keep
those two directories untracked there for the same reason.

## Commands

`make help` lists all of them. Nothing here starts Spotify — start it from your
launcher afterwards, since a script-launched client breaks auto-advance.

| | |
|---|---|
| `make test` / `test-patch` / `test-provider` / `lint` | the suite, or one part of it |
| `make status` | one screen: versions, bundle state, source anchors, hook, developer mode, endpoint |
| `make install` / `uninstall` | patch and apply / restore stock. One sudo prompt each |
| `make anchors` | after a spicetify upgrade: every anchor its lyrics-plus breaks, nothing written |
| `make runs` | today's installer runs from sudo's journal — when `/opt` was opened and closed |
| `make lrclib Q="title artist"` | how much LRCLIB's timings disagree for a song |
| `make hook-install` / `hook-test` / `hook-log` | the pacman hook |
| `make devtools-on` / `devtools-off` / `devtools-check` | developer mode; on and off quit Spotify first |

The scripts behind them — `install.sh`, `patch.py apply|remove|check`,
`scripts/*` — can still be run directly. `install.sh` needs sudo only to write
`/opt/spotify` during the apply, and restores `root:root` 755/644 through an
`EXIT` trap.

## Testing

```sh
make test           # everything: patch round-trip, provider, shell syntax, shellcheck
make test-patch     # patch.py only          (pytest, tests/test_patch.py)
make test-provider  # the provider only      (node:test, tests/provider.test.mjs)
```

Everything runs offline. The patch tests work against a synthetic `lyrics-plus`
fixture rather than a real install, and the provider tests against a fake
endpoint — so no spicetify, no Spotify and no network are required, which is
also why CI can run them (`.github/workflows/ci.yml`, on push and PR).

What the suite is actually protecting:

- **The round-trip is byte-identical.** Removal is the safety net; if it drifts,
  `uninstall.sh` stops being trustworthy and a half-reverted app is worse than a
  patched one.
- **`RETIRED` is enforced.** An edit that shipped and was later dropped must be
  reversible, or already-patched installs can never be cleaned up. This has bitten
  repeatedly — see the entries in `patch.py`.
- **Anchors match exactly once, and a bad anchor writes nothing.** Upstream drift
  must fail loudly and atomically rather than produce a half-patched app.
- **The provider backs off rather than retrying harder.** Circuit breaker,
  cooldown persistence, transport fallback, and the same-language skip — the
  behaviours where getting it wrong caused sustained rate limiting.

After changing a patch edit, also `node --check` the patched files against a real
tree; one syntax error takes out the entire lyrics app, and the fixture cannot
catch a mismatch with the *actual* upstream source.

## Conventions

- Patch edits are `(file, anchor, replacement)` triples applied as plain text.
  Anchors must match **exactly once** — `apply` aborts otherwise rather than
  corrupting the app.
- Validation is **sequential and staged**: edits are applied to in-memory copies
  in order, and written only once every one has succeeded. So an edit may
  legitimately anchor on text an earlier edit introduced, and a failure part way
  through leaves the app untouched instead of half patched. `remove` mirrors
  this in reverse order.
- `manifest.json` is edited textually, never via a JSON round-trip;
  `json.dumps` reformats the file and breaks byte-identical removal.
- Anything ever shipped and then dropped moves to `RETIRED`, so already-patched
  trees are corrected rather than stranded.
- Comments explain *why*, especially where the obvious approach is wrong — the
  render-time `setState` hazard, the `MutationObserver` that fires every frame,
  the `hasTranslation` gate. Those cost real debugging time; keep them.

## After upgrades

`spicetify upgrade` replaces `CustomApps/`, and a Spotify package upgrade
replaces the bundle. Both silently remove everything. Re-run `install.sh`,
which unpatches first so patch-set changes are picked up.
