# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1] - 2026-08-14

### Fixed

- A vendored path that holds a space no longer breaks the run. The tool read
  `git status --porcelain`, which wraps such a path in double quotes. The quotes
  travelled into `git add` as part of the path, so every repo failed with
  `pathspec ... did not match any files`. It now reads `--porcelain -z`, which
  separates records with a NUL byte and never quotes.
- A rename that is already staged no longer breaks the run either. Such a record
  carries the old path in an extra field, and that path exists nowhere anymore.
  The tool now skips it and stages only the new path.

## [0.2.0] - 2026-07-16

### Added

- `--no-rebase` (alias `--merge`): on a non-fast-forward push, merge the remote
  instead of rebasing onto it. Reach for it when the target repos have merge
  commits — a rebase replays the vendor commit across them and can conflict on
  files the commit never touched, while a merge of a disjoint path set cannot.
  Needs git >= 2.27 for `--autostash` on a merge. The default is unchanged
  (`git pull --rebase --autostash`), and a merge conflict is aborted and
  reported just like a rebase conflict was.
- The run header names the integration mode when it is not the default.

## [0.1.0] - 2026-07-07

### Added

- Initial release. Commit and push vendored config files across sibling git
  repos — the commit+push half of a file-vendoring sync.
- Reads the hub repo's `package.json` `rollout` block (`paths`, `message`) so a
  plain `pnpm rollout` needs no arguments; `--paths` and `-m` override.
- Stages only the declared vendored paths, so a target repo's work-in-progress
  is never committed. Commits with `--no-verify`.
- Pushes concurrently; on a non-fast-forward push, does `git pull --rebase
  --autostash` once and retries, and reports a rebase conflict rather than
  leaving it half-applied.
- `--dry-run`, `--no-push`, `--root`, and `--concurrency` flags.

[0.2.0]: https://github.com/sedlukha/config-rollout/releases/tag/v0.2.0
[0.1.0]: https://github.com/sedlukha/config-rollout/releases/tag/v0.1.0
