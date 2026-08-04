DIST := dist
APP := $(DIST)/Inter.app

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

clean:
	rm -rf $(DIST)
	cd swift && swift package clean
