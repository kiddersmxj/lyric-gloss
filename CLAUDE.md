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

**On failure, back off — never retry harder.** Two separate incidents came
from error handling that amplified a problem: a `catch` that cleared the
request key and re-fired on every render tick, and a per-line retry that ran
when the request itself had failed. Retry only where the failure is genuinely
recoverable, and put a circuit breaker behind anything hitting the network.

**Selectors must be scoped to their container.** Spotify serves UI experiments
per session, so an element that matches on one launch can match something else
on the next. This is what made the nav mic bind itself as the playbar button.

**Cosmetic code goes last, in `try`/`catch`.** The extension is one IIFE, so
anything that throws stops everything after it. The route-class block was
briefly placed before `bind()` and silently disabled the button binding and the
nav hiding. Critical path first; extras afterwards, guarded.

**`/opt/spotify` is opened only for the apply.** `install.sh` restores
`root:root` 755/644 via an `EXIT` trap. Never leave it world-writable.

## Working on it

- `./test` before anything ships. It covers the patch round-trip, atomicity,
  the `RETIRED` sweep, and the provider's alignment, skip, cache and circuit
  breaker — all offline, against a synthetic fixture and a fake endpoint. Add
  a case for any behaviour you had to debug; that is what it is for.
- `python3 patch.py apply|remove ~/.spicetify` — idempotent; refuses if any
  anchor isn't found exactly once, so upstream drift fails loudly.
- The suite proves the machinery, not that the anchors still match the
  *installed* lyrics-plus. Still do one real round-trip against your own tree
  before shipping a patch change: remove → snapshot → apply → remove →
  `diff -rq`. It must be byte-identical.
- The provider is also testable interactively: shim `localStorage` and
  `Spicetify.CosmosAsync`, then `eval` the file. That is how the line-alignment
  and same-language-skip behaviour were verified against the live endpoint.

## Debugging the running client

Do not guess at DOM selectors. Enable developer mode and query it:

```sh
~/.spicetify/spicetify enable-devtools      # only sticks if Spotify is CLOSED
curl -s http://127.0.0.1:8088/json          # find the page target's ws:// URL
```

Then drive it over CDP (`Runtime.evaluate`). Four selector guesses were shipped
across four install-and-restart cycles before anyone looked at the actual DOM;
the nav entry turned out to have no `href` and no `data-id`, so none of them
could ever have matched. Measure first.

Turning it off again is fiddlier than it looks, and getting it wrong wasted the
user's time three times:

- `spicetify config always_enable_devtools 0` only stops **spicetify**
  re-enabling it on apply. It does not close an already-open channel.
- The switch Spotify reads is `app.enable-developer-mode` in
  `~/.config/spotify/prefs`, and it is read **at launch**. Edit it with Spotify
  closed, or the file is rewritten from memory on exit and the edit is lost.
- Spotify writes that key back to `true` after starting, so the file showing
  `true` while the channel is closed is normal. Do not judge by the file.

Verify with `curl -s http://127.0.0.1:8088/json/version` — a CDP-specific path.
Checking whether *anything* answers on 8088 proves nothing.

## Rules that are not about code

**Never judge Spotify playback from an instance launched by a tool shell or
script.** It reproduces an end-of-track failure of its own. Ask for it to be
launched normally — through the desktop entry, not a terminal — and reported
back on. Concluding otherwise from a script-launched instance produced several
rounds of wrong diagnosis and a needless full revert.

**localStorage flushes lazily.** Wait ~20s after writing before quitting
Spotify, or the write is lost and looks like it never happened.

**`pgrep -f "/opt/spotify/spotify"` matches your own shell's command line.**
Use `pgrep -x spotify`.

**The user's Spotify prefs are rewritten on exit.** Edit `prefs` only while
Spotify is closed.
