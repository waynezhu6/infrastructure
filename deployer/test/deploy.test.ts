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

function setup(opts: {
  previous?: string;
  // Backend containers already there: the deployer's (labelled), or one from
  // before blue-green deploys, called reader-backend.
  labelled?: string[];
  legacy?: boolean;
  healthy?: (call: number) => boolean;
  env?: Record<string, string>;
  fail?: (args: string[]) => boolean;
}) {
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
    if (opts.fail?.(args)) return { code: 1, stdout: "" };
    const [a, b] = args;
    if (a === "ps") return { code: 0, stdout: (opts.labelled ?? []).map((n) => `${n}\n`).join("") };
    if (a === "image" && b === "inspect") return opts.previous ? { code: 0, stdout: opts.previous } : { code: 1, stdout: "" };
    if (a === "container" && b === "inspect") {
      const name = args.at(-1)!;
      const exists = (opts.legacy && name === "reader-backend") || opts.labelled?.includes(name);
      return exists ? { code: 0, stdout: args[3] === "{{.Image}}" ? `sha256:image-of-${name}` : `/${name}` } : { code: 1, stdout: "" };
    }
    if (a === "cp") {
      mkdirSync(args[2]);
      writeFileSync(join(args[2], "index.html"), "new");
    }
    return { code: 0, stdout: "" };
  };
  let healthCalls = 0;
  const health: string[] = [];
  const fetchFake = (async (url: string) => {
    health.push(url);
    return { ok: (opts.healthy ?? (() => true))(healthCalls++), status: 200 };
  }) as unknown as typeof fetch;

  const store = new Store(dataDir);
  const deployer = new Deployer(createRunner({ config, store, exec, fetch: fetchFake, sleep: async () => {} }), store);
  const run = (): Promise<Job> =>
    new Promise((resolve) => {
      const job = deployer.submit({ app: "reader", digest, repository: "waynezhu6/reader", sha: "abcdef0", runId: "1", env: opts.env ?? {} });
      job.once("done", () => resolve(job));
    });
  const docker = () => calls.map((c) => c.args.join(" "));
  // The order of the calls matching each pattern, so tests can check one came before another.
  const index = (pattern: RegExp) => docker().findIndex((c) => pattern.test(c));
  return { infraDir, dataDir, calls, docker, index, health, run, store };
}

test("a healthy deploy starts a new container, routes to it, then retires the old one", async () => {
  const { infraDir, dataDir, calls, docker, index, health, run, store } = setup({ previous: "sha256:prev", labelled: ["reader-backend-0123456789ab"] });
  const job = await run();
  assert.equal(job.status, "succeeded", job.lines.join("\n"));
  const container = `reader-backend-${job.id}`;

  const image = `ghcr.io/waynezhu6/reader-backend@${digest}`;
  assert.deepEqual(calls[0].args, ["pull", "--quiet", image]);
  assert.deepEqual(calls[1].args, ["ps", "--all", "--filter", "label=deployer.app=reader", "--format", "{{.Names}}"]);
  const up = calls.find((c) => c.args[0] === "compose")!;
  assert.deepEqual(up.args.slice(0, 5), ["compose", "--project-name", `reader-${job.id}`, "--file", "/app/app.compose.yml"]);
  assert.equal(up.env?.IMAGE, image);
  assert.equal(up.env?.APP, "reader");
  assert.equal(up.env?.CONTAINER, container);
  assert.deepEqual(health, [`http://${container}:3001/api/health`]);

  // The alias moves only once the new container is healthy, and the old one
  // stops only after that.
  const connect = index(new RegExp(`^network connect --alias reader-backend caddy-web ${container}$`));
  assert.ok(index(new RegExp(`^network disconnect caddy-web ${container}$`)) < connect);
  assert.ok(connect > index(/^compose /));
  assert.ok(index(/^stop --time 30 reader-backend-0123456789ab$/) > connect);
  assert.ok(index(/^rm reader-backend-0123456789ab$/) > index(/^stop /));
  assert.ok(!docker().some((c) => c.includes(`rm --force ${container}`) || c === `stop --time 30 ${container}`));

  assert.equal(readFileSync(join(infraDir, "sites", "reader", "index.html"), "utf8"), "new");
  assert.deepEqual(readdirSync(join(infraDir, "sites")), ["reader"]);
  assert.equal(readFileSync(join(dataDir, "apps", "reader", "app.env"), "utf8"), "NODE_ENV=production\nPORT=3001\nDATABASE_URL=postgres://x\nREADER_KEY=k\n");
  assert.equal(store.current("reader"), digest);
  assert.ok(docker().includes("tag local/reader-backend:current local/reader-backend:previous"));
  assert.ok(docker().includes(`tag ${image} local/reader-backend:current`));
});

