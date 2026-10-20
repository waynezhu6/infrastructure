import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deployer, Store, type Job } from "../src/jobs.js";

const digest = (n: number) => `sha256:${String(n).repeat(64).slice(0, 64)}`;
const req = (app: string, n: number) => ({ app, digest: digest(n), repository: `waynezhu6/${app}`, sha: "abc", runId: "1" });

// A runner whose deploys finish only when the test says so.
function setup() {
  const store = new Store(mkdtempSync(join(tmpdir(), "deployer-")));
  const started: Job[] = [];
  const finishers = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();
  const deployer = new Deployer(
    (job) =>
      new Promise<void>((resolve, reject) => {
        started.push(job);
        finishers.set(job.id, { resolve, reject });
      }),
    store,
  );
  const finish = async (job: Job, ok = true) => {
    const f = finishers.get(job.id)!;
    if (ok) f.resolve();
    else f.reject(new Error("boom"));
    await new Promise((r) => setImmediate(r));
  };
  return { store, deployer, started, finish };
}

test("runs one deploy per app at a time, in order", async () => {
  const { deployer, started, finish } = setup();
  const a = deployer.submit(req("reader", 1));
  const b = deployer.submit(req("reader", 2));
  assert.equal(a.status, "running");
  assert.equal(b.status, "queued");
  assert.deepEqual(started, [a]);

  await finish(a);
  assert.equal(a.status, "succeeded");
  assert.equal(b.status, "running");
  assert.deepEqual(started, [a, b]);
});

test("different apps deploy in parallel", () => {
  const { deployer, started } = setup();
  deployer.submit(req("reader", 1));
  deployer.submit(req("notes", 1));
  assert.equal(started.length, 2);
});

test("a newer request replaces the one waiting, which is reported superseded", async () => {
  const { deployer, started, finish } = setup();
  const a = deployer.submit(req("reader", 1));
  const b = deployer.submit(req("reader", 2));
  const c = deployer.submit(req("reader", 3));
  assert.equal(b.status, "superseded");
  assert.match(b.lines.at(-1)!, new RegExp(c.id));

  await finish(a);
  assert.deepEqual(started, [a, c]);
});

test("a repeat call for an image already deploying or waiting joins that deploy", () => {
  const { deployer } = setup();
  const a = deployer.submit(req("reader", 1));
  const b = deployer.submit(req("reader", 2));
  assert.equal(deployer.submit(req("reader", 1)), a);
  assert.equal(deployer.submit(req("reader", 2)), b);
});

test("a repeat call for the image already live is a no-op", () => {
  const { deployer, store, started } = setup();
  store.setCurrent("reader", digest(1), "old");
  const job = deployer.submit(req("reader", 1));
  assert.equal(job.status, "succeeded");
  assert.match(job.lines[0], /already running/);
  assert.equal(started.length, 0);
});

test("a failed deploy is reported and the next one still runs", async () => {
  const { deployer, finish } = setup();
  const a = deployer.submit(req("reader", 1));
  const b = deployer.submit(req("reader", 2));
  await finish(a, false);
  assert.equal(a.status, "failed");
  assert.match(a.lines.at(-1)!, /boom/);
  assert.equal(b.status, "running");
});

test("logs go to a file per deploy", async () => {
  const { deployer, store } = setup();
  const job = deployer.submit(req("reader", 1));
  job.log("hello");
  const file = store.logFile("reader", job.id);
  assert.match(readFileSync(file, "utf8"), /hello\n$/);
});

test("idle waits for running and waiting deploys", async () => {
  const { deployer, finish } = setup();
  const a = deployer.submit(req("reader", 1));
  const b = deployer.submit(req("reader", 2));
  let idle = false;
  const done = deployer.idle().then(() => (idle = true));
  await finish(a);
  assert.equal(idle, false);
  await finish(b);
  await done;
  assert.equal(idle, true);
});
