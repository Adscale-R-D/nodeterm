// Fork patch #6, end to end through the real messaging service: an agent's message queued before a
// Server Edition restart flushes after it — the creator ledger and the pane owner both come back
// from disk — and is still refused when the target's session changed.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  createDeliveryQueue,
  deliverFromControl,
  onMessagingAgentEvent,
  restoreDeliveryQueue,
  type AgentMessagingDeps
} from '../core/agents/agent-messaging'
import { QUEUE_FACT } from '../core/agents/delivery-queue'
import { resetMessageFlow } from '../core/agents/agent-message-flow'
import { resetAgentMessageTraceForTests } from '../core/agents/agent-message-trace'
import { MANAGED_SCRIPT_REVISION } from '../core/agents/hooks/managed-script'
import {
  attachPaneOwnershipStore,
  paneOwnerProject,
  persistFreshSpawnStamp,
  recordFreshSpawnOwner,
  reprovePaneOwners,
  resetPaneOwnershipForTests,
  type PaneOwnerRecord
} from '../core/agents/pane-ownership'
import { DurableFactFile } from '../core/durable-state'
import type { MirrorEntry } from '../core/agent-status-mirror'
import { testTmpDir } from '../core/test-tmp'
import { createHeadlessNodeOwnership, type HeadlessOwnerRecord } from './headless-node-factory'

const STAMP = '$7|1795005377|443794'

function deps(over: {
  mirror: Record<string, MirrorEntry>
  owners: ReturnType<typeof createHeadlessNodeOwnership>
  sent: string[]
}): AgentMessagingDeps {
  return {
    paneOwner: async () => ({ tty: '/dev/pts/9', panePid: 100, paneId: '%1', command: 'claude', argv: ['claude'], pids: [200] }),
    sendEnvelope: async (nodeId) => {
      over.sent.push(nodeId)
      return true
    },
    hasLiveSession: () => true,
    mirrorEntry: (id) => over.mirror[id],
    projects: () => [{ id: 'p1', nodes: [{ id: 'boss', title: 'Boss', agentId: 'claude' }, { id: 'st1', title: 'Station', agentId: 'claude' }] }],
    isRemoteNode: () => false,
    messagingEnabled: () => true,
    paneOwnerProject,
    callerOwnsTarget: (src, target) => over.owners.ownerOf(target)?.sourceNodeId === src,
    customAgents: () => undefined,
    appendBoardLog: async () => false,
    subscribeReceipts: (cb) => {
      const t = setTimeout(() => cb({ nodeId: 'st1', newTurn: true, verified: true }), 5)
      return () => clearTimeout(t)
    }
  }
}

const entry = (state: MirrorEntry['state'], sessionId: string): MirrorEntry => ({
  state,
  updatedAt: Date.now(),
  stateVerified: true,
  clientRevision: MANAGED_SCRIPT_REVISION,
  agentId: 'claude',
  sessionId
})

/** Run 1: boss opens st1 (both ledgers record it), st1 is busy, boss's `send` is queued. */
async function firstRun(dir: string) {
  let ownerRows: HeadlessOwnerRecord[] = []
  let paneRows: PaneOwnerRecord[] = []
  const owners = createHeadlessNodeOwnership({ load: () => ownerRows, save: (r) => (ownerRows = [...r]) })
  attachPaneOwnershipStore({ load: () => paneRows, save: (r) => (paneRows = [...r]) })
  owners.record('st1', { sourceNodeId: 'boss', projectId: 'p1' })
  persistFreshSpawnStamp('st1', 'p1', recordFreshSpawnOwner('st1', 'p1')!, STAMP)
  const queueFile = new DurableFactFile(QUEUE_FACT, { userDataDir: dir, debounceMs: 1 })
  const d = deps({ mirror: { st1: entry('working', 's-A') }, owners, sent: [] })
  d.queue = createDeliveryQueue(d, { durable: queueFile })
  const { outcome } = await deliverFromControl({ verb: 'send', sourceNodeId: 'boss', targetNodeId: 'st1', body: 'next task' } as never, d)
  expect(outcome.kind).toBe('queued')
  await queueFile.flush()
  return { ownerRows: () => ownerRows, paneRows: () => paneRows }
}

/** Run 2: nothing in memory; everything read back from disk. */
async function secondRun(dir: string, saved: Awaited<ReturnType<typeof firstRun>>, sessionNow: string, durableOwners = true) {
  resetPaneOwnershipForTests()
  const rows = saved.ownerRows()
  const owners = durableOwners ? createHeadlessNodeOwnership({ load: () => rows, save: () => undefined }) : createHeadlessNodeOwnership()
  const paneRows = saved.paneRows()
  attachPaneOwnershipStore({ load: () => paneRows, save: () => undefined })
  reprovePaneOwners(() => STAMP)
  const sent: string[] = []
  const queueFile = new DurableFactFile(QUEUE_FACT, { userDataDir: dir, debounceMs: 1 })
  const d = deps({ mirror: { st1: entry('done', sessionNow) }, owners, sent })
  const flushed: string[] = []
  d.onQueuedResult = (_req, outcome) => flushed.push(outcome.kind === 'notPermitted' ? `notPermitted:${outcome.reason}` : outcome.kind)
  d.queue = createDeliveryQueue(d, { durable: queueFile })
  await restoreDeliveryQueue(d.queue, queueFile)
  onMessagingAgentEvent({ nodeId: 'st1', state: 'done', verified: true }, d.queue)
  for (let i = 0; i < 50 && !flushed.length; i++) await new Promise((r) => setTimeout(r, 20))
  return { sent, flushed }
}

beforeEach(() => {
  resetMessageFlow()
  resetAgentMessageTraceForTests()
  resetPaneOwnershipForTests()
})
afterEach(() => resetPaneOwnershipForTests())

describe('a queued agent message across a Server Edition restart', () => {
  it('flushes into the same session: creator and pane owner both came back from disk', async () => {
    const dir = testTmpDir('nt-own-restart-')
    const r = await secondRun(dir, await firstRun(dir), 's-A')
    expect(r.flushed).toEqual(['delivered'])
    expect(r.sent).toEqual(['st1'])
  })

  it('a different session in the pane ends it targetGone; nothing typed', async () => {
    const dir = testTmpDir('nt-own-restart-')
    const r = await secondRun(dir, await firstRun(dir), 's-B')
    expect(r.sent).toEqual([])
    expect(r.flushed).toEqual(['targetGone'])
  })

  it('control: with the old in-memory creator ledger the same flush is refused caller-not-owner', async () => {
    const dir = testTmpDir('nt-own-restart-')
    const r = await secondRun(dir, await firstRun(dir), 's-A', false)
    expect(r.sent).toEqual([])
    expect(r.flushed).toEqual(['notPermitted:caller-not-owner'])
  })
})
