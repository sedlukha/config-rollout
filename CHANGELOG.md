# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.1.0]: https://github.com/sedlukha/config-rollout/releases/tag/v0.1.0
