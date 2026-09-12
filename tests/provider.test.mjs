// Tests for src/ProviderAutoTranslate.js — the translation source.
//
// The provider is a plain IIFE meant to be loaded into lyrics-plus, so it is
// run here in a vm context with stubbed localStorage, fetch, Spicetify and
// clock. Nothing touches the network: a fake endpoint answers, and counts how
// often it is asked.
//
// The behaviours worth guarding are the ones that cost real debugging:
// per-line alignment, the same-language skip, and above all the rule that a
// *failed* request is never retried per line — that is what turned one 429
// into sustained rate limiting.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";

const SOURCE = readFileSync(fileURLToPath(new URL("../src/ProviderAutoTranslate.js", import.meta.url)), "utf8");

const CACHE_PREFIX = "lyrics-plus:auto-translate:";
const COOLDOWN_KEY = "lyrics-plus:auto-translate:cooldown";

// --- harness ----------------------------------------------------------------

function makeLocalStorage(seed = {}) {
	const map = new Map(Object.entries(seed));
	return {
		getItem: (key) => (map.has(key) ? map.get(key) : null),
		setItem: (key, value) => map.set(key, String(value)),
		removeItem: (key) => map.delete(key),
		key: (index) => [...map.keys()][index] ?? null,
		get length() {
			return map.size;
		},
		_map: map,
	};
}

/**
 * A stand-in for translate.googleapis.com.
 *
 * The real response is [segments, null, detectedLang, ...] where each segment
 * is [translated, original, ...] and segments keep their own trailing newline —
 * which is what makes concatenate-then-split recover per-line alignment.
 */
function fakeEndpoint({ detected = "es", translate = (line) => `T:${line}`, behaviour = () => null } = {}) {
	const calls = [];

	const respond = (url) => {
		const q = new URL(url).searchParams.get("q");
		calls.push(q);

		const override = behaviour(calls.length, q);
		if (override) throw override;

		const lines = q.split("\n").map(translate);
		const segments = lines.map((line, index) => [index === lines.length - 1 ? line : `${line}\n`, "orig"]);
		return [segments, null, detected];
	};

	return { calls, respond };
}

function load({ storage = makeLocalStorage(), fetchImpl, cosmosImpl, now = 1_700_000_000_000 } = {}) {
	const clock = { now };
	const notifications = [];

	const sandbox = {
		localStorage: storage,
		Date: { now: () => clock.now },
		console: { log() {}, warn() {}, error() {} },
		fetch:
			fetchImpl ??
			(async () => {
				throw new TypeError("fetch not stubbed");
			}),
		Spicetify: {
			showNotification: (message) => notifications.push(message),
			CosmosAsync: {
				get:
					cosmosImpl ??
					(async () => {
						throw new Error("cosmos not stubbed");
					}),
			},
		},
	};

	const provider = vm.runInNewContext(`${SOURCE}\nProviderAutoTranslate;`, sandbox);
	return { provider, storage, clock, notifications };
}

/** fetch stub backed by a fake endpoint. */
const fetchFrom = (endpoint) => async (url) => ({
	ok: true,
	status: 200,
	json: async () => endpoint.respond(url),
});

const lyricsOf = (...texts) => texts.map((text, index) => ({ text, startTime: index * 1000 }));

// --- alignment --------------------------------------------------------------

test("translates every line and keeps the original alongside it", async () => {
	const endpoint = fakeEndpoint();
	const { provider } = load({ fetchImpl: fetchFrom(endpoint) });

	const out = await provider.getTranslation(lyricsOf("uno", "dos", "tres"), "spotify:track:a", null, "en");

	assert.deepEqual(
		out.map((line) => line.text),
		["T:uno", "T:dos", "T:tres"],
	);
	assert.deepEqual(
		out.map((line) => line.originalText),
		["uno", "dos", "tres"],
	);
	assert.equal(endpoint.calls.length, 1, "a short song should be a single request");
	assert.equal(out[0].startTime, 0, "timing fields must survive");
});

