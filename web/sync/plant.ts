// Bugs planted to show a level finds them, each named in TESTING.md's matrix: the fuzzer's by scripts/fuzz.ts --plant NAME.
declare global {
  var __breezyPlant: string | undefined;
}

export const planted = (name: string): boolean => globalThis.__breezyPlant === name;
