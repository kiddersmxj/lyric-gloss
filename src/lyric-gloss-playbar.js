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

	// Never return the lyrics-plus nav entry. Spotify does not always tag the
	// playbar button with data-testid — it varies between launches, since UI
	// experiments are served per session — and the aria-label fallback matches
	// the nav mic first, because it sits higher in the DOM. Binding that marks
	// it, and hideNavEntry() skips marked elements, so the mic made itself
	// immune to hiding on exactly those launches.
	//
	// Search inside the now-playing bar first, and reject the nav entry by its
	// icon in any case.
	function findButton() {
		const bar = document.querySelector(".Root__now-playing-bar, .main-nowPlayingBar-nowPlayingBar, footer");

		for (const scope of [bar, document]) {
			if (!scope) continue;
			for (const selector of SELECTORS) {
				for (const el of scope.querySelectorAll(selector)) {
					if (isNavEntry(el)) continue;
					return el;
				}
			}
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
			// Deliberately no MARK check: findButton() can no longer return a
			// nav entry, so hiding always wins. The old guard meant that if the
			// mic ever got bound by mistake it silently became unhideable.
			if (!isNavEntry(el)) continue;

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

	// --- optional extras, strictly after the critical path ------------------
	// Anything below is cosmetic. It runs last and inside try/catch so that a
	// failure here can never stop the button binding or the nav hiding above,
	// which is exactly what happened when this block sat before bind().
	try {
		// Mark the document while the lyrics route is open, so the stylesheet
		// can scope rules to it. The page scrolls Spotify's main-view
		// container, not anything lyrics-plus owns, so its scrollbar cannot be
		// reached otherwise — and hiding it unscoped would strip scrollbars
		// from every page in the client.
		const ROUTE_CLASS = "lyric-gloss-route";
		const syncRouteClass = (pathname) => document.documentElement.classList.toggle(ROUTE_CLASS, pathname === ROUTE);

		syncRouteClass(Spicetify.Platform.History.location?.pathname);

		if (typeof Spicetify.Platform.History.listen === "function") {
			Spicetify.Platform.History.listen((location) => syncRouteClass(location?.pathname));
		} else {
			// No route events on this build — fall back to the existing poll.
			setInterval(() => syncRouteClass(Spicetify.Platform.History.location?.pathname), 1000);
		}
	} catch (error) {
		console.error("[lyric-gloss] route-class setup failed (scrollbar will show)", error);
	}

	console.log("[lyric-gloss] playbar lyrics button bound to", ROUTE);
})();
