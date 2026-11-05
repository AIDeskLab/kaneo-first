import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// App images are published as vX.Y.Z or X.Y.Z. Package releases such as
// mcp-v0.1.14 and cli-v0.1.1 are stable GitHub releases, but they are not
// Kaneo images and fail the SemVer check used for the upgrade baseline.
const APP_RELEASE_TAG =
  /^(?:v)?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

export function selectAppReleaseTag(releases) {
  for (const release of releases) {
    if (!release || release.draft || release.prerelease) continue;
    const tag = release.tag_name;
    if (typeof tag === "string" && APP_RELEASE_TAG.test(tag)) return tag;
  }
  return null;
}

function readReleases(raw) {
  const releases = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    releases.push(JSON.parse(trimmed));
  }
  return releases;
}

// Exit 2 when no app release matches so upgrade.sh can skip the step.
async function main() {
  const tag = selectAppReleaseTag(readReleases(readFileSync(0, "utf8")));
  if (!tag) process.exit(2);
  process.stdout.write(`${tag}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
