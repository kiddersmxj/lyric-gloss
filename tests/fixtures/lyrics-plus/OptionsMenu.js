// Test fixture — see the header of index.js in this directory.
//
// Carries the translation-source option list, which is where the patch appends
// the auto-translate targets.

function translationSourceOptions(state) {
	const sourceOptions = { none: "None" };
	let extra = {};

	if (state.hasNetease) {
		if (state.language === "zh") {
			extra = {
				musixmatchTranslation: "Musixmatch",
				neteaseTranslation: "Chinese (Netease)",
			};
		}

		Object.assign(sourceOptions, extra);
	}

	return sourceOptions;
}

void translationSourceOptions;
