#!/usr/bin/env python3
"""Apply (or remove) the lyric-gloss patch to spicetify's bundled lyrics-plus.

`spicetify upgrade` replaces CustomApps/ wholesale, so this is re-runnable.
It is idempotent, and it refuses to touch anything if an anchor has moved
upstream rather than corrupting the file.

    python3 patch.py apply    ~/.spicetify
    python3 patch.py remove   ~/.spicetify
"""

import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

# (file, anchor, replacement) — anchor must appear exactly once.
EDITS = [
    (
        "index.js",
        'neteaseTranslation: null,\n\t\t\turi: "",',
        'neteaseTranslation: null,\n\t\t\tautoTranslation: null,\n\t\t\turi: "",',
    ),
    (
        "index.js",
        "\t\tthis._musixmatchTranslationRequestId = null;\n\t}",
        """\t\tthis._musixmatchTranslationRequestId = null;
\t\tthis._autoTranslateKey = null;
\t}

\t// Machine-translate the current lyrics for the auto-translate source.
\t// Called from lyricsSource(), which runs during render, so this must never
\t// setState synchronously — the request is keyed and resolves later.
\trequestAutoTranslation(uri, lyrics, sourceLang, targetLang) {
\t\tif (typeof ProviderAutoTranslate === "undefined" || !Array.isArray(lyrics) || !lyrics.length) return;

\t\tconst key = `${uri}::${targetLang}::${lyrics.length}::${lyrics[0]?.text ?? ""}`;
\t\tif (this._autoTranslateKey === key) return;
\t\tthis._autoTranslateKey = key;

\t\t// detectLanguage() only recognises CJK, so it is undefined for most
\t\t// languages. Let the service auto-detect unless there is an override.
\t\tconst override = CONFIG.visual["translate:detect-language-override"];
\t\tconst from = override !== "off" ? override.slice(0, 2) : /^[a-z]{2}$/.test(sourceLang ?? "") ? sourceLang : null;

\t\tProviderAutoTranslate.getTranslation(lyrics, uri, from, targetLang)
\t\t\t.then((translated) => {
\t\t\t\tif (this._autoTranslateKey !== key) return;
\t\t\t\tCACHE[uri] = { ...CACHE[uri], autoTranslation: translated };
\t\t\t\tthis.setState({ autoTranslation: translated });
\t\t\t})
\t\t\t.catch((error) => {
\t\t\t\t// Deliberately keep the key set. lyricsSource() runs on every
\t\t\t\t// render, which is every position tick, so clearing it here would
\t\t\t\t// re-fire the request on each tick for the rest of the song.
\t\t\t\t// Failures wait for the next track instead.
\t\t\t\tconsole.error("[auto-translate] failed", error);
\t\t\t});
\t}""",
    ),
    # Route the "autoTranslation:<lang>" menu value to the autoTranslation state key.
    (
        "index.js",
        '\tif (source.startsWith(MUSIXMATCH_TRANSLATION_PREFIX)) {',
        '\tif (source.startsWith("autoTranslation:")) {\n'
        '\t\treturn { key: "autoTranslation", language: null, autoTarget: source.slice("autoTranslation:".length) || "en" };\n'
        "\t}\n\n"
        '\tif (source.startsWith(MUSIXMATCH_TRANSLATION_PREFIX)) {',
    ),
    (
        "index.js",
        "\t\tif (CONFIG.visual.translate) {\n"
        "\t\t\tthis.state.currentLyrics = lyricsState[CONFIG.visual[`translation-mode:${friendlyLanguage}`]] ?? lyrics;",
        '\t\tif (translationSourceConfig.key === "autoTranslation") {\n'
        "\t\t\tthis.requestAutoTranslation(lyricsState.uri ?? this.state.uri, lyrics, lang, translationSourceConfig.autoTarget ?? \"en\");\n"
        "\t\t}\n\n"
        "\t\tif (CONFIG.visual.translate) {\n"
        "\t\t\tthis.state.currentLyrics = lyricsState[CONFIG.visual[`translation-mode:${friendlyLanguage}`]] ?? lyrics;",
    ),
    # Without this the whole translation menu is hidden for non-CJK songs,
    # because detectLanguage() returns undefined and hasTranslation is false.
    (
        "index.js",
        "\t\tconst hasTranslation = this.state.neteaseTranslation !== null || this.state.musixmatchTranslation !== null || hasMusixmatchLanguages;",
        "\t\t// Auto-translate works for any language, so a translation source is\n"
        "\t\t// always selectable — without this the menu is hidden for e.g. Spanish,\n"
        "\t\t// because detectLanguage() only ever resolves CJK.\n"
        "\t\tconst hasTranslation =\n"
        "\t\t\tthis.state.neteaseTranslation !== null ||\n"
        "\t\t\tthis.state.musixmatchTranslation !== null ||\n"
        "\t\t\thasMusixmatchLanguages ||\n"
        '\t\t\ttypeof ProviderAutoTranslate !== "undefined";',
    ),
    (
        "index.js",
        "\t\t\t\t\tneteaseTranslation: null,\n\t\t\t\t\t...tempState,",
        "\t\t\t\t\tneteaseTranslation: null,\n\t\t\t\t\tautoTranslation: null,\n\t\t\t\t\t...tempState,",
    ),
    # Defaults, so a fresh install behaves correctly with no settings to find.
    # These live in localStorage, which gets wiped whenever the translation
    # cache is cleared — baking the defaults in means that doesn't undo them.
    #
    # Replace Spotify's own playbar lyrics button with ours. The extension
    # already hides `.main-nowPlayingBar-lyricsButton` and the sidebar entry;
    # it was just gated off by default.
    (
        "index.js",
        '\t\t"playbar-button": getConfig("lyrics-plus:visual:playbar-button", false),',
        '\t\t"playbar-button": getConfig("lyrics-plus:visual:playbar-button", true),',
    ),
    (
        "PlaybarButton.js",
        '\tif (Spicetify.LocalStorage.get("lyrics-plus:visual:playbar-button") === "true") setPlaybarButton();',
        '\tif (Spicetify.LocalStorage.get("lyrics-plus:visual:playbar-button") !== "false") setPlaybarButton();',
    ),
    # Spotify's native lyrics are left-aligned; lyrics-plus centres by default.
    (
        "index.js",
        '\t\talignment: localStorage.getItem("lyrics-plus:visual:alignment") || "center",',
        '\t\talignment: localStorage.getItem("lyrics-plus:visual:alignment") || "left",',
    ),
    # Textual, not a JSON round-trip: json.dumps would reformat the whole file
    # and `remove` could not restore it byte-for-byte.
    (
        "manifest.json",
        '\t\t"ProviderLRCLIB.js",',
        '\t\t"ProviderLRCLIB.js",\n\t\t"ProviderAutoTranslate.js",',
    ),
    (
        "OptionsMenu.js",
        '\t\t\t\tneteaseTranslation: "Chinese (Netease)",\n\t\t\t};\n\t\t}',
        '\t\t\t\tneteaseTranslation: "Chinese (Netease)",\n\t\t\t};\n\t\t}\n\n'
        "\t\t// Always offered: unlike Musixmatch community translations, which\n"
        "\t\t// exist for only a fraction of tracks, this covers every song.\n"
        '\t\tif (typeof ProviderAutoTranslate !== "undefined") {\n'
        "\t\t\tfor (const [code, label] of Object.entries(ProviderAutoTranslate.TARGETS)) {\n"
        "\t\t\t\tsourceOptions[`autoTranslation:${code}`] = `${label} (auto-translate)`;\n"
        "\t\t\t}\n\t\t}",
    ),
]


