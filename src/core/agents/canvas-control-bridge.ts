/**
 * Canvas control's transport half: the two async hops between an agent's `nodeterm` CLI and the
 * canvas that answers it.
 *
 * WHAT THIS IS NOT. It implements no verb. All 25 of them live in `Canvas.tsx`'s `onAgentControl`
 * effect, because the canvas IS React Flow's node array — `core/canvas-sync.ts` is explicit that it
 * holds no canvas state, so there is nothing on a headless host for a verb to act on. That is why
 * this file is a pipe: hand the request to ONE attached UI, correlate its reply, and bound the wait.
 *
 * WHY IT IS IN CORE. It was `src/main/index.ts`'s inline handler, which meant the Server Edition had
 * none — every verb fell to a named refusal (`control-unsupported.ts`) and no agent on a headless
 * host could open a node. Everything the forwarding needs is already on `CorePlatform` (`sendTo` /
 * `clientIds` / `onWithSender`), so both shells share this one copy rather than keeping two that
 * drift (see CLAUDE.md, "a duplicated rule drifts, and this branch was bitten three times").
 *
 * THE REQUEST IS UNICAST, AND THAT IS LOAD-BEARING. Every other push in this app broadcasts
 * (`agent:status`, `context:update`), but a control verb MUTATES the canvas: `open-claude`
 * broadcast to three attached browser tabs would have each tab create its own node and save its own
 * workspace, so one agent's request becomes three nodes and a rev fight. One client performs it, and
 * `canvas-sync` reflects the resulting mutation to the peers — which is the existing contract for
 * every other canvas edit, so the peers converge exactly as they do for a human's edit.
 *
 * WHICH client is the LAST of the candidates (both platforms document `clientIds()` as attach
 * order). The desktop has exactly one candidate, so nothing changes there; on the Server Edition it
 * is the tab the user most recently opened or reloaded — a dropped socket detaches and re-attaches
 * at the back, so a live tab outranks a stale one someone left open on a sleeping laptop. It is a
 * heuristic, and the timeout below is what bounds being wrong about it.
 *
 * THE CANDIDATES ARE THE SHELL'S TO NAME, and `candidates` is REQUIRED for that reason — asking
 * without knowing is a compile error. `platform.clientIds()` is the wrong default on the desktop:
 * there it is the main window PLUS every relay peer (`platform-electron.ts` → `peerRegistry`), and a
 * relay peer is a phone attached to SESSIONS. It has no canvas at all, so "last attached" over that
 * list would hand `open-claude` to a paired phone, which can neither perform it nor refuse it — the
 * agent would just wait out the timeout while the desktop canvas sat right there. Only a UI that
 * owns a canvas belongs in this list.
 */

import { randomUUID } from 'node:crypto'
import { IPC } from '../../shared/ipc'
import type { CorePlatform } from '../platform'

/** What a verb's reply looks like on the wire, in both directions. Structurally the shape
 *  `hook-server.ts`'s control handler resolves and `Canvas.tsx`'s `reply()` sends. */
export interface ControlReply {
  ok: boolean
  message?: string
  result?: unknown
  error?: string
}

/** A reply carrying the requestId it answers. Exported for the tests, which forge these. */
export interface ControlResultPayload extends ControlReply {
  requestId: string
}

/**
 * No UI is attached, so there is no canvas to act on. NOT the same fact as
 * `control-unsupported-on-this-edition`: that one is permanent and tells the agent never to retry,
 * this one clears the moment a tab attaches — which is the normal state of a headless server, where
 * the agent's tmux session outlives every browser. So it says so, and says the wait is worth it.
 *
 * Getting this distinction wrong is the exact bug `src/server/control-unsupported.ts` was written
 * for, in the other direction: a model told "unavailable" retries an outage forever, and a model
 * told "permanent" gives up on something a single browser tab would have fixed.
 */
export const CONTROL_NO_UI_ERROR = 'control-no-ui-attached'

export const CONTROL_NO_UI_SENTENCE =
  'No nodeterm UI is attached, so there is no canvas to act on. Open the nodeterm window (Server ' +
  'Edition: the web UI in a browser) and try again — this is retryable, not permanent.'

