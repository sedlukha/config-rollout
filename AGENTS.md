# Project Instructions — config-rollout

A tiny CLI that commits and pushes **vendored config files** across sibling git
repos — the commit+push tail of a file-vendoring sync. One executable script,
zero runtime dependencies.

## Layout

```
config-rollout/
  bin/config-rollout.mjs   # the whole tool — a single Node ESM script
  package.json             # name + bin; no runtime deps
  README.md                # usage
  AGENTS.md                # this file
  CHANGELOG.md             # per-version history; drives tags/releases
  LICENSE                  # MIT
```

There is no `src/`, no build step, and no `dist/`. The published artifact is the
script itself, run via `npx config-rollout` or a `rollout` package script.

## Architecture

Run from the **hub repo's root**, after the vendoring copy step. `main()` parses
argv, reads the hub repo's `package.json` `rollout` block for defaults (`paths`,
`message`), enumerates the sibling directories under `--root` (default: the
parent of cwd), and processes each git repo through `rollout()` — concurrently,
bounded by `runPool()`.

`rollout()` is the per-repo unit: it finds which of the declared vendored paths
git reports dirty, stages **only those**, commits with `--no-verify`, and pushes
with `--no-verify`. A clean repo whose branch is ahead of its upstream is pushed
too: an earlier failed push leaves that state.
On a non-fast-forward push it integrates the remote once and retries — `git pull
--rebase --autostash` by default, `--no-rebase` to merge instead (safer where the
target repos have merge commits: a rebase replays across them and can conflict on
files the vendor commit never touched). Either way the conflict is aborted and
reported, never left half-applied. The
`git()` helper wraps `spawn` in a promise that **never rejects** — it returns
`{ status, stdout, stderr }` so callers branch on `status`.

## Hard rules

- **No runtime dependencies.** The tool uses only Node built-ins (`node:fs`,
  `node:path`, `node:child_process`) plus `git` on PATH. `devDependencies`
  (TypeScript for type-checking) are fine — the `files` allowlist keeps them out
  of the published package.
- **No build step.** Keep it a runnable `.mjs` with a `#!/usr/bin/env node`
  shebang. It must work via `node bin/config-rollout.mjs` and `npx
  config-rollout` with nothing compiled.
- **Node ≥ 18.** Only use APIs available there. `git` on PATH is required.
- **Never touch a developer's work-in-progress.** Stage only the declared
  vendored paths — never `git add -A`, never a bare `git add .`. A target repo's
  own uncommitted changes must survive a rollout untouched.
- **Never leave a repo half-done.** A failed push must not leave a dangling
  rebase or merge; abort it and report `push-failed` so a human resolves it by
  hand.

## Conventions

- ES modules, 2-space indent, single quotes, no semicolons — match the existing
  style in `bin/config-rollout.mjs`.
- The source is type-checked with `// @ts-check` + JSDoc (no `.ts`, no build).
  Keep it green: `npm run typecheck`.
- User-facing output is a per-repo line plus a final summary; keep the state
  vocabulary (`pushed`, `committed`, `would-commit`, `clean`, `push-failed`,
  `error`) consistent between the two.

## Releases

`master` is the main branch. Cut releases through GitHub Releases + annotated
`vX.Y.Z` tags, with the release body taken from the matching `CHANGELOG.md`
section. Keep the tags/releases in sync with the CHANGELOG.

## Verifying a change

The test suite drives the real CLI as a child process against throwaway git
repos, so no install is needed:

```bash
node --test        # or: npm test
```

Tests live in `test/`. They cover: a dirty vendored path committed (and pushed
to a bare remote), a repo's own work-in-progress left unstaged, a clean repo
skipped, `--dry-run` writing nothing, `--no-push` committing locally, the hub
repo and `worktrees/` excluded, defaults read from the hub's `package.json`, a
commit left by an earlier failed push pushed on the next run, and a failing
pre-push hook skipped. Add a case here when you change behaviour.
