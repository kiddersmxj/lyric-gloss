// Test fixture — see the header of index.js in this directory.
//
// Carries the synced-expanded page's scroll effect, which is the only part of
// Pages.js the patch touches, at upstream's indentation.

const { useEffect, useRef } = React;

const isInViewport = (element) => {
	const rect = element.getBoundingClientRect();
	return rect.top >= 0 && rect.bottom <= window.innerHeight;
};

const findNextLineStartTime = (lines, index) => lines[index + 1]?.startTime ?? 0;

function SyncedExpandedLyricsPage({ lyrics, position }) {
	const activeLineRef = useRef(null);
	const pageRef = useRef(null);
	const initialScroll = useRef(false);

	const padded = lyrics;
	const activeLineIndex = lyrics.findIndex((line) => line.startTime > position) - 1;

	// Reset scroll state when lyrics change
	useEffect(() => {
		initialScroll.current = true;
	}, [lyrics]);

	const lyricsId = lyrics[0].text;

	useEffect(() => {
		if (activeLineRef.current && (initialScroll.current || isInViewport(activeLineRef.current))) {
			if (activeLineIndex <= 0) {
				const nextStart = findNextLineStartTime(padded, 0);

				// If the intro is very short (e.g. less than 300ms), don't focus it
				if (nextStart && nextStart - position < 300) {
					initialScroll.current = false;
					return;
				}
			}

			activeLineRef.current.scrollIntoView({
				behavior: initialScroll.current ? "auto" : "smooth",
				block: "center",
				inline: "nearest",
			});

			initialScroll.current = false;
		}
	}, [activeLineIndex, lyricsId]);

	return { key: lyricsId, ref: pageRef };
}

void SyncedExpandedLyricsPage;
