import fs from 'node:fs'
import path from 'node:path'

import {
  createDeliveryQueue,
  deliverFromControl,
  deliverStationNotice,
  messagingEnabledVia,
  onMessagingAgentEvent,
  ptyPaneProbeDeps,
  restoreDeliveryQueue,
  type AgentMessagingDeps
} from '../core/agents/agent-messaging'
import { paneOwnerProject } from '../core/agents/pane-ownership'
import { StationNoticeMonitor } from '../core/agents/station-notice'
import {
  StationOutcomeStore,
  clearOutcomesAfterControl,
  handleReportOutcome,
  OUTCOME_FACT
} from '../core/station-outcome-store'
import { DurableFactFile } from '../core/durable-state'
import { QUEUE_FACT } from '../core/agents/delivery-queue'
import { HANDOVER_FACT, StationHandoverTracker } from '../core/station-handover'
import { stationRecipientFromOwner } from '../shared/station-notice'
import {
  mirrorEntry,
  nodeState
} from '../core/agent-status-mirror'
import type { BoardLogHandlers } from '../core/board-log-handlers'
import { buildControlShimScript } from '../core/canvas-control-core'
import { syncWindowsShLauncher } from '../core/agents/hooks/install-helper'
import { codexIdentityCaps } from '../core/codex-identity-caps'
import { codexThreadIdentityRoot } from '../core/codex-identity-proxy'
import { claudeCliCaps, type ClaudeCliCaps } from '../core/claude-cli'
import { grokCliCaps } from '../core/grok-cli'
import { codexCliCaps } from '../core/codex-cli'
import type { CodexCliCaps, GrokCliCaps } from '../shared/types'
import { platform } from '../core/platform'
import type { PtyManager } from '../core/pty-manager'
import type { WorkspaceStore } from '../core/workspace-store'
import type { NormalizedAgentEvent } from '../shared/agents/normalize'
import { IPC } from '../shared/ipc'
import type { Project, Settings } from '../shared/types'
import {
  createServerEditionControlHandler,
  type ServerEditionControlActions
} from './control-unsupported'
import { HEADLESS_OWNER_FACT, HeadlessNodeFactory, createHeadlessNodeOwnership } from './headless-node-factory'
import { openIntegrationLedger } from '../core/integration/ledger'
import { PrincipalRegistryReader } from '../core/integration/registry'
import { saveUpload } from '../core/uploads'
import { transcriptPresence } from '../core/transcript-reader'
import { createIntegrationService, type IntegrationHttpReply, type IntegrationRequest } from './integration-service'
import { sendSettledEnvelope } from './settled-envelope'
import { serverSettingsControl } from './settings-control'
import {
  answerGitHubRead,
  resolveGitHubReadProject,
  type GitHubReadDeps
} from '../core/github/control-read'

export interface ServerCanvasControlDeps {
  workspaceStore: WorkspaceStore
  ptyManager: PtyManager
  settings(): Settings
  boardLog: BoardLogHandlers
  cliCaps?: () => Promise<ClaudeCliCaps>
  /** grok's own `--session-id` probe; defaults to the real one. See HeadlessNodeFactoryDeps. */
  grokCaps?: () => Promise<GrokCliCaps>
  codexCaps?: () => Promise<CodexCliCaps>
  /** Test seam for the boot-populated shared Codex capability answer. */
  codexSharedIdentity?: () => Promise<boolean>
  /** The `owner/repo` a project's kanban board syncs with (the GitHub host controller's answer) —
   *  what `open-agent --issue #N` resolves against. Absent = only an explicitly configured
   *  repository counts. See HeadlessNodeFactoryDeps.issueRepository. */
  issueRepository?: (projectId: string) => Promise<string | null>
  /** The GitHub service's cache reads behind `issues` / `prs` (core/github/control-read.ts).
   *  Absent = those verbs answer that the GitHub lane is unavailable here. */
  githubRead?: Pick<GitHubReadDeps, 'snapshot' | 'dispatch'>
  /** An integration principal changed a project's DECLARED pull requests (the GitHub service's
   *  `declaredPullsChanged`: the boards re-read, a single-PR read is started). Absent = boards see
   *  the change on their next poll. */
  onDeclaredPullsChanged?: (projectId: string) => void
  /** Where a project's board stands for PR links (the GitHub host controller's `boardRepository`).
   *  Absent = every project answers `no-repository`. */
  boardRepository?: (projectId: string) => Promise<{ repository: string } | { refused: 'no-repository' }>
  /**
   * Does this process own the hook endpoint (`hookServer.startForApp()` returned no warning)? The
   * durable orchestration facts (queue, station reports, hand-over holds) belong to the owning
   * instance, like the request ledger: a second instance on the same data dir must neither restore
   * them nor overwrite their files. Absent = owns (every test, and a caller that did not ask).
   */
  ownsDurableState?: boolean
}

