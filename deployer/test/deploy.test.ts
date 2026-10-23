import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config.js";
import { createRunner } from "../src/deploy.js";
import type { Exec } from "../src/exec.js";
import { Deployer, Job, Store } from "../src/jobs.js";
import { provision } from "../src/provision.js";
import type { Manifest } from "../src/manifest.js";

const digest = `sha256:${"a".repeat(64)}`;

interface Pg {
  roles: Set<string>;
  databases: Set<string>;
  sql: string[];
}

function setup(opts: {
  previous?: string;
  // Backend containers already there: the deployer's (labelled), or one from
  // before blue-green deploys, called reader-backend.
  labelled?: string[];
  legacy?: boolean;
  healthy?: (call: number) => boolean;
  env?: Record<string, string>;
  fail?: (args: string[]) => boolean;
  manifest?: Manifest;
  pg?: Partial<Pg>;
}) {
  const infraDir = mkdtempSync(join(tmpdir(), "infra-"));
  const dataDir = mkdtempSync(join(tmpdir(), "data-"));
  mkdirSync(join(infraDir, "secrets"));
  writeFileSync(join(infraDir, "secrets", "reader.env"), "DATABASE_URL=postgres://x\nREADER_KEY=k");
  mkdirSync(join(infraDir, "sites", "reader"), { recursive: true });
  writeFileSync(join(infraDir, "sites", "reader", "index.html"), "old");

  const config = { owner: "WayneZhu6", registry: "ghcr.io", infraDir, dataDir, composeFile: "/app/app.compose.yml", healthTimeoutMs: 50 } as Config;
  const calls: { args: string[]; env?: NodeJS.ProcessEnv }[] = [];
  // A fake Postgres behind `docker exec postgres psql -c <sql>`.
  const pg: Pg = { roles: new Set(), databases: new Set(), sql: [], ...opts.pg };
  const exec: Exec = async (cmd, args, o) => {
    if (cmd !== "docker") return { code: 0, stdout: "" };
    calls.push({ args, env: o?.env });
    if (opts.fail?.(args)) return { code: 1, stdout: "" };
    const [a, b] = args;
    if (a === "exec" && b === "postgres") {
      const sql = args.at(-1)!;
      pg.sql.push(sql);
      // Queries name it as 'reader', statements as "reader".
      const name = sql.match(/"([a-z0-9_]+)"/)?.[1] ?? sql.match(/'([a-z0-9_]+)'$/)?.[1] ?? "";
      if (sql.includes("FROM pg_roles")) return { code: 0, stdout: pg.roles.has(name) ? "1\n" : "" };
      if (sql.includes("FROM pg_database")) return { code: 0, stdout: pg.databases.has(name) ? "1\n" : "" };
      if (sql.startsWith("CREATE ROLE")) pg.roles.add(name);
      if (sql.startsWith("CREATE DATABASE")) pg.databases.add(name);
      return { code: 0, stdout: "" };
    }
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
      const job = deployer.submit({ app: "reader", digest, repository: "waynezhu6/reader", sha: "abcdef0", runId: "1", env: opts.env ?? {}, manifest: opts.manifest });
      job.once("done", () => resolve(job));
    });
  const docker = () => calls.map((c) => c.args.join(" "));
  // The order of the calls matching each pattern, so tests can check one came before another.
  const index = (pattern: RegExp) => docker().findIndex((c) => pattern.test(c));
  return { infraDir, dataDir, calls, docker, index, health, run, store, pg };
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

test("an app without infra.yml or secrets gets only NODE_ENV and PORT", async () => {
  const { infraDir, dataDir, run, pg } = setup({});
  rmSync(join(infraDir, "secrets", "reader.env"));
  const job = await run();
  assert.equal(job.status, "succeeded", job.lines.join("\n"));
  assert.match(job.lines.join("\n"), /No infra.yml in the repo; provisioning nothing/);
  assert.deepEqual(pg.sql, []);
  assert.equal(readFileSync(join(dataDir, "apps", "reader", "app.env"), "utf8"), "NODE_ENV=production\nPORT=3001\n");
  assert.ok(!existsSync(join(infraDir, "secrets", "reader.env")));
});

test("postgres: true creates the role and database and writes DATABASE_URL", async () => {
  const { infraDir, dataDir, run, pg } = setup({ manifest: { postgres: true } });
  writeFileSync(join(infraDir, "secrets", "reader.env"), "READER_KEY=k");
  const job = await run();
  assert.equal(job.status, "succeeded", job.lines.join("\n"));

  assert.deepEqual([...pg.roles], ["reader"]);
  assert.deepEqual([...pg.databases], ["reader"]);
  assert.ok(pg.sql.includes('REVOKE CONNECT, TEMPORARY ON DATABASE "reader" FROM PUBLIC'));
  const secrets = readFileSync(join(infraDir, "secrets", "reader.env"), "utf8");
  const url = secrets.match(/^DATABASE_URL=postgres:\/\/reader:([0-9a-f]{48})@postgres:5432\/reader$/m);
  assert.ok(url, secrets);
  assert.ok(secrets.startsWith("READER_KEY=k\nDATABASE_URL="), "hand-added lines are kept");
  assert.ok(pg.sql.includes(`CREATE ROLE "reader" LOGIN PASSWORD '${url[1]}'`));
  assert.ok(!job.lines.join("\n").includes(url[1]), "the password stays out of the log");
  assert.match(readFileSync(join(dataDir, "apps", "reader", "app.env"), "utf8"), /DATABASE_URL=postgres:\/\/reader:/);
});

test("postgres: true on an app that already has it changes nothing", async () => {
  const { infraDir, run, pg } = setup({ manifest: { postgres: true }, pg: { roles: new Set(["reader"]), databases: new Set(["reader"]) } });
  writeFileSync(join(infraDir, "secrets", "reader.env"), "DATABASE_URL=postgres://reader:pw@postgres:5432/reader\n");
  const job = await run();
  assert.equal(job.status, "succeeded", job.lines.join("\n"));
  assert.ok(!pg.sql.some((q) => q.startsWith("CREATE")));
  assert.equal(readFileSync(join(infraDir, "secrets", "reader.env"), "utf8"), "DATABASE_URL=postgres://reader:pw@postgres:5432/reader\n");
});

test("a role whose password was lost fails the deploy before anything starts", async () => {
  const { infraDir, calls, run } = setup({ manifest: { postgres: true }, pg: { roles: new Set(["reader"]) } });
  rmSync(join(infraDir, "secrets", "reader.env"));
  const job = await run();
  assert.equal(job.status, "failed");
  assert.match(job.lines.join("\n"), /role reader exists but secrets\/reader.env has no DATABASE_URL/);
  assert.ok(!calls.some((c) => c.args[0] === "pull" || c.args[0] === "compose"));
});

test("dashes in app names become underscores in Postgres", async () => {
  const infraDir = mkdtempSync(join(tmpdir(), "infra-"));
  const sql: string[] = [];
  const exec: Exec = async (_cmd, args) => {
    sql.push(args.at(-1)!);
    return { code: 0, stdout: "" };
  };
  await provision(exec, infraDir, new Job({ app: "notes-api", digest, repository: "r", sha: "s", runId: "1", env: {} }), "notes-api", { postgres: true });
  assert.ok(sql.includes('CREATE DATABASE "notes_api" OWNER "notes_api"'), sql.join("\n"));
  assert.match(readFileSync(join(infraDir, "secrets", "notes-api.env"), "utf8"), /^DATABASE_URL=postgres:\/\/notes_api:[0-9a-f]+@postgres:5432\/notes_api\n$/);
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
