#!/usr/bin/env python3
"""Apply (or remove) the lyric-gloss patch to spicetify's bundled lyrics-plus.

`spicetify upgrade` replaces CustomApps/ wholesale, so this is re-runnable.
It is idempotent, and it refuses to touch anything if an anchor has moved
upstream rather than corrupting the file.

    python3 patch.py apply    ~/.spicetify
    python3 patch.py remove   ~/.spicetify
    python3 patch.py check    ~/.spicetify   # which anchors a release breaks
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
    # The auto-translate request method, added to the lyrics container class.
    # Anchored on the start of the method that follows the constructor, NOT on
    # the constructor's last line: spicetify 2.45.0 added a field there
    # (`this._romanizing = false;`) and the old anchor stopped matching. The
    # method's own state is initialised lazily for the same reason — an unset
    # key simply compares unequal — so the constructor is not touched at all.
    (
        "index.js",
        '\tinfoFromTrack(track) {',
        '\t// Machine-translate the current lyrics for the auto-translate source.\n\t// Called from lyricsSource(), which runs during render, so this must never\n\t// setState synchronously — the request is keyed and resolves later.\n\trequestAutoTranslation(uri, lyrics, sourceLang, targetLang) {\n\t\tif (typeof ProviderAutoTranslate === "undefined" || !Array.isArray(lyrics) || !lyrics.length) return;\n\n\t\tconst key = `${uri}::${targetLang}::${lyrics.length}::${lyrics[0]?.text ?? ""}`;\n\t\tif (this._autoTranslateKey === key) return;\n\t\tthis._autoTranslateKey = key;\n\n\t\t// detectLanguage() only recognises CJK, so it is undefined for most\n\t\t// languages. Let the service auto-detect unless there is an override.\n\t\tconst override = CONFIG.visual["translate:detect-language-override"];\n\t\tconst from = override !== "off" ? override.slice(0, 2) : /^[a-z]{2}$/.test(sourceLang ?? "") ? sourceLang : null;\n\n\t\tProviderAutoTranslate.getTranslation(lyrics, uri, from, targetLang)\n\t\t\t.then((translated) => {\n\t\t\t\tif (this._autoTranslateKey !== key) return;\n\t\t\t\tCACHE[uri] = { ...CACHE[uri], autoTranslation: translated };\n\t\t\t\tthis.setState({ autoTranslation: translated });\n\t\t\t})\n\t\t\t.catch((error) => {\n\t\t\t\t// Deliberately keep the key set. lyricsSource() runs on every\n\t\t\t\t// render, which is every position tick, so clearing it here would\n\t\t\t\t// re-fire the request on each tick for the rest of the song.\n\t\t\t\t// Failures wait for the next track instead.\n\t\t\t\tconsole.error("[auto-translate] failed", error);\n\t\t\t});\n\t}\n\n\tinfoFromTrack(track) {',
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
    # NOTE: lyrics-plus's own PlaybarButton.js is deliberately left OFF. It
    # appends a stylesheet hiding the native lyrics button *before* calling
    # Spicetify.Playbar.Button().register(), so when that API doesn't match the
    # running Spotify build you end up with no lyrics button at all. The
    # lyric-gloss-playbar extension hijacks the native button instead, which
    # cannot fail that way. See docs/operations.md.
    #
    # Spotify's native lyrics are left-aligned; lyrics-plus centres by default.
    # This default is baked into the source because localStorage is wiped
    # whenever the translation cache is cleared.
    (
        "index.js",
        '\t\talignment: localStorage.getItem("lyrics-plus:visual:alignment") || "center",',
        '\t\talignment: "left",',
    ),
    # The whole point of the tool: auto-detected source, glossed underneath.
    # Defaults rather than settings, so there is nothing to configure and
    # clearing the cache can't silently turn the gloss off.
    (
        "index.js",
        '\t\t"translate:translated-lyrics-source": localStorage.getItem("lyrics-plus:visual:translate:translated-lyrics-source") || "none",',
        '\t\t"translate:translated-lyrics-source": "autoTranslation:en",',
    ),
    (
        "index.js",
        '\t\t"translate:display-mode": localStorage.getItem("lyrics-plus:visual:translate:display-mode") || "replace",',
        '\t\t"translate:display-mode": "below",',
    ),
    # Expanded view, not the compact one — compact defaults on upstream.
    (
        "index.js",
        '\t\t"synced-compact": getConfig("lyrics-plus:visual:synced-compact"),',
        '\t\t"synced-compact": false,',
    ),
    # Lyric sources, most accurately timed first. lyrics-plus takes the FIRST
    # source that has any lyrics, and upstream puts LRCLIB first. LRCLIB is
    # hand-timed by volunteers against whatever release they had: measured for
    # one popular track, the 11 entries it accepts as the same recording (within
    # 2s of its length) start the first line anywhere from 6s to 28s in, and one
    # times the last line past the end of the track. So lyrics ran early on one
    # song and late on the next. Spotify's own lyrics are timed to the exact
    # recording, and Musixmatch is looked up by that same track ID; LRCLIB stays
    # as the fallback. Forced, not defaulted: the menu that sets it is hidden.
    # The parse below still validates it against the provider list.
    (
        "index.js",
        '\tprovidersOrder: localStorage.getItem("lyrics-plus:services-order"),',
        '\tprovidersOrder: JSON.stringify(["spotify", "musixmatch", "lrclib", "netease", "genius", "local"]),',
    ),
    # Lock to synced (mode 1) so the karaoke/synced/unsynced tabs are moot.
    (
        "index.js",
        '\tlocked: localStorage.getItem("lyrics-plus:lock-mode") || "-1",',
        '\tlocked: "1",',
    ),
    # --- auto-scroll to the current line on track change --------------------
    # Two upstream bugs stop the expanded page snapping to the top when the
    # next song's lyrics load, the way Spotify's native pane does.
    #
    # 1. The scroll effect keys off `lyrics[0].text`, and a track's first entry
    #    is very often a pause marker. Consecutive tracks then share the same
    #    id and the effect never re-fires. Including the track URI makes it
    #    genuinely unique per song.
    (
        "Pages.js",
        "\t// Reset scroll state when lyrics change\n"
        "\tuseEffect(() => {\n"
        "\t\tinitialScroll.current = true;\n"
        "\t}, [lyrics]);\n"
        "\n"
        "\tconst lyricsId = lyrics[0].text;",
        "\t// Reset scroll state when lyrics change\n"
        "\tuseEffect(() => {\n"
        "\t\tinitialScroll.current = true;\n"
        "\t}, [lyrics]);\n"
        "\n"
        "\t// Track URI included deliberately: lyrics[0].text is often a pause\n"
        "\t// marker, so consecutive tracks share it and the scroll effect below\n"
        "\t// never re-fires — leaving the new song scrolled wherever the last\n"
        "\t// one ended.\n"
        "\tconst lyricsId = `${Spicetify.Player?.data?.item?.uri ?? \"\"}::${lyrics[0].text}`;",
    ),
    # 3. Scrubbing. Upstream only follows the active line when it is already on
    #    screen, so seeking somewhere far away leaves the page where it was. The
    #    in-viewport guard is worth keeping for normal playback — it stops the
    #    page yanking you back if you scroll off to read ahead — so distinguish
    #    the two: a seek moves the active line by more than one, playback
    #    advances it by exactly one.
    (
        "Pages.js",
        "\tuseEffect(() => {\n"
        "\t\tif (activeLineRef.current && (initialScroll.current || isInViewport(activeLineRef.current))) {",
        "\tconst lastLineIndex = useRef(-1);\n"
        "\tconst lastUserScroll = useRef(0);\n"
        "\n"
        "\t// Note manual scrolling so auto-follow can stand aside for a moment.\n"
        "\t// `wheel`/`touchmove` rather than `scroll`: scrollIntoView() below\n"
        "\t// fires `scroll`, which would suspend the behaviour it implements.\n"
        "\tuseEffect(() => {\n"
        "\t\tconst note = () => {\n"
        "\t\t\tlastUserScroll.current = Date.now();\n"
        "\t\t};\n"
        '\t\twindow.addEventListener("wheel", note, { passive: true });\n'
        '\t\twindow.addEventListener("touchmove", note, { passive: true });\n'
        "\t\treturn () => {\n"
        '\t\t\twindow.removeEventListener("wheel", note);\n'
        '\t\t\twindow.removeEventListener("touchmove", note);\n'
        "\t\t};\n"
        "\t}, []);\n"
        "\n"
        "\tuseEffect(() => {\n"
        "\t\t// A scrub jumps the active line by more than one. Follow it even when\n"
        "\t\t// the target is off-screen; single-line advances keep the upstream\n"
        "\t\t// behaviour so manual scrolling during playback is not overridden.\n"
        "\t\tconst jumped = lastLineIndex.current !== -1 && Math.abs(activeLineIndex - lastLineIndex.current) > 1;\n"
        "\t\tlastLineIndex.current = activeLineIndex;\n"
        "\n"
        "\t\t// Self-healing. Upstream's in-viewport guard is a one-way door: once\n"
        "\t\t// the active line drifts off-screen, every later advance is a single\n"
        "\t\t// line, so the guard never passes again and following stops for good.\n"
        "\t\t// Resume unless the user actually scrolled in the last few seconds.\n"
        "\t\tconst userIdle = Date.now() - lastUserScroll.current > 4000;\n"
        "\n"
        "\t\tif (activeLineRef.current && (initialScroll.current || jumped || userIdle || isInViewport(activeLineRef.current))) {",
    ),
    # 4. Snap to the top on track change, deterministically. Chained onto the
    #    refs added above. The conditional effect below decides whether to
    #    scroll from activeLineIndex and viewport state, and across a track
    #    boundary both have proved unreliable — the page kept ending up wherever
    #    the previous song finished. This does not consult either.
    (
        "Pages.js",
        "\tconst lastLineIndex = useRef(-1);\n\tconst lastUserScroll = useRef(0);\n",
        "\tconst lastLineIndex = useRef(-1);\n"
        "\tconst lastUserScroll = useRef(0);\n"
        "\n"
        "\t// New track: reset the follow state and put the page back at the top.\n"
        "\t//\n"
        "\t// Deferred across frames deliberately. At the moment the lyrics change\n"
        "\t// the new content is not laid out yet, so scrolling immediately does\n"
        "\t// nothing at all — the page then sits where the previous song ended\n"
        "\t// until the first line is reached and the follow effect takes over,\n"
        "\t// which reads as the jump arriving late rather than not happening.\n"
        "\tuseEffect(() => {\n"
        "\t\tlastLineIndex.current = -1;\n"
        "\t\tlastUserScroll.current = 0;\n"
        "\t\tinitialScroll.current = true;\n"
        "\n"
        "\t\tconst started = Date.now();\n"
        "\t\tlet handle = 0;\n"
        "\t\tlet logged = false;\n"
        "\n"
        "\t\tconst toTop = () => {\n"
        "\t\t\t// Walk up to whatever actually scrolls. Overflowing is NOT the same\n"
        "\t\t\t// as scrollable: .lyrics-lyricsContainer-LyricsContainer overflows\n"
        "\t\t\t// its parent but has overflow-y: visible, so setting scrollTop on\n"
        "\t\t\t// it does nothing. The real scroller is an unnamed OverlayScrollbars\n"
        "\t\t\t// viewport several levels up. Check the computed overflow.\n"
        "\t\t\tconst scrollable = (el) => {\n"
        "\t\t\t\tconst oy = getComputedStyle(el).overflowY;\n"
        '\t\t\t\treturn (oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight;\n'
        "\t\t\t};\n"
        "\n"
        "\t\t\tlet node = pageRef.current?.parentElement;\n"
        "\t\t\twhile (node && !scrollable(node)) node = node.parentElement;\n"
        "\n"
        "\t\t\tif (node) {\n"
        "\t\t\t\tnode.scrollTop = 0;\n"
        "\t\t\t} else if (!logged) {\n"
        "\t\t\t\tlogged = true;\n"
        '\t\t\t\tconsole.warn("[lyric-gloss] no scrollable ancestor found for the lyrics page");\n'
        "\t\t\t}\n"
        "\n"
        "\t\t\t// Keep going until the new lyrics have actually laid out — height\n"
        "\t\t\t// is zero for a while, and a short fixed budget expired before the\n"
        "\t\t\t// content existed. Stops early the moment the user scrolls.\n"
        "\t\t\tif (Date.now() - started < 3000 && lastUserScroll.current === 0) {\n"
        "\t\t\t\thandle = requestAnimationFrame(toTop);\n"
        "\t\t\t}\n"
        "\t\t};\n"
        "\n"
        "\t\thandle = requestAnimationFrame(toTop);\n"
        "\t\treturn () => cancelAnimationFrame(handle);\n"
        "\t}, [lyricsId]);\n",
    ),
    # Jumps are instant rather than animated — smooth-scrolling the length of a
    # song looks broken.
    (
        "Pages.js",
        '\t\t\t\tbehavior: initialScroll.current ? "auto" : "smooth",',
        '\t\t\t\tbehavior: initialScroll.current || jumped ? "auto" : "smooth",',
    ),
    # 2. On a new track the active line is index 0, and upstream returns early
    #    without scrolling whenever the first line starts soon. That is exactly
    #    the case where the page most needs to snap back to the top.
    (
        "Pages.js",
        "\t\t\t\t// If the intro is very short (e.g. less than 300ms), don't focus it\n"
        "\t\t\t\tif (nextStart && nextStart - position < 300) {\n"
        "\t\t\t\t\tinitialScroll.current = false;\n"
        "\t\t\t\t\treturn;\n"
        "\t\t\t\t}",
        "\t\t\t\t// Upstream bailed out here for short intros, which left a new\n"
        "\t\t\t\t// track scrolled to wherever the previous one finished. Always\n"
        "\t\t\t\t// scroll — snapping to the top is the whole point.\n"
        "\t\t\t\tvoid nextStart;",
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


# Edits this patch set used to make and no longer does. `remove` only knows how
# to reverse the current EDITS, so without this a shipped-then-retired edit
# would be stranded in an already-patched tree forever. (patched, original)
RETIRED = [
    # Pre-2.45.0 form of the request method: anchored on the constructor's last
    # line and initialised its key there. spicetify 2.45.0 added a field to that
    # constructor, so the anchor stopped matching and install refused.
    (
        "index.js",
        '\t\tthis._musixmatchTranslationRequestId = null;\n\t\tthis._autoTranslateKey = null;\n\t}\n\n\t// Machine-translate the current lyrics for the auto-translate source.\n\t// Called from lyricsSource(), which runs during render, so this must never\n\t// setState synchronously — the request is keyed and resolves later.\n\trequestAutoTranslation(uri, lyrics, sourceLang, targetLang) {\n\t\tif (typeof ProviderAutoTranslate === "undefined" || !Array.isArray(lyrics) || !lyrics.length) return;\n\n\t\tconst key = `${uri}::${targetLang}::${lyrics.length}::${lyrics[0]?.text ?? ""}`;\n\t\tif (this._autoTranslateKey === key) return;\n\t\tthis._autoTranslateKey = key;\n\n\t\t// detectLanguage() only recognises CJK, so it is undefined for most\n\t\t// languages. Let the service auto-detect unless there is an override.\n\t\tconst override = CONFIG.visual["translate:detect-language-override"];\n\t\tconst from = override !== "off" ? override.slice(0, 2) : /^[a-z]{2}$/.test(sourceLang ?? "") ? sourceLang : null;\n\n\t\tProviderAutoTranslate.getTranslation(lyrics, uri, from, targetLang)\n\t\t\t.then((translated) => {\n\t\t\t\tif (this._autoTranslateKey !== key) return;\n\t\t\t\tCACHE[uri] = { ...CACHE[uri], autoTranslation: translated };\n\t\t\t\tthis.setState({ autoTranslation: translated });\n\t\t\t})\n\t\t\t.catch((error) => {\n\t\t\t\t// Deliberately keep the key set. lyricsSource() runs on every\n\t\t\t\t// render, which is every position tick, so clearing it here would\n\t\t\t\t// re-fire the request on each tick for the rest of the song.\n\t\t\t\t// Failures wait for the next track instead.\n\t\t\t\tconsole.error("[auto-translate] failed", error);\n\t\t\t});\n\t}',
        '\t\tthis._musixmatchTranslationRequestId = null;\n\t}',
    ),
    # Third form of the snap-to-top: retried for 3s, but walked up looking for
    # an ancestor whose content overflows. Overflowing is not the same as
    # scrollable — it stopped on .lyrics-lyricsContainer-LyricsContainer,
    # which has overflow-y: visible and ignores scrollTop entirely.
    (
        "Pages.js",
        '\tconst lastLineIndex = useRef(-1);\n\tconst lastUserScroll = useRef(0);\n\n\t// New track: reset the follow state and put the page back at the top.\n\t//\n\t// Deferred across frames deliberately. At the moment the lyrics change\n\t// the new content is not laid out yet, so scrolling immediately does\n\t// nothing at all — the page then sits where the previous song ended\n\t// until the first line is reached and the follow effect takes over,\n\t// which reads as the jump arriving late rather than not happening.\n\tuseEffect(() => {\n\t\tlastLineIndex.current = -1;\n\t\tlastUserScroll.current = 0;\n\t\tinitialScroll.current = true;\n\n\t\tconst started = Date.now();\n\t\tlet handle = 0;\n\t\tlet logged = false;\n\n\t\tconst toTop = () => {\n\t\t\t// Walk up to whatever actually scrolls — Spotify\'s shared main-view\n\t\t\t// container, managed by OverlayScrollbars, not anything we own.\n\t\t\tlet node = pageRef.current?.parentElement;\n\t\t\twhile (node && node.scrollHeight <= node.clientHeight) node = node.parentElement;\n\n\t\t\tif (node) {\n\t\t\t\tif (!logged) {\n\t\t\t\t\tlogged = true;\n\t\t\t\t\tconsole.log("[lyric-gloss] scroller", node.className || node.tagName, `${node.scrollHeight}/${node.clientHeight} top=${node.scrollTop}`);\n\t\t\t\t}\n\t\t\t\tnode.scrollTop = 0;\n\t\t\t}\n\n\t\t\t// Keep going until the new lyrics have actually laid out — height\n\t\t\t// is zero for a while, and a short fixed budget expired before the\n\t\t\t// content existed. Stops early the moment the user scrolls.\n\t\t\tif (Date.now() - started < 3000 && lastUserScroll.current === 0) {\n\t\t\t\thandle = requestAnimationFrame(toTop);\n\t\t\t}\n\t\t};\n\n\t\thandle = requestAnimationFrame(toTop);\n\t\treturn () => cancelAnimationFrame(handle);\n\t}, [lyricsId]);\n',
        '\tconst lastLineIndex = useRef(-1);\n\tconst lastUserScroll = useRef(0);\n',
    ),
    # Second form of the snap-to-top: deferred, but only 12 frames (~200ms),
    # which expired before the new lyrics had laid out. Text taken verbatim
    # from a tree that had it installed, so the revert is exact.
    (
        "Pages.js",
        '\tconst lastLineIndex = useRef(-1);\n\tconst lastUserScroll = useRef(0);\n\n\t// New track: reset the follow state and put the page back at the top.\n\t//\n\t// Deferred across frames deliberately. At the moment the lyrics change\n\t// the new content is not laid out yet, so scrolling immediately does\n\t// nothing at all — the page then sits where the previous song ended\n\t// until the first line is reached and the follow effect takes over,\n\t// which reads as the jump arriving late rather than not happening.\n\tuseEffect(() => {\n\t\tlastLineIndex.current = -1;\n\t\tlastUserScroll.current = 0;\n\t\tinitialScroll.current = true;\n\n\t\tlet frame = 0;\n\t\tlet handle = 0;\n\n\t\tconst toTop = () => {\n\t\t\tconst el = pageRef.current;\n\t\t\tif (el) {\n\t\t\t\t// Walk up to whatever actually scrolls — it is Spotify\'s shared\n\t\t\t\t// main-view container, not anything lyrics-plus owns.\n\t\t\t\tlet node = el.parentElement;\n\t\t\t\twhile (node && node.scrollHeight <= node.clientHeight) node = node.parentElement;\n\t\t\t\tif (node) node.scrollTop = 0;\n\t\t\t\telse el.scrollIntoView({ behavior: "auto", block: "start", inline: "nearest" });\n\t\t\t}\n\t\t\tif (++frame < 12) handle = requestAnimationFrame(toTop);\n\t\t};\n\n\t\thandle = requestAnimationFrame(toTop);\n\t\treturn () => cancelAnimationFrame(handle);\n\t}, [lyricsId]);\n',
        '\tconst lastLineIndex = useRef(-1);\n\tconst lastUserScroll = useRef(0);\n',
    ),
    # First form of the deterministic snap-to-top: scrolled immediately on the
    # lyrics change, before the new content was laid out, so it did nothing.
    (
        "Pages.js",
        "\tconst lastLineIndex = useRef(-1);\n"
        "\tconst lastUserScroll = useRef(0);\n"
        "\n"
        "\t// New track: reset the follow state and put the page back at the top.\n"
        "\t// pageRef is the page container, so scrolling it to `start` returns the\n"
        "\t// shared main-view scroller to the beginning of the lyrics.\n"
        "\tuseEffect(() => {\n"
        "\t\tlastLineIndex.current = -1;\n"
        "\t\tlastUserScroll.current = 0;\n"
        "\t\tinitialScroll.current = true;\n"
        '\t\tpageRef.current?.scrollIntoView({ behavior: "auto", block: "start", inline: "nearest" });\n'
        "\t}, [lyricsId]);\n",
        "\tconst lastLineIndex = useRef(-1);\n\tconst lastUserScroll = useRef(0);\n",
    ),
    # First form of the scrub fix: followed jumps, but kept upstream's
    # in-viewport guard for single-line advances, which meant that once the
    # active line drifted off-screen following stopped permanently.
    (
        "Pages.js",
        "\tconst lastLineIndex = useRef(-1);\n"
        "\n"
        "\tuseEffect(() => {\n"
        "\t\t// A scrub jumps the active line by more than one. Follow it even when\n"
        "\t\t// the target is off-screen; single-line advances keep the upstream\n"
        "\t\t// behaviour so manual scrolling during playback is not overridden.\n"
        "\t\tconst jumped = lastLineIndex.current !== -1 && Math.abs(activeLineIndex - lastLineIndex.current) > 1;\n"
        "\t\tlastLineIndex.current = activeLineIndex;\n"
        "\n"
        "\t\tif (activeLineRef.current && (initialScroll.current || jumped || isInViewport(activeLineRef.current))) {",
        "\tuseEffect(() => {\n"
        "\t\tif (activeLineRef.current && (initialScroll.current || isInViewport(activeLineRef.current))) {",
    ),
    (
        "index.js",
        '\t\t"translate:translated-lyrics-source": localStorage.getItem("lyrics-plus:visual:translate:translated-lyrics-source") || "autoTranslation:en",',
        '\t\t"translate:translated-lyrics-source": localStorage.getItem("lyrics-plus:visual:translate:translated-lyrics-source") || "none",',
    ),
    (
        "index.js",
        '\t\t"translate:display-mode": localStorage.getItem("lyrics-plus:visual:translate:display-mode") || "below",',
        '\t\t"translate:display-mode": localStorage.getItem("lyrics-plus:visual:translate:display-mode") || "replace",',
    ),
    (
        "index.js",
        '\t\t"synced-compact": getConfig("lyrics-plus:visual:synced-compact", false),',
        '\t\t"synced-compact": getConfig("lyrics-plus:visual:synced-compact"),',
    ),
    (
        "index.js",
        '\tlocked: localStorage.getItem("lyrics-plus:lock-mode") || "1",',
        '\tlocked: localStorage.getItem("lyrics-plus:lock-mode") || "-1",',
    ),
    (
        "index.js",
        '\t\talignment: localStorage.getItem("lyrics-plus:visual:alignment") || "left",',
        '\t\talignment: localStorage.getItem("lyrics-plus:visual:alignment") || "center",',
    ),
    (
        "index.js",
        '\t\t"playbar-button": getConfig("lyrics-plus:visual:playbar-button", true),',
        '\t\t"playbar-button": getConfig("lyrics-plus:visual:playbar-button", false),',
    ),
    (
        "PlaybarButton.js",
        '\tif (Spicetify.LocalStorage.get("lyrics-plus:visual:playbar-button") !== "false") setPlaybarButton();',
        '\tif (Spicetify.LocalStorage.get("lyrics-plus:visual:playbar-button") === "true") setPlaybarButton();',
    ),
]


def undo_retired(app: Path) -> None:
    for name, patched, original in RETIRED:
        path = app / name
        # A retired edit can name a file upstream has since dropped. Nothing to
        # sweep there, and crashing would take both apply and remove with it.
        if not path.is_file():
            continue
        text = path.read_text()
        if patched in text:
            path.write_text(text.replace(patched, original))
            print(f"  reverted retired edit in {name}")


def app_dir(root: Path) -> Path:
    path = root / "CustomApps" / "lyrics-plus"
    if not path.is_dir():
        sys.exit(f"lyrics-plus not found at {path}")
    return path


def is_patched(app: Path) -> bool:
    return "ProviderAutoTranslate" in (app / "index.js").read_text()


def apply(app: Path) -> None:
    undo_retired(app)

    if is_patched(app):
        print("already patched — nothing to do")
        return

    # Validate and build sequentially in memory, then write only if every edit
    # succeeded. Sequential matters: an edit may legitimately anchor on text an
    # earlier edit introduced. Deferring the writes keeps it atomic, so a failure
    # half way through leaves the app untouched rather than half patched.
    staged: dict[str, str] = {}

    for name, anchor, replacement in EDITS:
        text = staged.get(name) or (app / name).read_text()
        if text.count(anchor) != 1:
            print("upstream changed, patch NOT applied. Anchor not found exactly once:", file=sys.stderr)
            print(f"  {name}: {anchor.splitlines()[0][:70]}…", file=sys.stderr)
            sys.exit(1)
        staged[name] = text.replace(anchor, replacement)

    shutil.copy(HERE / "src" / "ProviderAutoTranslate.js", app / "ProviderAutoTranslate.js")

    for name, text in staged.items():
        (app / name).write_text(text)

    print("patched lyrics-plus")


def check(app: Path) -> None:
    """List every anchor that does not match, without writing anything.

    For a new lyrics-plus release: apply stops at the first moved anchor, which
    turns re-anchoring into one install attempt per broken edit. An
    already-patched tree is first unpatched in memory, so its own replacements
    are not reported as missing anchors. An edit that anchors on text an earlier
    edit introduces will also fail if that earlier edit did — fix from the top.
    """
    texts: dict[str, str] = {}

    def read(name: str) -> str:
        if name not in texts:
            text = (app / name).read_text()
            for retired_name, patched, original in RETIRED:
                if retired_name == name:
                    text = text.replace(patched, original)
            for edit_name, anchor, replacement in reversed(EDITS):
                if edit_name == name:
                    text = text.replace(replacement, anchor)
            texts[name] = text
        return texts[name]

    broken = []
    for index, (name, anchor, replacement) in enumerate(EDITS):
        text = read(name)
        count = text.count(anchor)
        if count == 1:
            texts[name] = text.replace(anchor, replacement)
        else:
            broken.append((index, name, count, anchor))

    if not broken:
        print(f"all {len(EDITS)} anchors match")
        return

    print(f"{len(broken)} of {len(EDITS)} anchors do not match exactly once:")
    for index, name, count, anchor in broken:
        first = anchor.strip().splitlines()[0][:70]
        print(f"  edit {index:>2}  {name:<15} found {count}x  {first}")
    sys.exit(1)


def remove(app: Path) -> None:
    undo_retired(app)

    if not is_patched(app):
        # `spicetify upgrade` swaps lyrics-plus's own files for stock copies but
        # leaves extra files alone, so the provider can outlive the patch. Our
        # file either way, so clean it up even when there is nothing to unpatch.
        provider = app / "ProviderAutoTranslate.js"
        if provider.exists():
            provider.unlink()
            print("not patched — removed a leftover ProviderAutoTranslate.js")
        else:
            print("not patched — nothing to do")
        return

    # Reverse order, for the same chaining reason as apply().
    staged: dict[str, str] = {}

    for name, anchor, replacement in reversed(EDITS):
        text = staged.get(name) or (app / name).read_text()
        staged[name] = text.replace(replacement, anchor)

    for name, text in staged.items():
        (app / name).write_text(text)

    (app / "ProviderAutoTranslate.js").unlink(missing_ok=True)

    print("removed patch from lyrics-plus")


if __name__ == "__main__":
    actions = {"apply": apply, "remove": remove, "check": check}
    if len(sys.argv) != 3 or sys.argv[1] not in actions:
        sys.exit(__doc__)
    actions[sys.argv[1]](app_dir(Path(sys.argv[2]).expanduser()))
