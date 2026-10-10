import AppKit
import ApplicationServices

private func targetAttr(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}
private func targetAttrResult(_ element: AXUIElement, _ name: String) -> (AXError, CFTypeRef?) {
    var value: CFTypeRef?
    let error = AXUIElementCopyAttributeValue(element, name as CFString, &value)
    return (error, value)
}
private func targetElement(_ value: CFTypeRef?) -> AXUIElement? {
    guard let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}
// AXURL providers may return either a CFString or a CFURL/NSURL. Preserve the
// actual URL so the existing domain privacy filter can make its decision.
func inputTargetURL(_ value: CFTypeRef?) -> String? {
    if let string = value as? String { return string }
    if let url = value as? URL { return url.absoluteString }
    return nil
}
private func targetRange(_ element: AXUIElement) -> CFRange? {
    guard let value = targetAttr(element, kAXSelectedTextRangeAttribute as String), CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    var range = CFRange()
    return AXValueGetValue(value as! AXValue, .cfRange, &range) ? range : nil
}
private func targetJSON(_ value: [String: Any]) -> UnsafeMutablePointer<CChar>? {
    guard let data = try? JSONSerialization.data(withJSONObject: value), let string = String(data: data, encoding: .utf8) else { return strdup("{}") }
    return strdup(string)
}
private func editableTarget(_ element: AXUIElement, failure: ((String) -> Void)? = nil) -> AXUIElement? {
    var current: AXUIElement? = element
    for _ in 0..<12 {
        guard let node = current else { return nil }
        let role = targetAttr(node, kAXRoleAttribute as String) as? String ?? ""
        let subrole = targetAttr(node, kAXSubroleAttribute as String) as? String ?? ""
        if (role + subrole).lowercased().contains("secure") { return nil }
        if ["AXTextField", "AXTextArea", "AXSearchField", "AXComboBox"].contains(role) {
            if targetAttr(node, kAXEnabledAttribute as String) as? Bool == false { failure?("injection_target_disabled"); return nil }
            if targetAttr(node, "AXEditable") as? Bool == false { failure?("injection_target_readonly"); return nil }
            // Chromium readonly fields omit AXEditable entirely. Check value
            // editability before reading their contents or recording a token.
            var settable = DarwinBoolean(false)
            guard AXUIElementIsAttributeSettable(node, kAXValueAttribute as CFString, &settable) == .success, settable.boolValue else { failure?("injection_target_value_not_settable"); return nil }
            return node
        }
        current = targetElement(targetAttr(node, kAXParentAttribute as String))
    }
    return nil
}
private func focusedTarget(app: NSRunningApplication) -> AXUIElement? {
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier,
          let element = focusedElement(app: app).element else { return nil }
    return editableTarget(element)
}

/// Read the current system focus. Callers outside capture must never wait or
/// mutate another app's accessibility settings.
private struct FocusResult {
    let element: AXUIElement?
    let error: AXError
    let source: String
    let globalError: AXError?
    let appError: AXError?
    var forcedAX = false
    var bootstrapAttempted = false
    var bootstrapError: Int?
    var initialFocusError: Int
    var focusRetries = 0
}
private func addFocusDiagnostics(_ focus: FocusResult, to data: inout [String: Any]) {
    data["focusError"] = focus.error.rawValue
    data["focusSource"] = focus.source
    if let globalError = focus.globalError { data["globalFocusError"] = globalError.rawValue }
    if let appError = focus.appError { data["appFocusError"] = appError.rawValue }
    data["focusReadable"] = focus.element != nil
    data["initialFocusError"] = focus.initialFocusError
    data["focusRetries"] = focus.focusRetries
    data["axBootstrapAttempted"] = focus.bootstrapAttempted
    if let bootstrapError = focus.bootstrapError { data["axBootstrapError"] = bootstrapError }
    if focus.forcedAX { data["axForced"] = true }
}
private func focusAttribute(on element: AXUIElement) -> (element: AXUIElement?, error: AXError) {
    var value: CFTypeRef?
    let error = AXUIElementCopyAttributeValue(element, kAXFocusedUIElementAttribute as CFString, &value)
    return (error == .success ? targetElement(value) : nil, error)
}
/// Query the known foreground process first. System-wide focus can transiently
/// return noValue even while the app exposes its current focused element.
/// Accept app focus only when AX confirms it belongs to that exact process;
/// otherwise fall back to the system-wide value and retain the caller's PID
/// checks before capture can become an insertion target.
private func focusedElement(app: NSRunningApplication?) -> FocusResult {
    var appError: AXError?
    if let app, NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier {
        let appFocus = focusAttribute(on: AXUIElementCreateApplication(app.processIdentifier))
        appError = appFocus.error
        if let element = appFocus.element {
            var pid: pid_t = 0
            if AXUIElementGetPid(element, &pid) == .success, pid == app.processIdentifier {
                // Keep the app result authoritative, while sampling the global
                // error for diagnostics so app-first successes explain why
                // they differ from the previous system-only path.
                let globalDiagnostic = focusAttribute(on: AXUIElementCreateSystemWide())
                return FocusResult(element: element, error: .success, source: "application", globalError: globalDiagnostic.error,
                                   appError: appFocus.error, initialFocusError: Int(appFocus.error.rawValue))
            }
        }
    }
    let global = focusAttribute(on: AXUIElementCreateSystemWide())
    if let element = global.element {
        return FocusResult(element: element, error: .success, source: "system", globalError: global.error,
                           appError: appError, initialFocusError: Int(appError?.rawValue ?? global.error.rawValue))
    }
    return FocusResult(element: nil, error: global.error, source: "none", globalError: global.error,
                       appError: appError, initialFocusError: Int(appError?.rawValue ?? global.error.rawValue))
}

