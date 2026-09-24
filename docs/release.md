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

## Bootstrap the first npm release

npm requires the package to exist before its trusted publisher can be
configured. The GitHub workflow therefore skips publication while
`useless-tests` is absent from npm. After the release commit has passed CI and
landed on `main`, an npm maintainer signs in with two-factor authentication
and publishes that commit's tested tarball:

```sh
npm login
npm whoami
pnpm install --frozen-lockfile
pnpm check
pnpm check:package
npm pack --ignore-scripts
node scripts/test-pack.mjs --tarball useless-tests-0.2.0.tgz
npm publish ./useless-tests-0.2.0.tgz --access public --ignore-scripts
```

Use the version from `package.json` in the two tarball commands. After npm
lists the package, verify its version and install the public package in a
fresh directory before announcing the release.

## Configure later releases

In the npm package settings, configure GitHub Actions as a trusted publisher:

- Owner: `a-github-name`
- Repository: `useless`
- Workflow filename: `publish.yml`
- Environment: `npm`

The repository's `publish.yml` checks for a version absent from npm, builds
and smoke-tests a tarball, publishes that same tarball through npm OIDC, and
creates a matching GitHub release. It needs no npm token. A private GitHub
repository can publish this way, but npm does not generate public source
provenance for a private repository. See the
[npm trusted publishing guide](https://docs.npmjs.com/trusted-publishers/).
