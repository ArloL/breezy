import Foundation

/// Past bugs put back by name to show a level finds them (TESTING.md, "Adding a plant"); BREEZY_PLANT names one.
let plantedBug = ProcessInfo.processInfo.environment["BREEZY_PLANT"]

public func planted(_ name: String) -> Bool { plantedBug == name }
