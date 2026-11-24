// A target whose status cannot be known — a CLI resumed after a reboot (SessionStart, then nothing
// until its next turn; measured on Claude Code 2.1.331) or a status restored from disk after a
// server restart — is answered by its own screen: idle at an empty prompt ⇒ deliver. Before this, a
// message queued for it waited for a turn only the message could start.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { readClaudeIdle } from '../../shared/agents/claude-screen'
import { decidePreProbe, screenIdleWaivable, SESSION_BOUNDARY_REASON, type AgentMessageOutcome } from './agent-message-decide'
import { deliverAgentMessage, type DeliveryDeps, type DeliveryRequest, type ReceiptEvent } from './agent-message'
import { DeliveryQueue, UNKNOWN_STATUS_RETRY_MS, UNKNOWN_STATUS_RETRY_MAX_MS, type CancelTimer, type QueuedDeliveryRequest } from './delivery-queue'
import { MANAGED_SCRIPT_REVISION } from './hooks/managed-script'
import type { MirrorEntry } from '../agent-status-mirror'
import type { PaneOwner } from '../../shared/agents/pane-owner-predicate'

const fixture = JSON.parse(
  readFileSync(join(__dirname, '../../shared/agents/__fixtures__/claude/idle-working-capture.json'), 'utf8')
) as { idle: string; working: string; question: string }

describe('readClaudeIdle — the screen half (captured on 2.1.331)', () => {
  it('an empty prompt with no busy hint is idle', () => {
    expect(readClaudeIdle(fixture.idle)).toBe(true)
  })
  it('a running turn is not: the composer is empty, but the status line says esc to interrupt', () => {
    expect(readClaudeIdle(fixture.working)).toBe(false)
  })
  it('a typed draft is not idle', () => {
    expect(readClaudeIdle(fixture.idle.replace('❯ ', '❯ half a sentence'))).toBe(false)
  })
  it('the older spinner line above the box ("(esc to interrupt)") also reads busy', () => {
    const lines = fixture.idle.split('\n')
    lines.splice(2, 0, '✻ Thinking… (esc to interrupt)')
    expect(readClaudeIdle(lines.join('\n'))).toBe(false)
  })
  it('a real question dialog (captured live: AskUserQuestion, its `❯ 1.` row highlighted) is not idle', () => {
    expect(readClaudeIdle(fixture.question)).toBe(false)
  })
  it('agrees with the 2.1.301 composer captures: only the empty one is idle', () => {
    const c = JSON.parse(
      readFileSync(join(__dirname, '../../shared/agents/__fixtures__/claude/composer-capture.json'), 'utf8')
    ) as { screens: Record<string, string> }
    for (const [name, screen] of Object.entries(c.screens)) expect([name, readClaudeIdle(screen)]).toEqual([name, name === 'empty'])
  })
  it('a dialog footer, no input box, or nothing at all is never idle', () => {
    expect(readClaudeIdle(`${fixture.idle}\nEnter to select · ↑/↓ to navigate · Esc to cancel`)).toBe(false)
    expect(readClaudeIdle('$ ls\nfile.txt\n$ ')).toBe(false)
    expect(readClaudeIdle('')).toBe(false)
  })
})

const verifiedDone = (over: Partial<MirrorEntry> = {}): MirrorEntry => ({
  state: 'done',
  updatedAt: 1000,
  stateVerified: true,
  verifiedAt: 1000,
  clientRevision: MANAGED_SCRIPT_REVISION,
  ...over
})
/** A CLI that crossed a verified SessionStart and has posted nothing since. */
const boundary = (): MirrorEntry => ({ updatedAt: 1000, stateVerified: false, verifiedAt: 900, clientRevision: MANAGED_SCRIPT_REVISION })
/** A status that came off disk at server start. */
const restored = (): MirrorEntry => ({ state: 'done', updatedAt: 1000, restored: true, stateVerified: false })

