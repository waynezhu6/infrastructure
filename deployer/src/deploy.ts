import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.js";
import type { Exec } from "./exec.js";
import type { Job, Runner, Store } from "./jobs.js";
import { provision } from "./provision.js";

export interface DeployDeps {
  config: Config;
  store: Store;
  exec: Exec;
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
}

// Where the app image keeps its built frontend (app-template's Dockerfile).
export const FRONTEND_IN_IMAGE = "/app/frontend/dist";

// One deploy:
//   0. provision what the app's infra.yml asks for (provision.ts)
//   1. pull the image by digest
//   2. copy its frontend out into a staging folder
//   3. start the backend container from it (docker compose, app.compose.yml)
//   4. wait for /api/health
//   5. on success, switch the frontend over and record the new image;
//      on failure, put the previous image back and leave the frontend alone.
// The previous image stays tagged locally as local/<app>-backend:current until
// a deploy succeeds, so a rollback never needs the registry.
export function createRunner(deps: DeployDeps): Runner {
  const { config, store, exec } = deps;

  return async (job: Job) => {
    const { app, digest } = job.req;
    const image = `${config.registry}/${config.owner.toLowerCase()}/${app}-backend@${digest}`;
    const local = `local/${app}-backend`;
    const container = `${app}-backend`;
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

    await provision(exec, config.infraDir, job, app, job.req.manifest);
    const secrets = join(config.infraDir, "secrets", `${app}.env`);

    job.log(`==> Pulling ${image}`);
    await run(["pull", "--quiet", image]);

    // What to roll back to. The first deploy through here adopts whatever
    // container is already running (from the old SSH deploy, say).
    let previous = await quiet(["image", "inspect", "--format", "{{.Id}}", `${local}:current`]);
    if (!previous) {
      const running = await quiet(["container", "inspect", "--format", "{{.Image}}", container]);
      if (running) {
        await run(["tag", running, `${local}:current`]);
        previous = running;
      }
    }
    job.log(previous ? `    Rollback target: ${previous.slice(0, 19)}` : "    No previous image; nothing to roll back to.");

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
      writeFileSync(envFile, appEnv(existsSync(secrets) ? readFileSync(secrets, "utf8") : "", job.req.env), { mode: 0o600 });

      const up = (img: string) =>
        run(["compose", "--project-name", app, "--file", config.composeFile, "up", "--detach", "--pull", "never", "--remove-orphans"], {
          ...process.env,
          APP: app,
          IMAGE: img,
          APP_ENV_FILE: envFile,
        });

      job.log("==> Starting backend");
      await up(image);

      job.log(`==> Waiting for http://${container}:3001/api/health`);
      const healthy = await waitHealthy(deps, job, container);

      if (!healthy) {
        job.log("==> Backend never became healthy. Its last log lines:");
        await exec("docker", ["logs", "--tail", "40", container], { onLine: (l) => job.log(`  | ${l}`) });
        if (previous) {
          job.log("==> Rolling back to the previous image");
          await up(`${local}:current`);
          job.log((await waitHealthy(deps, job, container)) ? "    Previous image is back up." : "    The previous image isn't healthy either; check the server.");
        }
        throw new Error("health check failed; the frontend was not changed");
      }

      job.log("==> Switching frontend");
      const live = join(sites, app);
      const old = join(sites, `.${app}.old-${job.id}`);
      if (existsSync(live)) renameSync(live, old);
      renameSync(staged, live);
      rmSync(old, { recursive: true, force: true });

      if (previous) await run(["tag", `${local}:current`, `${local}:previous`]);
      await run(["tag", image, `${local}:current`]);
      store.setCurrent(job.req, job.id);
      // Untagged images are older deploys, already replaced twice.
      await quiet(["image", "prune", "--force"]);
      job.log(`==> ${app} is live on ${digest}`);
    } finally {
      rmSync(staged, { recursive: true, force: true });
    }
  };
}

// The backend's environment: NODE_ENV and PORT, the server's secrets/<app>.env
// (DATABASE_URL and anything added by hand; empty if the app has neither), then the app repo's GitHub
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