test("lines with no letters are left alone and never sent", async () => {
	const endpoint = fakeEndpoint();
	const { provider } = load({ fetchImpl: fetchFrom(endpoint) });

	const out = await provider.getTranslation(lyricsOf("♪", "uno", "", "- - -"), "spotify:track:b", null, "en");

	assert.deepEqual(
		out.map((line) => line.text),
		["♪", "T:uno", "", "- - -"],
	);
	assert.equal(endpoint.calls[0], "uno", "only the line with words was sent");
});

test("a long song is chunked, and every chunk stays inside the URL budget", async () => {
	const endpoint = fakeEndpoint();
	const { provider } = load({ fetchImpl: fetchFrom(endpoint) });

	const lines = Array.from({ length: 60 }, (_, index) => `linea numero ${index} con bastante texto para llenar`);
	const out = await provider.getTranslation(lyricsOf(...lines), "spotify:track:c", null, "en");

	assert.ok(endpoint.calls.length > 1, "should have taken more than one request");
	for (const q of endpoint.calls) assert.ok(q.length <= 1400, `chunk of ${q.length} chars exceeds the budget`);

	// Alignment across the chunk boundary is the thing that breaks silently.
	assert.deepEqual(
		out.map((line) => line.text),
		lines.map((line) => `T:${line}`),
	);
});

test("a chunk that comes back with the wrong number of segments is retried per line", async () => {
	// Drop a line from the first response only.
	let first = true;
	const endpoint = fakeEndpoint();
	const respond = endpoint.respond;
	endpoint.respond = (url) => {
		const parsed = respond(url);
		if (first && parsed[0].length > 1) {
			first = false;
			return [parsed[0].slice(1), null, "es"];
		}
		return parsed;
	};

	const { provider } = load({ fetchImpl: fetchFrom(endpoint) });
	const out = await provider.getTranslation(lyricsOf("uno", "dos", "tres"), "spotify:track:d", null, "en");

	assert.equal(endpoint.calls.length, 4, "one failed chunk plus one request per line");
	assert.deepEqual(
		out.map((line) => line.text),
		["T:uno", "T:dos", "T:tres"],
	);
});

// --- same-language skip -----------------------------------------------------

test("a song already in the target language is skipped, and the skip is cached", async () => {
	const endpoint = fakeEndpoint({ detected: "en" });
	const { provider, storage } = load({ fetchImpl: fetchFrom(endpoint) });

	const out = await provider.getTranslation(lyricsOf("one", "two"), "spotify:track:e", null, "en");
	assert.equal(out, null);
	assert.equal(endpoint.calls.length, 1);

	const entry = JSON.parse(storage.getItem(`${CACHE_PREFIX}spotify:track:e:en`));
	assert.equal(entry.skip, "en");

	// The point of caching the skip: an English song costs one request, ever.
	assert.equal(await provider.getTranslation(lyricsOf("one", "two"), "spotify:track:e", null, "en"), null);
	assert.equal(endpoint.calls.length, 1, "the skip was not cached");
});

test("the skip is per target language, so the same track still translates elsewhere", async () => {
	const endpoint = fakeEndpoint({ detected: "en" });
	const { provider } = load({ fetchImpl: fetchFrom(endpoint) });

	// Skipped for English…
	assert.equal(await provider.getTranslation(lyricsOf("one"), "spotify:track:f", null, "en"), null);

	// …but the same track into French is a different cache key, and a real
	// translation. A skip keyed on the URI alone would have suppressed it.
	const out = await provider.getTranslation(lyricsOf("one"), "spotify:track:f", null, "fr");

	assert.equal(endpoint.calls.length, 2);
	assert.deepEqual(
		out.map((line) => line.text),
		["T:one"],
	);
});

// --- caching ----------------------------------------------------------------

test("a second play of a translated track makes no requests", async () => {
	const endpoint = fakeEndpoint();
	const { provider } = load({ fetchImpl: fetchFrom(endpoint) });

	await provider.getTranslation(lyricsOf("uno", "dos"), "spotify:track:g", null, "en");
	const again = await provider.getTranslation(lyricsOf("uno", "dos"), "spotify:track:g", null, "en");

	assert.equal(endpoint.calls.length, 1);
	assert.deepEqual(
		again.map((line) => line.text),
		["T:uno", "T:dos"],
	);
});

