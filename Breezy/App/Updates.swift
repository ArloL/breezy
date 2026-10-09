import AppKit
import Sparkle

/// Sparkle, on only in builds that name a feed, which CI does on main.
enum Updates {
  static let enabled = !(Bundle.main.object(forInfoDictionaryKey: "SUFeedURL") as? String ?? "").isEmpty && !DebugLaunch.active

  static let controller = SPUStandardUpdaterController(startingUpdater: enabled, updaterDelegate: nil, userDriverDelegate: nil)
}
