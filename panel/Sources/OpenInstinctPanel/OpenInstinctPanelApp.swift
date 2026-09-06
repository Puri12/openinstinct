import AppKit
import SwiftUI

/// Template (monochrome) glyph so the menu bar tints it for light/dark and overflow.
private func menuBarIcon() -> NSImage {
    let base = Bundle.main.resourceURL?.appendingPathComponent("menubar.png")
    let image = base.flatMap { NSImage(contentsOf: $0) }
        ?? NSImage(systemSymbolName: "sparkles", accessibilityDescription: "OpenInstinct")!
    image.isTemplate = true
    image.size = NSSize(width: 16, height: 16)
    return image
}

/// AppKit status item host. SwiftUI's `MenuBarExtra` does not reliably create
/// its NSStatusItem when the process is spawned by launchd (no Aqua activation),
/// so the item is created explicitly and the SwiftUI view lives in a popover.
@MainActor
final class PanelAppDelegate: NSObject, NSApplicationDelegate, NSPopoverDelegate {
    private var statusItem: NSStatusItem!
    private let popover = NSPopover()
    private let model = PanelViewModel()
    private let updates = UpdateChecker()
    private var monitor: Any?
    private var attentionTimer: Timer?
    private var shownAttentionIDs = Set<String>()

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        popover.behavior = .transient
        popover.animates = false
        popover.delegate = self
        popover.contentViewController = NSHostingController(rootView: MenuBarView(model: model, updates: updates))

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.behavior = [.removalAllowed, .terminationOnRemoval]
        if let button = statusItem.button {
            button.image = menuBarIcon()
            button.imagePosition = .imageOnly
            button.imageScaling = .scaleNone
            button.toolTip = "OpenInstinct"
            button.target = self
            button.action = #selector(toggle(_:))
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        }
        statusItem.isVisible = true

        // Surface owner-only fixes (TCC grants, broken attachment paste) as a
        // real alert, once per issue, instead of hoping they open the popover.
        attentionTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.checkAttention() }
        }
        Task { @MainActor in await checkAttention() }
    }

    private func checkAttention() async {
        await model.refresh()
        guard let attention = model.status?.attention, !shownAttentionIDs.contains(attention.id) else { return }
        shownAttentionIDs.insert(attention.id)
        statusItem.button?.image = badgedIcon()
        let alert = NSAlert()
        alert.messageText = attention.title
        alert.informativeText = attention.detail
        alert.alertStyle = .warning
        let primary = attention.action == "open_automation" ? "Open Automation settings" : (attention.action == "open_settings" ? "Open Settings" : "OK")
        alert.addButton(withTitle: primary)
        alert.addButton(withTitle: "Later")
        NSApp.activate(ignoringOtherApps: true)
        let choice = alert.runModal()
        if choice == .alertFirstButtonReturn, attention.action == "open_settings" {
            SettingsWindowController.shared.show(model: model, tab: .account)
        }
        if choice == .alertFirstButtonReturn, attention.action == "open_automation" {
            NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation")!)
        }
    }

    private func badgedIcon() -> NSImage {
        let base = menuBarIcon()
        let image = NSImage(size: base.size)
        image.lockFocus()
        base.draw(in: NSRect(origin: .zero, size: base.size))
        NSColor.systemOrange.setFill()
        NSBezierPath(ovalIn: NSRect(x: base.size.width - 6, y: base.size.height - 6, width: 6, height: 6)).fill()
        image.unlockFocus()
        image.isTemplate = false
        return image
    }

    @objc private func toggle(_ sender: Any?) {
        guard let button = statusItem.button else { return }
        if popover.isShown {
            popover.performClose(sender)
            return
        }
        // Tahoe's menu bar floats in a rounded bezel; anchoring to the bare
        // button bounds jams the popover against it. Drop the anchor below the
        // bar so the arrow clears the bezel and the panel sits under it.
        // The positioning rect must stay inside the button's bounds or AppKit
        // silently refuses to show the popover; bezel clearance comes from the
        // view's own top padding instead.
        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        NSApp.activate(ignoringOtherApps: true)
        monitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
            Task { @MainActor in self?.popover.performClose(nil) }
        }
    }

    func popoverDidClose(_ notification: Notification) {
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
    }
}

@main
enum OpenInstinctPanelMain {
    static func main() {
        MainActor.assumeIsolated {
            run()
        }
    }

    @MainActor private static func run() {
        let app = NSApplication.shared
        let delegate = PanelAppDelegate()
        app.delegate = delegate
        app.run()
    }
}
