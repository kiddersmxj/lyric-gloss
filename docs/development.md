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

There is no test runner. Three checks, all cheap, all worth doing before
shipping a patch change:

**Round-trip must be byte-identical.** Removal is the safety net; if it drifts,
`uninstall.sh` stops being trustworthy.

```sh
cp -r ~/.spicetify/CustomApps /tmp/t/
python3 patch.py remove /tmp/t          # clean baseline
cp -r /tmp/t/CustomApps /tmp/t/baseline
python3 patch.py apply  /tmp/t
python3 patch.py remove /tmp/t
diff -rq /tmp/t/baseline /tmp/t/CustomApps
```

**Syntax-check every patched file.** `node --check` on `index.js`,
`OptionsMenu.js`, `ProviderAutoTranslate.js`, `lyric-gloss-playbar.js`. One
syntax error takes out the entire lyrics app.

**Exercise the provider outside Spotify.** Shim `localStorage` and
`Spicetify.CosmosAsync` with `fetch`, `eval` the source, and call
`getTranslation()`. Worth covering: a non-English track, a track already in the
target language (must skip and cache the skip), and a repeat call (must make
zero requests).

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
