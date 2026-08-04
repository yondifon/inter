DIST := dist
APP := $(DIST)/Inter.app
BINDIR ?= $(HOME)/.local/bin

.PHONY: dev server swift-build app-icon bundle install clean

dev:
	cd swift && swift run

server:
	mkdir -p $(DIST)
	bun build --compile src/cli.ts --outfile $(DIST)/inter-server

swift-build:
	cd swift && swift build -c release

app-icon:
	CLANG_MODULE_CACHE_PATH=/tmp/inter-icon-clang-cache swift scripts/generate-app-icon.swift $(DIST)/Inter.iconset
	iconutil -c icns --output $(DIST)/Inter.icns $(DIST)/Inter.iconset

bundle: server swift-build app-icon
	rm -rf $(APP)
	mkdir -p $(APP)/Contents/MacOS $(APP)/Contents/Resources
	cp swift/.build/release/Inter $(APP)/Contents/MacOS/Inter
	cp $(DIST)/inter-server $(APP)/Contents/Resources/inter-server
	cp $(DIST)/Inter.icns $(APP)/Contents/Resources/Inter.icns
	cp Info.plist.template $(APP)/Contents/Info.plist
	codesign --force --deep --sign - $(APP)

install: bundle
	@# Retiring the broker stops whatever it is driving, so say what that costs
	@# before doing it rather than leaving the wreckage to be discovered. On a
	@# terminal this asks; in a script it warns and continues, because an install
	@# that cannot be overridden is worse than one that destroys work quietly.
	@# INTER_INSTALL_YES=1 skips the prompt.
	@if ! $(DIST)/inter-server inflight; then \
		if [ -t 0 ] && [ -z "$$INTER_INSTALL_YES" ]; then \
			printf 'Stop them and continue? [y/N] '; read -r reply; \
			case "$$reply" in [yY]*) ;; *) echo "install aborted"; exit 1 ;; esac; \
		else \
			echo "install: continuing anyway (non-interactive)"; \
		fi; \
	fi
	pkill -x Inter || true
	# The broker outlives the app it was spawned from, and the next launch finds
	# port 7331 already answering /health — so it reports healthy while serving
	# the previous build's contract. Retire it with the app.
	pkill -f 'Contents/Resources/inter-server' || true
	rm -rf /Applications/Inter.app
	cp -R $(APP) /Applications/Inter.app
	open /Applications/Inter.app
	@# The bundle is the app, not the CLI: link the broker binary onto PATH so
	@# `inter` names this install. BINDIR overrides where the link lands, and a
	@# link directory missing from PATH is a warning, never a failure.
	mkdir -p $(BINDIR)
	ln -sf /Applications/Inter.app/Contents/Resources/inter-server $(BINDIR)/inter
	@case ":$$PATH:" in \
		*":$(BINDIR):"*) ;; \
		*) echo "install: warning: $(BINDIR) is not on PATH; add it to your shell profile for the inter command" ;; \
	esac
	@# open(1) returning is not success: a cold launch takes seconds to answer,
	@# and a broker that survived the pkill answers with the previous build's
	@# contract. Success is the port answering with exactly what the binary
	@# just built reports; anything else fails the install loudly.
	@health=""; \
	for i in $$(seq 1 30); do \
		health=$$(curl -sf --max-time 2 http://127.0.0.1:7331/health 2>/dev/null) && break; \
		sleep 1; \
	done; \
	if [ -z "$$health" ]; then \
		echo "install: FAILED: no broker answered /health on port 7331 within 30s of launch"; \
		exit 1; \
	fi; \
	built=$$($(DIST)/inter-server version); \
	if [ "$$health" != "$$built" ]; then \
		echo "install: FAILED: the broker on port 7331 is not the build just installed"; \
		echo "  /health answers: $$health"; \
		echo "  just built:      $$built"; \
		exit 1; \
	fi; \
	echo "install: broker verified — $$health"

clean:
	rm -rf $(DIST)
	cd swift && swift package clean
