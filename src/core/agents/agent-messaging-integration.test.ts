/**
 * An INTEGRATION PRINCIPAL's `send` through the messaging service (docs/integration-principal.md):
 * the same gate chain as an agent's `send`, with the principal's own scope, creator check and
 * envelope, and no per-project switch (registration is that consent).
 */
import { beforeEach, describe, expect, it } from 'vitest'

import {
  createDeliveryQueue,
  deliverIntegrationMessage,
  onMessagingAgentEvent,
  type AgentMessagingDeps,
  type IntegrationMessage
} from './agent-messaging'
import { resetMessageFlow } from './agent-message-flow'
import { resetAgentMessageTraceForTests } from './agent-message-trace'
import { MANAGED_SCRIPT_REVISION } from './hooks/managed-script'
import { sanitizePersistedQueueEntry } from './delivery-queue'
import type { MirrorEntry } from '../agent-status-mirror'
import { INTEGRATION_MESSAGE_VERB, INTEGRATION_REPLY_TO } from '../../shared/integration-principal'

const idle: MirrorEntry = { state: 'done', updatedAt: 1, stateVerified: true, clientRevision: MANAGED_SCRIPT_REVISION }
const working: MirrorEntry = { ...idle, state: 'working' }

function fakeDeps(over: Partial<AgentMessagingDeps> = {}): AgentMessagingDeps & { sent: string[]; owners: string[] } {
  const sent: string[] = []
  const owners: string[] = []
  return {
    sent,
    owners,
    paneOwner: async (nodeId) => {
      owners.push(nodeId)
      return { tty: '/dev/pts/9', panePid: 100, paneId: '%1', command: 'claude', argv: ['claude'], pids: [200] }
    },
    sendEnvelope: async (_nodeId, payload) => {
      sent.push(payload)
      return true
    },
    hasLiveSession: () => true,
    mirrorEntry: () => idle,
    projects: () => [
      { id: 'p1', nodes: [{ id: 'n1', title: 'APP-1', agentId: 'claude' }] },
      { id: 'p2', nodes: [{ id: 'm2', title: 'Other', agentId: 'claude' }] }
    ],
    isRemoteNode: () => false,
    // Off on purpose: a principal's registration is its messaging consent (decision D3).
    messagingEnabled: () => false,
    paneOwnerProject: (id) => (id === 'n1' ? 'p1' : id === 'm2' ? 'p2' : undefined),
    principalOwnsTarget: (principal, nodeId) => principal === 'sink' && nodeId === 'n1',
    customAgents: () => undefined,
    appendBoardLog: async () => false,
    subscribeReceipts: (cb) => {
      const t = setTimeout(() => cb({ nodeId: 'n1', newTurn: true, verified: true }), 5)
      return () => clearTimeout(t)
    },
    now: () => 1_000_000,
    ...over
  }
}

const msg = (over: Partial<IntegrationMessage> = {}): IntegrationMessage => ({
  verb: INTEGRATION_MESSAGE_VERB,
  principal: 'sink',
  label: 'Sink',
  projectId: 'p1',
  targetNodeId: 'n1',
  body: 'APP-1 got a new comment',
  sendId: 'send-1',
  ...over
})

beforeEach(() => {
  resetMessageFlow()
  resetAgentMessageTraceForTests()
})

