> Read-only mirror of the published `babli` CLI. Source lives in the [monorepo](https://github.com/infi-pc/babli). Install with `npm i -g babli`.

# Babli CLI

Use Babli.ai from your commandline. Sync your project with Babli.

## Use

When you have new keys to translate. Add them to one of your translation files. And then

- run `babli login` if you haven't already
- `babli push` - push new keys/translations to Babli.ai
- translate them on [babli.ai](https://www.babli.ai/app)
- `babli pull` - pull the new translations to your project

## Install

```bash
npm install -g babli
```

## Workspace development

Start local dev (links globally + watches for changes):

```bash
pnpm cli:watch-and-link
```

`babli --version` should show a `-dev` suffix while you are using the local watch build, plus the repo root folder name so you can tell which worktree is linked.

When done, restore the published npm version:

```bash
pnpm cli:unlink
```

If you only need a one-time local install snapshot, use:

```bash
pnpm cli:install-local
```

## Release

The canonical release process is the **`/release` skill** (see `.claude/skills/release/`).
It curates the `CHANGELOG.md`, bumps the version, promotes `develop` → `main`, pushes the
`cli-v*` tag (which triggers the npm publish below), and syncs the public mirror at
[`babli-ai/babli-cli`](https://github.com/babli-ai/babli-cli). Releases are maintainers-only.

If you need to release manually, the underlying steps are:

1. Bump `apps/cli/package.json` version and add a `CHANGELOG.md` entry.
2. Land it on `main`.
3. Create and push a tag that matches the CLI version:

```bash
git tag cli-v0.5.1
git push origin cli-v0.5.1
```

The publish workflow:

- only runs for `cli-v*` tags
- verifies the tag matches `apps/cli/package.json`
- runs CLI and shared-package checks
- publishes `apps/cli` to npm from CI

Before this works, configure npm trusted publishing for the `babli` package to trust:

- repository: this repo
- workflow file: `publish-cli.yml`
- environment: `npm-publish`

If the version is a prerelease such as `0.1.0-beta.1`, CI publishes it under the matching npm dist-tag such as `beta`.

## Use in CI

- set `BABLI_API_KEY` env variable (find it in your project settings)
- run `babli pull` to pull translations from babli.ai

## Create a project from the CLI

Create a new Babli.ai project without leaving the terminal:

```bash
babli project create --name "My App" --organization <organizationId>
```

Then add the returned `projectId` to your `babli.json` (see Manual Setup below).

## Manual Setup

1. Create a `babli.json` or `babli.yaml` file in the root of your project
2. Create an empty project in [babli.ai](https://www.babli.ai/app) and get your projectId
3. Add your projectId and translation file path pattern
   ```json
   {
     "projectId": "<your projectId>",
     "translationFiles": [{ "path": "src/translations/{{lang}}.json" }]
   }
   ```
4. Then you can push your keys from your project `babli push`




```