export interface ServerCanvasControl {
  handler: ReturnType<typeof createServerEditionControlHandler>
  onAgentEvent(event: NormalizedAgentEvent): void
  /** Station-failure notices for the stations agents opened during THIS server run. */
  stationNotices: StationNoticeMonitor
  /** What each station reported about its own task in THIS server run (`report-outcome`). */
  stationOutcomes: StationOutcomeStore
  /** Stations with unfinished handed-over work in THIS server run (plain `--after` holds on them). */
  stationHandovers: StationHandoverTracker
  /** The `/integration/<verb>` handler (docs/integration-principal.md). */
  integration(req: IntegrationRequest): Promise<IntegrationHttpReply>
  /** The pull requests principals declared on a project's cards (the GitHub service's
   *  `setDeclaredPulls` source). Read from the durable integration ledger. */
  declaredPulls(projectId: string): Array<{ nodeId: string; pulls: number[]; repository: string }>
  stop(): void
}

function canvasControlDir(): string {
  return path.join(platform().userDataDir, 'canvas-control')
}

function shimPath(): string {
  return path.join(canvasControlDir(), 'nodeterm.sh')
}

function writeShim(): void {
  const dir = canvasControlDir()
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(shimPath(), buildControlShimScript(codexThreadIdentityRoot()), 'utf8')
  try {
    fs.chmodSync(shimPath(), 0o755)
  } catch {
    /* best effort on filesystems without POSIX modes */
  }
  // The `.cmd` launcher the skill names on a Windows host (skillsFor picks that dialect from this
  // core's platform); a no-op removal on the Linux hosts the Server Edition targets.
  syncWindowsShLauncher(dir, 'nodeterm.sh')
  // Same upgrade sweep as desktop: the POSIX shim replaced this Electron-as-Node script.
  try {
    fs.rmSync(path.join(dir, 'canvas-control-cli.mjs'), { force: true })
  } catch {
    /* best effort */
  }
}

/** The canvas-control shim under the server dataDir (what the canvas skill points at). */
export function serverCanvasShimPath(): string {
  return shimPath()
}

/**
 * Boot the Server Edition canvas runtime.
 *
 * The shim itself always lives under the configured server dataDir, never under a hard-coded
 * `~/.nodeterm-server`. Its discovery skill is the consent lifecycle's (core/agent-integrations.ts,
 * issue #744), which also honours `installHooks: false` as a veto.
 */
