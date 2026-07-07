#!/usr/bin/env node
// @ts-check
// config-rollout — commit and push VENDORED config files across sibling git
// repos. It is the commit+push half of a file-vendoring sync: a "hub" repo
// (a shared-config repo) copies generated files into every sibling repo, then
// this tool commits and pushes just those files, in every repo, at once.
//
//   config-rollout -m "chore: sync shared config"     # commit + push, all repos
//   config-rollout -m "..." --dry-run                 # preview, write nothing
//   config-rollout -m "..." --no-push                 # commit locally, no push
//
// It is generic: what differs between hub repos is WHICH paths they vendor and
// the commit message they use. You declare both once, in the hub repo's
// package.json, so a plain `pnpm rollout` needs no arguments:
//
//   "rollout": {
//     "paths": [".workmux", ".workmux.yaml", "pnpm-workspace.yaml"],
//     "message": "chore: sync shared workmux config"
//   }
//
// Flags override: --paths beats rollout.paths, -m beats rollout.message. Run it
// from the hub repo's root; it targets every sibling git repo (the directories
// next to the hub repo), never the hub repo itself and never a worktrees/ dir.
//
// Why it is safe and fast:
//   - It stages ONLY the declared vendored paths. A developer's own
//     work-in-progress in a target repo is never staged or committed.
//   - It commits with --no-verify. Vendored files are generated; the target
//     repo's source hooks (lint, lockfile verify) add nothing here and only
//     cost time (they also race on .git/index.lock when driven in a loop).
//   - It runs the repos concurrently. Each repo has its own .git, so parallel
//     pushes are independent.
//   - On a non-fast-forward push it does `git pull --rebase --autostash` once
//     and retries. A rebase conflict is reported, never left half-applied.
//
// Run it on the HOST, not inside a masking dev sandbox: a masked .env breaks
// git stash and a read-only ~/.gitconfig breaks the push credential helper.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

// ---- args ----------------------------------------------------------------
/**
 * @typedef {Object} Opts
 * @property {string|null} message
 * @property {string[]|null} paths
 * @property {string|null} root
 * @property {boolean} dryRun
 * @property {boolean} push
 * @property {number} concurrency
 * @property {boolean} [help]
 */

/** @param {string[]} argv @returns {Opts} */
function parseArgs(argv) {
  /** @type {Opts} */
  const opts = { message: null, paths: null, root: null, dryRun: false, push: true, concurrency: 8 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-m' || a === '--message') opts.message = argv[++i]
    else if (a === '--paths') {
      const v = argv[++i]
      opts.paths = v ? v.split(',').map((s) => s.trim()).filter(Boolean) : null
    } else if (a === '--root') opts.root = argv[++i]
    else if (a === '-n' || a === '--dry-run') opts.dryRun = true
    else if (a === '--no-push') opts.push = false
    else if (a === '-c' || a === '--concurrency') opts.concurrency = Number(argv[++i]) || 8
    else if (a === '-h' || a === '--help') opts.help = true
    else {
      console.error(`unknown argument: ${a}`)
      opts.help = true
    }
  }
  return opts
}

const USAGE = `config-rollout — commit and push vendored config across every sibling repo.

  config-rollout -m "<commit message>" [options]

Options:
  -m, --message <msg>    Commit message. Overrides the package.json default.
      --paths <a,b,c>    Vendored paths to stage. Overrides package.json.
      --root <dir>       Where the sibling repos live (default: parent of cwd).
  -n, --dry-run          Show what would be committed/pushed. Write nothing.
      --no-push          Commit locally, do not push.
  -c, --concurrency <n>  Repos to process at once (default 8).
  -h, --help             This help.

Paths and the default commit message come from the hub repo's package.json;
flags override them:
  "rollout": {
    "paths": ["...", "..."],
    "message": "chore: sync shared config"
  }

Run from the hub repo's root, on the host, after your file-vendoring sync.`

// ---- config: what this hub repo vendors, and its default commit message ---
// Read once from the hub repo's package.json "rollout" block:
//   "rollout": { "paths": ["..."], "message": "chore: sync shared config" }
// Flags override: --paths beats rollout.paths, -m beats rollout.message.
/** @param {string} hubRepo */
function loadRolloutConfig(hubRepo) {
  try {
    const pkg = JSON.parse(readFileSync(join(hubRepo, 'package.json'), 'utf8'))
    return pkg?.rollout ?? {}
  } catch {
    return {}
  }
}

