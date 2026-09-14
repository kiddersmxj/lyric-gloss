#!/usr/bin/env bash
# Spotify's developer mode, for inspecting the running client over CDP.
#
#   devtools.sh on      enable it (quits Spotify first)
#   devtools.sh off     disable it (quits Spotify first)
#   devtools.sh check   is the debugging channel actually open?
#
# Both on and off quit Spotify and never start it again: a Spotify launched from
# a script breaks end-of-track auto-advance, so the user starts it from their
# launcher. See docs/operations.md.
#
# The switch Spotify reads is app.enable-developer-mode in its prefs, read at
# launch. Spotify rewrites that file from memory when it exits, so any edit made
# while it is still running is lost — which is why this waits for the process to
# be gone and the file to stop changing first. After starting, Spotify writes the
# key back to true regardless, so the file is not evidence either way; the
# channel is.
set -euo pipefail

SPICE_HOME=${SPICETIFY_HOME:-$HOME/.spicetify}
PREFS=${SPOTIFY_PREFS:-$HOME/.config/spotify/prefs}
ENDPOINT=http://127.0.0.1:8088/json/version

quit_spotify() {
	pgrep -x spotify >/dev/null || return 0
	echo "==> quitting Spotify"
	pkill -x spotify || true
	for _ in $(seq 60); do
		pgrep -x spotify >/dev/null || break
		sleep 0.5
	done
	if pgrep -x spotify >/dev/null; then
		pkill -9 -x spotify || true
		sleep 2
	fi

	# Wait for the exit-time rewrite of prefs to land before touching it.
	local previous="" current
	for _ in $(seq 20); do
		current=$(stat -c '%Y-%s' "$PREFS" 2>/dev/null || true)
		[[ $current == "$previous" ]] && break
		previous=$current
		sleep 1
	done
}

case ${1:-} in
	on)
		quit_spotify
		"$SPICE_HOME/spicetify" enable-devtools >/dev/null
		echo "developer mode will be on at next launch — start Spotify from your launcher, then: make devtools-check"
		;;
	off)
		quit_spotify
		if [[ -f $PREFS ]]; then
			sed -i 's/^app\.enable-developer-mode=true$/app.enable-developer-mode=false/' "$PREFS"
		fi
		"$SPICE_HOME/spicetify" config always_enable_devtools 0 >/dev/null
		echo "developer mode will be off at next launch — start Spotify from your launcher, then: make devtools-check"
		;;
	check)
		if curl -fs -m 3 "$ENDPOINT" >/dev/null; then
			echo "developer mode ON — debugging channel open on 127.0.0.1:8088"
		elif pgrep -x spotify >/dev/null; then
			echo "developer mode off"
		else
			echo "Spotify is not running, so there is nothing to check"
		fi
		;;
	*)
		sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'
		exit 2
		;;
esac
