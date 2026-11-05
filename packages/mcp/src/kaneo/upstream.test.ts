import { describe, expect, it } from "vite-plus/test";
import {
  shouldRetryUpstream,
  UPSTREAM_MAX_RETRY_DELAY_MS,
  upstreamErrorDetail,
  upstreamRetryDelayMs,
} from "./upstream.js";

describe("upstream retry policy", () => {
  it("retries idempotent 429 and 5xx responses a limited number of times", () => {
    for (const status of [429, 502, 503, 504]) {
      expect(shouldRetryUpstream(status, "GET", 0, null)).toBe(true);
      expect(shouldRetryUpstream(status, undefined, 1, null)).toBe(true);
      expect(shouldRetryUpstream(status, "DELETE", 1, null)).toBe(true);
      expect(
        shouldRetryUpstream(status, "get", UPSTREAM_ATTEMPT_LIMIT, null),
      ).toBe(false);
    }
    expect(shouldRetryUpstream(500, "GET", 0, null)).toBe(false);
    expect(shouldRetryUpstream(401, "GET", 0, null)).toBe(false);
  });

  it("retries a non-idempotent request only for 429 or 503 with Retry-After", () => {
    for (const method of ["POST", "PATCH"]) {
      expect(shouldRetryUpstream(429, method, 0, null)).toBe(false);
      expect(shouldRetryUpstream(503, method, 0, "  ")).toBe(false);
      expect(shouldRetryUpstream(502, method, 0, "1")).toBe(false);
      expect(shouldRetryUpstream(504, method, 0, "1")).toBe(false);
      expect(shouldRetryUpstream(429, method, 0, "1")).toBe(true);
      expect(
        shouldRetryUpstream(503, method, 0, "Thu, 05 Nov 2026 16:00:02 GMT"),
      ).toBe(true);
      expect(
        shouldRetryUpstream(429, method, UPSTREAM_ATTEMPT_LIMIT, "1"),
      ).toBe(false);
    }
  });

  it("honors Retry-After seconds and HTTP dates, capped to a short wait", () => {
    expect(UPSTREAM_MAX_RETRY_DELAY_MS).toBeLessThanOrEqual(2_000);
    expect(upstreamRetryDelayMs("2", 0, 0)).toBe(2_000);
    expect(upstreamRetryDelayMs("1.5", 0, 0)).toBe(1_500);
    expect(upstreamRetryDelayMs("120", 0, 0)).toBe(UPSTREAM_MAX_RETRY_DELAY_MS);
    expect(upstreamRetryDelayMs("Thu, 01 Jan 1970 00:00:02 GMT", 0, 0)).toBe(
      2_000,
    );
    expect(upstreamRetryDelayMs("Thu, 01 Jan 1970 00:00:30 GMT", 0, 0)).toBe(
      UPSTREAM_MAX_RETRY_DELAY_MS,
    );
    expect(
      upstreamRetryDelayMs("Thu, 01 Jan 1970 00:00:00 GMT", 0, 5_000),
    ).toBe(0);
    expect(upstreamRetryDelayMs(null, 0, 0)).toBe(200);
    expect(upstreamRetryDelayMs("soon", 1, 0)).toBe(400);
  });

  it("keeps a message, and otherwise keeps issues or code", () => {
    expect(
      upstreamErrorDetail(404, {
        message: "Task not found",
        code: "NOT_FOUND",
      }),
    ).toBe("Task not found (NOT_FOUND)");
    expect(
      upstreamErrorDetail(400, {
        code: "VALIDATION_ERROR",
        issues: [{ path: "body.title", message: "Required" }],
      }),
    ).toBe("body.title: Required (VALIDATION_ERROR)");
    expect(upstreamErrorDetail(429, { code: "RATE_LIMITED" })).toBe(
      "RATE_LIMITED",
    );
    expect(
      upstreamErrorDetail(400, { message: " ", code: "VALIDATION_ERROR" }),
    ).toBe("VALIDATION_ERROR");
    expect(upstreamErrorDetail(400, {})).toBe("HTTP 400");
    expect(upstreamErrorDetail(404, "missing")).toBe("missing");
  });
});

const UPSTREAM_ATTEMPT_LIMIT = 2;
