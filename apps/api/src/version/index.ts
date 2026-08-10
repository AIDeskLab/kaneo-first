import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import * as v from "valibot";
import packageJson from "../../../../package.json";

export const versionInfo = {
  version: packageJson.version,
  upstreamVersion: packageJson.upstreamVersion,
  forkCounter: packageJson.counter,
};

const version = new Hono().get(
  "/",
  describeRoute({
    operationId: "getVersion",
    tags: ["Version"],
    description: "Get the canonical AIDesk Kaneo fork version",
    // Version metadata is intentionally public, like /api/health and
    // /api/instance/status, so deployments can be identified before login.
    security: [],
    responses: {
      200: {
        description: "Canonical fork and upstream version metadata",
        content: {
          "application/json": {
            schema: resolver(
              v.object({
                version: v.string(),
                upstreamVersion: v.string(),
                forkCounter: v.number(),
              }),
            ),
          },
        },
      },
    },
  }),
  (c) => c.json(versionInfo),
);

export default version;
