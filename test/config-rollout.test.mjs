// Behaviour tests for config-rollout. Uses only Node built-ins (node:test,
// node:assert) plus `git` on PATH, so the package keeps its zero-dependency
// promise.
//
//   node --test
//
// Each test builds a throwaway "workspace": a hub repo and one or more sibling
// git repos (some with a bare remote to push to), runs the real CLI as a child
// process from the hub repo, and inspects what it committed and pushed.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BIN = join(HERE, '..', 'bin', 'config-rollout.mjs')

// --- git / fs helpers ------------------------------------------------------
/** @param {string} cwd @param {...string} args */
function git(cwd, ...args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`)
  return res.stdout.trim()
}

/** @param {string} dir @param {string} rel @param {string} body */
function write(dir, rel, body) {
  const p = join(dir, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, body)
}

/** A git repo with an initial commit and `master` checked out. */
function initRepo(/** @type {string} */ dir) {
  mkdirSync(dir, { recursive: true })
  git(dir, 'init')
  git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/master')
  git(dir, 'config', 'user.email', 't@example.com')
  git(dir, 'config', 'user.name', 'Test')
  git(dir, 'config', 'commit.gpgsign', 'false')
  write(dir, 'README.md', 'init\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'init')
  return dir
}

/** A sibling repo wired to a fresh bare remote, upstream set. */
function repoWithRemote(/** @type {string} */ dir, /** @type {string} */ remotesRoot, /** @type {string} */ name) {
  initRepo(dir)
  const bare = join(remotesRoot, `${name}.git`)
  git(dir, 'init', '--bare', bare) // `git init --bare <path>` creates it
  git(dir, 'remote', 'add', 'origin', bare)
  git(dir, 'push', '-q', '-u', 'origin', 'master')
  return { dir, bare }
}

/**
 * Land a commit on the bare remote from a throwaway clone, so the sibling repo
 * falls behind and its next push is rejected as non-fast-forward.
 * @param {string} bare @param {string} rel @param {string} body
 * @param {{ viaMerge?: boolean }} [o] viaMerge: land it through a merge commit,
 *   which is what makes a later rebase replay across a merge.
 */
function advanceRemote(bare, rel, body, o = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'cr-adv-'))
  git(tmp, 'clone', '-q', bare, '.')
  git(tmp, 'config', 'user.email', 't@example.com')
  git(tmp, 'config', 'user.name', 'Test')
  git(tmp, 'config', 'commit.gpgsign', 'false')
  if (o.viaMerge) {
    git(tmp, 'checkout', '-q', '-b', 'side')
    write(tmp, rel, body)
    git(tmp, 'add', '-A')
    git(tmp, 'commit', '-q', '-m', `side: ${rel}`)
    git(tmp, 'checkout', '-q', 'master')
    git(tmp, 'merge', '-q', '--no-ff', '-m', `merge side`, 'side')
  } else {
    write(tmp, rel, body)
    git(tmp, 'add', '-A')
    git(tmp, 'commit', '-q', '-m', `remote: ${rel}`)
  }
  git(tmp, 'push', '-q', 'origin', 'HEAD:master')
  return tmp
}

/** Number of parents of HEAD — 2 means a merge commit. */
const parentCount = (/** @type {string} */ dir) =>
  git(dir, 'rev-list', '--parents', '-n', '1', 'HEAD').trim().split(/\s+/).length - 1

/** @param {string} hub @param {string[]} [args] */
function run(hub, args = []) {
  const res = spawnSync(process.execPath, [BIN, ...args], { cwd: hub, encoding: 'utf8' })
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' }
}

/** A workspace root plus a separate dir to hold bare remotes (kept out of it). */
function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'cr-root-'))
  const remotes = mkdtempSync(join(tmpdir(), 'cr-remotes-'))
  const hub = initRepo(join(root, 'hub'))
  return { root, remotes, hub }
}

const head = (/** @type {string} */ dir) => git(dir, 'rev-parse', 'HEAD')
const bareHead = (/** @type {string} */ bare) => git(bare, 'rev-parse', 'master')

// --- tests -----------------------------------------------------------------

test('commits and pushes a dirty vendored path; leaves WIP untouched', () => {
  const { root, remotes, hub } = workspace()
  const { dir, bare } = repoWithRemote(join(root, 'app'), remotes, 'app')
  const before = head(dir)
  const remoteBefore = bareHead(bare)

  write(dir, '.shared/ci.yml', 'vendored v2\n') // vendored — should be committed
  write(dir, 'src/app.js', 'developer WIP\n') // NOT vendored — must be left alone

  const r = run(hub, ['--paths', '.shared', '-m', 'chore: sync'])
  assert.equal(r.status, 0, r.stderr)

  // A new commit landed and was pushed.
  assert.notEqual(head(dir), before, 'a commit was made')
  assert.equal(bareHead(bare), head(dir), 'the commit was pushed to origin')

  // Only the vendored path is in the commit; the WIP file is not.
  const files = git(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean)
  assert.deepEqual(files, ['.shared/ci.yml'])
  assert.notEqual(remoteBefore, bareHead(bare))

  // The WIP file survives, still untracked.
  assert.ok(existsSync(join(dir, 'src/app.js')))
  const status = git(dir, 'status', '--porcelain')
  assert.match(status, /^\?\? src\//m, 'WIP left untracked and uncommitted')
  assert.doesNotMatch(status, /\.shared/, 'vendored path fully committed, nothing left dirty')
})

test('a repo with no vendored change is skipped', () => {
  const { root, remotes, hub } = workspace()
  const { dir, bare } = repoWithRemote(join(root, 'app'), remotes, 'app')
  const before = head(dir)
  const remoteBefore = bareHead(bare)

  const r = run(hub, ['--paths', '.shared', '-m', 'chore: sync'])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(head(dir), before, 'no commit made')
  assert.equal(bareHead(bare), remoteBefore, 'nothing pushed')
  assert.match(r.stdout, /app: · up to date/)
})

test('--dry-run reports the plan but writes nothing', () => {
  const { root, hub } = workspace()
  const dir = initRepo(join(root, 'app'))
  const before = head(dir)
  write(dir, '.shared/ci.yml', 'vendored\n')

  const r = run(hub, ['--paths', '.shared', '-n'])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(head(dir), before, 'no commit was made')
  assert.match(r.stdout, /DRY RUN/)
  assert.match(r.stdout, /would commit: \.shared/)
})

test('--no-push commits locally and does not push', () => {
  const { root, remotes, hub } = workspace()
  const { dir, bare } = repoWithRemote(join(root, 'app'), remotes, 'app')
  const before = head(dir)
  const remoteBefore = bareHead(bare)
  write(dir, '.shared/ci.yml', 'vendored\n')

  const r = run(hub, ['--paths', '.shared', '-m', 'chore: sync', '--no-push'])
  assert.equal(r.status, 0, r.stderr)
  assert.notEqual(head(dir), before, 'committed locally')
  assert.equal(bareHead(bare), remoteBefore, 'remote untouched')
  assert.match(r.stdout, /app: ✓ committed/)
})

test('the hub repo and a worktrees/ dir are never targeted', () => {
  const { root, hub } = workspace()
  // A vendored change in the hub itself and in a worktrees/ dir.
  write(hub, '.shared/ci.yml', 'vendored\n')
  const wt = initRepo(join(root, 'worktrees'))
  write(wt, '.shared/ci.yml', 'vendored\n')
  const hubBefore = head(hub)
  const wtBefore = head(wt)

  const r = run(hub, ['--paths', '.shared', '-m', 'chore: sync', '--no-push'])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(head(hub), hubBefore, 'hub repo not committed to')
  assert.equal(head(wt), wtBefore, 'worktrees/ not committed to')
  assert.match(r.stdout, /0 sibling repos|Up to date: none/)
})

test('paths and message default from the hub package.json rollout block', () => {
  const { root, hub } = workspace()
  write(hub, 'package.json', JSON.stringify({
    name: 'hub',
    rollout: { paths: ['.shared'], message: 'chore: sync shared config' },
  }))
  const dir = initRepo(join(root, 'app'))
  write(dir, '.shared/ci.yml', 'vendored\n')

  // No --paths, no -m — both come from package.json.
  const r = run(hub, ['--no-push'])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: sync shared config')
})

test('missing paths / missing message fail with a helpful error', () => {
  const { hub } = workspace()
  const noPaths = run(hub, ['-m', 'x'])
  assert.equal(noPaths.status, 1)
  assert.match(noPaths.stderr, /no vendored paths/)

  const noMsg = run(hub, ['--paths', '.shared'])
  assert.equal(noMsg.status, 1)
  assert.match(noMsg.stderr, /no commit message/)
})

test('--help prints usage and exits 0', () => {
  const { hub } = workspace()
  const r = run(hub, ['--help'])
  assert.equal(r.status, 0)
  assert.match(r.stdout, /config-rollout — commit and push/)
})

// Plain `git status --porcelain` quotes a path that holds a space, and those
// quotes used to reach `git add` as part of the path. Every repo in the rollout
// then failed with "pathspec ... did not match any files".
test('stages a vendored path whose name holds a space', () => {
  const { root, hub } = workspace()
  const dir = initRepo(join(root, 'app'))
  write(dir, '.shared/CI Config.yml', 'vendored v1\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'add vendored file')

  write(dir, '.shared/CI Config.yml', 'vendored v2\n')

  const r = run(hub, ['--paths', '.shared', '-m', 'chore: sync', '--no-push'])
  assert.equal(r.status, 0, r.stderr)
  const files = git(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean)
  assert.deepEqual(files, ['.shared/CI Config.yml'], 'the spaced path is in the commit')
  assert.equal(git(dir, 'status', '--porcelain'), '', 'nothing left dirty')
})

// The real trigger: the vendoring sync renamed "ADR Template.md" to
// adr-template.md. The old file is gone from disk, the new one is untracked,
// and the deletion line carries the quoted path.
test('stages a rename from a spaced name to a plain one', () => {
  const { root, hub } = workspace()
  const dir = initRepo(join(root, 'app'))
  write(dir, '.shared/ADR Template.md', 'body\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'add vendored file')

  // What the sync does: write the new name, remove the old one.
  write(dir, '.shared/adr-template.md', 'body\n')
  rmSync(join(dir, '.shared/ADR Template.md'))

  const r = run(hub, ['--paths', '.shared', '-m', 'chore: sync', '--no-push'])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(git(dir, 'status', '--porcelain'), '', 'both sides of the move committed')
  assert.ok(existsSync(join(dir, '.shared/adr-template.md')), 'new name on disk')
})

// A move already staged by hand before the rollout runs. Git reports it as one
// R record with two fields, and only the new path may be handed to `git add`.
test('an already staged rename does not break the run', () => {
  const { root, hub } = workspace()
  const dir = initRepo(join(root, 'app'))
  write(dir, '.shared/ADR Template.md', 'body\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'add vendored file')

  git(dir, 'mv', '.shared/ADR Template.md', '.shared/adr-template.md')

  const r = run(hub, ['--paths', '.shared', '-m', 'chore: sync', '--no-push'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /app: ✓ committed/)
  assert.equal(git(dir, 'status', '--porcelain'), '', 'nothing left dirty')
})

test('a non-fast-forward push rebases by default, keeping history linear', () => {
  const { root, remotes, hub } = workspace()
  const { dir, bare } = repoWithRemote(join(root, 'app'), remotes, 'app')

  advanceRemote(bare, 'src/other.js', 'remote work\n')
  write(dir, '.shared/ci.yml', 'vendored v2\n')

  const r = run(hub, ['--paths', '.shared', '-m', 'chore: sync'])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(bareHead(bare), head(dir), 'pushed to origin')
  assert.equal(parentCount(dir), 1, 'HEAD has one parent — replayed, no merge commit')
  assert.ok(existsSync(join(dir, 'src/other.js')), 'remote work present')
  assert.ok(existsSync(join(dir, '.shared/ci.yml')), 'vendored change present')
})

test('--no-rebase merges the remote instead of rebasing onto it', () => {
  const { root, remotes, hub } = workspace()
  const { dir, bare } = repoWithRemote(join(root, 'app'), remotes, 'app')

  advanceRemote(bare, 'src/other.js', 'remote work\n')
  write(dir, '.shared/ci.yml', 'vendored v2\n')

  const r = run(hub, ['--paths', '.shared', '-m', 'chore: sync', '--no-rebase'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /merge on non-fast-forward/, 'the mode is reported')
  assert.match(r.stdout, /app: ✓ pushed/)
  assert.equal(bareHead(bare), head(dir), 'pushed to origin')
  assert.equal(parentCount(dir), 2, 'HEAD is a merge commit')
  assert.ok(existsSync(join(dir, 'src/other.js')), 'remote work present')
  assert.ok(existsSync(join(dir, '.shared/ci.yml')), 'vendored change present')
})

// The case this flag exists for: the remote landed its work through a merge
// commit, and our vendor commit touches a path no one else did. Rebasing
// replays across that merge; merging cannot conflict over files it never
// touches. Both must survive with the vendored and remote work intact.
test('--no-rebase integrates a remote whose work arrived via a merge commit', () => {
  const { root, remotes, hub } = workspace()
  const { dir, bare } = repoWithRemote(join(root, 'app'), remotes, 'app')

  advanceRemote(bare, 'src/feature.js', 'remote feature\n', { viaMerge: true })
  write(dir, '.shared/ci.yml', 'vendored v2\n') // disjoint from the remote's paths

  const r = run(hub, ['--paths', '.shared', '-m', 'chore: sync', '--merge'])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(bareHead(bare), head(dir), 'pushed to origin')
  assert.equal(git(dir, 'status', '--porcelain'), '', 'tree clean — nothing left half-applied')
  assert.equal(readFileSync(join(dir, 'src/feature.js'), 'utf8'), 'remote feature\n')
  assert.equal(readFileSync(join(dir, '.shared/ci.yml'), 'utf8'), 'vendored v2\n')
})

// An earlier run committed, then its push failed. The tree is clean now, so the
// old check called the repo "up to date" and the commit never left.
test('pushes a vendor commit that an earlier run left behind', () => {
  const { root, remotes, hub } = workspace()
  const { dir, bare } = repoWithRemote(join(root, 'app'), remotes, 'app')
  write(dir, '.shared/ci.yml', 'vendored v2\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'chore: sync')

  const dry = run(hub, ['--paths', '.shared', '-n'])
  assert.match(dry.stdout, /app: • would push: 1 local commit/)
  assert.notEqual(bareHead(bare), head(dir), 'dry run pushed nothing')

  const r = run(hub, ['--paths', '.shared', '-m', 'chore: sync'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /app: ✓ pushed/)
  assert.equal(bareHead(bare), head(dir), 'the old commit reached origin')
})

// The target repo's own pre-push hook runs its tests. It has nothing to say
// about a vendored file, and when it failed the commit stayed behind.
test('a failing pre-push hook does not stop the push', () => {
  const { root, remotes, hub } = workspace()
  const { dir, bare } = repoWithRemote(join(root, 'app'), remotes, 'app')
  write(dir, '.git/hooks/pre-push', '#!/bin/sh\nexit 1\n')
  chmodSync(join(dir, '.git/hooks/pre-push'), 0o755)
  write(dir, '.shared/ci.yml', 'vendored v2\n')

  const r = run(hub, ['--paths', '.shared', '-m', 'chore: sync'])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(bareHead(bare), head(dir), 'pushed past the hook')
})
