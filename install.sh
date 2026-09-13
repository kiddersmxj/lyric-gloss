#!/usr/bin/env bash
# Install lyric-gloss into spicetify and apply it to Spotify.
#
# Re-run after every `spicetify upgrade` (which wipes CustomApps/) and after
# every Spotify package upgrade (which replaces the patched bundle).
#
# /opt/spotify is opened for writing only for the duration of the apply, then
# put back to the package's root:root 755/644. It is never left writable.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SPICE_HOME="${SPICETIFY_HOME:-$HOME/.spicetify}"
SPOTIFY_DIR="${SPOTIFY_DIR:-/opt/spotify}"
SPICETIFY="$SPICE_HOME/spicetify"

# Prerequisites are checked, never installed. spicetify rewrites a proprietary
# client's JS bundle and its own installer wants to be run deliberately, so
# pulling it in from inside this script would be doing something substantial on
# someone's behalf while they were expecting a lyrics tweak.
if [[ ! -d $SPOTIFY_DIR ]]; then
	cat >&2 <<-EOF
		Spotify not found at $SPOTIFY_DIR

		This needs the desktop client installed there — on Arch that is the AUR
		'spotify' package. If yours lives elsewhere, point SPOTIFY_DIR at it:

		    SPOTIFY_DIR=/path/to/spotify ./install.sh

		Note that spicetify patches whatever its own spotify_path points at, so
		the two have to agree. Flatpak and Snap installs are untested.
	EOF
	exit 1
fi

if [[ ! -x $SPICETIFY ]]; then
	cat >&2 <<-EOF
		spicetify not found at $SPICETIFY

		This is a patch against spicetify's bundled lyrics-plus app, so spicetify
		has to be installed first. It is not installed for you. See:

		    https://spicetify.app/docs/getting-started

		If yours is installed elsewhere, point SPICETIFY_HOME at it:

		    SPICETIFY_HOME=/path/to/.spicetify ./install.sh
	EOF
	exit 1
fi

