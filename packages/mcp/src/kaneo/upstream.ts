/**
 * Shared Kaneo HTTP policy for `KaneoClient` and the in-process MCP
 * `ApiClient`. A timeout is reported by name, and a short upstream failure
 * can be repeated. This module is an implementation detail of those clients.
 */

export const UPSTREAM_TIMEOUT_MS = 10_000;
/** Extra attempts after the first response. */
export const UPSTREAM_MAX_RETRIES = 2;
/**
 * Longest pause between attempts. `Retry-After` is honored up to this cap
 * so one tool call cannot sleep for a multi-minute rate-limit window.
 */
export const UPSTREAM_MAX_RETRY_DELAY_MS = 2_000;

const BACKOFF_BASE_MS = 200;
const DETAIL_LIMIT = 500;
const RETRY_STATUSES = new Set([429, 502, 503, 504]);
const IDEMPOTENT_METHODS = new Set([
  "GET",
  "HEAD",
  "OPTIONS",
  "PUT",
  "DELETE",
  "TRACE",
]);

export function isIdempotentMethod(method: string | undefined): boolean {
  return IDEMPOTENT_METHODS.has((method ?? "GET").toUpperCase());
}

/**
 * Idempotent requests retry every 429/502/503/504. POST and PATCH do not:
 * a 502 or 504 means the gateway lost the upstream response, so the write
 * may already have been applied. Those methods retry only a 429 or 503 that
 * carries `Retry-After`, which is the server saying the request can be
 * repeated. A timeout is not retried; the attempt already ran for 10s and
 * the outcome is ambiguous.
 */
export function shouldRetryUpstream(
  status: number,
  method: string | undefined,
  attempt: number,
  retryAfter: string | null,
): boolean {
  if (attempt >= UPSTREAM_MAX_RETRIES) return false;
  if (!RETRY_STATUSES.has(status)) return false;
  if (isIdempotentMethod(method)) return true;
  return (
    (status === 429 || status === 503) &&
    retryAfter != null &&
    retryAfter.trim() !== ""
  );
}

export function upstreamRetryDelayMs(
  retryAfter: string | null,
  attempt: number,
  now = Date.now(),
): number {
  const requested = parseRetryAfterMs(retryAfter, now);
  if (requested == null) {
    return Math.min(
      BACKOFF_BASE_MS * 2 ** attempt,
      UPSTREAM_MAX_RETRY_DELAY_MS,
    );
  }
  return Math.min(Math.max(0, requested), UPSTREAM_MAX_RETRY_DELAY_MS);
}

export function upstreamErrorDetail(status: number, body: unknown): string {
  if (typeof body === "string" && body.length > 0) return clip(body);
  if (!isRecord(body)) return `HTTP ${status}`;

  if (typeof body.message === "string" && body.message.trim().length > 0) {
    const code =
      typeof body.code === "string" && body.code.length > 0
        ? ` (${body.code})`
        : "";
    return `${body.message}${code}`;
  }

  const fields = fieldError(body);
  if (fields) return clip(fields);
  return `HTTP ${status}`;
}

export function upstreamCallError(path: string, error: unknown): Error {
  if (isAbortOrTimeout(error)) return new Error(`${path}: timeout`);
  if (error instanceof Error) return error;
  return new Error(String(error));
}

export async function fetchUpstream(
  url: string,
  path: string,
  init: RequestInit | undefined,
  headers: Headers,
): Promise<Response> {
  const callerSignal = init?.signal ?? undefined;
  let attempt = 0;

  for (;;) {
    const timeoutSignal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, timeoutSignal])
      : timeoutSignal;

    let response: Response;
    try {
      response = await fetch(url, { ...init, headers, signal });
    } catch (error) {
      throw upstreamCallError(path, error);
    }

    const retryAfter = response.headers.get("retry-after");
    if (
      !shouldRetryUpstream(response.status, init?.method, attempt, retryAfter)
    ) {
      return response;
    }

    await release(response);
    const delayMs = upstreamRetryDelayMs(retryAfter, attempt);
    attempt += 1;
    try {
      await waitForRetry(delayMs, callerSignal);
    } catch (error) {
      throw upstreamCallError(path, error);
    }
  }
}

