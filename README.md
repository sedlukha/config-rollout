# config-rollout

Commit and push **vendored config files** across sibling git repos — the
commit+push half of a file-vendoring sync.

Many "shared config" setups work by **vendoring**: a hub repo copies generated
files (CI config, editor config, a sandbox image, shared skills, …) into every
sibling repo, which then commit them. The copy step is easy to script. The tail
— committing and pushing those files in each repo, without touching anyone's
work-in-progress, and coping with a remote that moved on — is the annoying part.
That tail is `config-rollout`.

```bash
config-rollout -m "chore: sync shared config"   # commit + push, every repo
config-rollout -m "..." --dry-run               # preview, write nothing
config-rollout -m "..." --no-push               # commit locally, no push
config-rollout -m "..." --no-rebase             # merge instead of rebase
```

## How it works

Run it from the **hub repo's root**, right after your vendoring sync. It targets
every sibling git repo (the directories next to the hub repo), never the hub repo
itself and never a `worktrees/` dir. For each repo it:

1. Finds which **declared vendored paths** are dirty. If none, and the branch
   is not ahead of its upstream, the repo is skipped. A branch that is ahead
   still gets pushed: a push that failed on an earlier run leaves it so. The
   push sends every local commit, not only the vendor ones.
2. Stages **only those paths** — a developer's own work-in-progress is never
   staged or committed.
3. Commits with `--no-verify`. Vendored files are generated, so the target
   repo's source hooks (lint, lockfile verify) add nothing here and only cost
   time.
4. Pushes, also with `--no-verify`, so a slow or failing pre-push hook cannot
   leave the commit behind. On a non-fast-forward push it integrates the remote once and retries.
   A conflict is reported, never left half-applied. By default it integrates
   with `git pull --rebase --autostash`, keeping history linear; `--no-rebase`
   merges instead — see [Rebase or merge](#rebase-or-merge).

Repos run **concurrently** — each has its own `.git`, so parallel pushes are
independent.

## Configure per repo

What differs between hub repos is which paths they vendor and the commit message
they use. Declare both once in the hub repo's `package.json`, so a plain
`pnpm rollout` needs no arguments:

```jsonc
{
  "rollout": {
    "paths": [".workmux", ".workmux.yaml", "pnpm-workspace.yaml"],
    "message": "chore: sync shared workmux config"
  },
  "scripts": {
    "rollout": "config-rollout"
  }
}
```

Then `pnpm rollout` (or `npx config-rollout`) does the rest — no flags. Override
per run when you want to: `-m "…"` beats `rollout.message`, `--paths a,b,c` beats
`rollout.paths`.

## Options

| Flag | Meaning |
| --- | --- |
| `-m, --message <msg>` | Commit message. Overrides `rollout.message` in `package.json`. |
| `--paths <a,b,c>` | Vendored paths to stage. Overrides `rollout.paths` in `package.json`. |
| `--root <dir>` | Where the sibling repos live (default: parent of cwd). |
| `-n, --dry-run` | Show what would happen. Write nothing. |
| `--no-push` | Commit locally, do not push. |
| `--no-rebase` | On a non-fast-forward push, merge the remote instead of rebasing onto it. Alias: `--merge`. |
| `-c, --concurrency <n>` | Repos to process at once (default 8). |

## Rebase or merge

When a target repo's remote has moved on, the vendor commit has to be integrated
before it can be pushed. Both ways work; they fail differently.

**Rebase (default)** replays the vendor commit on top of the remote and keeps
history linear. It is the right default for target repos with linear history.

**`--no-rebase`** merges the remote in. Reach for it when the target repos have
merge commits. A rebase replays your commit across every commit it lands on,
including merges — and that can raise a conflict on files your vendor commit
never touched. A merge compares three trees once, so a vendor commit that only
touches generated paths nobody else edits cannot conflict at all.

The failure is not hypothetical: a vendor commit touching a path set completely
disjoint from the remote's still hit a rebase conflict, and merging the same two
sides resolved with none. If your rollouts hit `rebase conflict — resolve by
hand` on repos where nothing overlaps, this is why:

```sh
config-rollout -m "chore: sync shared config" --no-rebase
```

Either way a conflict is aborted and reported, never left half-applied.

`--autostash` on a merge needs git >= 2.27.

## Run it on the host

Run `config-rollout` on the host, not inside a dev sandbox that masks env files.
A masked `.env` (mounted as `/dev/null`, a character device) breaks `git stash`,
and a read-only `~/.gitconfig` breaks the push credential helper. On the host
neither applies.

## License

MIT
