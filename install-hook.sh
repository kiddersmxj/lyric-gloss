#!/usr/bin/env bash
# Install a pacman hook that re-applies lyric-gloss after every Spotify update.
#
# Without it, each update of the spotify package silently turns the gloss off
# until install.sh is run again. Arch (pacman) only.
#
# Installs two root-owned files:
#   /etc/pacman.d/hooks/lyric-gloss.hook      the trigger
#   /usr/local/lib/lyric-gloss/reapply         the action, with this user and
#                                              this repository's path filled in
#
# The action runs the installer from THIS directory, as you — so if you move the
# repository, run this again. Run as your normal user; it asks for sudo itself.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ((EUID == 0)); then
	echo "Run this as your normal user, not with sudo — it needs to know who you are." >&2
	exit 1
fi
if ! command -v pacman >/dev/null; then
	echo "pacman not found: the hook is Arch-only. Re-run install.sh after each Spotify update instead." >&2
	exit 1
fi
if [[ $HERE == *'|'* ]]; then
	echo "Repository path contains '|', which this script cannot substitute safely: $HERE" >&2
	exit 1
fi

action=$(mktemp)
trap 'rm -f "$action"' EXIT
sed -e "s|@USER@|$USER|g" -e "s|@REPO@|$HERE|g" "$HERE/hooks/reapply" > "$action"

echo "==> installing pacman hook (needs sudo)"
sudo install -D -o root -g root -m 755 "$action" /usr/local/lib/lyric-gloss/reapply
sudo install -D -o root -g root -m 644 "$HERE/hooks/lyric-gloss.hook" /etc/pacman.d/hooks/lyric-gloss.hook

cat <<EOF

Done. After every Spotify update, pacman will re-apply lyric-gloss as $USER,
from $HERE.

To test it now without waiting for an update, reinstall the current package:

    sudo pacman -S spotify

You should see ":: lyric-gloss: re-applied." near the end. The full log is
/var/log/lyric-gloss.log. To remove the hook, run ./uninstall.sh.
EOF
