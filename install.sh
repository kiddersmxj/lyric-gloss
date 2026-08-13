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

[[ -x $SPICETIFY ]] || { echo "spicetify not found at $SPICETIFY" >&2; exit 1; }

echo "==> patching lyrics-plus"
# Remove first so re-running picks up changes to the patch set rather than
# short-circuiting on "already patched".
python3 "$HERE/patch.py" remove "$SPICE_HOME" >/dev/null 2>&1 || true
python3 "$HERE/patch.py" apply "$SPICE_HOME"

echo "==> installing gloss theme"
mkdir -p "$SPICE_HOME/Themes/lyric-gloss"
cp "$HERE/src/gloss.css" "$SPICE_HOME/Themes/lyric-gloss/user.css"
printf '[Base]\n' > "$SPICE_HOME/Themes/lyric-gloss/color.ini"

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
# client — which silently leaves the previous build in place. Restoring first
# also handles the case where Spotify was upgraded since the last backup.
"$SPICETIFY" restore >/dev/null 2>&1 || true
"$SPICETIFY" backup apply

echo "==> verifying"
fail=0
grep -rq ProviderAutoTranslate "$SPOTIFY_DIR/Apps/xpui/" || { echo "  MISSING: translation provider" >&2; fail=1; }
grep -q "nth-of-type(2)" "$SPOTIFY_DIR/Apps/xpui/user.css" || { echo "  MISSING: gloss stylesheet" >&2; fail=1; }
grep -rq 'playbar-button") !== "false"' "$SPOTIFY_DIR/Apps/xpui/" || { echo "  MISSING: playbar button default" >&2; fail=1; }
if ((fail)); then
	echo "  apply did not land — the client is unchanged. Nothing above is installed." >&2
	exit 1
fi
echo "  provider, stylesheet and playbar button all present in the client"

echo
echo "Done. Restart Spotify. The playbar lyrics button is now this app."
echo "Then, on the translate icon inside the lyrics page:"
echo "  Translation Provider → <language> (auto-translate)"
echo "  Translation Display  → Below original"
