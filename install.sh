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

echo "==> applying (needs sudo to write $SPOTIFY_DIR)"
restore_perms() {
	sudo chown -R root:root "$SPOTIFY_DIR" 2>/dev/null || true
	sudo find "$SPOTIFY_DIR/Apps" -type d -exec chmod 755 {} + 2>/dev/null || true
	sudo find "$SPOTIFY_DIR/Apps" -type f -exec chmod 644 {} + 2>/dev/null || true
	sudo chmod 755 "$SPOTIFY_DIR" 2>/dev/null || true
}
trap restore_perms EXIT

sudo chmod a+wr "$SPOTIFY_DIR"
sudo chmod -R a+wr "$SPOTIFY_DIR/Apps"

# Always start from a pristine bundle. `backup apply` refuses outright when a
# backup exists and Apps/ is already patched — it will not back up a patched
# client — which silently leaves the previous build in place.
#
# But restoring is only safe when the backup belongs to the Spotify that is
# actually installed. Spicetify decides that from the version recorded at LAST
# LAUNCH, not from the binary, so after a package upgrade that has not been
# launched yet it believes the old backup still matches, and `restore` copies
# the previous version's bundle over the new client. Compare against the
# binary instead.
installed_version=$(strings -n 8 "$SPOTIFY_DIR/spotify" | grep -m1 -oE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+\.g[0-9a-f]+$' || true)
backup_version=$(awk -F' *= *' '/^\[Backup\]/ { section = 1; next } /^\[/ { section = 0 } section && $1 == "version" { print $2; exit }' "$("$SPICETIFY" -c)")

if [[ -n $backup_version && $backup_version != "$installed_version" ]]; then
	echo "==> Spotify updated since the last install (${backup_version} → ${installed_version:-unknown})"
	# The package puts fresh stock archives back and leaves the old version's
	# unpacked directories beside them. Drop those so the new bundle is built
	# from the new archives alone; `backup apply` then discards the stale
	# backup itself. Only where the archive exists — without it, the
	# directory is the client.
	for part in xpui login; do
		if [[ -f "$SPOTIFY_DIR/Apps/$part.spa" && -d "$SPOTIFY_DIR/Apps/$part" ]]; then
			rm -rf "${SPOTIFY_DIR:?}/Apps/${part:?}"
		fi
	done
else
	"$SPICETIFY" -n restore >/dev/null 2>&1 || true
fi

# -n: do not let spicetify relaunch Spotify. A Spotify started from this
# script's shell breaks end-of-track auto-advance (see docs/operations.md).
"$SPICETIFY" -n backup apply

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
