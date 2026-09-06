import Foundation
@testable import OpenInstinctPanel

@MainActor
enum SettingsTabChecks {
    static func run() async -> [String] {
        let handle = "+821012345678"
        let transport = SettingsTabScriptedTransport(responses: [
            .response(.settingsSet(
                id: "settings-1",
                payload: SettingsSetResponsePayload(ok: true, restarting: false, reloaded: true)
            )),
            .response(.status(id: "status-1", payload: attachedStatus(handle: handle))),
        ])
        let request = ControlRequest.settingsSet(
            id: "settings-1",
            payload: SettingsSetPayload(patch: ["ownerHandle": .string(handle)])
        )

        var failures: [String] = []
        do {
            let frame = try await transport.request(request)
            guard case .response(.settingsSet(_, let response)) = frame, response.ok else {
                failures.append("iMessage settings.set did not acknowledge the owner handle")
                return failures
            }
            if response.restarting {
                failures.append("iMessage settings.set unexpectedly requested a restart")
                return failures
            }
        } catch {
            failures.append("iMessage settings.set script threw: \(error.localizedDescription)")
            return failures
        }

        let model = PanelViewModel(transport: transport)
        await model.refreshStatus()
        if model.status?.imessage.state != .attached {
            failures.append("status refresh did not show the iMessage lane as attached")
        }
        if model.status?.imessage.handle != handle {
            failures.append("status refresh did not retain the connected iMessage handle")
        }

        let requests = await transport.requests()
        guard requests.count == 2 else {
            failures.append("iMessage settings script made \(requests.count) requests instead of settings.set plus status.get")
            return failures
        }
        if case .settingsSet(_, let payload) = requests[0] {
            if payload.patch["ownerHandle"] != .string(handle) {
                failures.append("iMessage settings.set did not send ownerHandle")
            }
        } else {
            failures.append("iMessage settings script did not record settings.set")
        }
        if case .statusGet = requests[1] {
            // Expected status refresh request.
        } else {
            failures.append("iMessage settings script did not refresh status after saving")
        }
        return failures
    }

    private static func attachedStatus(handle: String) -> StatusResponsePayload {
        StatusResponsePayload(
            bootstrap: BootstrapStatus(
                state: .running,
                remediation: "",
                probes: [
                    "credentials": ProbeInfo(status: "passed"),
                    "fda": ProbeInfo(status: "passed"),
                    "accessibility": ProbeInfo(status: "passed"),
                ]
            ),
            session: SessionStatus(
                state: .active,
                mainSessionId: "main-session-001",
                mainSessionFilePresent: true,
                paused: false
            ),
            activeChildren: [],
            monitors: [],
            settings: SettingsStatus(allowlistHandle: handle),
            imessage: ImessageLaneStatus(state: .attached, handle: handle)
        )
    }
}

private enum SettingsTabScriptedTransportError: Error, LocalizedError, Sendable {
    case exhausted

    var errorDescription: String? {
        "scripted transport ran out of responses"
    }
}

private actor SettingsTabScriptedTransport: ControlTransport {
    private var queuedResponses: [ControlFrame]
    private var recordedRequests: [ControlRequest] = []

    init(responses: [ControlFrame]) {
        queuedResponses = responses
    }

    func request(_ request: ControlRequest) async throws -> ControlFrame {
        recordedRequests.append(request)
        guard !queuedResponses.isEmpty else {
            throw SettingsTabScriptedTransportError.exhausted
        }
        return queuedResponses.removeFirst()
    }

    /// The settings tab never subscribes; this conformance only satisfies the
    /// transport protocol.
    func subscribe() async throws -> ChatSubscription {
        ChatSubscription(events: AsyncThrowingStream { $0.finish() }, cancel: {})
    }

    func requests() -> [ControlRequest] {
        recordedRequests
    }
}
