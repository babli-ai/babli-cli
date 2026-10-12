> Read-only mirror of the published `babli` CLI. Source lives in the monorepo (infi-pc/babli). Install with `npm i -g babli`.

# Babli CLI

Use Babli.ai from your commandline. Sync your project with Babli.

## Use

For the complete agent workflow, add new keys to your translation files and run:

```bash
babli sync-and-translate --json --no-interaction
```

This pushes, waits for translation, and pulls completed results. For a cost-controlled operation on existing remote keys:

```bash
babli translate --namespace speech --estimate --json
babli translate --namespace speech --max-credits 7.00 --wait --json
babli pull --namespace speech --json --no-interaction
```

Push new local keys before requesting an exact estimate. If waiting times out, use the returned job id with `babli job <job_id> --wait`; do not dispatch `translate` again.

### Answer questions from an agent

```bash
babli questions --json
babli questions --answers-file answers.json --json --no-interaction
```

JSON listing never prompts. It includes each question's `keyId`, `languageId`, `languageCode`, `keyName`, and `question`. Build `answers.json` from those identifiers:

```json
{
  "answers": [{
    "keyId": "<key UUID from questions>",
    "languageId": "<language UUID from questions>",
    "questionText": "<exact question text>",
    "answer": "Use formal address."
  }]
}
```

Answer submission requires a user token from `babli login`; project API keys can list questions but cannot submit answers. A batch of up to 500 answers is validated and saved atomically. Unknown questions, duplicate entries, and blank answers are rejected.

The response contains remaining questions and `retranslationRequired`. Retranslate the affected keys and languages to use the answers. Saving an answer clears their cached scores; earlier jobs cannot restore those scores without the saved answers in their input. Answers apply only to their key and language.

Generation and saving check ICU arguments, format specifiers, select branches, explicit plural selectors, rich-text component tags, and common `{{name}}` placeholders. Locale-specific plural categories may change. Invalid output is retried during generation and rejected before saving. These checks do not establish linguistic correctness; arbitrary HTML, printf syntax, and custom template formats are not covered.

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
- run `babli sync-and-translate --json --no-interaction` to safely push, wait, and pull

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

### Empty translation placeholders

If local translation files represent untranslated values with a sentinel, set
`emptyValueString` so Babli synchronizes that value as an empty placeholder:

```json
{
  "projectId": "<your projectId>",
  "translationFiles": [{ "path": "src/translations/{{lang}}.json" }],
  "emptyValueString": ""
}
```

The empty string is supported, as are non-empty sentinels such as
`"NOT_TRANSLATED"`. This setting applies to local file values; approved
non-empty server translations are never overwritten automatically.




```
