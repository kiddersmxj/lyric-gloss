# Operations

Gotchas, each with the symptom that identifies it.

## `spicetify apply` breaks Spotify's end-of-track auto-advance

**Symptom:** a track plays to the end, Spotify says *"can't play current song"*,
and the next track never starts. Manually skipping works fine. Survives
`spicetify restore`, reinstalling Spotify, fixing `/opt` permissions, and
clearing `~/.cache/spotify/Storage`.

**Cause:** `experimental_features = 1` — which is the value in the default
generated `config-xpui.ini` — makes `spicetify apply` write a
`spicetify-exp-features` key into Spotify's **localStorage**, pinning ~258
internal feature flags to whatever that spicetify release shipped as defaults.
Several are playback-pipeline flags (`betamax*`, `enablePrefetching`). They
override what Spotify's servers deliver.

**Why it's so hard to find:** `spicetify restore` reverts the JS bundle and
nothing else. localStorage lives in
`~/.cache/spotify/Default/Local Storage/leveldb` and is never touched, so a
verifiably pristine client keeps running the overridden flags.

**Fix:** `install.sh` always sets `experimental_features 0`, so it never
happens. To clear it after the fact, with developer mode on:

```sh
curl -s http://127.0.0.1:8088/json     # find the page target's ws:// URL
# then over CDP:  localStorage.removeItem("spicetify-exp-features")
```

localStorage flushes lazily — **wait ~20 seconds before quitting Spotify** or
the deletion is lost and the key reappears on next launch.

## `/opt/spotify` permissions

Spicetify's docs suggest `chmod a+wr /opt/spotify /opt/spotify/Apps -R`, which
leaves the install world-writable and, after an apply, owned by your user
instead of root. `pacman -Qkk spotify` then reports a dozen mismatches.

`install.sh` opens the directory only for the duration of the apply and
restores `root:root` 755/644 on exit via a trap. Mtime mismatches on the two
`.spa` files afterwards are expected and harmless.

## Upgrades clobber the patch

- `spicetify upgrade` replaces `CustomApps/` wholesale → the provider and all
  wiring vanish.
- A Spotify package upgrade replaces `Apps/xpui.spa` → the patch is gone from
  the client, and permissions reset to root.

Both are fixed by re-running `install.sh`.

## Two Spotify packages

Arch has both `spotify` (AUR, real `/opt/spotify`) and `spotify-launcher`
(official repo, downloads its own copy into
`~/.local/share/spotify-launcher/install/usr` and self-updates). Each ships a
`.desktop` entry.

**Symptom:** everything looks correctly applied, but the running client has no
Lyrics app and no gloss — because you launched the other one. Spicetify patches
whatever `spotify_path` points at, which is `/opt`.

Keep only one installed.

## "Can't play current song" depends on how Spotify was launched

**Symptom:** track plays to the end, *"can't play current song"*, no
auto-advance. Manual skip works. Quitting and relaunching from dmenu fixes it
immediately.

Observed twice, both times on a Spotify started by something other than the
normal desktop launch, and cleared both times by relaunching from dmenu. The
mechanism is not established — the renderer logs no JS error, exception or
failed request while it happens, so the fault is below the UI layer. The
environment inherited from the launching process is the obvious suspect
(`XDG_RUNTIME_DIR`, the DBus session, PipeWire socket access), but this has not
been pinned down.

**Practical rule:** always launch Spotify the normal way — dmenu →
`spotify.desktop` → `/usr/local/bin/spotify` → `/opt/spotify/spotify`. Never
judge playback behaviour from an instance started by a script, a tool shell, or
anything else non-interactive, and never conclude anything about a patch from
such an instance.

Related: `PULSE_LATENCY_MSEC=60`, the workaround for Spotify's SIGFPE when
PipeWire reports zero latency during sink transitions, is exported from
`.bashrc` and so only reaches Spotify when launched from an interactive shell.
A dmenu launch bypasses it entirely. Moving it to `~/.xprofile` would make it
apply to every launch, and is worth trying if this recurs.

## Settings live in localStorage, not in the repo

Clearing `lyrics-plus:*` keys — which `uninstall.sh` suggests, and which is
also how you clear the translation cache — resets **all** lyrics-plus settings
to defaults, including Translation Provider (`none`) and Translation Display
(`replace`). The patch is still installed; nothing renders until both are set
again. Symptom: everything verifies as present in the client, but no gloss
appears.

## No lyrics button at all

**Symptom:** after an install, there is no lyrics button on the playbar —
neither Spotify's nor one from lyrics-plus.

**Cause:** lyrics-plus's `PlaybarButton.js` appends a stylesheet hiding
`.main-nowPlayingBar-lyricsButton` *before* calling
`Spicetify.Playbar.Button().register()`. If that API doesn't match the running
Spotify build, the hide lands and the replacement never appears.

**Fix:** that extension is deliberately left at its upstream default (off).
`src/lyric-gloss-playbar.js` hijacks the native button instead — a capture-phase
click listener that routes to `/lyrics-plus` — so Spotify's own button, icon and
position are kept and nothing is hidden. The worst case is the button carrying
on doing what it always did.

