import Foundation

/// Incremental NDJSON frame splitter.
///
/// The control socket writes one JSON frame per line. A single `receive` can
/// return a partial frame, several coalesced frames, or any split in between,
/// so the leftover bytes have to survive across reads: buffering per call
/// silently drops every frame after the first newline in a chunk, which loses
/// events whenever the daemon emits a burst.
public struct FrameReader: Sendable {
    public enum ReaderError: Error, LocalizedError, Sendable {
        case oversizedFrame(Int)
        case incompleteFrameAtEOF(Int)

        public var errorDescription: String? {
            switch self {
            case .oversizedFrame(let limit):
                return "control frame exceeds \(limit) bytes"
            case .incompleteFrameAtEOF(let pending):
                return "control socket closed with \(pending) buffered bytes and no frame terminator"
            }
        }
    }

    private var buffered = Data()
    private let maxFrameBytes: Int

    public init(maxFrameBytes: Int = 256 * 1024) {
        self.maxFrameBytes = maxFrameBytes
    }

    public var pendingByteCount: Int { buffered.count }

    public mutating func append(_ chunk: Data) {
        buffered.append(chunk)
    }

    /// Returns the next complete line, or nil when more bytes are needed.
    /// Throws once the buffer exceeds the frame cap without a terminator, so a
    /// peer streaming an unbounded line cannot exhaust memory.
    public mutating func nextLine() throws -> Data? {
        guard let newline = buffered.firstIndex(of: 0x0A) else {
            if buffered.count > maxFrameBytes {
                throw ReaderError.oversizedFrame(maxFrameBytes)
            }
            return nil
        }
        var line = Data(buffered[buffered.startIndex..<newline])
        buffered.removeSubrange(buffered.startIndex...newline)
        if line.last == 0x0D {
            line.removeLast()
        }
        return line
    }

    /// Decodes the next complete frame. Blank lines are skipped so a stray
    /// keep-alive newline is not a decode error.
    public mutating func nextFrame() throws -> ControlFrame? {
        while let line = try nextLine() {
            if line.isEmpty {
                continue
            }
            return try ControlCodec.decode(line)
        }
        return nil
    }

    /// Called when the peer closes: a non-empty buffer means the last frame was
    /// truncated, which must surface rather than being silently discarded.
    public func assertDrainedAtEOF() throws {
        if !buffered.isEmpty {
            throw ReaderError.incompleteFrameAtEOF(buffered.count)
        }
    }
}
