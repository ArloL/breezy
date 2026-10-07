import "./vendor/motion.js";

/** Motion 14 (motion.dev), vendored as its standalone bundle, which puts itself on globalThis. */
export const { animate, spring, motionValue, frame, cancelFrame } = globalThis.Motion;
