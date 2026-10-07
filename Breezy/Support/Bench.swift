import AppKit
import BreezyKit

/// The scripted workload behind -BreezyBench: idle, a pinch-like zoom, a fast pan, a pointer
/// drag through a lane, typing into a new card and the app hidden. Per phase it records memory
/// footprint, CPU time, card draws and the main-thread time of each step (the step, display and
/// commit) as median, 95th percentile and maximum; then the peak footprint and the launch time.
/// With -BreezyBenchOnly <phase> it runs only that phase, five times, for profiling.
final class Bench {
  private let wc: BoardWindowController
  private let out: String
  private var steps: [() -> Void] = []
  private var results: [String: Any] = [:]
  private var phaseCPU = 0.0
  private var stepMS: [Double] = []
  private let d: Driver

  init(_ wc: BoardWindowController, out: String) {
    self.wc = wc
    self.out = out
    d = Driver(wc)
    results["launch_ms"] = Bench.sinceLaunch()
    mark("idle")
    let phases: [(String, () -> Void)] = [("zoom", zoom), ("pan", pan), ("drag", dragThroughLane), ("type", typeIntoNewCard)]
    if let only = UserDefaults.standard.string(forKey: "BreezyBenchOnly"), let phase = phases.first(where: { $0.0 == only }) {
      for _ in 0..<5 { phase.1() }
      mark(only)
      return
    }
    for (name, phase) in phases {
      phase()
      mark(name)
    }
    steps.append { NSApp.hide(nil) }
    for _ in 0..<40 { steps.append {} }
    mark("hidden")
  }

  /// A pinch: small steps in, out to the minimum and back to 100 %.
  private func zoom() {
    let sv = wc.scrollView
    let path = Bench.ramp(1, 2, 50) + Bench.ramp(2, 0.25, 50) + Bench.ramp(0.25, 1, 25)
    for m in path { steps.append { sv.setMagnification(m, centeredAt: NSPoint(x: sv.contentView.bounds.midX, y: sv.contentView.bounds.midY)) } }
  }

  /// A fast trackpad pan, one frame per step: 30 pt across and 15 pt down, then back.
  private func pan() {
    let sv = wc.scrollView
    for i in 0..<60 {
      steps.append {
        let o = sv.contentView.bounds.origin, s: CGFloat = i < 30 ? 1 : -1
        sv.contentView.scroll(to: NSPoint(x: o.x + 30 * s, y: o.y + 15 * s))
        sv.reflectScrolledClipView(sv.contentView)
      }
    }
  }

  static func ramp(_ a: Double, _ b: Double, _ n: Int) -> [Double] {
    (1...n).map { a + (b - a) * Double($0) / Double(n) }
  }

  /// Takes the highest visible card in a lane down 240 pt within it, then across to the next lane;
  /// without one, there is no drag.
  private func dragThroughLane() {
    var start: NSPoint?, end: NSPoint?
    steps.append { [unowned self] in
      let b = d.board
      let visible = d.canvas.visibleRect.insetBy(dx: 60, dy: 60)
      let candidates = b.lanes.flatMap { l in b.cardsInLane(l.id, heightOf: d.canvas.height).map { (l, $0) } }
        .filter { visible.contains(d.canvas.doc(Rect(x: $0.1.x + $0.1.w / 2, y: $0.1.y + 12, w: 0, h: 0)).origin) }
      if let (l, c) = candidates.min(by: { $0.1.y < $1.1.y }) {
        let next = b.lanes.filter { $0.x > l.x }.min { $0.x < $1.x }
        start = NSPoint(x: c.x + c.w / 2, y: c.y + 12)
        end = NSPoint(x: next.map { $0.x + $0.w / 2 } ?? c.x + c.w / 2 + 504, y: c.y + 252)
      }
      if let start { d.mouse(.leftMouseDown, start) }
    }
    // down the lane first, then across: 40 moves down, 40 across
    for i in 1...80 {
      steps.append { [unowned self] in
        guard let a = start, let b = end else { return }
        let p = i <= 40
          ? NSPoint(x: a.x, y: a.y + (b.y - a.y) * Double(i) / 40)
          : NSPoint(x: a.x + (b.x - a.x) * Double(i - 40) / 40, y: b.y)
        d.mouse(.leftMouseDragged, p)
      }
    }
    steps.append { [unowned self] in if let end { d.mouse(.leftMouseUp, end) } }
  }

  /// Double-clicks empty space left of the visible area's centre, types 40 characters and finishes.
  private func typeIntoNewCard() {
    steps.append { [unowned self] in
      let v = d.canvas.visibleWorldCentre
      d.doubleClick(NSPoint(x: v.x - 120, y: v.y))
    }
    for ch in "Quick brown fox jumps over the lazy dog!" { steps.append { [unowned self] in d.type(String(ch)) } }
    steps.append { [unowned self] in d.key("\u{1b}", code: 53) }
  }

  private func mark(_ name: String) {
    steps.append { [unowned self] in
      let ms = stepMS.sorted()
      func q(_ p: Double) -> Double { ms.isEmpty ? 0 : (ms[min(ms.count - 1, Int(Double(ms.count) * p))] * 100).rounded() / 100 }
      results[name] = [
        "mb": (footprint().now * 10).rounded() / 10, "cpu_ms": ((cpuSeconds() - phaseCPU) * 1000).rounded(), "draws": CardLayer.drawCount, "layers": wc.canvas.cardLayers.count, "visible": wc.window!.occlusionState.contains(.visible),
        "p50_ms": q(0.5), "p95_ms": q(0.95), "max_ms": q(1),
      ]
      CardLayer.drawCount = 0
      phaseCPU = cpuSeconds()
      stepMS = []
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
    let t = CACurrentMediaTime()
    steps.removeFirst()()
    wc.window?.displayIfNeeded()
    CATransaction.flush()
    stepMS.append((CACurrentMediaTime() - t) * 1000)
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { self.next() }
  }

  /// Milliseconds from process start until now.
  private static func sinceLaunch() -> Double {
    var info = kinfo_proc()
    var size = MemoryLayout<kinfo_proc>.size
    var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
    sysctl(&mib, 4, &info, &size, nil, 0)
    let s = info.kp_proc.p_un.__p_starttime
    let start = Double(s.tv_sec) + Double(s.tv_usec) / 1e6
    return ((Date().timeIntervalSince1970 - start) * 1000).rounded()
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
