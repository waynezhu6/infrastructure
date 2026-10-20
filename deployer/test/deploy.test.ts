import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config.js";
import { createRunner } from "../src/deploy.js";
import type { Exec } from "../src/exec.js";
import { Deployer, Store, type Job } from "../src/jobs.js";

const digest = `sha256:${"a".repeat(64)}`;

function setup(opts: { previous?: string; running?: string; healthy?: (call: number) => boolean }) {
  const infraDir = mkdtempSync(join(tmpdir(), "infra-"));
  const dataDir = mkdtempSync(join(tmpdir(), "data-"));
  mkdirSync(join(infraDir, "secrets"));
  writeFileSync(join(infraDir, "secrets", "reader.env"), "DATABASE_URL=postgres://x\nREADER_KEY=k");
  mkdirSync(join(infraDir, "sites", "reader"), { recursive: true });
  writeFileSync(join(infraDir, "sites", "reader", "index.html"), "old");

  const config = { owner: "WayneZhu6", registry: "ghcr.io", infraDir, dataDir, composeFile: "/app/app.compose.yml", healthTimeoutMs: 50 } as Config;
  const calls: { args: string[]; env?: NodeJS.ProcessEnv }[] = [];
  const exec: Exec = async (cmd, args, o) => {
    if (cmd !== "docker") return { code: 0, stdout: "" };
    calls.push({ args, env: o?.env });
    const [a, b] = args;
    if (a === "image" && b === "inspect") return opts.previous ? { code: 0, stdout: opts.previous } : { code: 1, stdout: "" };
    if (a === "container" && b === "inspect") return opts.running ? { code: 0, stdout: opts.running } : { code: 1, stdout: "" };
    if (a === "cp") {
      mkdirSync(args[2]);
      writeFileSync(join(args[2], "index.html"), "new");
    }
    return { code: 0, stdout: "" };
  };
  let healthCalls = 0;
  const fetchFake = (async () => ({ ok: (opts.healthy ?? (() => true))(healthCalls++), status: 200 })) as unknown as typeof fetch;

  const store = new Store(dataDir);
  const deployer = new Deployer(createRunner({ config, store, exec, fetch: fetchFake, sleep: async () => {} }), store);
  const run = (): Promise<Job> =>
    new Promise((resolve) => {
      const job = deployer.submit({ app: "reader", digest, repository: "waynezhu6/reader", sha: "abcdef0", runId: "1" });
      job.once("done", () => resolve(job));
    });
  const docker = () => calls.map((c) => c.args.slice(0, 2).join(" "));
  return { infraDir, dataDir, calls, docker, run, store };
}

test("a healthy deploy switches the frontend and records the image", async () => {
  const { infraDir, dataDir, calls, run, store } = setup({ previous: "sha256:prev" });
  const job = await run();
  assert.equal(job.status, "succeeded", job.lines.join("\n"));

  const image = `ghcr.io/waynezhu6/reader-backend@${digest}`;
  assert.deepEqual(calls[0].args, ["pull", "--quiet", image]);
  const up = calls.find((c) => c.args[0] === "compose")!;
  assert.deepEqual(up.args.slice(0, 5), ["compose", "--project-name", "reader", "--file", "/app/app.compose.yml"]);
  assert.equal(up.env?.IMAGE, image);
  assert.equal(up.env?.APP, "reader");

  assert.equal(readFileSync(join(infraDir, "sites", "reader", "index.html"), "utf8"), "new");
  assert.deepEqual(readdirSync(join(infraDir, "sites")), ["reader"]);
  assert.equal(readFileSync(join(dataDir, "apps", "reader", "app.env"), "utf8"), "NODE_ENV=production\nPORT=3001\nDATABASE_URL=postgres://x\nREADER_KEY=k\n");
  assert.equal(store.current("reader"), digest);
  assert.ok(calls.some((c) => c.args.join(" ") === "tag local/reader-backend:current local/reader-backend:previous"));
  assert.ok(calls.some((c) => c.args.join(" ") === `tag ${image} local/reader-backend:current`));
});

test("an unhealthy deploy rolls back and leaves the frontend alone", async () => {
  // Unhealthy until the rollback has started.
  let rolledBack = false;
  const { infraDir, calls, run, store } = setup({ previous: "sha256:prev", healthy: () => rolledBack });
  const origPush = calls.push.bind(calls);
  calls.push = (...items) => {
    if (items[0].env?.IMAGE === "local/reader-backend:current") rolledBack = true;
    return origPush(...items);
  };
  const job = await run();

  assert.equal(job.status, "failed");
  assert.ok(job.lines.some((l) => /Previous image is back up/.test(l)), job.lines.join("\n"));
  assert.ok(job.lines.some((l) => /health check failed/.test(l)));
  assert.equal(readFileSync(join(infraDir, "sites", "reader", "index.html"), "utf8"), "old");
  assert.deepEqual(readdirSync(join(infraDir, "sites")), ["reader"]);
  assert.equal(store.current("reader"), undefined);
  assert.ok(!calls.some((c) => c.args[0] === "tag" && c.args[2] === "local/reader-backend:current"));
});

test("the first deploy adopts the container already running as its rollback target", async () => {
  const { calls, run } = setup({ running: "sha256:running" });
  const job = await run();
  assert.equal(job.status, "succeeded", job.lines.join("\n"));
  assert.deepEqual(calls.find((c) => c.args[0] === "tag")!.args, ["tag", "sha256:running", "local/reader-backend:current"]);
});

test("with nothing to roll back to, a failure just reports", async () => {
  const { calls, run } = setup({ healthy: () => false });
  const job = await run();
  assert.equal(job.status, "failed");
  assert.equal(calls.filter((c) => c.args[0] === "compose").length, 1);
});

test("an app without secrets fails before touching anything", async () => {
  const { infraDir, calls, run } = setup({});
  const { rmSync } = await import("node:fs");
  rmSync(join(infraDir, "secrets", "reader.env"));
  const job = await run();
  assert.equal(job.status, "failed");
  assert.match(job.lines.join("\n"), /no secrets\/reader.env/);
  assert.equal(calls.length, 0);
  assert.ok(existsSync(join(infraDir, "sites", "reader")));
});
