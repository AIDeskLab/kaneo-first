import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { selectAppReleaseTag } from "./app-release-tag.mjs";

const execFileAsync = promisify(execFile);
const script = join(
  dirname(fileURLToPath(import.meta.url)),
  "app-release-tag.mjs",
);

test("keeps the newest app tag and skips package releases", () => {
  assert.equal(
    selectAppReleaseTag([
      { tag_name: "mcp-v0.1.14", draft: false, prerelease: false },
      { tag_name: "cli-v0.1.1", draft: false, prerelease: false },
      { tag_name: "v2.49.0", draft: false, prerelease: false },
      { tag_name: "v2.48.0", draft: false, prerelease: false },
    ]),
    "v2.49.0",
  );
});

test("accepts an unprefixed X.Y.Z tag", () => {
  assert.equal(
    selectAppReleaseTag([
      { tag_name: "2.49.0", draft: false, prerelease: false },
    ]),
    "2.49.0",
  );
});

test("returns null when nothing is a stable app release", () => {
  assert.equal(
    selectAppReleaseTag([
      { tag_name: "mcp-v0.1.14", draft: false, prerelease: false },
      { tag_name: "cli-v0.1.1", draft: false, prerelease: false },
      { tag_name: "v2.49.0-rc.1", draft: false, prerelease: false },
      { tag_name: "v2.49.0", draft: true, prerelease: false },
      { tag_name: "v2.48.0", draft: false, prerelease: true },
      { tag_name: "v01.2.3", draft: false, prerelease: false },
      { tag_name: "v1.2.3+build", draft: false, prerelease: false },
      { tag_name: "v1.2", draft: false, prerelease: false },
    ]),
    null,
  );
  assert.equal(selectAppReleaseTag([]), null);
});

function pipeToCli(lines) {
  const payload = lines.map((line) => JSON.stringify(line)).join("\n");
  return execFileAsync("bash", [
    "-c",
    'printf "%s\\n" "$1" | node "$2"',
    "bash",
    payload,
    script,
  ]);
}

test("cli prints the selected tag", async () => {
  const { stdout } = await pipeToCli([
    { tag_name: "mcp-v0.1.14", draft: false, prerelease: false },
    { tag_name: "v1.2.3", draft: false, prerelease: false },
  ]);
  assert.equal(stdout, "v1.2.3\n");
});

test("cli exits 2 when no app release matches", async () => {
  await assert.rejects(
    pipeToCli([{ tag_name: "mcp-v0.1.14", draft: false, prerelease: false }]),
    (error) => error.code === 2 && error.stdout === "",
  );
});