/// Context only: Electron hides its AX tree until AXManualAccessibility is set.
/// Ask once without waiting, so later reads (and the next dictation) can see
/// the field. Delivery never depends on this; see commitInputTargetOnMain.
private func readFocusForContext(app: NSRunningApplication) -> FocusResult {
    var focus = focusedElement(app: app)
    if focus.element == nil, focus.globalError == .noValue {
        let error = AXUIElementSetAttributeValue(AXUIElementCreateApplication(app.processIdentifier), "AXManualAccessibility" as CFString, kCFBooleanTrue)
        focus.bootstrapAttempted = true
        if error != .success { focus.bootstrapError = Int(error.rawValue) }
    }
    return focus
}

/// AX ranges use UTF-16, not Swift grapheme counts. Refuse out-of-bounds and
/// surrogate-splitting ranges; never expand a selection to neighbouring text.
func expectedInsertion(_ original: String, _ range: CFRange, _ text: String) -> String? {
    let value = original as NSString
    guard range.location >= 0, range.length >= 0, range.location <= value.length,
          range.length <= value.length - range.location else { return nil }
    for at in [range.location, range.location + range.length] where at > 0 && at < value.length {
        if (0xD800...0xDBFF).contains(value.character(at: at - 1)) && (0xDC00...0xDFFF).contains(value.character(at: at)) { return nil }
    }
    return value.replacingCharacters(in: NSRange(location: range.location, length: range.length), with: text)
}

private final class InputTarget {
    let app: NSRunningApplication
    /// nil for an app-level target: the app owns keyboard focus but does not
    /// expose its focused field through Accessibility (Chromium before its tree
    /// is built, games, Java/Qt/terminal views). Delivery then gates only on the
    /// frontmost process, like an ordinary keyboard paste, and is unverified.
    let element: AXUIElement?
    let window: AXUIElement?
    let value: String?
    let range: CFRange?
    var expected: String?
    var insertedText: String?
    var submitted = false
    var verified = false
    var observingSince: TimeInterval?
    let webUrls: [String]
    let webRedacted: Bool
    init(app: NSRunningApplication) {
        self.app = app; element = nil; window = nil; value = nil; range = nil
        webUrls = []; webRedacted = true
    }
    init(app: NSRunningApplication, element: AXUIElement) {
        self.app = app; self.element = element
        window = targetElement(targetAttr(element, kAXWindowAttribute as String))
        let original = targetAttr(element, kAXValueAttribute as String) as? String
        value = original
        range = targetRange(element)
        let web = targetWebContext(element)
        webUrls = web.urls; webRedacted = web.redacted
    }
    func valid() -> String? {
        if !AXIsProcessTrusted() { return "injection_permission" }
        if app.isTerminated { return "injection_target_closed" }
        if let element, secureTarget(element) { return "injection_secure_target" }
        return nil
    }
    /// The only delivery gate: the app that was frontmost at capture is still
    /// frontmost. Its own keyboard focus decides where the text lands.
    func ready() -> String? {
        if let error = valid() { return error }
        return NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier ? nil : "injection_app_changed"
    }
}
// Opaque handles never leave the main process and never enter history or network requests.
private var inputTargets: [String: InputTarget] = [:]

