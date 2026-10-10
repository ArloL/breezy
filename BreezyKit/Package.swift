// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "BreezyKit",
  platforms: [.macOS(.v15)],
  products: [
    .library(name: "BreezyKit", targets: ["BreezyKit"]),
    .executable(name: "breezy-sim", targets: ["breezy-sim"]),
  ],
  targets: [
    .target(name: "BreezyKit"),
    // the fuzzer's Swift devices: the host in a library, so that tests drive it in-process
    .target(name: "BreezySim", dependencies: ["BreezyKit"]),
    .executableTarget(name: "breezy-sim", dependencies: ["BreezySim"]),
    .testTarget(name: "BreezyKitTests", dependencies: ["BreezyKit", "BreezySim", "breezy-sim"]),
  ],
  swiftLanguageModes: [.v5]
)
