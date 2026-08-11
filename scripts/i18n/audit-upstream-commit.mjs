import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

const args = process.argv.slice(2);
const shouldFix = args.includes("--fix");
const verbose = args.includes("--verbose");
const commit = args.find((arg) => !arg.startsWith("--"));

if (!commit) {
  console.error(
    "Usage: node scripts/i18n/audit-upstream-commit.mjs <commit> [--fix]",
  );
  process.exit(2);
}

const parent = git("rev-parse", `${commit}^`).trim();
const resolvedCommit = git("rev-parse", commit).trim();
const files = git(
  "diff",
  "--name-only",
  parent,
  resolvedCommit,
  "--",
  "i18n/*.json",
)
  .trim()
  .split("\n")
  .filter(Boolean);

let mismatchCount = 0;
let changedLeafCount = 0;

for (const file of files) {
  const before = readGitJson(parent, file);
  const after = readGitJson(resolvedCommit, file);
  const current = JSON.parse(await readFile(file, "utf8"));
  const beforeLeaves = flatten(before);
  const afterLeaves = flatten(after);
  const changedPaths = new Set([...beforeLeaves.keys(), ...afterLeaves.keys()]);
  const changed = [...changedPaths].filter(
    (path) => !sameEntry(beforeLeaves, afterLeaves, path),
  );
  changedLeafCount += changed.length;

  let currentLeaves = flatten(current);
  const mismatches = changed.filter(
    (path) => !sameEntry(afterLeaves, currentLeaves, path),
  );
  mismatchCount += mismatches.length;
  console.log(`${file}: ${mismatches.length}/${changed.length} mismatches`);
  if (verbose) {
    for (const path of mismatches) console.log(`  ${path || "/"}`);
  }

  if (shouldFix && mismatches.length > 0) {
    const deletions = mismatches
      .filter((path) => !afterLeaves.has(path))
      .sort(compareDeletionPaths);
    const additions = mismatches
      .filter((path) => afterLeaves.has(path))
      .sort(
        (left, right) => splitPointer(left).length - splitPointer(right).length,
      );

    for (const path of deletions) deleteAtPointer(current, path);
    for (const path of additions) {
      setAtPointer(current, path, structuredClone(afterLeaves.get(path)));
    }

    await writeFile(file, `${JSON.stringify(current, null, 2)}\n`);
    currentLeaves = flatten(current);
    const remaining = changed.filter(
      (path) => !sameEntry(afterLeaves, currentLeaves, path),
    );
    if (remaining.length > 0) {
      throw new Error(
        `${file}: ${remaining.length} mismatches remain after fix`,
      );
    }
  }
}

console.log(
  `${mismatchCount} mismatches across ${changedLeafCount} source-changed leaves in ${files.length} files.`,
);
process.exit(shouldFix || mismatchCount === 0 ? 0 : 1);

function git(...commandArgs) {
  return execFileSync("git", commandArgs, { encoding: "utf8" });
}

function readGitJson(revision, file) {
  try {
    return JSON.parse(git("show", `${revision}:${file}`));
  } catch (error) {
    if (error.status === 128) return undefined;
    throw error;
  }
}

function flatten(value, path = "", leaves = new Map()) {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.keys(value).length === 0
  ) {
    leaves.set(path, value);
    return leaves;
  }

  for (const [key, child] of Object.entries(value)) {
    flatten(child, `${path}/${escapePointer(key)}`, leaves);
  }
  return leaves;
}

function sameEntry(left, right, path) {
  if (left.has(path) !== right.has(path)) return false;
  if (!left.has(path)) return true;
  return JSON.stringify(left.get(path)) === JSON.stringify(right.get(path));
}

function escapePointer(value) {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function splitPointer(pointer) {
  if (pointer === "") return [];
  return pointer
    .slice(1)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function compareDeletionPaths(left, right) {
  const leftParts = splitPointer(left);
  const rightParts = splitPointer(right);
  if (leftParts.length !== rightParts.length)
    return rightParts.length - leftParts.length;
  const leftLast = leftParts.at(-1);
  const rightLast = rightParts.at(-1);
  if (/^\d+$/.test(leftLast) && /^\d+$/.test(rightLast)) {
    return Number(rightLast) - Number(leftLast);
  }
  return right.localeCompare(left);
}

function deleteAtPointer(root, pointer) {
  const parts = splitPointer(pointer);
  if (parts.length === 0)
    throw new Error("Cannot delete the JSON document root");
  let parentValue = root;
  for (const part of parts.slice(0, -1)) {
    if (parentValue === null || typeof parentValue !== "object") return;
    parentValue = parentValue[part];
  }
  if (parentValue === null || typeof parentValue !== "object") return;
  const key = parts.at(-1);
  if (Array.isArray(parentValue) && /^\d+$/.test(key)) {
    parentValue.splice(Number(key), 1);
  } else {
    delete parentValue[key];
  }
}

function setAtPointer(root, pointer, value) {
  const parts = splitPointer(pointer);
  if (parts.length === 0)
    throw new Error("Cannot replace the JSON document root");
  let parentValue = root;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    const nextPart = parts[index + 1];
    if (parentValue[part] === null || typeof parentValue[part] !== "object") {
      parentValue[part] = /^\d+$/.test(nextPart) ? [] : {};
    }
    parentValue = parentValue[part];
  }
  parentValue[parts.at(-1)] = value;
}
