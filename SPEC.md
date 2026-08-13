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

## Rate limiting

The endpoint is unofficial and throttles by IP, so the provider has to be a
good citizen or it loses access for everyone using that address.

The failure that mattered was not the throttling itself but the amplification:
the per-line retry, which exists for a chunk that returns the wrong number of
segments, also ran when the request itself failed. One 429 became one doomed
request per line, dozens per song, repeated on every track change — which kept
the limit alive indefinitely.

Two rules follow. Retry only distinguishes recoverable from unrecoverable
failure: a misaligned response is worth retrying line by line, a failed request
is not. And repeated failure opens a circuit breaker — 2m, 10m, 30m, 2h while
failures continue, reset by any clean run, persisted so a restart does not
resume hammering. Cached tracks keep rendering throughout, and a throttled
track caches nothing so it retries once the cooldown expires.

## The playbar button and the nav entry

The goal is that Spotify's own lyrics button opens this page, with no second
control anywhere.

lyrics-plus ships `PlaybarButton.js` for this, and it is not usable: it hides
the native button *before* calling `Spicetify.Playbar.Button().register()`, so
on a build where that API doesn't match you get no lyrics button at all. The
extension instead binds a capture-phase click listener to Spotify's existing
button. Nothing is hidden, so the worst failure is the button behaving as it
always did.

Two things make this harder than it looks:

**The nav entry has no route in its markup.** It renders as a bare
`<button aria-label="Lyrics">` — no `href`, no `data-id`. Nothing in the
document references `/lyrics-plus` except the stylesheet link. It is identified
by its icon instead: both `icon` and `active-icon` in the lyrics-plus manifest
begin `m224.98` once whitespace is stripped, and nothing else in the client
draws that path.

**Spotify serves UI experiments per session,** so the playbar button does not
always carry `data-testid="lyrics-button"`. Selectors must therefore be scoped
to the container they belong to — `findButton()` searches the now-playing bar
first and rejects anything matching the nav icon. An unscoped `aria-label`
match would find the nav mic, since it sits higher in the DOM, and binding it
made it unhideable.

The nav entry is only ever hidden once a button has actually been bound, so a
client where the hijack fails still has a way in.

## Scrolling and the scrollbar

Upstream follows the active line but does not return to the top when a new
track starts, because the scroll effect keys off `lyrics[0].text` — often a
pause marker, so consecutive tracks share an id and the effect never re-fires —
and because it returns early without scrolling when the active line is index 0
and the first line starts within 300ms, which is exactly the state at the start
of a track.

It also only follows the active line while that line is already on screen, so
scrubbing to a distant part of a song left the page where it was. The guard is
worth keeping — it stops the page yanking you back when you scroll off to read
ahead — so the two cases are distinguished by distance: playback advances the
active line by exactly one, a seek moves it by more. Jumps scroll instantly
rather than smoothly, since animating the length of a song looks broken.

The page scrolls Spotify's shared main-view container, not anything lyrics-plus
owns, so its scrollbar cannot be styled from the lyrics container. It is also not a native
scrollbar: Spotify uses OverlayScrollbars, which renders real DOM elements
(`.os-scrollbar` and friends), so `::-webkit-scrollbar` rules are inert. It is
hidden with `opacity: 0` — paint only. Removing it with `display: none` or
zeroing its width stops the container scrolling altogether, since its geometry
feeds Spotify's own scroll handling. The
extension marks `<html>` with `lyric-gloss-route` while the route is open and
the stylesheet scopes the scrollbar rules to that, leaving every other page
alone. That marking is cosmetic, so it runs last and inside `try`/`catch` —
when it briefly ran first, a throw there silently disabled the button binding
and the nav hiding.

## Quality

Straight lines translate well. Slang goes literal:

Idiom is rendered literally. A colloquial "the drink is getting to me" comes
back as a word-for-word reading about rising liquid; affectionate address is
translated as a literal family term. Both are wrong in register rather than in
vocabulary, which is the hard kind of wrong to notice if you are still learning
the language.

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
