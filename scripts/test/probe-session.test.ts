// The probe session's pushes of its results: one rejected once ended the session, its iPhone and the probes still to come.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const yaml = readFileSync(fileURLToPath(new URL("../../.github/workflows/probe-session.yaml", import.meta.url)), "utf8");
const publish = /^\s*(publish\(\) \{.*\})$/m.exec(yaml)![1]!;

/** Runs the workflow's own publish as its step does, with pushes refused `refused` times; waits take no time. */
function run(refused: number) {
  const dir = mkdtempSync(join(tmpdir(), "probe-session-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(join(dir, "res/results"), { recursive: true });
    mkdirSync(bin);
    writeFileSync(join(dir, "pushes"), "");
    writeFileSync(join(bin, "git"), `#!/bin/bash\ncase " $* " in *" push "*) echo x >> "${dir}/pushes"; [ "$(wc -l < "${dir}/pushes")" -gt ${refused === Infinity ? 999 : refused} ];; esac\n`);
    writeFileSync(join(bin, "sleep"), "#!/bin/bash\n");
    chmodSync(join(bin, "git"), 0o755);
    chmodSync(join(bin, "sleep"), 0o755);
    writeFileSync(join(dir, "out"), "result");
    const r = spawnSync("bash", ["-e", "-o", "pipefail", "-c", `res="${dir}/res"; ${publish}; publish "${dir}/out" name; echo still here`], {
      encoding: "utf8", timeout: 10_000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    return { status: r.status, stdout: r.stdout, pushes: readFileSync(join(dir, "pushes"), "utf8").split("\n").length - 1 };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a refused push of a result is tried again", () => {
  const r = run(1);
  assert.equal(r.status, 0);
  assert.equal(r.pushes, 2);
  assert.doesNotMatch(r.stdout, /::warning::/);
});

test("the session outlives a result it cannot push, and says so", () => {
  const r = run(Infinity);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /::warning::.*name/);
  assert.match(r.stdout, /still here/);
});

test("the session notes the probe it has seen before saying it is ready, so a probe sent on ready is not taken for an old one", () => {
  assert.ok(yaml.indexOf("last=$(git ls-remote") < yaml.indexOf('publish "$RUNNER_TEMP/ready.txt"'));
});
