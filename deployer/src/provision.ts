import { randomBytes } from "node:crypto";
import { appendFileSync, chownSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Exec } from "./exec.js";
import type { Job } from "./jobs.js";
import { describe, MANIFEST_FILE, type Manifest } from "./manifest.js";

// Creates what an app's infra.yml declares and doesn't exist yet, before its
// backend starts. Safe to repeat on every deploy: existing roles, databases
// and passwords are left alone, and nothing is ever removed.
export async function provision(exec: Exec, infraDir: string, job: Job, app: string, manifest: Manifest | undefined): Promise<void> {
  if (!manifest) {
    job.log(`==> No ${MANIFEST_FILE} in the repo; provisioning nothing`);
    return;
  }
  job.log(`==> Provisioning what ${MANIFEST_FILE} asks for: ${describe(manifest)}`);
  if (manifest.postgres) await postgres(exec, join(infraDir, "secrets"), job, app);
}

// A role and database named after the app, reachable only by that role, and
// its DATABASE_URL in secrets/<app>.env. The password is generated here and
// never leaves the server.
async function postgres(exec: Exec, secretsDir: string, job: Job, app: string): Promise<void> {
  // Postgres identifiers can't contain '-' unquoted, so notes-api -> notes_api.
  // App names are [a-z0-9-] (APP_NAME), so ident is safe to put in SQL.
  const ident = app.replace(/-/g, "_");
  const psql = async (sql: string, what: string) => {
    const errors: string[] = [];
    const result = await exec("docker", ["exec", "postgres", "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-qtA", "-c", sql], {
      onLine: (l) => errors.push(l),
    });
    if (result.code !== 0) throw new Error(`couldn't ${what}: ${errors.join(" ") || `psql exited with ${result.code}`}`);
    return result.stdout.trim();
  };

  mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  const envFile = join(secretsDir, `${app}.env`);
  const existing = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
  let password = existing.match(/^DATABASE_URL=postgres:\/\/[^:]*:([^@]*)@/m)?.[1];

  const roleExists = (await psql(`SELECT 1 FROM pg_roles WHERE rolname = '${ident}'`, "check for the role")) === "1";
  const written = !password;
  if (!password) {
    if (roleExists) {
      throw new Error(
        `role ${ident} exists but secrets/${app}.env has no DATABASE_URL, so its password is unknown. ` +
          `Add the line to secrets/${app}.env on the server, or reset the role's password there.`,
      );
    }
    password = randomBytes(24).toString("hex");
  }

  if (!roleExists) {
    await psql(`CREATE ROLE "${ident}" LOGIN PASSWORD '${password}'`, "create the role");
    job.log(`    Created role ${ident}`);
  }
  if ((await psql(`SELECT 1 FROM pg_database WHERE datname = '${ident}'`, "check for the database")) !== "1") {
    // As owner, the app role also owns the public schema (pg_database_owner).
    await psql(`CREATE DATABASE "${ident}" OWNER "${ident}"`, "create the database");
    job.log(`    Created database ${ident}`);
  }
  // Postgres lets every role connect to every database by default. Only the
  // owning app should reach its own. Re-applied each deploy, so older
  // databases get it too.
  await psql(`REVOKE CONNECT, TEMPORARY ON DATABASE "${ident}" FROM PUBLIC`, "restrict the database");

  if (written) {
    const line = `DATABASE_URL=postgres://${ident}:${password}@postgres:5432/${ident}\n`;
    appendFileSync(envFile, existing && !existing.endsWith("\n") ? `\n${line}` : line, { mode: 0o600 });
    // Owned like the folder, so the deploy user can still add lines by hand.
    const { uid, gid } = statSync(secretsDir);
    chownSync(envFile, uid, gid);
    job.log(`    Wrote DATABASE_URL to secrets/${app}.env`);
  } else {
    job.log(`    Database ${ident} is ready`);
  }
}
