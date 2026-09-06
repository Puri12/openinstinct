// oi-presence: typing indicator and read receipts for a 1:1 iMessage thread.
//
// Messages' scripting bridge only exposes `send`, so presence has to go
// through Accessibility on the running Messages.app. Technique adapted from
// beeper/platform-imessage (MIT, see LICENSE.platform-imessage): open the
// thread via its deep link, then set the compose field's value (typing) or
// press ⌘⇧U (mark as read). Best-effort by design: any failure exits non-zero
// and the daemon carries on without presence.
//
// usage: oi-presence typing <handle> on|off
//        oi-presence read <handle>
import AppKit
import ApplicationServices

func fail(_ message: String) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(1)
}

let args = CommandLine.arguments
guard args.count >= 3 else { fail("usage: oi-presence typing <handle> on|off | read <handle>") }
let command = args[1], handle = args[2]

guard AXIsProcessTrusted() else { fail("accessibility not granted") }

// Presence needs Messages frontmost for a moment, which steals focus. Only do
// it when the owner is not actively using this Mac (no input for idleSec).
let idleSec = Double(ProcessInfo.processInfo.environment["OI_PRESENCE_IDLE_SEC"] ?? "") ?? 3
let sinceInput = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: CGEventType(rawValue: ~0)!)
if sinceInput < idleSec {
    FileHandle.standardError.write("skipped: owner active (\(Int(sinceInput))s since last input)\n".data(using: .utf8)!)
    exit(0)
}

// Messages must be running; open the thread (imessage:// selects it without sending).
guard let messages = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.MobileSMS").first else {
    fail("Messages is not running")
}
let app = AXUIElementCreateApplication(messages.processIdentifier)

func attribute<T>(_ element: AXUIElement, _ name: String) -> T? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value as? T
}

func descendants(_ root: AXUIElement, depth: Int = 0, into out: inout [AXUIElement]) {
    guard depth < 25 else { return }
    out.append(root)
    let children: [AXUIElement] = attribute(root, kAXChildrenAttribute) ?? []
    for child in children { descendants(child, depth: depth + 1, into: &out) }
}

func composeField() -> AXUIElement? {
    guard let window: AXUIElement = attribute(app, kAXMainWindowAttribute) ?? (attribute(app, kAXWindowsAttribute) as [AXUIElement]?)?.first else { return nil }
    var all: [AXUIElement] = []
    descendants(window, into: &all)
    // The compose box is the settable AXTextField that is not the search field
    // (transcript bubbles are AXTextAreas, so those are excluded).
    return all.first { element in
        let role: String? = attribute(element, kAXRoleAttribute)
        let subrole: String? = attribute(element, kAXSubroleAttribute)
        guard role == kAXTextFieldRole as String, subrole != (kAXSearchFieldSubrole as String) else { return false }
        var settable: DarwinBoolean = false
        AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable)
        return settable.boolValue
    }
}

/// Messages only emits typing / marks read while it is the active app, so
/// bring it forward for the shortest possible moment and hand focus straight
/// back to whatever the owner was using. No window ordering changes persist.
func frontmostPid() -> pid_t? { NSWorkspace.shared.frontmostApplication?.processIdentifier }

func activate(pid: pid_t, bundleId: String?) -> Bool {
    // NSRunningApplication.activate is a no-op for a launchd-spawned helper
    // (no Aqua activation rights). System Events can do it on our behalf.
    if let app = NSRunningApplication(processIdentifier: pid) { app.activate(options: [.activateIgnoringOtherApps]) }
    for _ in 0..<8 {
        if frontmostPid() == pid { return true }
        let script = "tell application \"System Events\" to set frontmost of (first process whose unix id is \(pid)) to true"
        let task = Process(); task.executableURL = URL(fileURLWithPath: "/usr/bin/osascript"); task.arguments = ["-e", script]
        task.standardError = FileHandle.nullDevice; task.standardOutput = FileHandle.nullDevice
        try? task.run(); task.waitUntilExit()
        usleep(120_000)
    }
    return frontmostPid() == pid
}

func withActivation(_ body: () -> Void) {
    // Re-check right before stealing focus: the owner may have sat down since launch.
    let idleNow = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: CGEventType(rawValue: ~0)!)
    if idleNow < idleSec { exit(0) }
    let previous = NSWorkspace.shared.frontmostApplication
    guard activate(pid: messages.processIdentifier, bundleId: "com.apple.MobileSMS") else { fail("could not bring Messages frontmost") }
    usleep(120_000)
    body()
    usleep(150_000)
    if let previous, previous.processIdentifier != messages.processIdentifier {
        _ = activate(pid: previous.processIdentifier, bundleId: previous.bundleIdentifier)
    }
}

