DIST := dist
APP := $(DIST)/Inter.app

.PHONY: dev server swift-build bundle install clean

dev:
	cd swift && swift run

server:
	mkdir -p $(DIST)
	bun build --compile src/cli.ts --outfile $(DIST)/inter-server

swift-build:
	cd swift && swift build -c release

bundle: server swift-build
	rm -rf $(APP)
	mkdir -p $(APP)/Contents/MacOS $(APP)/Contents/Resources
	cp swift/.build/release/Inter $(APP)/Contents/MacOS/Inter
	cp $(DIST)/inter-server $(APP)/Contents/Resources/inter-server
	cp Info.plist.template $(APP)/Contents/Info.plist
	codesign --force --deep --sign - $(APP)

install: bundle
	pkill -x Inter || true
	rm -rf /Applications/Inter.app
	cp -R $(APP) /Applications/Inter.app
	open /Applications/Inter.app

clean:
	rm -rf $(DIST)
	cd swift && swift package clean
