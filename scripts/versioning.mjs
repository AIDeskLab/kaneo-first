import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const STABLE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const CANONICAL_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-aidesk\.(0|[1-9]\d*)$/;

export function parseUpstreamVersion(value) {
  if (typeof value !== "string") {
    throw new Error(`Invalid upstream version: ${String(value)}`);
  }

  const normalized = value.startsWith("v") ? value.slice(1) : value;
  if (!STABLE_VERSION_PATTERN.test(normalized)) {
    throw new Error(`Invalid upstream version: ${value}`);
  }

  return normalized;
}

export function buildCanonicalVersion(upstreamVersion, counter) {
  const normalizedUpstream = parseUpstreamVersion(upstreamVersion);
  if (!Number.isSafeInteger(counter) || counter < 0) {
    throw new Error(`Invalid fork counter: ${String(counter)}`);
  }

  return `${normalizedUpstream}-aidesk.${counter}`;
}

export function parseCanonicalVersion(value) {
  if (typeof value !== "string") {
    throw new Error(`Invalid canonical version: ${String(value)}`);
  }

  const match = CANONICAL_VERSION_PATTERN.exec(value);
  if (!match) {
    throw new Error(`Invalid canonical version: ${value}`);
  }

  return {
    upstreamVersion: `${match[1]}.${match[2]}.${match[3]}`,
    counter: Number(match[4]),
  };
}

export function validateVersionMetadata(metadata) {
  if (!metadata || typeof metadata !== "object") {
    throw new Error("Invalid version metadata: expected an object");
  }

  const upstreamVersion = parseUpstreamVersion(metadata.upstreamVersion);
  const canonicalVersion = buildCanonicalVersion(
    upstreamVersion,
    metadata.counter,
  );
  const parsedVersion = parseCanonicalVersion(metadata.version);

  if (
    parsedVersion.upstreamVersion !== upstreamVersion ||
    parsedVersion.counter !== metadata.counter ||
    metadata.version !== canonicalVersion
  ) {
    throw new Error(
      `Version metadata must match canonical version ${canonicalVersion}`,
    );
  }

  return {
    version: canonicalVersion,
    upstreamVersion,
    counter: metadata.counter,
  };
}

function compareStableVersions(left, right) {
  const leftParts = parseUpstreamVersion(left).split(".").map(BigInt);
  const rightParts = parseUpstreamVersion(right).split(".").map(BigInt);

  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] > rightParts[index]) return 1;
    if (leftParts[index] < rightParts[index]) return -1;
  }

  return 0;
}

function parseCurrentState(metadata) {
  const hasUpstreamVersion = metadata.upstreamVersion !== undefined;
  const hasCounter = metadata.counter !== undefined;

  if (!hasUpstreamVersion && !hasCounter) {
    const legacyVersion = parseUpstreamVersion(metadata.version);
    return { kind: "legacy", upstreamVersion: legacyVersion };
  }

  if (!hasUpstreamVersion || !hasCounter) {
    throw new Error(
      "Invalid version metadata: upstreamVersion and counter must both be present",
    );
  }

  return { kind: "canonical", ...validateVersionMetadata(metadata) };
}

export function incrementForkVersion(metadata) {
  const currentState = parseCurrentState(metadata);
  const counter = currentState.kind === "legacy" ? 1 : currentState.counter + 1;
  if (!Number.isSafeInteger(counter)) {
    throw new Error("Fork counter exceeds the maximum safe integer");
  }
  return {
    version: buildCanonicalVersion(currentState.upstreamVersion, counter),
    upstreamVersion: currentState.upstreamVersion,
    counter,
    changed: true,
    reason: "increment",
  };
}

export function synchronizeUpstreamVersion(metadata, upstreamTag) {
  const upstreamVersion = parseUpstreamVersion(upstreamTag);
  const currentState = parseCurrentState(metadata);
  const comparison = compareStableVersions(
    upstreamVersion,
    currentState.upstreamVersion,
  );

  if (comparison < 0) {
    throw new Error(
      `Refusing upstream downgrade from ${currentState.upstreamVersion} to ${upstreamVersion}`,
    );
  }

  if (currentState.kind === "canonical" && comparison === 0) {
    return {
      version: currentState.version,
      upstreamVersion: currentState.upstreamVersion,
      counter: currentState.counter,
      changed: false,
      reason: "unchanged",
    };
  }

  return {
    version: buildCanonicalVersion(upstreamVersion, 0),
    upstreamVersion,
    counter: 0,
    changed: true,
    reason: currentState.kind === "legacy" ? "initialize" : "upstream-sync",
  };
}

export function parseArguments(argv) {
  const [command, ...argumentsList] = argv;
  let upstreamVersion;

  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--upstream-version") {
      upstreamVersion = argumentsList[index + 1];
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (!command || !["check", "increment", "sync"].includes(command)) {
    throw new Error(
      "Usage: node scripts/versioning.mjs <check|increment|sync> [--upstream-version <tag>]",
    );
  }

  if (command === "sync" && !upstreamVersion) {
    throw new Error("sync requires --upstream-version <tag>");
  }
  if (command !== "sync" && upstreamVersion !== undefined) {
    throw new Error(`${command} does not accept --upstream-version`);
  }

  return { command, upstreamVersion };
}

function validateChart(chartYaml, expectedVersion) {
  const chartVersion = /^version:\s*(\S+)$/m.exec(chartYaml)?.[1];
  const appVersion = /^appVersion:\s*["']?([^"'\s]+)["']?$/m.exec(
    chartYaml,
  )?.[1];

  if (chartVersion !== expectedVersion || appVersion !== expectedVersion) {
    throw new Error(
      `Chart version/appVersion must both match package version ${expectedVersion}`,
    );
  }
}

function updateChart(chartYaml, version) {
  const withChartVersion = chartYaml.replace(
    /^version:\s*\S+$/m,
    `version: ${version}`,
  );
  const updated = withChartVersion.replace(
    /^appVersion:\s*["']?[^"'\s]+["']?$/m,
    `appVersion: "${version}"`,
  );

  if (updated === chartYaml && !chartYaml.includes(version)) {
    throw new Error("Unable to update charts/kaneo/Chart.yaml");
  }

  validateChart(updated, version);
  return updated;
}

async function runCli() {
  const { command, upstreamVersion } = parseArguments(process.argv.slice(2));
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const packagePath = resolve(repositoryRoot, "package.json");
  const chartPath = resolve(repositoryRoot, "charts/kaneo/Chart.yaml");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  const chartYaml = await readFile(chartPath, "utf8");

  if (command === "check") {
    const metadata = validateVersionMetadata(packageJson);
    validateChart(chartYaml, metadata.version);
    console.log(JSON.stringify({ ...metadata, valid: true }));
    return;
  }

  const next =
    command === "increment"
      ? incrementForkVersion(packageJson)
      : synchronizeUpstreamVersion(packageJson, upstreamVersion);
  packageJson.version = next.version;
  packageJson.upstreamVersion = next.upstreamVersion;
  packageJson.counter = next.counter;
  const nextChartYaml = updateChart(chartYaml, next.version);

  await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
  await writeFile(chartPath, nextChartYaml);
  console.log(JSON.stringify(next));
}

const isMainModule =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMainModule) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