test("an unhealthy deploy removes only the new container; the old one never stops", async () => {
  const { infraDir, docker, run, store } = setup({ previous: "sha256:prev", labelled: ["reader-backend-0123456789ab"], healthy: () => false });
  const job = await run();
  const container = `reader-backend-${job.id}`;

  assert.equal(job.status, "failed");
  assert.match(job.lines.join("\n"), /health check failed; the old backend kept serving throughout/);
  assert.ok(docker().includes(`logs --tail 40 ${container}`));
  assert.ok(docker().includes(`rm --force ${container}`));
  assert.ok(!docker().some((c) => /^(stop|network)/.test(c) || c === "rm reader-backend-0123456789ab"));
  assert.equal(docker().filter((c) => c.startsWith("compose")).length, 1);
  assert.equal(readFileSync(join(infraDir, "sites", "reader", "index.html"), "utf8"), "old");
  assert.deepEqual(readdirSync(join(infraDir, "sites")), ["reader"]);
  assert.equal(store.current("reader"), undefined);
  assert.ok(!docker().some((c) => c.startsWith("tag") && c.endsWith("local/reader-backend:current")));
});

test("if routing to the new container fails, it's removed and the old one keeps serving", async () => {
  const { infraDir, docker, run, store } = setup({ previous: "sha256:prev", labelled: ["reader-backend-0123456789ab"], fail: (a) => a[1] === "connect" });
  const job = await run();
  assert.equal(job.status, "failed");
  assert.ok(docker().includes(`rm --force reader-backend-${job.id}`));
  assert.ok(!docker().some((c) => c.startsWith("stop")));
  assert.equal(readFileSync(join(infraDir, "sites", "reader", "index.html"), "utf8"), "old");
  assert.deepEqual(readdirSync(join(infraDir, "sites")), ["reader"]);
  assert.equal(store.current("reader"), undefined);
});

test("the first deploy adopts the pre-blue-green reader-backend container, then retires it", async () => {
  const { docker, run } = setup({ legacy: true });
  const job = await run();
  assert.equal(job.status, "succeeded", job.lines.join("\n"));
  assert.equal(docker().find((c) => c.startsWith("tag")), "tag sha256:image-of-reader-backend local/reader-backend:current");
  assert.ok(docker().includes(`network connect --alias reader-backend caddy-web reader-backend-${job.id}`));
  assert.ok(docker().indexOf("stop --time 30 reader-backend") > docker().findIndex((c) => c.startsWith("network connect")));
  assert.ok(docker().includes("rm reader-backend"));
});

test("containers left by an unfinished deploy are retired along with the live one", async () => {
  const { docker, run } = setup({ previous: "sha256:prev", labelled: ["reader-backend-0123456789ab", "reader-backend-ba9876543210"], legacy: true });
  const job = await run();
  assert.equal(job.status, "succeeded", job.lines.join("\n"));
  for (const name of ["reader-backend-0123456789ab", "reader-backend-ba9876543210", "reader-backend"]) assert.ok(docker().includes(`rm ${name}`), name);
});

test("an old container that won't stop is reported, but the deploy still succeeds", async () => {
  const { run, store } = setup({ previous: "sha256:prev", labelled: ["reader-backend-0123456789ab"], fail: (a) => a[0] === "stop" });
  const job = await run();
  assert.equal(job.status, "succeeded", job.lines.join("\n"));
  assert.match(job.lines.join("\n"), /Couldn't remove reader-backend-0123456789ab.*docker rm -f reader-backend-0123456789ab/);
  assert.equal(store.current("reader"), digest);
});

test("with nothing serving before, a failure just reports", async () => {
  const { docker, run } = setup({ healthy: () => false });
  const job = await run();
  assert.equal(job.status, "failed");
  assert.match(job.lines.join("\n"), /nothing was serving before either/);
  assert.equal(docker().filter((c) => c.startsWith("compose")).length, 1);
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

test("GitHub secrets join the server's env file and win over hand-added lines", async () => {
  const { dataDir, run, store } = setup({ env: { READER_KEY: "from github", RAPIDAPI_KEY: "r#1 $x" } });
  const job = await run();
  assert.equal(job.status, "succeeded", job.lines.join("\n"));
  assert.equal(
    readFileSync(join(dataDir, "apps", "reader", "app.env"), "utf8"),
    "NODE_ENV=production\nPORT=3001\nDATABASE_URL=postgres://x\nREADER_KEY='from github'\nRAPIDAPI_KEY='r#1 $x'\n",
  );
  assert.ok(!job.lines.join("\n").includes("from github"));
  assert.ok(!readFileSync(join(dataDir, "apps", "reader", "state.json"), "utf8").includes("from github"));
  assert.equal(store.current("reader"), digest);
});
