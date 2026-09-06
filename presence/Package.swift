// swift-tools-version: 5.9
import PackageDescription
let package = Package(
    name: "oi-presence",
    platforms: [.macOS(.v13)],
    targets: [.executableTarget(name: "oi-presence", path: "Sources/oi-presence")]
)
