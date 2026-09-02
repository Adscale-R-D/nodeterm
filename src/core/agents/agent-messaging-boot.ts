/**
 * Booting agent messaging — ONE wiring, both shells.
 *
 * WHY THIS FILE EXISTS. `agent-messaging.ts` lived in `src/main` and was therefore desktop-only, so
 * `send`/`reply`/`notify` were refused by name on the Server Edition and an author↔reviewer handoff
 * had to route through the human. Nothing about it needed Electron: its imports were already all
 * `shared`/`core`, and its whole surface is the injected `AgentMessagingDeps`. What kept it out of
 * core was the *wiring*, which sat inline in `src/main/index.ts` — the same shape as the
 * canvas-control bridge, and the same fix.
 *
 * WHY A FACTORY RATHER THAN TWO DEPS OBJECTS. Every field below is identical on both shells (they
 * share `PtyManager`, `WorkspaceStore`, `SettingsStore` and the board-log router), so two copies
 * would be nine lines of duplicated SECURITY-relevant wiring: the per-project capability grant, the
 * runtime pane-ownership gate, and the flow reservation. CLAUDE.md's rule, learned three times in
 * this repo — a duplicated rule drifts — and the two things most likely to drift here are exactly
 * the two that must not: `messagingEnabled` reading the GRANT (never the raw file bit) and
 * `paneOwnerProject` being consulted at all.
 *
 * IT ALSO OWNS THE PARITY HAZARD. `onMessagingAgentEvent` must be fed from BOTH shells' raw hook
 * listeners or the queue never flushes on that shell — the exact class of one-shell miss this repo
 * has shipped three times. It is returned from here so each listener has one obvious call to make,
 * and `agent-messaging-both-shells.test.ts` asserts both make it.
 */

import { IPC } from '../../shared/ipc'
import type { NormalizedAgentEvent } from '../../shared/agents/normalize'
import type { BoardLogEntry } from '../../shared/types'
import { platform } from '../platform'
import { paneOwnerProject } from './pane-ownership'
import {
  createDeliveryQueue,
  deliverFromControl,
  isDeliverRequest,
  messagingEnabledVia,
  onMessagingAgentEvent,
  setDeliveryQueue,
  type AgentMessagingDeps,
  type MessagingStoredNode
} from './agent-messaging'

/** The few things a shell must hand over: everything else is derived here. */
export interface AgentMessagingBootDeps {
  ptyManager: {
    paneOwner: AgentMessagingDeps['paneOwner']
    sendEnvelope: AgentMessagingDeps['sendEnvelope']
    hasLiveSession: AgentMessagingDeps['hasLiveSession']
  }
  /** The delivery SCOPE: every persisted canvas and its nodes — the same index the desktop reads. */
  projects(): readonly { id: string; nodes: readonly MessagingStoredNode[] }[]
  settings: { customAgents(): readonly { id: string; launchCmd: string }[] | undefined }
  appendBoardLog(projectId: string, entry: BoardLogEntry): Promise<boolean>
  /**
   * REQUIRED, not defaulted. A remote (SSH-project) node's pane lives on another machine, and the
   * delivery gate must know. The desktop answers from `ptyManager.sshRemoteForNode`; the Server
   * Edition answers a constant `false`, which is COMPLETE there rather than lazy — SSH projects are
   * a desktop-only concept on that edition (see docs/SERVER.md). Making it required means a third
   * shell cannot inherit either answer by accident.
   */
  isRemoteNode(nodeId: string): boolean
  /**
   * The capability lookup `messagingEnabledVia` wraps (`WorkspaceStore.capabilityProjectFor`).
   * Injected rather than taken off a store object so the suite can drive the identical wiring, and
   * so nothing here can reach for the raw project.json flag by mistake.
   */
  capabilityProjectFor: Parameters<typeof messagingEnabledVia>[0]
}

export interface AgentMessagingHandle {
  deps: AgentMessagingDeps
  /** Feed EVERY normalized agent event here, from this shell's raw hook listener. */
  onAgentEvent(event: NormalizedAgentEvent): void
}

/**
 * Build the deps, arm the deliver-on-idle queue, and register the `agent-message:deliver` handler on
 * whichever platform is installed. Call once per shell, after PtyManager and the stores exist.
 */
export function initAgentMessaging(boot: AgentMessagingBootDeps): AgentMessagingHandle {
  const deps: AgentMessagingDeps = {
    paneOwner: (id) => boot.ptyManager.paneOwner(id),
    sendEnvelope: (id, envelope) => boot.ptyManager.sendEnvelope(id, envelope),
    hasLiveSession: (id) => boot.ptyManager.hasLiveSession(id),
    projects: () => boot.projects(),
    isRemoteNode: (id) => boot.isRemoteNode(id),
    // GLOBAL CONSTRAINT 11: every delivery path is gated behind the per-project switch, OFF by
    // default. The switch is the `agentMessaging` capability GRANT — the strict `=== true` flag in
    // the hostile git-shared project.json AND this machine's recorded 'kept' answer to the clone
    // notice (`projectCapabilityGrantedFor`), never the raw file bit. Read per call, so a decline or
    // an off-toggle refuses the very next delivery.
    messagingEnabled: messagingEnabledVia(boot.capabilityProjectFor),
    // Runtime pane ownership: which project PROVABLY spawned the target's pane this run. The gate
    // trusts this over the attacker-writable store to decide whose grant applies; unproven ⇒
    // refused. Already in core, and its header says it was put there for both shells.
    paneOwnerProject: (id) => paneOwnerProject(id),
    customAgents: () => boot.settings.customAgents(),
    appendBoardLog: (projectId, entry) => boot.appendBoardLog(projectId, entry)
  }
  // The process-lifetime bounded queue: a PERMITTED delivery that refuses only because the target is
  // BUSY is enqueued and answered `queued`, then flushed when that target next goes idle. Its
  // `deliver` is `runDelivery` against these SAME deps, so a flush re-runs the whole gate chain
  // against live state.
  deps.queue = createDeliveryQueue(deps)
  setDeliveryQueue(deps.queue)
  platform().handle(IPC.agentMessageDeliver, async (raw: unknown) => {
    if (!isDeliverRequest(raw))
      return { ok: false, error: 'malformed agent-message request. Do not retry.' }
    const { reply } = await deliverFromControl(raw, deps)
    return reply
  })
  return { deps, onAgentEvent: (event) => onMessagingAgentEvent(event) }
}
