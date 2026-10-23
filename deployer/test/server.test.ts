import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { AuthError, type Caller } from "../src/auth.js";
import { Deployer, Store, type Job } from "../src/jobs.js";
import { createApp } from "../src/server.js";

const infraDir = mkdtempSync(join(tmpdir(), "infra-"));
mkdirSync(join(infraDir, "apps"));
writeFileSync(join(infraDir, "apps", "reader.caddy"), "");
writeFileSync(join(infraDir, "apps", "notes.caddy"), "");

// Tokens are "app:jti"; the real verifier is tested in auth.test.ts.
const verify = async (header: string | undefined): Promise<Caller> => {
  const m = header?.match(/^Bearer (\w+):(\w+)$/);
  if (!m) throw new AuthError("bad token", 401);
  return { app: m[1], repository: `waynezhu6/${m[1]}`, sha: "abc", runId: "1", jti: m[2], exp: Date.now() / 1000 + 300 };
};

let release: (ok: boolean) => void = () => {};
const runner = async (job: Job) => {
  job.log("pulling");
  const ok = await new Promise<boolean>((r) => (release = r));
  job.log("started");
  if (!ok) throw new Error("unhealthy");
};
const deployer = new Deployer(runner, new Store(mkdtempSync(join(tmpdir(), "data-"))));
const server = createApp({ verify, deployer, infraDir }).listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => server.close());

const digest = (c: string) => `sha256:${c.repeat(64)}`;
let n = 0;
const post = (app: string, body: unknown) =>
  fetch(`${base}/deploy`, { method: "POST", headers: { Authorization: `Bearer ${app}:t${n++}` }, body: JSON.stringify(body) });

test("streams the deploy and ends with the verdict", async () => {
  const res = await post("reader", { digest: digest("a") });
  assert.equal(res.status, 200);
  const id = res.headers.get("x-deploy-id")!;
  const reader = res.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /pulling/);
  release(true);
  let rest = "";
  for (let r = await reader.read(); !r.done; r = await reader.read()) rest += new TextDecoder().decode(r.value);
  assert.equal(rest, `started\n==> deploy ${id} succeeded\n`);
});

test("a failed deploy ends with a failed verdict", async () => {
  const res = await post("reader", { digest: digest("b") });
  setTimeout(() => release(false), 10);
  const text = await res.text();
  assert.match(text, /Deploy failed: unhealthy\n==> deploy \w+ failed\n$/);
});

test("rejects bad bodies, unpublished apps, bad and reused tokens", async () => {
  assert.equal((await post("reader", { digest: "latest" })).status, 400);
  assert.equal((await post("reader", "nope")).status, 400);
  const unpublished = await post("ghost", { digest: digest("c") });
  assert.equal(unpublished.status, 404);
  assert.match((await unpublished.json()).error, /ghost is not published.*publish-app\.sh ghost/);
  assert.equal((await fetch(`${base}/deploy`, { method: "POST", body: "{}" })).status, 401);

  const headers = { Authorization: "Bearer notes:same" };
  const first = await fetch(`${base}/deploy/jobs/000000000000`, { headers });
  assert.equal(first.status, 404);
  const once = await fetch(`${base}/deploy`, { method: "POST", headers, body: JSON.stringify({ digest: "x" }) });
  assert.equal(once.status, 400);
  const again = await fetch(`${base}/deploy`, { method: "POST", headers, body: JSON.stringify({ digest: "x" }) });
  assert.equal(again.status, 401);
});

test("status of a deploy is visible to its own app only, from a given line", async () => {
  const res = await post("notes", { digest: digest("d") });
  const id = res.headers.get("x-deploy-id")!;
  await res.body!.cancel();

  const mine = await fetch(`${base}/deploy/jobs/${id}?from=0`, { headers: { Authorization: "Bearer notes:s1" } });
  const body = await mine.json();
  assert.equal(body.status, "running");
  assert.deepEqual(body.lines, ["pulling"]);

  const theirs = await fetch(`${base}/deploy/jobs/${id}`, { headers: { Authorization: "Bearer reader:s2" } });
  assert.equal(theirs.status, 404);

  // The deploy carried on without the client.
  release(true);
  await new Promise((r) => setTimeout(r, 20));
  const later = await (await fetch(`${base}/deploy/jobs/${id}?from=1`, { headers: { Authorization: "Bearer notes:s3" } })).json();
  assert.equal(later.status, "succeeded");
  assert.deepEqual(later.lines, ["started"]);
});

test("passes env through and rejects server-owned or unsafe names and values", async () => {
  const bad = [
    { DATABASE_URL: "postgres://evil" },
    { lower: "x" },
    { KEY: "it's" },
    { KEY: "a\nB=c" },
    { KEY: 1 },
    ["KEY"],
  ];
  for (const env of bad) {
    const res = await post("notes", { digest: digest("e"), env });
    assert.equal(res.status, 400, JSON.stringify(env));
  }
  const res = await post("notes", { digest: digest("e"), env: { RAPIDAPI_KEY: "k" } });
  assert.equal(res.status, 200);
  assert.deepEqual(deployer.get(res.headers.get("x-deploy-id")!)!.req.env, { RAPIDAPI_KEY: "k" });
  await res.body!.cancel();
  release(true);
});

test("parses infra.yml and refuses a bad one before deploying", async () => {
  for (const manifest of ["postgress: true", "postgres: yes please", "[1, 2]", "a: [", 42]) {
    const res = await post("notes", { digest: digest("f"), manifest });
    assert.equal(res.status, 400, JSON.stringify(manifest));
    assert.match((await res.json()).error, /infra\.yml/);
  }
  const res = await post("notes", { digest: digest("f"), manifest: "# what notes needs\npostgres: true\n" });
  assert.equal(res.status, 200);
  assert.deepEqual(deployer.get(res.headers.get("x-deploy-id")!)!.req.manifest, { postgres: true });
  await res.body!.cancel();
  release(true);
});

test("healthz needs no token", async () => {
  assert.equal((await fetch(`${base}/deploy/healthz`)).status, 200);
});
