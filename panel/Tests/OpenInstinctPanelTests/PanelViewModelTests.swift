import Foundation
@testable import OpenInstinctPanel

@MainActor
enum PanelViewModelChecks {
    static func run() async -> [String] {
        var failures = await revisionConflictCheck()
        failures.append(contentsOf: await daemonAbsentCheck())
        return failures
    }

    private static func revisionConflictCheck() async -> [String] {
        let initial = monitor(id: "daily", enabled: true, revision: 1)
        let refreshed = monitor(id: "daily", enabled: true, revision: 2)
        let transport = ScriptedTransport(responses: [
            .response(.monitorsList(id: "list-1", payload: MonitorsListResponsePayload(monitors: [initial]))),
            .error(ControlError(id: "toggle-1", code: .revisionConflict, message: "monitor revision conflict")),
            .response(.monitorsList(id: "list-2", payload: MonitorsListResponsePayload(monitors: [refreshed]))),
        ])
        let model = PanelViewModel(transport: transport)

        await model.refreshMonitors()
        await model.toggleMonitor(id: "daily", enabled: false)

        var failures: [String] = []
        if model.connectionState != .connected {
            failures.append("revision-conflict handling marked a healthy socket absent")
        }
        if model.monitors != [refreshed] {
            failures.append("revision conflict did not refetch current monitor state")
        }
        if model.notice != "Monitor changed elsewhere. Refreshed its current state." {
            failures.append("revision conflict did not show the inline refresh notice")
        }
        let requests = await transport.requests()
        guard requests.count == 3 else {
            failures.append("revision conflict made \(requests.count) requests instead of toggle plus refetch")
            return failures
        }
        guard case .monitorsToggle(_, let payload) = requests[1] else {
            failures.append("revision conflict test did not send a monitor toggle")
            return failures
        }
        if payload.id != "daily" || payload.enabled || payload.expectedRevision != 1 {
            failures.append("monitor toggle did not send the selected expectedRevision")
        }
        return failures
    }

    private static func daemonAbsentCheck() async -> [String] {
        let model = PanelViewModel(transport: ScriptedTransport(fails: true))
        await model.refreshStatus()
        var failures: [String] = []
        if model.connectionState != .absent {
            failures.append("socket failure did not project daemon-absent state")
        }
        if model.status != nil {
            failures.append("daemon-absent state retained stale status")
        }
        if model.connectionError == nil {
            failures.append("daemon-absent state omitted connection error")
        }
        return failures
    }

    private static func monitor(id: String, enabled: Bool, revision: Int) -> Monitor {
        Monitor(
            id: id,
            name: "Daily briefing",
            trigger: .cron(expression: "30 8 * * 1-5"),
            instruction: "Summarize priorities.",
            eventTypes: ["cron"],
            burstPolicy: "coalesce",
            tz: "Asia/Seoul",
            timeoutSec: 2700,
            enabled: enabled,
            revision: revision,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z"
        )
    }
}

private enum StubTransportError: Error, LocalizedError, Sendable {
    case unavailable

    var errorDescription: String? {
        "socket unavailable"
    }
}

private actor ScriptedTransport: ControlTransport {
    private var queuedResponses: [ControlFrame]
    private var recordedRequests: [ControlRequest] = []
    private let fails: Bool
    private let subscribeAck: ControlFrame?
    private let subscribeEvents: [ControlEvent]

    init(
        responses: [ControlFrame] = [],
        fails: Bool = false,
        subscribeAck: ControlFrame? = nil,
        subscribeEvents: [ControlEvent] = []
    ) {
        queuedResponses = responses
        self.fails = fails
        self.subscribeAck = subscribeAck
        self.subscribeEvents = subscribeEvents
    }

    func request(_ request: ControlRequest) async throws -> ControlFrame {
        recordedRequests.append(request)
        if fails {
            throw StubTransportError.unavailable
        }
        guard !queuedResponses.isEmpty else {
            throw StubTransportError.unavailable
        }
        return queuedResponses.removeFirst()
    }

    func subscribe() async throws -> ChatSubscription {
        if fails {
            throw StubTransportError.unavailable
        }
        // Mirrors the real transport: an error in place of the ack throws, and
        // the stream is only handed back once the ack has been seen.
        if let ack = subscribeAck, case .error = ack {
            throw StubTransportError.unavailable
        }
        let events = subscribeEvents
        let stream = AsyncThrowingStream<ControlEvent, Error> { continuation in
            for event in events {
                continuation.yield(event)
            }
            continuation.finish()
        }
        return ChatSubscription(events: stream, cancel: {})
    }

    func requests() -> [ControlRequest] {
        recordedRequests
    }
}

/// `FrameReader` owns the byte-level contract the chat subscription depends on:
/// a burst of coalesced event frames must not lose all but the first.
enum FrameReaderChecks {
    static func run() -> [String] {
        var failures: [String] = []
        failures.append(contentsOf: splitAcrossChunks())
        failures.append(contentsOf: coalescedInOneChunk())
        failures.append(contentsOf: carriageReturnLineEndings())
        failures.append(contentsOf: incompleteAtEOF())
        failures.append(contentsOf: oversizeGuard())
        return failures
    }

