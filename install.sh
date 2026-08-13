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
"$SPICETIFY" backup apply

echo
echo "Done. Restart Spotify, then in the Lyrics view:"
echo "  Translation Provider → <language> (auto-translate)"
echo "  Translation Display  → Below original"
echo "  Alignment            → Left        (gear icon; defaults to Center)"
echo "  Playbar button       → on          (replaces Spotify's own lyrics button)"
