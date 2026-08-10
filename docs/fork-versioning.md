# Fork versioning

This fork uses the Docker-safe SemVer prerelease format
`<upstream>-aidesk.<counter>`, for example `2.16.3-aidesk.0`.

The root `package.json` is the source of truth: `version` is the canonical
version, while `upstreamVersion` and `counter` store its components.
`charts/kaneo/Chart.yaml`, the web UI, and `GET /api/version` must agree with
that metadata. Run `pnpm version:check` to verify the stored files.

After every pull request merged into `main`, the `Update fork version` workflow
increments only the fork counter. It does not query upstream tags and never
changes `upstreamVersion` automatically.

For a selective upstream synchronization, first fetch the upstream commits and
choose which reviewed commits to apply (choosing none is allowed). Then run the
`Update fork version` workflow manually and provide the exact stable upstream
version/tag from which that synchronization was performed. The workflow records
that explicit base and resets the counter to zero; it never substitutes the
latest release available at execution time. Older upstream versions are
rejected, while synchronizing the same version again makes no change.

For local checks, increment needs no upstream argument. Sync requires the exact
stable upstream version/tag used as the synchronization source:

```sh
pnpm version:increment
pnpm version:sync 2.17.0
pnpm version:test
```

The `version:sync` package script supplies `--upstream-version`; its positional
value is required. `version:increment` is for a merged fork PR, while sync
changes the base only when the explicitly supplied upstream version is newer.
