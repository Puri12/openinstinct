import Combine
import Foundation

/// A single owner-facing bubble in the shared chat transcript.
public struct ChatRow: Identifiable, Equatable, Sendable {
    public let id: String
    public let role: String
    public let source: String?
    public let text: String?
    public let image: ChatImageRef?
    public let at: String?
    public let turnId: String?
    public let seq: Int?
    public let final: Bool
    public let isOwner: Bool
    public let isGap: Bool

    public init(
        id: String,
        role: String,
        source: String? = nil,
        text: String? = nil,
        image: ChatImageRef? = nil,
        at: String? = nil,
        turnId: String? = nil,
        seq: Int? = nil,
        final: Bool = false,
        isOwner: Bool? = nil,
        isGap: Bool = false
    ) {
        self.id = id
        self.role = role
        self.source = source
        self.text = text
        self.image = image
        self.at = at
        self.turnId = turnId
        self.seq = seq
        self.final = final
        self.isOwner = isOwner ?? (role.lowercased() == "owner" || role.lowercased() == "user")
        self.isGap = isGap
    }

    public static func gap(id: String = "gap") -> ChatRow {
        ChatRow(id: id, role: "gap", text: "Earlier messages are unavailable.", isGap: true)
    }
}

@MainActor
public final class ChatViewModel: ObservableObject {
    @Published public private(set) var messages: [ChatRow] = []
    @Published public private(set) var typing = false
    @Published public private(set) var banner: String?
    @Published public private(set) var sending = false

    /// The sequence watermark is intentionally not part of the view surface, but
    /// remains readable by the panel checks to prove reconnect/repair monotonicity.
    private(set) var lastSeq = 0

    /// The composer is derived from the shared panel state. In particular, the
    /// iMessage lane is deliberately absent from this decision.
    public var composerBlock: String? {
        if panel.connectionState == .absent {
            return Self.offlineDetail
        }
        guard let status = panel.status else {
            return nil
        }
        if status.bootstrap.state == .credentialsBlocked {
            return status.bootstrap.remediation
        }
        if status.session.paused {
            return "Paused"
        }
        return nil
    }

    private static let offlineDetail = "OmO isn't running on this Mac right now. Reinstall it, or wait a moment and check again."

    private let panel: PanelViewModel
    private let transport: any ControlTransport
    private var subscription: ChatSubscription?
    private var streamTask: Task<Void, Never>?
    private var pollTask: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?
    private var pending: [ControlEvent] = []
    private var loaded = false
    private var openState = false
    private var repairTurnId: String?
    private var repairDue = false

    public init(panel: PanelViewModel, transport: any ControlTransport = UnixSocketTransport()) {
        self.panel = panel
        self.transport = transport
    }

    /// Opens the lossless subscription/history view and returns once the first
    /// history response (including any required repair refetch) has settled.
    public func open() async {
        guard !openState else { return }
        openState = true
        loaded = false
        pending.removeAll()
        repairTurnId = nil
        repairDue = false
        startStatusPolling()
        syncPanelPresentation()
        await establishConnection()
    }

    public func send(_ text: String) async {
        guard composerBlock == nil else { return }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        sending = true
        defer { sending = false }

        let request = ControlRequest.chatSend(
            id: requestID(),
            payload: ChatSendPayload(text: text)
        )
        do {
            let frame = try await transport.request(request)
            switch frame {
            case .response(.chatSend(_, let payload)):
                if payload.outcome == "suppressed_paused" {
                    banner = "Paused"
                }
            case .error(let error):
                await panel.refreshStatus()
                syncPanelPresentation()
                banner = error.message
            default:
                banner = ChatViewModelError.unexpectedResponse.localizedDescription
            }
        } catch {
            await panel.refreshStatus()
            syncPanelPresentation()
            banner = error.localizedDescription
        }
    }

    public func close() {
        openState = false
        loaded = false
        pending.removeAll()
        pollTask?.cancel()
        pollTask = nil
        reconnectTask?.cancel()
        reconnectTask = nil
        tearDownConnection()
    }

    private func establishConnection() async {
        guard openState else { return }
        tearDownConnection()
        loaded = false
        pending.removeAll()

        do {
            let sub = try await transport.subscribe()
            guard openState else {
                sub.cancel()
                return
            }
            subscription = sub
            let events = sub.events
            streamTask = Task { [weak self] in
                guard let self else { return }
                await self.consume(events)
            }
            try await loadHistory(resetWatermark: true)
        } catch {
            guard openState else { return }
            banner = error.localizedDescription
            tearDownConnection()
            scheduleReconnect()
        }
    }

    private func consume(_ events: AsyncThrowingStream<ControlEvent, Error>) async {
        do {
            for try await event in events {
                guard openState else { return }
                if !loaded {
                    pending.append(event)
                    continue
                }
                if apply(event) {
                    await repairIfNeeded()
                }
            }
        } catch {
            guard openState, !Task.isCancelled else { return }
            scheduleReconnect()
        }
    }

    private func loadHistory(resetWatermark: Bool) async throws {
        guard openState else { return }
        let previousWatermark = lastSeq
        loaded = false

        let history = try await requestHistory()
        guard openState else { return }

        // (i) Replace history rows before touching the sequence watermark.
        messages = history.messages.enumerated().map { index, payload in
            row(from: payload, id: "history:\(index)")
        }
        lastSeq = resetWatermark ? 0 : previousWatermark

        // (ii) Arm repair before replaying either tail or buffered events.
        repairTurnId = nil
        repairDue = false
        if history.tailTruncated == true {
            repairTurnId = history.inFlight?.turnId
            messages.append(.gap())
            if repairTurnId == nil {
                repairDue = true
            }
        }

        // (iii) Replay the daemon tail, then buffered events in sequence order.
        let tail = history.tail.map { ControlEvent.chatMessage($0.payload) }
        for event in sortedBySequence(tail) {
            _ = apply(event)
        }

        let buffered = pending
        pending.removeAll()
        let pendingWatermark = max(lastSeq, history.seq)
        for event in sortedBySequence(buffered) {
            guard let seq = sequence(of: event), seq > pendingWatermark else { continue }
            _ = apply(event)
        }

        lastSeq = max(lastSeq, history.seq)
        typing = history.inFlight?.typing ?? false
        loaded = true

        // (iv) A truncated tail is repaired only after the initial snapshot and
        // replay have been made visible. Refetch keeps the current watermark so
        // settled tail events cannot be appended a second time.
        await repairIfNeeded()
    }

