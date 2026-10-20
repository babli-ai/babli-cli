> Read-only mirror of the published `babli` CLI. Source lives in the monorepo (infi-pc/babli). Install with `npm i -g babli`.

# Babli CLI

To archive keys that are no longer in your configured local translation files:

```bash
babli push --prune --dry-run --json
babli push --prune --no-interaction
```

`push --prune` also uploads local changes but does not start AI translation. It supports `--key` and `--namespace` filters and handles deletion-only changes. Keys present in any configured local language file are kept; this does not scan application code for usage. Archives preserve translations and can be restored with `babli key unarchive`.

Use `sync-and-translate --prune --json` to include archiving in the full translation workflow. Without `--prune`, noninteractive commands keep server-only keys; interactive sync offers a choice even when there is nothing to upload.

Both commands refuse to archive keys when no configured local files are found. Check your file paths, or add `--allow-empty-prune` when this is intentional. This flag does not enable pruning by itself. Existing files containing no keys are valid inputs. Archiving runs after all upload batches succeed; a failed upload keeps the old keys active.


Use Babli.ai from your commandline. Sync your project with Babli.

## Use

Agents must prepare descriptions for the selected keys before starting translation.
Add new keys and source text to your translation files, then push and export:

```bash
babli push --json --no-interaction
babli key export --language en --output keys.json --json --no-interaction
```

Use the project's source language in place of `en`. Inspect the selected keys' code
usages and keep useful existing descriptions. Draft missing or outdated descriptions
with their UI role, intended meaning, and placeholder meanings, then save them:

```bash
babli key update --file descriptions.json --dry-run --json --no-interaction
babli key update --file descriptions.json --json --no-interaction
```

