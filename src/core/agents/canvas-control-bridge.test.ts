/**
 * The canvas-control bridge: the transport contract, not the verbs.
 *
 * Three of these measure a decision that a "cleanup" would plausibly undo, so each names the cost:
 * the request is UNICAST (broadcasting it makes one agent's `open-claude` into N nodes and a rev
 * fight), the reply is accepted only from the client that was ASKED, and no-UI is a RETRYABLE
 * refusal distinct from the edition's permanent one (`src/server/control-unsupported.ts`).
 */
import { describe, it, expect, vi } from 'vitest'
import { IPC } from '../../shared/ipc'
import { fakePlatform } from '../platform-fake'
import {
  CONTROL_NO_UI_ERROR,
  CONTROL_TIMEOUT_ERROR,
  initCanvasControlBridge,
  pickControlClient,
  type ControlResultPayload
} from './canvas-control-bridge'

/** A bridge over a fake platform, with the ids attached and a deterministic requestId. */
function harness(clients: number[]) {
  const platform = fakePlatform()
  platform.clients.push(...clients)
  let n = 0
  const handler = initCanvasControlBridge({
    platform,
    candidates: () => platform.clientIds(),
    timeoutMs: 50,
    newRequestId: () => `req-${++n}`
  })
  /** Answer as `senderId` would, the way the renderer's `reply()` does. */
  const answer = (senderId: number, payload: ControlResultPayload) =>
    platform.senderListeners[IPC.agentControlResult](senderId, payload)
  return { platform, handler, answer }
}

describe('pickControlClient', () => {
  it('takes the LAST attached, so a reloaded tab outranks a stale one', () => {
    // Both platforms document clientIds() as attach order, and a dropped socket detaches and
    // re-attaches at the back — which is what makes "last" mean "most recently alive".
    expect(pickControlClient([7, 8, 9])).toBe(9)
    expect(pickControlClient([7])).toBe(7)
  })

  it('answers null for none attached rather than inventing a target', () => {
    expect(pickControlClient([])).toBeNull()
  })
})

describe('the request', () => {
  it('goes to exactly ONE client, never a broadcast', async () => {
    const { platform, handler, answer } = harness([1, 2, 3])
    const reply = handler({ verb: 'open-claude', nodeId: 'n-src', args: { title: 'x' } })
    // The assertion that matters: three attached tabs, ONE send. A broadcast here would have each
    // tab create its own node and save its own workspace — one agent's verb, three nodes.
    expect(platform.sent).toHaveLength(1)
    expect(platform.sent[0].to).toBe(3)
    expect(platform.sent[0].channel).toBe(IPC.agentControl)
    expect(platform.sent[0].args[0]).toEqual({
      requestId: 'req-1',
      sourceNodeId: 'n-src',
      verb: 'open-claude',
      args: { title: 'x' }
    })
    answer(3, { requestId: 'req-1', ok: true, message: 'opened' })
    expect(await reply).toEqual({ ok: true, message: 'opened' })
  })

  it('strips the requestId out of the reply the agent sees', async () => {
    const { handler, answer } = harness([1])
    const reply = handler({ verb: 'list', nodeId: 'n', args: {} })
    answer(1, { requestId: 'req-1', ok: true, result: { nodes: [] } })
    expect(await reply).toEqual({ ok: true, result: { nodes: [] } })
  })

  it('correlates concurrent requests independently, in whatever order they answer', async () => {
    const { handler, answer } = harness([1])
    const a = handler({ verb: 'list', nodeId: 'n-a', args: {} })
    const b = handler({ verb: 'board', nodeId: 'n-b', args: {} })
    answer(1, { requestId: 'req-2', ok: true, message: 'b' })
    answer(1, { requestId: 'req-1', ok: true, message: 'a' })
    expect(await a).toEqual({ ok: true, message: 'a' })
    expect(await b).toEqual({ ok: true, message: 'b' })
  })
})

describe('the reply', () => {
  it('is ignored from a client that was not asked', async () => {
    const { handler, answer } = harness([1, 2])
    const reply = handler({ verb: 'close', nodeId: 'n', args: { node: 'x' } })
    // Tab 1 answers for tab 2's request. Its answer describes a canvas that performed nothing, so
    // it must not resolve the wait — the real client's reply (or the timeout) still has to land.
    answer(1, { requestId: 'req-1', ok: true, message: 'closed by the wrong tab' })
    answer(2, { requestId: 'req-1', ok: false, error: 'refused' })
    expect(await reply).toEqual({ ok: false, error: 'refused' })
  })

  it('ignores an unknown or malformed requestId without throwing', () => {
    const { answer } = harness([1])
    expect(() => answer(1, { requestId: 'nope', ok: true })).not.toThrow()
    expect(() => answer(1, undefined as unknown as ControlResultPayload)).not.toThrow()
    expect(() => answer(1, {} as ControlResultPayload)).not.toThrow()
  })

  it('cannot resolve a request twice', async () => {
    const { handler, answer } = harness([1])
    const reply = handler({ verb: 'list', nodeId: 'n', args: {} })
    answer(1, { requestId: 'req-1', ok: true, message: 'first' })
    answer(1, { requestId: 'req-1', ok: false, error: 'second' })
    expect(await reply).toEqual({ ok: true, message: 'first' })
  })
})

describe('the refusals', () => {
  it('no UI attached is NAMED and retryable, and sends nothing', async () => {
    const { platform, handler } = harness([])
    const reply = await handler({ verb: 'open-terminal', nodeId: 'n', args: {} })
    expect(reply.ok).toBe(false)
    expect(reply.error).toBe(CONTROL_NO_UI_ERROR)
    expect(reply.message).toContain('retryable')
    // Not the permanent one: a browser tab fixes this, and an agent told "permanent" would give up
    // on a canvas that is one click from working. (The inverse mistake — reporting a permanent fact
    // as an outage — is what src/server/control-unsupported.ts exists for.)
    expect(reply.message).not.toContain('do not retry')
    expect(platform.sent).toHaveLength(0)
  })

  it('times out rather than hanging when the asked client never answers', async () => {
    vi.useFakeTimers()
    try {
      const { handler } = harness([1])
      const reply = handler({ verb: 'write', nodeId: 'n', args: { node: 'x', text: 'hi' } })
      await vi.advanceTimersByTimeAsync(51)
      expect(await reply).toEqual({ ok: false, error: CONTROL_TIMEOUT_ERROR })
    } finally {
      vi.useRealTimers()
    }
  })

  it('a late reply after the timeout changes nothing', async () => {
    vi.useFakeTimers()
    try {
      const { handler, answer } = harness([1])
      const reply = handler({ verb: 'list', nodeId: 'n', args: {} })
      await vi.advanceTimersByTimeAsync(51)
      expect(await reply).toEqual({ ok: false, error: CONTROL_TIMEOUT_ERROR })
      expect(() => answer(1, { requestId: 'req-1', ok: true, message: 'too late' })).not.toThrow()
    } finally {
      vi.useRealTimers()
    }
  })
})
