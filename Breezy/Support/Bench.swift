import AppKit
import BreezyKit

/// The scripted workload behind -BreezyBench: idle, a zoom sweep, a trackpad pan and a card drag,
/// recording memory footprint and CPU time per phase, then the peak footprint.
final class Bench {
  private let wc: BoardWindowController
  private let out: String
  private var steps: [() -> Void] = []
  private var results: [String: Any] = [:]
  private var phaseCPU = 0.0

  init(_ wc: BoardWindowController, out: String) {
    self.wc = wc
    self.out = out
    let sv = wc.scrollView
    let centre = { NSPoint(x: sv.contentView.bounds.midX, y: sv.contentView.bounds.midY) }
    mark("idle")
    for m in [0.75, 0.5, 0.35, 0.25, 0.5, 1, 1.5, 2, 1] { steps.append { sv.setMagnification(m, centeredAt: centre()) } }
    mark("zoom")
    for i in 0..<60 {
      let d: Int32 = i < 30 ? -120 : 120
      let phase: Int64 = i % 30 == 0 ? 1 : (i % 30 == 29 ? 4 : 2)
      steps.append { sv.scrollWheel(with: Bench.scroll(dx: d, dy: d / 2, phase: phase)) }
    }
    mark("pan")
    for i in 0..<60 {
      steps.append {
        guard let first = wc.canvas.board.cards.first else { return }
        wc.canvas.model.perform("Bench") { b in
          b.moveCards([Origin(id: first.id, x: first.x, y: first.y)], dx: i % 2 == 0 ? Metrics.grid : -Metrics.grid, dy: i < 30 ? Metrics.grid : -Metrics.grid)
        }
      }
    }
    mark("drag")
  }

  /// A trackpad scroll event: precise pixel deltas with a gesture phase (1 began, 2 changed, 4 ended).
  static func scroll(dx: Int32, dy: Int32, phase: Int64) -> NSEvent {
    let e = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0)!
    e.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
    e.setIntegerValueField(.scrollWheelEventScrollPhase, value: phase)
    return NSEvent(cgEvent: e)!
  }

  private func mark(_ name: String) {
    steps.append { [unowned self] in
      results[name] = ["mb": (footprint().now * 10).rounded() / 10, "cpu_ms": ((cpuSeconds() - phaseCPU) * 1000).rounded(), "draws": CardLayer.drawCount]
      CardLayer.drawCount = 0
      phaseCPU = cpuSeconds()
    }
  }

  func run() {
    phaseCPU = cpuSeconds()
    next()
  }

  private func next() {
    guard !steps.isEmpty else {
      results["peak_mb"] = (footprint().peak * 10).rounded() / 10
      results["cards"] = wc.canvas.board.cards.count
      let json = try! JSONSerialization.data(withJSONObject: results, options: [.sortedKeys])
      try! json.write(to: URL(fileURLWithPath: out))
      exit(0)
    }
    steps.removeFirst()()
    wc.window?.displayIfNeeded()
    CATransaction.flush()
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { self.next() }
  }

  private func footprint() -> (now: Double, peak: Double) {
    var info = task_vm_info_data_t()
    var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
    _ = withUnsafeMutablePointer(to: &info) {
      $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count) }
    }
    return (Double(info.phys_footprint) / 1e6, Double(info.ledger_phys_footprint_peak) / 1e6)
  }

  private func cpuSeconds() -> Double {
    var u = rusage()
    getrusage(RUSAGE_SELF, &u)
    return Double(u.ru_utime.tv_sec + u.ru_stime.tv_sec) + Double(u.ru_utime.tv_usec + u.ru_stime.tv_usec) / 1e6
  }
}
