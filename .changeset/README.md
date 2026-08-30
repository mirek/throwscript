# Changesets

Every pull request adds one markdown file here instead of editing package versions —
uniquely named files never conflict between concurrent pull requests. Format:

```md
---
"@mirek/throwscript-core": minor
"@mirek/throwscript-cli": minor
"@mirek/eslint-plugin-throwscript": minor
---

One-line summary of the change.
```

All packages are released in lockstep (`fixed` in `config.json`): naming any of them
bumps all to the same version. Pick the bump the change needs:

- `patch` — fixes and documentation;
- `minor` — new features;
- `major` — breaking changes.

A pull request that changes nothing publishable (CI, scripts, repository docs) still needs a
file, so that nothing is ever forgotten: run `pnpm changeset --empty`.

## How a release happens

1. Merged changesets accumulate on `main`. The **Publish** workflow
   (`.github/workflows/publish.yml`) opens or updates the `chore(release): version packages`
   pull request (branch `changeset-release/main`), which runs `pnpm version-packages`:
   `changeset version` bumps the packages, prepends their `CHANGELOG.md` entries, and deletes
   the consumed files.
2. Merging that pull request leaves `main` with no pending changesets, so the same workflow
   runs `pnpm verify` and then `pnpm release:publish` (`changeset publish`): every package
   whose version is not yet on npm is published with provenance and tagged
   `<package>@<version>`. Packages already on npm are skipped, so a failed run is simply
   re-run.

npm authentication is OIDC trusted publishing: each `@mirek/throwscript-*` package lists this
repository and the workflow file name `publish.yml` as its trusted publisher on npmjs.com, so
do not rename the workflow file. A brand-new package cannot use trusted publishing for its
first release — publish it once from a maintainer machine (`npm login`, then
`pnpm build && pnpm release:publish`), add the trusted publisher on npmjs.com, and re-run the
workflow.

Do not run `npm version` or `pnpm publish` in individual packages by hand.