func press(key: CGKeyCode, flags: CGEventFlags) {
    let down = CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: true)
    let up = CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: false)
    down?.flags = flags; up?.flags = flags
    down?.postToPid(messages.processIdentifier)
    up?.postToPid(messages.processIdentifier)
}

switch command {
case "typing":
    guard args.count >= 4 else { fail("typing needs on|off") }
    let on = args[3] == "on"
    // Never activate Messages or open the thread: that steals the owner's
    // focus. Key events are posted straight to Messages' pid, which works
    // while it sits in the background, and the compose field is focused via
    // AX inside the app only. The daemon is single-owner, so the selected
    // conversation is already the owner's thread.
    guard let field = composeField() else { fail("compose field not found") }
    withActivation {
        // After a read (sidebar row press) keyboard focus sits on the sidebar;
        // an AX focus request alone is not always honoured. Click the field.
        for _ in 0..<5 {
            AXUIElementSetAttributeValue(field, kAXFocusedAttribute as CFString, kCFBooleanTrue)
            usleep(80_000)
            let focused: Bool = attribute(field, kAXFocusedAttribute) ?? false
            if focused { break }
            var pos = CGPoint.zero, size = CGSize.zero
            if let p: AXValue = attribute(field, kAXPositionAttribute), let sz: AXValue = attribute(field, kAXSizeAttribute) {
                AXValueGetValue(p, .cgPoint, &pos); AXValueGetValue(sz, .cgSize, &size)
                let center = CGPoint(x: pos.x + size.width / 2, y: pos.y + size.height / 2)
                CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: center, mouseButton: .left)?.postToPid(messages.processIdentifier)
                CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: center, mouseButton: .left)?.postToPid(messages.processIdentifier)
                usleep(120_000)
            }
        }
        if on {
            press(key: 0x31 /* space */, flags: [])
        } else {
            // ⌘A then delete clears the draft, withdrawing the indicator.
            press(key: 0x00 /* A */, flags: [.maskCommand])
            press(key: 0x33 /* delete */, flags: [])
        }
    }
case "read":
    // chat.db is_read is not reliably updated on Messages 26, so it cannot
    // gate this. Activation with the thread showing sends the read receipt;
    // the sidebar badge (when present) is cleared with ⌘⇧U. ⌘⇧U toggles, so
    // it is pressed only when the badge is actually visible.
    withActivation {
        if let row = unreadRow() {
            AXUIElementPerformAction(row, kAXPressAction as CFString)
            usleep(400_000)
            if unreadRow() != nil { press(key: 0x20 /* U */, flags: [.maskCommand, .maskShift]) }
        }
        usleep(250_000)
    }
default:
    fail("unknown command \(command)")
}

func latestInboundUnread() -> Bool {
    let db = NSHomeDirectory() + "/Library/Messages/chat.db"
    let sql = "SELECT m.is_read FROM message m JOIN handle h ON h.ROWID = m.handle_id WHERE h.id = '\(handle.replacingOccurrences(of: "'", with: ""))' AND m.is_from_me = 0 ORDER BY m.ROWID DESC LIMIT 1"
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/usr/bin/sqlite3")
    task.arguments = ["-readonly", db, sql]
    let pipe = Pipe(); task.standardOutput = pipe; task.standardError = FileHandle.nullDevice
    do { try task.run() } catch { return false }
    task.waitUntilExit()
    let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return out == "0"
}

func unreadRow() -> AXUIElement? {
    // Sidebar rows are AXStaticText "name, 읽지 않음, preview, time". The open
    // thread's name is the window title, so match on that to avoid pressing
    // another contact's unread row.
    guard let window: AXUIElement = attribute(app, kAXMainWindowAttribute) else { return nil }
    let title: String = attribute(window, kAXTitleAttribute) ?? ""
    var all: [AXUIElement] = []
    descendants(window, into: &all)
    return all.first { element in
        let role: String? = attribute(element, kAXRoleAttribute)
        guard role == kAXStaticTextRole as String else { return false }
        let description: String = attribute(element, kAXDescriptionAttribute) ?? ""
        let unread = description.contains("읽지 않음") || description.localizedCaseInsensitiveContains("unread")
        return unread && (title.isEmpty || description.hasPrefix(title + ","))
    }
}
