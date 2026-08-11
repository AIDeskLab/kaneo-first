# Selective upstream sync record: v2.16.3

## Scope

- Upstream: `usekaneo/kaneo`
- Exact tag: `v2.16.3`
- Tag/main SHA: `067102b44909c40886a7a5843a0882f3b04dc3ac`
- Audited range: all 178 non-merge upstream-only commits from merge-base `bb3c3d72`
- Effective decisions: 99 include, 8 already present, 62 exclude, 9 superseded
- Traceability: 101 source commits were cherry-picked; two behavior-neutral review-only patches (`fddbb150`, `8dcb3261`) are neutralized in the reconciliation diff
- Corporate version before merge: `2.16.3-aidesk.2`; explicit same-base sync is a no-op

## Selection policy

Included: security, data integrity, core API/UI features, performance, localization, observability, Helm/runtime fixes, and regression coverage. Excluded: sponsors/funding, cloud billing, marketing/site-only changes, OSS governance, release bookkeeping, standalone npm MCP publishing, and broad unrelated major dependency/tooling upgrades.

Mixed commits were scoped to product files. Final diff intentionally contains no `apps/site`, `packages/mcp`, billing, sponsor, changelog, or release-workflow changes.

Four independent read-only workers reclassified all 178 commits from the real diffs. Their findings were reconciled individually rather than accepted by majority vote. The final reconciliation adopted the exclusion of two cosmetic-only commits, retained the direct Hono/security fix because its broad superseding dependency chain was intentionally excluded, retained manual CI dispatch as generally useful corporate operations support, and kept cloud billing and unrelated tooling majors out of scope.

## Corporate conflict policy

Corporate behavior wins when patches conflict. In particular:

- Project Groups and `projectGroupId` were preserved while adding project ordering.
- `/tasks/my`, API-key MCP Bearer auth, instance administration, PWA, task hierarchy, and fork versioning were preserved.
- Project-list task rows were replaced by bounded SQL aggregates while retaining corporate `taskCountByStatus` and active-task semantics.
- Upstream migrations were regenerated from corporate migration `0035_wakeful_shiva`: `0036` contains MCP OAuth state and project position, `0037` adds a validated `task.start_date <= task.due_date` database check with safe repair of pre-existing invalid rows, and `0038` adds label provenance through a `source` column constrained to the allowed values.
- Shared locale keys use the exact `v2.16.3` translations; corporate-only keys absent upstream are retained with `en-US` fallback values. The exact `bea10b21` semantic checker, `scripts/i18n/audit-upstream-commit.mjs`, proves zero mismatches across 2,966 changed leaves; valid locale-specific CLDR plural variants are accepted by the checker.
- Dependency lockfile is regenerated from selected manifests and security overrides; excluded major-upgrade chains are not imported. `fast-uri` resolves to `3.1.5`, and Next is pinned to patched `15.5.21` to avoid drifting into the excluded Next 16 toolchain.
- Independent security review hardened outbound requests: Gitea and generic webhooks validate every DNS answer, pin the actual socket lookup to the validated global-unicast set, reject redirects and non-global address ranges, and enforce a streaming 10 MiB response cap before buffering. The private-destination override remains scoped to generic webhooks only. Residual risk remains LOW because DNS lookup timeout is not solved; socket pinning, redirect, range, and response-size protections remain in force.
- Public MCP OAuth client registration is bounded by atomic PostgreSQL fixed-window limits of 20/minute per actual connection source and 600/minute globally. Authorization is limited to 120/minute per source, 300/minute per client, and 3,000/minute globally. Each admission acquires deterministic per-key transaction locks, cleans up expired rate rows, checks every applicable partition before mutating any counter, and then increments all admitted counters atomically, so a denied global or partition ceiling cannot consume capacity or create attacker-controlled rows. Atomic pending-request caps remain 100 per client and 10,000 globally; capacity rejection does not evict live unrelated requests. Registration also permits at most 10 redirect URIs and a 32 KiB request body.
- Task assignment requires `task:assign` for create/import and every create, import, full, dedicated, and bulk assignment validates membership in the task project's workspace.
- Dedicated and bulk due-date routes validate new values against persisted start dates before side effects or updates.
- GitHub global repository discovery, installation verification, and repository binding are restricted to instance administrators while retaining workspace access and `workspace:manage_settings`; non-admin callers cannot reach global duplicate-linkage checks.
- Project-group mutation resolves workspace access from the group ID, and project updates reject missing or cross-workspace group assignments before mutation.
- Workspace offboarding atomically clears that user's task assignments in the removed workspace, and `/task/my` requires current workspace membership to suppress stale legacy assignments.
- Migration `0038` deliberately leaves all legacy labels locally owned because task-level Gitea linkage cannot establish label provenance. New Gitea imports record provenance explicitly; reconciliation deletes only Gitea-owned labels and preserves local labels. Label removal is awaited for both GitHub and Gitea before local deletion.

## Commit decisions

| # | Commit | Decision | Subject | Reason |
|---:|:---|:---|:---|:---|
| 001 | `e8f75808` | Exclude | docs: update contributors and sponsors | Sponsor/funding/marketing metadata has no corporate-fork value. |
| 002 | `6c8fb8f5` | Exclude | feat(site): add homepage sponsors section with public sponsor sync | Sponsor/funding/marketing metadata has no corporate-fork value. |
| 003 | `85481c45` | Exclude | docs: update contributors and sponsors | Sponsor/funding/marketing metadata has no corporate-fork value. |
| 004 | `91829ab6` | Exclude | feat(site): make founding sponsorship a badge for all early backers | Sponsor/funding/marketing metadata has no corporate-fork value. |
| 005 | `09a13670` | Exclude | fix(mcp): emit type declarations for the package exports entry | Standalone npm MCP packaging/docs are excluded; corporate MCP is integrated in the API. |
| 006 | `9eb0b812` | Exclude | ci(mcp): publish to npm automatically on version bump | Standalone npm MCP packaging/docs are excluded; corporate MCP is integrated in the API. |
| 007 | `90d8b695` | Exclude | chore(mcp): 0.1.6 | No material corporate product/security value or depends on excluded upstream-only scope. |
| 008 | `e048fb40` | Include | fix(email): stop forcing SMTP auth when no credentials are set | Security/auth hardening selected. |
| 009 | `debad748` | Exclude | docs: update contributors and sponsors | Sponsor/funding/marketing metadata has no corporate-fork value. |
| 010 | `7771d46c` | Include | fix(api): stop embedding task rows in the project list response | Core product/data-integrity bug fix selected. |
| 011 | `47fd67fc` | Already present | feat(api): add optional Sentry error tracking via SENTRY_DSN | Included by the previous selective sync; patch or adapted equivalent is already in the fork. |
| 012 | `16b5a174` | Exclude | chore(release): v2.9.9 | Upstream release bookkeeping; fork versioning is canonical and independent. |
| 013 | `6a0210c5` | Include | fix: persist task title activity atomically | Core product/data-integrity bug fix selected. |
| 014 | `23327e38` | Already present | feat: add Saturday week-start option | Included by the previous selective sync; patch or adapted equivalent is already in the fork. |
| 015 | `63530974` | Already present | fix: address week-start validation and i18n feedback | Included by the previous selective sync; patch or adapted equivalent is already in the fork. |
| 016 | `cbe93a07` | Exclude | feat(site): add pricing, privacy policy, and terms pages | Marketing/site-only presentation change is excluded. |
| 017 | `a2e51329` | Already present | fix(api): allocate task numbers atomically via per-project counter | Included by the previous selective sync; patch or adapted equivalent is already in the fork. |
| 018 | `bf7cb386` | Already present | fix(api): return 401 instead of 500 for invalid API keys | Included by the previous selective sync; patch or adapted equivalent is already in the fork. |
| 019 | `e2ffa941` | Exclude | chore(release): v2.9.10 | Upstream release bookkeeping; fork versioning is canonical and independent. |
| 020 | `896031e9` | Already present | test(api): keep project task counter in sync with seeded fixtures | Included by the previous selective sync; patch or adapted equivalent is already in the fork. |
| 021 | `0f53ab93` | Already present | fix: add Saturday translations for all locales | Included by the previous selective sync; patch or adapted equivalent is already in the fork. |
| 022 | `c7bc1260` | Already present | fix(i18n): correct Greek Saturday translation | Included by the previous selective sync; patch or adapted equivalent is already in the fork. |
| 023 | `093995d0` | Exclude | feat(billing): add Kaneo Cloud subscriptions via Creem | Cloud billing/monetization is intentionally excluded from the corporate fork. |
| 024 | `5c8390e9` | Include | fix(project): allow one-character names and keys | Core product/data-integrity bug fix selected. |
| 025 | `6cb37485` | Include | fix(api): github install and label detachment bug | Core product/data-integrity bug fix selected. |
| 026 | `f62789c6` | Include | fix(api): resolve bugs in api tests | Regression/quality gate selected for included behavior. |
| 027 | `22f6f8fc` | Include | fix(api): coderabbit/qodo reviews | Core product/data-integrity bug fix selected. |
| 028 | `019ac9ee` | Include | fix(api): coderabbit nitpick | Core product/data-integrity bug fix selected. |
| 029 | `92f5aa73` | Include | fix(tests): update label test | Regression/quality gate selected for included behavior. |
| 030 | `6813f3b3` | Exclude | test(billing): live-verify entitlement enforcement and seat sync | Cloud billing/monetization is intentionally excluded from the corporate fork. |
| 031 | `eda0d055` | Exclude | feat(billing): polish billing settings page UI | Cloud billing/monetization is intentionally excluded from the corporate fork. |
| 032 | `8e5c211a` | Exclude | chore(release): v2.10.0 | Upstream release bookkeeping; fork versioning is canonical and independent. |
| 033 | `e299f543` | Exclude | feat(web): add dismissible trial nudge in sidebar | No material corporate product/security value or depends on excluded upstream-only scope. |
| 034 | `3597eb96` | Exclude | chore(release): v2.11.0 | Upstream release bookkeeping; fork versioning is canonical and independent. |
| 035 | `b2ba8e46` | Exclude | feat: deep-link pricing CTAs through signup to checkout | No material corporate product/security value or depends on excluded upstream-only scope. |
| 036 | `4ae6c668` | Exclude | chore(release): v2.12.0 | Upstream release bookkeeping; fork versioning is canonical and independent. |
| 037 | `f282e1f8` | Exclude | feat(site): add Jira, Trello, and Linear comparison pages for SEO | Marketing/site-only presentation change is excluded. |
| 038 | `94bb6914` | Exclude | docs(site): remove em dashes from comparison copy | Marketing/site-only presentation change is excluded. |
| 039 | `3db23c97` | Exclude | feat: switch Cloud pricing to USD and replace Product Hunt button with Pricing | Cloud billing/monetization is intentionally excluded from the corporate fork. |
| 040 | `3894504c` | Exclude | chore(release): v2.12.1 | Upstream release bookkeeping; fork versioning is canonical and independent. |
| 041 | `f8564199` | Include | feat(web): add Mermaid diagram preview support | Core product feature/performance improvement selected. |
| 042 | `d19da38d` | Include | feat(web): improve Mermaid diagram rendering and error handling | Core product feature/performance improvement selected. |
| 043 | `9d7d3278` | Include | feat(i18n): add Italian (it-IT) translation | Product localization selected; corporate keys are preserved with fallback values. |
| 044 | `efe53531` | Include | feat(web): localize Mermaid rendering errors | Core product feature/performance improvement selected. |
| 045 | `ffb6bc6b` | Include | fix(api): scope task aggregates by workspace join instead of project ID list | Core product/data-integrity bug fix selected. |
| 046 | `0c86e83f` | Include | fix: move overrides to workspace config | Core product/data-integrity bug fix selected. |
| 047 | `f12744e5` | Include | test(api-integration): add isSmtpConfigured to email mock | Regression/quality gate selected for included behavior. |
| 048 | `1eb3e519` | Superseded | fix(deps): bump next to 15.5.21 to patch 8 disclosed advisories | Corporate Next override is already stricter/newer; no app/site dependency churn. |
| 049 | `d0570ee9` | Include | fix: resolve workspace access from the id the handler acts on | Core product/data-integrity bug fix selected. |
| 050 | `a483bd46` | Include | fix: serve public-project assets to anonymous callers | Core product/data-integrity bug fix selected. |
| 051 | `4c4ccf17` | Include | fix(web): search tasks by issue identifier | Core product/data-integrity bug fix selected. |
| 052 | `79872a31` | Include | fix: enforce bulk task permissions | Security/auth hardening selected. |
| 053 | `67827c44` | Include | fix: fail closed for mixed-workspace bulk tasks | Core product/data-integrity bug fix selected. |
| 054 | `a2a76725` | Include | fix: preserve bulk task validation responses | Core product/data-integrity bug fix selected. |
| 055 | `1c7366bb` | Include | fix(web): guard nullable task identifiers | Core product/data-integrity bug fix selected. |
| 056 | `1f20eb93` | Include | fix: keep planned subtasks in backlog | Core product/data-integrity bug fix selected. |
| 057 | `3a617054` | Include | fix: wait for subtask status columns | Core product/data-integrity bug fix selected. |
| 058 | `0efc06f9` | Exclude | docs: update contributors and sponsors | Sponsor/funding/marketing metadata has no corporate-fork value. |
| 059 | `702483da` | Superseded | fix(deps): raise next override floor to 15.5.21 so the bump actually resolves | Corporate Next security range already supersedes this floor. |
| 060 | `dc45f269` | Include | fix: prevent task number gaps during partial import failures | Core product/data-integrity bug fix selected. |
| 061 | `65455279` | Include | fix: include labels in task export to prevent data loss on round-trip | Core product/data-integrity bug fix selected. |
| 062 | `e968adfe` | Include | fix: add date validation for task create/update to prevent Invalid Date in DB | Core product/data-integrity bug fix selected. |
| 063 | `f837beb3` | Include | feat: add Hindi (hi-IN) locale translation | Product localization selected; corporate keys are preserved with fallback values. |
| 064 | `134317e0` | Include | fix: complete all 1598 translation keys for Hindi locale | Product localization selected; corporate keys are preserved with fallback values. |
| 065 | `82f88837` | Include | fix: translate remaining externalLinks.issue and branch keys to Hindi | Core product/data-integrity bug fix selected. |
| 066 | `b39f29b4` | Include | style: fix biome formatting for validate-dates files | Core product/data-integrity bug fix selected. |
| 067 | `5a0b65c9` | Include | style: fix biome formatting for import-tasks | Core product/data-integrity bug fix selected. |
| 068 | `990d70ef` | Include | perf(web): avoid per-task kanban metadata requests | Core product feature/performance improvement selected. |
| 069 | `a417b89c` | Include | test: read the bound id through drizzle's dialect, not queryChunks | Regression/quality gate selected for included behavior. |
| 070 | `1e555966` | Include | fix(auth): let invited users without an account register | Security/auth hardening selected. |
| 071 | `e473a413` | Include | fix(web): restore ResizeObserver stub and correct invite-flow comment | Core product/data-integrity bug fix selected. |
| 072 | `1236ab97` | Include | fix: address code review feedback for date validation | Core product/data-integrity bug fix selected. |
| 073 | `8b7d01eb` | Include | feat(web): add invitation link and clipboard helpers | Core product feature/performance improvement selected. |
| 074 | `e81c1c73` | Include | feat(web): surface the workspace invitation link in the UI | Core product feature/performance improvement selected. |
| 075 | `c698c6c4` | Include | feat(i18n): add Vietnamese (vi-VN) locale | Product localization selected; corporate keys are preserved with fallback values. |
| 076 | `aeb23d90` | Include | fix(email): fix Biome formatting in password-reset template | Core product/data-integrity bug fix selected. |
| 077 | `8c210b92` | Include | feat: add zh-CN locale | Product localization selected; corporate keys are preserved with fallback values. |
| 078 | `d3aef283` | Include | fix: CVE-2026-69192 security vulnerability | Security/auth hardening selected. |
| 079 | `8477ed89` | Include | chore(deps): bump hono from 4.12.31 to 4.12.34 | Core product feature/performance improvement selected. |
| 080 | `a41e38d4` | Include | fix: apply triage follow-ups for #1461, #1464 and #1470 | Core product/data-integrity bug fix selected. |
| 081 | `4a82dd89` | Include | fix(i18n): translate invite-flow strings and language labels across locales | Product localization selected; corporate keys are preserved with fallback values. |
| 082 | `b49fb250` | Include | fix: resolve all TypeScript errors across api and web | Core product/data-integrity bug fix selected. |
| 083 | `c20d90a1` | Include | ci: enforce typecheck and fix cold-start dev | Regression/quality gate selected for included behavior. |
| 084 | `27873d12` | Exclude | chore: remove em dashes repo-wide and shorten Macedonia in legal copy | Marketing/site-only presentation change is excluded. |
| 085 | `f1797b91` | Exclude | ci: upgrade npm before publishing @kaneo/mcp | Standalone npm MCP packaging/docs are excluded; corporate MCP is integrated in the API. |
| 086 | `e0d0a4e3` | Exclude | ci: run mcp publish on Node 24 for OIDC-capable npm | Standalone npm MCP packaging/docs are excluded; corporate MCP is integrated in the API. |
| 087 | `b575e6bf` | Exclude | ci: drop token auth remnants so npm uses trusted publishing | No material corporate product/security value or depends on excluded upstream-only scope. |
| 088 | `3fca72a8` | Exclude | chore(mcp): publish 0.1.7 with official npm metadata | Standalone npm MCP packaging/docs are excluded; corporate MCP is integrated in the API. |
| 089 | `a34711eb` | Exclude | feat(mcp): publish to the official MCP Registry | Standalone npm MCP packaging/docs are excluded; corporate MCP is integrated in the API. |
| 090 | `10cbb44e` | Superseded | chore(deps): bump the npm-minor group across 1 directory with 62 updates | Broad dependency churn rejected; required security/direct dependency changes were selected separately. |
| 091 | `1dea7753` | Exclude | fix(ci): registry description limit and idempotent MCP Registry publish | Standalone npm MCP packaging/docs are excluded; corporate MCP is integrated in the API. |
| 092 | `7db4dbbe` | Include | fix(deps): align the better-auth override with 1.6.25 | Security/auth hardening selected. |
| 093 | `9d88948d` | Exclude | ci: refresh sponsors daily and deploy the site after updates | Sponsor/funding/marketing metadata has no corporate-fork value. |
| 094 | `1727d93e` | Exclude | docs: update contributors and sponsors | Sponsor/funding/marketing metadata has no corporate-fork value. |
| 095 | `1dce7aa8` | Exclude | chore(release): v2.12.2 | Upstream release bookkeeping; fork versioning is canonical and independent. |
| 096 | `55400430` | Include | fix(web): show language names without region in the locale picker | Product localization selected; corporate keys are preserved with fallback values. |
| 097 | `bfe834ab` | Include | feat: refactor settings layout to use Sheet component and improve mobile responsiveness | Core product feature/performance improvement selected. |
| 098 | `a79a83c3` | Include | fix: polish mobile settings layout | Core product/data-integrity bug fix selected. |
| 099 | `2d5447ab` | Include | fix(gitea): record the external link before publishing task.created | Core product/data-integrity bug fix selected. |
| 100 | `dc31480a` | Include | fix(github): comment the task link on issues created from Kaneo | Core product/data-integrity bug fix selected. |
| 101 | `7d20a3fc` | Include | feat(web): pick a project in the create-task modal when none is in scope | Core product feature/performance improvement selected. |
| 102 | `18ad8f53` | Include | fix(mcp): store OAuth state in Postgres so multiple replicas work | Security/auth hardening selected. |
| 103 | `6fc3f44f` | Include | perf(web): render list and backlog rows from the task payload | Core product feature/performance improvement selected. |
| 104 | `3ac5aa97` | Include | fix(api): stop returning integration secrets from the external-link route | Core product/data-integrity bug fix selected. |
| 105 | `26ae20ff` | Include | fix(api): block SSRF through the Gitea integration endpoints | Security/auth hardening selected. |
| 106 | `700da1b2` | Include | fix(web): reject non-http URLs in attachment and issue-link nodes | Core product/data-integrity bug fix selected. |
| 107 | `86ee7fca` | Include | fix(mcp): bind streamable sessions to the user that created them | Security/auth hardening selected. |
| 108 | `704daeb4` | Include | fix(api): reject traversal in finalized task image keys | Security/auth hardening selected. |
| 109 | `99571c9a` | Include | fix(api): stop reflecting arbitrary origins in production | Core product/data-integrity bug fix selected. |
| 110 | `198bd076` | Exclude | docs: add a security policy | No material corporate product/security value or depends on excluded upstream-only scope. |
| 111 | `38c39ef3` | Exclude | chore(release): v2.13.0 | Upstream release bookkeeping; fork versioning is canonical and independent. |
| 112 | `f040ebf1` | Exclude | docs: make the Kaneo docs the source of truth for drim | Upstream OSS governance/site documentation is not product functionality. |
| 113 | `c4427a6d` | Exclude | fix(mcp): correct the docs URL in package metadata | Standalone npm MCP packaging/docs are excluded; corporate MCP is integrated in the API. |
| 114 | `09fb5d44` | Include | fix(web): use Shiki's JavaScript regex engine to avoid WebAssembly | Core product/data-integrity bug fix selected. |
| 115 | `fb656d42` | Include | feat(i18n): add Brazilian Portuguese (pt-BR) locale | Product localization selected; corporate keys are preserved with fallback values. |
| 116 | `804817dd` | Include | fix(i18n): use pt-BR copy for workspace invitation emails | Core product/data-integrity bug fix selected. |
| 117 | `e8f8f8a3` | Exclude | fix(web): correct link to the API reference in the nav menu | No material corporate product/security value or depends on excluded upstream-only scope. |
| 118 | `39fc9fc1` | Include | fix(deps): patch 16 disclosed advisories through the overrides | Core product/data-integrity bug fix selected. |
| 119 | `04ea0cad` | Exclude | docs: unwrap hard-wrapped prose | No material corporate product/security value or depends on excluded upstream-only scope. |
| 120 | `3f3dd136` | Include | fix(web): stop warning about due dates on completed tasks | Core product/data-integrity bug fix selected. |
| 121 | `f3f50a0c` | Superseded | chore(deps): batch the pending dependabot updates | Broad Dependabot batch rejected; selected security floors are integrated separately. |
| 122 | `6c98c281` | Superseded | chore(deps): bump lucide-react to 1.x and vendor the GitHub mark | Lucide major upgrade rejected as unrelated compatibility risk. |
| 123 | `a3ee7ad5` | Exclude | fix(deps): drop the next override so the site really gets next 16 | Marketing/site-only presentation change is excluded. |
| 124 | `545374e3` | Superseded | chore: upgrade to typescript 7 and next 16.3 | TypeScript 7/Next 16 major upgrade rejected as unrelated compatibility risk. |
| 125 | `5bc34aea` | Include | ci: allow manual dispatch of the ci workflow | Regression/quality gate selected for included behavior. |
| 126 | `c5e74f0d` | Superseded | fix(deps): sync lockfile with the babel override | Lockfile-only follow-up to excluded dependency batch; lockfile regenerated from selected manifests. |
| 127 | `9acfec86` | Exclude | chore: cache the site build output in turbo | Marketing/site-only presentation change is excluded. |
| 128 | `353b38d2` | Include | test(mcp): port cross-replica flow test from #1493 | Regression/quality gate selected for included behavior. |
| 129 | `3da2ac5f` | Include | fix(mcp): cap pending OAuth authorization requests | Security/auth hardening selected. |
| 130 | `02539fd0` | Exclude | docs: update contributors and sponsors | Sponsor/funding/marketing metadata has no corporate-fork value. |
| 131 | `01511cdc` | Include | fix(helm): set postgresql Deployment update strategy to Recreate | Core product/data-integrity bug fix selected. |
| 132 | `8ff50373` | Exclude | docs: update contributors and sponsors | Sponsor/funding/marketing metadata has no corporate-fork value. |
| 133 | `284d78b3` | Include | feat: add web Sentry SDK with session replay and opt-in API tracing | Security/auth hardening selected. |
| 134 | `1f894988` | Exclude | chore(release): v2.13.1 | Upstream release bookkeeping; fork versioning is canonical and independent. |
| 135 | `33270e37` | Include | feat(api): tag Sentry events with the app release | Observability improvement selected with canonical fork release tagging. |
| 136 | `fddbb150` | Exclude | chore: trim comments in Sentry instrumentation | Comment-only cleanup was neutralized after independent review; no runtime value. |
| 137 | `665895ad` | Exclude | chore(release): v2.13.2 | Upstream release bookkeeping; fork versioning is canonical and independent. |
| 138 | `bea10b21` | Include | fix(i18n): complete translations for all locales | Product localization selected; corporate keys are preserved with fallback values. |
| 139 | `8c76a46a` | Exclude | chore: Add Contributor Covenant Code of Conduct | Upstream OSS governance/site documentation is not product functionality. |
| 140 | `cb19d384` | Exclude | chore(release): v2.14.0 | Upstream release bookkeeping; fork versioning is canonical and independent. |
| 141 | `df608005` | Exclude | docs: update contributors and sponsors | Sponsor/funding/marketing metadata has no corporate-fork value. |
| 142 | `8b88c7d7` | Include | feat(projects): add drag-and-drop project reordering | Core product feature/performance improvement selected. |
| 143 | `de1518f8` | Include | fix(projects): address reorder review findings | Core product/data-integrity bug fix selected. |
| 144 | `2b1f92f2` | Include | fix(projects): show reorder handle on touch and cover archived ordering | Core product/data-integrity bug fix selected. |
| 145 | `c6b87687` | Include | fix(projects): keep omitted projects at their existing rank on reorder | Core product/data-integrity bug fix selected. |
| 146 | `b539c762` | Exclude | fix(billing): keep failed webhooks replayable and preserve subscription dates | Cloud billing/monetization is intentionally excluded from the corporate fork. |
| 147 | `55f1d387` | Exclude | feat(billing): reconcile drifted seat counts hourly | Cloud billing/monetization is intentionally excluded from the corporate fork. |
| 148 | `fa2198e4` | Exclude | chore(release): v2.15.0 | Upstream release bookkeeping; fork versioning is canonical and independent. |
| 149 | `a79d490c` | Exclude | docs: update contributors and sponsors | Sponsor/funding/marketing metadata has no corporate-fork value. |
| 150 | `60d9029a` | Exclude | ci(deps): bump actions/checkout from 6.0.2 to 7.0.1 | No material corporate product/security value or depends on excluded upstream-only scope. |
| 151 | `c6046d8b` | Include | fix(projects): rework project drag-and-drop interaction | Core product/data-integrity bug fix selected. |
| 152 | `5886b929` | Exclude | chore: add Emil Kowalski's design engineering skills | No material corporate product/security value or depends on excluded upstream-only scope. |
| 153 | `7e14a7d2` | Include | fix(web): stop the mermaid render cache evicting diagrams still on screen | Core product/data-integrity bug fix selected. |
| 154 | `ca8c8274` | Include | fix(web): use column isFinal for due-date badges on public views | Core product/data-integrity bug fix selected. |
| 155 | `1099a159` | Include | fix(web): make settings rows responsive and align their typography | Core product/data-integrity bug fix selected. |
| 156 | `6423f463` | Exclude | chore(release): v2.16.0 | Upstream release bookkeeping; fork versioning is canonical and independent. |
| 157 | `24d50f19` | Superseded | chore(deps): bump dev and build tooling majors | Major tooling/dependency batch rejected to preserve PWA/custom-code compatibility. |
| 158 | `9c75b9de` | Superseded | chore(deps): bump the npm-minor group with 18 updates | Follow-up dependency batch depends on excluded major upgrade; selected manifests were resolved directly. |
| 159 | `b0133ee0` | Include | fix(task): validate assignee existence on task creation | Core product/data-integrity bug fix selected. |
| 160 | `cb2f3337` | Include | fix(pr): responding to AI pr reviews | Core product/data-integrity bug fix selected. |
| 161 | `f983f34e` | Include | fix: strip quoted runtime placeholders | Core product/data-integrity bug fix selected. |
| 162 | `16481e3b` | Include | fix(web): avoid nested buttons in alert dialog footers | Core product/data-integrity bug fix selected. |
| 163 | `4a24d74b` | Include | fix(ci): failure in ci after fix | Regression/quality gate selected for included behavior. |
| 164 | `097aeddb` | Include | fix(gitea-integration): handle invalid JSON from non-Gitea URLs | Core product/data-integrity bug fix selected. |
| 165 | `dee61c13` | Include | fix: address placeholder cleanup reviews | Core product/data-integrity bug fix selected. |
| 166 | `f8475b2f` | Exclude | chore(release): v2.16.1 | Upstream release bookkeeping; fork versioning is canonical and independent. |
| 167 | `49eac382` | Include | fix(gitea-integration): structured failure response and test coverage | Regression/quality gate selected for included behavior. |
| 168 | `51131c10` | Include | fix(web): prevent TypeError when relatedTarget is not an Element | Core product/data-integrity bug fix selected. |
| 169 | `fc361d24` | Include | test: add regression test for relatedTarget TypeError in editor mouseleave | Regression/quality gate selected for included behavior. |
| 170 | `8dcb3261` | Exclude | refactor(web): drop redundant throw check and explicit return annotation | Review-only cosmetic refactor was neutralized; the actual regression fix and test remain included. |
| 171 | `364f5e37` | Include | fix(gitea): classify /user 404 as not-a-gitea-instance | Core product/data-integrity bug fix selected. |
| 172 | `494f1fbc` | Include | fix(web): handle unhandled promise rejection from authClient.getSession() | Security/auth hardening selected. |
| 173 | `18ffaa38` | Include | test(task): cover whitespace-padded and whitespace-only assignee userIds | Regression/quality gate selected for included behavior. |
| 174 | `a2772742` | Include | fix(web): preserve full location in auth redirect | Security/auth hardening selected. |
| 175 | `922cee27` | Exclude | chore(release): v2.16.2 | Upstream release bookkeeping; fork versioning is canonical and independent. |
| 176 | `3f9029f9` | Exclude | docs: update contributors and sponsors | Sponsor/funding/marketing metadata has no corporate-fork value. |
| 177 | `f5b3717f` | Include | fix(task): treat blank assignee id as unassigned on task creation | Core product/data-integrity bug fix selected. |
| 178 | `067102b4` | Exclude | chore(release): v2.16.3 | Upstream release bookkeeping; fork versioning is canonical and independent. |

KDL-111 follow-up: PostgreSQL transaction advisory locks now serialize GitHub
repository binding and workspace assignment/offboarding races. Full task updates
compare the assignee authorized by middleware with the locked row. Corporate
migration 0036 also carries only the deterministic per-workspace
`project.position` backfill; excluded billing/cloud schema remains absent.