/** The reply the caller gets when nobody is attached. One line: the sh shim renders one line. */
export function controlNoUiReply(): ControlReply {
  return {
    ok: false,
    error: CONTROL_NO_UI_ERROR,
    message: `${CONTROL_NO_UI_ERROR}: ${CONTROL_NO_UI_SENTENCE}`
  }
}

/**
 * The wait before a request is abandoned. Long because a verb can legitimately take minutes: it may
 * travel to another project (`controlRouting`), and `write` and the destructive verbs wait on a
 * HUMAN clicking a confirm dialog. Cheaper to make the agent wait than to leave it unsure whether
 * the node it asked for is about to appear.
 */
export const CONTROL_TIMEOUT_MS = 120_000

export const CONTROL_TIMEOUT_ERROR = 'timed out (no response / not confirmed)'

/** Which candidate answers: the last to attach. Pure, so the choice is testable without a
 *  platform. `null` for none attached — the caller turns that into `controlNoUiReply()`. */
export function pickControlClient(candidates: readonly number[]): number | null {
  return candidates.length ? candidates[candidates.length - 1] : null
}

export interface ControlRequest {
  verb: string
  nodeId: string
  args: Record<string, string>
}

/** What `hookServer.setControlHandler` takes. */
export type ControlHandler = (req: ControlRequest) => Promise<ControlReply>

/**
 * Register the result listener and return the handler to hand to `hookServer.setControlHandler`.
 *
 * Call ONCE per platform: `onWithSender` COMPOSES on a channel (the platforms keep an ordered set
 * per channel), so a second registration would resolve each request twice — harmless for the
 * pending map, which deletes on first resolve, but it is a real leak of listeners, and the same trap
 * `canvas-sync.ts` guards with its `registeredOn`.
 */
export function initCanvasControlBridge(deps: {
  platform: CorePlatform
  /** Every attached UI that OWNS A CANVAS, in attach order. Required, never defaulted — see the
   *  header: the desktop's `platform.clientIds()` includes canvas-less relay peers. */
  candidates: () => number[]
  /** Overridden only by tests, which must not sit on a two-minute timer. */
  timeoutMs?: number
  newRequestId?: () => string
}): ControlHandler {
  const { platform, candidates, timeoutMs = CONTROL_TIMEOUT_MS, newRequestId = randomUUID } = deps

  const pending = new Map<
    string,
    { resolve: (r: ControlReply) => void; timer: ReturnType<typeof setTimeout>; uiId: number }
  >()

  platform.onWithSender(IPC.agentControlResult, (senderId: number, payload: ControlResultPayload) => {
    if (!payload || typeof payload.requestId !== 'string') return
    const entry = pending.get(payload.requestId)
    if (!entry) return
    // Only the client we ASKED may answer. A requestId is a `randomUUID` a peer never sees, so this
    // is not much of a gate on its own — the point is that a second tab which somehow observed one
    // cannot answer on the acting tab's behalf, because its answer would describe a canvas that
    // performed nothing. Silently ignored, so the real client's reply (or the timeout) still lands.
    if (senderId !== entry.uiId) return
    clearTimeout(entry.timer)
    pending.delete(payload.requestId)
    const { requestId: _drop, ...reply } = payload
    entry.resolve(reply)
  })

  return async ({ verb, nodeId, args }) => {
    const uiId = pickControlClient(candidates())
    if (uiId === null) return controlNoUiReply()
    const requestId = newRequestId()
    return await new Promise<ControlReply>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(requestId)
        resolve({ ok: false, error: CONTROL_TIMEOUT_ERROR })
      }, timeoutMs)
      pending.set(requestId, { resolve, timer, uiId })
      // If the client vanished between the pick and the send, `sendTo` drops silently and the
      // timeout is what answers. Deliberate: re-picking here would race the same window again, and
      // an unattached-at-send-time request is indistinguishable from one whose tab never replied.
      platform.sendTo(uiId, IPC.agentControl, { requestId, sourceNodeId: nodeId, verb, args })
    })
  }
}
