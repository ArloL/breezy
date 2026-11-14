import AppKit

let delegate = AppDelegate()
BreezyApplication.shared.delegate = delegate
_ = NSApplicationMain(CommandLine.argc, CommandLine.unsafeArgv)