test("cache entries expire after 30 days", async () => {
	const endpoint = fakeEndpoint();
	const { provider, clock } = load({ fetchImpl: fetchFrom(endpoint) });

	await provider.getTranslation(lyricsOf("uno"), "spotify:track:h", null, "en");
	clock.now += 31 * 24 * 60 * 60 * 1000;
	await provider.getTranslation(lyricsOf("uno"), "spotify:track:h", null, "en");

	assert.equal(endpoint.calls.length, 2);
});

test("a cache entry whose line count no longer matches is refetched", async () => {
	// Lyrics can change provider between plays; reusing the old array would
	// shift every translation against the wrong line.
	const endpoint = fakeEndpoint();
	const { provider } = load({ fetchImpl: fetchFrom(endpoint) });

	await provider.getTranslation(lyricsOf("uno", "dos"), "spotify:track:i", null, "en");
	const out = await provider.getTranslation(lyricsOf("uno", "dos", "tres"), "spotify:track:i", null, "en");

	assert.equal(endpoint.calls.length, 2);
	assert.equal(out.length, 3);
});

test("clearCache removes only this provider's keys", async () => {
	const endpoint = fakeEndpoint();
	const { provider, storage } = load({ fetchImpl: fetchFrom(endpoint) });
	storage.setItem("lyrics-plus:visual:alignment", "left");

	await provider.getTranslation(lyricsOf("uno"), "spotify:track:j", null, "en");
	const removed = provider.clearCache();

	assert.equal(removed, 1);
	assert.equal(storage.getItem("lyrics-plus:visual:alignment"), "left");
});

// --- failure and rate limiting ----------------------------------------------

test("a failed request is NOT retried per line", async () => {
	// The regression this exists for: the per-line retry, which is there for a
	// misaligned response, also ran when the request itself failed — turning
	// one bad chunk into dozens of doomed calls per song.
	const endpoint = fakeEndpoint({ behaviour: () => new Error("network down") });
	const { provider } = load({ fetchImpl: fetchFrom(endpoint) });

	const out = await provider.getTranslation(lyricsOf("uno", "dos", "tres"), "spotify:track:k", null, "en");

	assert.equal(out, null);
	assert.equal(endpoint.calls.length, 1, "the failed chunk was retried line by line");
});

test("a 429 opens the circuit breaker, and nothing new is requested while it holds", async () => {
	const endpoint = fakeEndpoint({
		behaviour: () => Object.assign(new Error("HTTP 429"), { status: 429 }),
	});
	const { provider, storage, notifications, clock } = load({ fetchImpl: fetchFrom(endpoint) });

	assert.equal(await provider.getTranslation(lyricsOf("uno"), "spotify:track:l", null, "en"), null);
	// One attempt per client identifier: a 429 rotates to the next client, and
	// the breaker opens only once every client is throttled.
	assert.equal(endpoint.calls.length, 2);
	assert.match(notifications[0], /rate limited/i);

	const cooldown = JSON.parse(storage.getItem(COOLDOWN_KEY));
	assert.ok(cooldown.until > clock.now);

	// A different track during the cooldown must not ask at all.
	assert.equal(await provider.getTranslation(lyricsOf("dos"), "spotify:track:m", null, "en"), null);
	assert.equal(endpoint.calls.length, 2, "asked again while throttled");
});

