import Foundation
import OpenInstinctPanel

enum LiveDecode {
    static func run() -> Bool {
        guard let data = FileManager.default.contents(atPath: "/tmp/live-status.json") else { return true }
        do {
            let frame = try JSONDecoder().decode(ControlResponse.self, from: data)
            if case .status = frame { return true }
            print("LiveDecode: decoded as wrong case: \(frame)")
            return false
        } catch {
            print("LiveDecode: \(error)")
            return false
        }
    }
}