// ---- git helper ----------------------------------------------------------
// Promise wrapper around spawn so repos can run concurrently. Never rejects —
// returns { status, stdout, stderr } so callers branch on status.
/**
 * @param {string[]} args
 * @param {string} [cwd]
 * @returns {Promise<{ status: number|null, stdout: string, stderr: string }>}
 */
function git(args, cwd) {
  return new Promise((res) => {
    const p = spawn('git', args, { cwd })
    let stdout = ''
    let stderr = ''
    p.stdout?.on('data', (d) => (stdout += d))
    p.stderr?.on('data', (d) => (stderr += d))
    p.on('close', (status) => res({ status, stdout, stderr }))
    p.on('error', (err) => res({ status: 1, stdout, stderr: String(err) }))
  })
}

// Vendored paths that git reports as dirty (modified, added, or untracked).
/** @param {string} repo @param {string[]} paths @returns {Promise<string[]|null>} */
async function vendoredChanges(repo, paths) {
  const res = await git(['status', '--porcelain', '--', ...paths], repo)
  if (res.status !== 0) return null
  return res.stdout.split('\n').filter(Boolean).map((l) => l.slice(3))
}

/** @param {{ stdout: string, stderr: string }} res */
function isNonFastForward(res) {
  const s = `${res.stderr}\n${res.stdout}`
  return /\brejected\b|non-fast-forward|fetch first|tip of your current branch is behind/i.test(s)
}
/** @param {{ stderr: string }} res */
function isNoUpstream(res) {
  return /no upstream|set-upstream|has no upstream branch/i.test(res.stderr)
}

// ---- per-repo rollout ----------------------------------------------------
/**
 * @typedef {Object} RolloutResult
 * @property {string} name
 * @property {'clean'|'would-commit'|'committed'|'pushed'|'push-failed'|'error'} state
 * @property {string} [detail]
 * @property {string[]} [paths]
 * @property {string} [head]
 */

/**
 * @param {string} name
 * @param {string} repo
 * @param {string[]} paths
 * @param {Opts} opts
 * @returns {Promise<RolloutResult>}
 */
async function rollout(name, repo, paths, opts) {
  const dirty = await vendoredChanges(repo, paths)
  if (dirty === null) return { name, state: 'error', detail: 'git status failed' }
  if (dirty.length === 0) return { name, state: 'clean' }

  if (opts.dryRun) return { name, state: 'would-commit', paths: dirty }

  const add = await git(['add', '--', ...dirty], repo)
  if (add.status !== 0) return { name, state: 'error', detail: `git add: ${add.stderr.trim()}` }

  // Nothing actually staged (e.g. a pure mode flip git ignores) — treat as clean.
  const staged = await git(['diff', '--cached', '--quiet'], repo)
  if (staged.status === 0) return { name, state: 'clean' }

  const commit = await git(['commit', '--no-verify', '-m', /** @type {string} */ (opts.message)], repo)
  if (commit.status !== 0) return { name, state: 'error', detail: `git commit: ${commit.stderr.trim()}` }
  const head = (await git(['rev-parse', '--short', 'HEAD'], repo)).stdout.trim()

  if (!opts.push) return { name, state: 'committed', paths: dirty, head }

  let push = await git(['push'], repo)
  if (push.status !== 0 && isNoUpstream(push)) {
    push = await git(['push', '-u', 'origin', 'HEAD'], repo)
  }
  if (push.status !== 0 && isNonFastForward(push)) {
    // Remote moved on. Rebase our vendor commit on top, then retry once.
    const pull = await git(['pull', '--rebase', '--autostash'], repo)
    if (pull.status !== 0) {
      await git(['rebase', '--abort'], repo) // best-effort; no-op if not rebasing
      return { name, state: 'push-failed', head, detail: 'rebase conflict — resolve by hand' }
    }
    push = await git(['push'], repo)
  }
  if (push.status !== 0) {
    return { name, state: 'push-failed', head, detail: push.stderr.trim().split('\n').pop() }
  }
  return { name, state: 'pushed', paths: dirty, head }
}

