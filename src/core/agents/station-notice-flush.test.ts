// A station reports with `--notify-opener` while its opener is busy; the notice is queued; the
// opener closes the station; the notice flushes on the opener's next idle. Before the fork patch it
// was refused `cross-project` there (the station was in no project any more) and dropped, unseen.
import { beforeEach, describe, expect, it } from 'vitest'
import { createDeliveryQueue, deliverStationNotice, onMessagingAgentEvent, STATION_NOTICE_TTL_MS, type AgentMessagingDeps } from './agent-messaging'
import { resetMessageFlow } from './agent-message-flow'
import { resetAgentMessageTraceForTests } from './agent-message-trace'
import { MANAGED_SCRIPT_REVISION } from './hooks/managed-script'
import { stationOutcomeNoticeBody } from '../../shared/station-notice'
import type { MirrorEntry } from '../agent-status-mirror'

const idle: MirrorEntry = { state: 'done', updatedAt: 1, stateVerified: true, clientRevision: MANAGED_SCRIPT_REVISION }

function setup() {
  let state: MirrorEntry = { ...idle, state: 'working' }
  let nodes = [{ id: 'orch', title: 'Opener', agentId: 'claude' }, { id: 'st1', title: 'Station', agentId: 'claude' }]
  let owns = true
  const sent: string[] = []
  const ttls: number[] = []
  const ended: string[] = []
  const deps: AgentMessagingDeps = {
    paneOwner: async () => ({ tty: '/dev/pts/9', panePid: 100, paneId: '%1', command: 'claude', argv: ['claude'], pids: [200] }),
    sendEnvelope: async (_n, payload) => {
      sent.push(payload)
      return true
    },
    hasLiveSession: () => true,
    mirrorEntry: () => state,
    projects: () => [{ id: 'p1', nodes }],
    isRemoteNode: () => false,
    messagingEnabled: () => true,
    paneOwnerProject: () => 'p1',
    callerOwnsTarget: (caller, target) => owns && caller === 'orch' && target === 'st1',
    customAgents: () => undefined,
    appendBoardLog: async () => true,
    subscribeReceipts: (cb) => {
      const t = setTimeout(() => cb({ nodeId: 'orch', newTurn: true, verified: true }), 1)
      return () => clearTimeout(t)
    },
    onQueuedResult: (_r, o) => ended.push(o.kind),
    now: () => 1_000_000
  }
  deps.queue = createDeliveryQueue(deps, {
    schedule: (ms) => {
      ttls.push(ms)
      return () => {}
    }
  })
  return {
    deps,
    sent,
    ttls,
    ended,
    idleNow: () => {
      state = idle
    },
    closeStation: () => {
      nodes = nodes.filter((n) => n.id !== 'st1')
      owns = false // the creator ledger row goes with the node
    }
  }
}

beforeEach(() => {
  resetMessageFlow()
  resetAgentMessageTraceForTests()
})

describe('a queued station notice outlives its closed station', () => {
  it('queued while the opener works, the station is closed, and the notice still lands with its note', async () => {
    const h = setup()
    const body = stationOutcomeNoticeBody({ id: 'st1', title: 'Station' }, 'succeeded', 'PR #42 opened')
    const first = await deliverStationNotice({ stationNodeId: 'st1', recipientNodeId: 'orch', body, outcome: true }, h.deps)
    expect(first.kind).toBe('queued')
    expect(h.ttls).toContain(STATION_NOTICE_TTL_MS) // not the 5-minute default
    h.closeStation()
    h.idleNow()
    await onMessagingAgentEvent({ nodeId: 'orch', state: 'done', verified: true }, h.deps.queue!)
    await new Promise((r) => setTimeout(r, 20))
    expect(h.ended).toEqual(['delivered'])
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]).toContain('its note: "PR #42 opened"')
  })

  it('a station-FAILURE notice keeps the old rules: the 5-minute wait, and no flush once the station is gone', async () => {
    const h = setup()
    const body = stationOutcomeNoticeBody({ id: 'st1', title: 'Station' }, 'failed')
    expect((await deliverStationNotice({ stationNodeId: 'st1', recipientNodeId: 'orch', body }, h.deps)).kind).toBe('queued')
    expect(h.ttls).not.toContain(STATION_NOTICE_TTL_MS)
    h.closeStation()
    h.idleNow()
    await onMessagingAgentEvent({ nodeId: 'orch', state: 'done', verified: true }, h.deps.queue!)
    await new Promise((r) => setTimeout(r, 20))
    expect(h.sent).toEqual([])
    expect(h.ended).toEqual(['notPermitted'])
  })

  it('a station that still EXISTS keeps the creator check: an opener that did not open it is refused', async () => {
    const h = setup()
    h.idleNow()
    const out = await deliverStationNotice(
      { stationNodeId: 'st1', recipientNodeId: 'orch', body: stationOutcomeNoticeBody({ id: 'st1' }, 'failed') },
      { ...h.deps, callerOwnsTarget: () => false, queue: undefined }
    )
    expect(out).toEqual({ kind: 'notPermitted', reason: 'caller-not-owner' })
    expect(h.sent).toEqual([])
  })
})

describe('stationOutcomeNoticeBody', () => {
  it('quotes a cleaned note, says when there is none, and never points at `list`', () => {
    const withNote = stationOutcomeNoticeBody({ id: 'st1', title: 'T' }, 'succeeded', 'done "fast"\nnext line‮')
    expect(withNote).toContain(`its note: "done 'fast' next line"`)
    expect(withNote).not.toContain('`list`')
    const without = stationOutcomeNoticeBody({ id: 'st1', title: 'T' }, 'failed')
    expect(without).toContain('It left no note.')
    expect(without).toContain('the station wrote none of it')
  })
})
