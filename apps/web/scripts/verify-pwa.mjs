import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const webRoot = path.join(repoRoot, "apps/web");

function fail(message) {
  console.error(message);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

const swPath = path.join(webRoot, "dist/sw.js");
assert(
  existsSync(swPath),
  `Missing service worker at ${path.relative(repoRoot, swPath)}`,
);

const manifestPath = path.join(webRoot, "public/site.webmanifest");
assert(
  existsSync(manifestPath),
  `Missing web manifest at ${path.relative(repoRoot, manifestPath)}`,
);

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (error) {
  fail(
    `Failed to parse ${path.relative(repoRoot, manifestPath)}: ${error instanceof Error ? error.message : String(error)}`,
  );
}

assert(manifest.name, "Web manifest is missing required field: name");
assert(
  manifest.short_name,
  "Web manifest is missing required field: short_name",
);
assert(manifest.start_url, "Web manifest is missing required field: start_url");

const validDisplays = ["standalone", "fullscreen", "minimal-ui"];
assert(
  validDisplays.includes(manifest.display),
  `Web manifest display must be one of ${validDisplays.join(", ")}, got: ${manifest.display ?? "(missing)"}`,
);

assert(
  Array.isArray(manifest.icons) && manifest.icons.length >= 2,
  "Web manifest must define at least 2 icons",
);

function iconHasSizeAndPurpose(icon, size) {
  const sizeToken = size === 192 ? "192x192" : "512x512";
  const sizes = String(icon.sizes ?? "").split(/\s+/);
  if (!sizes.includes(sizeToken)) {
    return false;
  }
  const purpose = String(icon.purpose ?? "any");
  return purpose.split(/\s+/).includes("any");
}

assert(
  manifest.icons.some((icon) => iconHasSizeAndPurpose(icon, 192)),
  "Web manifest must include a 192px icon with purpose including 'any'",
);
assert(
  manifest.icons.some((icon) => iconHasSizeAndPurpose(icon, 512)),
  "Web manifest must include a 512px icon with purpose including 'any'",
);

const distIndexPath = path.join(webRoot, "dist/index.html");
const sourceIndexPath = path.join(webRoot, "index.html");
const indexPath = existsSync(distIndexPath) ? distIndexPath : sourceIndexPath;

assert(
  existsSync(indexPath),
  `Missing index.html at ${path.relative(repoRoot, distIndexPath)} or ${path.relative(repoRoot, sourceIndexPath)}`,
);

const indexHtml = readFileSync(indexPath, "utf8");
assert(
  indexHtml.includes('<link rel="manifest"'),
  `${path.relative(repoRoot, indexPath)} must contain '<link rel="manifest"'`,
);
assert(
  indexHtml.includes('<meta name="theme-color"'),
  `${path.relative(repoRoot, indexPath)} must contain '<meta name="theme-color"'`,
);

console.log("PWA checks passed");
