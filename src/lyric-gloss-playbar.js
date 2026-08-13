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

	// lyrics-plus's nav entry is identified by its ICON, not by the route.
	// Verified against the live DOM: it renders as
	//     <button aria-label="Lyrics"> …  no href, no data-id
	// so every route-based selector misses it, and aria-label="Lyrics" alone
	// would also match Spotify's playbar button and hide the thing we want.
	//
	// The icon is the manifest's own artwork, and nothing else in the client
	// uses it. Both the icon and active-icon paths begin "m224.98" once
	// whitespace is stripped and case is folded.
	const NAV_ICON = "m224.98";

	function isNavEntry(el) {
		const d = el.querySelector?.("svg path")?.getAttribute("d") ?? "";
		return d.replace(/\s+/g, "").toLowerCase().startsWith(NAV_ICON);
	}

	function hideNavEntry() {
		let hid = 0;

		for (const el of document.querySelectorAll("button, a, li")) {
			if (el.hasAttribute(MARK) || !isNavEntry(el)) continue;

			const item = el.closest("li, [role='listitem']") ?? el;
			if (item.dataset.lyricGlossHidden) continue;
			item.dataset.lyricGlossHidden = "1";
			item.style.setProperty("display", "none", "important");
			hid++;
		}

		if (hid && !navHidden) {
			navHidden = true;
			console.log(`[lyric-gloss] hid ${hid} nav entr${hid === 1 ? "y" : "ies"}`);
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

	// Mark the document while the lyrics route is open, so the stylesheet can
	// scope rules to it. The page scrolls Spotify's main view container, not
	// anything lyrics-plus owns, so its scrollbar cannot be reached without
	// this — and hiding it unscoped would strip scrollbars from every page.
	const ROUTE_CLASS = "lyric-gloss-route";

	function syncRouteClass(pathname) {
		document.documentElement.classList.toggle(ROUTE_CLASS, pathname === ROUTE);
	}

	syncRouteClass(Spicetify.Platform.History.location?.pathname);
	Spicetify.Platform.History.listen((location) => syncRouteClass(location?.pathname));

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
