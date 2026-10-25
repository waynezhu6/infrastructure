import { parse } from "yaml";

// What an app needs from the server, from infra.yml at the root of its repo.
// The deploy action sends the file's text with each deploy, and the deployer
// provisions whatever is declared and missing (provision.ts). Nothing is ever
// removed: setting a resource back to false only stops creating it.
//
//   postgres: true    a database and role of its own, and DATABASE_URL
//   monitor: false    leave it out of the monitor's health checks (monitor/);
//                     on by default. The monitor reads it from the app's
//                     deploy state, so the deployer only validates it.
export interface Manifest {
  postgres: boolean;
  monitor: boolean;
}

export const MANIFEST_FILE = "infra.yml";

const DEFAULTS: Manifest = { postgres: false, monitor: true };

export class ManifestError extends Error {}

// An empty file declares nothing. Unknown keys are refused so a typo can't
// quietly leave an app without what it asked for.
export function parseManifest(text: string): Manifest {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (err) {
    throw new ManifestError(`${MANIFEST_FILE} isn't valid YAML: ${(err as Error).message.split("\n")[0]}`);
  }
  if (doc === null || doc === undefined) return { ...DEFAULTS };
  if (typeof doc !== "object" || Array.isArray(doc)) throw new ManifestError(`${MANIFEST_FILE} must be a map of settings, like "postgres: true"`);

  const manifest = { ...DEFAULTS };
  for (const [key, value] of Object.entries(doc)) {
    if (!Object.hasOwn(DEFAULTS, key)) {
      throw new ManifestError(`${MANIFEST_FILE} has an unknown setting "${key}"; known: ${Object.keys(DEFAULTS).join(", ")}`);
    }
    if (typeof value !== "boolean") throw new ManifestError(`${MANIFEST_FILE}: ${key} must be true or false`);
    manifest[key as keyof Manifest] = value;
  }
  return manifest;
}

// How a manifest reads in a deploy's log.
export function describe(manifest: Manifest): string {
  const wanted = Object.entries(manifest)
    .filter(([, v]) => v)
    .map(([k]) => k);
  return wanted.length ? wanted.join(", ") : "nothing";
}
