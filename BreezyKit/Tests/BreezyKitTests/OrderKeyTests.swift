import Foundation
import Testing
@testable import BreezyKit

private struct OrderCases: Decodable {
  struct Assign: Decodable {
    var name: String
    var ids: [String]
    var keys: [String: String]
    var result: [String: String]
  }
  var between: [[String?]]
  var assign: [Assign]
}

@Test func orderKeysMatchTheSharedCases() throws {
  let cases = try JSONDecoder().decode(OrderCases.self, from: fixture("order-key.json"))
  for c in cases.between { #expect(OrderKey.between(c[0]!, c[1]) == c[2]!) }
  for c in cases.assign { #expect(OrderKey.assign(c.ids, keeping: c.keys) == c.result, "\(c.name)") }
}

@Test func keysMadeOneAfterAnotherKeepIncreasing() {
  var keys: [String] = []
  var last = ""
  for _ in 0..<200 {
    last = OrderKey.between(last, nil)
    keys.append(last)
  }
  #expect(keys == keys.sorted())
  #expect(Set(keys).count == 200)
  #expect(keys.allSatisfy(OrderKey.valid))
}

@Test func aKeyBetweenTwoSortsBetweenThem() {
  let lo = "V"
  var hi = "W"
  for _ in 0..<50 {
    let m = OrderKey.between(lo, hi)
    #expect(lo < m && m < hi)
    hi = m
  }
}
