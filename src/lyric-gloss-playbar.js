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

	// Hidden only once a native button has actually been bound — never up
	// front. If there is no button to hijack, the nav entry stays as the way
	// in; hiding it unconditionally is how you end up unable to open lyrics
	// at all.
	let navHidden = false;

	// Find the nav entry by what it points at rather than by class name, then
	// walk up to the element that actually occupies space. Guessing selectors
	// failed repeatedly — Spotify moves this thing between builds and it has
	// been a list item, a link, and a button.
	function hideNavEntry() {
		const anchors = document.querySelectorAll(`[href="${ROUTE}"], [href="#${ROUTE}"], [data-id="${ROUTE}"], [aria-label="Lyrics Plus"]`);
		let hid = 0;

		for (const anchor of anchors) {
			// Don't ever hide something containing the playbar button we bound.
			if (anchor.querySelector?.(`[${MARK}]`)) continue;

			const item = anchor.closest("li, [role='listitem'], [role='tab']") ?? anchor;
			if (item.dataset.lyricGlossHidden) continue;
			item.dataset.lyricGlossHidden = "1";
			item.style.setProperty("display", "none", "important");
			hid++;
		}

		if (hid && !navHidden) {
			navHidden = true;
			console.log(`[lyric-gloss] hid ${hid} nav entr${hid === 1 ? "y" : "ies"} for ${ROUTE}`);
		}
	}

	function toggleLyrics(event) {
		const history = Spicetify.Platform.History;

		try {
			if (history.location?.pathname === ROUTE) {
				history.goBack();
			} else {
				history.push(ROUTE);
			}
		} catch (error) {
			// Let Spotify's own handler run rather than swallowing the click.
			console.error("[lyric-gloss] navigation failed, falling back", error);
			return;
		}

		event.preventDefault();
		event.stopImmediatePropagation(); // beat Spotify's own handler
	}

	function bind() {
		const button = findButton();
		if (!button || button.hasAttribute(MARK)) return;

		button.setAttribute(MARK, "1");
		button.addEventListener("click", toggleLyrics, true); // capture phase
		hideNavEntry(); // safe now: there is a working way in
	}

	bind();

	// Spotify replaces the playbar element (track changes, resize, PiP), which
	// drops the listener. A MutationObserver here is the obvious choice and the
	// wrong one: the progress bar mutates every frame, so a subtree observer
	// fires continuously. A cheap poll is predictable and costs nothing —
	// bind() returns immediately once the current element is marked.
	setInterval(() => {
		bind();
		if (findButton()) hideNavEntry(); // only ever hide when a way in exists
	}, 1000);

	console.log("[lyric-gloss] playbar lyrics button bound to", ROUTE);
})();