describe('deliverIntegrationMessage', () => {
  it('delivers into a node the principal owns, with the switch OFF, naming the principal and no reply-to node', async () => {
    const deps = fakeDeps()
    const { outcome } = await deliverIntegrationMessage(msg(), deps)
    expect(outcome.kind).toBe('delivered')
    expect(deps.sent).toHaveLength(1)
    expect(deps.sent[0]).toContain('from: integration Sink')
    expect(deps.sent[0]).toContain(`reply-to: ${INTEGRATION_REPLY_TO}`)
    expect(deps.sent[0]).not.toContain('integration:sink')
    expect(deps.sent[0]).toContain('APP-1 got a new comment')
  })

  it('refuses a node the principal does not own, before touching the pane', async () => {
    const deps = fakeDeps({ projects: () => [{ id: 'p1', nodes: [{ id: 'n1' }, { id: 'n9' }] }], paneOwnerProject: () => 'p1' })
    const { outcome } = await deliverIntegrationMessage(msg({ targetNodeId: 'n9' }), deps)
    expect(outcome).toEqual({ kind: 'notPermitted', reason: 'caller-not-owner' })
    expect(deps.owners).toEqual([])
    expect(deps.sent).toEqual([])
  })

  it('a shell with no principal ledger refuses by edition', async () => {
    const deps = fakeDeps({ principalOwnsTarget: undefined })
    expect((await deliverIntegrationMessage(msg(), deps)).outcome).toEqual({ kind: 'notPermitted', reason: 'unsupported-edition' })
  })

  it('a target outside the project the principal opened it in is cross-project', async () => {
    const deps = fakeDeps({ principalOwnsTarget: () => true })
    expect((await deliverIntegrationMessage(msg({ targetNodeId: 'm2' }), deps)).outcome).toEqual({
      kind: 'notPermitted',
      reason: 'cross-project'
    })
  })

  it('an unproven pane (a restart, not re-proved) is refused, not delivered', async () => {
    const deps = fakeDeps({ paneOwnerProject: () => undefined })
    expect((await deliverIntegrationMessage(msg(), deps)).outcome).toEqual({ kind: 'notPermitted', reason: 'unproven-target-owner' })
    expect(deps.sent).toEqual([])
  })

  it('a busy target is queued with the asked TTL, and its end reaches onQueuedResult with the sendId', async () => {
    let state: MirrorEntry = working
    const ended: Array<{ sendId: unknown; kind: string }> = []
    const deps = fakeDeps({
      mirrorEntry: () => state,
      onQueuedResult: (req, outcome) => ended.push({ sendId: req.sendId, kind: outcome.kind })
    })
    deps.queue = createDeliveryQueue(deps)
    const { outcome } = await deliverIntegrationMessage(msg(), deps, { ttlMs: 60 * 60_000 })
    expect(outcome).toMatchObject({ kind: 'queued', ttlMs: 60 * 60_000 })
    expect(deps.sent).toEqual([])
    state = idle
    onMessagingAgentEvent({ nodeId: 'n1', state: 'done', verified: true }, deps.queue)
    await new Promise((r) => setTimeout(r, 40))
    expect(deps.sent).toHaveLength(1)
    expect(ended).toEqual([{ sendId: 'send-1', kind: 'delivered' }])
    deps.queue.resetForTests()
  })

  it('queue: false answers a busy target instead of queueing it', async () => {
    const deps = fakeDeps({ mirrorEntry: () => working })
    deps.queue = createDeliveryQueue(deps)
    expect((await deliverIntegrationMessage(msg(), deps, { queue: false })).outcome.kind).toBe('targetBusy')
    deps.queue.resetForTests()
  })

  it('each send has its own fan-out budget: five keys in a row are not rate-limited', async () => {
    const projects = [{ id: 'p1', nodes: ['n1', 'n2', 'n3', 'n4', 'n5'].map((id) => ({ id, agentId: 'claude' })) }]
    const deps = fakeDeps({
      projects: () => projects,
      paneOwnerProject: () => 'p1',
      principalOwnsTarget: () => true,
      subscribeReceipts: (cb) => {
        const t = setTimeout(() => ['n1', 'n2', 'n3', 'n4', 'n5'].forEach((nodeId) => cb({ nodeId, newTurn: true, verified: true })), 5)
        return () => clearTimeout(t)
      }
    })
    for (let i = 1; i <= 5; i++) {
      const { outcome } = await deliverIntegrationMessage(msg({ targetNodeId: `n${i}`, sendId: `s${i}` }), deps)
      expect(outcome.kind).toBe('delivered')
    }
  })
})

describe('a queued integration send on disk', () => {
  const entry = (sourceNodeId: string) => ({
    req: { verb: INTEGRATION_MESSAGE_VERB, sourceNodeId, targetNodeId: 'n1', sourceTitle: 'integration Sink', body: 'x', principal: 'sink', sendId: 's1' },
    enqueuedAt: 1,
    ttlMs: 1000,
    queuedTraceId: 't1'
  })
  it('is restorable with its own source shape', () => {
    expect(sanitizePersistedQueueEntry(entry('integration:sink'))).not.toBeNull()
  })
  it('refuses any other source shape for that verb', () => {
    expect(sanitizePersistedQueueEntry(entry('n1'))).toBeNull()
    expect(sanitizePersistedQueueEntry(entry('integration:../x'))).toBeNull()
  })
})
