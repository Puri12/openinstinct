import Combine
import Foundation

/// Compares the installed release (`~/.openinstinct/VERSION`, written by the
/// release payload) against GitHub's latest release and, on request, runs the
/// installed `scripts/update.sh`. That script detaches itself before it calls
/// the installer, because install.sh kills and relaunches this panel midway.
///
/// Source-checkout installs have no VERSION file and never get an offer; the
/// owner updates those with `git pull && bash scripts/install.sh`.
@MainActor
public final class UpdateChecker: ObservableObject {
    public enum State: Equatable, Sendable {
        case idle
        case checking
        case upToDate
        case available(tag: String)
        case updating(tag: String)
        case failed(String)
    }

    public struct Environment: Sendable {
        public var installedVersion: @Sendable () -> String?
        public var latestTag: @Sendable () async throws -> String
        public var launchUpdate: @Sendable (String) throws -> Void
        public var lastLog: @Sendable () -> String?
        public var now: @Sendable () -> Date

        public init(
            installedVersion: @escaping @Sendable () -> String?,
            latestTag: @escaping @Sendable () async throws -> String,
            launchUpdate: @escaping @Sendable (String) throws -> Void,
            lastLog: @escaping @Sendable () -> String?,
            now: @escaping @Sendable () -> Date = { Date() }
        ) {
            self.installedVersion = installedVersion
            self.latestTag = latestTag
            self.launchUpdate = launchUpdate
            self.lastLog = lastLog
            self.now = now
        }

