import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCanonicalVersion,
  computeNextVersion,
  parseCanonicalVersion,
  parseUpstreamVersion,
  validateVersionMetadata,
} from "./versioning.mjs";

const current = {
  version: "2.16.3-aidesk.4",
  upstreamVersion: "2.16.3",
  counter: 4,
};

test("increments the fork counter when the upstream base is unchanged", () => {
  assert.deepEqual(computeNextVersion(current, "v2.16.3", true), {
    version: "2.16.3-aidesk.5",
    upstreamVersion: "2.16.3",
    counter: 5,
    changed: true,
    reason: "increment",
  });
});

test("resets the counter when a newer upstream base is available", () => {
  assert.deepEqual(computeNextVersion(current, "2.17.0", true), {
    version: "2.17.0-aidesk.0",
    upstreamVersion: "2.17.0",
    counter: 0,
    changed: true,
    reason: "upstream-reset",
  });
});

test("manual synchronization does not increment an unchanged base", () => {
  assert.deepEqual(computeNextVersion(current, "2.16.3", false), {
    ...current,
    changed: false,
    reason: "unchanged",
  });
});

test("rejects an upstream downgrade", () => {
  assert.throws(
    () => computeNextVersion(current, "2.15.9", true),
    /Refusing upstream downgrade/,
  );
});

test("initializes legacy metadata at counter zero", () => {
  assert.deepEqual(computeNextVersion({ version: "2.9.8" }, "v2.16.3", true), {
    version: "2.16.3-aidesk.0",
    upstreamVersion: "2.16.3",
    counter: 0,
    changed: true,
    reason: "initialize",
  });
});

test("builds and parses the Docker-safe canonical prerelease", () => {
  assert.equal(buildCanonicalVersion("2.16.3", 12), "2.16.3-aidesk.12");
  assert.deepEqual(parseCanonicalVersion("2.16.3-aidesk.12"), {
    upstreamVersion: "2.16.3",
    counter: 12,
  });
});

test("accepts only stable upstream release tags", () => {
  assert.equal(parseUpstreamVersion("v2.16.3"), "2.16.3");
  assert.equal(parseUpstreamVersion("2.16.3"), "2.16.3");

  for (const invalid of [
    "latest",
    "v2.16",
    "2.16.3-beta.1",
    "2.16.3+aidesk.1",
    "v02.16.3",
    "2.16.3 ",
  ]) {
    assert.throws(
      () => parseUpstreamVersion(invalid),
      /Invalid upstream version/,
    );
  }
});

test("rejects invalid or inconsistent canonical metadata", () => {
  for (const metadata of [
    { version: "2.16.3+aidesk.1", upstreamVersion: "2.16.3", counter: 1 },
    { version: "2.16.3-aidesk.1", upstreamVersion: "2.16.2", counter: 1 },
    { version: "2.16.3-aidesk.1", upstreamVersion: "2.16.3", counter: 2 },
    { version: "2.16.3-aidesk.1", upstreamVersion: "2.16.3", counter: -1 },
    { version: "2.16.3-aidesk.01", upstreamVersion: "2.16.3", counter: 1 },
    { version: "2.16.3-aidesk.1", upstreamVersion: "2.16.3" },
  ]) {
    assert.throws(
      () => validateVersionMetadata(metadata),
      /Invalid|must match/,
    );
  }
});

test("rejects a fork counter increment beyond the safe integer range", () => {
  const maximum = {
    version: `2.16.3-aidesk.${Number.MAX_SAFE_INTEGER}`,
    upstreamVersion: "2.16.3",
    counter: Number.MAX_SAFE_INTEGER,
  };

  assert.throws(
    () => computeNextVersion(maximum, "2.16.3", true),
    /maximum safe integer/,
  );
});