private func secureTarget(_ element: AXUIElement) -> Bool {
    var current: AXUIElement? = element
    for _ in 0..<64 {
        guard let node = current else { return false }
        let role = targetAttr(node, kAXRoleAttribute as String) as? String ?? ""
        let subrole = targetAttr(node, kAXSubroleAttribute as String) as? String ?? ""
        if (role + subrole).lowercased().contains("secure") || targetAttr(node, "AXProtectedContent") as? Bool == true { return true }
        if role == "AXWebArea" || role == "AXWindow" { return false }
        current = targetElement(targetAttr(node, kAXParentAttribute as String))
    }
    return true
}
private func selectedTargetText(_ element: AXUIElement) -> String? {
    if let text = targetAttr(element, kAXSelectedTextAttribute as String) as? String, !text.isEmpty { return text }
    guard let markers = targetAttr(element, "AXSelectedTextMarkerRange") else { return nil }
    var text: CFTypeRef?
    guard AXUIElementCopyParameterizedAttributeValue(element, "AXStringForTextMarkerRange" as CFString, markers, &text) == .success else { return nil }
    return text as? String
}
// Include ancestor document URLs (such as an iframe's parent), so a domain
// restriction on the containing page cannot be bypassed by an embedded editor.
private func targetWebContext(_ element: AXUIElement) -> (urls: [String], redacted: Bool) {
    var current: AXUIElement? = element, urls: [String] = [], web = false
    for _ in 0..<64 {
        guard let node = current else { return (urls, web && urls.isEmpty) }
        let role = targetAttr(node, kAXRoleAttribute as String) as? String ?? ""
        if role == "AXWebArea" {
            web = true
            if let value = inputTargetURL(targetAttr(node, kAXURLAttribute as String)),
               let url = URL(string: value), ["http", "https", "file"].contains(url.scheme?.lowercased() ?? ""),
               !urls.contains(value) { urls.append(value) }
        }
        if role == "AXApplication" { return (urls, web && urls.isEmpty) }
        current = targetElement(targetAttr(node, kAXParentAttribute as String))
    }
    return (urls, true)
}
private func targetDiagnostics(_ element: AXUIElement? = nil, app: NSRunningApplication? = nil) -> [String: Any] {
    let front = NSWorkspace.shared.frontmostApplication
    var data: [String: Any] = ["trusted": AXIsProcessTrusted(), "frontPid": Int(front?.processIdentifier ?? 0), "frontBundleId": front?.bundleIdentifier ?? "", "targetPid": Int(app?.processIdentifier ?? 0), "targetBundleId": app?.bundleIdentifier ?? ""]
    let focus = focusedElement(app: app)
    addFocusDiagnostics(focus, to: &data)
    if let app { data["frontMatches"] = front?.processIdentifier == app.processIdentifier }
    guard let node = element ?? focus.element else { return data }
    data["role"] = targetAttr(node, kAXRoleAttribute as String) as? String ?? ""
    var pid: pid_t = 0
    data["pidError"] = AXUIElementGetPid(node, &pid).rawValue
    if app == nil { data["targetPid"] = Int(pid) }
    if let focus = focus.element { data["focusMatches"] = CFEqual(focus, node) }
    var writable = DarwinBoolean(false)
    let valueError = AXUIElementIsAttributeSettable(node, kAXValueAttribute as CFString, &writable)
    data["valueSettable"] = valueError == .success && writable.boolValue
    writable = DarwinBoolean(false)
    let rangeError = AXUIElementIsAttributeSettable(node, kAXSelectedTextRangeAttribute as CFString, &writable)
    data["rangeSettable"] = rangeError == .success && writable.boolValue
    // Only capability booleans survive; never return values or selected text.
    data["valueReadable"] = targetAttr(node, kAXValueAttribute as String) is String
    data["rangeReadable"] = targetRange(node) != nil
    return data
}

