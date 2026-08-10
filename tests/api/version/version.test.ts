import { expect, test } from "vitest";
import { createApp } from "../../../apps/api/src";
import packageJson from "../../../package.json";

test("GET /api/version is public and returns canonical version metadata", async () => {
  const { app } = createApp();
  const response = await app.request("/api/version");

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({
    version: packageJson.version,
    upstreamVersion: packageJson.upstreamVersion,
    forkCounter: packageJson.counter,
  });
});
