# lyric-gloss — orientation for agents

Machine-translated lyrics rendered under the original line, inside Spotify's own
lyrics view. A patch-set against spicetify's bundled `lyrics-plus` custom app,
plus one standalone extension.

Read [SPEC.md](SPEC.md) for design and [docs/operations.md](docs/operations.md)
before debugging anything — it has every failure mode we have actually hit, each
with its symptom. Most "new" problems are already in there.

## Shape of the thing

```
patch.py                    text edits applied to ~/.spicetify/CustomApps/lyrics-plus
src/ProviderAutoTranslate.js    new file copied into that app — the translation source
src/lyric-gloss-playbar.js      standalone spicetify extension — playbar button + nav hiding
src/gloss.css                   installed as a spicetify theme — styling + chrome removal
install.sh / uninstall.sh       orchestration, including the sudo window for /opt
```

Nothing here runs standalone. Everything ends up inside `/opt/spotify/Apps/xpui/`
after `spicetify apply`, which is the only thing that can inject into the client
— Spotify has no plugin API.

## Invariants — breaking these has cost real hours

**`experimental_features` must stay 0.** At 1, `spicetify apply` pins ~258
Spotify feature flags into localStorage and breaks end-of-track auto-advance, in
a way that survives `spicetify restore`, permission fixes and cache clears.

**Spicetify must be newer than the installed Spotify.** An older spicetify
throws inside the lyrics route and can crash the client. `install.sh` enforces
`>= 2.44.0`. Beware "restoring the previous version" — a spicetify that was fine
while dormant is not fine once applied.

**Settings the UI no longer exposes must be *forced*, not defaulted.**
`CONFIG.visual` reads `localStorage.getItem(...) || "<default>"`, so a patched
default is ignored whenever a stale value exists. A default plus a hidden menu
is a dead end with no way out.

**Retired edits go in `RETIRED`.** `patch.py remove` only reverses the current
`EDITS`. An edit that was shipped and later dropped would be stranded in
already-patched trees forever. `RETIRED` is swept on both apply and remove.

**Never hide the nav entry unless a playbar button is bound.** Hiding it up
front, twice, left no way to open lyrics at all. `hideNavEntry()` runs only
after `bind()` succeeds.

**Cosmetic code goes last, in `try`/`catch`.** The extension is one IIFE, so
anything that throws stops everything after it. The route-class block was
briefly placed before `bind()` and silently disabled the button binding and the
nav hiding. Critical path first; extras afterwards, guarded.

**`/opt/spotify` is opened only for the apply.** `install.sh` restores
`root:root` 755/644 via an `EXIT` trap. Never leave it world-writable.

## Working on it

- `python3 patch.py apply|remove ~/.spicetify` — idempotent; refuses if any
  anchor isn't found exactly once, so upstream drift fails loudly.
- Always test the round-trip from a clean baseline: remove → snapshot → apply →
  remove → `diff -rq`. It must be byte-identical.
- `node --check` every patched JS file. A syntax error takes out the whole app.
- The provider is testable outside Spotify: shim `localStorage` and
  `Spicetify.CosmosAsync`, then `eval` the file. That is how the line-alignment
  and same-language-skip behaviour were verified against the live endpoint.

## Debugging the running client

Do not guess at DOM selectors. Enable developer mode and query it:

```sh
~/.spicetify/spicetify enable-devtools      # only sticks if Spotify is CLOSED
curl -s http://127.0.0.1:8088/json          # find the page target's ws:// URL
```

Then drive it over CDP (`Runtime.evaluate`). Four selector guesses were shipped
across four of the user's install-and-restart cycles before anyone looked at the
actual DOM; the nav entry turned out to have no `href` and no `data-id`, so none
of them could ever have matched. Measure first.

Turn developer mode off afterwards — it is a pref edit, and `enable-devtools`
has no off switch.

## Rules that are not about code

**Never judge Spotify playback from an instance launched by a tool shell or
script.** It reproduces an end-of-track failure of its own. Have the user launch
it normally (dmenu) and report back. Concluding otherwise from a
script-launched instance produced several rounds of wrong diagnosis and a
needless full revert.

**localStorage flushes lazily.** Wait ~20s after writing before quitting
Spotify, or the write is lost and looks like it never happened.

**`pgrep -f "/opt/spotify/spotify"` matches your own shell's command line.**
Use `pgrep -x spotify`.

**The user's Spotify prefs are rewritten on exit.** Edit `prefs` only while
Spotify is closed.
