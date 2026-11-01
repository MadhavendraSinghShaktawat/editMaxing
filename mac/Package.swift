// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "ShifuDojo",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "ShifuDojo", path: "Sources/ShifuDojo"),
        .executableTarget(
            name: "dojo-native",
            path: "Sources/DojoNative",
            swiftSettings: [.unsafeFlags(["-Ounchecked"], .when(configuration: .release))]
        ),
    ]
)
