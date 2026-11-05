import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const upgradeScript = "scripts/ci/upgrade.sh";

async function withFakeGh(body, run) {
  const bin = mkdtempSync(join(tmpdir(), "kaneo-gh-"));
  writeFileSync(join(bin, "gh"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  try {
    return await run({
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_REPOSITORY: "example/planed",
      GITHUB_REPOSITORY_OWNER: "example",
    });
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
}

test("upgrade.sh skips package releases that are not app tags", async () => {
  const { stdout } = await withFakeGh(
    `
printf '%s\n' '{"tag_name":"mcp-v0.1.14","draft":false,"prerelease":false}'
printf '%s\n' '{"tag_name":"cli-v0.1.1","draft":false,"prerelease":false}'
`,
    (env) =>
      execFileAsync("bash", [upgradeScript], {
        env,
      }),
  );
  assert.match(stdout, /No stable app release matching vX\.Y\.Z/);
  assert.match(stdout, /Skipping the upgrade check/);
});

test("upgrade.sh skips a 404 from the releases list", async () => {
  const { stdout } = await withFakeGh(
    `
echo 'HTTP 404: Not Found' >&2
exit 1
`,
    (env) => execFileAsync("bash", [upgradeScript], { env }),
  );
  assert.match(stdout, /releases returned 404/);
  assert.match(stdout, /Skipping the upgrade check/);
});

test("upgrade.sh still fails on other gh errors", async () => {
  await assert.rejects(
    withFakeGh(
      `
echo 'HTTP 401: Bad credentials' >&2
exit 1
`,
      (env) => execFileAsync("bash", [upgradeScript], { env }),
    ),
    (error) =>
      error.code === 1 &&
      String(error.stderr).includes("HTTP 401: Bad credentials"),
  );
});
