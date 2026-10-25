import { test } from "node:test";
import assert from "node:assert/strict";
import { planted } from "../sync/plant.ts";

test("a plant named in BREEZY_PLANT is planted, so that any test run takes one", () => {
  delete globalThis.__breezyPlant;
  process.env.BREEZY_PLANT = "x";
  try {
    assert.equal(planted("x"), true);
    assert.equal(planted("y"), false);
  } finally {
    delete process.env.BREEZY_PLANT;
  }
});

test("a plant set in the page's global wins over the environment", () => {
  process.env.BREEZY_PLANT = "x";
  globalThis.__breezyPlant = "y";
  try {
    assert.equal(planted("y"), true);
    assert.equal(planted("x"), false);
  } finally {
    delete process.env.BREEZY_PLANT;
    delete globalThis.__breezyPlant;
  }
});
