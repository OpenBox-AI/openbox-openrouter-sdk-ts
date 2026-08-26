# Releasing

Releases are cut by bumping the version in `package.json` on `main`. The
[`release.yml`](.github/workflows/release.yml) workflow does the rest.

## The process

1. Make sure `main` is green (PR Quality, PR Security and PR Governance all
   pass).
2. Bump the version:

   ```bash
   npm version patch    # or minor / major
   ```

   This writes `package.json`, updates the lockfile and creates a `v<version>`
   commit and tag locally.
3. Push:

   ```bash
   git push origin main --follow-tags
   ```

The push to `main` touching `package.json` triggers the release pipeline.

## What the pipeline does

| Stage | Gate |
|---|---|
| **Governance** | Required files exist; the version is not already on npm. Everything downstream is skipped when the version is unchanged, so an unrelated `package.json` edit does not publish. |
| **Quality** | Type-check, build, tests on Node 20 and 22, and a check that `dist/` is actually in the package. |
| **Security** | Trivy (HIGH/CRITICAL, fixable, dependencies) and Gitleaks (secrets). Both upload SARIF to the Security tab. |
| **Publish** | `npm publish --provenance --access public`, then a GitHub Release for the tag. |

Quality and both security stages run in parallel; publish waits for all three.

## npm authentication

Preferred is OIDC Trusted Publishing, which needs no long-lived secret:

1. npmjs.com → package settings → **Publish access** → **Trusted Publishers**
2. Add: GitHub Actions, owner `OpenBox-AI`, repo `openbox-openrouter-sdk-ts`,
   workflow `release.yml`
3. Leave `NPM_TOKEN` unset.

Fallback: add `NPM_TOKEN` to repository secrets (Settings → Secrets → Actions).

## Versioning

Semantic versioning. Bump **major** for a breaking change to the public surface
(`createOpenBoxGovernance`, its options, or the exported types), **minor** for
new capability, **patch** for fixes.

Pre-release versions (`1.2.0-rc.1`) publish under the `rc` dist-tag rather than
`latest` — pass `--tag rc` when publishing manually, or bump with
`npm version prerelease --preid rc`.
