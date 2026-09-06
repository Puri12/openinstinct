import Foundation
@testable import OpenInstinctPanel

@MainActor
enum UpdateCheckerChecks {
    static func run() async -> [String] {
        var failures: [String] = []

        // Version ordering: tags, bare numbers, git-describe suffixes, garbage.
        let orderings: [(String, String, Bool)] = [
            ("v0.3.1", "v0.3.0", true),
            ("v0.3.0", "v0.3.0", false),
            ("v0.2.9", "v0.3.0", false),
            ("v1.0.0", "v0.9.9", true),
            ("v0.3.0", "v0.3.0-4-gabc1234", false),
            ("v0.3.1", "0.3.0", true),
            ("v0.3", "v0.3.0", false),
            ("v0.3.0.1", "v0.3.0", true),
            ("latest", "v0.3.0", false),
            ("v0.4.0", "dev", false),
        ]
        for (candidate, installed, expected) in orderings where UpdateChecker.isNewer(candidate, than: installed) != expected {
            failures.append("isNewer(\(candidate), than: \(installed)) should be \(expected)")
        }

        // Release JSON parsing.
        let resolved = URL(string: "https://github.com/Yeachan-Heo/openinstinct/releases/tag/v0.3.1")
        if (try? UpdateChecker.parseLatestTag(fromResolvedURL: resolved)) != "v0.3.1" { failures.append("parseLatestTag did not read the tag from the redirect") }
        for bad in ["https://github.com/Yeachan-Heo/openinstinct/releases", "https://github.com/Yeachan-Heo/openinstinct/releases/latest", "https://github.com/login"] {
            if (try? UpdateChecker.parseLatestTag(fromResolvedURL: URL(string: bad))) != nil { failures.append("parseLatestTag accepted \(bad)") }
        }
        if (try? UpdateChecker.parseLatestTag(fromResolvedURL: nil)) != nil { failures.append("parseLatestTag accepted a missing URL") }

        // Failure-log tail: only the last run counts, and only if it never finished.
        let finished = "== update to latest started t0\nstuff\n== update done v0.3.1\n"
        if UpdateChecker.failureTail(finished) != nil { failures.append("failureTail flagged a finished run") }
        let broken = "== update to latest started t0\nok\n== update done v0.3.0\n== update to v0.3.1 started t1\nerror: checksum mismatch\n"
        if UpdateChecker.failureTail(broken) != "== update to v0.3.1 started t1\nerror: checksum mismatch" { failures.append("failureTail did not return the unfinished run") }
        if UpdateChecker.failureTail(nil) != nil || UpdateChecker.failureTail("") != nil { failures.append("failureTail invented a failure from no log") }

        // No VERSION file (source checkout): never checks, never offers.
        let probe = Probe(installed: nil, latest: "v9.9.9")
        let sourceInstall = UpdateChecker(environment: probe.environment)
        await sourceInstall.checkIfDue()
        await sourceInstall.check()
        if sourceInstall.canUpdate || sourceInstall.state != .idle || probe.fetches != 0 {
            failures.append("source checkout install must not check or offer updates")
        }

        // Newer release available → update launches the script with that tag, once.
        let newer = Probe(installed: "v0.3.0", latest: "v0.3.1")
        let checker = UpdateChecker(environment: newer.environment)
        await checker.checkIfDue()
        if checker.state != .available(tag: "v0.3.1") { failures.append("newer release was not offered: \(checker.state)") }
        await checker.checkIfDue()
        if newer.fetches != 1 { failures.append("checkIfDue re-fetched within the daily window (\(newer.fetches))") }
        newer.clock += 25 * 60 * 60
        await checker.checkIfDue()
        if newer.fetches != 2 { failures.append("checkIfDue did not re-check after a day (\(newer.fetches))") }
        checker.update()
        if checker.state != .updating(tag: "v0.3.1") || newer.launched != ["v0.3.1"] {
            failures.append("update() did not launch the updater with the offered tag: \(checker.state) \(newer.launched)")
        }
        await checker.check()
        if newer.fetches != 2 { failures.append("check() ran while an update was in progress") }

        // Same version → up to date; update() is a no-op.
        let same = Probe(installed: "v0.3.1", latest: "v0.3.1")
        let current = UpdateChecker(environment: same.environment)
        await current.check()
        current.update()
        if current.state != .upToDate || !same.launched.isEmpty { failures.append("up-to-date install offered or launched an update") }

        // Network failure surfaces, and the launcher throwing surfaces.
        let offline = Probe(installed: "v0.3.0", latest: nil)
        let failing = UpdateChecker(environment: offline.environment)
        await failing.check()
        guard case .failed = failing.state else { failures.append("network failure was not reported: \(failing.state)"); return failures }
        let badLauncher = Probe(installed: "v0.3.0", latest: "v0.3.1", launchThrows: true)
        let launcher = UpdateChecker(environment: badLauncher.environment)
        await launcher.check()
        launcher.update()
        guard case .failed(let why) = launcher.state, why.contains("update script") else {
            failures.append("launcher failure was not reported: \(launcher.state)"); return failures
        }

        // A prior unfinished run is shown at startup and cleared by a new launch.
        let stale = Probe(installed: "v0.3.0", latest: "v0.3.1", log: "== update to v0.3.1 started t\nerror: download failed\n")
        let resumed = UpdateChecker(environment: stale.environment)
        if resumed.lastFailureLog?.contains("download failed") != true { failures.append("previous failed run was not surfaced at startup") }
        await resumed.check()
        resumed.update()
        if resumed.lastFailureLog != nil { failures.append("launching a new update did not clear the stale failure log") }

        return failures
    }
}

private final class Probe: @unchecked Sendable {
    private let lock = NSLock()
    private var _fetches = 0
    private var _launched: [String] = []
    private var _clock: TimeInterval = 1_000_000
    private let installed: String?
    private let latest: String?
    private let log: String?
    private let launchThrows: Bool

    init(installed: String?, latest: String?, log: String? = nil, launchThrows: Bool = false) {
        self.installed = installed
        self.latest = latest
        self.log = log
        self.launchThrows = launchThrows
    }

    var fetches: Int { lock.withLock { _fetches } }
    var launched: [String] { lock.withLock { _launched } }
    var clock: TimeInterval {
        get { lock.withLock { _clock } }
        set { lock.withLock { _clock = newValue } }
    }

    var environment: UpdateChecker.Environment {
        UpdateChecker.Environment(
            installedVersion: { [installed] in installed },
            latestTag: { [self] in
                lock.withLock { _fetches += 1 }
                guard let latest else { throw URLError(.notConnectedToInternet) }
                return latest
            },
            launchUpdate: { [self] tag in
                if launchThrows { throw UpdateChecker.UpdateError.scriptMissing }
                lock.withLock { _launched.append(tag) }
            },
            lastLog: { [log] in log },
            now: { [self] in Date(timeIntervalSince1970: clock) }
        )
    }
}
