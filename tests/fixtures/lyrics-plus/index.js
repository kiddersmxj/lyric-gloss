// Test fixture — a stand-in for spicetify lyrics-plus's index.js.
//
// This is NOT upstream code. It is the smallest valid JavaScript that carries
// every region patch.py anchors on, at the exact indentation upstream uses, so
// the patch can be applied, removed and syntax-checked without a spicetify
// install and without vendoring an LGPL bundle into this repo.
//
// If an anchor moves upstream, the real install fails loudly (apply refuses)
// and this fixture keeps passing — that is the intended split. These tests
// cover the patch machinery; upstream drift is caught at install time.

const APP_NAME = "lyrics-plus";
const MUSIXMATCH_TRANSLATION_PREFIX = "musixmatchTranslation:";

const getConfig = (key, fallback = true) => (localStorage.getItem(key) === null ? fallback : localStorage.getItem(key) === "true");

const CONFIG = {
	visual: {
		alignment: localStorage.getItem("lyrics-plus:visual:alignment") || "center",
		translate: true,
		"translate:translated-lyrics-source": localStorage.getItem("lyrics-plus:visual:translate:translated-lyrics-source") || "none",
		"translate:display-mode": localStorage.getItem("lyrics-plus:visual:translate:display-mode") || "replace",
		"translate:detect-language-override": localStorage.getItem("lyrics-plus:visual:translate:detect-language-override") || "off",
		"synced-compact": getConfig("lyrics-plus:visual:synced-compact"),
		"playbar-button": getConfig("lyrics-plus:visual:playbar-button", false),
	},
	providersOrder: localStorage.getItem("lyrics-plus:services-order"),
	locked: localStorage.getItem("lyrics-plus:lock-mode") || "-1",
};

const CACHE = {};

function resolveTranslationSource(source) {
	if (source.startsWith(MUSIXMATCH_TRANSLATION_PREFIX)) {
		return { key: "musixmatchTranslation", language: source.slice(MUSIXMATCH_TRANSLATION_PREFIX.length) };
	}

	return { key: source, language: null };
}

class LyricsContainer {
	constructor() {
		this.state = {
			musixmatchTranslation: null,
			neteaseTranslation: null,
			uri: "",
		};
		this._musixmatchTranslationRequestId = null;
	}

	infoFromTrack(track) {
		return track;
	}

	setState(next) {
		this.state = { ...this.state, ...next };
	}

	lyricsSource(lyricsState, lang) {
		const friendlyLanguage = lang && lang.split("-")[0].toLowerCase();
		const translationSourceConfig = resolveTranslationSource(CONFIG.visual["translate:translated-lyrics-source"]);
		const lyrics = lyricsState[translationSourceConfig.key] ?? lyricsState.currentLyrics;

		if (CONFIG.visual.translate) {
			this.state.currentLyrics = lyricsState[CONFIG.visual[`translation-mode:${friendlyLanguage}`]] ?? lyrics;
		}

		return this.state.currentLyrics;
	}

	resetTranslationState(tempState) {
		if (this.state.uri) {
			this.setState({
				...{
					musixmatchTranslation: null,
					neteaseTranslation: null,
					...tempState,
				},
			});
		}
	}

	render() {
		const hasMusixmatchLanguages = false;
		const hasTranslation = this.state.neteaseTranslation !== null || this.state.musixmatchTranslation !== null || hasMusixmatchLanguages;

		return { hasTranslation, appName: APP_NAME, cache: CACHE };
	}
}

void LyricsContainer;
