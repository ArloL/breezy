// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "BreezyKit",
  platforms: [.macOS(.v15)],
  products: [.library(name: "BreezyKit", targets: ["BreezyKit"])],
  targets: [
    .target(name: "BreezyKit"),
    .testTarget(name: "BreezyKitTests", dependencies: ["BreezyKit"]),
  ],
  swiftLanguageModes: [.v5]
)
