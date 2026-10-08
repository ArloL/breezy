import Foundation
import Testing
@testable import BreezyKit

private struct MergeCase: Decodable {
  var name: String
  var base: Record?
  var local: Record
  var incoming: Record
  var record: Record
  var copy: Record?
}

@Test func mergesMatchTheSharedCases() throws {
  for c in try JSONDecoder().decode([MergeCase].self, from: fixture("merge.json")) {
    let r = Merge.record(base: c.base, local: c.local, incoming: c.incoming)
    #expect(r.record == c.record, "\(c.name)")
    #expect(r.copy == c.copy, "\(c.name)")
  }
}
