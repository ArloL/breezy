import Foundation

/// Bugs the convergence fuzzer plants to show it finds them (scripts/fuzz.ts --plant NAME); nothing else sets this.
let plantedBug = ProcessInfo.processInfo.environment["BREEZY_PLANT"]

func planted(_ name: String) -> Bool { plantedBug == name }
