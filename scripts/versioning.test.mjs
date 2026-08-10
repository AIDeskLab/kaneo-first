import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCanonicalVersion,
  incrementForkVersion,
  parseArguments,
  parseCanonicalVersion,
  parseUpstreamVersion,
  synchronizeUpstreamVersion,
  validateVersionMetadata,
} from "./versioning.mjs";

const current = {
  version: "2.16.3-aidesk.4",
  upstreamVersion: "2.16.3",
  counter: 4,
};

test("increments only the fork counter without an upstream argument", () => {
  assert.deepEqual(incrementForkVersion(current), {
    version: "2.16.3-aidesk.5",
    upstreamVersion: "2.16.3",
    counter: 5,
    changed: true,
    reason: "increment",
  });
});

test("explicitly synchronizes to a newer upstream base and resets the counter", () => {
  assert.deepEqual(synchronizeUpstreamVersion(current, "2.17.0"), {
    version: "2.17.0-aidesk.0",
    upstreamVersion: "2.17.0",
    counter: 0,
    changed: true,
    reason: "upstream-sync",
  });
});

test("synchronizing the same upstream base is idempotent", () => {
  assert.deepEqual(synchronizeUpstreamVersion(current, "v2.16.3"), {
    ...current,
    changed: false,
    reason: "unchanged",
  });
});

test("rejects an upstream downgrade", () => {
  assert.throws(
    () => synchronizeUpstreamVersion(current, "2.15.9"),
    /Refusing upstream downgrade/,
  );
});

test("resets the counter when a huge upstream component is higher", () => {
  const huge = {
    version: "9007199254740992.0.0-aidesk.4",
    upstreamVersion: "9007199254740992.0.0",
    counter: 4,
  };

  assert.deepEqual(synchronizeUpstreamVersion(huge, "9007199254740993.0.0"), {
    version: "9007199254740993.0.0-aidesk.0",
    upstreamVersion: "9007199254740993.0.0",
    counter: 0,
    changed: true,
    reason: "upstream-sync",
  });
});

test("rejects a downgrade when a huge upstream component is lower", () => {
  const huge = {
    version: "9007199254740993.0.0-aidesk.4",
    upstreamVersion: "9007199254740993.0.0",
    counter: 4,
  };

  assert.throws(
    () => synchronizeUpstreamVersion(huge, "9007199254740992.0.0"),
    /Refusing upstream downgrade/,
  );
});

test("keeps canonical metadata unchanged for equal huge components", () => {
  const huge = {
    version: "9007199254740993.0.0-aidesk.4",
    upstreamVersion: "9007199254740993.0.0",
    counter: 4,
  };

  assert.deepEqual(synchronizeUpstreamVersion(huge, "9007199254740993.0.0"), {
    ...huge,
    changed: false,
    reason: "unchanged",
  });
});

test("initializes legacy metadata from its current base when incrementing", () => {
  assert.deepEqual(incrementForkVersion({ version: "2.9.8" }), {
    version: "2.9.8-aidesk.1",
    upstreamVersion: "2.9.8",
    counter: 1,
    changed: true,
    reason: "increment",
  });
});

test("initializes legacy metadata at zero only through explicit sync", () => {
  assert.deepEqual(
    synchronizeUpstreamVersion({ version: "2.9.8" }, "v2.16.3"),
    {
      version: "2.16.3-aidesk.0",
      upstreamVersion: "2.16.3",
      counter: 0,
      changed: true,
      reason: "initialize",
    },
  );
});

test("requires a valid explicit upstream version only for sync", () => {
  assert.deepEqual(parseArguments(["increment"]), {
    command: "increment",
    upstreamVersion: undefined,
  });
  assert.throws(() => parseArguments(["sync"]), /requires --upstream-version/);
  assert.throws(
    () => parseArguments(["sync", "--upstream-version"]),
    /requires --upstream-version/,
  );
  assert.throws(
    () => synchronizeUpstreamVersion(current, "latest"),
    /Invalid upstream version/,
  );
  assert.throws(
    () => parseArguments(["increment", "--upstream-version", "2.17.0"]),
    /does not accept --upstream-version/,
  );
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

  assert.throws(() => incrementForkVersion(maximum), /maximum safe integer/);
});
