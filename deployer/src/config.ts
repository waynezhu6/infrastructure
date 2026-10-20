// Settings come from the environment, set in the infrastructure
// docker-compose.yml. Paths are inside the deployer container.

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

export interface Config {
  port: number;
  // OIDC tokens must be issued for this audience. The deploy action requests
  // it, so a token minted for anything else is useless here.
  audience: string;
  issuer: string;
  // Only repos owned by this GitHub account may deploy, and only from this ref.
  owner: string;
  ownerId: string;
  ref: string;
  // Images are pulled from <registry>/<owner>/<app>-backend.
  registry: string;
  // The infrastructure checkout: apps/, secrets/ and sites/ live here.
  infraDir: string;
  // Deploy logs and per-app state.
  dataDir: string;
  // The compose file every app runs from.
  composeFile: string;
  healthTimeoutMs: number;
}

export function loadConfig(): Config {
  return {
    port: Number(process.env.PORT ?? 8080),
    audience: process.env.DEPLOY_AUDIENCE ?? "https://waynezhu.dev/deploy",
    issuer: "https://token.actions.githubusercontent.com",
    owner: required("DEPLOY_OWNER"),
    ownerId: required("DEPLOY_OWNER_ID"),
    ref: process.env.DEPLOY_REF ?? "refs/heads/main",
    registry: process.env.DEPLOY_REGISTRY ?? "ghcr.io",
    infraDir: process.env.INFRA_DIR ?? "/infra",
    dataDir: process.env.DATA_DIR ?? "/data",
    composeFile: process.env.APP_COMPOSE_FILE ?? "/app/app.compose.yml",
    healthTimeoutMs: Number(process.env.HEALTH_TIMEOUT_MS ?? 90_000),
  };
}

// Same rule as scripts/register-app.sh.
export const APP_NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;
export const DIGEST = /^sha256:[a-f0-9]{64}$/;