        public static let live: Environment = {
            let stateHome = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(".openinstinct")
            let repo = "Yeachan-Heo/openinstinct"
            return Environment(
                installedVersion: {
                    guard let raw = try? String(contentsOf: stateHome.appendingPathComponent("VERSION"), encoding: .utf8) else { return nil }
                    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
                    return trimmed.isEmpty ? nil : trimmed
                },
                latestTag: {
                    // github.com/<repo>/releases/latest 302s to /releases/tag/<tag>.
                    // That redirect is not rate-limited, unlike api.github.com
                    // (60 anonymous requests per hour per IP, shared behind NAT).
                    var request = URLRequest(url: URL(string: "https://github.com/\(repo)/releases/latest")!)
                    request.httpMethod = "HEAD"
                    request.setValue("OpenInstinctPanel", forHTTPHeaderField: "User-Agent")
                    request.timeoutInterval = 15
                    let (_, response) = try await URLSession.shared.data(for: request)
                    guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                        throw UpdateError.http((response as? HTTPURLResponse)?.statusCode ?? -1)
                    }
                    return try UpdateChecker.parseLatestTag(fromResolvedURL: http.url)
                },
                launchUpdate: { tag in
                    let script = stateHome.appendingPathComponent("src/scripts/update.sh").path
                    guard FileManager.default.isReadableFile(atPath: script) else { throw UpdateError.scriptMissing }
                    let process = Process()
                    process.executableURL = URL(fileURLWithPath: "/bin/sh")
                    process.arguments = [script, tag]
                    process.standardOutput = FileHandle.nullDevice
                    process.standardError = FileHandle.nullDevice
                    try process.run()
                    process.waitUntilExit()
                    guard process.terminationStatus == 0 else { throw UpdateError.launchFailed(process.terminationStatus) }
                },
                lastLog: {
                    guard let text = try? String(contentsOf: stateHome.appendingPathComponent("logs/update.log"), encoding: .utf8) else { return nil }
                    return text
                }
            )
        }()
    }

    public enum UpdateError: Error, LocalizedError, Equatable {
        case http(Int)
        case malformedRelease
        case scriptMissing
        case launchFailed(Int32)

        public var errorDescription: String? {
            switch self {
            case .http(let code): return "GitHub answered \(code)"
            case .malformedRelease: return "GitHub did not point at a release"
            case .scriptMissing: return "The installed copy has no update script; reinstall from the website"
            case .launchFailed(let code): return "The updater could not start (exit \(code))"
            }
        }
    }

    @Published public private(set) var state: State = .idle
    @Published public private(set) var installedVersion: String?
    /// Set when the previous update run's log ends without the "done" marker.
    @Published public private(set) var lastFailureLog: String?

    private let env: Environment
    private var lastCheck: Date?
    /// Daily is enough: an owner who wants it sooner clicks "Check for updates".
    private let checkInterval: TimeInterval = 24 * 60 * 60

    public init(environment: Environment = .live) {
        self.env = environment
        self.installedVersion = environment.installedVersion()
        self.lastFailureLog = UpdateChecker.failureTail(environment.lastLog())
    }

    /// A release archive install; source checkouts cannot be updated from here.
    public var canUpdate: Bool { installedVersion != nil }

    /// Cheap to call on every popover open; only hits the network once a day.
    public func checkIfDue() async {
        guard canUpdate else { return }
        if let lastCheck, env.now().timeIntervalSince(lastCheck) < checkInterval { return }
        await check()
    }

    public func check() async {
        guard canUpdate, let installed = installedVersion else { return }
        if case .updating = state { return }
        state = .checking
        do {
            let latest = try await env.latestTag()
            lastCheck = env.now()
            state = UpdateChecker.isNewer(latest, than: installed) ? .available(tag: latest) : .upToDate
        } catch {
            lastCheck = env.now()
            state = .failed(error.localizedDescription)
        }
    }

    public func update() {
        guard case .available(let tag) = state else { return }
        do {
            try env.launchUpdate(tag)
            lastFailureLog = nil
            state = .updating(tag: tag)
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    public func dismissFailureLog() {
        lastFailureLog = nil
    }

    // MARK: - Pure helpers

    /// The URL a `releases/latest` request lands on after redirects.
    nonisolated static func parseLatestTag(fromResolvedURL url: URL?) throws -> String {
        guard let parts = url?.pathComponents, let i = parts.lastIndex(of: "tag"), i > 0, i + 1 < parts.count,
              parts[i - 1] == "releases", !parts[i + 1].isEmpty else {
            throw UpdateError.malformedRelease
        }
        return parts[i + 1]
    }

    /// `v0.3.1` > `v0.3.0`; a build with extra `-N-gSHA` (git describe on an
    /// untagged commit) counts as its base tag, so a dev build never nags.
    /// Unparseable input is never "newer".
    nonisolated public static func isNewer(_ candidate: String, than installed: String) -> Bool {
        guard let a = numericParts(candidate), let b = numericParts(installed) else { return false }
        let width = max(a.count, b.count)
        let pa = a + Array(repeating: 0, count: width - a.count)
        let pb = b + Array(repeating: 0, count: width - b.count)
        return pb.lexicographicallyPrecedes(pa)
    }

    nonisolated private static func numericParts(_ tag: String) -> [Int]? {
        var body = Substring(tag.trimmingCharacters(in: .whitespacesAndNewlines))
        if body.hasPrefix("v") || body.hasPrefix("V") { body = body.dropFirst() }
        // Drop git-describe suffix: 0.3.0-4-gabc123 → 0.3.0
        if let dash = body.firstIndex(of: "-") { body = body[..<dash] }
        let parts = body.split(separator: ".", omittingEmptySubsequences: false).map { Int($0) }
        guard !parts.isEmpty, parts.allSatisfy({ $0 != nil }) else { return nil }
        return parts.compactMap { $0 }
    }

    /// The last run's log if it began but never reached the done marker.
    nonisolated static func failureTail(_ log: String?) -> String? {
        guard let log else { return nil }
        let lines = log.split(separator: "\n", omittingEmptySubsequences: true)
        guard let startIndex = lines.lastIndex(where: { $0.hasPrefix("== update to ") }) else { return nil }
        let run = lines[startIndex...]
        if run.contains(where: { $0.hasPrefix("== update done") }) { return nil }
        return run.suffix(12).joined(separator: "\n")
    }
}
