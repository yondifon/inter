DIST := dist
APP := $(DIST)/Inter.app
BINDIR ?= $(HOME)/.local/bin

.PHONY: dev server swift-build app-icon bundle install clean

dev:
	cd swift && swift run

server:
	mkdir -p $(DIST)
	@# The stamp is what lets `make install` tell two 0.6.0 builds apart: a
	@# surviving old broker with a matching version number would otherwise pass
	@# verification while serving yesterday's code.
	bun build --compile --define INTER_BUILD_STAMP="\"$$(git rev-parse --short HEAD 2>/dev/null || echo nogit)-$$(date +%Y%m%d%H%M%S)\"" src/cli.ts --outfile $(DIST)/inter-server

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
	@# SwiftPM's `resources:` target (the bundled IBM Plex typeface) builds a
	@# `.bundle` next to the release binary; `Bundle.module`'s generated
	@# accessor looks for it there, so it has to land in the same spot inside
	@# the app. Globbed rather than named, since the exact bundle name is
	@# derived from the package and target names.
	cp -R swift/.build/release/*.bundle $(APP)/Contents/Resources/ 2>/dev/null || true
	@commit=$$(git rev-parse HEAD); \
	sed -e "s/{{COMMIT}}/$$commit/g" \
		-e "s|{{REPO}}|$(CURDIR)|g" \
		Info.plist.template \
		> $(APP)/Contents/Info.plist
	codesign --force --deep --sign - $(APP)

install: bundle
	@# Retiring the broker stops whatever it is driving, so say what that costs
	@# before doing it rather than leaving the wreckage to be discovered. On a
	@# terminal this asks; in a script it warns and continues, because an install
	@# that cannot be overridden is worse than one that destroys work quietly.
	@# INTER_INSTALL_YES=1 skips the prompt.
	@sh scripts/install-preflight.sh $(DIST)/inter-server "$$INTER_INSTALL_YES"
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
	echo "install: broker verified — $$health"; \
	if [ -S "$$HOME/.inter/inter.sock" ]; then \
		echo "install: event socket bound — $$HOME/.inter/inter.sock"; \
	else \
		echo "install: warning: no event socket at $$HOME/.inter/inter.sock; watch will fall back to database polling (harmless, but push is off)"; \
	fi

clean:
	rm -rf $(DIST)
	cd swift && swift package clean
