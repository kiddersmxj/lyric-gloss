#!/usr/bin/env bash
# One screen of lyric-gloss state on this machine.
#
# Most failures here have presented as "translations quietly stopped", with the
# cause somewhere else entirely: a Spotify update restoring stock files, a
# spicetify upgrade replacing the patched app, an install that refused before
# doing anything, a throttled translation client. This puts all of it in one
# place. It changes nothing.
set -uo pipefail

SPICE_HOME=${SPICETIFY_HOME:-$HOME/.spicetify}
SPOTIFY_DIR=${SPOTIFY_DIR:-/opt/spotify}
HOOK_LOG=${HOOK_LOG:-/var/log/lyric-gloss.log}
SPICETIFY="$SPICE_HOME/spicetify"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUNDLE="$SPOTIFY_DIR/Apps/xpui"

section() { printf '\n\033[1m%s\033[0m\n' "$1"; }
row() { printf '  %-24s %s\n' "$1" "$2"; }
yes_no() { if "$@" >/dev/null 2>&1; then echo yes; else echo no; fi; }

section "Versions"
spotify_version=$(strings -n 8 "$SPOTIFY_DIR/spotify" 2>/dev/null | grep -m1 -oE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+\.g[0-9a-f]+$' || true)
row "Spotify (binary)" "${spotify_version:-not found}"

if [[ -x $SPICETIFY ]]; then
	spicetify_version=$("$SPICETIFY" -v 2>/dev/null | tr -d '[:space:]')
	latest=$(curl -fsSI -m 10 https://github.com/spicetify/cli/releases/latest 2>/dev/null |
		awk 'tolower($1) == "location:" { gsub(/\r/, ""); n = split($2, a, "/"); sub(/^v/, "", a[n]); print a[n] }')
	row "spicetify" "${spicetify_version:-?}${latest:+  (latest release $latest)}"
	config=$("$SPICETIFY" -c 2>/dev/null)
	backup() { awk -F' *= *' -v key="$1" '/^\[Backup\]/ { s = 1; next } /^\[/ { s = 0 } s && $1 == key { print $2; exit }' "$config"; }
	row "spicetify backup of" "$(backup version) (made with spicetify $(backup with))"
	[[ -n $spotify_version && $(backup version) != "$spotify_version" ]] &&
		row "" "!! backup is not of the installed Spotify — install.sh will rebuild"
else
	row "spicetify" "not found at $SPICETIFY"
fi

section "Spotify client"
spa=$(compgen -G "$SPOTIFY_DIR/Apps/*.spa" | wc -l)
dirs=$(find "$SPOTIFY_DIR/Apps" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l)
if ((spa && dirs)); then
	state="MIXED — stock archives beside a patched bundle; Spotify loads the stock ones"
elif ((spa)); then
	state="stock — not patched"
elif ((dirs)); then
	state="patched"
else
	state="empty?"
fi
row "bundle" "$state"
if [[ -d $BUNDLE ]]; then
	row "built" "$(stat -c '%y' "$BUNDLE/spicetify-routes-lyrics-plus.js" 2>/dev/null | cut -c1-16 || echo '?')"
	row "translation provider" "$(yes_no grep -q ProviderAutoTranslate "$BUNDLE/spicetify-routes-lyrics-plus.js")"
	row "Spotify lyrics first" "$(yes_no grep -q 'providersOrder: JSON.stringify(\["spotify"' "$BUNDLE/spicetify-routes-lyrics-plus.js")"
	row "playbar extension" "$(yes_no grep -rq data-lyric-gloss-bound "$BUNDLE/extensions")"
fi
row "/opt/spotify" "$(stat -c '%U:%G %a' "$SPOTIFY_DIR" 2>/dev/null)"
if pgrep -x spotify >/dev/null; then
	row "running" "yes, since $(ps -o lstart= -p "$(pgrep -x spotify | head -1)" | xargs)"
else
	row "running" "no"
fi
if curl -fs -m 2 http://127.0.0.1:8088/json/version >/dev/null 2>&1; then
	row "developer mode" "ON — turn off with: make devtools-off"
else
	row "developer mode" "off"
fi

section "lyrics-plus source (what the next install applies)"
if [[ -f $SPICE_HOME/CustomApps/lyrics-plus/index.js ]]; then
	row "patched" "$(yes_no grep -q ProviderAutoTranslate "$SPICE_HOME/CustomApps/lyrics-plus/index.js")"
	row "anchors" "$(python3 "$HERE/patch.py" check "$SPICE_HOME" 2>&1 | head -1)"
else
	row "lyrics-plus" "not found under $SPICE_HOME/CustomApps"
fi

section "Pacman hook"
if [[ -f /etc/pacman.d/hooks/lyric-gloss.hook ]]; then
	row "installed" "yes"
	last=$(grep ':: lyric-gloss:' "$HOOK_LOG" 2>/dev/null | tail -1)
	row "last run" "${last:-no runs logged yet}"
else
	row "installed" "no — every Spotify update will need make install (or: make hook-install)"
fi

section "Translation endpoint (from this address)"
for client in gtx dict-chrome-ex; do
	code=$(curl -s -o /dev/null -m 10 -w '%{http_code}' -G https://translate.googleapis.com/translate_a/single \
		--data-urlencode "client=$client" --data-urlencode sl=auto --data-urlencode tl=en \
		--data-urlencode dt=t --data-urlencode q=hola)
	case $code in
		200) verdict="ok" ;;
		429) verdict="throttled" ;;
		*) verdict="unexpected" ;;
	esac
	row "client=$client" "HTTP $code  $verdict"
done
echo
