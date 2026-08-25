# AIDeskLab mechanical gates — verification targets.
#   make verify-fast : fast Task-level gate (lint + typecheck + unit tests).
#   make verify      : full Outcome-level gate (adds integration tests).

.PHONY: verify-fast verify

verify-fast:
	pnpm lint && pnpm typecheck && pnpm test

verify:
	pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration
