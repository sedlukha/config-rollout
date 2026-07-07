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
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
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
