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
// Endpoint: translate.googleapis.com/translate_a/single (client=gtx, falling
// back to dict-chrome-ex when gtx is throttled; no key).

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

	// --- rate-limit circuit breaker ----------------------------------------
	// The endpoint is unofficial and throttles by IP. Once it starts returning
	// 429 the only useful response is to stop asking for a while: every extra
	// request keeps the limit alive. Backoff escalates while it keeps failing
	// and resets after a clean run, and it is persisted so restarting Spotify
	// doesn't immediately resume hammering.
	const COOLDOWN_KEY = "lyrics-plus:auto-translate:cooldown";
	const BACKOFF_MS = [2 * 60_000, 10 * 60_000, 30 * 60_000, 2 * 60 * 60_000];

	function readCooldown() {
		try {
			return JSON.parse(localStorage.getItem(COOLDOWN_KEY)) ?? { until: 0, step: 0 };
		} catch {
			return { until: 0, step: 0 };
		}
	}

	function startCooldown() {
		const { step } = readCooldown();
		const next = Math.min(step, BACKOFF_MS.length - 1);
		const until = Date.now() + BACKOFF_MS[next];

		try {
			localStorage.setItem(COOLDOWN_KEY, JSON.stringify({ until, step: next + 1 }));
		} catch {
			/* cache full — the in-flight guard below still applies */
		}

		const minutes = Math.round(BACKOFF_MS[next] / 60_000);
		console.warn(`[auto-translate] rate limited; pausing ${minutes}m`);
		Spicetify.showNotification(`Lyrics translation rate limited — pausing for ${minutes} min`, true, 6000);
	}

	function clearCooldown() {
		if (readCooldown().step === 0) return;
		try {
			localStorage.removeItem(COOLDOWN_KEY);
		} catch {
			/* nothing useful to do */
		}
	}

	// The endpoint throttles per client identifier as well as per address:
	// `gtx` can be answering Google's "Sorry…" page for an IP while
	// `dict-chrome-ex` still answers normally, with an identical response shape
	// (segments keep their newlines, detected language at index 2). So a rate
	// limit rotates to the next client before the circuit breaker opens, and
	// whichever client last worked is tried first from then on.
	const CLIENTS = ["gtx", "dict-chrome-ex"];
	let clientIndex = 0;

	function buildURL(text, sourceLang, targetLang, client = CLIENTS[clientIndex]) {
		const params = {
			client,
			sl: sourceLang || "auto",
			tl: targetLang,
			dt: "t",
			q: text,
		};
		return `${ENDPOINT}?${Object.keys(params)
			.map((key) => `${key}=${encodeURIComponent(params[key])}`)
			.join("&")}`;
	}

	// Transport order matters, and fetch must come first.
	//
	// Spicetify's CosmosAsync routes external requests through its own shared
	// CORS proxy (cors-proxy.spicetify.app), which is rate-limited across every
	// spicetify user — so it returns 429 while the endpoint answers 200 from
	// the same machine. The endpoint sends `access-control-allow-origin: *`, so
	// a plain fetch reaches it directly and is subject only to our own usage.
	//
	// Cosmos is kept as a fallback in case a build blocks direct fetch.
	let transport = null;

	async function viaCosmos(url) {
		const response = await Spicetify.CosmosAsync.get(url);
		// Cosmos may hand back a parsed array or a raw string depending on the
		// content-type it sees.
		const parsed = typeof response === "string" ? JSON.parse(response) : response;

		// Cosmos reports proxy failures as a body rather than by throwing.
		if (parsed && !Array.isArray(parsed) && typeof parsed.code === "number" && parsed.code >= 400) {
			const error = new Error(`HTTP ${parsed.code}`);
			error.status = parsed.code;
			throw error;
		}

		return parsed;
	}

	async function viaFetch(url) {
		const response = await fetch(url);
		if (!response.ok) {
			const error = new Error(`HTTP ${response.status}`);
			error.status = response.status;
			throw error;
		}
		return response.json();
	}

	const isRateLimit = (error) => error?.status === 429 || /\b429\b|too many requests|rate.?limit/i.test(error?.message ?? "");

	async function request(url) {
		const all = [
			{ name: "fetch", fn: viaFetch },
			{ name: "cosmos", fn: viaCosmos },
		];

		// A pinned transport is tried first, not exclusively. Pinning
		// exclusively meant that once one was chosen a later failure could
		// never fall back to the other.
		const candidates = transport ? [transport, ...all.filter((c) => c.name !== transport.name)] : all;

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

	// Only a rate limit is worth another client. Any other failure is thrown
	// straight away, so a network outage still costs one request, not two.
	async function requestAnyClient(text, sourceLang, targetLang) {
		let lastError = null;

		for (let attempt = 0; attempt < CLIENTS.length; attempt++) {
			const index = (clientIndex + attempt) % CLIENTS.length;
			try {
				const parsed = await request(buildURL(text, sourceLang, targetLang, CLIENTS[index]));
				if (index !== clientIndex) {
					clientIndex = index;
					console.log(`[auto-translate] switched to client=${CLIENTS[index]}`);
				}
				return parsed;
			} catch (error) {
				if (!isRateLimit(error)) throw error;
				lastError = error;
			}
		}

		throw lastError;
	}

	async function translateBlock(text, sourceLang, targetLang) {
		const parsed = await requestAnyClient(text, sourceLang, targetLang);
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
			let requestFailed = false;

			try {
				block = await translateBlock(chunk.map((index) => texts[index]).join("\n"), sourceLang, targetLang);
			} catch (error) {
				requestFailed = true;
				console.error("[auto-translate] chunk failed", error);

				if (isRateLimit(error)) {
					// Stop immediately. Continuing would issue one request per
					// remaining chunk, each of which is also throttled, which is
					// what kept the limit alive in the first place.
					startCooldown();
					return { lines: null, detected, rateLimited: true };
				}
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

			// Only retry per line when the request SUCCEEDED but came back with
			// the wrong number of segments. If the request itself failed, one
			// retry per line means dozens of doomed calls for a single song —
			// which is how a single 429 turned into sustained rate limiting.
			if (requestFailed) continue;

			console.warn(`[auto-translate] chunk misaligned (${lines?.length} vs ${chunk.length}), retrying per line`);
			for (const index of chunk) {
				try {
					const single = await translateBlock(texts[index], sourceLang, targetLang);
					out[index] = single?.text == null ? null : single.text.trim();
				} catch (error) {
					console.error("[auto-translate] line failed", error);
					if (isRateLimit(error)) {
						startCooldown();
						return { lines: null, detected, rateLimited: true };
					}
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

		// Cached tracks still render while throttled; only new requests stop.
		if (!lines) {
			const { until } = readCooldown();
			if (Date.now() < until) {
				console.log(`[auto-translate] in cooldown for another ${Math.round((until - Date.now()) / 1000)}s`);
				return null;
			}
		}

		if (!lines) {
			console.log(`[auto-translate] requesting ${texts.length} lines for ${uri} (${sourceLang ?? "auto"} → ${targetLang})`);
			const result = await translateLines(texts, sourceLang, targetLang);

			// Throttled: cache nothing, so this track retries once the cooldown
			// expires rather than being remembered as untranslatable.
			if (result.rateLimited) return null;

			if (result.lines === null) {
				// Already in the target language — remember so we don't ask again.
				writeCache(uri, targetLang, { skip: result.detected ?? targetLang });
				clearCooldown();
				return null;
			}

			if (result.lines.every((line) => line === null)) return null;
			lines = result.lines;
			writeCache(uri, targetLang, { lines });
			clearCooldown(); // a clean run resets the backoff ladder
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