test("a throttled client rotates to the next one without opening the breaker", async () => {
	// Seen for real: `gtx` returned Google's "Sorry…" page for the address while
	// `dict-chrome-ex` answered normally with the same response shape.
	const endpoint = fakeEndpoint();
	const clients = [];
	const { provider, storage, notifications } = load({
		fetchImpl: async (url) => {
			const client = new URL(url).searchParams.get("client");
			clients.push(client);
			if (client === "gtx") return { ok: false, status: 429, json: async () => ({}) };
			return { ok: true, status: 200, json: async () => endpoint.respond(url) };
		},
	});

	const out = await provider.getTranslation(lyricsOf("uno"), "spotify:track:rot1", null, "en");
	assert.deepEqual(
		out.map((line) => line.text),
		["T:uno"],
	);
	assert.deepEqual(clients, ["gtx", "dict-chrome-ex"]);
	assert.equal(storage.getItem(COOLDOWN_KEY), null, "breaker opened although a client worked");
	assert.equal(notifications.length, 0);

	// The working client is remembered, so the next track does not pay for the
	// throttled one again.
	await provider.getTranslation(lyricsOf("dos"), "spotify:track:rot2", null, "en");
	assert.deepEqual(clients.slice(2), ["dict-chrome-ex"]);
});

test("a non-rate-limit failure does not rotate clients", async () => {
	const clients = [];
	const { provider } = load({
		fetchImpl: async (url) => {
			clients.push(new URL(url).searchParams.get("client"));
			throw new TypeError("network down");
		},
	});

	assert.equal(await provider.getTranslation(lyricsOf("uno"), "spotify:track:rot3", null, "en"), null);
	assert.deepEqual(clients, ["gtx"]);
});

test("a throttled track caches nothing, so it retries once the cooldown expires", async () => {
	let throttled = true;
	const endpoint = fakeEndpoint({
		behaviour: () => (throttled ? Object.assign(new Error("HTTP 429"), { status: 429 }) : null),
	});
	const { provider, clock, storage } = load({ fetchImpl: fetchFrom(endpoint) });

	await provider.getTranslation(lyricsOf("uno"), "spotify:track:n", null, "en");
	assert.equal(storage.getItem(`${CACHE_PREFIX}spotify:track:n:en`), null, "a throttled track must not be remembered as untranslatable");

	throttled = false;
	clock.now += 3 * 60 * 1000; // past the first 2m step

	const out = await provider.getTranslation(lyricsOf("uno"), "spotify:track:n", null, "en");
	assert.deepEqual(
		out.map((line) => line.text),
		["T:uno"],
	);
});

test("the backoff escalates while it keeps failing, and a clean run resets it", async () => {
	let throttled = true;
	const endpoint = fakeEndpoint({
		behaviour: () => (throttled ? Object.assign(new Error("HTTP 429"), { status: 429 }) : null),
	});
	const { provider, clock, storage } = load({ fetchImpl: fetchFrom(endpoint) });

	const steps = [];
	for (let i = 0; i < 3; i++) {
		await provider.getTranslation(lyricsOf("uno"), `spotify:track:o${i}`, null, "en");
		const { until } = JSON.parse(storage.getItem(COOLDOWN_KEY));
		steps.push(until - clock.now);
		clock.now = until + 1;
	}

	assert.deepEqual(steps, [2 * 60_000, 10 * 60_000, 30 * 60_000], "backoff did not escalate");

	throttled = false;
	await provider.getTranslation(lyricsOf("uno"), "spotify:track:p", null, "en");
	assert.equal(storage.getItem(COOLDOWN_KEY), null, "a clean run must reset the ladder");
});

test("cached tracks still render while throttled", async () => {
	let throttled = false;
	const endpoint = fakeEndpoint({
		behaviour: () => (throttled ? Object.assign(new Error("HTTP 429"), { status: 429 }) : null),
	});
	const { provider } = load({ fetchImpl: fetchFrom(endpoint) });

	await provider.getTranslation(lyricsOf("uno"), "spotify:track:q", null, "en");
	throttled = true;
	await provider.getTranslation(lyricsOf("dos"), "spotify:track:r", null, "en"); // opens the breaker

	const out = await provider.getTranslation(lyricsOf("uno"), "spotify:track:q", null, "en");
	assert.deepEqual(
		out.map((line) => line.text),
		["T:uno"],
	);
});

