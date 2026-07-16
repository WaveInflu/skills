# Setup and release

## Contract

`npx @waveinflu/setup@latest` is the single entry point for first installation and later updates.

| Run | Behavior |
|---|---|
| First run | Install every published WaveInflu Skill, request the Key through hidden input, save credentials |
| Later run | Refresh existing Skills, install newly published Skills, keep the saved Key |
| `--reconfigure` | Refresh every published Skill, replace the saved Key |
| `--status` | Check only the local credential file; never call the API |

Credentials live outside installed Skill directories, so a Skill update cannot overwrite them. Runtime resolution is `WAVEINFLU_API_KEY` first for CI/automation, then the user credential file.

Setup deliberately selects `*` from the repository on every normal run. Adding another directory under `skills/` therefore needs no Setup code change; users receive it the next time they run the same `@latest` command.

## Versioning

| Artifact | Version |
|---|---|
| Setup npm package | `packages/setup/package.json` |
| Skills release | Root `package.json` and both scripts' `CLIENT_VERSION` |
| Setup release tag | `setup-v<package-version>` |

Use patch versions for fixes, minor versions for additive behavior, and major versions for breaking Setup flags or credential formats. Keep credential format `version: 1` readable until an explicit migration exists.

## Release

1. Bump the affected versions.
2. Run `npm run check` and `npm pack --dry-run --workspace @waveinflu/setup`.
3. Merge the reviewed change to `main`.
4. Create a GitHub Release tagged `setup-v<package-version>` when Setup changed.
5. Verify the npm package and run Setup from a clean temporary HOME.

The first npm publication must be performed by an authenticated `@waveinflu` npm maintainer with 2FA:

```bash
npm publish --workspace @waveinflu/setup --access public
```

After the package exists, configure npm Trusted Publishing for GitHub organization `WaveInflu`, repository `skills`, and workflow `publish-setup.yml`. Later GitHub Releases publish through OIDC without a long-lived npm token.
