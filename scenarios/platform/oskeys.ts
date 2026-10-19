// tools/oskeys from the scenarios: real macOS input, and its echo app, a text view that reports what reached it.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

const root = new URL("../..", import.meta.url).pathname;
const bin = (name: string) => join(root, "tools/oskeys/.build/release", name);
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function buildOskeys() {
  execFileSync("swift", ["build", "--package-path", join(root, "tools/oskeys"), "--configuration", "release"], { stdio: ["ignore", "ignore", "inherit"] });
}

/** Runs oskeys; input commands refuse unless process `front`, when given, is frontmost. */
export function oskeys(args: string[], front?: number): string {
  return execFileSync(bin("oskeys"), args, { encoding: "utf8", env: { ...process.env, ...front ? { OSKEYS_PID: String(front) } : {} } }).trim();
}

export function trusted() {
  try {
    oskeys(["trusted"]);
    return true;
  } catch {
    return false;
  }
}

/** Puts input source `id` back when the run ends, also on ⌃C. */
export function restoreSourceOnExit(id: string) {
  const restore = () => {
    try {
      oskeys(["source", id]);
    } catch {}
  };
  process.once("exit", restore);
  process.once("SIGINT", () => {
    restore();
    process.exit(130);
  });
}

export type EchoLine = { call?: string; text?: string; selector?: string; string: string; marked: boolean; ready?: number };

export class Echo {
  readonly lines: EchoLine[] = [];
  pid = 0;
  private readonly child: ChildProcess;

  private constructor(child: ChildProcess) {
    this.child = child;
  }

  /** With input source `source`: an app that is frontmost as the source changes takes it only once it comes to the
   * front again. */
  static async start(source?: string): Promise<Echo> {
    const e = new Echo(spawn(bin("oskeys-echo"), [], { stdio: ["pipe", "pipe", "inherit"] }));
    let buffer = "";
    e.child.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
      buffer += chunk;
      for (let nl; (nl = buffer.indexOf("\n")) >= 0; buffer = buffer.slice(nl + 1)) e.lines.push(JSON.parse(buffer.slice(0, nl)));
    });
    e.pid = (await e.until("the echo app", (l) => l.ready !== undefined)).ready!;
    oskeys(["activate", String(e.pid)]);
    if (source) {
      oskeys(["source", source]);
      oskeys(["away", String(e.pid)]);
    }
    return e;
  }

  async until(what: string, test: (l: EchoLine) => boolean, ms = 5000): Promise<EchoLine> {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) {
      const l = this.lines.find(test);
      if (l) return l;
    }
    throw new Error(`no ${what} in ${ms} ms; the echo app saw ${JSON.stringify(this.lines)}`);
  }

  stop() {
    this.child.stdin!.end();
  }
}
