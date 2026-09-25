# Release `useless-tests`

The npm package contains the CLI, TypeScript library, tree-sitter grammars,
and audit skill. Build and test the files that users install before publishing.

## Verify a release candidate

From a clean commit on the intended release branch, run:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm check:package
pnpm test:pack
```

Review `npm pack --dry-run --ignore-scripts` and confirm the version in
`package.json` is absent from npm. The packed CLI requires a Git checkout to
scan; `test:pack` installs the tarball in a temporary directory and scans a
fixture repo through both the CLI and library API.

## First release record

Version `0.2.0` was published from commit
`e4d0aabbb0f85c602cd66fc97545734c52159709` after CI and a tarball
installation test. npm requires the package to exist before its trusted
publisher can be configured, so this first version used an authenticated npm
publish. The [GitHub release](https://github.com/a-github-name/useless/releases/tag/v0.2.0)
includes the tarball and its SHA-256 checksum. The registry tarball matched
the tested tarball byte for byte.

## First trusted publisher release

Version `0.3.0` was published from merge commit
`732bb584abe8929f3f16844911beabb6b65ceef1` through the `publish.yml`
trusted publisher. The workflow built and smoke-tested the tarball before
publishing it with signed provenance. The npm registry SHA-1
(`6c23a41b94123f9c5e97e13e6c0759130e92b829`) matches the workflow
artifact. The [GitHub release](https://github.com/a-github-name/useless/releases/tag/v0.3.0)
tag points to the same merge commit.

## Publish later releases

The npm package has a GitHub Actions trusted publisher configured with:

- Owner: `a-github-name`
- Repository: `useless`
- Workflow filename: `publish.yml`
- Environment: `npm`

Increase the version in `package.json` and merge the release commit into
`main`. The repository's `publish.yml` checks for a version absent from npm,
builds and smoke-tests a tarball, publishes that same tarball through npm OIDC, and
creates a matching GitHub release. It needs no npm token. See the
[npm trusted publishing guide](https://docs.npmjs.com/trusted-publishers/).
