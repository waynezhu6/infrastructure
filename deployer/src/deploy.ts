import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.js";
import type { Exec } from "./exec.js";
import type { Job, Runner, Store } from "./jobs.js";

export interface DeployDeps {
  config: Config;
  store: Store;
  exec: Exec;
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
}

// Where the app image keeps its built frontend (app-template's Dockerfile).
export const FRONTEND_IN_IMAGE = "/app/frontend/dist";

// The label app.compose.yml puts on every backend container, so a deploy can
// find the ones it replaces whatever they're called.
export const APP_LABEL = "deployer.app";

// How long an old backend gets to finish its requests before it's killed.
export const STOP_TIMEOUT_S = 30;

// One deploy, blue-green on the one server:
//   1. pull the image by digest
//   2. copy its frontend out into a staging folder
//   3. start a new backend container, <app>-backend-<deploy id>, next to the
//      one serving (docker compose, app.compose.yml), not yet reachable as
//      <app>-backend
//   4. wait for its /api/health
//   5. on success, give it the <app>-backend alias Caddy proxies to, switch
//      the frontend over, record the new image and stop the old container;
//      on failure, remove only the new container, so the old one never stops
//      serving, and leave the frontend alone.
// The previous image stays tagged locally as local/<app>-backend:previous.
export function createRunner(deps: DeployDeps): Runner {
  const { config, store, exec } = deps;

  return async (job: Job) => {
    const { app, digest } = job.req;
    const image = `${config.registry}/${config.owner.toLowerCase()}/${app}-backend@${digest}`;
    const local = `local/${app}-backend`;
    // Caddy proxies to this name. Containers from before blue-green deploys
    // were called it; since then it's a network alias of the live one.
    const alias = `${app}-backend`;
    const container = `${alias}-${job.id}`;
    const sites = join(config.infraDir, "sites");
    const staged = join(sites, `.${app}.${job.id}`);
    const appDir = join(config.dataDir, "apps", app);

    const run = async (args: string[], env?: NodeJS.ProcessEnv) => {
      const result = await exec("docker", args, { env, onLine: (l) => job.log(`  ${l}`) });
      if (result.code !== 0) throw new Error(`docker ${args[0]} ${args[1] ?? ""} exited with ${result.code}`.trim());
      return result.stdout.trim();
    };
    const quiet = async (args: string[]) => {
      const result = await exec("docker", args);
      return result.code === 0 ? result.stdout.trim() : undefined;
    };

    job.log(`==> Deploying ${app} (${job.req.repository}@${job.req.sha.slice(0, 7)}) as deploy ${job.id}`);

    const secrets = join(config.infraDir, "secrets", `${app}.env`);
    if (!existsSync(secrets)) {
      throw new Error(`${app} is registered but has no secrets/${app}.env yet. Re-run the infrastructure Deploy workflow.`);
    }

    job.log(`==> Pulling ${image}`);
    await run(["pull", "--quiet", image]);

    // The containers this deploy replaces: the live one, plus any left behind
    // by a deploy the deployer didn't get to finish.
    const old = ((await quiet(["ps", "--all", "--filter", `label=${APP_LABEL}=${app}`, "--format", "{{.Names}}"])) ?? "")
      .split("\n")
      .filter(Boolean);
    if (!old.includes(alias) && (await quiet(["container", "inspect", "--format", "{{.Name}}", alias])) !== undefined) old.push(alias);
    job.log(old.length ? `    Serving now: ${old.join(", ")}` : "    Nothing serving yet.");

    // The image to keep as :previous. The first deploy through here adopts
    // whatever container is already running (from the old SSH deploy, say).
    let previous = await quiet(["image", "inspect", "--format", "{{.Id}}", `${local}:current`]);
    if (!previous && old.length) {
      const running = await quiet(["container", "inspect", "--format", "{{.Image}}", old[0]]);
      if (running) {
        await run(["tag", running, `${local}:current`]);
        previous = running;
      }
    }

    // Until the new container has the alias, a failure removes it and nothing
    // else changes.
    let live = false;
    try {
      job.log("==> Unpacking frontend");
      const tmp = `deploy-${job.id}`;
      if ((await quiet(["create", "--name", tmp, image])) === undefined) throw new Error("docker create failed");
      try {
        rmSync(staged, { recursive: true, force: true });
        await run(["cp", `${tmp}:${FRONTEND_IN_IMAGE}`, staged]).catch(() => {
          throw new Error(`the image has no ${FRONTEND_IN_IMAGE}; build it with app-template's backend/Dockerfile`);
        });
      } finally {
        await quiet(["rm", tmp]);
      }
      // Keep the folder owned like the rest of sites/, as the old rsync left it.
      const { uid, gid } = statSync(sites);
      await exec("chown", ["-R", `${uid}:${gid}`, staged]);

      mkdirSync(appDir, { recursive: true });
      const envFile = join(appDir, "app.env");
      writeFileSync(envFile, appEnv(readFileSync(secrets, "utf8"), job.req.env), { mode: 0o600 });

      job.log(`==> Starting ${container} next to ${old.length ? "the one serving" : "nothing"}`);
      // A compose project per container, so starting this one never touches
      // the one serving.
      await run(["compose", "--project-name", `${app}-${job.id}`, "--file", config.composeFile, "up", "--detach", "--pull", "never"], {
        ...process.env,
        APP: app,
        CONTAINER: container,
        IMAGE: image,
        APP_ENV_FILE: envFile,
      });

      job.log(`==> Waiting for http://${container}:3001/api/health`);
      if (!(await waitHealthy(deps, job, container))) {
        job.log("==> Backend never became healthy. Its last log lines:");
        await exec("docker", ["logs", "--tail", "40", container], { onLine: (l) => job.log(`  | ${l}`) });
        throw new Error(
          `health check failed; ${old.length ? "the old backend kept serving throughout" : "nothing was serving before either"} and the frontend was not changed`,
        );
      }

      // Docker can't add an alias to a network the container is already on,
      // so join caddy-web again with it. Nothing reaches this container by
      // that network yet, so nothing notices.
      job.log(`==> Routing ${alias} to ${container}`);
      await run(["network", "disconnect", "caddy-web", container]);
      await run(["network", "connect", "--alias", alias, "caddy-web", container]);
      live = true;
    } catch (err) {
      if (!live) await quiet(["rm", "--force", container]);
      rmSync(staged, { recursive: true, force: true });
      throw err;
    }

    try {
      job.log("==> Switching frontend");
      const current = join(sites, app);
      const replaced = join(sites, `.${app}.old-${job.id}`);
      if (existsSync(current)) renameSync(current, replaced);
      renameSync(staged, current);
      rmSync(replaced, { recursive: true, force: true });

      if (previous) await run(["tag", `${local}:current`, `${local}:previous`]);
      await run(["tag", image, `${local}:current`]);
      store.setCurrent(job.req, job.id);
    } finally {
      rmSync(staged, { recursive: true, force: true });
    }

    // Both containers serve until here. The old one gets SIGTERM, finishes
    // the requests it has (app-template's backend closes its server on it),
    // and is killed after STOP_TIMEOUT_S if it doesn't exit; Caddy retries any
    // request that lands on it meanwhile.
    for (const name of old) {
      job.log(`==> Stopping ${name}`);
      if ((await quiet(["stop", "--time", String(STOP_TIMEOUT_S), name])) === undefined || (await quiet(["rm", name])) === undefined) {
        job.log(`    Couldn't remove ${name}; it may still be serving next to ${container}. Remove it by hand: docker rm -f ${name}`);
      }
    }
    // Untagged images are older deploys, already replaced twice.
    await quiet(["image", "prune", "--force"]);
    job.log(`==> ${app} is live on ${digest}`);
  };
}

// The backend's environment: NODE_ENV and PORT, the server's secrets/<app>.env
// (DATABASE_URL and anything added by hand), then the app repo's GitHub
// secrets, which win over a hand-added line of the same name. The server
// rejects GitHub secrets named like the server-owned ones (server.ts).
export function appEnv(serverFile: string, env: Record<string, string>): string {
  const lines = serverFile.split("\n").filter((l) => l.trim() && !Object.hasOwn(env, l.split("=")[0].trim()));
  // Single quotes keep compose from interpolating or trimming the value.
  const extra = Object.entries(env).map(([k, v]) => `${k}='${v}'`);
  return ["NODE_ENV=production", "PORT=3001", ...lines, ...extra].join("\n") + "\n";
}

async function waitHealthy(deps: DeployDeps, job: Job, container: string): Promise<boolean> {
  const deadline = Date.now() + deps.config.healthTimeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const res = await deps.fetch(`http://${container}:3001/api/health`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        job.log(`    Healthy (HTTP ${res.status})`);
        return true;
      }
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = (err as Error).message;
    }
    await deps.sleep(2000);
  }
  job.log(`    Gave up after ${Math.round(deps.config.healthTimeoutMs / 1000)}s (last: ${last})`);
  return false;
}
