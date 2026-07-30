import Cocoa
import SwiftUI

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, NSMenuItemValidation {
    private var statusItem: NSStatusItem!
    private var window: NSWindow!
    private let broker = BrokerManager()
    private let store = ProfileStore()
    private let zoom = AppZoom()

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        setupMenu()
        setupStatusItem()
        setupWindow()
        broker.start()
    }

    func applicationWillTerminate(_ notification: Notification) { broker.stop() }

    private func setupMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem()
        main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Quit Inter", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        let editItem = NSMenuItem()
        main.addItem(editItem)
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit

        let viewItem = NSMenuItem()
        main.addItem(viewItem)
        let view = NSMenu(title: "View")
        view.addItem(zoomItem("Zoom In", #selector(zoomIn), key: "+"))
        // ⌘+ needs Shift on most layouts; ⌘= is the keystroke fingers actually make.
        view.addItem(zoomItem("Zoom In", #selector(zoomIn), key: "=", hidden: true))
        view.addItem(zoomItem("Zoom Out", #selector(zoomOut), key: "-"))
        view.addItem(zoomItem("Actual Size", #selector(zoomReset), key: "0"))
        viewItem.submenu = view
        NSApp.mainMenu = main
    }

    private func zoomItem(_ title: String, _ action: Selector, key: String, hidden: Bool = false) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.target = self
        item.isHidden = hidden
        item.allowsKeyEquivalentWhenHidden = hidden
        return item
    }

    @objc private func zoomIn() { zoom.zoomIn() }
    @objc private func zoomOut() { zoom.zoomOut() }
    @objc private func zoomReset() { zoom.reset() }

    func validateMenuItem(_ item: NSMenuItem) -> Bool {
        switch item.action {
        case #selector(zoomIn): return zoom.canZoomIn
        case #selector(zoomOut): return zoom.canZoomOut
        case #selector(zoomReset):
            item.title = zoom.isDefault ? "Actual Size" : "Actual Size (\(zoom.label))"
            return !zoom.isDefault
        default: return true
        }
    }

    private func setupStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem.button?.image = NSImage(systemSymbolName: "point.3.connected.trianglepath.dotted",
                                           accessibilityDescription: "Inter")
        statusItem.button?.target = self
        statusItem.button?.action = #selector(toggleWindow)
        statusItem.button?.sendAction(on: [.leftMouseUp, .rightMouseUp])
    }

    private func setupWindow() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 860, height: 600),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                          backing: .buffered, defer: false)
        window.title = "Inter"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.contentViewController = NSHostingController(
            rootView: RootView(store: store, broker: broker, zoom: zoom)
        )
        window.setFrameAutosaveName("InterMainWindow")
        if !window.setFrameUsingName("InterMainWindow") { window.center() }
    }

    @objc private func toggleWindow() {
        if NSApp.currentEvent?.type == .rightMouseUp {
            let menu = NSMenu()
            menu.addItem(withTitle: window.isVisible ? "Hide Inter" : "Open Inter",
                         action: #selector(toggleWindow), keyEquivalent: "").target = self
            menu.addItem(.separator())
            menu.addItem(withTitle: "Quit Inter", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
            statusItem.menu = menu
            statusItem.button?.performClick(nil)
            statusItem.menu = nil
        } else if window.isVisible {
            window.orderOut(nil)
            NSApp.setActivationPolicy(.accessory)
        } else {
            NSApp.setActivationPolicy(.regular)
            NSApp.activate(ignoringOtherApps: true)
            window.makeKeyAndOrderFront(nil)
        }
    }

    func windowWillClose(_ notification: Notification) { NSApp.setActivationPolicy(.accessory) }
}

let app = NSApplication.shared
let delegate = MainActor.assumeIsolated { AppDelegate() }
app.delegate = delegate
app.run()
