# Fork versioning

This fork uses the Docker-safe SemVer prerelease format
`<upstream>-aidesk.<counter>`, for example `2.16.3-aidesk.0`.

The root `package.json` is the source of truth: `version` is the canonical
version, while `upstreamVersion` and `counter` store its components.
`charts/kaneo/Chart.yaml`, the web UI, and `GET /api/version` must agree with
that metadata. Run `pnpm version:check` to verify the stored files.

After every pull request merged into `main`, the `Update fork version` workflow
finds the latest stable `usekaneo/kaneo` tag. It increments the counter when the
upstream base is unchanged. When the upstream base is newer, it adopts that base
and resets the counter to zero. Older upstream versions are always rejected.

Selective upstream changes and version tracking are independent. Cherry-pick or
otherwise apply only the upstream commits that have been reviewed and accepted;
do not edit version fields as part of that operation. Afterward, run the
`Update fork version` workflow manually to record a newly published upstream
base even when no upstream commit was accepted and no pull request was created.

For local checks, supply an explicit stable upstream tag:

```sh
pnpm version:increment --latest-upstream 2.16.3
pnpm version:sync --latest-upstream 2.17.0
pnpm version:test
```

`version:increment` is for a merged fork PR. `version:sync` only changes the
version when the supplied upstream base is newer.
