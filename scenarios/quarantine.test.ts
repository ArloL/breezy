import { test } from "node:test";
import assert from "node:assert/strict";
import { cases } from "./cases.ts";
import { QUARANTINE, quarantined } from "./quarantine.ts";

test("a case quarantined on a pair says why on that pair only, and on every pair when none is named", () => {
  const list = [{ case: "a", pair: "chromium:mac", why: "flaky", since: "2026-10-25" }, { case: "b", why: "flaky", since: "2026-10-25" }];
  assert.equal(quarantined("a", "chromium:mac", list), "quarantined since 2026-10-25: flaky");
  assert.equal(quarantined("a", "mac:chromium", list), null);
  assert.ok(quarantined("b", "webkit:firefox", list));
});

test("each quarantined case is a case, with a date and a reason", () => {
  for (const q of QUARANTINE) {
    assert.ok(cases.some((c) => c.name === q.case), q.case);
    assert.match(q.since, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(q.why.length > 0);
  }
});