// ---- concurrency pool ----------------------------------------------------
/**
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T) => Promise<R>} worker
 * @param {(r: R) => void} onDone
 */
async function runPool(items, limit, worker, onDone) {
  const queue = [...items]
  const workers = Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
    while (queue.length) onDone(await worker(/** @type {T} */ (queue.shift())))
  })
  await Promise.all(workers)
}

// ---- main ----------------------------------------------------------------
const opts = parseArgs(process.argv.slice(2))
if (opts.help) {
  console.log(USAGE)
  process.exit(0)
}

const hubRepo = process.cwd()
const root = resolve(opts.root ? resolve(hubRepo, opts.root) : dirname(hubRepo))

const cfg = loadRolloutConfig(hubRepo)
const paths =
  opts.paths?.length ? opts.paths : Array.isArray(cfg.paths) && cfg.paths.length ? cfg.paths : null
// -m beats the package.json default; that default is the whole point of not
// retyping the same message on every rollout.
const message = opts.message ?? (typeof cfg.message === 'string' ? cfg.message : null)

if (!paths) {
  console.error('config-rollout: no vendored paths.\n')
  console.error('Declare them in this repo\'s package.json:')
  console.error('  "rollout": { "paths": [".workmux", ".workmux.yaml"] }')
  console.error('or pass --paths a,b,c.\n')
  console.error(USAGE)
  process.exit(1)
}
if (!opts.dryRun && !message) {
  console.error('config-rollout: no commit message.\n')
  console.error('Set a default in this repo\'s package.json:')
  console.error('  "rollout": { "message": "chore: sync shared config" }')
  console.error('or pass -m "<message>". (Not needed for --dry-run.)\n')
  console.error(USAGE)
  process.exit(1)
}
opts.message = message // rollout() reads opts.message

/** @type {{ name: string, repo: string }[]} */
const targets = []
for (const entry of readdirSync(root, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const repo = join(root, entry.name)
  if (repo === hubRepo) continue // the hub repo itself — its source is committed by hand
  if (entry.name === 'worktrees') continue // a worktree dir, not a repo
  if (!existsSync(join(repo, '.git'))) continue // only git repos
  targets.push({ name: entry.name, repo })
}

const mode = opts.dryRun ? 'DRY RUN — nothing is written' : opts.push ? 'commit + push' : 'commit only'
console.log(`config-rollout: ${targets.length} sibling repos under ${root}`)
console.log(`paths: ${paths.join(', ')}`)
console.log(`mode: ${mode}\n`)

/** @type {RolloutResult[]} */
const results = []
await runPool(targets, opts.concurrency, ({ name, repo }) => rollout(name, repo, paths, opts), (r) => {
  results.push(r)
  const tag = {
    pushed: `✓ pushed   ${r.head}`,
    committed: `✓ committed ${r.head} (not pushed)`,
    'would-commit': `• would commit: ${r.paths?.join(', ')}`,
    clean: '· up to date',
    'push-failed': `✗ push FAILED (${r.detail})`,
    error: `✗ error (${r.detail})`,
  }[r.state]
  console.log(`  ${r.name}: ${tag}`)
})

// ---- summary -------------------------------------------------------------
const by = (/** @type {RolloutResult['state']} */ s) =>
  results.filter((r) => r.state === s).map((r) => r.name)
const pushed = by('pushed')
const committed = by('committed')
const would = by('would-commit')
const clean = by('clean')
const failed = results.filter((r) => r.state === 'push-failed' || r.state === 'error')

console.log('')
if (opts.dryRun) {
  console.log(`Would commit: ${would.join(', ') || 'none'}`)
  console.log(`Up to date:   ${clean.join(', ') || 'none'}`)
} else {
  if (pushed.length) console.log(`Pushed:    ${pushed.join(', ')}`)
  if (committed.length) console.log(`Committed (not pushed): ${committed.join(', ')}`)
  console.log(`Up to date: ${clean.join(', ') || 'none'}`)
}
if (failed.length) {
  console.log('\nNEEDS ATTENTION — fix these by hand:')
  for (const r of failed) console.log(`  ${r.name}: ${r.detail}`)
  process.exitCode = 1
}