test("lines that fail individually fall back to the original text", async () => {
	// The "below original" renderer collapses a line back to one when the
	// translation equals the original, so a partial failure degrades quietly.
	let seen = 0;
	const endpoint = fakeEndpoint();
	const respond = endpoint.respond;
	endpoint.respond = (url) => {
		const parsed = respond(url);
		seen += 1;
		if (seen === 1) return [parsed[0].slice(1), null, "es"]; // force per-line retry
		if (seen === 3) throw new Error("this one line fails");
		return parsed;
	};

	const { provider } = load({ fetchImpl: fetchFrom(endpoint) });
	const out = await provider.getTranslation(lyricsOf("uno", "dos", "tres"), "spotify:track:s", null, "en");

	assert.deepEqual(
		out.map((line) => line.text),
		["T:uno", "dos", "T:tres"],
	);
});

// --- transport --------------------------------------------------------------

test("falls back to Cosmos when direct fetch is unavailable", async () => {
	const endpoint = fakeEndpoint();
	const { provider } = load({
		fetchImpl: async () => {
			throw new TypeError("Failed to fetch");
		},
		cosmosImpl: async (url) => endpoint.respond(url),
	});

	const out = await provider.getTranslation(lyricsOf("uno"), "spotify:track:t", null, "en");

	assert.deepEqual(
		out.map((line) => line.text),
		["T:uno"],
	);
});

test("a Cosmos proxy error reported as a body, not a throw, is still a rate limit", async () => {
	// CosmosAsync hands proxy failures back as { code: 429 } rather than
	// throwing, which is how the shared spicetify CORS proxy reports throttling.
	const { provider, notifications } = load({
		fetchImpl: async () => {
			throw new TypeError("Failed to fetch");
		},
		cosmosImpl: async () => ({ code: 429, error: "Too Many Requests" }),
	});

	assert.equal(await provider.getTranslation(lyricsOf("uno"), "spotify:track:u", null, "en"), null);
	assert.match(notifications[0] ?? "", /rate limited/i);
});

test("a transport that failed once can still be used later", async () => {
	// Pinning a transport exclusively meant a later failure could never fall
	// back to the other one.
	const endpoint = fakeEndpoint();
	let fetchWorks = false;
	const { provider } = load({
		fetchImpl: async (url) => {
			if (!fetchWorks) throw new TypeError("Failed to fetch");
			return { ok: true, status: 200, json: async () => endpoint.respond(url) };
		},
		cosmosImpl: async (url) => {
			if (fetchWorks) throw new Error("cosmos gone");
			return endpoint.respond(url);
		},
	});

	await provider.getTranslation(lyricsOf("uno"), "spotify:track:v", null, "en"); // pins cosmos
	fetchWorks = true;
	const out = await provider.getTranslation(lyricsOf("dos"), "spotify:track:w", null, "en");

	assert.deepEqual(
		out.map((line) => line.text),
		["T:dos"],
	);
});

// --- surface ----------------------------------------------------------------

test("exposes the target languages the menu is built from", () => {
	const { provider } = load();

	assert.ok(Object.keys(provider.TARGETS).length >= 10);
	assert.equal(provider.TARGETS.en, "English");
	for (const code of Object.keys(provider.TARGETS)) assert.match(code, /^[a-z]{2}$/);
});

test("empty or missing lyrics are handled without a request", async () => {
	const endpoint = fakeEndpoint();
	const { provider } = load({ fetchImpl: fetchFrom(endpoint) });

	assert.equal(await provider.getTranslation([], "spotify:track:x", null, "en"), null);
	assert.equal(await provider.getTranslation(null, "spotify:track:x", null, "en"), null);
	assert.equal(endpoint.calls.length, 0);
});

test("a source language override is passed through, and auto-detect is the default", async () => {
	const endpoint = fakeEndpoint();
	const { provider } = load({ fetchImpl: fetchFrom(endpoint) });
	const seen = [];
	const wrapped = endpoint.respond;
	endpoint.respond = (url) => {
		seen.push(new URL(url).searchParams.get("sl"));
		return wrapped(url);
	};

	await provider.getTranslation(lyricsOf("uno"), "spotify:track:y", "es", "en");
	await provider.getTranslation(lyricsOf("uno"), "spotify:track:z", null, "en");

	assert.deepEqual(seen, ["es", "auto"]);
});
