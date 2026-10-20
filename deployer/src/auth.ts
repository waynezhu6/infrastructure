import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { APP_NAME } from "./config.js";

// Who is calling, from a verified GitHub Actions OIDC token. The app is the
// repo's own name, so a repo can only ever deploy itself.
export interface Caller {
  app: string;
  repository: string;
  sha: string;
  runId: string;
  jti: string;
  exp: number;
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403,
  ) {
    super(message);
  }
}

export interface VerifierOptions {
  issuer: string;
  audience: string;
  owner: string;
  ownerId: string;
  ref: string;
  // Defaults to GitHub's published signing keys.
  keys?: JWTVerifyGetKey;
}

export type Verifier = (authorization: string | undefined) => Promise<Caller>;

export function createVerifier(opts: VerifierOptions): Verifier {
  const keys = opts.keys ?? createRemoteJWKSet(new URL(`${opts.issuer}/.well-known/jwks`));

  return async (authorization) => {
    const token = authorization?.match(/^Bearer (\S+)$/)?.[1];
    if (!token) throw new AuthError("missing bearer token", 401);

    let claims;
    try {
      ({ payload: claims } = await jwtVerify(token, keys, {
        issuer: opts.issuer,
        audience: opts.audience,
        algorithms: ["RS256"],
        requiredClaims: ["exp", "iat", "jti"],
        clockTolerance: 30,
      }));
    } catch (err) {
      throw new AuthError(`invalid token: ${(err as Error).message}`, 401);
    }

    const str = (key: string) => (typeof claims[key] === "string" ? (claims[key] as string) : "");

    // The numeric id survives account renames, so a new account that takes
    // the old name can't deploy.
    if (str("repository_owner_id") !== opts.ownerId || str("repository_owner").toLowerCase() !== opts.owner.toLowerCase()) {
      throw new AuthError(`repository owner ${str("repository_owner") || "(none)"} may not deploy here`, 403);
    }
    if (str("ref") !== opts.ref) {
      throw new AuthError(`only ${opts.ref} may deploy, not ${str("ref") || "(none)"}`, 403);
    }

    const repository = str("repository");
    const [repoOwner, repoName = ""] = repository.split("/");
    const app = repoName.toLowerCase();
    if (repoOwner?.toLowerCase() !== opts.owner.toLowerCase() || !APP_NAME.test(app)) {
      throw new AuthError(`repository ${repository || "(none)"} is not a deployable app`, 403);
    }

    return {
      app,
      repository,
      sha: str("sha"),
      runId: str("run_id"),
      jti: str("jti"),
      exp: claims.exp as number,
    };
  };
}

// OIDC tokens are bearer tokens: someone who copied one out of a log could
// replay it until it expires. Each one may start a deploy only once.
export class ReplayGuard {
  private seen = new Map<string, number>();

  use(caller: Caller, now = Date.now() / 1000): boolean {
    // Kept a little past expiry to cover the verifier's clock tolerance.
    for (const [jti, exp] of this.seen) if (exp + 60 < now) this.seen.delete(jti);
    if (this.seen.has(caller.jti)) return false;
    this.seen.set(caller.jti, caller.exp);
    return true;
  }
}
