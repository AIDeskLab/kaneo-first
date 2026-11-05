# MCP server audit

## Status after upstream sync (067ae03)

Re-checked at `f9a1f16f` (`origin/main`), which contains merge `067ae039` (pull request #24, `sync/upstream-20261104`). The sections below this one are the audit written at `e83fe1ec`, before that sync. They are the historical record. This section is the status of those findings on the current tree. Product code was not changed.

The sync replaced the in-memory session map on the request path with upstream's stateless handler, pinned `@modelcontextprotocol/sdk` `1.32.2` and `@modelcontextprotocol/server` `2.4.0`, and folded both MCP surfaces onto `packages/mcp` `registerTools` (`@kaneo/mcp` `0.1.14`). Those package versions match `upstream/main` at the time of this check. There is one registrar. `apps/api/src/mcp/tools.ts` is a thin client around it, not a second tool list.

Checked live, the same way as the original audit. A throwaway Postgres 16 database and an API process from this tree (`tsx` loading `apps/api/src/index.ts`) listened on `127.0.0.1:1347`. Port 1337 was already taken, so this process did not reuse it or the Compose database. `KANEO_API_URL` was `http://127.0.0.1:9` (nothing listening). `KANEO_INTERNAL_API_URL` was `http://127.0.0.1:1347`. Node was v24.22.1. Clients were `@modelcontextprotocol/sdk` `1.32.2` `Client` with `StreamableHTTPClientTransport` and `StdioClientTransport`. No external calls.

| Item | Status | Evidence |
| --- | --- | --- |
| Finding 1. Stranded sessions, then HTTP 503 | Fixed | `apps/api/src/mcp/index.ts:333-360` accepts only POST and builds a stateless transport (`sessionIdGenerator: undefined`) or `createModernMcpHandler`. The handler does not import `session-admission.ts`. Live: eight SDK clients for one user all listed tools. Every `sessionId` was null. None returned 503. `GET` and `DELETE` `/api/mcp` are 405. A `tools/list` that sent `mcp-session-id: missing-session` was 200, not 404. |
| Finding 2. Missing `Accept` reported as capacity | Fixed | `index.ts` returns the SDK response. It does not replace an empty `sessionId` with 503. Live, on an empty server: initialize without `Accept` was 406 `Not Acceptable: Client must accept both application/json and text/event-stream`. Invalid JSON was 400 `-32700`. A `text/plain` body was 415. |
| Finding 3. `whoami` null success and session token | Partially fixed | A live API key on HTTP and on stdio returned `isError: false` and `{ id, name, email, role }` with no `token` and no `session` (`packages/mcp/src/tools/get-current-user.ts:4-21`). `GET /api/auth/get-session` for that key is still HTTP 200 with `session.token`; the tool schema drops it. `Bearer bad` on `/api/mcp` is 401. stdio with `KANEO_API_KEY=bad` was `isError: true` (`/api/user/me: Unauthorized (UNAUTHORIZED)`) in 536ms. stdio with no key still runs the device flow: the client got `MCP error -32001: Request timed out` at 3.5s and stderr asked for device approval (`packages/mcp/src/auth/auth-service.ts:75-123`). `register.test.ts:141-156` still expects a null session to be `isError: false`. HTTP `ApiClient.usingApiKey` is hardcoded `false` (`apps/api/src/mcp/tools.ts:30`), same as upstream, so HTTP `whoami` uses `get-session` rather than `/api/user/me`. |
| Finding 4. `get_my_tasks` calls `/api/task/tasks/my` | Fixed | The tool is not registered. HTTP and stdio both listed the same 42 names, and `get_my_tasks` was not one of them. Live `GET /api/task/my` was 200 `{ tasks, total }`. Live `GET /api/task/tasks/my` was 404 `Project not found`. The wrong call is gone because the fork tool was dropped with the second registrar. See new issues. |
| Finding 5. Schemas and the two wrong writes | Partially fixed | `delete_label` calls `DELETE /api/label/:id` (`packages/mcp/src/tools/register.ts:621-654`). Live delete of a workspace label was `isError: false`, and that row was gone. `list_tasks` with no `limit` returned `pagination.pageSize` 50 (`apps/api/src/task/controllers/get-tasks.ts:137-138`); the description already says that. `priority: "critical"` is rejected by the tool and by `POST /api/task/:projectId` (400 `VALIDATION_ERROR`). Still open: `dueDate: "2026-12-01"` is `-32602` on HTTP and stdio (`register.ts:31`), while the same REST body is 200 and stores `2026-12-01T00:00:00.000Z`. `update_project` still sends `{ name, icon, slug, description, isPublic }` (`register.ts:199`); live, a description change cleared `projectGroupId` because `update-project.ts:69` writes `projectGroupId ?? null`. `attach_label_to_task` still inserts a new row (`assign-label-to-task.ts:120-131`). Live attach returned a different id, and detach of the id the agent already had was `Label is not assigned to a task`. `KaneoClient` still retries only a non-key 401 (`packages/mcp/src/kaneo/client.ts:37-47`). No `Retry-After`. |
| Finding 6. OAuth refresh and metadata URL | Partially fixed | `schemas.ts:30-43` accepts `refresh_token` in `grant_types` on purpose. Live `POST /api/mcp/register` with `["authorization_code", "refresh_token"]` was 200 and the response body was `grant_types: ["authorization_code"]`. `["refresh_token"]` alone was 400. `POST /api/mcp/token` with `grant_type=refresh_token` was 400 `unsupported_grant_type` (`index.ts:258-259`). `exchangeCode` still returns a 30-day access token and no refresh token (`oauth.ts:151-161`). Anonymous `POST /api/mcp` advertised `http://127.0.0.1:9/.well-known/oauth-protected-resource/api/mcp` (`index.ts:315-323`). Expiry sweep compares `expires_at` with `now() AT TIME ZONE 'UTC'` (`oauth-store.ts:19-24`). The column is still `timestamp` without time zone (`schema.ts:1442`). This run did not change the server timezone. |
| Finding 7. Protocol 2026 and self-fetch | Fixed | `createModernMcpHandler` (`modern.ts:6-28`) served `tools/list` for protocol `2026-07-28` with the per-request envelope: HTTP 200, `Content-Type: application/json`, no session id. Tool calls succeeded while `KANEO_API_URL` pointed at a closed port, so they used `KANEO_INTERNAL_API_URL` (`index.ts:40-44`). A stale session id was not a 404. Residual, same split as upstream: a legacy initialize with `protocolVersion: "2026-07-28"` negotiates `2025-11-25`, `capabilities.tools.listChanged: true`, and `serverInfo.version` `1.0.0` (`legacy-server.ts:10`; the npm package is 0.1.14). A later POST that keeps header `mcp-protocol-version: 2026-07-28` without the modern `_meta` envelope is 400 missing `_meta`, not a tool result. |
| Finding 8. Tests miss the failures | Partially fixed | `tests/api/mcp-stateless.test.ts` covers a sessionless 2026 `tools/list`, strips `whoami` secrets, and checks bearer auth per POST. `tests/api/mcp-internal-api-url.test.ts` covers the internal fetch host. `packages/mcp/src/tools/register.test.ts` covers API-key `whoami` and the safe session shape. Still open: nothing drives a real SDK client at the route, nothing asserts `GET /api/task/my`, and `register.test.ts:338-352` locks the date-only rejection in. `tests/api/mcp-session-admission.test.ts` asserts the stateless `/api/mcp` route never consults a session map. |
| Old stage 1. Transport failures vs a full server | Fixed | The 406/400/415 behavior and the eight-client burst above are what that stage asked to prove. `nginx.kaneo.conf:56-67` still proxies `/api/` with `Connection: upgrade` and default buffering. `GET /api/mcp` is 405, so a buffered SSE stream no longer deletes a session and turns the next POST into 404. |
| Old stage 2. Authentication visible to the host | Partially fixed | Profile `whoami`, no `session` object, explicit `refresh_token` on register, and the host-root `WWW-Authenticate` path are in. The device-flow hang and the fact that refresh is not issued are not. |
| Old stage 3. One registrar, matching the routes | Partially fixed | Both surfaces call `registerTools`, the lists match, workspace `delete_label` deletes, and `list_tasks` is paged. Dates, `projectGroupId`, the attach/detach id, and `get_my_tasks` are not. |
| Old stage 4. Bound the Kaneo calls | Partially fixed | Tool fetch uses `KANEO_INTERNAL_API_URL` (default `http://127.0.0.1:1337`). The board page size is 50. Retries, `Retry-After`, and a timeout message that names the path are not. Session counts on `/api/health` do not apply: live `/api/health` is `{ "status": "ok" }` and there is no session table. |
| Old stage 5. Stateless 2026 handler | Fixed | The split in `index.ts:333-360` is that handler. SDK and `@modelcontextprotocol/server` are pinned at the versions named in the old plan. Two replicas were not run; the live stale session id returning 200 is the property that stage was protecting. |

### New issues from the merge

The fork did not keep a second copy of the tool list, and it did not fork the SDK. At the recheck, `git diff upstream/main -- apps/api/src/mcp packages/mcp/src` was `session-admission.ts` (present only here), the API-key branch in `validateBearerToken` (`index.ts:64-74`; upstream returns null when `getSession` misses), cascade wording on `update_task_status` and `delete_task`, and an em dash in the CLI help. Stage 7 deletes `session-admission.ts`.

- `apps/api/src/mcp/session-admission.ts` is deleted. `shutdownMcpSessions` (`index.ts:365-367`) stays empty so `apps/api/src/index.ts` can still call it. `tests/api/mcp-session-admission.test.ts` asserts the `/api/mcp` route never consults a session map.
- The fork tool `get_my_tasks` (added for `GET /api/task/my`) is not on the shared registrar. HTTP and stdio agree, and both omit it. Docs that said the lists match are true again. The endpoint is not reachable from MCP.
- HTTP `whoami` depends on Better Auth turning an API key into a session (`enableSessionForAPIKeys`). The tool then drops `session.token`. stdio with a key calls `/api/user/me` instead. Both returned the same profile in this run. A `get-session` body of `null` is still a successful tool result.

## Fix plan

The old stages 1-5 are the historical plan. Fix-plan stages 1-7 are done. Do not put a process-local session map back in front of `/api/mcp`.

| Stage | Status | Pull request |
| --- | --- | --- |
| 1. Keep a project's group across `update_project` | Done | #26 |
| 2. Accept the calendar dates the API already accepts | Done | #28 |
| 3. Detach the label id that attach returns | Done | #29 |
| 4. Expose `GET /api/task/my` as `get_my_tasks` | Done | #30 |
| 5. Do not spend a tool call on the device-code poll | Done | #31 |
| 6. Retry a short upstream failure, and name a timeout | Done | #32 |
| 7. Remove the unused session map | Done | this pull request |

### Stage 1. Keep a project's group across `update_project`

`update_project` GET-merges and then omits `projectGroupId`. `PUT /api/project/:id` writes `projectGroupId ?? null`, so a description change clears the group. Send the existing `projectGroupId` back, or treat omission as "leave it" in `update-project.ts`.

Test: a project with a group, then `update_project` with only `description`, still has that `projectGroupId`.

### Stage 2. Accept the calendar dates the API already accepts

`isoDateTimeSchema` is `z.string().datetime({ offset: true })`. `validateAndParseDate` accepts `2026-12-01`. Live `create_task` and `list_tasks` returned `-32602`; the same REST create returned 200. Widen the shared schema in `packages/mcp/src/tools/register.ts` to the strings the API parses, including a calendar date. `register.test.ts` currently expects the date-only value to throw. Change that test to expect the value to be forwarded.

### Stage 3. Detach the label id that attach returns

`assign-label-to-task.ts` inserts a task row and leaves the workspace row's `taskId` null. Live attach returned a new id. Detach of the original id was `Label is not assigned to a task`. Say that in the `attach_label_to_task` description, and make `detach_label_from_task` remove the copy attach just created (the returned id, or the workspace id the agent already had).

Test: attach a workspace label, then detach using the id the caller passed in, and the task no longer has that label.

### Stage 4. Expose `GET /api/task/my` as `get_my_tasks`

Register `get_my_tasks` on `registerTools` so HTTP and stdio both get it. The fetch URL is `/api/task/my`, and `/api/task/my?status=archived` when status is set. Accept `archived` and any other non-empty status string. The API ignores unknown statuses.

Test: the mocked fetch URL is `/api/task/my` and `/api/task/my?status=archived`. HTTP and stdio `tools/list` names stay equal, including this tool.

### Stage 5. Do not spend a tool call on the device-code poll

When `KANEO_API_KEY` is unset, stdin is not a TTY, and no cached token exists, `AuthService.getAccessToken` polls until the device code expires. Live `whoami` died with `-32001` at 3.5s while stderr kept the approval prompt. Return an `isError` result that says a token or `KANEO_API_KEY` is required. Do not start the device flow when `KANEO_API_KEY` is set (that part already holds: a bad key failed in 536ms and did not ask for approval). A null `get-session` body should be `isError` too, so a missing user is not a successful `null`.

Test: stdio `whoami` with no key and no credential file is `isError` true and does not call `requestDeviceCode`.

### Stage 6. Retry a short upstream failure, and name a timeout

`KaneoClient` and the HTTP `ApiClient` abort at 10s and retry only one non-key 401. Retry 429 and 502/503/504 a small number of times, honor `Retry-After`, and map an abort to `isError` text that includes the path and `timeout`. Keep using `KANEO_INTERNAL_API_URL` for the fetch. If the error body has no `message` string, keep a field error when the body has one (`issues` or `code`), instead of collapsing to `HTTP <status>`.

Test: a fake Kaneo that returns 429 then 200 is called twice. A hanging server hits the timeout text. With `KANEO_API_URL` on a public host and `KANEO_INTERNAL_API_URL` on loopback, the tool fetch host is the loopback host.

### Stage 7. Remove the unused session map

Delete `apps/api/src/mcp/session-admission.ts` and `tests/api/mcp-session-admission.test.ts`, or replace that test with one that asserts the stateless route never consults the map. Leave `shutdownMcpSessions` as the empty function the process already calls, or inline that. Do not put a process-local session table back in front of `/api/mcp`.

---

## Historical audit (e83fe1ec)

Audit of the MCP surfaces in `AIDeskLab/planed` at `e83fe1ec` (`origin/main`). Product code was not changed. Upstream comparison is `usekaneo/kaneo` `main`, fetched during this audit (`git rev-list --left-right --count origin/main...upstream/main` was `69 1866`). No open pull requests and no in-progress upstream-merge branch were on the fork remote (only `main` and `backup/pre-kdl-111-2026-08-10`).

This is the fork's own tree, not the published `ghcr.io/usekaneo/kaneo` image. `compose.yml` runs that upstream image, so it does not exercise this fork.

## Architecture

Kaneo exposes two MCP servers that register nearly the same tools and then call the Kaneo HTTP API with a bearer token.

| Surface | Entry | Transport | Auth |
| --- | --- | --- | --- |
| Built-in endpoint | `apps/api/src/mcp/index.ts`, mounted at `/api/mcp` | Streamable HTTP (`WebStandardStreamableHTTPServerTransport` from `@modelcontextprotocol/sdk` 1.29.0) | `Authorization: Bearer` session token or API key. A browser cookie is rejected with HTTP 401. |
| Package `@kaneo/mcp` 0.1.5 | `packages/mcp/src/cli.ts` `kaneo-mcp` / `kaneo-mcp serve` | stdio (`StdioServerTransport`) | `KANEO_API_KEY`, otherwise the device-authorization flow in `packages/mcp/src/auth/auth-service.ts`. Credentials are stored in `~/.config/kaneo-mcp/credentials.json` mode `0600`. |

There is no SSE-only legacy transport (`/sse` + `/messages`). POST responses are still `text/event-stream` because the SDK defaults `enableJsonResponse` to false. A GET with `mcp-session-id` opens the standalone SSE stream. DELETE ends the session.

The HTTP server keeps sessions in a process-local map (`apps/api/src/mcp/session-admission.ts`). Defaults: 200 sessions globally, 5 per user, 30 minute idle timeout, 60 second reservation timeout. Env overrides: `KANEO_MCP_MAX_GLOBAL_SESSIONS`, `KANEO_MCP_MAX_PER_USER_SESSIONS`, `KANEO_MCP_SESSION_IDLE_TIMEOUT_MS`, `KANEO_MCP_SESSION_RESERVATION_TIMEOUT_MS`.

Tool handlers do not call Kaneo in-process. Both copies `fetch` `${baseUrl}/api/...` with a 10 second `AbortSignal.timeout`. The HTTP copy uses `KANEO_API_URL` (default `http://localhost:1337`) after stripping a trailing `/api`. The bundled image entrypoint sets that variable to `${KANEO_CLIENT_URL}/api` when it is unset (`deploy/kaneo-entrypoint.sh`).

Tools are registered once, synchronously, inside `createMcpServer` / `createMcpServerForUser`, before `server.connect`. The list is not conditional and Kaneo never sends `notifications/tools/list_changed`. The SDK still advertises `capabilities.tools.listChanged: true` (observed on initialize). A client that loses its session and does not initialize again reports the tools as unavailable. That is session loss, not a dynamic tool list.

OAuth for the HTTP endpoint is a custom authorization-code + PKCE flow (`/api/mcp/register`, `/api/mcp/authorize`, `/api/mcp/token`) with state in Postgres (`mcp_oauth_state`). The token endpoint inserts a Better Auth `session` row and returns `access_token` and `expires_in` of 30 days. It does not return `refresh_token`.

SDK 1.29.0 (resolved from `^1.29.0` for both `@kaneo/api` and `@kaneo/mcp`, linked with Zod 4.4.3) accepts protocol versions `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`, and `2024-10-07`. Initialize negotiates an unknown client version down to `2025-11-25`. A later request whose `mcp-protocol-version` header is outside that list is HTTP 400.

`/api/health` returns `{ status: "ok" }` and does not report MCP session capacity. The HTTP handler does not log tool calls, session admission, or upstream API failures. stdio logs the device flow to stderr, which keeps it off the protocol stdout.

## What was run

Local API from this tree (`tsx src/index.ts`) against Postgres 16, `KANEO_API_URL=http://127.0.0.1:1337`. Node used to drive the clients was v24.22.1. The official MCP inspector was not required: `@modelcontextprotocol/sdk` 1.29.0 `Client` with `StreamableHTTPClientTransport` and `StdioClientTransport` performed the same calls.

A user was signed up (instance admin), a workspace and two projects were created, and an API key was issued. Every HTTP tool was called with valid input and with invalid input. stdio `tools/list` was compared with the HTTP list, and stdio `whoami`, a date-only `create_task`, and `whoami` with a bad API key were called. Session initialize, `tools/list`, DELETE, reuse of the deleted id, a second initialize, a per-user capacity burst, a missing `Accept` header, protocol `2026-07-28`, cookie-only auth, and OAuth client registration were exercised over HTTP.

Unit tests, without the live server:

- `pnpm --filter @kaneo/mcp test`: 8 files, 35 tests, passed.
- `pnpm --filter @kaneo/api exec vitest run` on `tests/api/mcp-session-admission.test.ts`, `tests/api/mcp-oauth-security.test.ts`, and `tests/api/mcp-task-cascade-tools.test.ts`: 3 files, 30 tests, passed.

Those tests mock `registerMcpTools` or call tool handlers with a fake `fetch`. They do not open a Streamable HTTP session against the route, and they do not assert the tool URL or the Zod date format.

Nginx from `apps/web/nginx.kaneo.conf` was not placed in front of this process. Proxy behavior below is from that config plus the live `Content-Type: text/event-stream` response.

## Tool results

HTTP registers 26 tools. stdio registers the same set except `get_my_tasks`. `apps/docs/core/integrations/mcp.mdx` says both surfaces offer the same tools.

`isError` in the table is the MCP tool result flag. Schema rejections come back as a tool error whose text starts with `MCP error -32602` (the client surfaces the server's validation error that way). HTTP 401 on `/api/mcp` itself is a transport failure, before any tool runs.

| Tool | Live result | Issue |
| --- | --- | --- |
| `whoami` | HTTP and stdio with a valid API key: `isError: false`, body `null`. HTTP with a session bearer: `isError: false` and the JSON includes `session.token`. stdio with a bad API key: `isError: false`, body `null`. | API-key and invalid-bearer calls to `GET /api/auth/get-session` are HTTP 200 `null`. The tool reports success. A real session token is copied into the model context. |
| `list_workspaces` | HTTP valid call returned the workspace array. Missing input is not applicable. | None on the happy path. |
| `list_projects` | HTTP valid call returned both projects. `{}` is a `-32602` tool error. | None on the happy path. |
| `get_project` | HTTP valid call returned the project. `id: ""` is `-32602`. | None on the happy path. |
| `create_project` | HTTP valid call created a project. Omitting required fields is `-32602`. | `icon` and `slug` are required, matching `POST /api/project`. |
| `update_project` | HTTP call that set `description` succeeded. | The handler omits `projectGroupId`. `PUT /api/project/:id` writes `projectGroupId ?? null`, so every call clears a project group. |
| `list_tasks` | HTTP call returned `{ data, pagination }` (the whole board). `dueAfter: "2026-11-04"` is `-32602`. The same filter with a `Z` offset succeeded. | Date-only values are rejected even though the API accepts them. With no `page`/`limit` the API returns every task and its description in one JSON blob. The tool does not document that shape. |
| `get_task` | HTTP valid call returned the task. Unknown id is `isError` with `Workspace ID could not be determined`, not "Task not found". | Missing ids fail in workspace lookup before the 404 from the controller. |
| `get_my_tasks` | HTTP only. Valid call is `isError`: `/api/task/tasks/my: Workspace ID could not be determined`. `status: "archived"` and `status: "custom-column"` are `-32602`. Direct `GET /api/task/my` with the same API key returned `{ tasks, total }`. | The tool calls `/api/task/tasks/:projectId` with `projectId=my`. The route that implements this tool is `GET /api/task/my`. The enum also omits `archived`, which `getMyTasks` accepts, and it cannot name a custom column slug. |
| `create_task` | HTTP valid call created a task in `to-do`. Date-only `dueDate` and `priority: "critical"` are `-32602`. stdio date-only call failed the same way. | `dueDate` / `startDate` require a timezone offset. The API's `validateAndParseDate` accepts `2026-12-01`. `description` is required (`z.string()`, empty string allowed), matching the route. |
| `update_task` | HTTP rename succeeded. `dueDate` without an offset is `-32602`. | Same offset rule. The handler GET+merges and PUT the full body, which matches `PUT /api/task/:id`. |
| `move_task` | HTTP valid call moved a task to the second project. | None on the happy path. |
| `update_task_status` | HTTP valid call succeeded. | `status` is a free string. The API checks it against the project's columns. |
| `delete_task` | HTTP valid call deleted a task. `{}` is `-32602`. | None on the happy path. |
| `list_task_comments` | HTTP valid call returned the comment array. | None on the happy path. |
| `create_task_comment` | HTTP valid call created a comment. Whitespace-only `content` is `-32602`. | Matches the route's `minLength(1)` after trim. |
| `update_task_comment` | HTTP valid call succeeded. | None on the happy path. |
| `delete_task_comment` | HTTP valid call succeeded. | None on the happy path. |
| `list_workspace_labels` | HTTP valid call returned the workspace label. | None on the happy path. |
| `create_label` | HTTP valid call created a workspace label (`taskId: null`). `color: "red"` is `-32602`. `#abc` was accepted. | Hex check matches the intended colors. The API route accepts any string color, so non-hex colors fail only at the tool. |
| `attach_label_to_task` | HTTP call succeeded and returned a new label id. | Attaching a workspace label inserts a task-scoped copy and leaves the original row's `taskId` null (`assign-label-to-task.ts`). |
| `detach_label_from_task` | HTTP call with the original workspace label id is `isError`: `Label is not assigned to a task`. | The id the agent already had is the definition row, not the copy returned by attach. |
| `create_task_relation` | HTTP `related` relation succeeded. `relationType: "parent"` is `-32602`. | Enum matches the route (`subtask`, `blocks`, `related`). |
| `get_task_relations` | HTTP valid call returned the relation. | None on the happy path. |
| `delete_task_relation` | HTTP valid call succeeded. | None on the happy path. |
| `delete_label` | HTTP delete of the workspace label is `isError` with the tool's own "workspace-level labels are not deletable" message. `DELETE /api/label/:id` for that same id then returned 200. Delete of a task-scoped label succeeded. | The pre-check disagrees with `deleteLabel`, which deletes workspace definitions and cascades task rows. |

stdio `tools/list` names, in order: `whoami`, `list_workspaces`, `list_projects`, `get_project`, `create_project`, `update_project`, `list_tasks`, `get_task`, `create_task`, `update_task`, `move_task`, `update_task_status`, `delete_task`, `list_task_comments`, `create_task_comment`, `update_task_comment`, `delete_task_comment`, `list_workspace_labels`, `create_label`, `attach_label_to_task`, `detach_label_from_task`, `create_task_relation`, `get_task_relations`, `delete_task_relation`, `delete_label`.

## Findings

### 1. High: per-user sessions stay allocated after the client goes away, then new clients get HTTP 503

`apps/api/src/mcp/session-admission.ts:23-26` and `:124-141`. The HTTP handler stores the transport in that map (`apps/api/src/mcp/index.ts:350-422`). The default per-user cap is 5. Idle reclaim is 30 minutes and only runs on the next admission call (`session-admission.ts:65-71`). `client.close()` from the SDK did not free the server session.

Repro, against a freshly started API:

1. Connect an MCP client with a valid API key, call `tools/list`, and close the client.
2. Open more `StreamableHTTPClientTransport` clients for the same user until initialize fails.
3. Observed: four further clients listed 26 tools. The fifth and sixth POSTs returned HTTP 503 `{"error":"server_busy","error_description":"MCP session capacity reached"}`. One session from step 1 was still counted, so the cap of 5 was already one full.

Cursor and other hosts open a connection per window and reconnect without DELETE. After five stranded sessions the server answers 503 to initialize. Hosts surface that as the MCP server being down and the tools being unavailable, until the idle timeout. A second API replica cannot see the map at all, so the same client gets `404 {"error":"Session not found"}` (`index.ts:360`) whenever a proxy sends the next POST to another process. Upstream removed this map (see below).

There is no MCP ping on the standalone GET stream. `apps/web/nginx.kaneo.conf:44-52` proxies every `/api/` request with `Connection: upgrade` and leaves `proxy_buffering` and `proxy_read_timeout` at the nginx defaults (buffering on, 60 seconds). Live initialize responses are `Content-Type: text/event-stream`. A buffered or idle-cut SSE stream drops the GET; if that close fires `transport.onclose`, `index.ts:382-386` deletes the session and the next POST is a plain JSON 404, which many clients do not treat as "initialize again".

### 2. High: any initialize that does not assign a session id is reported as "MCP session capacity reached"

`apps/api/src/mcp/index.ts:392-402`. `handleRequest` returns the SDK response first. The handler then checks `transport.sessionId`. The SDK sets that id only after the `Accept` check and a parsed initialize (`webStandardStreamableHttp.js` in SDK 1.29.0). A 406 or a JSON parse error leaves `sessionId` unset, and this block discards that response and returns 503.

Repro on a process with an empty session map:

```http
POST /api/mcp
Authorization: Bearer <valid API key>
Content-Type: application/json

{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"a","version":"0"}}}
```

No `Accept` header. Observed HTTP 503 `server_busy`, not the SDK's HTTP 406 `Not Acceptable: Client must accept both application/json and text/event-stream`. Clients and proxies that omit or strip `Accept` see a capacity error and disable the server.

### 3. High: `whoami` turns both API keys and invalid bearers into a successful `null`, and turns a session token into a secret in the tool result

`apps/api/src/mcp/tools.ts:183-191` and `packages/mcp/src/tools/register.ts:45-54` call `GET /api/auth/get-session` and wrap the body in `textResult`.

Observed with the live API:

| Bearer | `GET /api/auth/get-session` | `whoami` |
| --- | --- | --- |
| Valid API key | HTTP 200, body `null` | `isError: false`, text `null` |
| `Bearer bad` | HTTP 200, body `null` | stdio: `isError: false`, text `null` |
| Session token from sign-in | HTTP 200, object with `session` and `user` | `isError: false`, and `session.token` is present in the tool text |

`apps/api/src/index.ts:499-524` only rewrites a bearer into `x-api-key` when `getSession` did not already return a session. `get-session` itself still returns 200 `null` for an API key (`apiKeyHeaders` is `x-api-key` in `apps/api/src/auth.ts:458-460`) and for a garbage bearer. The MCP tool treats that as data. The same bad bearer on `GET /api/project` is HTTP 401 `Unauthorized`, so the REST surface and `whoami` disagree.

On HTTP `/api/mcp`, a bad key is rejected earlier by `validateBearerToken` (`index.ts:64-88`) with HTTP 401 and `WWW-Authenticate`. That part is correct. The null result is what stdio and a session-shaped token produce inside the tool. Agents report a tool that "worked" and then follow-up calls fail, or they keep going with an empty user.

A successful session `whoami` includes `session.token`. That string is the credential. It is now in the model transcript. Do not log tool output from this tool until the handler returns a user profile only.

stdio with no `KANEO_API_KEY` is worse in a different way. `AuthService.getAccessToken` (`packages/mcp/src/auth/auth-service.ts:106-124`) starts the device flow and polls until the code expires. The first live run, where the API key was not available to the child, blocked `whoami` until the MCP client returned `MCP error -32001: Request timed out`. The child kept printing `Waiting for device approval` after the client had given up.

### 4. High: `get_my_tasks` calls the project task list with `projectId` `my`

`apps/api/src/mcp/tools.ts:381-388` requests `/api/task/tasks/my`. `apps/api/src/task/index.ts:57-107` mounts that pattern as `GET /tasks/:projectId`. `GET /my` on the same router (`task/index.ts:108-127`) is `/api/task/my`.

Repro: `GET /api/task/tasks/my` with a valid API key returned HTTP 400 `Workspace ID could not be determined` (`apps/api/src/utils/workspace-access-middleware.ts:115-118`, project id `my` does not exist). `GET /api/task/my` with the same key returned HTTP 200 `{ tasks, total }`.

The tool is HTTP-only, so stdio clients never see it, while the docs say the lists match. `status` is a Zod enum of `to-do`, `in-progress`, `in-review`, `done`, `planned` (`tools.ts:376-378`). `getMyTasks` also accepts `archived` and silently ignores any other string (`apps/api/src/task/controllers/get-my-tasks.ts:11-30`). Custom column slugs fail in the tool and would be ignored by the API.

### 5. Medium: tool schemas reject inputs the API accepts, and two write tools do the wrong write

Datetime fields use `z.string().datetime({ offset: true })` in `packages/mcp/src/tools/register.ts:19-23` and `apps/api/src/mcp/tools.ts:164-168`. Live `create_task` and `list_tasks` with `2026-12-01` or `2026-11-04` returned `-32602` `invalid_format` `datetime`. `apps/api/src/utils/validate-dates.ts:7-19` accepts those strings. Models copy the API's own example format and the tool call fails before Kaneo sees it.

`update_project` builds `{ name, icon, slug, description, isPublic }` (`apps/api/src/mcp/tools.ts:306` and `packages/mcp/src/tools/register.ts:178`). `apps/api/src/project/controllers/update-project.ts:51-59` sets `projectGroupId: projectGroupId ?? null`. A call that only changes the description clears the group.

`delete_label` (`apps/api/src/mcp/tools.ts:705-726`, same logic in `packages/mcp/src/tools/register.ts:563-584`) refuses a label whose `taskId` is null. Live tool result: `Label is not associated with a task and cannot be deleted`. The following `DELETE /api/label/:id` returned 200. `apps/api/src/label/controllers/delete-label.ts:82-137` deletes workspace definitions and their task copies.

`attach_label_to_task` inserts a new row (`apps/api/src/label/controllers/assign-label-to-task.ts:103-118`). Live attach returned a different id from the one passed in. `detach_label_from_task` on the original id returned `Label is not assigned to a task` (`unassign-label-from-task.ts:21-24`).

`list_tasks` without `page` or `limit` returns every task inside the board document (`apps/api/src/task/controllers/get-tasks.ts:108-154` and `:334-360`). Both HTTP clients use a 10 second timeout (`apps/api/src/mcp/tools.ts:19-22`, `packages/mcp/src/kaneo/client.ts:33-37`) and no retry. A large board or a 429 becomes one `isError` string. `KaneoClient` retries a 401 once only when it is not an API key (`client.ts:39-44`). 429 and 5xx are not retried. `Retry-After` is ignored. The HTTP `verifyApiKey` path (`apps/api/src/utils/verify-api-key.ts:39-55`) does not decrement the API-key rate-limit counters that Better Auth would decrement on `/api/auth/*`.

Valibot failures from Kaneo that do not use a `message` string collapse to `HTTP <status>` in `client.ts:60-74` and `tools.ts:34-41`, so the agent loses the field error.

### 6. Medium: OAuth registration drops `refresh_token`, and the access token cannot be refreshed

`apps/api/src/mcp/schemas.ts:35` is `v.optional(v.tuple([v.literal("authorization_code")]))`. Valibot's tuple keeps the first item and succeeds when the array is `["authorization_code", "refresh_token"]`. Live `POST /api/mcp/register` with that body returned HTTP 200 and `grant_types: ["authorization_code"]`. `["refresh_token"]` alone returned HTTP 400. The token endpoint rejects anything other than `authorization_code` (`index.ts:291-292`) and the success body is only `access_token`, `token_type`, and `expires_in` (`index.ts:308-312`). `exchangeCode` sets `expiresIn` to 30 days (`apps/api/src/mcp/oauth.ts:176-188`).

Clients that send both grants, which the upstream comment says Claude does, can register. They are not given a refresh token. When the session row expires, `/api/mcp` returns 401 `invalid_token` (`index.ts:336-347`). Hosts that only refresh, and do not run registration again, keep failing tool calls. The `WWW-Authenticate` resource metadata URL on that 401 was `http://127.0.0.1:1337/api/.well-known/oauth-protected-resource/api/mcp`. The canonical path also exists at `/.well-known/oauth-protected-resource/api/mcp` (`index.ts:440-447` and `nginx.kaneo.conf:18-27`). Advertising the `/api/.well-known/...` form makes strict clients discard the metadata.

`mcp_oauth_state.expires_at` is `timestamp` without time zone (`apps/api/src/database/schema.ts:1017`). Expiry checks use `row.expiresAt.getTime()` (`apps/api/src/mcp/oauth-store.ts:120`). That combination is the bug upstream fixed for non-UTC hosts. This run did not change the server timezone, so it was not reproduced here.

### 7. Medium: protocol and self-fetch

Initialize with `protocolVersion: "2026-07-28"` returned HTTP 200 `text/event-stream` and negotiated `2025-11-25` (`capabilities.tools.listChanged: true`, server version `1.0.0` hardcoded in `index.ts:55-61`; the npm package is 0.1.5). The next POST on that session with `mcp-protocol-version: 2026-07-28` returned HTTP 400 `-32000` listing the five versions above. A client that keeps sending the version it asked for, rather than the negotiated one, initializes and then fails every tool call.

Tool fetches use the public `KANEO_API_URL`. `deploy/kaneo-entrypoint.sh:26-28` derives it from `KANEO_CLIENT_URL` and appends `/api`. The MCP code strips one trailing `/api` and then requests `${origin}/api/...`. From inside the container that is a hairpin through the public proxy. There is no `KANEO_INTERNAL_API_URL`. Locally, with `KANEO_API_URL=http://127.0.0.1:1337`, the calls succeeded. The failure shows up when the public URL is not reachable from the API process, or when it hits a different replica that does not own the MCP session.

Unknown session ids return HTTP 404 `{"error":"Session not found"}` (`index.ts:360`), a plain JSON body rather than a JSON-RPC error. Repro: initialize, `tools/list` (200), DELETE (200), `tools/list` with the old id (404), initialize again (200). DELETE itself works. Clients that do not start a new session on 404 keep the dead id and report tool failures.

### 8. Low: tests and operations do not cover the failures above

Existing coverage:

| Tests | What they lock in |
| --- | --- |
| `packages/mcp/src/tools/register.test.ts` | Tool names and a few mocked HTTP calls, including cascade wording. |
| `packages/mcp/src/kaneo/client.test.ts` | Auth header, one 401 retry, `message` extraction. |
| `packages/mcp/src/auth/*.test.ts` | Device flow and token file. |
| `tests/api/mcp-session-admission.test.ts` | Caps, idle reclaim, user mismatch, with the tool registrar mocked. |
| `tests/api/mcp-oauth-security.test.ts` | Registration limits, redirect rules, token exchange. |
| `tests/api/mcp-task-cascade-tools.test.ts` | Both registrars mention cascade on update and delete. |
| `tests/api-integration/mcp-oauth-*.test.ts` | OAuth state across imports. |

Nothing asserts `GET /api/task/my`, the datetime offset, `whoami` under an API key, the 503 rewrite, or a real SDK client. `/api/health` does not include session counts. The HTTP path has no structured log for admission failures.

## What upstream already changed

Upstream `packages/mcp` is 0.1.14. `apps/api` depends on `@modelcontextprotocol/sdk` `1.32.2` and `@modelcontextprotocol/server` `2.4.0`. The HTTP entry (`apps/api/src/mcp/index.ts` on `upstream/main`) does the following, which this fork does not:

| Upstream change | What it fixes here |
| --- | --- |
| `15247876` and the current handler: stateless legacy POST (`sessionIdGenerator: undefined`) plus `createModernMcpHandler` with `legacy: "reject"` | Findings 1 and 2. No in-memory session map, no per-user 503, no "session not found" across replicas. `apps/api/src/mcp/session-admission.ts` is deleted upstream. Non-POST is 405. |
| `7d9d9d21` `KANEO_INTERNAL_API_URL` (default `http://127.0.0.1:1337`) for tool fetches, public URL only for OAuth metadata | Finding 7 self-fetch. |
| `7fe3610d` stateless 2026 protocol via `@modelcontextprotocol/server` | Finding 7. A 2026 client is handled by a fresh server per request instead of being rejected on the next call. |
| `f9b2c09a` and `packages/mcp/src/tools/get-current-user.ts`: API keys call `GET /api/user/me`; session `whoami` returns `id`, `name`, `email`, `role` | Finding 3. This fork has no `/api/user/me`. |
| `cf446256` omit session credentials from `whoami` | Finding 3 token leak. |
| `59314c15` and current `schemas.ts`: `grant_types` may include `refresh_token`, and the response still only advertises `authorization_code` | Finding 6. Upstream still does not issue a refresh token. The difference is that registration is explicit instead of a Valibot tuple accident. |
| `86ee7fca` bind sessions to the creating user, then later replaced by the stateless handler | This fork already checks `userId` in `getSession`. The remaining bug is that the map is process-local. |
| `8f56b4d2` one shared registrar, workspace label delete | Findings 4 and 5. Upstream `register.ts` also adds `get_task_by_ticket_id`, `duplicate_task`, members, search, columns, custom fields, recurrence, time entries, activity, notifications, and assignee/due-date updates. |
| `bee5686e`, `a491a93f` request and OAuth state bounds; `c5cb1e86` OAuth timestamps outside UTC | Finding 6 expiry and unbounded `state`. |
| `1167ec6a` guard the media type | Related to finding 2: upstream returns 415 for a non-JSON body instead of pretending the server is full. |
| Canonical `WWW-Authenticate` URL `/.well-known/oauth-protected-resource/api/mcp` | Finding 6 metadata URL. |
| `23464e5c` do not treat API keys as user sessions, and `6c5f26e4` stable JSON error `code` | Finding 3 and the `client.ts` error string. Upstream `KaneoClient` appends `code` when the body has one. |

`apps/api/src/mcp/tools.ts` upstream is a thin re-export of the package registrar. This fork keeps a second 728-line copy, which is how `get_my_tasks` drifted.

Merging `upstream/main` is not a drop-in for this fork: the fork is 69 commits ahead, and the API router, OpenAPI helper, and auth hooks have diverged. The MCP files above can be ported on their own. A full merge will conflict in `apps/api/src/mcp/index.ts`, `oauth.ts`, `schemas.ts`, `tools.ts`, and `packages/mcp/src/tools/register.ts`.

## Historical fix plan

The stage list that used to be here was rewritten after merge `067ae03`. The remaining work is the fix plan at the top of this file. The old stages 1 and 5 are done on the request path. Stages 2, 3, and 4 are only partly done. Do not implement the old stage 1 session map.
