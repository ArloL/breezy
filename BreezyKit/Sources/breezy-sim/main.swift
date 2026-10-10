import BreezySim
import Foundation

// Dictionaries iterate in an order seeded per process unless hashing is deterministic, which the runtime reads at launch.
if getenv("SWIFT_DETERMINISTIC_HASHING") == nil, let path = Bundle.main.executablePath {
  setenv("SWIFT_DETERMINISTIC_HASHING", "1", 1)
  let args = CommandLine.arguments.map { strdup($0) } + [nil]
  execv(path, args)
  fputs("breezy-sim: could not restart with deterministic hashing\n", stderr)
  exit(1)
}

/// Commands on stdin, answers on stdout, a line each; ends at end of input.
@MainActor func serve() async {
  let host = SimHost()
  while let line = readLine() {
    guard !line.isEmpty else { continue }
    print(await host.handle(line))
    fflush(stdout)
  }
  host.close()
}

await serve()
