// Bugs the convergence fuzzer plants to show it finds them (scripts/fuzz.ts --plant NAME); nothing else sets this.
declare global {
  var __breezyPlant: string | undefined;
}

export const planted = (name: string): boolean => globalThis.__breezyPlant === name;