export async function parseUpstreamJson<T>(
  response: Response,
  path: string,
): Promise<T> {
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = text;
    }
  }
  if (!response.ok) {
    throw new Error(`${path}: ${upstreamErrorDetail(response.status, body)}`);
  }
  return body as T;
}

function parseRetryAfterMs(header: string | null, now: number): number | null {
  if (header == null) return null;
  const value = header.trim();
  if (!value) return null;
  if (/^\d+(?:\.\d+)?$/.test(value)) return Math.round(Number(value) * 1000);
  const date = Date.parse(value);
  if (Number.isNaN(date)) return null;
  return date - now;
}

function fieldError(body: Record<string, unknown>): string | null {
  const nested = isRecord(body.error) ? body.error : null;
  const issues = presentIssues(body.issues) ?? presentIssues(nested?.issues);
  const code = presentCode(body.code) ?? presentCode(nested?.code);
  if (issues === undefined && code === undefined) return null;

  const issuesText = formatIssues(issues);
  const codeText = formatCode(code);
  if (issuesText && codeText) return `${issuesText} (${codeText})`;
  if (issuesText) return issuesText;
  if (codeText) return codeText;
  return null;
}

function presentIssues(value: unknown): unknown | undefined {
  if (value == null) return undefined;
  if (Array.isArray(value) && value.length === 0) return undefined;
  return value;
}

function presentCode(value: unknown): unknown | undefined {
  if (value == null || value === "") return undefined;
  return value;
}

function formatIssues(issues: unknown): string | null {
  if (issues == null) return null;
  if (!Array.isArray(issues)) return JSON.stringify(issues);
  const parts = issues.slice(0, 20).map((issue) => formatIssue(issue));
  return parts.length > 0 ? parts.join("; ") : null;
}

function formatIssue(issue: unknown): string {
  if (typeof issue === "string") return issue;
  if (!isRecord(issue)) return JSON.stringify(issue) ?? String(issue);
  const path = formatIssuePath(issue.path);
  const message = typeof issue.message === "string" ? issue.message : "";
  if (path && message) return `${path}: ${message}`;
  if (message) return message;
  if (path) return path;
  return JSON.stringify(issue) ?? "invalid";
}

function formatIssuePath(path: unknown): string {
  if (typeof path === "string" || typeof path === "number") return String(path);
  if (!Array.isArray(path)) return "";
  return path
    .map((segment) => {
      if (typeof segment === "string" || typeof segment === "number") {
        return String(segment);
      }
      if (
        isRecord(segment) &&
        (typeof segment.key === "string" || typeof segment.key === "number")
      ) {
        return String(segment.key);
      }
      return "";
    })
    .filter((segment) => segment.length > 0)
    .join(".");
}

function formatCode(code: unknown): string | null {
  if (code == null) return null;
  if (typeof code === "string") return code.length > 0 ? code : null;
  if (typeof code === "number" && Number.isFinite(code)) return String(code);
  return JSON.stringify(code);
}

function clip(text: string): string {
  return text.length > DETAIL_LIMIT ? `${text.slice(0, DETAIL_LIMIT)}…` : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortOrTimeout(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== "object" || depth > 2) return false;
  const name = "name" in error ? error.name : undefined;
  if (name === "AbortError" || name === "TimeoutError") return true;
  if ("cause" in error && error.cause && error.cause !== error) {
    return isAbortOrTimeout(error.cause, depth + 1);
  }
  return false;
}

async function release(response: Response): Promise<void> {
  if (!response.body) return;
  try {
    await response.body.cancel();
  } catch {
    // The body may already be closed.
  }
}

function waitForRetry(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortReason(signal: AbortSignal | undefined): unknown {
  return (
    signal?.reason ??
    new DOMException("This operation was aborted", "AbortError")
  );
}
