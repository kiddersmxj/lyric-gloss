// lyric-gloss-playbar — make Spotify's own playbar lyrics button open
// lyrics-plus instead of the native lyrics pane.
//
// lyrics-plus ships PlaybarButton.js, which adds a *second* button and hides
// the native one. That is fragile: it appends the hiding stylesheet before
// calling Spicetify.Playbar.Button().register(), so if that API doesn't match
// the running Spotify build you get no lyrics button at all.
//
// This instead leaves the native button exactly where it is — same icon,
// position, tooltip, active state — and intercepts its click in the capture
// phase. Nothing is hidden, so the worst possible failure is that the button
// keeps doing what it always did.

(function LyricGlossPlaybar() {
	const READY = () => Spicetify?.Platform?.History && document.querySelector(".Root__now-playing-bar, .main-nowPlayingBar-nowPlayingBar");
	if (!READY()) {
		setTimeout(LyricGlossPlaybar, 300);
		return;
	}

	const ROUTE = "/lyrics-plus";
	const MARK = "data-lyric-gloss-bound";

	// Spotify has moved this button between builds, so try several handles.
	const SELECTORS = [
		'[data-testid="lyrics-button"]',
		".main-nowPlayingBar-lyricsButton",
		'button[aria-label*="yric"]',
		'button[title*="yric"]',
	];

	function findButton() {
		for (const selector of SELECTORS) {
			const el = document.querySelector(selector);
			if (el) return el;
		}
		return null;
	}

	function toggleLyrics(event) {
		event.preventDefault();
		event.stopImmediatePropagation(); // beat Spotify's own handler

		const history = Spicetify.Platform.History;
		if (history.location?.pathname === ROUTE) {
			history.goBack();
		} else {
			history.push(ROUTE);
		}
	}

	function bind() {
		const button = findButton();
		if (!button || button.hasAttribute(MARK)) return;

		button.setAttribute(MARK, "1");
		button.addEventListener("click", toggleLyrics, true); // capture phase
	}

	bind();

	// Spotify re-renders the playbar (track changes, window resize, PiP), which
	// replaces the element and drops the listener. Re-bind whenever that happens.
	const bar = document.querySelector(".Root__now-playing-bar, .main-nowPlayingBar-nowPlayingBar") ?? document.body;
	new MutationObserver(bind).observe(bar, { childList: true, subtree: true });

	// The sidebar entry is redundant once the playbar button works, but only
	// hide it after we have actually bound something.
	if (findButton()) {
		const style = document.createElement("style");
		style.innerHTML = `li[data-id="${ROUTE}"] { display: none; }`;
		document.head.appendChild(style);
	}

	console.log("[lyric-gloss] playbar lyrics button bound to", ROUTE);
})();
