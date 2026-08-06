import Cocoa
import SwiftUI

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuItemValidation {
    private var statusItem: NSStatusItem!
    private var window: NSWindow!
    private let broker = BrokerManager()
    private let store = ProfileStore()
    private let zoom = AppZoom()
    private let updateChecker = UpdateChecker()
    private let settingsPresentation = SettingsPresentation()

    func applicationDidFinishLaunching(_ notification: Notification) {
        if Bundle.main.object(forInfoDictionaryKey: "CFBundleIconFile") == nil {
            NSApp.applicationIconImage = InterMark.appIcon()
        }
        NSApp.setActivationPolicy(.regular)
        setupMenu()
        setupStatusItem()
        setupWindow()
        broker.start()
        updateChecker.startPeriodicChecks()
    }

    func applicationWillTerminate(_ notification: Notification) { broker.stop() }

    private func setupMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem()
        main.addItem(appItem)
        let appMenu = NSMenu(title: "Inter")
        appMenu.addItem(withTitle: "About Inter",
                        action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)),
                        keyEquivalent: "")
        appMenu.addItem(.separator())
        // NSMenuItem defaults to the Command modifier, so "," alone gives ⌘,
        // the standard Settings shortcut.
        let settingsItem = NSMenuItem(title: "Settings…", action: #selector(openSettings), keyEquivalent: ",")
        settingsItem.target = self
        appMenu.addItem(settingsItem)
        appMenu.addItem(.separator())
        if UpdateChecker.isConfigured {
            let update = appMenu.addItem(
                withTitle: "Check for Updates…",
                action: #selector(checkForUpdates),
                keyEquivalent: ""
            )
            update.target = self
            appMenu.addItem(.separator())
        }
        appMenu.addItem(withTitle: "Hide Inter", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = NSMenuItem(title: "Hide Others",
                                    action: #selector(NSApplication.hideOtherApplications(_:)),
                                    keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(hideOthers)
        appMenu.addItem(withTitle: "Show All",
                        action: #selector(NSApplication.unhideAllApplications(_:)),
                        keyEquivalent: "")
        appMenu.addItem(.separator())
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

    @objc private func checkForUpdates() {
        showWindow()
        Task { await updateChecker.check() }
    }

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
        statusItem.button?.image = InterMark.statusItemImage()
        statusItem.button?.image?.accessibilityDescription = "Inter"
        statusItem.button?.target = self
        statusItem.button?.action = #selector(toggleWindow)
        statusItem.button?.sendAction(on: [.leftMouseUp, .rightMouseUp])
    }

    private func setupWindow() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 860, height: 600),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                          backing: .buffered, defer: false)
        window.title = "Inter"
        // Detail views paint their own plane; this catches what they do not cover —
        // the profile pane, the empty state, and the strip behind the toolbar.
        window.backgroundColor = Surface.contentColor
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.level = .normal
        window.hidesOnDeactivate = false
        window.isReleasedWhenClosed = false
        window.contentViewController = NSHostingController(
            rootView: RootView(store: store, broker: broker, zoom: zoom, updateChecker: updateChecker, settingsPresentation: settingsPresentation)
        )
        window.setFrameAutosaveName("InterMainWindow")
        if !window.setFrameUsingName("InterMainWindow") { window.center() }
    }

    /// No SwiftUI `App`/`Scene` backs this app, so there is no `Settings` scene for
    /// ⌘, to open for free. Settings is a sheet over the main window instead —
    /// this just brings that window forward and flips the shared presentation flag.
    @objc private func openSettings() {
        showWindow()
        settingsPresentation.isPresented = true
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
        } else if window.isVisible && NSApp.isActive {
            hideWindow()
        } else {
            // A visible window behind another app means the click asked for focus, not a hide.
            showWindow()
        }
    }

    private func showWindow() {
        NSApp.activate()
        window.makeKeyAndOrderFront(nil)
    }

    private func hideWindow() {
        window.orderOut(nil)
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { showWindow() }
        return true
    }
}

LegacyDefaults.migrate()
TaskSortDefaults.migrate()
let app = NSApplication.shared
let delegate = MainActor.assumeIsolated { AppDelegate() }
app.delegate = delegate
app.run()