# Spicetify reads "which Spotify is installed" from the version Spotify recorded
# at its LAST LAUNCH, and uses it both to judge whether its backup still matches
# and to choose version-specific patches for the bundle. Straight after a
# package upgrade — which is exactly when this runs from the pacman hook —
# that is still the old version, so the new client would be patched as if it
# were the old one. Record the version of the binary actually on disk first.
#
# Spotify rewrites prefs from memory when it exits, so if it is running now this
# can be overwritten with the old value — harmless, since the patching below has
# already used the right one, and the next launch records the truth anyway.
installed_version=$(strings -n 8 "$SPOTIFY_DIR/spotify" | grep -m1 -oE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+\.g[0-9a-f]+$' || true)
prefs_path=$(awk -F' *= *' '$1 == "prefs_path" { print $2; exit }' "$("$SPICETIFY" -c)" 2>/dev/null || true)
prefs_path=${prefs_path:-$HOME/.config/spotify/prefs}

if [[ -n $installed_version && -f $prefs_path ]]; then
	if grep -q '^app\.last-launched-version=' "$prefs_path"; then
		sed -i "s/^app\.last-launched-version=.*/app.last-launched-version=\"$installed_version\"/" "$prefs_path"
	else
		printf 'app.last-launched-version="%s"\n' "$installed_version" >> "$prefs_path"
	fi
fi

# Spicetify must be new enough for the installed Spotify, or lyrics-plus throws
# "Something went wrong" on the lyrics route and can take the client down with
# it. 2.43.0 added 1.2.86, 2.44.0 added 1.2.93, 2.45.0 added 1.2.96. A spicetify
# older than your Spotify is the thing to suspect first — and Spotify updates
# with ordinary system upgrades, so this floor has to move with it.
MIN_SPICETIFY=2.45.0
have=$("$SPICETIFY" -v | tr -d '[:space:]')
if [[ $(printf '%s\n%s\n' "$MIN_SPICETIFY" "$have" | sort -V | head -1) != "$MIN_SPICETIFY" ]]; then
	echo "==> spicetify $have is older than $MIN_SPICETIFY — upgrading"
	"$SPICETIFY" upgrade || true          # wipes CustomApps/; we patch after
	echo "    now $("$SPICETIFY" -v | tr -d '[:space:]')"
fi

echo "==> patching lyrics-plus"
# Remove first so re-running picks up changes to the patch set rather than
# short-circuiting on "already patched".
python3 "$HERE/patch.py" remove "$SPICE_HOME" >/dev/null 2>&1 || true
python3 "$HERE/patch.py" apply "$SPICE_HOME"

echo "==> installing gloss theme"
mkdir -p "$SPICE_HOME/Themes/lyric-gloss"
cp "$HERE/src/gloss.css" "$SPICE_HOME/Themes/lyric-gloss/user.css"
printf '[Base]\n' > "$SPICE_HOME/Themes/lyric-gloss/color.ini"

echo "==> installing playbar extension"
mkdir -p "$SPICE_HOME/Extensions"
cp "$HERE/src/lyric-gloss-playbar.js" "$SPICE_HOME/Extensions/"

echo "==> configuring spicetify"
# experimental_features MUST stay 0. At 1, apply writes ~258 Spotify feature
# flags into localStorage (key: spicetify-exp-features), including playback
# ones, and `spicetify restore` does NOT remove them. That breaks end-of-track
# auto-advance in a way that survives every obvious revert. See SPEC.md.
"$SPICETIFY" config experimental_features 0 >/dev/null
"$SPICETIFY" config always_enable_devtools 0 >/dev/null
# Stops the "a new version of Spicetify is available" banner appearing in the
# client. Upgrades are a deliberate act here — they wipe CustomApps/ and need
# install.sh re-run afterwards — so a nag in the UI is worse than useless.
"$SPICETIFY" config check_spicetify_update 0 >/dev/null
"$SPICETIFY" config custom_apps lyrics-plus >/dev/null
"$SPICETIFY" config extensions lyric-gloss-playbar.js >/dev/null
"$SPICETIFY" config current_theme lyric-gloss replace_colors 0 >/dev/null

if [[ ${LYRIC_GLOSS_HOOK:-} == 1 ]]; then
	# Run by the pacman hook: it is already root, has opened $SPOTIFY_DIR, and
	# restores ownership itself when this returns. No sudo, so no prompt in the
	# middle of a package transaction.
	echo "==> applying (permissions handled by the pacman hook)"
else
	echo "==> applying (needs sudo to write $SPOTIFY_DIR)"
	restore_perms() {
		sudo chown -R root:root "$SPOTIFY_DIR" 2>/dev/null || true
		sudo find "$SPOTIFY_DIR/Apps" -type d -exec chmod 755 {} + 2>/dev/null || true
		sudo find "$SPOTIFY_DIR/Apps" -type f -exec chmod 644 {} + 2>/dev/null || true
		sudo chmod 755 "$SPOTIFY_DIR" 2>/dev/null || true
	}
	sudo chmod a+wr "$SPOTIFY_DIR"
	sudo chmod -R a+wr "$SPOTIFY_DIR/Apps"
fi

# Set once the patched client has been taken down to rebuild it. If the script
# ends — failure or Ctrl-C — while this is set, Spotify is running stock on its
# next launch, and that must be said out loud: a silent stock client is exactly
# how a previous interrupted run went unnoticed until the next day.
client_torn_down=0

on_exit() {
	local status=$?
	if declare -F restore_perms >/dev/null; then
		restore_perms
	fi
	if ((status != 0 && client_torn_down)); then
		cat >&2 <<-EOF

			!! Stopped part way through rebuilding. Spotify is now UNPATCHED — no
			!! lyric translations after its next launch. Run this again to finish:

			    $HERE/install.sh
		EOF
	fi
}
trap on_exit EXIT

# Pick the least destructive route to a patched client.
#
# Rebuilding means backing up stock files, and a backup needs a stock client —
# so on an already-patched client it means restoring first, i.e. tearing down
# the working patch before a rebuild that can still fail, be rate limited, or be
# interrupted. A re-run that died a second in once left Spotify stock this way.
# So only rebuild when there is no other option:
#
#   stock files present          nothing patched to lose → rebuild from them
#   backup matches this Spotify
#     and this spicetify         re-apply in place → nothing torn down
#   otherwise                    restore + rebuild → the only destructive path
#
# "This Spotify" means the binary on disk, not spicetify's last-launched version
# — see the version recording near the top.
config_file=$("$SPICETIFY" -c)
backup_field() {
	awk -F' *= *' -v key="$1" '/^\[Backup\]/ { section = 1; next } /^\[/ { section = 0 } section && $1 == key { print $2; exit }' "$config_file"
}
backup_version=$(backup_field version)
backup_with=$(backup_field with)
spicetify_version=$("$SPICETIFY" -v | tr -d '[:space:]')
backup_folder="${XDG_STATE_HOME:-$HOME/.local/state}/spicetify/Backup"

# -n on every spicetify call: never let it relaunch Spotify. A Spotify started
# from this script's shell breaks end-of-track auto-advance
# (see docs/operations.md).
if compgen -G "$SPOTIFY_DIR/Apps/*.spa" >/dev/null; then
	if [[ -n $backup_version && $backup_version != "$installed_version" ]]; then
		echo "==> Spotify updated since the last install (${backup_version} → ${installed_version:-unknown})"
	else
		echo "==> building from stock Spotify files"
	fi
	# A package update leaves the old version's unpacked directories beside
	# the fresh archives. Drop them so the bundle is built from the archives
	# alone; `backup apply` discards any stale backup itself.
	for part in xpui login; do
		if [[ -f "$SPOTIFY_DIR/Apps/$part.spa" && -d "$SPOTIFY_DIR/Apps/$part" ]]; then
			rm -rf "${SPOTIFY_DIR:?}/Apps/${part:?}"
		fi
	done
	"$SPICETIFY" -n backup apply

elif [[ $backup_version == "$installed_version" && $backup_with == "$spicetify_version" ]] &&
	compgen -G "$backup_folder/*.spa" >/dev/null; then
	echo "==> re-applying in place (nothing is taken down)"
	"$SPICETIFY" -n apply

elif [[ $backup_version == "$installed_version" ]] && compgen -G "$backup_folder/*.spa" >/dev/null; then
	echo "==> spicetify changed (${backup_with:-unknown} → $spicetify_version): rebuilding"
	client_torn_down=1
	"$SPICETIFY" -n restore
	"$SPICETIFY" -n backup apply
	client_torn_down=0

else
	cat >&2 <<-EOF
		No stock copy of Spotify ${installed_version:-} to rebuild from: the app is
		already patched, and spicetify's backup is of ${backup_version:-nothing}.
		Reinstall the Spotify package to put the stock files back, then re-run:

		    sudo pacman -S spotify
	EOF
	exit 1
fi

echo "==> verifying"
fail=0
# A stock archive beside the unpacked bundle means Spotify loads the archive and
# ignores the patch — and the stale directory still greps as fully installed.
# That is exactly how a Spotify update presented: everything below "present",
# nothing actually running. So check the archives are gone first.
for part in xpui login; do
	[[ -f "$SPOTIFY_DIR/Apps/$part.spa" ]] && { echo "  STOCK ARCHIVE STILL PRESENT: Apps/$part.spa — Spotify will load it instead of the patch" >&2; fail=1; }
done
grep -rq ProviderAutoTranslate "$SPOTIFY_DIR/Apps/xpui/" || { echo "  MISSING: translation provider" >&2; fail=1; }
grep -q "nth-of-type(2)" "$SPOTIFY_DIR/Apps/xpui/user.css" || { echo "  MISSING: gloss stylesheet" >&2; fail=1; }
grep -rq "data-lyric-gloss-bound" "$SPOTIFY_DIR/Apps/xpui/" || { echo "  MISSING: playbar extension" >&2; fail=1; }
if ((fail)); then
	echo "  apply did not land — the client is unchanged. Nothing above is installed." >&2
	exit 1
fi
echo "  provider, stylesheet and playbar extension all present in the client"

echo
echo "Done. Quit Spotify and start it again from your launcher — not from this"
echo "terminal. The playbar lyrics button is now this app."
echo "There is nothing to configure — auto-translate to English, glossed below"
echo "the original, is baked in. To change the target language, edit patch.py"
echo "and re-run this script. See README.md."