def app_dir(root: Path) -> Path:
    path = root / "CustomApps" / "lyrics-plus"
    if not path.is_dir():
        sys.exit(f"lyrics-plus not found at {path}")
    return path


def is_patched(app: Path) -> bool:
    return "ProviderAutoTranslate" in (app / "index.js").read_text()


def apply(app: Path) -> None:
    if is_patched(app):
        print("already patched — nothing to do")
        return

    missing = [f"{name}: {anchor.splitlines()[0][:60]}…" for name, anchor, _ in EDITS if (app / name).read_text().count(anchor) != 1]
    if missing:
        print("upstream changed, patch NOT applied. Anchors not found exactly once:", file=sys.stderr)
        for item in missing:
            print(f"  {item}", file=sys.stderr)
        sys.exit(1)

    shutil.copy(HERE / "src" / "ProviderAutoTranslate.js", app / "ProviderAutoTranslate.js")

    for name, anchor, replacement in EDITS:
        path = app / name
        path.write_text(path.read_text().replace(anchor, replacement))

    print("patched lyrics-plus")


def remove(app: Path) -> None:
    if not is_patched(app):
        print("not patched — nothing to do")
        return

    for name, anchor, replacement in reversed(EDITS):
        path = app / name
        path.write_text(path.read_text().replace(replacement, anchor))

    (app / "ProviderAutoTranslate.js").unlink(missing_ok=True)

    print("removed patch from lyrics-plus")


if __name__ == "__main__":
    if len(sys.argv) != 3 or sys.argv[1] not in {"apply", "remove"}:
        sys.exit(__doc__)
    {"apply": apply, "remove": remove}[sys.argv[1]](app_dir(Path(sys.argv[2]).expanduser()))
