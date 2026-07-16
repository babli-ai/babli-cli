# Changelog

All notable changes to the Babli CLI are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
