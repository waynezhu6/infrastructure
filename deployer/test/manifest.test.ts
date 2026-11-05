import { test } from "node:test";
import assert from "node:assert/strict";
import { describe, ManifestError, parseManifest } from "../src/manifest.js";

test("reads what an app declares", () => {
  assert.deepEqual(parseManifest("# notes\npostgres: true\n"), { postgres: true, backend: true });
  assert.deepEqual(parseManifest("postgres: false"), { postgres: false, backend: true });
  assert.deepEqual(parseManifest("backend: false"), { postgres: false, backend: false });
});

test("an empty file declares nothing", () => {
  assert.deepEqual(parseManifest(""), { postgres: false, backend: true });
  assert.deepEqual(parseManifest("# nothing yet\n"), { postgres: false, backend: true });
});

test("refuses unknown settings, wrong types and broken YAML", () => {
  assert.throws(() => parseManifest("postgress: true"), /unknown setting "postgress"; known: postgres, backend/);
  assert.throws(() => parseManifest("postgres: yes please"), /postgres must be true or false/);
  assert.throws(() => parseManifest('postgres: "true"'), /must be true or false/);
  assert.throws(() => parseManifest("- postgres"), /must be a map/);
  assert.throws(() => parseManifest("postgres: [1"), ManifestError);
});

test("describes a manifest for the deploy log", () => {
  assert.equal(describe({ postgres: true, backend: true }), "postgres");
  assert.equal(describe({ postgres: false, backend: true }), "nothing");
  assert.equal(describe({ postgres: false, backend: false }), "no backend (static files only)");
});
