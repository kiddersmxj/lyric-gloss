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

## Testing playback

Do not test playback behaviour against a Spotify launched from a sandboxed
tool shell — it reproduces an end-of-track failure of its own and will send you
chasing a bug that isn't there. Launch it the normal way (dmenu →
`spotify.desktop` → `/usr/local/bin/spotify` → `/opt/spotify/spotify`).

Related: `PULSE_LATENCY_MSEC=60`, the workaround for Spotify's SIGFPE when
PipeWire reports zero latency during sink transitions, is exported from
`.bashrc` and therefore only reaches Spotify when launched from an interactive
shell. Launching from dmenu bypasses it entirely. Move it to `~/.xprofile` if
that bug ever resurfaces.
