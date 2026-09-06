// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "OpenInstinctPanel",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "OpenInstinctPanel", targets: ["OpenInstinctPanel"]),
    ],
    targets: [
        .target(
            name: "Testing",
            path: "Support/Testing"
        ),
        .executableTarget(
            name: "OpenInstinctPanel"
        ),
        .testTarget(
            name: "OpenInstinctPanelTests",
            dependencies: ["OpenInstinctPanel", "Testing"],
            resources: [.copy("Resources")]
        ),
    ]
)
