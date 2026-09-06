import Foundation
import Network

public enum ControlTransportError: Error, LocalizedError, Sendable {
    case connectionFailed(String)
    case connectionClosed
    case missingNegotiation
    case unsupportedCapability(ControlCapability)
    case unexpectedFrame

    public var errorDescription: String? {
        switch self {
        case .connectionFailed(let message):
            return "Unable to connect to openinstinct: \(message)"
        case .connectionClosed:
            return "The openinstinct control socket closed unexpectedly."
        case .missingNegotiation:
            return "The daemon did not complete protocol negotiation."
        case .unsupportedCapability(let capability):
            return "The daemon does not support \(capability.rawValue)."
        case .unexpectedFrame:
            return "The daemon returned an unexpected control frame."
        }
    }
}

/// A live `chat.subscribe` stream. `events` yields every `chat.message` /
/// `chat.presence` frame the daemon pushes, starting with any that arrived
/// before the subscribe ack.
public struct ChatSubscription: Sendable {
    public let events: AsyncThrowingStream<ControlEvent, Error>
    private let cancelHandler: @Sendable () -> Void

    public init(events: AsyncThrowingStream<ControlEvent, Error>, cancel: @escaping @Sendable () -> Void) {
        self.events = events
        self.cancelHandler = cancel
    }

    public func cancel() {
        cancelHandler()
    }
}

public protocol ControlTransport: Sendable {
    func request(_ request: ControlRequest) async throws -> ControlFrame
    /// Resolves only after the daemon acks `chat.subscribe`, so a caller may
    /// subscribe before loading history without losing the events in between.
    func subscribe() async throws -> ChatSubscription
}

