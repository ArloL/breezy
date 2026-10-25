// Reads an iPhone's page for the scenarios where safaridriver cannot: on this Mac it finds no session in the
// simulator at all, and nowhere does it reach the app added to the Home Screen. The scenarios' server puts a script in
// each page it serves an iPhone; the script asks the server for a function to run, runs it, and posts what it gave.
import { execFileSync } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";

/** How long a poll waits for a function before the page asks again. */
const POLL_MS = 10_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs in the page: asks for the next function, runs it with its argument, and posts its value or its error. */
function pageAgent() {
  const page = Math.random().toString(36).slice(2);
  const loop = async () => {
    for (;;) {
      try {
        const r = await fetch(`/agent/next?page=${page}`, { cache: "no-store" });
        if (r.status !== 200) continue;
        const { seq, src, arg } = await r.json();
        let out;
        try {
          out = { seq, value: (await (0, eval)(`(${src})`)(arg)) ?? null };
        } catch (e) {
          out = { seq, error: String(e instanceof Error ? e.stack ?? e.message : e) };
        }
        await fetch("/agent/result", { method: "POST", body: JSON.stringify(out) });
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  };
  loop();
}

/** What the server adds to each page it serves an iPhone. */
export const AGENT_SCRIPT = `<script>(${pageAgent.toString()})()</script>`;

/** Whether a request comes from an iPhone, whose pages get the agent. */
export const fromIphone = (req: IncomingMessage) => /iPhone/.test(req.headers["user-agent"] ?? "");

interface Job {
  seq: number;
  src: string;
  arg: unknown;
  resolve(v: unknown): void;
  reject(e: Error): void;
}

/** The server's side: functions waiting for the page, and the page's polls waiting for functions. */
export class Agent {
  /** The page last heard from; a function goes to it alone. */
  current = "";
  readonly page: AgentPage;
  private seq = 0;
  private readonly queue: Job[] = [];
  private readonly sent = new Map<number, Job>();
  private polls: { page: string; res: ServerResponse; timer: ReturnType<typeof setTimeout> }[] = [];

  constructor() {
    this.page = new AgentPage(this);
  }

  /** Answers the agent's requests; false for any other. */
  handle(req: IncomingMessage, res: ServerResponse): boolean {
    const u = new URL(req.url!, "http://x");
    if (u.pathname === "/agent/next") {
      this.current = u.searchParams.get("page") ?? "";
      const timer = setTimeout(() => this.drop(res), POLL_MS);
      this.polls.push({ page: this.current, res, timer });
      this.flush();
      return true;
    }
    if (u.pathname === "/agent/result") {
      let body = "";
      req.on("data", (d: Buffer) => (body += d.toString()));
      req.on("end", () => {
        res.writeHead(204).end();
        const { seq, value, error } = JSON.parse(body) as { seq: number; value?: unknown; error?: string };
        const job = this.sent.get(seq);
        this.sent.delete(seq);
        if (error !== undefined) job?.reject(new Error(`in the iPhone's page: ${error}`));
        else job?.resolve(value);
      });
      return true;
    }
    return false;
  }

  /** `src`, a function's source, run in the page with `arg`; what it gives, or its error. */
  run(src: string, arg: unknown, ms = 15_000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const job: Job = { seq: ++this.seq, src, arg, resolve, reject };
      const timer = setTimeout(() => {
        this.queue.splice(this.queue.indexOf(job), 1);
        this.sent.delete(job.seq);
        reject(new Error(`the iPhone's page did not answer in ${ms / 1000} s${this.current ? "" : ": no page has asked yet"}`));
      }, ms);
      job.resolve = (v) => (clearTimeout(timer), resolve(v));
      job.reject = (e) => (clearTimeout(timer), reject(e));
      this.queue.push(job);
      this.flush();
    });
  }

  stop() {
    for (const p of this.polls) this.drop(p.res);
    for (const j of [...this.queue, ...this.sent.values()]) j.reject(new Error("the agent stopped"));
    this.queue.length = 0;
    this.sent.clear();
  }

  /** Takes `res` off the polls waiting. */
  private take(res: ServerResponse) {
    for (const p of this.polls) if (p.res === res) clearTimeout(p.timer);
    this.polls = this.polls.filter((p) => p.res !== res);
  }

  /** Answers poll `res` with nothing to run. */
  private drop(res: ServerResponse) {
    this.take(res);
    if (!res.headersSent) res.writeHead(204).end();
  }

  private flush() {
    // a page navigated away from polls no more; its open poll is dropped
    for (const p of this.polls.filter((p) => p.page !== this.current)) this.drop(p.res);
    while (this.queue.length && this.polls.length) {
      const { res } = this.polls[0]!, job = this.queue.shift()!;
      this.take(res);
      this.sent.set(job.seq, job);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ seq: job.seq, src: job.src, arg: job.arg }));
    }
  }
}

/** The iPhone's page, with what the scenarios ask of a Playwright Page. */
export class AgentPage {
  private readonly agent: Agent;

  constructor(agent: Agent) {
    this.agent = agent;
  }

  /** `f` run in the page with `arg`, its promise awaited, as Playwright's evaluate. */
  async evaluate<R, A>(f: (arg: A) => R | Promise<R>, arg?: A): Promise<R> {
    return (await this.agent.run(f.toString(), arg ?? null)) as R;
  }

  /** Loads `url` in the page, once a page asks; until the new one asks. */
  async goto(url: string) {
    await this.connected();
    const was = this.agent.current;
    await this.evaluate((u: string) => void setTimeout(() => location.assign(u), 50), url);
    for (const end = Date.now() + 30_000; this.agent.current === was; await sleep(50)) {
      if (Date.now() > end) throw new Error(`the iPhone's page did not load ${url} in 30 s`);
    }
  }

  /** Until a page has asked for a function. */
  async connected(ms = 60_000) {
    for (const end = Date.now() + ms; !this.agent.current; await sleep(100)) {
      if (Date.now() > end) throw new Error(`no iPhone page asked the agent in ${ms / 1000} s`);
    }
  }

  async waitForSelector(selector: string, { timeout = 30_000 }: { timeout?: number } = {}) {
    await this.waitForFunction((s: string) => !!document.querySelector(s), selector, { timeout });
  }

  async waitForFunction<A>(f: (arg: A) => unknown, arg?: A, { timeout = 30_000 }: { timeout?: number } = {}) {
    for (const end = Date.now() + timeout; ; await sleep(100)) {
      if (await this.evaluate(f, arg)) return;
      if (Date.now() > end) throw new Error("timed out waiting for a function in the iPhone's page");
    }
  }

  async fill(selector: string, value: string) {
    await this.evaluate(([s, v]: readonly [string, string]) => {
      const e = document.querySelector<HTMLInputElement>(s)!;
      e.value = v;
      e.dispatchEvent(new Event("input", { bubbles: true }));
    }, [selector, value] as const);
  }

  /** The simulator's screen as a PNG. */
  async screenshot(): Promise<Buffer> {
    return execFileSync("xcrun", ["simctl", "io", "booted", "screenshot", "--type=png", "-"], { timeout: 30_000, maxBuffer: 64 << 20 });
  }

  async close() {}
}