describe('screenIdleWaivable — which refusals the screen may answer', () => {
  const pre = (target: MirrorEntry | undefined, screenIdle?: boolean): AgentMessageOutcome | null =>
    decidePreProbe({ targetLive: true, target, tokenFilePresent: true, ...(screenIdle !== undefined ? { screenIdle } : {}) })

  it('a node between sessions (resumed after a reboot): refused without the screen, waived with it', () => {
    expect(pre(boundary())).toEqual({ kind: 'targetNotIdleUnknown', reason: SESSION_BOUNDARY_REASON })
    expect(pre(boundary(), true)).toBeNull()
    expect(pre(boundary(), false)?.kind).toBe('targetNotIdleUnknown')
  })
  it('a status restored from disk (server restart), and an expired one: waived', () => {
    expect(pre(restored())?.kind).toBe('targetStatusStale')
    expect(pre(restored(), true)).toBeNull()
    expect(pre({ updatedAt: 1000, stateExpired: true, stateVerified: false }, true)).toBeNull()
  })
  it('a status restored as waiting/blocked (a dialog when the server went down) is NOT waived', () => {
    for (const state of ['waiting', 'blocked'] as const)
      expect(pre({ ...restored(), state }, true)?.kind).toBe('targetStatusStale')
    expect(pre({ ...restored(), state: 'working' }, true)).toBeNull()
  })
  it('never waives a status that SAYS something, or a node with no evidence at all', () => {
    for (const state of ['working', 'waiting', 'blocked'] as const)
      expect(pre(verifiedDone({ state }), true)?.kind).toBe('targetBusy')
    // An idle_prompt-inferred done: a node holding an approval also idles at its prompt.
    expect(pre(verifiedDone({ idleInferred: true }), true)?.kind).toBe('targetNotIdleUnknown')
    expect(pre(undefined, true)?.kind).toBe('targetStatusStale') // never posted: not waived
    // Observed this run but never verified: an identity question, not an unknowable status.
    expect(pre({ updatedAt: 1000, stateVerified: false, clientRevision: MANAGED_SCRIPT_REVISION }, true)?.kind).toBe('targetStatusStale')
    // No token file, stale script: not the screen's to answer.
    expect(decidePreProbe({ targetLive: true, target: restored(), tokenFilePresent: false, screenIdle: true })?.kind).toBe('targetStatusUnverified')
    expect(pre({ updatedAt: 1000, stateVerified: false, clientRevision: 1 }, true)?.kind).toBe('targetHookScriptStale')
  })
  it('the predicate itself, directly', () => {
    expect(screenIdleWaivable({ kind: 'targetBusy', state: 'working' }, restored())).toBe(false)
    expect(screenIdleWaivable({ kind: 'targetStatusStale' }, boundary())).toBe(false)
    expect(screenIdleWaivable({ kind: 'targetNotIdleUnknown', reason: 'x' }, undefined)).toBe(false)
  })
})

const claudePane: PaneOwner = {
  panePid: 4242,
  tty: '/dev/pts/9',
  command: 'node',
  paneId: '%7',
  argv: ['node /usr/local/bin/claude --resume x'],
  pids: [5100]
}
const shellPane: PaneOwner = { panePid: 4242, tty: '/dev/pts/9', command: 'zsh', paneId: '%7', argv: ['-zsh'], pids: [4242] }

