# Publishing to npm

अर्जुनः publishes two public packages from this repository:

- `arjunah`: the website SDK in `packages/sdk/`
- `arjunah-desktop`: the optional desktop companion in `desktop/`

Normal releases use npm trusted publishing from `.github/workflows/publish-npm.yml`. GitHub receives a short-lived OIDC credential for each run; there is no `NPM_TOKEN` repository secret. This same workflow owns the complete tagged release so GitHub cannot advertise a desktop version before npm has published and verified it.

## One-time package bootstrap

npm can attach a trusted publisher only after a package exists. A maintainer must therefore create each package with one interactive publish from a trusted checkout. Enable 2FA on the npm account first, then run from the repository root:

```sh
npm login --auth-type=web
npm whoami
npm run check
npm publish --workspace arjunah --access public --tag alpha
npm publish --workspace arjunah-desktop --access public --tag alpha
```

These commands create `arjunah@1.0.0-alpha.1` and `arjunah-desktop@1.0.0-alpha.1` under the `alpha` dist-tag. npm package versions are immutable. If the first publish succeeds and the second fails, fix the second package and publish only that workspace; do not try to republish the first version.

On a package's first publication npm may also create a `latest` tag even when `--tag alpha` was supplied. Remove it while signed in interactively so plain installs do not resolve to the prerelease:

```sh
npm dist-tag rm arjunah latest
npm dist-tag rm arjunah-desktop latest
```

Alpha users install with:

```sh
npm install arjunah@alpha
npm install --global arjunah-desktop@alpha
```

## Configure npm trusted publishers

On npmjs.com, open **Settings → Trusted Publisher** for each package and add the same GitHub Actions publisher:

| Field | Value |
| --- | --- |
| Organization or user | `mesudip` |
| Repository | `arjunah` |
| Workflow filename | `publish-npm.yml` |
| Environment | leave blank |
| Allowed action | allow direct `npm publish` |

Configure both `arjunah` and `arjunah-desktop`. The workflow filename is only the filename, not `.github/workflows/publish-npm.yml`. The repository fields in both package manifests already point to `https://github.com/mesudip/arjunah`.

## Publish later versions

1. Update every synchronized version location listed in `AGENTS.md` and commit the change.
2. Push the commit to `main` and wait for CI to pass.
3. Push an annotated `v<package-version>` tag.
4. Confirm the **Release** workflow publishes and verifies both package versions before its GitHub release job starts.
5. Confirm both package pages show the expected dist-tag and GitHub provenance.

The workflow runs the complete project check and Firefox package lint before publishing anything. It builds the extension archives, publishes the SDK followed by the desktop companion, waits for npm to expose both exact versions under the correct `alpha` or `latest` tag, and only then creates the GitHub release. A failure before registry verification leaves no GitHub release claiming that npm installation is ready.

Publication is safe to rerun after a partial failure: an exact package version already present on npm is left untouched, while a missing sibling package is published. The registry verification still requires both packages and the expected dist-tag. To repair a partial publication without creating another GitHub release, open **Actions → Release → Run workflow** and choose the tag appropriate to the package version.
