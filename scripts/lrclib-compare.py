#!/usr/bin/env python3
"""How much LRCLIB's hand-timed versions of a song disagree.

    lrclib-compare.py "<title> <artist>"

lyrics-plus falls back to LRCLIB when neither Spotify nor Musixmatch has a
song, and LRCLIB holds many volunteer-timed versions of popular tracks, often
against different releases. This prints each synced entry's length and where it
puts the first, twentieth and last lines, so a song whose lyrics run early or
late can be checked against the spread. See docs/operations.md.
"""

import json
import re
import sys
import urllib.parse
import urllib.request

STAMP = re.compile(r"^\[(\d+):(\d+(?:\.\d+)?)\]\s*\S", re.MULTILINE)


def main() -> int:
    if len(sys.argv) != 2 or not sys.argv[1].strip():
        print(__doc__.strip(), file=sys.stderr)
        return 2

    url = "https://lrclib.net/api/search?" + urllib.parse.urlencode({"q": sys.argv[1]})
    request = urllib.request.Request(url, headers={"x-user-agent": "lyric-gloss lrclib-compare"})
    with urllib.request.urlopen(request, timeout=15) as response:
        rows = json.load(response)

    synced = [row for row in rows if row.get("syncedLyrics") and row.get("duration")]
    if not synced:
        print("no synced entries on LRCLIB for that search")
        return 1

    print(f"{'length':>8}  {'line 1':>7}  {'line 20':>7}  {'last':>7}  track — artist")
    for row in sorted(synced, key=lambda r: r["duration"]):
        stamps = [int(m.group(1)) * 60 + float(m.group(2)) for m in STAMP.finditer(row["syncedLyrics"])]
        if not stamps:
            continue
        twentieth = f"{stamps[19]:7.2f}" if len(stamps) >= 20 else f"{'-':>7}"
        print(
            f"{row['duration']:8.1f}  {stamps[0]:7.2f}  {twentieth}  {stamps[-1]:7.2f}  "
            f"{row.get('trackName', '?')} — {row.get('artistName', '?')}"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
