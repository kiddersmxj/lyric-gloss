// ProviderAutoTranslate — machine translation for lyrics-plus.
//
// lyrics-plus can already render a translation under each original line
// ("Below original" display mode), but its only sources are Musixmatch
// community translations — which exist for a small fraction of tracks — and
// Netease, which is Chinese only. This provider translates whatever lyrics
// were found, so coverage becomes "any song lyrics-plus can find lyrics for".
//
// Source language is auto-detected; the target is selectable. Songs already in
// the target language are detected and skipped rather than glossed with a
// pointless copy of themselves.
//
// Endpoint: translate.googleapis.com/translate_a/single (client=gtx, no key).

const ProviderAutoTranslate = (() => {
	const ENDPOINT = "https://translate.googleapis.com/translate_a/single";
	const CACHE_PREFIX = "lyrics-plus:auto-translate:";
	const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
	const MAX_CHUNK_CHARS = 1400; // keep the GET well inside URL length limits

	// Languages offered as translation targets in the menu.
	const TARGETS = {
		en: "English",
		es: "Spanish",
		fr: "French",
		de: "German",
		it: "Italian",
		pt: "Portuguese",
		nl: "Dutch",
		ja: "Japanese",
		ko: "Korean",
		zh: "Chinese",
		ru: "Russian",
		ar: "Arabic",
	};

	// Lines that carry no words — leave them exactly as they are.
	const isUntranslatable = (text) => !text || !/\p{Letter}/u.test(text);

	function buildURL(text, sourceLang, targetLang) {
		const params = {
			client: "gtx",
			sl: sourceLang || "auto",
			tl: targetLang,
			dt: "t",
			q: text,
		};
		return `${ENDPOINT}?${Object.keys(params)
			.map((key) => `${key}=${encodeURIComponent(params[key])}`)
			.join("&")}`;
	}

	// Two transports, because it is not obvious in advance which the client
	// permits: CosmosAsync (Spotify's native stack, no page CORS, but may balk
	// at long URLs or encoded newlines) and plain fetch (subject to the page
	// CSP). Whichever works first wins and is reused.
	let transport = null;

	async function viaCosmos(url) {
		const response = await Spicetify.CosmosAsync.get(url);
		// Cosmos may hand back a parsed array or a raw string depending on the
		// content-type it sees.
		return typeof response === "string" ? JSON.parse(response) : response;
	}

	async function viaFetch(url) {
		const response = await fetch(url);
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		return response.json();
	}

	async function request(url) {
		const candidates = transport
			? [transport]
			: [
					{ name: "cosmos", fn: viaCosmos },
					{ name: "fetch", fn: viaFetch },
				];

		const errors = [];
		for (const candidate of candidates) {
			try {
				const parsed = await candidate.fn(url);
				if (!Array.isArray(parsed?.[0])) {
					errors.push(`${candidate.name}: unexpected shape ${JSON.stringify(parsed)?.slice(0, 120)}`);
					continue;
				}
				if (!transport) {
					transport = candidate;
					console.log(`[auto-translate] using ${candidate.name} transport`);
				}
				return parsed;
			} catch (error) {
				errors.push(`${candidate.name}: ${error?.message ?? error}`);
			}
		}

		throw new Error(errors.join(" | "));
	}

	async function translateBlock(text, sourceLang, targetLang) {
		const parsed = await request(buildURL(text, sourceLang, targetLang));
		const segments = parsed[0];
		if (!Array.isArray(segments)) return null;
		return {
			// segment = [translated, original, ...]; concatenating preserves newlines
			text: segments.map((segment) => segment?.[0] ?? "").join(""),
			// index 2 is the language the service detected in the source
			detected: typeof parsed[2] === "string" ? parsed[2] : null,
		};
	}

	// Group indices into chunks that stay under the URL budget.
	function chunkIndices(texts, indices) {
		const chunks = [];
		let current = [];
		let size = 0;

		for (const index of indices) {
			const cost = texts[index].length + 1;
			if (current.length && size + cost > MAX_CHUNK_CHARS) {
				chunks.push(current);
				current = [];
				size = 0;
			}
			current.push(index);
			size += cost;
		}
		if (current.length) chunks.push(current);
		return chunks;
	}

	async function translateLines(texts, sourceLang, targetLang) {
		const out = new Array(texts.length).fill(null);
		const translatable = texts.map((text, index) => (isUntranslatable(text) ? -1 : index)).filter((index) => index !== -1);
		let detected = null;

		for (const chunk of chunkIndices(texts, translatable)) {
			let block = null;
			try {
				block = await translateBlock(chunk.map((index) => texts[index]).join("\n"), sourceLang, targetLang);
			} catch (error) {
				console.error("[auto-translate] chunk failed", error);
				Spicetify.showNotification(`Translate failed: ${error?.message ?? error}`.slice(0, 300), true, 8000);
			}

			// The first chunk tells us what language the song is actually in.
			// If it already matches the target there is nothing worth showing,
			// so stop rather than glossing a language with itself.
			if (detected === null && block?.detected) {
				detected = block.detected;
				if (detected.slice(0, 2) === targetLang.slice(0, 2)) {
					console.log(`[auto-translate] source is already ${detected}, skipping`);
					return { lines: null, detected };
				}
			}

			const lines = block?.text == null ? null : block.text.split("\n");

			if (lines && lines.length === chunk.length) {
				chunk.forEach((index, position) => {
					out[index] = lines[position].trim();
				});
				continue;
			}

			// Segment count disagreed with input count — fall back to one
			// request per line for this chunk so alignment can't drift.
			console.warn(`[auto-translate] chunk misaligned (${lines?.length} vs ${chunk.length}), retrying per line`);
			for (const index of chunk) {
				try {
					const single = await translateBlock(texts[index], sourceLang, targetLang);
					out[index] = single?.text == null ? null : single.text.trim();
				} catch (error) {
					console.error("[auto-translate] line failed", error);
				}
			}
		}

		return { lines: out, detected };
	}

	// Cache entries are either { lines: [...] } or { skip: "<lang>" } for songs
	// already in the target language. Caching the skip matters: without it every
	// same-language track re-requests on every play.
	function readCache(uri, targetLang) {
		try {
			const raw = localStorage.getItem(`${CACHE_PREFIX}${uri}:${targetLang}`);
			if (!raw) return null;
			const entry = JSON.parse(raw);
			if (!entry?.at || Date.now() - entry.at > CACHE_TTL_MS) return null;
			if (entry.skip) return { skip: entry.skip };
			return entry.lines ? { lines: entry.lines } : null;
		} catch (error) {
			return null;
		}
	}

	function writeCache(uri, targetLang, entry) {
		try {
			localStorage.setItem(`${CACHE_PREFIX}${uri}:${targetLang}`, JSON.stringify({ at: Date.now(), ...entry }));
		} catch (error) {
			// localStorage full — translations are cheap to refetch, so drop it
			console.warn("[auto-translate] could not cache", error);
		}
	}

	/**
	 * @param lyrics array of { text, startTime? }
	 * @returns array of { ...line, originalText, text }, or null when the song
	 *          is already in the target language or translation failed
	 */
	async function getTranslation(lyrics, uri, sourceLang, targetLang = "en") {
		if (!Array.isArray(lyrics) || !lyrics.length) return null;

		const texts = lyrics.map((line) => (typeof line.text === "string" ? line.text : ""));

		const cached = readCache(uri, targetLang);
		if (cached?.skip) return null;

		let lines = cached?.lines?.length === texts.length ? cached.lines : null;

		if (!lines) {
			console.log(`[auto-translate] requesting ${texts.length} lines for ${uri} (${sourceLang ?? "auto"} → ${targetLang})`);
			const result = await translateLines(texts, sourceLang, targetLang);

			if (result.lines === null) {
				// Already in the target language — remember so we don't ask again.
				writeCache(uri, targetLang, { skip: result.detected ?? targetLang });
				return null;
			}

			if (result.lines.every((line) => line === null)) return null;
			lines = result.lines;
			writeCache(uri, targetLang, { lines });
		}

		return lyrics.map((line, index) => ({
			...line,
			originalText: line.text,
			// Untranslated / failed lines fall back to the original, which the
			// "below" renderer detects and collapses to a single line.
			text: lines[index] || line.text,
		}));
	}

	function clearCache() {
		const keys = [];
		for (let i = 0; i < localStorage.length; i++) {
			const key = localStorage.key(i);
			if (key?.startsWith(CACHE_PREFIX)) keys.push(key);
		}
		for (const key of keys) localStorage.removeItem(key);
		return keys.length;
	}

	return { getTranslation, clearCache, TARGETS };
})();
