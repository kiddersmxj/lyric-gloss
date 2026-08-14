# Development

## Layout

```
CLAUDE.md                       agent orientation — invariants and hard-won rules
README.md                       what it is, install, status
SPEC.md                         design and the reasoning behind it
docs/operations.md              failure modes, each with its symptom
docs/development.md             this file
patch.py                        text edits against vendored lyrics-plus
install.sh, uninstall.sh        orchestration
test                            test runner — patch, provider, shell
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

`~/.spicetify` is a symlink into the `home-k` dotfiles repo, but `CustomApps/`
and `Extensions/` are untracked there — this repo is the source of truth.

## Commands

```sh
./install.sh                          # patch, configure, apply, verify
./uninstall.sh                        # restore stock client, unpatch
python3 patch.py apply  ~/.spicetify  # patch only
python3 patch.py remove ~/.spicetify  # unpatch only
```

`install.sh` needs sudo, but only to write `/opt/spotify` during the apply; it
restores `root:root` 755/644 through an `EXIT` trap.

## Testing

```sh
./test              # everything: patch round-trip, provider, shell syntax, shellcheck
./test patch        # patch.py only          (pytest, tests/test_patch.py)
./test provider     # the provider only      (node:test, tests/provider.test.mjs)
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