    private func repairIfNeeded() async {
        guard openState, repairDue else { return }
        repairDue = false
        repairTurnId = nil
        do {
            try await loadHistory(resetWatermark: false)
        } catch {
            guard openState else { return }
            banner = error.localizedDescription
            tearDownConnection()
            scheduleReconnect()
        }
    }

    private func requestHistory() async throws -> ChatHistoryResponsePayload {
        let frame = try await transport.request(
            .chatHistory(id: requestID(), payload: ChatHistoryPayload(limit: 50))
        )
        switch frame {
        case .response(.chatHistory(_, let payload)):
            return payload
        case .error(let error):
            throw ChatViewModelError.server(error.message)
        default:
            throw ChatViewModelError.unexpectedResponse
        }
    }

    /// Returns true when this event completed the turn whose truncated tail is
    /// represented by the gap row.
    @discardableResult
    private func apply(_ event: ControlEvent) -> Bool {
        guard let seq = sequence(of: event), seq > lastSeq else { return false }
        switch event {
        case .chatMessage(let payload):
            lastSeq = seq
            append(row(from: payload, id: String(seq)))
            if !isOwner(payload) {
                typing = false
            }
            if payload.final == true, payload.turnId == repairTurnId {
                repairDue = true
                return true
            }
        case .chatPresence(let payload):
            lastSeq = seq
            if let nextTyping = payload.typing {
                typing = nextTyping
            }
        default:
            break
        }
        return false
    }

    private func append(_ row: ChatRow) {
        guard let seq = row.seq else {
            let gapIndex = messages.firstIndex(where: \.isGap) ?? messages.endIndex
            messages.insert(row, at: gapIndex)
            return
        }

        // History rows have no sequence and stay before live rows. A gap stays
        // last until the repair refetch removes it.
        let end = messages.firstIndex(where: \.isGap) ?? messages.endIndex
        let insertion = messages[..<end].firstIndex { existing in
            guard let existingSeq = existing.seq else { return false }
            return existingSeq > seq
        } ?? end
        messages.insert(row, at: insertion)
    }

    private func row(from payload: ChatMessagePayload, id: String) -> ChatRow {
        ChatRow(
            id: id,
            role: payload.role,
            source: payload.source,
            text: payload.text,
            image: payload.image,
            at: payload.at,
            turnId: payload.turnId,
            seq: payload.seq,
            final: payload.final ?? false,
            isOwner: isOwner(payload)
        )
    }

    private func isOwner(_ payload: ChatMessagePayload) -> Bool {
        let role = payload.role.lowercased()
        return role == "owner" || role == "user"
    }

    private func sequence(of event: ControlEvent) -> Int? {
        switch event {
        case .chatMessage(let payload): return payload.seq
        case .chatPresence(let payload): return payload.seq
        default: return nil
        }
    }

    private func sortedBySequence(_ events: [ControlEvent]) -> [ControlEvent] {
        events.enumerated().sorted { lhs, rhs in
            let left = sequence(of: lhs.element) ?? Int.max
            let right = sequence(of: rhs.element) ?? Int.max
            if left == right { return lhs.offset < rhs.offset }
            return left < right
        }.map(\.element)
    }

    private func startStatusPolling() {
        guard pollTask == nil else { return }
        pollTask = Task { [weak self] in
            while let self, self.openState, !Task.isCancelled {
                do {
                    try await Task.sleep(nanoseconds: 5_000_000_000)
                } catch {
                    return
                }
                guard self.openState, !Task.isCancelled else { return }
                await self.panel.refreshStatus()
                self.syncPanelPresentation()
            }
        }
    }

    private func syncPanelPresentation() {
        if panel.connectionState == .absent {
            if banner == nil {
                banner = Self.offlineDetail
            }
            objectWillChange.send()
            return
        }
        guard let status = panel.status else {
            objectWillChange.send()
            return
        }
        switch status.bootstrap.state {
        case .starting, .configBlocked, .identityBlocked, .permissionBlocked, .credentialsBlocked, .degraded:
            banner = status.bootstrap.remediation
        case .running:
            break
        }
        objectWillChange.send()
    }

    private func scheduleReconnect() {
        guard openState, reconnectTask == nil else { return }
        reconnectTask = Task { [weak self] in
            do {
                try await Task.sleep(nanoseconds: 3_000_000_000)
            } catch {
                return
            }
            guard !Task.isCancelled, let self, self.openState else { return }
            self.reconnectTask = nil
            await self.establishConnection()
        }
    }

    private func tearDownConnection() {
        streamTask?.cancel()
        streamTask = nil
        subscription?.cancel()
        subscription = nil
    }

    private func requestID() -> String {
        UUID().uuidString.lowercased()
    }
}

private enum ChatViewModelError: LocalizedError {
    case unexpectedResponse
    case server(String)

    var errorDescription: String? {
        switch self {
        case .unexpectedResponse:
            return "The daemon returned an unexpected control response."
        case .server(let message):
            return message
        }
    }
}
