// server/sync.php on PHP's built-in server with a throwaway SQLite database, one per run, as server/test.sh runs it.
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request, type IncomingHttpHeaders, type OutgoingHttpHeaders } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import type { Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("../../server/", import.meta.url));

export const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });

export interface Request {
  method: string;
  url: string;
  headers: OutgoingHttpHeaders;
  body: Buffer | null;
}

export interface Answer {
  status: number | undefined;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

export class Server {
  declare tmp: string;
  declare db: string;
  declare port: number;
  declare php: ChildProcessByStdio<null, null, Readable>;
  declare log: string;
  declare url: string;

  /** Starts PHP; `relay` is the address sync.php names. */
  static async start(relay: string, port = freePort) {
    const s = new Server();
    s.tmp = mkdtempSync(`${tmpdir()}/breezy-fuzz-`);
    s.db = `${s.tmp}/test.db`;
    const db = new DatabaseSync(s.db);
    db.exec(readFileSync(`${dir}schema.sql`, "utf8"));
    db.close();
    const config = `${s.tmp}/config.php`;
    writeFileSync(config, `<?php return ['dsn' => 'sqlite:${s.db}', 'relay' => '${relay}'];`);
    s.log = "";
    // a port found free can go to another test file's PHP first; this one then exits and the other answers in its place
    for (let tries = 1; !(await s.listen(await port(), config)); tries++) {
      if (tries === 5) {
        s.stop();
        throw new Error(`php -S did not start: ${s.log}`);
      }
    }
    s.url = `http://127.0.0.1:${s.port}/sync.php`;
    return s;
  }

  /** Whether this PHP says it took `port`, which a connection cannot tell: whichever PHP holds it would answer. */
  private listen(port: number, config: string) {
    this.port = port;
    this.php = spawn("php", ["-d", "memory_limit=64M", "-S", `127.0.0.1:${port}`, "-t", dir], {
      env: { ...process.env, BREEZY_CONFIG: config }, stdio: ["ignore", "ignore", "pipe"],
    });
    return new Promise<boolean>((resolve) => {
      const done = (up: boolean) => {
        clearTimeout(deadline);
        if (!up) this.php.kill();
        resolve(up);
      };
      const deadline = setTimeout(() => done(false), 10_000);
      this.php.stderr.on("data", (d: Buffer) => {
        this.log = (this.log + d).slice(-20_000);
        if (this.log.includes(`(http://127.0.0.1:${port}) started`)) done(true);
      });
      this.php.once("exit", () => done(false));
    });
  }

  /** How PHP stands, for a request it did not take. */
  private state() {
    const { exitCode, signalCode } = this.php;
    return exitCode !== null ? `ended with ${exitCode}` : signalCode ? `ended by ${signalCode}` : "still running";
  }

  /** A device's request as sent: path and query from `url`, headers, and a body (Buffer) or null. */
  send({ method, url, headers, body }: Request) {
    const u = new URL(url);
    return new Promise<Answer>((resolve, reject) => {
      const r = request({ host: "127.0.0.1", port: this.port, method, path: u.pathname + u.search, headers: { ...headers, connection: "close" } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on("error", reject);
      });
      r.on("error", (e) => reject(new Error(`${e.message}; php ${this.state()}; its log ends:\n${this.log.slice(-2000)}`, { cause: e })));
      r.end(body ?? undefined);
    });
  }

  backup() {
    copyFileSync(this.db, `${this.db}.backup`);
  }

  /** The backup back in place, with a new epoch for every space, as the README says to do after a restore. */
  restore() {
    copyFileSync(`${this.db}.backup`, this.db);
    const db = new DatabaseSync(this.db);
    db.exec("UPDATE spaces SET epoch = randomblob(16)");
    db.close();
  }

  stop() {
    this.php.kill();
    rmSync(this.tmp, { recursive: true, force: true });
  }
}
