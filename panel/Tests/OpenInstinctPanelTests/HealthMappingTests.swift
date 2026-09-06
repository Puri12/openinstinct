import Foundation
@testable import OpenInstinctPanel

/// `health(for:)` drives the popover headline. Because iMessage is now an
/// optional lane, a detached lane must still read as awake: the Chat window is
/// a first-class surface, not a degraded fallback.
@MainActor
enum HealthMappingChecks {
    static func run() async -> [String] {
        var failures: [String] = []

        failures.append(contentsOf: await expect(
            label: "credentialsBlocked",
            status: status(state: .credentialsBlocked, remediation: "Sign in to an AI account", lane: .detached, reason: "core_lane_down"),
            matches: { health in
                if case .needsSetup(let why) = health { return why == "Sign in to an AI account" }
                return false
            }
        ))

        failures.append(contentsOf: await expect(
            label: "running + detached",
            status: status(state: .running, lane: .detached, reason: "no_owner_handle"),
            matches: { health in
                if case .awake(let imessage) = health { return imessage == false }
                return false
            }
        ))

        failures.append(contentsOf: await expect(
            label: "running + attached",
            status: status(state: .running, lane: .attached),
            matches: { health in
                if case .awake(let imessage) = health { return imessage == true }
                return false
            }
        ))

        failures.append(contentsOf: await expect(
            label: "degraded",
            status: status(state: .degraded, remediation: "session failed to start", lane: .detached, reason: "core_lane_down"),
            matches: { health in
                if case .trouble = health { return true }
                return false
            }
        ))

        failures.append(contentsOf: await expect(
            label: "running + paused",
            status: status(state: .running, lane: .attached, paused: true),
            matches: { health in
                if case .asleep = health { return true }
                return false
            }
        ))

        // A denied FDA probe must not downgrade the headline: chat still works.
        failures.append(contentsOf: await expect(
            label: "running + fda denied",
            status: status(state: .running, lane: .detached, reason: "fda_denied", fda: ProbeInfo(status: "denied", reason: "FDA denied")),
            matches: { health in
                if case .awake(let imessage) = health { return imessage == false }
                return false
            }
        ))

        // Copy contract: detached points at Chat, attached mentions iMessage.
        let detachedDetail = Health.awake(imessage: false).detail
        if !detachedDetail.contains("Chat") {
            failures.append("detached awake detail does not mention Chat: \(detachedDetail)")
        }
        let attachedDetail = Health.awake(imessage: true).detail
        if !attachedDetail.contains("iMessage") {
            failures.append("attached awake detail does not mention iMessage: \(attachedDetail)")
        }

        return failures
    }

    private static func expect(
        label: String,
        status: StatusResponsePayload,
        matches: (Health) -> Bool
    ) async -> [String] {
        let model = PanelViewModel(transport: HealthScriptedTransport(status: status))
        await model.refreshStatus()
        guard model.status != nil else {
            return ["health check \(label) could not load a scripted status"]
        }
        return matches(health(for: model)) ? [] : ["health(for:) mapped \(label) incorrectly"]
    }

    private static func status(
        state: BootstrapState,
        remediation: String = "",
        lane: ImessageLaneState,
        reason: String? = nil,
        paused: Bool = false,
        fda: ProbeInfo? = nil
    ) -> StatusResponsePayload {
        var probes: [String: ProbeInfo] = ["credentials": ProbeInfo(status: "passed")]
        if let fda {
            probes["fda"] = fda
        }
        let handle = lane == .attached ? "+15550000001" : nil
        return StatusResponsePayload(
            bootstrap: BootstrapStatus(state: state, remediation: remediation, probes: probes),
            session: SessionStatus(
                state: .active,
                mainSessionId: "main-session-001",
                mainSessionFilePresent: true,
                paused: paused
            ),
            activeChildren: [],
            monitors: [],
            settings: SettingsStatus(allowlistHandle: handle),
            imessage: ImessageLaneStatus(state: lane, reason: reason, handle: handle)
        )
    }
}

private actor HealthScriptedTransport: ControlTransport {
    private let status: StatusResponsePayload

    init(status: StatusResponsePayload) {
        self.status = status
    }

    func request(_ request: ControlRequest) async throws -> ControlFrame {
        .response(.status(id: request.id, payload: status))
    }

    func subscribe() async throws -> ChatSubscription {
        ChatSubscription(events: AsyncThrowingStream { $0.finish() }, cancel: {})
    }
}
