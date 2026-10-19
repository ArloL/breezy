// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "oskeys",
  platforms: [.macOS(.v15)],
  targets: [
    .executableTarget(name: "oskeys"),
    .executableTarget(name: "oskeys-echo"),
  ]
)