export async function initServerCanvasControl(
  deps: ServerCanvasControlDeps
): Promise<ServerCanvasControl> {
  try {
    writeShim()
  } catch (error) {
    // The HTTP runtime remains useful even if discovery files cannot be written; fail open and loud.
    console.warn('[server-canvas-control] shim install failed', error)
  }

  // Station task outcomes: built before the factory, which reads them for `--after-success`.
  // Durable across a server restart, each report bound to the session that made it — the same
  // store, file and rules as the desktop (core/station-outcome-store.ts). The status mirror is
  // already restored (server/index.ts runs `initAgentStatusMirror` first), so load it here.
  const outcomesFile = new DurableFactFile(OUTCOME_FACT, { userDataDir: platform().userDataDir })
  const stationOutcomes = new StationOutcomeStore(
    (records) => platform().broadcast(IPC.stationOutcomeChanged, records),
    {
      durable: outcomesFile,
      sessionOf: (id) => {
        const m = mirrorEntry(id)
        return m ? { sessionId: m.sessionId, agentId: m.agentId } : undefined
      }
    }
  )
  // Stations with unfinished handed-over work (core/station-handover.ts): built before the factory,
  // whose plain `--after` holds on them — the same tracker, fed the same events, as the desktop.
  // Every change re-evaluates the factory's arms: a hold can end on an event `refreshArmed` is not
  // otherwise run for (a SessionEnd clearing a background-subagent hold). `factory` is assigned
  // below, before any event can reach the tracker. Durable like the reports; loaded in the same
  // order as the desktop (reports, hand-overs, queue).
  let factoryRef: HeadlessNodeFactory | undefined
  const handoversFile = new DurableFactFile(HANDOVER_FACT, { userDataDir: platform().userDataDir })
  const stationHandovers = new StationHandoverTracker(
    (records) => {
      platform().broadcast(IPC.stationHandoverChanged, records)
      void factoryRef?.refreshArmed()
    },
    Date.now,
    handoversFile
  )
  if (deps.ownsDurableState === false) {
    outcomesFile.standDown()
    handoversFile.standDown()
  }
  stationOutcomes.loadFromDisk()
  stationHandovers.loadFromDisk()
  // Fork patch #6: who opened which node survives a restart (headless-node-factory.ts
  // `createHeadlessNodeOwnership`). Same ownership rule as the other durable facts.
  const ownersFile = new DurableFactFile(HEADLESS_OWNER_FACT, { userDataDir: platform().userDataDir })
  if (deps.ownsDurableState === false) ownersFile.standDown()
  const factory = new HeadlessNodeFactory({
    ownership: createHeadlessNodeOwnership(ownersFile),
    workspaceStore: deps.workspaceStore,
    ptyManager: deps.ptyManager,
    settings: deps.settings,
    cliCaps: deps.cliCaps ?? claudeCliCaps,
    // grok answers with its own probe — see HeadlessNodeFactoryDeps.grokCaps.
    grokCaps: deps.grokCaps ?? grokCliCaps,
    // …and so does codex, for the same reason: its `--ask-for-approval` vocabulary is its own and
    // it MOVED (see HeadlessNodeFactoryDeps.codexCaps). The Server Edition runs its Codex sessions
    // on this host's `codex`, so this probe is the right authority for them.
    codexCaps: deps.codexCaps ?? codexCliCaps,
    codexSharedIdentity:
      deps.codexSharedIdentity ?? (() => codexIdentityCaps().then((caps) => caps.shared)),
    stateOf: nodeState,
    agentIdOf: (nodeId) => mirrorEntry(nodeId)?.agentId,
    outcomeOf: (nodeId) => stationOutcomes.get(nodeId),
    handedOver: (nodeId) => stationHandovers.isHandedOver(nodeId),
    // NOT `workspaceExternalChange`. That channel means "somebody else wrote this file" and the
    // renderer answers it with `decideExternalChange`, which compares the whole project shell —
    // and `ropes` is part of it, so every headless spawn (one appended `ctrl-…` rope) read as a
    // conflict while the canvas was dirty, which it almost always is mid-burst. The bar that came
    // up suspends autosave, so it latched on, and "Keep my version" then wrote the browser's edge
    // state over the ropes this factory had just persisted. These writes are OURS; the renderer
    // merges them (renderer/lib/serverChange.ts) and is never asked to choose.
    // The CONTENT of each write (nodes, edges) travels separately, as canvas ops the factory casts
    // through the reflector BEFORE every save (its `castAndSave`; no `publishMutation` here = the
    // reflector). On a project the canvas authority governs, only what it heard as ops is written.
    publishProject: (project: Project) => platform().broadcast(IPC.workspaceServerChange, project),
    issueRepository: deps.issueRepository,
    // An issue card's run history lives in the same board log the messaging trace writes to, and
    // `assign` / the column sweep on `close` narrate through it too, so a server-side card move
    // lands in the card's feed exactly like a desktop move.
    appendBoardLog: (projectId, entry) => deps.boardLog.append(projectId, entry)
  })

  factoryRef = factory

  const messaging: AgentMessagingDeps = {
    ...ptyPaneProbeDeps(deps.ptyManager),
    // Server delivery has no renderer/xterm echo stream. Capture the headless pane instead and
    // separate paste from Enter so a fresh TUI cannot swallow the first submit keystroke.
    sendEnvelope: (nodeId, envelope) =>
      sendSettledEnvelope(deps.ptyManager, nodeId, envelope),
    // Attached OR released-but-running: see AgentMessagingDeps.hasLiveSession.
    hasLiveSession: (nodeId) => deps.ptyManager.sessionExists(nodeId),
    mirrorEntry,
    projects: () => deps.workspaceStore.persistedCanvases(),
    isRemoteNode: () => false,
    messagingEnabled: messagingEnabledVia(
      (projectId) => deps.workspaceStore.capabilityProjectFor(projectId),
      // The SAME machine default the desktop reads — this shell's own settings.json.
      () => deps.settings()
    ),
    paneOwnerProject,
    heldLaunch: (projectId, nodeId) => deps.workspaceStore.heldLaunch(projectId, nodeId),
    callerOwnsTarget: (sourceNodeId, targetNodeId) =>
      factory.ownsSpawn(sourceNodeId, targetNodeId),
    customAgents: () => deps.settings().customAgents,
    appendBoardLog: (projectId, entry) => deps.boardLog.append(projectId, entry),
    // A `send` / `reply` hands a station new work when it REACHES the pane (queued ⇒ "work pending"
    // until it lands) — the same rule, and the same store method, as the desktop.
    onHandover: (ev) => {
      stationOutcomes.onHandover(ev)
      stationHandovers.onHandover(ev)
    }
  }
  // Durable, like the desktop's (delivery-queue.ts states what a restart does to a message). The
  // creator ledger is durable too (fork patch #6), so a restored message from an agent to a node it
  // opened can flush after a restart — still only into a pane re-proven by its tmux stamp.
  const queueFile = new DurableFactFile(QUEUE_FACT, { userDataDir: platform().userDataDir })
  if (deps.ownsDurableState === false) queueFile.standDown()
  const queue = createDeliveryQueue(messaging, { durable: queueFile })
  messaging.queue = queue

  // Station-failure notices. The recipient is the CREATOR LEDGER's answer — who opened the station
  // — which is this edition's ownership rule for every verb; durable across a restart (fork patch #6). The pane leg is the same
  // messaging service `send` uses (creator check reversed: the recipient must have opened the
  // station), and the canvas leg is the board log plus a push to every attached browser tab.
  // DROPPED arrives only from a browser tab that shows the node (its liveness check); a server with
  // no tab attached reports errored and long-blocked stations only.
  // Shared with `report-outcome --notify-opener` (#1356): same recipient, same delivery.
  const opener = {
    recipientFor: (stationNodeId: string) =>
      stationRecipientFromOwner(
        deps.workspaceStore.persistedCanvases(),
        stationNodeId,
        factory.openerOf(stationNodeId)
      ),
    deliver: (notice: Parameters<typeof deliverStationNotice>[0]) =>
      deliverStationNotice(notice, messaging)
  }
  // Integration principals (docs/integration-principal.md): a registered local program that owns the
  // nodes it opened through a DURABLE ledger, not through a node of its own. Its `send` rides this
  // same messaging service; the ledger is its creator check, on first attempt and on every flush.
  const integrationLedger = openIntegrationLedger(platform().userDataDir, {
    standDown: deps.ownsDurableState === false
  })
  messaging.principalOwnsTarget = (principal, nodeId) => integrationLedger.ledger.owns(principal, nodeId)
  const integration = createIntegrationService({
    registry: new PrincipalRegistryReader(platform().userDataDir),
    ledger: integrationLedger.ledger,
    factory,
    messaging,
    canvases: () => deps.workspaceStore.persistedCanvases(),
    sessionVerdict: (nodeId) => deps.ptyManager.sessionVerdict(nodeId),
    mirror: (nodeId) => mirrorEntry(nodeId),
    lastTurnErrored: (nodeId) => factory.lastTurnErroredFor(nodeId),
    paneOwnerProject,
    transcriptPresence: (sessionId) => transcriptPresence(sessionId),
    savePrompt: (name, base64) => saveUpload(platform().userDataDir, name, base64),
    boardLogReachable: (projectId) => deps.workspaceStore.boardLogRootForProject(projectId) !== undefined,
    appendBoardLog: (projectId, entry) => deps.boardLog.append(projectId, entry),
    // Whether the board is connected to GitHub, and the repository it syncs with.
    boardRepository: (projectId) =>
      deps.boardRepository?.(projectId) ?? Promise.resolve({ refused: 'no-repository' as const }),
    ...(deps.onDeclaredPullsChanged ? { onPullsChanged: deps.onDeclaredPullsChanged } : {})
  })

  const stationNotices = new StationNoticeMonitor({
    now: () => Date.now(),
    recipientFor: opener.recipientFor,
    pendingQuestionOf: (nodeId) => mirrorEntry(nodeId)?.pendingQuestion?.toolUseId,
    appendBoardLog: (projectId, entry) => deps.boardLog.append(projectId, entry),
    deliver: opener.deliver,
    publish: (views) => platform().broadcast(IPC.stationNoticeChanged, views),
    exists: (nodeId) => deps.workspaceStore.projectIdsForNode(nodeId).length > 0
  })
  stationNotices.start()
  messaging.onQueuedResult = (req, outcome) => {
    stationNotices.onQueuedResult(req, outcome)
    integration.onQueuedResult(req, outcome)
  }
  // Every listener is wired: bring back what the previous run queued.
  await restoreDeliveryQueue(queue, queueFile)

  const actions: ServerEditionControlActions = {
    openProject: (sourceNodeId, args, verified) =>
      factory.openProject(sourceNodeId, args, verified),
    openTerminal: (sourceNodeId, args, verified) =>
      factory.openTerminal(sourceNodeId, args, verified),
    openAgent: (sourceNodeId, args, verified) => factory.openAgent(sourceNodeId, args, verified),
    close: (sourceNodeId, args, verified) => factory.close(sourceNodeId, args, verified),
    link: (sourceNodeId, args, verified) => factory.link(sourceNodeId, args, verified),
    group: (sourceNodeId, args) => factory.group(sourceNodeId, args),
    rename: (sourceNodeId, args) => factory.rename(sourceNodeId, args),
    color: (sourceNodeId, args) => factory.color(sourceNodeId, args),
    sticky: (sourceNodeId, args) => factory.sticky(sourceNodeId, args),
    board: (sourceNodeId, args) => factory.board(sourceNodeId, args),
    assign: (sourceNodeId, args) => factory.assign(sourceNodeId, args),
    run: (sourceNodeId, args, verified) => factory.run(sourceNodeId, args, verified),
    // A station's report about ITSELF (core/station-outcome-store.ts, the same handler the desktop
    // runs). A report can release an armed dependent, so the factory re-evaluates its arms.
    reportOutcome: (sourceNodeId, args, verified) =>
      handleReportOutcome(
        { nodeId: sourceNodeId, args, verified },
        {
          store: stationOutcomes,
          now: () => Date.now(),
          projectIdOfNode: (id) => {
            const ids = deps.workspaceStore.projectIdsForNode(id)
            return ids.length === 1 ? ids[0] : undefined
          },
          appendBoardLog: (projectId, entry) => deps.boardLog.append(projectId, entry),
          onRecorded: () => void factory.refreshArmed(),
          opener
        }
      ),
    // The board's GitHub lane, read-only, from the GitHub service's cache — the same core module the
    // desktop answers with. Own project only: this edition keeps no `open-project` grant ledger.
    githubRead: async (verb, sourceNodeId, args) => {
      const read = deps.githubRead
      if (!read) {
        const msg = `${verb}-unavailable: the GitHub lane is not available on this server. Do not retry.`
        return { ok: false, error: msg, message: msg }
      }
      const ids = deps.workspaceStore.projectIdsForNode(sourceNodeId)
      const resolved = resolveGitHubReadProject({
        verb,
        callerProjectId: ids.length === 1 ? ids[0] : undefined,
        targetProjectId: args.project,
        grantsOtherProjects: false
      })
      if ('refuse' in resolved) return { ok: false, error: resolved.refuse, message: resolved.refuse }
      return answerGitHubRead(verb, resolved.projectId, args, {
        ...read,
        agentState: (id) => nodeState(id),
        now: () => Date.now()
      })
    },
    settings: async (sourceNodeId, args) =>
      serverSettingsControl(
        {
          persistedCanvases: () => deps.workspaceStore.persistedCanvases(),
          capabilityProjectFor: (id) => deps.workspaceStore.capabilityProjectFor(id),
          projectName: (id) => deps.workspaceStore.projectTargetInfo(id)?.name,
          settings: deps.settings
        },
        sourceNodeId,
        args
      ),
    // `runDelivery` applies caller→target creator proof before any pane probe or write, and
    // re-applies it when a queued delivery flushes.
    deliver: async (input) => (await deliverFromControl(input, messaging)).reply
  }

  // Boot deliberately performs no canvas/session adoption: a restored creator row is the right to
  // act on a node, never a reason to start or type into one (`spawnedThisRun`). An owner request or
  // a browser view is the only cold-spawn authority. `start()` only prunes rows of deleted nodes.
  await factory.start()

  const baseHandler = createServerEditionControlHandler(actions)
  return {
    // New work typed into a station by `run` withdraws its older outcome report — the "new task"
    // rule in core/station-outcome-store.ts, applied on the answer. (`send` / `reply` go through
    // `messaging.onHandover` above, which knows when a queued message actually lands.)
    handler: async (req) => {
      // When the request arrived — before `run` typed anything (see core/station-handover.ts).
      const requestAt = Date.now()
      const reply = await baseHandler(req)
      clearOutcomesAfterControl(stationOutcomes, req.verb, req.args, reply, req.nodeId)
      stationHandovers.noteControlAnswer(req.verb, req.args, reply, req.nodeId, requestAt)
      return reply
    },
    onAgentEvent: (event) => {
      // The hand-over tracker FIRST: it stamps turn starts and ends, and both the queue flush and
      // the factory's `refreshArmed` below act on this very event.
      stationHandovers.onAgentEvent(event)
      // A station starting a DIFFERENT session drops its old report before anything reads it.
      stationOutcomes.onAgentEvent(event)
      onMessagingAgentEvent(event, queue)
      factory.onAgentEvent(event)
      stationNotices.onAgentEvent(event)
    },
    stationNotices,
    stationOutcomes,
    stationHandovers,
    integration: (req) => integration.handle(req),
    declaredPulls: (projectId) => integrationLedger.ledger.declaredForProject(projectId),
    stop: () => {
      factory.stop()
      queue.resetForTests()
      stationNotices.stop()
      // Write what the last save window still holds; the next start loads it.
      queueFile.dispose()
      outcomesFile.dispose()
      handoversFile.dispose()
      ownersFile.dispose()
      integrationLedger.dispose()
    }
  }
}