## Retired patch edits

`patch.py remove` only reverses the edits currently in `EDITS`. An edit that was
shipped and later dropped would otherwise be stranded in an already-patched tree
forever, because `remove` no longer recognises it and `apply` sees the file as
already patched. Anything retired must be moved to `RETIRED`, which is swept on
both apply and remove.

## "Something went wrong" on the lyrics page, and crashes

**Symptom:** clicking the lyrics button shows Spotify's error page, and the
client sometimes crashes outright.

**Cause:** spicetify older than the installed Spotify. `lyrics-plus` is built
against a known set of client internals, so an older spicetify rendering a
newer Spotify throws inside the route.

| spicetify | supports up to |
|---|---|
| 2.42.7 | pre-1.2.86 |
| 2.43.0 | 1.2.86 |
| 2.44.0 | 1.2.93 |

**Check first:** `spicetify -v` against the Spotify version in
`~/.config/spotify/prefs` (`app.last-launched-version`). If spicetify is older
than Spotify, that is almost certainly it.

`install.sh` now refuses to proceed on anything below 2.44.0 and upgrades
first. Note that `spicetify upgrade` wipes `CustomApps/`, which is why the
upgrade runs before patching.

**Beware of "reverting to how it was".** If spicetify was previously installed
but never *applied*, downgrading it to that original version reintroduces this
incompatibility — the old version was only ever fine because nothing was using
it.

## No translations, and no menu to fix it

**Symptom:** the gloss never appears, and the translation menu is hidden so
there is nothing to click.

**Cause:** a stale value in localStorage. `CONFIG.visual` reads
`localStorage.getItem(...) || "<default>"`, so a patched *default* is ignored
whenever a value already exists — and `translate:translated-lyrics-source` is
left at `"none"` by any earlier run or cache clear. Hiding the menu then
removes the only way to change it.

**Fix:** these values are now **forced** in the patched source, not defaulted:

```js
"translate:translated-lyrics-source": "autoTranslation:en",
"translate:display-mode": "below",
"synced-compact": false,
alignment: "left",
locked: "1",
```

Rule of thumb: if the UI for a setting is hidden, the value must be forced. A
default plus a hidden menu is a dead end.

## Hiding UI by class name

Spotify moves its nav entry for custom apps between builds — it has been a list
item, a link and a button — so CSS written against a guessed class name
silently stops working. `lyric-gloss-playbar.js` finds it by what it points at
(`[href="/lyrics-plus"]`, `[data-id="/lyrics-plus"]`) and walks up to the
nearest `li`/listitem, which survives those changes.

## New song doesn't scroll back to the top

**Symptom:** a track ends, the next one's lyrics load, and the page stays
scrolled wherever the previous song finished instead of snapping to the current
line the way Spotify's native pane does.

**Cause:** two things in `SyncedExpandedLyricsPage`. The scroll effect keys off
`lyrics[0].text`, and a track's first entry is very often a pause marker — so
consecutive tracks share an id and the effect never re-fires. Separately, when
the active line is index 0 (i.e. a new track) upstream returns early without
scrolling if the first line starts within 300 ms.

**Fix:** the patch includes the track URI in the id, and drops the early
return.

## Mic entry comes back on some launches but not others

**Symptom:** after a `spicetify apply` the nav mic is gone, then it reappears
after restarting Spotify yourself — same files, same client, no reinstall.

**Cause:** Spotify serves UI experiments per session, so the playbar lyrics
button does not always carry `data-testid="lyrics-button"`. On launches where
it doesn't, `findButton()` fell through to `button[aria-label*="yric"]`, which
matches the **nav mic** first because it is higher in the DOM. Binding marked
it, and `hideNavEntry()` skipped marked elements to avoid hiding the button it
had just bound — so the mic made itself unhideable, on exactly those launches.

**Fix:** `findButton()` searches inside the now-playing bar first and rejects
anything matching the nav icon, so a nav entry can never be bound. The MARK
guard in `hideNavEntry()` is gone as well: hiding now always wins.

**General lesson:** anything that identifies an element by a label or test id
should be scoped to the container it belongs to. Per-session UI experiments
mean a selector that works on one launch can silently match something else on
the next.

## Translation fails in a loop with HTTP 429

**Symptom:** every track, in any language, shows a translation failure. The
console is full of 429s.

**Cause:** the endpoint is unofficial and throttles by IP, and the provider
amplified a single 429 into sustained throttling. The per-line retry — meant
for a chunk that returns the *wrong number of segments* — also fired when the
request itself failed, so one 429 became one doomed request per line, dozens
per song, repeated on every track change.

**Fix:** per-line retry now happens only when the request succeeded and came
back misaligned. A 429 aborts the whole song immediately and opens a circuit
breaker: 2m, then 10m, 30m, 2h while it keeps failing, reset by any clean run.
The cooldown is persisted, so restarting Spotify doesn't resume hammering, and
already-cached tracks keep rendering throughout.

**If you are throttled right now,** wait it out — nothing is broken. To clear
the breaker manually, remove `lyrics-plus:auto-translate:cooldown` from
localStorage.