@_cdecl("inputTargetDiagnostics")
public func inputTargetDiagnostics(_ tokenPtr: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>? {
    if let tokenPtr, let target = inputTargets[String(cString: tokenPtr)] { return targetJSON(targetDiagnostics(target.element, app: target.app)) }
    return targetJSON(targetDiagnostics())
}

private func captureTarget(_ allowReadOnlySelection: Bool) -> UnsafeMutablePointer<CChar>? {
    let app = NSWorkspace.shared.frontmostApplication
    var result: [String: Any] = ["appName": app?.localizedName ?? "", "bundleId": app?.bundleIdentifier ?? "", "pid": Int(app?.processIdentifier ?? 0)]
    guard AXIsProcessTrusted() else { result["diagnostics"] = targetDiagnostics(app: app); result["reason"] = "injection_permission"; return targetJSON(result) }
    guard let app else { result["diagnostics"] = targetDiagnostics(app: app); result["reason"] = "injection_front_app_missing"; return targetJSON(result) }
    // Best effort: the focused field only adds context, selection and later
    // verification. Failing to read it never blocks delivery.
    let focus = readFocusForContext(app: app)
    var field: AXUIElement?
    if let focused = focus.element {
        var pid: pid_t = 0
        if AXUIElementGetPid(focused, &pid) == .success, pid == app.processIdentifier { field = focused }
    }
    var diagnostics = targetDiagnostics(field, app: app)
    addFocusDiagnostics(focus, to: &diagnostics)
    result["diagnostics"] = diagnostics
    result["contextRedacted"] = true
    if let field, secureTarget(field) { result["reason"] = "injection_secure_target"; return targetJSON(result) }
    let editable = field.flatMap { editableTarget($0) }
    if let element = editable ?? field {
        if let window = targetElement(targetAttr(element, kAXWindowAttribute as String)),
           let rawPosition = targetAttr(window, kAXPositionAttribute as String),
           let rawSize = targetAttr(window, kAXSizeAttribute as String),
           CFGetTypeID(rawPosition) == AXValueGetTypeID(), CFGetTypeID(rawSize) == AXValueGetTypeID() {
            var position = CGPoint.zero, size = CGSize.zero
            if AXValueGetValue(rawPosition as! AXValue, .cgPoint, &position),
               AXValueGetValue(rawSize as! AXValue, .cgSize, &size) {
                result["windowBounds"] = ["x": position.x, "y": position.y, "width": size.width, "height": size.height]
            }
        }
        let web = targetWebContext(element)
        result["webUrls"] = web.urls; result["webUrl"] = web.urls.first
        result["contextRedacted"] = web.redacted
        result["role"] = targetAttr(element, kAXRoleAttribute as String) as? String ?? ""
    }
    let redacted = result["contextRedacted"] as? Bool ?? true
    // Question mode keeps its old contract: a read-only selection is context,
    // not a place to paste the answer.
    if allowReadOnlySelection && editable == nil {
        result["reason"] = "injection_target_not_editable"
        if !redacted, let field, let text = selectedTargetText(field), !text.isEmpty { result["selectedText"] = text; result["selectionReadOnly"] = true }
        return targetJSON(result)
    }
    guard inputTargets.count < 16 else { result["reason"] = "injection_target_capacity"; return targetJSON(result) }
    let target = editable.map { InputTarget(app: app, element: $0) } ?? InputTarget(app: app)
    let token = UUID().uuidString
    inputTargets[token] = target; result["token"] = token
    if !redacted, let value = target.value, let range = target.range, expectedInsertion(value, range, "") != nil {
        let source = value as NSString
        result["selectedText"] = source.substring(with: NSRange(location: range.location, length: range.length))
        let start = max(0, range.location - 800), end = min(source.length, range.location + range.length + 400)
        result["contextText"] = source.substring(with: NSRange(location: start, length: min(2000, end - start)))
    }
    return targetJSON(result)
}

@_cdecl("captureInputTarget")
public func captureInputTarget() -> UnsafeMutablePointer<CChar>? { captureTarget(false) }
@_cdecl("captureCommandTarget")
public func captureCommandTarget() -> UnsafeMutablePointer<CChar>? { captureTarget(true) }

private func prepareInputTargetOnMain(_ tokenPtr: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>? {
    guard let tokenPtr, let target = inputTargets[String(cString: tokenPtr)], !target.submitted else { return targetJSON(["reason": "injection_target_unavailable"]) }
    // Never activate or refocus: if the user moved to another app, the text
    // stays saved instead of being pasted somewhere they are not looking.
    if let reason = target.ready() { return targetJSON(["reason": reason]) }
    return targetJSON(["ok": true])
}

@_cdecl("inputTargetReady")
public func inputTargetReady(_ tokenPtr: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>? {
    guard let tokenPtr, let target = inputTargets[String(cString: tokenPtr)] else { return targetJSON(["reason": "injection_target_unavailable"]) }
    if let reason = target.ready() { return targetJSON(["reason": reason]) }
    return targetJSON(["ok": true])
}

private func commitInputTargetOnMain(_ tokenPtr: UnsafePointer<CChar>?, _ textPtr: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>? {
    guard let tokenPtr, let textPtr, let target = inputTargets[String(cString: tokenPtr)] else { return targetJSON(["reason": "injection_target_unavailable"]) }
    if target.submitted { return targetJSON(["reason": "injection_already_sent"]) }
    if let reason = target.ready() { return targetJSON(["reason": reason]) }
    let text = String(cString: textPtr)
    guard !text.isEmpty else { return targetJSON(["reason": "injection_failed"]) }
    if let value = target.value, let range = target.range, let expected = expectedInsertion(value, range, text) {
        target.expected = expected
        target.insertedText = text
    }
    target.submitted = true
    return nil
}

/// One shared injector: VocaMac serializes every clipboard delivery through it.
private let textInjector = TextInjector()

/// Receives the first outcome of one delivery; later reports are ignored.
private final class DeliveryWaiter: @unchecked Sendable {
    private let lock = NSLock()
    private let done = DispatchSemaphore(value: 0)
    private var outcome: DeliveryOutcome?
    func report(_ value: DeliveryOutcome) {
        lock.lock(); defer { lock.unlock() }
        guard outcome == nil else { return }
        outcome = value
        done.signal()
    }
    func wait(seconds: Double) -> DeliveryOutcome? {
        _ = done.wait(timeout: .now() + seconds)
        lock.lock(); defer { lock.unlock() }
        return outcome
    }
}

/// Token validation runs on main; delivery is VocaMac's TextInjector, which
/// writes Accessibility off the main thread and pastes on it. Koffi calls this
/// from a worker thread, which waits for the outcome without blocking AppKit.
private func commitInputTargetThroughInjector(_ tokenPtr: UnsafePointer<CChar>?, _ textPtr: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>? {
    if let refused = onTargetMain({ commitInputTargetOnMain(tokenPtr, textPtr) }) { return refused }
    guard let tokenPtr, let textPtr else { return targetJSON(["reason": "injection_target_unavailable"]) }
    let token = String(cString: tokenPtr), text = String(cString: textPtr)
    let pid = onTargetMain { inputTargets[token]?.app.processIdentifier } ?? 0
    let waiter = DeliveryWaiter()
    textInjector.inject(text: text, preserveClipboard: true, expectedProcessID: pid, report: { waiter.report($0) })
    // The main thread cannot wait for work it has to run itself.
    if Thread.isMainThread { return targetJSON(["submitted": true, "method": "unknown"]) }
    // A queued delivery waits for the previous paste (up to its 2s receipt timeout).
    switch waiter.wait(seconds: 8) {
    case .accessibility: return targetJSON(["submitted": true, "method": "accessibility"])
    case .uncertain: return targetJSON(["submitted": true, "method": "accessibility", "uncertain": true])
    case .pasted: return targetJSON(["submitted": true, "method": "clipboard"])
    case .failed(let reason):
        onTargetMain { inputTargets[token]?.submitted = false }
        return targetJSON(["reason": reason])
    case nil: return targetJSON(["submitted": true, "method": "unknown", "uncertain": true])
    }
}

@_cdecl("verifyInputTarget")
public func verifyInputTarget(_ tokenPtr: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>? {
    guard let tokenPtr, let target = inputTargets[String(cString: tokenPtr)], target.submitted else { return targetJSON(["reason": "injection_target_unavailable"]) }
    guard let expected = target.expected, let element = target.element else { return targetJSON(["status": "unverified"]) }
    guard !target.app.isTerminated, !secureTarget(element) else { return targetJSON(["status": "unverified"]) }
    let (readError, rawValue) = targetAttrResult(element, kAXValueAttribute as String)
    guard readError == .success else {
        // Accessibility can report a transient read failure during delivery.
        // Return pending so the existing bounded verifier rereads this same
        // target; every other AX error remains unverified.
        if readError == .cannotComplete { return targetJSON(["status": "pending", "reason": "ax_cannot_complete", "ax_error": readError.rawValue]) }
        return targetJSON(["status": "unverified", "reason": "ax_read_failed", "ax_error": readError.rawValue])
    }
    guard let value = rawValue as? String else { return targetJSON(["status": "unverified", "reason": "ax_value_missing"]) }
    if value == expected { target.verified = true }
    return targetJSON(["status": value == expected ? "verified" : "pending"])
}

/// Only the inserted region may change. Compare exact prefix/suffix locally;
/// never send the surrounding field or its changes over the native bridge.
/// Size limits bound this optional learning feature, not dictation duration.
func observedInsertion(_ original: String, _ range: CFRange, _ current: String) -> String? {
    guard (original as NSString).length <= 1_000_000, (current as NSString).length <= 1_000_000,
          expectedInsertion(original, range, "") != nil else { return nil }
    let old = original as NSString, next = current as NSString
    let suffixLength = old.length - range.location - range.length
    let length = next.length - range.location - suffixLength
    guard length >= 0, length <= 100_000,
          next.substring(to: range.location) == old.substring(to: range.location),
          next.substring(from: range.location + length) == old.substring(from: range.location + range.length),
          expectedInsertion(current, CFRange(location: range.location, length: length), "") != nil else { return nil }
    return next.substring(with: NSRange(location: range.location, length: length))
}

@_cdecl("beginInputObservation")
public func beginInputObservation(_ tokenPtr: UnsafePointer<CChar>?, _ textPtr: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>? {
    guard let tokenPtr, let textPtr, let target = inputTargets[String(cString: tokenPtr)], target.verified, target.element != nil,
          target.insertedText == String(cString: textPtr), !target.webRedacted,
          let original = target.value, let range = target.range, let expected = target.expected,
          observedInsertion(original, range, expected) == target.insertedText else { return targetJSON(["ok": false]) }
    target.observingSince = ProcessInfo.processInfo.systemUptime
    return targetJSON(["ok": true])
}

@_cdecl("readInputObservation")
public func readInputObservation(_ tokenPtr: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>? {
    guard let tokenPtr, let target = inputTargets[String(cString: tokenPtr)], let since = target.observingSince,
          ProcessInfo.processInfo.systemUptime - since < 60 else { return targetJSON(["active": false, "reason": "expired"]) }
    guard AXIsProcessTrusted(), !target.app.isTerminated else { return targetJSON(["active": false, "reason": "unavailable"]) }
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == target.app.processIdentifier else { return targetJSON(["active": false, "reason": "app_inactive"]) }
    guard let element = target.element, !secureTarget(element) else { return targetJSON(["active": false, "reason": "field_invalid"]) }
    let web = targetWebContext(element)
    guard !web.redacted, web.urls == target.webUrls else { return targetJSON(["active": false, "reason": "document_changed"]) }
    guard let focused = focusedTarget(app: target.app), CFEqual(focused, element) else { return targetJSON(["active": false, "reason": "field_unfocused"]) }
    // The current field is read transiently to reject any change outside the
    // insertion. Nothing from a different target or outside that range returns.
    guard let original = target.value, let range = target.range,
          let current = targetAttr(element, kAXValueAttribute as String) as? String,
          let text = observedInsertion(original, range, current), let selected = targetRange(element),
          selected.location >= range.location, selected.length >= 0,
          selected.location <= range.location + (text as NSString).length,
          selected.length <= range.location + (text as NSString).length - selected.location else { return targetJSON(["active": false, "reason": "range_changed"]) }
    return targetJSON(["active": true, "text": text])
}

@_cdecl("releaseInputTarget")
public func releaseInputTarget(_ tokenPtr: UnsafePointer<CChar>?) {
    guard let tokenPtr else { return }
    inputTargets.removeValue(forKey: String(cString: tokenPtr))
}

// Called through Koffi's async API. UI mutations execute on the AppKit main
// queue after the initiating JavaScript callback has unwound, avoiding nested
// Electron event dispatch inside a synchronous FFI call.
private func onTargetMain<T>(_ action: () -> T) -> T {
    if Thread.isMainThread { return action() }
    return DispatchQueue.main.sync(execute: action)
}
@_cdecl("prepareInputTarget")
public func prepareInputTarget(_ token: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>? {
    return onTargetMain { prepareInputTargetOnMain(token) }
}
@_cdecl("commitInputTarget")
public func commitInputTarget(_ token: UnsafePointer<CChar>?, _ text: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>? {
    return commitInputTargetThroughInjector(token, text)
}
