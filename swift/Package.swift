// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "Inter",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "Inter", targets: ["Inter"])],
    targets: [
        .executableTarget(name: "Inter", path: "Sources", resources: [.copy("Resources/Fonts")]),
        .testTarget(name: "InterTests", dependencies: ["Inter"], path: "Tests"),
    ]
)
