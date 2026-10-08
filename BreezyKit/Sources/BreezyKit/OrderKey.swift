import Foundation

/// Fractional order keys: strings of base-62 digits, compared as strings, never ending in "0", so
/// that a key fits between any two. Cards sort by key, then id, so equal keys are harmless.
public enum OrderKey {
  static let digits = Array("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz")

  public static func valid(_ key: String) -> Bool {
    !key.isEmpty && !key.hasSuffix("0") && key.allSatisfy(digits.contains)
  }

  /// A key after `a` and before `b`; "" is the start and nil the end. Needs a < b, both valid or "".
  public static func between(_ a: String, _ b: String?) -> String {
    String(midpoint(Array(a), b.map(Array.init)))
  }

  private static func midpoint(_ a: [Character], _ b: [Character]?) -> [Character] {
    if let b {
      var n = 0
      while n < b.count && (n < a.count ? a[n] : "0") == b[n] { n += 1 }
      if n > 0 { return Array(b[..<n]) + midpoint(Array(a.dropFirst(n)), Array(b.dropFirst(n))) }
    }
    let da = a.first.map(index) ?? 0
    let db = b.flatMap { $0.first.map(index) } ?? digits.count
    if db - da > 1 { return [digits[(da + db + 1) / 2]] }
    if let b, b.count > 1 { return [b[0]] }
    return [digits[da]] + midpoint(Array(a.dropFirst()), nil)
  }

  private static func index(_ c: Character) -> Int { digits.firstIndex(of: c)! }

  /// Keys for `ids` in this order: the longest run whose `keys` already increase keeps them, the
  /// others get keys between their neighbours, so a reorder rewrites as few cards as it can.
  public static func assign(_ ids: [String], keeping keys: [String: String]) -> [String: String] {
    let known = ids.map { id in keys[id].flatMap { valid($0) ? $0 : nil } }
    let kept = longestIncreasing(known)
    var out: [String: String] = [:]
    var i = 0
    while i < ids.count {
      if kept.contains(i) {
        out[ids[i]] = known[i]!
        i += 1
        continue
      }
      var j = i
      while j < ids.count && !kept.contains(j) { j += 1 }
      var lo = i > 0 ? out[ids[i - 1]]! : ""
      let hi = j < ids.count ? known[j]! : nil
      for k in i..<j {
        lo = between(lo, hi)
        out[ids[k]] = lo
      }
      i = j
    }
    return out
  }

  /// The indices of a longest strictly increasing run of the keys present.
  static func longestIncreasing(_ keys: [String?]) -> Set<Int> {
    var tails: [Int] = []
    var prev = [Int?](repeating: nil, count: keys.count)
    for (i, k) in keys.enumerated() {
      guard let k else { continue }
      var lo = 0, hi = tails.count
      while lo < hi {
        let m = (lo + hi) / 2
        if keys[tails[m]]! < k { lo = m + 1 } else { hi = m }
      }
      prev[i] = lo > 0 ? tails[lo - 1] : nil
      if lo == tails.count { tails.append(i) } else { tails[lo] = i }
    }
    var out = Set<Int>()
    var at = tails.last
    while let j = at {
      out.insert(j)
      at = prev[j]
    }
    return out
  }
}
