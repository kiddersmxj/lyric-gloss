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

Related: `PULSE_LATENCY_MSEC=60`, the workaround for Spotify's SIGFPE when
PipeWire reports zero latency during sink transitions, is exported from
`.bashrc` and therefore only reaches Spotify when launched from an interactive
shell. Launching from dmenu bypasses it entirely. Move it to `~/.xprofile` if
that bug ever resurfaces.

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