function harness(entry: MirrorEntry | undefined, screen: boolean | undefined, pane: PaneOwner = claudePane) {
  const order: string[] = []
  const sends: string[] = []
  const listeners = new Set<(e: ReceiptEvent) => void>()
  const deps: DeliveryDeps = {
    paneOwner: async () => {
      order.push('paneOwner')
      return pane
    },
    bracketPasteRequested: async () => true,
    sendEnvelope: async (_id, payload) => {
      sends.push(payload)
      return true
    },
    mirrorEntry: () => entry,
    tokenFilePresent: () => true,
    lock: async (_id, fn) => fn(),
    now: () => 1000,
    nonce: () => 'NONCE0123456',
    trace: async () => ({ traceId: 't', traced: 'board-log' }),
    subscribeEvents: (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    ...(screen !== undefined
      ? {
          screenIdle: async () => {
            order.push('screenIdle')
            return screen
          }
        }
      : {})
  }
  const request: DeliveryRequest = {
    targetNodeId: 'n-dst',
    sourceNodeId: 'integration:sink',
    sourceTitle: 'sink',
    body: 'update',
    targetAgentId: 'claude',
    origin: 'integration'
  }
  const run = async (): ReturnType<typeof deliverAgentMessage> => {
    const p = deliverAgentMessage(request, deps)
    for (let i = 0; i < 30; i++) await Promise.resolve()
    listeners.forEach((l) => l({ nodeId: 'n-dst', newTurn: true, verified: true }))
    return p
  }
  return { order, sends, run }
}

describe('deliverAgentMessage — an unknowable status answered by the screen', () => {
  it('a resumed CLI idle at its prompt is delivered, reading the pane owner ONCE', async () => {
    const h = harness(boundary(), true)
    expect((await h.run()).kind).toBe('delivered')
    expect(h.sends).toHaveLength(1)
    expect(h.order.filter((o) => o === 'paneOwner')).toHaveLength(2) // the gate + the post-write check
    expect(h.order.indexOf('paneOwner')).toBeLessThan(h.order.indexOf('screenIdle'))
  })
  it('a screen that is not idle (dialog, draft, running turn) keeps the old refusal, nothing written', async () => {
    const h = harness(restored(), false)
    expect((await h.run()).kind).toBe('targetStatusStale')
    expect(h.sends).toEqual([])
  })
  it('the screen of a pane the agent does not own is never read', async () => {
    const h = harness(boundary(), true, shellPane)
    expect((await h.run()).kind).toBe('targetNotIdleUnknown')
    expect(h.order).not.toContain('screenIdle')
    expect(h.sends).toEqual([])
  })
  it('a busy status is never handed to the screen', async () => {
    const h = harness(verifiedDone({ state: 'working' }), true)
    expect((await h.run()).kind).toBe('targetBusy')
    expect(h.order).toEqual([])
  })
  it('without the dep, nothing changes: the target waits for its next turn', async () => {
    const h = harness(boundary(), undefined)
    expect((await h.run()).kind).toBe('targetNotIdleUnknown')
    expect(h.order).toEqual([])
  })
})

describe('DeliveryQueue — a queue nothing will flush is WATCHED, silently', () => {
  function queue(ready: () => boolean) {
    const timers: Array<{ ms: number; fn: () => void; cancelled: boolean }> = []
    const delivered: string[] = []
    const traces: string[] = []
    let checks = 0
    const q = new DeliveryQueue({
      now: () => 1000,
      deliver: async (r) => {
        delivered.push(r.body)
        return { kind: 'delivered', traceId: 't', traced: 'board-log', receipt: 'observed', signal: 'newTurn' }
      },
      trace: async (input) => {
        traces.push(input.outcome)
        return { traceId: 't', traced: 'board-log' }
      },
      bindingOf: () => ({ sessionId: 's-A', agentId: 'claude' }),
      readyByScreen: async () => {
        checks++
        return ready()
      },
      schedule: (ms, fn): CancelTimer => {
        const t = { ms, fn, cancelled: false }
        timers.push(t)
        return () => {
          t.cancelled = true
        }
      }
    })
    const req: QueuedDeliveryRequest = {
      verb: 'integration-message',
      sourceNodeId: 'integration:sink',
      sourceTitle: 'sink',
      targetNodeId: 'n-dst',
      body: 'update'
    } as QueuedDeliveryRequest
    const watchTimers = () => timers.filter((t) => !t.cancelled && t.ms < 24 * 3_600_000 && t.ms !== 5 * 60_000)
    const fire = async (): Promise<number> => {
      const t = watchTimers()[0]
      t.cancelled = true
      t.fn()
      for (let i = 0; i < 20; i++) await Promise.resolve()
      return t.ms
    }
    return { q, req, fire, watchTimers, delivered, traces, checks: () => checks }
  }

  it('a restored entry whose session is not back yet stays queued, untraced, while the watch backs off', async () => {
    let ready = false
    const h = queue(() => ready)
    await h.q.restore([{ req: h.req, enqueuedAt: 1000, ttlMs: 86_400_000, queuedTraceId: 'q', binding: { sessionId: 's-A', agentId: 'claude' } }])
    const tracesAfterRestore = h.traces.length
    expect(await h.fire()).toBe(UNKNOWN_STATUS_RETRY_MS)
    expect(await h.fire()).toBe(UNKNOWN_STATUS_RETRY_MS * 2)
    expect(await h.fire()).toBe(UNKNOWN_STATUS_RETRY_MS * 4)
    expect(h.checks()).toBe(3)
    expect(h.q.depth('n-dst')).toBe(1) // never dropped as targetGone
    expect(h.delivered).toEqual([])
    expect(h.traces.length).toBe(tracesAfterRestore) // a "not yet" writes no board-log row
    ready = true
    await h.fire()
    expect(h.delivered).toEqual(['update'])
    expect(h.q.depth('n-dst')).toBe(0)
    expect(h.watchTimers()).toEqual([])
  })
  it('the back-off stops at 15 minutes', async () => {
    const h = queue(() => false)
    await h.q.enqueue(h.req)
    h.q.heldBy('n-dst', 'targetStatusStale')
    const seen: number[] = []
    for (let i = 0; i < 7; i++) seen.push(await h.fire())
    expect(seen.slice(-2)).toEqual([UNKNOWN_STATUS_RETRY_MAX_MS, UNKNOWN_STATUS_RETRY_MAX_MS])
  })
  it('a BUSY target is not watched: its own turn end flushes it', async () => {
    const h = queue(() => true)
    await h.q.enqueue(h.req)
    h.q.heldBy('n-dst', 'targetBusy')
    expect(h.watchTimers()).toEqual([])
  })
})

describe('wiring: both shells reach the screen read through ptyPaneProbeDeps', () => {
  it('the helper both shells spread forwards composerIdle with the pane read', async () => {
    const { ptyPaneProbeDeps } = await import('./agent-messaging')
    const calls: string[] = []
    const deps = ptyPaneProbeDeps({
      paneOwner: async () => null,
      paneProbeTimeoutMs: () => 2000,
      composerIdle: async (id, agent) => {
        calls.push(`${id}:${agent}`)
        return true
      }
    })
    expect(await deps.composerIdle?.('n1', 'claude')).toBe(true)
    expect(calls).toEqual(['n1:claude'])
  })
  it('PtyManager has the method (the shells pass a real PtyManager)', async () => {
    const { PtyManager } = await import('../pty-manager')
    expect(typeof PtyManager.prototype.composerIdle).toBe('function')
  })
})

describe('end to end: a restored queue after a reboot, through createDeliveryQueue + restoreDeliveryQueue', () => {
  it('nothing is sent, traced or dropped before the session is back; then the first lands and the second waits', async () => {
    const { initPlatform, resetPlatformForTests } = await import('../platform')
    const { fakePlatform } = await import('../platform-fake')
    const { writeNodeTokenFile, resetNodeTokenFilesForTests } = await import('./node-token-files')
    const { createDeliveryQueue, restoreDeliveryQueue } = await import('./agent-messaging')
    const { resetMessageFlow } = await import('./agent-message-flow')
    const { resetAgentMessageTraceForTests } = await import('./agent-message-trace')
    resetPlatformForTests()
    initPlatform(fakePlatform())
    resetNodeTokenFilesForTests()
    resetMessageFlow()
    resetAgentMessageTraceForTests()
    writeNodeTokenFile('n1', 'tok')

    let live = false
    const sent: string[] = []
    const boardRows: string[] = []
    const ended: string[] = []
    const timers: Array<{ ms: number; fn: () => void; cancelled: boolean }> = []
    const entry: MirrorEntry = { state: 'done', updatedAt: 1, restored: true, stateVerified: false, sessionId: 's-A', agentId: 'claude' }
    const deps = {
      paneOwner: async () =>
        live ? { tty: '/dev/pts/9', panePid: 100, paneId: '%1', command: 'claude', argv: ['claude'], pids: [200] } : null,
      sendEnvelope: async (_n: string, payload: string) => {
        sent.push(payload)
        return true
      },
      composerIdle: async () => live,
      hasLiveSession: () => live,
      mirrorEntry: () => entry,
      projects: () => [{ id: 'p1', nodes: [{ id: 'n1', title: 'APP-1', agentId: 'claude' }] }],
      isRemoteNode: () => false,
      messagingEnabled: () => false,
      paneOwnerProject: () => (live ? 'p1' : undefined),
      principalOwnsTarget: () => true,
      customAgents: () => undefined,
      appendBoardLog: async (_p: string, e: { event?: { title?: string } }) => {
        boardRows.push(String(e.event?.title))
        return true
      },
      subscribeReceipts: (cb: (e: ReceiptEvent) => void) => {
        const t = setTimeout(() => cb({ nodeId: 'n1', newTurn: true, verified: true }), 1)
        return () => clearTimeout(t)
      },
      onQueuedResult: (_r: unknown, o: { kind: string }) => ended.push(o.kind),
      now: () => 2_000_000
    } as unknown as Parameters<typeof createDeliveryQueue>[0]
    const queue = createDeliveryQueue(deps, {
      schedule: (ms, fn) => {
        const t = { ms, fn, cancelled: false }
        timers.push(t)
        return () => {
          t.cancelled = true
        }
      }
    })
    const persisted = ['first', 'second'].map((body, i) => ({
      req: {
        verb: 'integration-message',
        principal: 'sink',
        label: 'Sink',
        projectId: 'p1',
        targetNodeId: 'n1',
        body,
        sendId: `s${i}`,
        sourceNodeId: 'integration:sink',
        sourceTitle: 'integration Sink'
      },
      enqueuedAt: 1_990_000,
      ttlMs: 86_400_000,
      queuedTraceId: `q${i}`,
      binding: { sessionId: 's-A', agentId: 'claude' }
    }))
    await restoreDeliveryQueue(queue, { load: () => persisted as never })
    const fireWatch = async (): Promise<void> => {
      const t = timers.find((x) => !x.cancelled && x.ms >= UNKNOWN_STATUS_RETRY_MS && x.ms <= UNKNOWN_STATUS_RETRY_MAX_MS)!
      t.cancelled = true
      t.fn()
      await new Promise((r) => setTimeout(r, 30))
    }
    // The session is not back yet: two watch checks, nothing happens.
    await fireWatch()
    await fireWatch()
    expect(sent).toEqual([])
    expect(boardRows).toEqual([])
    expect(ended).toEqual([])
    expect(queue.depth('n1')).toBe(2)
    // The sink resumes it; the screen shows an idle prompt.
    live = true
    await fireWatch()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('first')
    expect(ended).toEqual(['delivered'])
    expect(queue.depth('n1')).toBe(1) // behind the pair window, not lost
  })
})
