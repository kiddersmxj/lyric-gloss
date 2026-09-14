# lyric-gloss: development and operation.
#
# `make help` lists everything. Targets are grouped by what they act on:
#
#   (local)      this checkout: the test suite and lint
#   (spotify)    the Spotify client and spicetify on this laptop
#   hook-*       the pacman hook that re-applies after Spotify updates
#   devtools-*   Spotify's developer mode, for inspecting the running client
#
# This file is maintained as the project grows: any command typed more than
# twice belongs here. See docs/development.md.
#
# Targets that need root say so and call sudo themselves, so they prompt in your
# terminal. Nothing here ever starts Spotify: a Spotify launched from a script
# breaks end-of-track auto-advance, so start it from your launcher.

.DEFAULT_GOAL := help
SHELL := /bin/bash

# Where things are on this machine. The scripts read the same variables, so an
# override here reaches all of them.
export SPICETIFY_HOME ?= $(HOME)/.spicetify
export SPOTIFY_DIR    ?= /opt/spotify
export HOOK_LOG       ?= /var/log/lyric-gloss.log

.PHONY: help
help: ## Show this help
	@echo ""
	@echo "  lyric-gloss make targets"
	@awk 'BEGIN {FS = ":.*?## "} \
		/^# --- / { gsub(/^# --- /, ""); gsub(/ -*$$/, ""); printf "\n  \033[1m%s\033[0m\n", $$0 } \
		/^[a-zA-Z0-9_-]+:.*?## / { printf "    \033[36m%-18s\033[0m %s\n", $$1, $$2 }' \
		$(MAKEFILE_LIST)
	@echo ""

# --- Local development ------------------------------------------------------

.PHONY: test
test: ## Whole suite: patch round-trip, provider, script syntax, shellcheck
	@./test

.PHONY: test-patch
test-patch: ## patch.py only
	@./test patch

.PHONY: test-provider
test-provider: ## Translation provider only
	@./test provider

.PHONY: lint
lint: ## Script syntax and shellcheck only
	@./test shell

# --- Spotify on this laptop -------------------------------------------------

.PHONY: status
status: ## What is installed, what Spotify is running, whether translation answers
	@./scripts/status.sh

.PHONY: install
install: ## Patch and apply to Spotify (asks for sudo once), then start it from your launcher
	@./install.sh

.PHONY: uninstall
uninstall: ## Remove the hook, restore stock Spotify, unpatch lyrics-plus (asks for sudo)
	@./uninstall.sh

.PHONY: anchors
anchors: ## After a spicetify upgrade: list every patch anchor its lyrics-plus breaks
	@python3 patch.py check "$(SPICETIFY_HOME)"

.PHONY: runs
runs: ## Installer runs today, from sudo's journal — when /opt was opened and closed
	@journalctl -q --no-pager _COMM=sudo --since today 2>/dev/null | \
		grep -E 'COMMAND=.*(chmod a\+wr|chown -R root:root) $(SPOTIFY_DIR)$$' | \
		sed -E 's/^([A-Za-z]+ +[0-9]+ [0-9:]+).*COMMAND=/\1  /' || echo "no installer runs today"

.PHONY: lrclib
lrclib: ## How much LRCLIB's timings disagree for a song:  make lrclib Q="title artist"
	@test -n "$(Q)" || { echo 'usage: make lrclib Q="title artist"'; exit 2; }
	@python3 scripts/lrclib-compare.py "$(Q)"

# --- Pacman hook (Arch) -----------------------------------------------------

.PHONY: hook-install
hook-install: ## Re-apply automatically after every Spotify update (asks for sudo)
	@./install-hook.sh

.PHONY: hook-test
hook-test: ## Fire the hook now by reinstalling the current Spotify (asks for sudo)
	sudo pacman -S spotify

.PHONY: hook-log
hook-log: ## Recent hook runs, in full
	@if [[ -r "$(HOOK_LOG)" ]]; then tail -n 80 "$(HOOK_LOG)" | sed 's/\x1b\[[0-9;]*[a-zA-Z]//g'; \
	else echo "no hook log at $(HOOK_LOG) — the hook has not run since it was installed"; fi

# --- Developer mode ---------------------------------------------------------

.PHONY: devtools-on
devtools-on: ## Quit Spotify and enable developer mode for the next launch
	@./scripts/devtools.sh on

.PHONY: devtools-off
devtools-off: ## Quit Spotify and disable developer mode for the next launch
	@./scripts/devtools.sh off

.PHONY: devtools-check
devtools-check: ## Is the debugging channel actually open?
	@./scripts/devtools.sh check
