# Changelog

All notable changes to the Babli CLI are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.11.1] - 2026-11-05

### Fixed

- Reduce startup time and memory use for large projects by comparing compact key fingerprints instead of downloading all translations and review details before showing the menu. Existing servers retain the full-comparison fallback.

### Changed

- Request compact approval and blocking flags instead of full review summaries when supported by the server, preserving stale-approval handling and unresolved-concern blockers.
- Omit unused internal quality plans from translation estimates and job responses while retaining credit information, quotes and job IDs. Server approval and billing checks still apply.

## [0.11.0] - 2026-11-05

### Added

- `translate --allow-unapproved-sources` permits translation without current AI or human source approval. Unresolved concerns still block translation.

### Changed

- Scoped `push --dry-run` compares every local value using compact fingerprints, preserves the exact withheld-change count, and downloads wording only for selected keys when supported by the server. Older servers continue to use the existing lookup.

## [0.10.1] - 2026-11-03

### Fixed

- Include the patched validation and glob-matching code in the installed CLI so npm users receive the same security fixes as the monorepo.
- Exclude locally cached login credentials from CLI package archives.
- Verify a clean package installation and audit its runtime dependencies before publishing.

## [0.10.0] - 2026-11-03

### Added

- Manage organization metadata and shared translation instructions with `organization list`, `get`, and `update`.
- Manage project and organization glossaries: list, inspect, create/update, remove, import/export, and move project terms to the organization.
- Request human review of selected translations and inspect invitation status with `human-review request` and `human-review status`.
- Select a primary source language and supporting-reference approval mode for translation with `--primary-language` and `--reference-mode`.

### Changed

- **Breaking:** stored-key operations require the new server review contract. Upgrade the CLI when the server is upgraded; older clients are rejected.
- Approval now comes from a current AI pass or explicit human approval. Saved wording and imports do not automatically approve translations, and old approval flags are not migrated. Source wording may need review before translation.
- `quality check` uses the Argon reviewer (`gemini-4-argon`) and shared batch estimates; a current successful AI review grants AI approval.
- Replacement translation requires an explicit key, key ID, or namespace scope.
- **Breaking:** `pull --json` now uses output version 2. It reports completed additions, updates, removals, changed files, and translations still missing locally instead of the previous missing-key and missing-translation summary. Translation totals include updates, and changed-only or removal-only pulls report `pulled`.

### Fixed

- Pull reports reflect files actually written, including custom-transform output.

### Removed

- Legacy `review` and `proofread` commands, `translation approve` and `translation unapprove`, approval-on-upsert flags, and approved-only pull flags. Use `quality` for AI review and the human-review workspace for human decisions.

## [0.9.0] - 2026-10-20

### Added

- `key rename --file` atomically renames keys, moves namespaces, and changes source-file placement. Supports dry runs and safe retries. Rejects unpushed local changes by default (`--allow-unpushed` overrides), nested-key collisions, and conflicting destination paths. Run `pull` after applying a rename.
- `key export` includes each key's `source`.
- `push --prune` and `sync-and-translate --prune` archive server keys absent from all configured local translation files, respecting key and namespace filters. Archived keys retain their translations. When no local files are found, pruning requires `--allow-empty-prune`.
- `push --dry-run` previews uploads and archives without changing the server.
- `quality check`, `show`, `decide`, and `retry` provide linguistic review of existing translations, with estimates, findings, decisions, and rechecks. Submitting a review requires an explicit `--max-credits` cap.
- `questions` supports `--job`, `--key`, `--namespace`, `--key-id`, and `--languages` filters.
- Translation completion, job status, sync, and saved question answers include `follow_up` information with question status and scoped next actions.
- `pull --keep-local-only` preserves keys that exist only locally.

### Changed

- **Full pulls now remove local-only keys from standard translation files, including never-pushed keys.** Interactive runs ask first; noninteractive runs remove them automatically. Push local additions before pulling, or use `--keep-local-only`. Scoped pulls preserve local-only keys and content outside their scope. JSON output lists removals in `removed_keys`.
- Pull follows current source and namespace placement, removes obsolete names, and deletes emptied source or namespace files. Output collisions are rejected before writing. Custom transforms require manual rename cleanup.
- CLI guidance now requires agents to prepare and save key descriptions before translating.

### Fixed

- `sync-and-translate` handles server-only keys even when there is nothing to upload, and pushes containing only removals are processed correctly.
- Noninteractive sync no longer recreates local keys that were intentionally kept only on the server.
- Large `--json` output is no longer truncated when piped to another command.

## [0.8.0] - 2026-10-13

### Added

- `key export --language <code> --output <file>` to export active keys, descriptions, source text and source versions without loading other languages.
- `key update --file <file>` with dry runs, guarded 100-key batches, resumable uploads and structured conflict reports for agent-authored descriptions.

### Changed

- Faster translation estimates while preserving existing translation plans.

## [0.7.0] - 2026-10-12

### Added

- Scoped translation coverage in `status` and namespaced work items.
- Key, namespace, language, quality, credit-cap, and timeout options for `sync-and-translate`.
- Translation/process counts, charged credits, and format-warning counts in JSON output.

### Changed

- Reuse saved question answers during subsequent translations.
- Report message-format concerns as review warnings while preserving generated output.

### Fixed

- Keep duplicate key names in different namespaces distinct.
- Validate scope and credit caps before atomically charging and creating jobs.
- Preserve job identity/progress on timeout, pull partial results, and exit with code 2.
- Preserve and report format warnings across `sync-and-translate` rounds, failures, and timeouts.

## [0.6.1] - 2026-07-16

### Added

- Translation job JSON and terminal output now include safe per-process failure details.

### Fixed

- Honor `emptyValueString: ""` as an untranslated local placeholder without creating recurring sync debt.
- Derive translation targets from project source-language metadata instead of language order.
- Reject and retry incomplete AI translation output before saving it.
- Stop `sync-and-translate` after a failed batch, pull successful partial results, and exit with code 2.
- Retry transient CLI reads and preserve structured server error metadata without leaking response bodies.

## [0.6.0] - 2026-07-16

### Added

- Repeatable `--key` and `--namespace` glob filters for `push`, `pull`, and `translate`, allowing operations to be scoped by matching keys and namespaces. The filters can be combined with AND.
- Filtered pushes report applied patterns and selected versus withheld changes in terminal and JSON output.

## [0.5.0] - 2026-06-26

### Fixed

- Bulk translate now includes keys that were just pushed, and async translation jobs are polled reliably until completion.

## [0.4.1] - 2026-06-23

### Fixed

- Correct `{{lang}}` placeholder detection in `babli init`, and add interactive file selection during setup.

## [0.4.0] - 2026-06-23

### Added

- Bulk conflict resolution for `push` — resolve all conflicts at once with `--resolve local|server`.

## [0.3.0] - 2026-06-17

### Added

- `pull --key` to pull a single key.

### Fixed

- `pull --only-existing` no longer deletes keys that exist locally.

## [0.2.0] - 2026-06-16

### Added

- Org-scoped `babli project` commands: `list`, `create`, and `get`.
- Surgical commands for individual keys and translations (`key …`, `translation …`).
- `pull --only-existing` to limit pulls to keys already present locally.
- `cli:watch-and-link` / `cli:unlink` development shortcuts.

### Fixed

- Normalize Windows path separators in config-file handling.

## [0.1.0] - 2026-04-15

### Added

- Initial public release of the Babli CLI: push/pull translation sync, an interactive dashboard and `sync-and-translate` workflow, JSON output for agents/CI, and `babli login` / `babli init`.
