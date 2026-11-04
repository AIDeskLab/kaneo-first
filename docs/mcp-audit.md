# MCP server audit

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

## Fix plan

Each stage is shippable on its own. Tests are the ones to add in that stage. Do not start stage 5 by deleting the session map until stage 1's tests exist, or the capacity tests will be rewritten mid-flight.

### Stage 1. Stop reporting transport failures as a full server

- Return the SDK `Response` from `handleRequest` when initialize fails. Reserve a session only after the SDK has produced a session id.
- On client disconnect, DELETE the session. Lower the damage of the cap: document it, and do not count a session whose transport has already closed.
- Set `enableJsonResponse: true` or turn off proxy buffering for `/api/mcp` (`proxy_buffering off`, `proxy_read_timeout` above the idle timeout, `Connection` upgrade only when `Upgrade` is set) in `apps/web/nginx.kaneo.conf`.
- Tests in `tests/api/mcp-session-admission.test.ts`:
  - POST initialize without `Accept` is 406 and the session map stays empty.
  - Invalid JSON is 400, not 503.
  - Five live sessions then a sixth is 503; DELETE of one allows a new initialize.
  - After the test transport emits `onclose`, `getSession` misses.
  - `tools/list` with an unknown `mcp-session-id` stays 404 and does not consume a slot.

### Stage 2. Make authentication visible to the host

- `whoami` with an API key reads the user profile (port `/api/user/me` or an equivalent) and returns `{ id, name, email, role }`.
- `whoami` with a session token returns that same shape and no `session` object.
- stdio: a 401 from `get-session` or an API-key 401 is an `isError` result that says the credential was rejected. Do not start the device flow when `KANEO_API_KEY` is set. When it is unset, fail the tool quickly if stdin is not a TTY and no cached token exists, instead of polling for the whole device-code lifetime inside the tool call.
- Registration accepts `refresh_token` in `grant_types` explicitly and still does not issue one until a refresh grant exists. Point `WWW-Authenticate` at `/.well-known/oauth-protected-resource/api/mcp`.
- Tests:
  - API key `whoami` snapshot has no `token` property and `isError` is false.
  - Bearer `bad` on stdio `whoami` is `isError` true and does not call `requestDeviceCode`.
  - Session `whoami` JSON has no `session` key.
  - `POST /api/mcp/register` with `grant_types: ["authorization_code", "refresh_token"]` is 200 and the stored client still cannot call the token endpoint with `grant_type=refresh_token` (400 `unsupported_grant_type`) until that grant is implemented.
  - `WWW-Authenticate` on an anonymous POST contains the host-root well-known path.

### Stage 3. One registrar, matching the routes

- Delete the duplicated tool list. HTTP and stdio both call `packages/mcp` `registerTools`.
- `get_my_tasks` calls `GET /api/task/my`. Add `archived` to the documented statuses or accept any non-empty slug and let the API filter.
- Datetime fields accept the strings `validateAndParseDate` accepts, including a calendar date.
- `update_project` sends the existing `projectGroupId` back, or the API treats omission as "leave it".
- `delete_label` calls `DELETE /api/label/:id` for workspace labels.
- `detach_label_from_task` uses the id returned by attach, and the tool description says attach may return a new id.
- Tests in `packages/mcp/src/tools/register.test.ts` and one HTTP test that mounts the real task router:
  - `get_my_tasks` fetch URL is `/api/task/my` and `/api/task/my?status=archived`.
  - `dueDate: "2026-12-01"` passes the tool schema and is forwarded.
  - `update_project` body includes the previous `projectGroupId`.
  - `delete_label` on `{ taskId: null }` still calls DELETE.
  - HTTP and stdio `tools/list` names are equal.

### Stage 4. Bound the Kaneo calls

- Tool `fetch` uses `KANEO_INTERNAL_API_URL` when set, otherwise `http://127.0.0.1:<listen port>`, never the public `KANEO_CLIENT_URL`.
- Retry 429 and 502/503/504 a small number of times, honoring `Retry-After`, and map abort to `isError` text that includes the path and `timeout`.
- `list_tasks` defaults `limit` (the API already caps a page at 100) and the description states the `{ data, pagination }` shape.
- Log admission rejections and upstream non-2xx at info/warn without the bearer. Extend `/api/health` or add `/api/mcp/health` with the session counts and the cap.
- Tests: a fake Kaneo that returns 429 then 200 is called twice; a hanging server hits the timeout message; `list_tasks` with no limit sends `limit`; with `KANEO_API_URL=https://public.example` and `KANEO_INTERNAL_API_URL=http://127.0.0.1:1337` the tool fetch host is `127.0.0.1`.

### Stage 5. Follow upstream's stateless 2026 handler

After stages 1-4, replace the session map with upstream's split: JSON content-type check, `isLegacyRequest`, `createModernMcpHandler` per request, and a stateless legacy transport. Pin `@modelcontextprotocol/sdk` and add `@modelcontextprotocol/server` at the versions upstream has tested (1.32.2 and 2.4.0 at audit time), rather than another floating `^1.29.0`.

Tests from stage 1 change as follows: two in-process Hono apps behind a round-robin fake proxy both answer `tools/list` for the same initialize (there is no session to lose); `protocolVersion: "2026-07-28"` completes `tools/call`; a second replica does not return 404. Keep the stage 2 and 3 assertions. Add a test that `POST` is the only method the stateless handler accepts, matching upstream, so GET-SSE clients are covered by the JSON response mode instead of a buffered stream.
