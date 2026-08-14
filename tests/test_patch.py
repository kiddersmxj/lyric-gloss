"""Tests for patch.py — the text edits applied to spicetify's lyrics-plus.

The property that matters most is byte-identical removal: `uninstall.sh` is the
only way back to a stock client, and if `remove` drifts even by a character the
next `spicetify upgrade` inherits a half-patched app.

These run against `tests/fixtures/lyrics-plus`, a synthetic stand-in carrying
every anchored region at upstream's indentation. No spicetify install, no
network, no vendored upstream code.
"""

import importlib.util
import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
FIXTURE = Path(__file__).resolve().parent / "fixtures" / "lyrics-plus"
JS_FILES = ("index.js", "Pages.js", "OptionsMenu.js")


def _load_patch_module():
    spec = importlib.util.spec_from_file_location("patch", REPO / "patch.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


patch = _load_patch_module()


@pytest.fixture
def spice(tmp_path):
    """A fake ~/.spicetify containing an unpatched lyrics-plus."""
    app = tmp_path / "CustomApps" / "lyrics-plus"
    app.parent.mkdir(parents=True)
    shutil.copytree(FIXTURE, app)
    return tmp_path


def run(action, root, expect=0):
    result = subprocess.run(
        [sys.executable, str(REPO / "patch.py"), action, str(root)],
        capture_output=True,
        text=True,
    )
    assert result.returncode == expect, f"{action} exited {result.returncode}\n{result.stdout}{result.stderr}"
    return result


def snapshot(app: Path) -> dict[str, bytes]:
    return {p.name: p.read_bytes() for p in sorted(app.iterdir()) if p.is_file()}


# --- the anchors themselves -------------------------------------------------


@pytest.mark.parametrize("name,anchor", [(e[0], e[1]) for e in patch.EDITS], ids=range(len(patch.EDITS)))
def test_every_anchor_appears_exactly_once_in_the_fixture(spice, name, anchor):
    """The fixture has to keep carrying every anchored region.

    Applied edits chain — later anchors can match text an earlier edit
    introduced — so this checks the pristine file only for the ones that are
    present there, and apply() covers the rest.
    """
    app = spice / "CustomApps" / "lyrics-plus"
    text = (app / name).read_text()
    if anchor not in text:
        pytest.skip("anchor is introduced by an earlier edit; covered by test_apply_succeeds")
    assert text.count(anchor) == 1


def test_apply_succeeds_on_the_fixture(spice):
    result = run("apply", spice)
    assert "patched" in result.stdout


# --- round trip -------------------------------------------------------------


def test_round_trip_is_byte_identical(spice):
    app = spice / "CustomApps" / "lyrics-plus"
    before = snapshot(app)

    run("apply", spice)
    assert snapshot(app) != before, "apply changed nothing"

    run("remove", spice)
    assert snapshot(app) == before


def test_apply_is_idempotent(spice):
    app = spice / "CustomApps" / "lyrics-plus"

    run("apply", spice)
    once = snapshot(app)

    result = run("apply", spice)
    assert "already patched" in result.stdout
    assert snapshot(app) == once


def test_remove_on_an_unpatched_tree_is_a_no_op(spice):
    app = spice / "CustomApps" / "lyrics-plus"
    before = snapshot(app)

    result = run("remove", spice)
    assert "not patched" in result.stdout
    assert snapshot(app) == before


def test_apply_remove_apply_matches_a_single_apply(spice):
    """Re-running install.sh removes first, so this is the real-world path."""
    app = spice / "CustomApps" / "lyrics-plus"

    run("apply", spice)
    first = snapshot(app)

    run("remove", spice)
    run("apply", spice)
    assert snapshot(app) == first


# --- the provider file ------------------------------------------------------


def test_provider_is_installed_and_removed(spice):
    app = spice / "CustomApps" / "lyrics-plus"
    provider = app / "ProviderAutoTranslate.js"

    assert not provider.exists()
    run("apply", spice)
    assert provider.read_text() == (REPO / "src" / "ProviderAutoTranslate.js").read_text()

    run("remove", spice)
    assert not provider.exists()


def test_manifest_lists_the_provider_and_stays_valid_json(spice):
    app = spice / "CustomApps" / "lyrics-plus"
    run("apply", spice)

    manifest = json.loads((app / "manifest.json").read_text())
    assert "ProviderAutoTranslate.js" in manifest["subfiles"]
    assert manifest["subfiles"].index("ProviderAutoTranslate.js") == manifest["subfiles"].index("ProviderLRCLIB.js") + 1


# --- failure behaviour ------------------------------------------------------


def test_apply_refuses_when_an_anchor_has_moved(spice):
    """Upstream drift must fail loudly rather than corrupt the app."""
    app = spice / "CustomApps" / "lyrics-plus"
    index = app / "index.js"
    index.write_text(index.read_text().replace('\tlocked: localStorage.getItem("lyrics-plus:lock-mode") || "-1",', "\tlocked: getConfig(),"))

    result = run("apply", spice, expect=1)
    assert "patch NOT applied" in result.stderr


def test_a_failed_apply_leaves_every_file_untouched(spice):
    """Edits are staged in memory and written only once all of them land."""
    app = spice / "CustomApps" / "lyrics-plus"

    # Break an anchor near the end of the list, so the earlier edits — including
    # ones in other files — would already have been written if apply wrote as
    # it went.
    pages = app / "Pages.js"
    pages.write_text(pages.read_text().replace("\tconst lyricsId = lyrics[0].text;", "\tconst lyricsId = trackId;"))

    before = snapshot(app)
    run("apply", spice, expect=1)
    assert snapshot(app) == before


def test_an_anchor_present_twice_is_refused(spice):
    """Ambiguity is drift too: str.replace would edit both sites."""
    app = spice / "CustomApps" / "lyrics-plus"
    index = app / "index.js"
    text = index.read_text()
    anchor = '\t\t"translate:display-mode": localStorage.getItem("lyrics-plus:visual:translate:display-mode") || "replace",'
    index.write_text(text.replace(anchor, anchor + "\n" + anchor))

    result = run("apply", spice, expect=1)
    assert "not found exactly once" in result.stderr


# --- retired edits ----------------------------------------------------------


@pytest.mark.parametrize("name,patched,original", patch.RETIRED, ids=range(len(patch.RETIRED)))
def test_retired_edits_are_swept_on_apply_and_on_remove(spice, name, patched, original):
    """A shipped-then-dropped edit must not be stranded in an existing tree.

    `remove` only knows how to reverse the *current* EDITS, so RETIRED is the
    only thing that can get an old install back to stock.
    """
    app = spice / "CustomApps" / "lyrics-plus"
    pristine = snapshot(app)
    target = app / name

    # Reconstruct a tree that still carries the retired edit. Some retired
    # edits anchored on text another edit introduced, so their region only
    # exists in a patched tree — which is also the real situation, since the
    # tree being swept is always one an older install.sh patched.
    if original not in target.read_text():
        run("apply", spice)
        if original not in target.read_text():
            pytest.skip(f"the region this {name} edit applied to no longer exists in either state")

    target.write_text(target.read_text().replace(original, patched, 1))

    run("remove", spice)
    assert snapshot(app) == pristine, "remove did not sweep the retired edit"


def test_no_retired_form_is_reintroduced_by_the_current_patch(spice):
    """apply() sweeps RETIRED first, so an edit that recreates a retired form
    would be undone on the next run — a silent, self-inflicted regression."""
    app = spice / "CustomApps" / "lyrics-plus"
    run("apply", spice)

    for name, patched, _ in patch.RETIRED:
        assert patched not in (app / name).read_text(), f"current EDITS reproduce a RETIRED form in {name}"


# --- what the patch is actually for -----------------------------------------


def test_forced_settings_are_baked_in_not_defaulted(spice):
    """CONFIG.visual reads `localStorage.getItem(...) || "<default>"`, so a
    patched *default* is ignored whenever a stale value exists — and the menus
    that would let you change it back are hidden. These must be literals."""
    app = spice / "CustomApps" / "lyrics-plus"
    run("apply", spice)
    text = (app / "index.js").read_text()

    assert '"translate:translated-lyrics-source": "autoTranslation:en",' in text
    assert '"translate:display-mode": "below",' in text
    assert '\t\talignment: "left",' in text
    assert '\tlocked: "1",' in text
    assert '"synced-compact": false,' in text

    for key in ("visual:translate:translated-lyrics-source", "visual:translate:display-mode", "visual:alignment", "lock-mode"):
        assert f'localStorage.getItem("lyrics-plus:{key}")' not in text, f"{key} is still read from localStorage"


def test_translation_menu_is_ungated(spice):
    """Utils.detectLanguage only resolves CJK, so upstream's hasTranslation is
    false for exactly the languages this targets."""
    app = spice / "CustomApps" / "lyrics-plus"
    run("apply", spice)

    assert 'typeof ProviderAutoTranslate !== "undefined";' in (app / "index.js").read_text()


def test_auto_translate_targets_are_offered_in_the_menu(spice):
    app = spice / "CustomApps" / "lyrics-plus"
    run("apply", spice)

    assert "autoTranslation:${code}" in (app / "OptionsMenu.js").read_text()


def test_scroll_fixes_are_present(spice):
    app = spice / "CustomApps" / "lyrics-plus"
    run("apply", spice)
    text = (app / "Pages.js").read_text()

    assert "Spicetify.Player?.data?.item?.uri" in text, "lyricsId is not unique per track"
    assert "lastUserScroll" in text, "auto-follow does not stand aside for manual scrolling"
    assert 'behavior: initialScroll.current || jumped ? "auto" : "smooth",' in text, "scrubs animate"
    assert "if (nextStart && nextStart - position < 300) {" not in text, "short-intro early return still skips the snap to top"


# --- syntax -----------------------------------------------------------------


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
@pytest.mark.parametrize("name", JS_FILES)
def test_patched_files_parse(spice, name):
    """One syntax error takes out the whole lyrics app."""
    app = spice / "CustomApps" / "lyrics-plus"
    run("apply", spice)

    result = subprocess.run(["node", "--check", str(app / name)], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
@pytest.mark.parametrize("name", ["src/ProviderAutoTranslate.js", "src/lyric-gloss-playbar.js"])
def test_shipped_sources_parse(name):
    result = subprocess.run(["node", "--check", str(REPO / name)], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
