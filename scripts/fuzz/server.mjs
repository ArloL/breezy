// server/sync.php on PHP's built-in server with a throwaway SQLite database, one per run, as server/test.sh runs it.
import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("../../server/", import.meta.url));

const freePort = () =>
  new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const reachable = (port) =>
  new Promise((resolve) => {
    const c = connect(port, "127.0.0.1", () => (c.end(), resolve(true)));
    c.on("error", () => resolve(false));
  });

export class Server {
  /** Starts PHP; `relay` is the address sync.php names. */
  static async start(relay) {
    const s = new Server();
    s.tmp = mkdtempSync(`${tmpdir()}/breezy-fuzz-`);
    s.db = `${s.tmp}/test.db`;
    const db = new DatabaseSync(s.db);
    db.exec(readFileSync(`${dir}schema.sql`, "utf8"));
    db.close();
    writeFileSync(`${s.tmp}/config.php`, `<?php return ['dsn' => 'sqlite:${s.db}', 'relay' => '${relay}'];`);
    s.port = await freePort();
    s.php = spawn("php", ["-d", "memory_limit=64M", "-S", `127.0.0.1:${s.port}`, "-t", dir], {
      env: { ...process.env, BREEZY_CONFIG: `${s.tmp}/config.php` }, stdio: ["ignore", "ignore", "pipe"],
    });
    s.log = "";
    s.php.stderr.on("data", (d) => (s.log = (s.log + d).slice(-20_000)));
    for (let i = 0; !(await reachable(s.port)); i++) {
      if (i > 200) throw new Error(`php -S did not start: ${s.log}`);
      await new Promise((r) => setTimeout(r, 10));
    }
    s.url = `http://127.0.0.1:${s.port}/sync.php`;
    return s;
  }

  /** A device's request as sent: path and query from `url`, headers, and a body (Buffer) or null. */
  send({ method, url, headers, body }) {
    const u = new URL(url);
    return new Promise((resolve, reject) => {
      const r = request({ host: "127.0.0.1", port: this.port, method, path: u.pathname + u.search, headers: { ...headers, connection: "close" } }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on("error", reject);
      });
      r.on("error", reject);
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
