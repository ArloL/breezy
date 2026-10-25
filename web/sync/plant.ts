// Bugs planted to show a level finds them, each named in TESTING.md's matrix: the fuzzer's by scripts/fuzz.ts --plant NAME.
declare global {
  var __breezyPlant: string | undefined;
}

/** Whether bug `name` is planted: by the page's global, or else, in Node, by BREEZY_PLANT, so that any test run takes one. */
export const planted = (name: string): boolean =>
  (globalThis.__breezyPlant ?? (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.BREEZY_PLANT) === name;
