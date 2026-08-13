# Design

## Why a patch and not a standalone app

Spotify's desktop client is a web app in a native shell. There is no plugin
API, so the only way to put anything inside its lyrics view is to modify the
JS bundle — which is what spicetify does. Anything else (a Web Playback SDK
app, an MPRIS-driven overlay, a browser extension) puts the text in a separate
window or a browser tab, which is not the same product.

`lyrics-plus` already solves the hard parts: lyric fetching from four
providers, sync, the settings UI, and a `"Below original"` display mode that
renders a second `<p>` under each line. The only missing piece was a
translation source that works for arbitrary languages, so that is all this adds.

## Rendering

`lyrics-plus` emits, per line:

```
div.lyrics-lyricsContainer-LyricsLine
  p                 <- original
  p (opacity: 0.5)  <- translation, only when display mode is "below"
```

`src/gloss.css` styles only the second `<p>`. Lines with no translation are
untouched, and when the gloss is off the CSS is inert. The translated line
falls back to the original text on failure, which the renderer detects
(`belowOrigin !== belowTxt`) and collapses back to a single line.

## Translation

`translate.googleapis.com/translate_a/single` with `client=gtx`. No key, no
quota to manage, no local model to ship.

**Line alignment is the whole problem.** Passing multiple `q` parameters does
not work — only the first is translated. Newline-joining does, and the response
returns one segment per input line, each retaining its own trailing `\n`. So
concatenating all translated segments and splitting on `\n` recovers per-line
alignment even when the service merges or splits segments internally. Line
counts are asserted per chunk, with a per-line retry if they disagree, so a
mismatch can never silently shift every subsequent translation up by one.

Requests are chunked to stay under ~1400 characters of source, which keeps the
GET inside URL length limits. A typical song is one request.

Two transports are tried in order — `Spicetify.CosmosAsync` (Spotify's native
stack, no page CORS) then plain `fetch` — because it isn't obvious in advance
which the client permits, and Cosmos can balk at long URLs and encoded
newlines. Whichever works first is reused.

## Same-language detection

Index 2 of the response is the language the service detected. The first chunk's
value decides: if it matches the target, translation stops and a `skip` marker
is cached. So an English track costs exactly one request, ever, and then
nothing. This is per song, not per line — a mostly-English song with a Spanish
chorus is skipped wholesale.

## Caching

`localStorage`, keyed by track URI **and** target language, 30-day TTL. Caching
the skip decision matters as much as caching translations; without it every
same-language track re-requests on every play.

## Quality

Straight lines translate well. Slang goes literal:

```
Se me sube el ron y me pongo a pensar  →  "My rum rises and I start to think"
Dime que sí, mami                      →  "Tell me yes, mommy"
```

This is inherent to sentence-level MT on song lyrics, which are dense in
regional slang, elision and deliberate ambiguity. The fix, if it matters, is
swapping the backend for an LLM with "these are Latin American song lyrics" as
context — a change confined to `translateBlock()`. The alignment machinery,
chunking, caching and skip logic all stay as they are.

A reasonable objection to this whole design: a permanently visible translation
is a comprehension aid, not a learning aid, because the eye goes to the
language it knows. Click-a-word-to-define would teach more. This builds the
always-visible version because that is what was asked for, twice.

## Patch mechanism

`patch.py` holds a list of `(file, anchor, replacement)` triples applied as
plain text. It is idempotent, reversible byte-for-byte, and refuses to touch
anything if an anchor is not found exactly once — so a `lyrics-plus` update
that moves code produces a clear failure rather than a corrupted app.

`manifest.json` is edited textually rather than via a JSON round-trip,
specifically so `remove` can restore it exactly; `json.dumps` would reformat
the entire file.

Six of the seven edits are mechanical wiring. The interesting one:

```js
const hasTranslation = … || hasMusixmatchLanguages;   // upstream
```

`hasTranslation` gates the entire translation menu, and it depends on
`Utils.detectLanguage`, which **only recognises CJK** — it returns `undefined`
for Spanish, French, and everything else Latin-scripted. So the menu was
unreachable for exactly the languages this targets. The patch forces it true.