See [Write key descriptions from code context](#write-key-descriptions-from-code-context)
for the file format and guards. Resolve upload conflicts before translating. Record
unclear keys as unresolved, and leave them out of translation until clarified;
use `translate --key-id <id>` for a resolved subset. Do not invent context to fill
missing descriptions.

Once descriptions are saved, estimate, translate, and pull the same prepared scope:

```bash
babli translate --namespace speech --estimate --json
babli translate --namespace speech --max-credits 7.00 --wait --json
babli pull --namespace speech --json --no-interaction
```

The example uses the `speech` namespace; choose your prepared keys with `--namespace`,
`--key`, or `--key-id`. Use `sync-and-translate` only when descriptions cover all
selected keys and their current source text. It pushes, waits for translation, and
pulls results without pausing to prepare descriptions. After source or usage changes,
push first and revisit the affected descriptions before using it.

This is required agent guidance; the CLI does not automatically enforce description
coverage. Push new local keys before requesting an exact estimate. If waiting times
out, use the returned job id with `babli job <job_id> --wait`; do not dispatch
`translate` again.

`translate --wait`, `job`, and `sync-and-translate` return `follow_up`. Generation
completion does not mean questions are resolved or linguistic review happened.
Question discovery also runs when generation is skipped. A `pending` result tells
you to resume the existing job; `unavailable` means inspection must be retried.

For every question, check repository evidence and the supplied context. Save
supported answers; ask the user about unknown product facts. Questions marked
`earlier` came from previous jobs and need a relevance check. Do not invent answers
to clear the list. Answering requires `babli login`; project API keys can inspect
questions only.

After saving answers, inspect current wording. Use returned exact-pair actions to
estimate any required regeneration, then pass the remaining authorized budget with
`--max-credits` before spending. Existing unapproved wording requires
`--strategy not-approved`; repeating missing-only sync skips it. Approved text
needs an explicit decision and must never be silently unapproved. Pull again after
corrections. Report unresolved questions and `review_status: not_requested` honestly.

### Answer questions from an agent

```bash
babli questions --json
babli questions --job <job-id> --json
babli questions --namespace checkout --languages de,fr --json
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

The response contains remaining questions, exact `affected_pairs`, safe `next_actions`, and the legacy `retranslationRequired` hint. Inspect or review the affected wording with the new answers; regenerate only when needed and explicitly authorized. Saving an answer clears their cached scores; earlier jobs cannot restore those scores without the saved answers in their input. Answers apply only to their key and language.

Generation and saving check ICU arguments, format specifiers, select branches, explicit plural selectors, rich-text component tags, and common `{{name}}` placeholders. Locale-specific plural categories may change. Invalid output is retried during generation and rejected before saving. These checks do not establish linguistic correctness; arbitrary HTML, printf syntax, and custom template formats are not covered.

### Review translations through your coding agent

After resolving generation questions, estimate and request linguistic review of the exact job or selected existing translations:

```bash
babli quality check --job <translation-job-id> --estimate --json
babli quality check --job <translation-job-id> --max-credits 2.00 --wait --json --no-interaction
babli quality check --namespace checkout --languages de,fr --source en --estimate --json
babli quality show <run-id> --wait --json
```

Review uses one configured model (default `gpt-4.1`; `--model` also accepts the configured Gemini reviewers). It checks source meaning, descriptions, instructions, glossary, saved answers, usages, and supported technical constraints. It neither generates missing translations nor approves output. The first release supports default-type translations in stored-key projects. Ambiguous source selection requires `--source`.

Pricing is 1 credit (100 units) per batch of at most four targets in one locale, with at most 12,000 estimated input tokens and 8,000 output tokens. Technical failures are reported before paid linguistic review. Estimate first; `--max-credits` is mandatory for submission. Track the overall translation/review/recheck budget yourself and pass the remaining allowance to each paid command. Preserve the printed request ID and reuse it with identical arguments after an uncertain submission; `show` resumes existing work without another charge.

Inspect each finding against repository evidence. A suggestion is a claim to evaluate. Apply supported corrections, dismiss evidenced false positives with reasons, clarify unknown product meaning, or defer judgments you cannot substantiate. Do not invent product facts, silently unapprove existing wording, or claim that model agreement proves correctness.

Record decisions in a JSON file using identifiers, `inputHash`, and `decisionRevision` from `quality show`:

```json
{
  "decisions": [{
    "requestId": "<new UUID retained for retries>",
    "resultId": "<review result UUID>",
    "expectedRevision": 0,
    "inputHash": "<exact 64-character input hash>",
    "findingIds": ["<finding ID>"],
    "action": "apply",
    "value": "Corrected translation",
    "reason": "The description establishes that this action removes membership.",
    "evidence": ["src/team/removeMember.ts: membership is deleted; the account is retained"]
  }]
}
```

```bash
babli quality decide --file decisions.json --json --no-interaction
babli quality check --recheck <result-id> --estimate --json
babli quality check --recheck <result-id> --max-credits 1.00 --wait --json --no-interaction
```

Use one final replacement per translation even when addressing several findings. `dismiss`, `clarify`, and `defer` require a reason; `clarify` also requires `answer`. Decisions are guarded by input hash and decision revision. A changed version or context requires a recheck. Decision request IDs are scoped to their result. Identical decision request IDs return the original receipt; a different payload with that ID is rejected. Batch decisions return per-target receipts and errors.

Applying wording creates an unapproved version. Dismissal preserves the reviewer's report and records the agent's separate judgment. Review-only clarifications reach explicit rechecks of that result; to inform future independent reviews or generation, deliberately save the fact in appropriate existing context. Rechecks can retain valid wording. Propose one correction/recheck cycle per target by default, then report persistent uncertainty or request a deliberate next step within budget.

Provider execution retries are bounded and successful results are retained. Permanently failed items refund their allocated charge once. `babli quality retry <run-id> --wait --json` permits the original requesting user one additional execution attempt without another debit; refunds already issued remain. A different model or changed inputs requires a new quoted run. Questions/defects in a valid review are billable results.

Final reports must distinguish reviewer outcome (`no_issues_found`, `issues_found`, `needs_context`), agent decisions, stale/unavailable evidence, incomplete execution, unanswered generation questions, and publication approval. Review findings do not change exit code 0; execution failure/timeout or rejected batch decisions return 2. The new web Review tab is read-only and shows reports, findings, decisions, and scoped CLI guidance. Existing `babli review` remains score-based approval; approved-only pull does not certify linguistic review.

### Write key descriptions from code context

Export active keys with one language's text and current descriptions:

```bash
babli key export --language en --output keys.json --json --no-interaction
```

The export has `version`, `projectId`, `language`, and `keys`. Each key contains
`keyId`, `key`, `namespace`, `source`, `sourceText`, `sourceVersionId`, and
`description`. `source` is the file-placement value used by `{{source}}` paths.
It is distinct from `sourceText`, which is the source-language translation.
Missing source translations have null text/version fields and need source text
before drafting. Export reads pages of up to 500 keys, without loading other
languages. Pages are read separately; export again if keys change during the run.

Agents must inspect local code usages and prepare descriptions for new or changed
keys before translating them. Existing accurate descriptions can be retained.
Write missing or outdated descriptions in a descriptions file:

```json
{
  "version": 1,
  "projectId": "<project UUID from export>",
  "language": "en",
  "items": [
    {
      "keyId": "<key UUID from export>",
      "expectedDescription": null,
      "expectedSourceVersionId": "<source version UUID from export>",
      "description": "Button that submits the booking and opens the payment step.",
      "status": "drafted"
    },
    {
      "keyId": "<another key UUID from export>",
      "status": "unresolved",
      "reason": "No reliable usage context found."
    }
  ]
}
```

Copy both expected values exactly from the export. Keep existing descriptions
unless deliberately revising them. Describe where the text appears, what it
means, and any placeholders or wording constraints. Skip keys whose meaning is
unclear; absence of collected usages does not establish that a key is unused.
Code excerpts, evidence paths, and other drafting metadata stay local.

```bash
babli key update --file descriptions.json --dry-run --json --no-interaction
babli key update --file descriptions.json --json --no-interaction
```

The CLI validates the complete file and project before sending changes, skips
unresolved entries, and sends descriptions in batches of at most 100. Each batch
is atomic: a changed source version or unexpected description rejects that whole
batch. Earlier successful batches remain saved. Dry-run checks current state
without reserving it; applying checks again.

On failure, the command exits with code 2 and reports completed batches and the
error. After resolving conflicts, rerun the file: descriptions already set to the
requested value are unchanged, provided their source version still matches.
Saving descriptions does not start translation jobs or upload local code usages.

These commands require the key-context export and description-batch API routes.
Deploy the updated Babli server before releasing the CLI version that includes
them. Existing single-key commands continue to work.

### Rename keys in bulk

Build an explicit manifest from the export. One manifest contains 1–1,000 keys
for the configured project. The command updates the existing key records, so
translations, approvals, history, and descriptions stay attached to the same IDs.

```bash
babli key rename --file renames.json --dry-run --json --no-interaction
babli key rename --file renames.json --json --no-interaction
```

`--file -` reads the same JSON from stdin. `--file` cannot be combined with
`--key`, `--key-id`, `--namespace`, or `--to`. Single-key rename still uses
`--to`.

```json
{
  "version": 1,
  "projectId": "<project UUID from export>",
  "items": [
    {
      "keyId": "<key UUID from export>",
      "expectedKey": "vouchers.title",
      "expectedNamespace": "",
      "expectedSource": "datatable/vouchers",
      "to": "commerce.vouchers.title",
      "toNamespace": "",
      "toSource": "commerce/vouchers"
    }
  ]
}
```

Copy export `key` to `expectedKey`, `namespace` to `expectedNamespace`, and
`source` to `expectedSource`. Leave `description`, `sourceText`, and
`sourceVersionId` off the manifest. `to` is required. Omit `toNamespace` or
`toSource` to preserve that field; set either to `""` to clear it. Unknown
fields are rejected as `invalid_rename_file`. Values are stored exactly,
without trimming.

The operation is atomic. Duplicate IDs, blank names, archived keys, stale
expected state, and a final namespace/key pair already used by another key —
including an archived key — reject the whole manifest. Names can swap or form
chains such as `a → b`, `b → c`. Uniqueness is project, namespace, and key.
Source chooses the file and does not create a second identity.

A retry is `unchanged` only when the key already has the complete requested
name, namespace, and source. Dry-run does not reserve those names. If the
network fails after apply starts, the outcome is unconfirmed; rerun the same
manifest. Validation and application errors exit 2.

With `--json`, success and failure are separate documents. Success `status` is
`dry_run` or `renamed`. A completed retry shows `counts.unchanged` and
`items[].status` of `unchanged`; the top-level status stays `renamed` or
`dry_run`. Each item uses `key_id` and `from` / `to` objects with `key`,
`namespace`, and `source`. `file_changes` is taken from the manifest before the
request, and each `key_id` there is lowercase. On a retry, `items[].from` is
the state already stored, while `file_changes[].from` still lists the paths
from that manifest.

```json
{
  "version": 1,
  "command": "key_rename",
  "status": "renamed",
  "project_id": "<project UUID>",
  "dry_run": false,
  "counts": { "total": 1, "renamed": 1, "would_rename": 0, "unchanged": 0 },
  "items": [
    {
      "index": 0,
      "key_id": "<key UUID>",
      "status": "renamed",
      "from": {
        "key": "vouchers.title",
        "namespace": "",
        "source": "datatable/vouchers"
      },
      "to": {
        "key": "commerce.vouchers.title",
        "namespace": "",
        "source": "commerce/vouchers"
      }
    }
  ],
  "file_changes": [
    {
      "index": 0,
      "key_id": "<key UUID>",
      "from": ["<paths for the expected placement>"],
      "to": ["<paths for the requested placement>"]
    }
  ]
}
```

A failure uses the error envelope. Conflicts are at `error.details.conflicts`.

```json
{
  "version": 1,
  "status": "error",
  "error": {
    "message": "Conflict",
    "code": "rename_conflict",
    "http_status": 409,
    "details": { "conflicts": [] }
  }
}
```

The command changes remote records. Follow one order: push, rename, pull. Push
first so every local key and translation is on the server; the command refuses
to run while `babli status` reports unpushed changes, unless you pass
`--allow-unpushed`. Update application references from the same manifest, apply
the remote rename, then pull. Do not push between those steps: sync matches keys
by namespace and name, so a push would recreate the old names as new records.
Pull writes the new names and source placements, removes the old names as
local-only keys, and deletes a source or namespace file when every key in that
file moved. Full pulls also remove never-pushed local keys, including keys in
files with no remaining server keys. Push local content you want to retain
before pulling, or use `pull --keep-local-only`.

Manifest renames preview the resulting standard-file output before changing
the server. They reject parent/child key collisions in nested output (such as
`title` and `title.short`) and destination paths differing only by case or
Unicode normalization. The path restriction applies on all platforms.

Custom transforms are not covered by this output validation or old-key
cleanup. A pull through a transform can retain the old names after a rename.
Update the transformed content manually to remove those names, then check
`babli status` before pushing.

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
