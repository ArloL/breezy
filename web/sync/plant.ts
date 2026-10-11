// Bugs the convergence fuzzer plants to show it finds them (scripts/fuzz.mjs --plant NAME); nothing else sets this.
export const planted = (name) => globalThis.__breezyPlant === name;
