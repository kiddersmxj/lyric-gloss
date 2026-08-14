// Test fixture — see the header of index.js in this directory.
//
// Present only so the sweep of the retired PlaybarButton edit is exercised.
// The patch set does not touch this file any more: lyrics-plus's own playbar
// button hides the native one before registering its replacement, so on a
// build where that API doesn't match you get no lyrics button at all. The
// lyric-gloss-playbar extension hijacks the native button instead.

function setPlaybarButton() {
	return Spicetify.Playbar.Button();
}

function init() {
	if (Spicetify.LocalStorage.get("lyrics-plus:visual:playbar-button") === "true") setPlaybarButton();
}

void init;
