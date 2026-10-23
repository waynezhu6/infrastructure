import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { AuthError, ReplayGuard, type Verifier } from "./auth.js";
import { DIGEST } from "./config.js";
import type { Deployer, Job } from "./jobs.js";
import { ManifestError, parseManifest, type Manifest } from "./manifest.js";

export interface ServerDeps {
  verify: Verifier;
  deployer: Deployer;
  infraDir: string;
}

// The deploy API, served by Caddy at waynezhu.dev/deploy:
//
//   POST /deploy             {"digest": "sha256:...", "env": {"NAME": "value"}, "manifest": "<infra.yml>"}
//                            start (or join) a deploy of the calling repo's
//                            app; env (optional) is extra environment for its
//                            backend, from the app repo's GitHub secrets;
//                            manifest (optional) is the text of its infra.yml,
//                            what to provision for it (manifest.ts). The response streams
//                            the deploy's output and ends with the verdict line
//                            "==> deploy <id> <succeeded|failed|superseded>".
//   GET  /deploy/jobs/<id>   status and output of a deploy, as JSON, for a CI
//                            run whose connection dropped (?from=<line> skips
//                            lines it already has).
//   GET  /deploy/healthz     liveness, unauthenticated.
//
// Every call but healthz needs a GitHub Actions OIDC token (see auth.ts).
export function createApp(deps: ServerDeps) {
  const replay = new ReplayGuard();

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://deployer");

      if (req.method === "GET" && url.pathname === "/deploy/healthz") {
        return send(res, 200, { status: "ok" });
      }

      if (req.method === "POST" && url.pathname === "/deploy") {
        const caller = await deps.verify(req.headers.authorization);
        if (!replay.use(caller)) throw new AuthError("token already used; request a new one", 401);

        const body = await readJson(req);
        const digest = typeof body?.digest === "string" ? body.digest : "";
        if (!DIGEST.test(digest)) return send(res, 400, { error: 'body must be {"digest": "sha256:<64 hex>"}' });
        const env = parseEnv(body?.env);
        const manifest = readManifest(body?.manifest);
        if (!existsSync(join(deps.infraDir, "apps", `${caller.app}.caddy`))) {
          return send(res, 404, {
            error: `${caller.app} is not registered. Run scripts/register-app.sh ${caller.app} in the infrastructure repo and merge the PR.`,
          });
        }

        const job = deps.deployer.submit({ app: caller.app, digest, repository: caller.repository, sha: caller.sha, runId: caller.runId, env, manifest });
        return stream(res, job);
      }

      const status = url.pathname.match(/^\/deploy\/jobs\/([a-f0-9]{12})$/);
      if (req.method === "GET" && status) {
        const caller = await deps.verify(req.headers.authorization);
        const job = deps.deployer.get(status[1]);
        // Another app's deploy is reported the same as a missing one.
        if (!job || job.req.app !== caller.app) return send(res, 404, { error: "no such deploy" });
        const from = Math.max(0, Number(url.searchParams.get("from")) || 0);
        return send(res, 200, { id: job.id, app: job.req.app, digest: job.req.digest, status: job.status, lines: job.lines.slice(from), next: job.lines.length });
      }

      send(res, 404, { error: "not found" });
    } catch (err) {
      if (err instanceof AuthError) return send(res, err.status, { error: err.message });
      if (err instanceof BadRequest) return send(res, 400, { error: err.message });
      console.error(err);
      if (!res.headersSent) send(res, 500, { error: "internal error" });
      else res.end();
    }
  });
}

function stream(res: ServerResponse, job: Job) {
  res.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Deploy-Id": job.id,
  });
  const onLine = (line: string) => res.write(`${line}\n`);
  const onDone = () => {
    res.end(`==> deploy ${job.id} ${job.status}\n`);
    cleanup();
  };
  const cleanup = () => {
    job.off("line", onLine);
    job.off("done", onDone);
  };

  for (const line of job.lines) onLine(line);
  if (job.done) return onDone();
  job.on("line", onLine);
  job.on("done", onDone);
  // The deploy carries on if CI goes away; it can poll /deploy/jobs/<id>.
  res.on("close", cleanup);
}

class BadRequest extends Error {}

// Names the server sets itself; an app's GitHub secrets can't replace them.
const SERVER_OWNED = new Set(["NODE_ENV", "PORT", "DATABASE_URL"]);
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

function parseEnv(raw: unknown): Record<string, string> {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new BadRequest("env must be an object of strings");
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!ENV_NAME.test(name)) throw new BadRequest(`env name ${JSON.stringify(name)} must be uppercase letters, digits and _`);
    if (SERVER_OWNED.has(name)) throw new BadRequest(`${name} is set by the server; remove the ${name} secret from the app repo`);
    // The env file has one NAME='value' per line (deploy.ts).
    if (typeof value !== "string" || /['\r\n\0]/.test(value)) {
      throw new BadRequest(`env ${name} must be a single-line string without single quotes`);
    }
    env[name] = value;
  }
  return env;
}

// The app's infra.yml, checked here so a bad one fails the request with a
// clear message rather than a deploy.
function readManifest(raw: unknown): Manifest | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") throw new BadRequest("manifest must be the text of infra.yml");
  try {
    return parseManifest(raw);
  } catch (err) {
    if (err instanceof ManifestError) throw new BadRequest(err.message);
    throw err;
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 65536) throw new BadRequest("body too large");
  }
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    throw new BadRequest("body must be JSON");
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body) + "\n");
}
