import { readFileSync } from "node:fs";

/** A file from BreezyKit/Tests/Fixtures, which the Swift tests read too. */
export const fixture = (name) => JSON.parse(readFileSync(new URL(`../../../BreezyKit/Tests/Fixtures/${name}`, import.meta.url), "utf8"));
