import "./vendor/motion.js";

/** The subset of Motion's API this app uses. */
export interface Transition {
  type?: string;
  duration?: number;
  visualDuration?: number;
  bounce?: number;
  stiffness?: number;
  damping?: number;
  mass?: number;
  velocity?: number;
  delay?: number;
  ease?: string | number[];
}

export interface ValueTransition<V> extends Transition {
  onUpdate?: (latest: V) => void;
  onComplete?: () => void;
}

export interface AnimationPlaybackControls {
  time: number;
  speed: number;
  readonly duration: number;
  stop(): void;
  cancel(): void;
  complete(): void;
  play(): void;
  pause(): void;
  then(onResolve: () => void, onReject?: () => void): Promise<void>;
}

export interface MotionValue<V = number> {
  get(): V;
  set(v: V): void;
  jump(v: V): void;
  stop(): void;
  getVelocity(): number;
  isAnimating(): boolean;
  on(event: "change", callback: (latest: V) => void): () => void;
  destroy(): void;
}

/** CSS properties or transforms to animate to, or through a list of keyframes. */
export type DOMKeyframes = Record<string, string | number | (string | number | null)[]>;

export interface FrameData {
  delta: number;
  timestamp: number;
  isProcessing: boolean;
}

export type FrameProcess = (data: FrameData) => void;
type Schedule = (process: FrameProcess, keepAlive?: boolean, immediate?: boolean) => FrameProcess;
type Step = "setup" | "read" | "resolveKeyframes" | "preUpdate" | "update" | "preRender" | "render" | "postRender";

interface SpringGenerator {
  calculatedDuration: number | null;
  next(t: number): { value: number; done: boolean };
}

interface MotionAPI {
  animate(from: number, to: number | number[], options?: ValueTransition<number>): AnimationPlaybackControls;
  animate<V extends number | string>(value: MotionValue<V>, to: V | V[], options?: ValueTransition<V>): AnimationPlaybackControls;
  animate(target: Element | string | ArrayLike<Element>, keyframes: DOMKeyframes, options?: Transition): AnimationPlaybackControls;
  spring(options?: Transition & { keyframes?: number[] }): SpringGenerator;
  motionValue<V>(init: V): MotionValue<V>;
  frame: Record<Step, Schedule>;
  cancelFrame(process: FrameProcess): void;
}

declare global {
  var Motion: MotionAPI;
}

/** Motion 14 (motion.dev), vendored as its standalone bundle, which puts itself on globalThis. */
export const { animate, spring, motionValue, frame, cancelFrame } = globalThis.Motion;
