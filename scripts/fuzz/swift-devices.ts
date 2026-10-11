// Swift devices in breezy-sim, a child process speaking one JSON object per line: a command each way, answered once
// its devices are idle.
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { Command, Reply } from "./hub.ts";

const pkg = fileURLToPath(new URL("../../BreezyKit/", import.meta.url));
export const BINARY = `${pkg}.build/debug/breezy-sim`;

export class SwiftDevices {
  declare child: ChildProcessByStdio<Writable, Readable, Readable>;
  declare waiting: Map<number, { resolve: (r: Reply) => void; reject: (e: Error) => void }>;
  declare id: number;
  declare stderr: string;

  static async start(binary = BINARY) {
    if (!existsSync(binary)) throw new Error(`${binary} is missing: swift build --package-path BreezyKit --product breezy-sim`);
    const s = new SwiftDevices();
    s.child = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
    s.waiting = new Map();
    s.id = 0;
    s.stderr = "";
    s.child.stderr.on("data", (d: Buffer) => (s.stderr = (s.stderr + d).slice(-20_000)));
    s.child.on("exit", (code: number | null) => {
      for (const { reject } of s.waiting.values()) reject(new Error(`breezy-sim exited (${code}): ${s.stderr}`));
      s.waiting.clear();
    });
    createInterface({ input: s.child.stdout }).on("line", (line) => {
      let m: Reply & { re: number };
      try {
        m = JSON.parse(line);
      } catch {
        return;
      }
      const w = s.waiting.get(m.re);
      if (!w) return;
      s.waiting.delete(m.re);
      w.resolve(m);
    });
    return s;
  }

  command(c: Command) {
    const id = ++this.id;
    return new Promise<Reply>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ ...c, id })}\n`);
    });
  }

  /** Ends the input, after which breezy-sim removes its devices' files and exits; one that hangs is killed. */
  stop() {
    this.child.stdin.end();
    const t = setTimeout(() => this.child.kill(), 5000);
    this.child.once("exit", () => clearTimeout(t));
  }
}
