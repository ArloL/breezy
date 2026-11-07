// swift-tools-version: 6.0
import PackageDescription

// Linux, for CI's runners: swift-crypto stands in for CryptoKit. In the manifest's #if, so that Apple's builds resolve nothing
#if os(Linux)
let crypto: [Package.Dependency] = [.package(url: "https://github.com/apple/swift-crypto.git", exact: "5.0.3")]
let cryptoProduct: [Target.Dependency] = [.product(name: "Crypto", package: "swift-crypto")]
// and zlib for Apple's NSData.compressed
let linuxOnly: [Target] = [.systemLibrary(name: "CZlib", providers: [.apt(["zlib1g-dev"])])]
let linuxProducts: [Target.Dependency] = cryptoProduct + ["CZlib"]
#else
let crypto: [Package.Dependency] = []
let cryptoProduct: [Target.Dependency] = []
let linuxOnly: [Target] = []
let linuxProducts: [Target.Dependency] = []
#endif

let package = Package(
  name: "BreezyKit",
  platforms: [.macOS(.v15)],
  products: [
    .library(name: "BreezyKit", targets: ["BreezyKit"]),
    .executable(name: "breezy-sim", targets: ["breezy-sim"]),
  ],
  dependencies: crypto,
  targets: [
    .target(name: "BreezyKit", dependencies: linuxProducts),
    // the fuzzer's Swift devices: the host in a library, so that tests drive it in-process
    .target(name: "BreezySim", dependencies: ["BreezyKit"]),
    .executableTarget(name: "breezy-sim", dependencies: ["BreezySim"]),
    .testTarget(name: "BreezyKitTests", dependencies: ["BreezyKit", "BreezySim", "breezy-sim"] + cryptoProduct),
  ] + linuxOnly,
  swiftLanguageModes: [.v5]
)