    private static func line(_ text: String) -> Data {
        Data(text.utf8)
    }

    private static func eventFrame(seq: Int) -> String {
        "{\"type\":\"event\",\"topic\":\"chat.message\",\"payload\":{\"seq\":\(seq),\"role\":\"assistant\",\"text\":\"t\(seq)\"}}"
    }

    private static func splitAcrossChunks() -> [String] {
        var reader = FrameReader()
        let whole = eventFrame(seq: 1) + "\n"
        let cut = whole.index(whole.startIndex, offsetBy: 20)
        reader.append(line(String(whole[whole.startIndex..<cut])))
        do {
            if try reader.nextFrame() != nil {
                return ["FrameReader yielded a frame from a partial chunk"]
            }
            reader.append(line(String(whole[cut...])))
            guard let frame = try reader.nextFrame() else {
                return ["FrameReader did not reassemble a frame split across chunks"]
            }
            guard case .event(.chatMessage(let payload)) = frame, payload.seq == 1 else {
                return ["FrameReader reassembled the wrong frame"]
            }
            return []
        } catch {
            return ["FrameReader threw on a split frame: \(error)"]
        }
    }

    private static func coalescedInOneChunk() -> [String] {
        var reader = FrameReader()
        reader.append(line(eventFrame(seq: 1) + "\n" + eventFrame(seq: 2) + "\n"))
        do {
            var seqs: [Int] = []
            while let frame = try reader.nextFrame() {
                if case .event(.chatMessage(let payload)) = frame, let seq = payload.seq {
                    seqs.append(seq)
                }
            }
            if seqs != [1, 2] {
                return ["FrameReader dropped coalesced frames, got \(seqs) instead of [1, 2]"]
            }
            return []
        } catch {
            return ["FrameReader threw on coalesced frames: \(error)"]
        }
    }

    private static func carriageReturnLineEndings() -> [String] {
        var reader = FrameReader()
        reader.append(line(eventFrame(seq: 7) + "\r\n"))
        do {
            guard let frame = try reader.nextFrame() else {
                return ["FrameReader did not yield a CRLF-terminated frame"]
            }
            guard case .event(.chatMessage(let payload)) = frame, payload.seq == 7 else {
                return ["FrameReader mis-decoded a CRLF-terminated frame"]
            }
            return []
        } catch {
            return ["FrameReader threw on a CRLF frame: \(error)"]
        }
    }

    private static func incompleteAtEOF() -> [String] {
        var reader = FrameReader()
        reader.append(line("{\"type\":\"event\""))
        do {
            _ = try reader.nextFrame()
        } catch {
            return ["FrameReader should buffer, not throw, before EOF: \(error)"]
        }
        do {
            try reader.assertDrainedAtEOF()
            return ["FrameReader accepted a truncated frame at EOF"]
        } catch {
            return []
        }
    }

    private static func oversizeGuard() -> [String] {
        var reader = FrameReader(maxFrameBytes: 64)
        reader.append(Data(repeating: 0x41, count: 128))
        do {
            _ = try reader.nextFrame()
            return ["FrameReader accepted an oversized unterminated frame"]
        } catch {
            return []
        }
    }
}

/// The subscription contract the chat view model relies on: `subscribe()` is
/// ack-gated, pre-ack events survive, an error instead of the ack throws, and
/// cancelling ends the stream.
enum ChatSubscriptionChecks {
    static func run() async -> [String] {
        var failures: [String] = []

        let queued: [ControlEvent] = [
            .chatMessage(ChatMessagePayload(role: "assistant", text: "before ack", seq: 1)),
            .chatMessage(ChatMessagePayload(role: "assistant", text: "after ack", seq: 2)),
        ]
        let transport = ScriptedTransport(
            subscribeAck: .response(.chatSubscribe(id: "sub-1", payload: ChatSubscribeResponsePayload(subscribed: true))),
            subscribeEvents: queued
        )
        do {
            let subscription = try await transport.subscribe()
            var seqs: [Int] = []
            for try await event in subscription.events {
                if case .chatMessage(let payload) = event, let seq = payload.seq {
                    seqs.append(seq)
                }
            }
            if seqs != [1, 2] {
                failures.append("subscription lost pre-ack events, got \(seqs) instead of [1, 2]")
            }
        } catch {
            failures.append("subscribe threw on a successful ack: \(error)")
        }

        let failing = ScriptedTransport(subscribeAck: .error(ControlError(id: "sub-1", code: .internalError, message: "nope")))
        do {
            _ = try await failing.subscribe()
            failures.append("subscribe returned a subscription despite an error frame in place of the ack")
        } catch {
            // expected
        }

        let cancelling = ScriptedTransport(
            subscribeAck: .response(.chatSubscribe(id: "sub-2", payload: ChatSubscribeResponsePayload(subscribed: true)))
        )
        do {
            let subscription = try await cancelling.subscribe()
            subscription.cancel()
            for try await _ in subscription.events {
                // Draining a cancelled subscription must terminate, not hang.
            }
        } catch {
            failures.append("cancelled subscription surfaced an unexpected error: \(error)")
        }

        return failures
    }
}
