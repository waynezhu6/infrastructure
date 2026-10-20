import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, SignJWT } from "jose";
import { createVerifier, ReplayGuard, type Caller } from "../src/auth.js";

const issuer = "https://token.actions.githubusercontent.com";
const audience = "https://waynezhu.dev/deploy";
const { publicKey, privateKey } = await generateKeyPair("RS256");
const verify = createVerifier({ issuer, audience, owner: "waynezhu6", ownerId: "48568003", ref: "refs/heads/main", keys: async () => publicKey });

const good = {
  repository: "waynezhu6/Reader",
  repository_owner: "waynezhu6",
  repository_owner_id: "48568003",
  ref: "refs/heads/main",
  sha: "abc123",
  run_id: "42",
};

async function token(claims: Record<string, unknown> = {}, opts: { aud?: string; iss?: string; exp?: string | number } = {}) {
  return new SignJWT({ ...good, ...claims })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(opts.iss ?? issuer)
    .setAudience(opts.aud ?? audience)
    .setIssuedAt()
    .setJti(crypto.randomUUID())
    .setExpirationTime(opts.exp ?? "5m")
    .sign(privateKey);
}

test("accepts a main-branch token from the owner and names the app after the repo", async () => {
  const caller = await verify(`Bearer ${await token()}`);
  assert.equal(caller.app, "reader");
  assert.equal(caller.repository, "waynezhu6/Reader");
  assert.equal(caller.sha, "abc123");
});

async function rejects(authorization: string | undefined, status: number, pattern: RegExp) {
  await assert.rejects(verify(authorization), (err: { status: number; message: string }) => {
    assert.equal(err.status, status);
    assert.match(err.message, pattern);
    return true;
  });
}

test("rejects missing and malformed headers", async () => {
  await rejects(undefined, 401, /missing/);
  await rejects("Basic abc", 401, /missing/);
});

test("rejects tokens for another audience or issuer, or expired", async () => {
  await rejects(`Bearer ${await token({}, { aud: "sigstore" })}`, 401, /aud/);
  await rejects(`Bearer ${await token({}, { iss: "https://evil.example" })}`, 401, /iss/);
  await rejects(`Bearer ${await token({}, { exp: Math.floor(Date.now() / 1000) - 120 })}`, 401, /exp/);
});

test("rejects a token signed by someone else", async () => {
  const other = await generateKeyPair("RS256");
  const forged = await new SignJWT(good).setProtectedHeader({ alg: "RS256" }).setIssuer(issuer).setAudience(audience).setIssuedAt().setJti("x").setExpirationTime("5m").sign(other.privateKey);
  await rejects(`Bearer ${forged}`, 401, /signature/);
});

test("rejects other owners, including a renamed account reusing the name", async () => {
  await rejects(`Bearer ${await token({ repository: "mallory/reader", repository_owner: "mallory", repository_owner_id: "1" })}`, 403, /owner/);
  await rejects(`Bearer ${await token({ repository_owner_id: "999" })}`, 403, /owner/);
});

test("rejects branches other than main and pull requests", async () => {
  await rejects(`Bearer ${await token({ ref: "refs/heads/feature" })}`, 403, /refs\/heads\/main/);
  await rejects(`Bearer ${await token({ ref: "refs/pull/3/merge" })}`, 403, /refs\/heads\/main/);
});

test("rejects repo names that can't be app names", async () => {
  await rejects(`Bearer ${await token({ repository: "waynezhu6/my_app" })}`, 403, /not a deployable app/);
  await rejects(`Bearer ${await token({ repository: "someone/reader" })}`, 403, /not a deployable app/);
});

test("ReplayGuard allows each token once", () => {
  const guard = new ReplayGuard();
  const now = 1_000_000;
  const caller = { jti: "a", exp: now + 300 } as Caller;
  assert.equal(guard.use(caller, now), true);
  assert.equal(guard.use(caller, now + 10), false);
  assert.equal(guard.use({ ...caller, jti: "b" }, now), true);
  // Forgotten once long expired, which is fine: the verifier rejects it anyway.
  assert.equal(guard.use(caller, now + 1000), true);
});
