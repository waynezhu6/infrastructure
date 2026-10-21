import { EventEmitter } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "superseded";

export interface DeployRequest {
  app: string;
  digest: string;
  repository: string;
  sha: string;
  runId: string;
  // Extra environment for the backend, from the app repo's GitHub secrets.
  // Kept in memory only: logs and state.json never see the values.
  env: Record<string, string>;
}

// Identifies what a deploy would put live: the image plus its environment, so
// changing only a secret still redeploys.
export function envHash(env: Record<string, string>): string {
  const sorted = Object.keys(env).sort().map((k) => [k, env[k]]);
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

function same(a: DeployRequest, b: DeployRequest): boolean {
  return a.digest === b.digest && envHash(a.env) === envHash(b.env);
}

// One deploy of one image. Its output is kept in memory for anyone attached
// to it (the CI run that started it, a repeat call, a status poll) and
// appended to data/logs/<app>/<id>.log for later.
export class Job extends EventEmitter {
  readonly id = randomBytes(6).toString("hex");
  readonly createdAt = new Date();
  readonly lines: string[] = [];
  status: JobStatus = "queued";
  private logFile?: string;

  constructor(
    readonly req: DeployRequest,
    logFileFor?: (id: string) => string,
  ) {
    super();
    this.logFile = logFileFor?.(this.id);
  }

  get done(): boolean {
    return this.status === "succeeded" || this.status === "failed" || this.status === "superseded";
  }

  log(text: string): void {
    for (const line of text.replace(/\n$/, "").split("\n")) {
      this.lines.push(line);
      if (this.logFile) appendFileSync(this.logFile, `${new Date().toISOString()} ${line}\n`);
      this.emit("line", line);
    }
  }

  finish(status: "succeeded" | "failed" | "superseded", message?: string): void {
    if (this.done) return;
    if (message) this.log(message);
    this.status = status;
    this.emit("done", status);
  }
}

// Remembers which image each app last deployed successfully, so a repeat call
// for it is a no-op, and where logs go.
export class Store {
  constructor(private dataDir: string) {}

  logFile(app: string, id: string): string {
    const dir = join(this.dataDir, "logs", app);
    mkdirSync(dir, { recursive: true });
    return join(dir, `${id}.log`);
  }

  current(app: string): string | undefined {
    return this.state(app)?.digest;
  }

  // Whether this exact image and environment is what's live.
  isCurrent(req: DeployRequest): boolean {
    const state = this.state(req.app);
    return state?.digest === req.digest && (state.env ?? envHash({})) === envHash(req.env);
  }

  setCurrent(req: DeployRequest, job: string): void {
    mkdirSync(join(this.dataDir, "apps", req.app), { recursive: true });
    const state = { digest: req.digest, env: envHash(req.env), job, at: new Date().toISOString() };
    writeFileSync(this.stateFile(req.app), JSON.stringify(state, null, 2) + "\n");
  }

  private state(app: string): { digest?: string; env?: string } | undefined {
    try {
      return JSON.parse(readFileSync(this.stateFile(app), "utf8"));
    } catch {
      return undefined;
    }
  }

  private stateFile(app: string): string {
    return join(this.dataDir, "apps", app, "state.json");
  }
}

export type Runner = (job: Job) => Promise<void>;

const KEEP_FINISHED = 200;

// Runs at most one deploy per app at a time; different apps run in parallel.
// While one runs, only the newest request waits behind it: an older waiting
// one is dropped, since deploying it would only be overwritten.
export class Deployer {
  private apps = new Map<string, { running?: Job; pending?: Job }>();
  private jobs = new Map<string, Job>();

  constructor(
    private run: Runner,
    private store: Store,
  ) {}

  submit(req: DeployRequest): Job {
    const slot = this.apps.get(req.app) ?? {};
    this.apps.set(req.app, slot);

    // The same image and environment already on its way: attach to that deploy.
    if (slot.running && same(slot.running.req, req)) return slot.running;
    if (slot.pending && same(slot.pending.req, req)) return slot.pending;

    const job = this.track(new Job(req, (id) => this.store.logFile(req.app, id)));

    if (!slot.running && this.store.isCurrent(req)) {
      job.finish("succeeded", `${req.app} is already running ${req.digest}; nothing to do.`);
      return job;
    }

    if (slot.running) {
      slot.pending?.finish("superseded", `Superseded by deploy ${job.id} of a newer image; this one was not deployed.`);
      slot.pending = job;
      job.log(`Waiting for deploy ${slot.running.id} of ${req.app} to finish.`);
    } else {
      this.start(req.app, job);
    }
    return job;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  // Resolves once no deploy is running or waiting, for a clean shutdown.
  async idle(): Promise<void> {
    for (;;) {
      const busy = [...this.apps.values()].flatMap((s) => [s.running, s.pending]).filter((j): j is Job => !!j);
      if (busy.length === 0) return;
      await Promise.all(busy.map((j) => (j.done ? undefined : new Promise((r) => j.once("done", r)))));
    }
  }

  private track(job: Job): Job {
    this.jobs.set(job.id, job);
    if (this.jobs.size > KEEP_FINISHED) {
      for (const [id, old] of this.jobs) {
        if (this.jobs.size <= KEEP_FINISHED) break;
        if (old.done) this.jobs.delete(id);
      }
    }
    return job;
  }

  private start(app: string, job: Job): void {
    const slot = this.apps.get(app)!;
    slot.running = job;
    job.status = "running";
    job.emit("start");
    this.run(job)
      .then(
        () => job.finish("succeeded"),
        (err: Error) => job.finish("failed", `Deploy failed: ${err.message}`),
      )
      .finally(() => {
        slot.running = undefined;
        const next = slot.pending;
        slot.pending = undefined;
        if (next && !next.done) this.start(app, next);
      });
  }
}