public actor UnixSocketTransport: ControlTransport {
    /// `OI_CONTROL_SOCKET` lets a dev build or the docs screenshot harness point
    /// the panel at another daemon (or a mock) without touching the install.
    public static let defaultSocketPath = ProcessInfo.processInfo.environment["OI_CONTROL_SOCKET"]
        ?? NSHomeDirectory() + "/.openinstinct/run/control.sock"

    private let socketPath: String
    private let clientName: String
    private let queue = DispatchQueue(label: "openinstinct.panel.control")

    public init(socketPath: String = UnixSocketTransport.defaultSocketPath, clientName: String = "openinstinct-panel") {
        self.socketPath = socketPath
        self.clientName = clientName
    }

    public func request(_ request: ControlRequest) async throws -> ControlFrame {
        let connection = NWConnection(to: .unix(path: socketPath), using: .tcp)
        defer { connection.cancel() }
        // Connection-scoped so coalesced frames survive across reads.
        var reader = FrameReader()

        try await waitUntilReady(connection)
        try await send(.hello(HelloFrame(client: clientName)), over: connection)

        let negotiation = try await nextFrame(from: connection, reader: &reader)
        guard case .negotiated(let negotiated) = negotiation else {
            throw ControlTransportError.missingNegotiation
        }
        guard negotiated.capabilities.contains(request.capability) else {
            throw ControlTransportError.unsupportedCapability(request.capability)
        }

        try await send(.request(request), over: connection)
        while true {
            let frame = try await nextFrame(from: connection, reader: &reader)
            switch frame {
            case .event:
                continue
            case .response(let response) where response.id == request.id:
                return frame
            case .error(let error) where error.id == nil || error.id == request.id:
                return frame
            default:
                throw ControlTransportError.unexpectedFrame
            }
        }
    }

    /// Opens a long-lived subscription. Resolves only once the daemon acks, and
    /// queues any event that arrives before the ack so the caller can load
    /// history afterwards without a gap.
    public func subscribe() async throws -> ChatSubscription {
        let connection = NWConnection(to: .unix(path: socketPath), using: .tcp)
        var reader = FrameReader()
        var success = false
        defer {
            if !success {
                connection.cancel()
            }
        }

        try await waitUntilReady(connection)
        try await send(.hello(HelloFrame(client: clientName)), over: connection)

        let negotiation = try await nextFrame(from: connection, reader: &reader)
        guard case .negotiated(let negotiated) = negotiation else {
            throw ControlTransportError.missingNegotiation
        }
        guard negotiated.capabilities.contains(.chatSubscribe) else {
            throw ControlTransportError.unsupportedCapability(.chatSubscribe)
        }

        let id = UUID().uuidString
        try await send(.request(.chatSubscribe(id: id)), over: connection)

        var queued: [ControlEvent] = []
        ackLoop: while true {
            let frame = try await nextFrame(from: connection, reader: &reader)
            switch frame {
            case .event(let event):
                queued.append(event)
            case .response(let response) where response.id == id:
                break ackLoop
            case .error(let error) where error.id == nil || error.id == id:
                throw ControlTransportError.connectionFailed(error.message)
            default:
                throw ControlTransportError.unexpectedFrame
            }
        }

        success = true
        let pending = reader
        let stream = AsyncThrowingStream<ControlEvent, Error> { continuation in
            for event in queued {
                continuation.yield(event)
            }
            let pump = Task.detached { [socketPath = self.socketPath] in
                _ = socketPath
                var live = pending
                do {
                    while true {
                        let frame = try await UnixSocketTransport.readFrame(from: connection, reader: &live)
                        if case .event(let event) = frame {
                            continuation.yield(event)
                        }
                    }
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in
                pump.cancel()
                connection.cancel()
            }
        }
        return ChatSubscription(events: stream, cancel: { connection.cancel() })
    }

    private func waitUntilReady(_ connection: NWConnection) async throws {
        let queue = queue
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            connection.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    connection.stateUpdateHandler = nil
                    continuation.resume()
                case .failed(let error):
                    connection.stateUpdateHandler = nil
                    continuation.resume(throwing: ControlTransportError.connectionFailed(error.localizedDescription))
                case .cancelled:
                    connection.stateUpdateHandler = nil
                    continuation.resume(throwing: ControlTransportError.connectionClosed)
                default:
                    break
                }
            }
            connection.start(queue: queue)
        }
    }


    private func send(_ frame: ControlFrame, over connection: NWConnection) async throws {
        var data = try ControlCodec.encode(frame)
        data.append(0x0A)
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            connection.send(content: data, completion: .contentProcessed { error in
                if let error {
                    continuation.resume(throwing: ControlTransportError.connectionFailed(error.localizedDescription))
                } else {
                    continuation.resume()
                }
            })
        }
    }


    private func nextFrame(from connection: NWConnection, reader: inout FrameReader) async throws -> ControlFrame {
        try await UnixSocketTransport.readFrame(from: connection, reader: &reader)
    }

    /// Drains any frame already buffered before issuing another read, so a
    /// chunk carrying several frames yields them all instead of only the first.
    fileprivate static func readFrame(from connection: NWConnection, reader: inout FrameReader) async throws -> ControlFrame {
        while true {
            if let frame = try reader.nextFrame() {
                return frame
            }
            do {
                reader.append(try await readChunk(from: connection))
            } catch {
                try reader.assertDrainedAtEOF()
                throw error
            }
        }
    }

    fileprivate static func readChunk(from connection: NWConnection) async throws -> Data {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Data, Error>) in
            connection.receive(minimumIncompleteLength: 1, maximumLength: 256 * 1024) { content, _, isComplete, error in
                if let error {
                    continuation.resume(throwing: ControlTransportError.connectionFailed(error.localizedDescription))
                } else if let content, !content.isEmpty {
                    continuation.resume(returning: content)
                } else if isComplete {
                    continuation.resume(throwing: ControlTransportError.connectionClosed)
                } else {
                    continuation.resume(throwing: ControlTransportError.connectionClosed)
                }
            }
        }
    }
}
