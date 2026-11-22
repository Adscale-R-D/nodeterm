import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { GitHubIssueCache } from './cache'
import { testTmpDir } from '../test-tmp'
import { GitHubIssueService, type GitHubIssueServiceContext, type GitHubIssuesClientLike } from './service'
import { GitHubRequestCoordinator } from './request-coordinator'
import { DECLARED_RETRY_MS } from './pull-status-tracker'
import type { PullOneRead, PullStatusRead } from './graphql-pulls'
import type { GitHubIssue, IssueHeartbeatResult, NormalisedProjectKanbanGitHub } from '../../shared/github-issues'
import type { GitHubPullChecksResult, PullStatusFacts } from '../../shared/github-pull-status'

let userDataDir: string
beforeEach(() => { userDataDir = testTmpDir('nt-github-pulls-') })
// A claim persists the pull memory asynchronously, so a save can still be landing as a test ends —
// and one that lands AFTER the rm recreates the directory (`writePrivate` mkdirs), which is how this
// file stranded a `nt-github-pulls-*` dir per run. Settle first, then remove; `testTmpDir` removes it
// again when the file ends, for a save slower than the settle.
afterEach(async () => {
  await flush()
  await fs.rm(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
})

const HEAD = 'a'.repeat(40)
const config: NormalisedProjectKanbanGitHub = {
  repository: 'o/r', columnMappings: [{ columnId: 'done', label: 'done' }], completionColumnId: 'done',
  revision: 'mapping-1'
}

function facts(number: number, over: Partial<PullStatusFacts> = {}): PullStatusFacts {
  return {
    number, headRefName: `feat/${number}`, headRefOid: HEAD, crossRepository: false, isDraft: false, mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN', rollup: 'SUCCESS', rollupOid: HEAD, closes: [], ...over
  }
}

class PullClient implements GitHubIssuesClientLike {
  /** The heartbeat's answer: flip `changed` to simulate activity in the repository. */
  changed = false
  heartbeats = 0
  statusReads = 0
  checkReads = 0
  open: PullStatusFacts[] = [facts(1)]
  checks: GitHubPullChecksResult = { status: 'no-checks' }
  failChecks?: Error

  async listIssues() { return { items: [] as GitHubIssue[] } }
  /** Runs inside the heartbeat — lets a test change the configuration between the heartbeat and the
   *  pull status read that follows it. */
  onHeartbeat?: () => void
  async issuesHeartbeat(_repository: string, etag?: string): Promise<IssueHeartbeatResult> {
    this.heartbeats += 1
    this.onHeartbeat?.()
    if (this.changed || !etag) { this.changed = false; return { notModified: false, etag: `W/"${Math.random()}"` } }
    return { notModified: true, etag }
  }
  async getIssue(): Promise<never> { throw new Error('unused') }
  async updateIssue(): Promise<never> { throw new Error('unused') }
  async listRepositoryLabels() { return { items: [] } }
  async createLabel(): Promise<never> { throw new Error('unused') }
  async createIssue(): Promise<never> { throw new Error('unused') }
  async createIssueComment(): Promise<never> { throw new Error('unused') }
  async pullRequestStatuses(): Promise<PullStatusRead> {
    this.statusReads += 1
    return { open: this.open, recent: [], access: { ci: true, merge: true }, truncated: false }
  }
  async pullRequestChecks(): Promise<GitHubPullChecksResult> {
    this.checkReads += 1
    if (this.failChecks) throw this.failChecks
    return this.checks
  }
}

function context(client: PullClient, revision = config.revision): GitHubIssueServiceContext {
  return {
    localApprovalId: 'local-1', projectId: 'project-1', repository: 'o/r', config: { ...config, revision },
    controlRevision: 1,
    credentialGeneration: 1, userId: 'user-1', client, columnColors: {}, mappingApproved: true
  }
}

/** The poll and the subscribe refresh write the real on-disk cache, so "nothing else happens"
 *  needs a real settle, not a few microtask turns. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 40))
}

function harness(client = new PullClient()) {
  let now = 1_000_000
  let poll: (() => void) | undefined
  let contexts = 0
  let revision = config.revision
  const service = new GitHubIssueService({
    cache: new GitHubIssueCache(userDataDir),
    coordinator: new GitHubRequestCoordinator({ now: () => now }),
    contextForProject: async () => { contexts += 1; return context(client, revision) },
    now: () => now,
    setInterval: (fn) => { poll = fn; return 1 },
    clearInterval: () => { poll = undefined }
  })
  return {
    client, service,
    advance: (ms: number) => { now += ms },
    poll: async () => { poll?.(); await flush() },
    contexts: () => contexts,
    setRevision: (next: string) => { revision = next }
  }
}

describe('GitHubIssueService pull status', () => {
  it('reads pull status on the first heartbeat, then only when the heartbeat reports a change', async () => {
    const h = harness()
    await h.service.subscribe(7, { projectId: 'project-1' })
    await vi.waitFor(() => expect(h.client.statusReads).toBe(1))
    expect((await h.service.pullStatus({ projectId: 'project-1' })).pulls[0]).toMatchObject({ number: 1, ci: 'passed' })

    h.advance(60_000)
    await h.poll()
    // The poll really ran (its heartbeat was sent) and answered 304: no GraphQL read.
    await vi.waitFor(() => expect(h.client.heartbeats).toBe(2))
    await flush()
    expect(h.client.statusReads).toBe(1)

    h.client.changed = true
    h.advance(60_000)
    await h.poll()
    await vi.waitFor(() => expect(h.client.statusReads).toBe(2))
  })

  it('a chase ping costs nothing until a read is due, and never resolves a context early', async () => {
    const h = harness()
    h.client.open = [facts(1, { rollup: 'PENDING' })]
    await h.service.subscribe(7, { projectId: 'project-1' })
    await flush()
    const contextsBefore = h.contexts()
    expect(await h.service.chasePulls({ projectId: 'project-1' })).toBe(false)
    expect(h.contexts()).toBe(contextsBefore)
    h.advance(30_000)
    expect(await h.service.chasePulls({ projectId: 'project-1' })).toBe(true)
    expect(h.client.statusReads).toBe(2)
  })

  it('a chase ping for a project with nothing undecided never reads', async () => {
    const h = harness()
    await h.service.subscribe(7, { projectId: 'project-1' })
    await flush()
    h.advance(3_600_000)
    expect(await h.service.chasePulls({ projectId: 'project-1' })).toBe(false)
    expect(h.client.statusReads).toBe(1)
  })

  it('check detail: hidden for a token that cannot read checks, never a failed board', async () => {
    const h = harness()
    h.client.failChecks = Object.assign(new Error('insufficient-permission'), { code: 'insufficient-permission', status: 403 })
    expect(await h.service.pullChecks({ projectId: 'project-1', pullNumber: 1 })).toEqual({ status: 'hidden' })
    h.client.failChecks = Object.assign(new Error('request-failed'), { code: 'request-failed', status: 502 })
    h.advance(15_000)
    expect(await h.service.pullChecks({ projectId: 'project-1', pullNumber: 1 })).toEqual({ status: 'unavailable' })
    expect(await h.service.pullChecks({ projectId: 'project-1', pullNumber: -3 })).toEqual({ status: 'unavailable' })
  })

  it('bounds check-detail reads: one per PR per 15 s, ten per project per minute', async () => {
    const h = harness()
    h.client.checks = { status: 'no-checks' }
    await h.service.pullChecks({ projectId: 'project-1', pullNumber: 1 })
    await h.service.pullChecks({ projectId: 'project-1', pullNumber: 1 })
    expect(h.client.checkReads).toBe(1)
    for (let number = 2; number <= 10; number++) {
      await h.service.pullChecks({ projectId: 'project-1', pullNumber: number })
    }
    expect(h.client.checkReads).toBe(10)
    const contexts = h.contexts()
    for (let number = 11; number <= 20; number++) {
      expect(await h.service.pullChecks({ projectId: 'project-1', pullNumber: number }))
        .toEqual({ status: 'unavailable' })
    }
    expect(h.client.checkReads).toBe(10)
    // Refused before a context (the credential chain) is resolved.
    expect(h.contexts()).toBe(contexts)
    h.advance(60_000)
    await h.service.pullChecks({ projectId: 'project-1', pullNumber: 21 })
    expect(h.client.checkReads).toBe(11)
  })

  it('does not ask for check detail once the list read showed the token cannot read checks', async () => {
    const h = harness()
    h.client.pullRequestStatuses = async () => {
      h.client.statusReads += 1
      return { open: [facts(1)], recent: [], access: { ci: false, merge: true }, truncated: false }
    }
    await h.service.subscribe(7, { projectId: 'project-1' })
    await flush()
    expect(await h.service.pullChecks({ projectId: 'project-1', pullNumber: 1 })).toEqual({ status: 'hidden' })
    expect(h.client.checkReads).toBe(0)
  })

  it('clearing the cache forgets pull status and deletes its memory file', async () => {
    const h = harness()
    await h.service.subscribe(7, { projectId: 'project-1' })
    await vi.waitFor(() => expect(h.client.statusReads).toBe(1))
    const memoryDir = path.join(userDataDir, 'github-pull-memory')
    await vi.waitFor(async () => expect(await fs.readdir(memoryDir).catch(() => [])).toHaveLength(1))
    await h.service.clearCache({ projectId: 'project-1' })
    expect(await fs.readdir(memoryDir).catch(() => [])).toEqual([])
    // Bind the same identity again with a read that never answers: nothing from before the clear may
    // come back under that key.
    h.client.pullRequestStatuses = () => new Promise(() => undefined)
    h.advance(120_000)
    await h.service.refresh({ projectId: 'project-1' })
    await flush()
    expect((await h.service.pullStatus({ projectId: 'project-1' })).pulls).toEqual([])
  })

  it('a configuration change between the heartbeat and the read is not a failed read', async () => {
    const h = harness()
    await h.service.subscribe(7, { projectId: 'project-1' })
    await vi.waitFor(() => expect(h.client.statusReads).toBe(1))
    h.client.changed = true
    h.client.onHeartbeat = () => h.setRevision('mapping-2')
    h.advance(120_000)
    await h.service.refresh({ projectId: 'project-1' })
    await flush()
    expect(h.client.statusReads).toBe(1)
    expect((await h.service.pullStatus({ projectId: 'project-1' })).stale).toBe(false)
  })

  it('a move claim is won once, and malformed asks are refused', async () => {
    const h = harness()
    expect(await h.service.claimPullAutoMove({ projectId: 'project-1', cardId: 'n', pulls: [1] })).toBe(false)
    await h.service.subscribe(7, { projectId: 'project-1' })
    await vi.waitFor(() => expect(h.client.statusReads).toBe(1))
    // No card was seen waiting on #1 yet: nothing may move.
    expect(await h.service.claimPullAutoMove({ projectId: 'project-1', cardId: 'n', pulls: [1] })).toBe(false)
    expect(await h.service.notePullWaits({ projectId: 'project-1', cardId: 'n', pulls: [1] })).toBe(1)
    expect(await h.service.notePullWaits({ projectId: 'project-1', cardId: 'other', pulls: [1] })).toBe(1)
    expect(await h.service.claimPullAutoMove({ projectId: 'project-1', cardId: 'n', pulls: [2, 1] })).toBe(true)
    expect(await h.service.claimPullAutoMove({ projectId: 'project-1', cardId: 'n', pulls: [1, 2] })).toBe(false)
    expect(await h.service.claimPullAutoMove({ projectId: 'project-1', cardId: 'other', pulls: [1, 2] })).toBe(true)
    expect(await h.service.claimPullAutoMove({ projectId: 'project-1', cardId: 'never-waited', pulls: [1] })).toBe(false)
    for (const bad of [
      { projectId: 'project-1', cardId: '', pulls: [1] },
      { projectId: 'project-1', cardId: 'x'.repeat(300), pulls: [1] },
      { projectId: 'project-1', cardId: 'n\u0001', pulls: [1] },
      { projectId: 'project-1', cardId: 'n', pulls: [] },
      { projectId: 'project-1', cardId: 'n', pulls: [0] },
      null
    ]) {
      expect(await h.service.claimPullAutoMove(bad as never)).toBe(false)
      expect(await h.service.notePullWaits(bad as never)).toBe(0)
    }
  })
})

describe('GitHubIssueService.controlSnapshot — the read behind the `issues` / `prs` control verbs', () => {
  function readOnlyHarness() {
    const client = new PullClient()
    let contexts = 0
    const service = new GitHubIssueService({
      cache: new GitHubIssueCache(userDataDir),
      coordinator: new GitHubRequestCoordinator({ now: () => 1_000_000 }),
      // The credential chain: every resolve is counted. The cache read must never take it.
      contextForProject: async () => { contexts += 1; return context(client) },
      projectContextForCache: async () => {
        const { client: _c, credentialGeneration: _g, userId: _u, ...cacheContext } = context(client)
        return cacheContext
      },
      now: () => 1_000_000,
      setInterval: () => 1,
      clearInterval: () => undefined
    })
    return { client, service, contexts: () => contexts }
  }

  it('before any fetch: no snapshot, and not one request or credential resolve', async () => {
    const h = readOnlyHarness()
    const snapshot = await h.service.controlSnapshot('project-1')
    expect(snapshot).toMatchObject({ repository: 'o/r', hasSnapshot: false, partial: false, items: [] })
    await flush()
    expect([h.client.heartbeats, h.client.statusReads, h.client.checkReads, h.contexts()]).toEqual([0, 0, 0, 0])
  })

  it('after the board fetched: the cached items and pull status, with no further request', async () => {
    const h = readOnlyHarness()
    await h.service.subscribe(7, { projectId: 'project-1' })
    await vi.waitFor(() => expect(h.client.statusReads).toBe(1))
    await flush()
    const before = [h.client.heartbeats, h.client.statusReads, h.client.checkReads, h.contexts()]
    const snapshot = await h.service.controlSnapshot('project-1')
    expect(snapshot.hasSnapshot).toBe(true)
    expect(snapshot.pullBoard.pulls[0]).toMatchObject({ number: 1, ci: 'passed' })
    await flush()
    expect([h.client.heartbeats, h.client.statusReads, h.client.checkReads, h.contexts()]).toEqual(before)
  })
})

describe('GitHubIssueService — principal-declared pull requests', () => {
  /** A client that also answers single-PR reads: #1045 is open far outside the list window, #900
   *  merged long ago, #77 is an issue number. */
  class DeclaredClient extends PullClient {
    singleReads: number[] = []
    failSingle = new Set<number>()
    single: Record<number, PullOneRead> = {
      1045: { kind: 'open', facts: facts(1045, { rollup: 'FAILURE', mergeStateStatus: 'BLOCKED' }), access: { ci: true, merge: true } },
      900: { kind: 'finished', pull: { number: 900, headRefName: 'feat/900', crossRepository: false, lifecycle: 'merged' } },
      77: { kind: 'missing' }
    }
    async pullRequestStatus(_repository: string, number: number): Promise<PullOneRead> {
      this.singleReads.push(number)
      if (this.failSingle.has(number)) throw Object.assign(new Error('request-failed'), { code: 'request-failed', status: 502 })
      return this.single[number] ?? { kind: 'missing' }
    }
  }

  function declaredHarness(declared: Array<{ nodeId: string; pulls: number[]; repository?: string }>) {
    const client = new DeclaredClient()
    const h = harness(client)
    h.service.setDeclaredPulls((projectId) => projectId === 'project-1'
      ? declared.map((d) => ({ repository: 'o/r', ...d }))
      : [])
    return { ...h, client, declared }
  }

  it('a declared PR outside the read window gets its own state, and the board carries the declaration', async () => {
    const h = declaredHarness([{ nodeId: 'term-1', pulls: [1045, 900, 77] }])
    await h.service.subscribe(7, { projectId: 'project-1' })
    await vi.waitFor(() => expect(h.client.singleReads.sort()).toEqual([1045, 77, 900]))
    await flush()
    const board = await h.service.pullStatus({ projectId: 'project-1' })
    expect(board.declared).toEqual([{ nodeId: 'term-1', pulls: [1045, 900, 77] }])
    expect(board.pulls.find((p) => p.number === 1045)).toMatchObject({ lifecycle: 'open', ci: 'failed', merge: 'blocked' })
    // Merged before this machine ever saw it open: no mergedSeenAt, kept on the board because declared.
    expect(board.pulls.find((p) => p.number === 900)).toMatchObject({ lifecycle: 'merged' })
    expect(board.pulls.find((p) => p.number === 900)?.mergedSeenAt).toBeUndefined()
    expect(board.pulls.some((p) => p.number === 77)).toBe(false)
    expect(board.stale).toBe(false)
  })

  it('the next list read re-reads only the open one: a finished PR and a missing number are cached', async () => {
    const h = declaredHarness([{ nodeId: 'term-1', pulls: [1045, 900, 77] }])
    await h.service.subscribe(7, { projectId: 'project-1' })
    await vi.waitFor(() => expect(h.client.singleReads).toHaveLength(3))
    await flush()
    h.client.singleReads = []
    h.client.changed = true
    h.advance(60_000)
    await h.poll()
    await vi.waitFor(() => expect(h.client.statusReads).toBe(2))
    await flush()
    expect(h.client.singleReads).toEqual([1045])
    // Not read again, and still on the board: a declared merge stays visible without a mergedSeenAt.
    expect((await h.service.pullStatus({ projectId: 'project-1' })).pulls.find((p) => p.number === 900))
      .toMatchObject({ lifecycle: 'merged' })
  })

  it('a failed single read never fails the list read', async () => {
    const h = declaredHarness([{ nodeId: 'term-1', pulls: [1045] }])
    h.client.failSingle.add(1045)
    await h.service.subscribe(7, { projectId: 'project-1' })
    await vi.waitFor(() => expect(h.client.singleReads).toEqual([1045]))
    await flush()
    const board = await h.service.pullStatus({ projectId: 'project-1' })
    expect(board.stale).toBe(false)
    expect(board.pulls.map((p) => p.number)).toEqual([1])
  })

  it('a declared PR whose read failed is retried on a quiet repository (bounded), and then appears', async () => {
    const h = declaredHarness([{ nodeId: 'term-1', pulls: [1045] }])
    h.client.failSingle.add(1045)
    await h.service.subscribe(7, { projectId: 'project-1' })
    await vi.waitFor(() => expect(h.client.singleReads).toEqual([1045]))
    await flush()
    // A 304 heartbeat still reads once (the PR is not on the board), and claims the retry interval.
    h.advance(60_000)
    await h.poll()
    await vi.waitFor(() => expect(h.client.statusReads).toBe(2))
    await flush()
    // Within the interval a quiet repository reads nothing, however long the number keeps failing.
    h.advance(60_000)
    await h.poll()
    await flush()
    expect(h.client.statusReads).toBe(2)
    // Past it, the next read succeeds and the declared PR gets its state.
    h.client.failSingle.clear()
    h.advance(DECLARED_RETRY_MS)
    await h.poll()
    await vi.waitFor(() => expect(h.client.statusReads).toBe(3))
    await vi.waitFor(async () =>
      expect((await h.service.pullStatus({ projectId: 'project-1' })).pulls.find((p) => p.number === 1045))
        .toMatchObject({ ci: 'failed' }))
    // Resolved: no more retry reads.
    h.advance(DECLARED_RETRY_MS)
    await h.poll()
    await flush()
    expect(h.client.statusReads).toBe(3)
  })

  it('a declared PR the list read already covers costs no extra read', async () => {
    const h = declaredHarness([{ nodeId: 'term-1', pulls: [1] }])
    await h.service.subscribe(7, { projectId: 'project-1' })
    await vi.waitFor(() => expect(h.client.statusReads).toBe(1))
    await flush()
    expect(h.client.singleReads).toEqual([])
  })

  it('links declared for another repository are not shown', async () => {
    const h = declaredHarness([{ nodeId: 'term-1', pulls: [1], repository: 'someone/else' }])
    await h.service.subscribe(7, { projectId: 'project-1' })
    await flush()
    expect((await h.service.pullStatus({ projectId: 'project-1' })).declared).toBeUndefined()
  })

  it('a change re-reads at once: the board is notified and the new number is read without waiting for a poll', async () => {
    const notified: number[] = []
    const h = declaredHarness([])
    ;(h.service as unknown as { options: { onDelta: unknown } }).options.onDelta = (uiId: number) => notified.push(uiId)
    await h.service.subscribe(7, { projectId: 'project-1' })
    await vi.waitFor(() => expect(h.client.statusReads).toBe(1))
    await flush()
    notified.length = 0
    h.declared.push({ nodeId: 'term-1', pulls: [1045] })
    h.service.declaredPullsChanged('project-1')
    expect(notified).toContain(7)
    await vi.waitFor(() => expect(h.client.singleReads).toEqual([1045]))
    await vi.waitFor(async () =>
      expect((await h.service.pullStatus({ projectId: 'project-1' })).pulls.some((p) => p.number === 1045)).toBe(true))
  })

  it('auto-move: a PR declared while open can be noted and claimed; one declared after its merge cannot', async () => {
    const h = declaredHarness([{ nodeId: 'term-1', pulls: [1045] }])
    await h.service.subscribe(7, { projectId: 'project-1' })
    await vi.waitFor(() => expect(h.client.singleReads).toEqual([1045]))
    await flush()
    // Open when declared: the armed board notes the wait, then the merge is observed.
    expect(await h.service.notePullWaits({ projectId: 'project-1', cardId: 'term-1', pulls: [1045] })).toBe(1)
    h.client.single[1045] = { kind: 'finished', pull: { number: 1045, headRefName: 'feat/1045', crossRepository: false, lifecycle: 'merged' } }
    h.client.changed = true
    h.advance(60_000)
    await h.poll()
    await vi.waitFor(async () =>
      expect((await h.service.pullStatus({ projectId: 'project-1' })).pulls.find((p) => p.number === 1045)?.mergedSeenAt).toBeDefined())
    expect(await h.service.claimPullAutoMove({ projectId: 'project-1', cardId: 'term-1', pulls: [1045] })).toBe(true)

    // #900 was merged before it was declared: no wait note can be taken, so no claim.
    h.declared.push({ nodeId: 'term-2', pulls: [900] })
    h.service.declaredPullsChanged('project-1')
    await vi.waitFor(async () =>
      expect((await h.service.pullStatus({ projectId: 'project-1' })).pulls.some((p) => p.number === 900)).toBe(true))
    expect(await h.service.notePullWaits({ projectId: 'project-1', cardId: 'term-2', pulls: [900] })).toBe(0)
    expect(await h.service.claimPullAutoMove({ projectId: 'project-1', cardId: 'term-2', pulls: [900] })).toBe(false)
  })
})
