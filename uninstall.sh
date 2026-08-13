#!/usr/bin/env bash
# Remove lyric-gloss and return Spotify to a stock, unpatched client.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SPICE_HOME="${SPICETIFY_HOME:-$HOME/.spicetify}"
SPOTIFY_DIR="${SPOTIFY_DIR:-/opt/spotify}"
SPICETIFY="$SPICE_HOME/spicetify"

echo "==> restoring stock Spotify bundle"
restore_perms() {
	sudo chown -R root:root "$SPOTIFY_DIR" 2>/dev/null || true
	sudo find "$SPOTIFY_DIR/Apps" -type d -exec chmod 755 {} + 2>/dev/null || true
	sudo find "$SPOTIFY_DIR/Apps" -type f -exec chmod 644 {} + 2>/dev/null || true
	sudo chmod 755 "$SPOTIFY_DIR" 2>/dev/null || true
}
trap restore_perms EXIT

sudo chmod a+wr "$SPOTIFY_DIR"
sudo chmod -R a+wr "$SPOTIFY_DIR/Apps"
"$SPICETIFY" restore || true

echo "==> unpatching lyrics-plus"
python3 "$HERE/patch.py" remove "$SPICE_HOME" || true
rm -rf "$SPICE_HOME/Themes/lyric-gloss"

cat <<'EOF'

Bundle restored. Two things live in Spotify's localStorage and are NOT removed
by restore — clear them from the Lyrics settings, or with Spotify closed:

  lyrics-plus:*            settings + translation cache
  spicetify-exp-features   feature-flag overrides (only if experimental_features
                           was ever 1 — install.sh always sets it to 0)
EOF
