// The INTEGRATION PRINCIPAL service (docs/integration-principal.md): the `/integration/<verb>` route's
// handler on the Server Edition. A principal is a registered local program — not a node — that opens
// agent sessions, sends them later updates and closes them, keyed by its own opaque key.
//
// Order of every request: authenticate (registry: name + token hash) → validate the body → act on
// the principal's OWN ledger rows only. Nothing here reads `project.json` as authority: ownership is
// the durable integration ledger, the node's `integration` marker is display only.
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { isAbsolute } from 'node:path'

import {
  INTEGRATION_AGENTS,
  INTEGRATION_COMMENT_TEXT_MAX,
  INTEGRATION_MESSAGE_VERB,
  INTEGRATION_PROMPT_MAX,
  INTEGRATION_SEND_TEXT_MAX,
  INTEGRATION_SEND_TTL_MAX_MS,
  INTEGRATION_VERBS,
  isIntegrationVerb,
  isDeclarablePull,
  isSafeFrameLabel,
  isSafePrincipalKey,
  parseDeclaredPulls,
  INTEGRATION_PULLS_MAX,
  type IntegrationAgent,
  type IntegrationCloseResult,
  type IntegrationCommentResult,
  type IntegrationListResult,
  type IntegrationListRow,
  type IntegrationOpenResult,
  type IntegrationPullResult,
  type IntegrationReply,
  type IntegrationResumeResult,
  type IntegrationSendResult
} from '../shared/integration-principal'
import { AGENT_CONFIG, FALLBACK_AGENT_COLOR, type BuiltinAgentId } from '../shared/agents/config'
import { LAUNCH_PROMPT_FILE_PREFIX } from '../shared/launch-prompt'
import { sanitizeChatText } from '../shared/mobile-chat'
import { commentSegments } from '../shared/board-comment'
import { BOARD_LOG_TEXT_MAX, type BoardLogEntry } from '../shared/types'
import { deliverIntegrationMessage, type AgentMessagingDeps } from '../core/agents/agent-messaging'
import type { AgentMessageOutcome } from '../core/agents/agent-message-decide'
import type { QueuedDeliveryRequest } from '../core/agents/delivery-queue'
import type { IntegrationLedger, IntegrationNodeRecord } from '../core/integration/ledger'
import type { PrincipalEntry, PrincipalRegistryReader } from '../core/integration/registry'
import type { HeadlessNodeFactory } from './headless-node-factory'

export interface IntegrationServiceDeps {
  registry: Pick<PrincipalRegistryReader, 'authenticate'>
  ledger: IntegrationLedger
  factory: Pick<HeadlessNodeFactory, 'principalOpen' | 'principalResume' | 'principalClose' | 'holdsSession'>
  messaging: AgentMessagingDeps
  /** The saved canvases (`workspaceStore.persistedCanvases()`): node existence and parents. */
  canvases(): readonly { id: string; nodes: readonly { id: string; parentId?: string }[] }[]
  sessionVerdict(nodeId: string): Promise<'present' | 'absent' | 'unknown'>
  mirror(nodeId: string): { state?: string; sessionId?: string; agentId?: string } | undefined
  /** Has this node's last turn ended on an error (the factory's own event stream)? Optional. */
  lastTurnErrored?(nodeId: string): boolean
  paneOwnerProject(nodeId: string): string | undefined
  transcriptPresence(sessionId: string): Promise<'present' | 'absent' | 'unknown'>
  /** Write a launch prompt file; the path, or null. Production: core `saveUpload`. */
  savePrompt(name: string, base64: string): Promise<string | null>
  isDirectory?(path: string): Promise<boolean>
  /** Does this project have a board log this server can write (a local folder)? Production:
   *  `workspaceStore.boardLogRootForProject(id) !== undefined`. */
  boardLogReachable(projectId: string): boolean
  /** Append one entry to a project's board log (the shared `boardLog.append`); false on failure. */
  appendBoardLog(projectId: string, entry: BoardLogEntry): Promise<boolean>
  /** The GitHub repository (`owner/name`) declared pull numbers are recorded against: the board's
   *  configured repository, else the project's git remote; or `no-repository`. The board need not be
   *  synced with GitHub. Production: the GitHub host controller (no credential). */
  boardRepository(projectId: string): Promise<{ repository: string } | { refused: 'no-repository' }>
  /** A key's declared pull requests changed: the project's open boards re-read. */
  onPullsChanged?(projectId: string): void
  now?(): number
}

export interface IntegrationRequest {
  verb: string
  name: unknown
  token: unknown
  body: string
}

export interface IntegrationHttpReply {
  status: number
  body: IntegrationReply<unknown>
}

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,127}$/
const TITLE_BAD = /[\p{Cc}\p{Cf}]/u
const SEND_TTL_MIN_MS = 1000
/** ALM, LRM/RLM, embeddings/overrides and isolates (the set `shared/presence.ts` strips from names). */
const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g

function fail(status: number, error: string, message: string, extra: { retryAfterMs?: number } = {}): IntegrationHttpReply {
  return { status, body: { ok: false, error, message, ...extra } }
}

function ok<T>(result: T): IntegrationHttpReply {
  return { status: 200, body: { ok: true, result } }
}

const ACCEPTED: ReadonlySet<string> = new Set(['delivered', 'stalled', 'queued'])

async function defaultIsDirectory(path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).isDirectory()
  } catch {
    return false
  }
}

export function createIntegrationService(deps: IntegrationServiceDeps): {
  handle(req: IntegrationRequest): Promise<IntegrationHttpReply>
  /** Wire as part of `AgentMessagingDeps.onQueuedResult`: files a queued send's end in the outbox. */
  onQueuedResult(req: QueuedDeliveryRequest, outcome: AgentMessageOutcome): void
} {
  const now = deps.now ?? Date.now
  const isDirectory = deps.isDirectory ?? defaultIsDirectory
  /** One operation per (principal, key) at a time: two concurrent opens of a key make one node. */
  const keyLocks = new Map<string, Promise<unknown>>()
  const withKeyLock = <T>(id: string, fn: () => Promise<T>): Promise<T> => {
    const prev = keyLocks.get(id) ?? Promise.resolve()
    const run = prev.then(fn, fn)
    const tail = run.then(() => undefined, () => undefined)
    keyLocks.set(id, tail)
    void tail.then(() => {
      if (keyLocks.get(id) === tail) keyLocks.delete(id)
    })
    return run
  }

  const nodeOnCanvas = (projectId: string, nodeId: string): { id: string; parentId?: string } | undefined =>
    deps.canvases().find((c) => c.id === projectId)?.nodes.find((n) => n.id === nodeId)

  /** The open row for a key, closing it first if a person removed its node. */
  const liveRow = (principal: string, key: string): IntegrationNodeRecord | undefined => {
    const row = deps.ledger.openNode(principal, key)
    if (row && !nodeOnCanvas(row.projectId, row.nodeId)) {
      deps.ledger.close(row.nodeId)
      return undefined
    }
    return row
  }

  const parseBody = (text: string): Record<string, unknown> | null => {
    if (!text.trim()) return {}
    try {
      const v = JSON.parse(text) as unknown
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
    } catch {
      return null
    }
  }

  type Refusal = 'no-repository'
  const repositoryOf = (projectId: string): Promise<{ repository: string } | { refused: Refusal }> =>
    deps.boardRepository(projectId).then(
      (r) => ('repository' in r && typeof r.repository === 'string' && r.repository ? r : { refused: 'refused' in r ? r.refused : 'no-repository' }),
      () => ({ refused: 'no-repository' as const })
    )

  const refusedRepository = (projectId: string, _refused: Refusal): IntegrationHttpReply =>
    fail(409, 'no-repository', `project ${projectId} has no GitHub repository (no board repository and no GitHub git remote) to link pull requests in`)

  const tooManyPulls = (): IntegrationHttpReply =>
    fail(409, 'too-many-pulls', `a key declares at most ${INTEGRATION_PULLS_MAX} pull requests`)

  /** Unions `pulls` into the key's declared set for `open`. Ignored (never refused) without a
   *  repository. */
  const declareOnOpen = async (
    nodeId: string,
    projectId: string,
    pulls: number[]
  ): Promise<{ pulls: number[]; pullsIgnored?: Refusal } | 'too-many'> => {
    const answer = await repositoryOf(projectId)
    if ('refused' in answer) return { pulls: [], pullsIgnored: answer.refused }
    const repository = answer.repository
    const before = deps.ledger.declaredPulls(nodeId, repository)
    const next = deps.ledger.declarePulls(nodeId, repository, pulls)
    if (next === 'too-many') return 'too-many'
    const after = next ?? []
    if (after.join(',') !== before.join(',')) deps.onPullsChanged?.(projectId)
    return { pulls: after }
  }

  const unknownKey = (key: string): IntegrationHttpReply =>
    fail(404, 'unknown-key', `no open node for key ${key} (never opened, closed, or removed from the canvas)`)

  async function open(p: PrincipalEntry, b: Record<string, unknown>): Promise<IntegrationHttpReply> {
    if (!isSafePrincipalKey(b.key)) return fail(400, 'bad-key', 'key: 1-64 characters of A-Z a-z 0-9 . _ : # / -, starting with a letter or digit')
    const key = b.key
    if (typeof b.agent !== 'string' || !(INTEGRATION_AGENTS as readonly string[]).includes(b.agent))
      return fail(400, 'bad-agent', `agent: one of ${INTEGRATION_AGENTS.join(', ')}`)
    const agent = b.agent as IntegrationAgent
    if (b.project !== undefined && (typeof b.project !== 'string' || !p.projects.includes(b.project)))
      return fail(403, 'project-not-registered', `project: one of this principal's registered projects (${p.projects.join(', ')})`)
    const projectId = (b.project as string | undefined) ?? p.projects[0]
    if (b.cwd !== undefined && (typeof b.cwd !== 'string' || !isAbsolute(b.cwd) || b.cwd.length > 4096 || !(await isDirectory(b.cwd))))
      return fail(400, 'bad-cwd', 'cwd: an absolute path to an existing directory')
    if (b.prompt !== undefined && (typeof b.prompt !== 'string' || b.prompt.length > INTEGRATION_PROMPT_MAX))
      return fail(400, 'bad-prompt', `prompt: a string of at most ${INTEGRATION_PROMPT_MAX} characters`)
    if (b.model !== undefined && (typeof b.model !== 'string' || !MODEL_RE.test(b.model)))
      return fail(400, 'bad-model', 'model: a model id (letters, digits and . _ : / @ [ ] -)')
    if (b.group !== undefined && !isSafeFrameLabel(b.group))
      return fail(400, 'bad-group', 'group: one printable line of at most 48 characters')
    if (b.title !== undefined && (typeof b.title !== 'string' || !b.title.trim() || b.title.length > 120 || TITLE_BAD.test(b.title)))
      return fail(400, 'bad-title', 'title: one printable line of at most 120 characters')
    if (b.column !== undefined && (typeof b.column !== 'string' || !b.column.trim() || b.column.length > 48 || TITLE_BAD.test(b.column)))
      return fail(400, 'bad-column', 'column: one printable line of at most 48 characters')
    const pulls = b.pulls === undefined ? undefined : parseDeclaredPulls(b.pulls)
    if (pulls === null) return fail(400, 'bad-pull', `pulls: at most ${INTEGRATION_PULLS_MAX} pull request numbers (positive integers)`)

    return withKeyLock(`${p.name}|${key}`, async () => {
      const existing = liveRow(p.name, key)
      if (existing) {
        const declared = pulls ? await declareOnOpen(existing.nodeId, existing.projectId, pulls) : undefined
        if (declared === 'too-many') return tooManyPulls()
        const result: IntegrationOpenResult = {
          key,
          nodeId: existing.nodeId,
          projectId: existing.projectId,
          status: 'existing',
          ...(declared ?? {})
        }
        return ok(result)
      }
      let promptFile: string | undefined
      if (typeof b.prompt === 'string' && b.prompt.trim()) {
        const saved = await deps.savePrompt(
          `${LAUNCH_PROMPT_FILE_PREFIX}${randomUUID()}.md`,
          Buffer.from(b.prompt, 'utf8').toString('base64')
        )
        if (!saved) return fail(500, 'prompt-not-saved', 'the prompt file could not be written; nothing was opened')
        promptFile = saved
      }
      let frame: { id: string } | { title: string } | undefined
      if (typeof b.group === 'string') {
        const f = deps.ledger.openFrame(p.name, projectId, b.group)
        if (f && nodeOnCanvas(projectId, f.nodeId)) frame = { id: f.nodeId }
        else {
          if (f) deps.ledger.close(f.nodeId)
          frame = { title: b.group }
        }
      }
      const title = typeof b.title === 'string' ? b.title.trim() : `${key} · ${AGENT_CONFIG[agent as BuiltinAgentId].label}`
      const opened = await deps.factory.principalOpen(
        {
          principal: p.name,
          label: p.label,
          key,
          projectId,
          agent: agent as BuiltinAgentId,
          title,
          ...(p.color ? { color: p.color } : {}),
          ...(typeof b.cwd === 'string' ? { cwd: b.cwd } : {}),
          ...(promptFile ? { promptFile } : {}),
          ...(typeof b.model === 'string' ? { model: b.model } : {}),
          ...(frame ? { frame } : {}),
          ...(typeof b.column === 'string' ? { column: b.column } : {})
        },
        (r) => {
          const at = now()
          if (r.frameCreated && r.frameId && typeof b.group === 'string')
            deps.ledger.add({ principal: p.name, kind: 'frame', key: b.group, nodeId: r.frameId, projectId, createdAt: at, state: 'open' })
          deps.ledger.add({
            principal: p.name,
            kind: 'node',
            key,
            nodeId: r.nodeId,
            projectId,
            agentId: agent,
            ...(r.agentSessionId ? { agentSessionId: r.agentSessionId } : {}),
            createdAt: at,
            state: 'open'
          })
        }
      )
      if (!opened.ok) return fail(opened.error === 'not-saved' || opened.error === 'stopping' ? 503 : 409, opened.error, opened.message)
      if (opened.sessionCreated !== undefined) deps.ledger.update(opened.nodeId, { sessionCreated: opened.sessionCreated })
      // A fresh key: at most INTEGRATION_PULLS_MAX by validation, so it cannot overflow.
      const declared = pulls ? await declareOnOpen(opened.nodeId, projectId, pulls) : undefined
      const result: IntegrationOpenResult = {
        key,
        nodeId: opened.nodeId,
        projectId,
        status: 'created',
        session: opened.session,
        ...(opened.reason ? { reason: opened.reason } : {}),
        ...(opened.frameId ? { frameId: opened.frameId } : {}),
        ...(opened.column !== undefined ? { column: opened.column } : {}),
        ...(declared && declared !== 'too-many' ? declared : {})
      }
      return ok(result)
    })
  }

  async function resume(p: PrincipalEntry, b: Record<string, unknown>): Promise<IntegrationHttpReply> {
    if (!isSafePrincipalKey(b.key)) return fail(400, 'bad-key', 'key: required')
    const key = b.key
    return withKeyLock(`${p.name}|${key}`, async () => {
      const row = deps.ledger.openNode(p.name, key)
      if (!row) return unknownKey(key)
      // A node that granted itself is not the principal's to relaunch: its lifecycle stays with
      // whoever opened it.
      if (row.adopted) return fail(409, 'adopted-node', `key ${key} is a node that granted itself to this principal; resume is for nodes the principal opened`)
      const r = await deps.factory.principalResume({
        projectId: row.projectId,
        nodeId: row.nodeId,
        agent: row.agentId as BuiltinAgentId,
        agentSessionId: row.agentSessionId ?? deps.mirror(row.nodeId)?.sessionId,
        sessionCreated: row.sessionCreated,
        transcriptPresence: (sid) => deps.transcriptPresence(sid)
      })
      if (!r.ok) {
        if (r.error === 'node-missing') deps.ledger.close(row.nodeId)
        return fail(r.error === 'stopping' ? 503 : 409, r.error, r.message)
      }
      const patch: { sessionCreated?: number; agentSessionId?: string } = {}
      if (r.sessionCreated !== undefined) patch.sessionCreated = r.sessionCreated
      if (r.agentSessionId) patch.agentSessionId = r.agentSessionId
      if (Object.keys(patch).length) deps.ledger.update(row.nodeId, patch)
      const result: IntegrationResumeResult = { key, nodeId: row.nodeId, outcome: r.outcome, ...(r.reason ? { reason: r.reason } : {}) }
      return ok(result)
    })
  }

  async function send(p: PrincipalEntry, b: Record<string, unknown>): Promise<IntegrationHttpReply> {
    if (!isSafePrincipalKey(b.key)) return fail(400, 'bad-key', 'key: required')
    if (typeof b.text !== 'string' || !b.text.trim() || b.text.length > INTEGRATION_SEND_TEXT_MAX)
      return fail(400, 'bad-text', `text: a non-empty string of at most ${INTEGRATION_SEND_TEXT_MAX} characters`)
    if (b.queue !== undefined && typeof b.queue !== 'boolean') return fail(400, 'bad-queue', 'queue: true or false')
    if (b.ttlMs !== undefined && (typeof b.ttlMs !== 'number' || !Number.isFinite(b.ttlMs)))
      return fail(400, 'bad-ttl', 'ttlMs: a number of milliseconds')
    const row = liveRow(p.name, b.key)
    if (!row) return unknownKey(b.key)
    const ttlMs =
      typeof b.ttlMs === 'number' ? Math.min(INTEGRATION_SEND_TTL_MAX_MS, Math.max(SEND_TTL_MIN_MS, Math.round(b.ttlMs))) : undefined
    const sendId = randomUUID()
    const { outcome, reply } = await deliverIntegrationMessage(
      {
        verb: INTEGRATION_MESSAGE_VERB,
        principal: p.name,
        label: p.label,
        projectId: row.projectId,
        targetNodeId: row.nodeId,
        body: sanitizeChatText(b.text),
        sendId
      },
      deps.messaging,
      { queue: b.queue !== false, ...(ttlMs !== undefined ? { ttlMs } : {}) }
    )
    const o = outcome as AgentMessageOutcome & { traceId?: string; retryAfterMs?: number; reason?: string }
    const result: IntegrationSendResult = {
      key: row.key,
      nodeId: row.nodeId,
      sendId,
      outcome: outcome.kind,
      accepted: ACCEPTED.has(outcome.kind),
      ...(typeof o.traceId === 'string' ? { traceId: o.traceId } : {}),
      message: reply.ok ? reply.message ?? outcome.kind : reply.error ?? outcome.kind,
      ...(typeof o.retryAfterMs === 'number' ? { retryAfterMs: o.retryAfterMs } : {}),
      ...(outcome.kind === 'notPermitted' && typeof o.reason === 'string' ? { reason: o.reason } : {})
    }
    return ok(result)
  }

  async function close(p: PrincipalEntry, b: Record<string, unknown>): Promise<IntegrationHttpReply> {
    if (!isSafePrincipalKey(b.key)) return fail(400, 'bad-key', 'key: required')
    const key = b.key
    return withKeyLock(`${p.name}|${key}`, async () => {
      const row = deps.ledger.openNode(p.name, key)
      if (!row) return unknownKey(key)
      // An adopted node: end the grant only. The node and its session stay with whoever opened it.
      if (row.adopted) {
        deps.ledger.close(row.nodeId)
        const result: IntegrationCloseResult = { key, nodeId: row.nodeId, closed: true, adopted: true }
        return ok(result)
      }
      const parentId = nodeOnCanvas(row.projectId, row.nodeId)?.parentId
      const frameRow = parentId ? deps.ledger.ownerOf(parentId) : undefined
      const frameId = frameRow && frameRow.kind === 'frame' && frameRow.principal === p.name ? frameRow.nodeId : undefined
      const r = await deps.factory.principalClose({ projectId: row.projectId, nodeId: row.nodeId, ...(frameId ? { frameId } : {}) })
      if (!r.ok) return fail(503, r.error, r.message)
      deps.ledger.close(row.nodeId)
      if (r.frameRemoved && frameId) deps.ledger.close(frameId)
      const result: IntegrationCloseResult = { key, nodeId: row.nodeId, closed: true, ...(r.nodeMissing ? { nodeMissing: true } : {}) }
      return ok(result)
    })
  }

  /**
   * `comment`: one display-only note on the card of the key's node, authored as the principal. It is
   * the same `kind: 'comment'` entry a person's card comment writes, but it is never delivered into
   * the session: only the board composer's own send starts a delivery (see shared/board-comment.ts),
   * and a mention token in the text is flattened to plain `@label` text so the note cannot even look
   * like one.
   */
  async function comment(p: PrincipalEntry, b: Record<string, unknown>): Promise<IntegrationHttpReply> {
    if (!isSafePrincipalKey(b.key)) return fail(400, 'bad-key', 'key: required')
    if (typeof b.text !== 'string' || b.text.length > INTEGRATION_COMMENT_TEXT_MAX)
      return fail(400, 'bad-text', `text: a non-empty string of at most ${INTEGRATION_COMMENT_TEXT_MAX} characters`)
    // Controls (except \n / \t) and bidi overrides go: a note must render as it reads.
    // Flatten to a fixpoint: flattening an inner token can complete an outer one
    // (`@[@[x](node:a)](node:b)` → `@[@x](node:b)`). Each pass shortens the text, so this ends.
    let flat = sanitizeChatText(b.text).replace(BIDI_CONTROLS, '')
    for (;;) {
      const next = commentSegments(flat)
        .map((seg) => (seg.kind === 'text' ? seg.text : `@${seg.label.trim() || seg.nodeId}`))
        .join('')
      if (next === flat) break
      flat = next
    }
    if (!flat.trim()) return fail(400, 'bad-text', 'text: must contain something besides whitespace and control characters')
    const text = flat.length > BOARD_LOG_TEXT_MAX ? flat.slice(0, BOARD_LOG_TEXT_MAX) + '…' : flat
    const row = liveRow(p.name, b.key)
    if (!row) return unknownKey(b.key)
    if (!deps.boardLogReachable(row.projectId))
      return fail(409, 'board-log-unavailable', `project ${row.projectId} has no board log this server can write (no local folder)`)
    const commentId = randomUUID()
    const entry: BoardLogEntry = {
      id: commentId,
      ts: now(),
      author: { name: p.label || p.name, color: p.color ?? FALLBACK_AGENT_COLOR },
      nodeId: row.nodeId,
      kind: 'comment',
      text
    }
    const saved = await deps.appendBoardLog(row.projectId, entry).catch(() => false)
    if (!saved) return fail(500, 'comment-not-saved', 'the board log could not be written; nothing was posted')
    const result: IntegrationCommentResult = { key: row.key, nodeId: row.nodeId, commentId }
    return ok(result)
  }

  /**
   * `link-pull` / `unlink-pull`: add or remove one DECLARED pull request on the key's card. Both are
   * idempotent and answer the key's whole declared set. The links live in this server's durable
   * integration ledger (never in project.json) and reach the board through the pull status the host
   * already serves; a person's unlink on the card still wins.
   */
  async function changePull(p: PrincipalEntry, b: Record<string, unknown>, add: boolean): Promise<IntegrationHttpReply> {
    if (!isSafePrincipalKey(b.key)) return fail(400, 'bad-key', 'key: required')
    if (!isDeclarablePull(b.pull)) return fail(400, 'bad-pull', 'pull: a pull request number (a positive integer)')
    const key = b.key
    const pull = b.pull
    return withKeyLock(`${p.name}|${key}`, async () => {
      const row = liveRow(p.name, key)
      if (!row) return unknownKey(key)
      const answer = await repositoryOf(row.projectId)
      if ('refused' in answer) return refusedRepository(row.projectId, answer.refused)
      const repository = answer.repository
      const before = deps.ledger.declaredPulls(row.nodeId, repository)
      const next = add
        ? deps.ledger.declarePulls(row.nodeId, repository, [pull])
        : deps.ledger.undeclarePull(row.nodeId, repository, pull)
      if (next === 'too-many') return tooManyPulls()
      if (next === undefined) return unknownKey(key)
      if (next.join(',') !== before.join(',')) deps.onPullsChanged?.(row.projectId)
      const result: IntegrationPullResult = { key, nodeId: row.nodeId, pulls: next }
      return ok(result)
    })
  }

  async function list(p: PrincipalEntry, b: Record<string, unknown>): Promise<IntegrationHttpReply> {
    if (b.key !== undefined && !isSafePrincipalKey(b.key)) return fail(400, 'bad-key', 'key: a key, or omit it')
    if (b.includeClosed !== undefined && typeof b.includeClosed !== 'boolean') return fail(400, 'bad-include-closed', 'includeClosed: true or false')
    if (b.outboxSince !== undefined && (typeof b.outboxSince !== 'number' || !Number.isFinite(b.outboxSince)))
      return fail(400, 'bad-outbox-since', 'outboxSince: a ms epoch number')
    const key = b.key as string | undefined
    const rows: IntegrationListRow[] = []
    for (const r of deps.ledger.rowsOf(p.name, b.includeClosed === true)) {
      if (key !== undefined && r.key !== key) continue
      const base: IntegrationListRow = {
        key: r.key,
        nodeId: r.nodeId,
        projectId: r.projectId,
        ...(r.agentId ? { agent: r.agentId } : {}),
        ...(r.adopted ? { adopted: true as const } : {}),
        ...(r.agentSessionId ? { agentSessionId: r.agentSessionId } : {}),
        state: r.state,
        createdAt: r.createdAt,
        ...(r.closedAt !== undefined ? { closedAt: r.closedAt } : {})
      }
      if (r.state === 'open') {
        if (!nodeOnCanvas(r.projectId, r.nodeId)) {
          base.nodeMissing = true
        } else {
          const verdict = await deps.sessionVerdict(r.nodeId).catch(() => 'unknown' as const)
          base.session = verdict === 'present' ? 'live' : verdict
          base.attached = deps.factory.holdsSession(r.nodeId)
          base.paneProven = deps.paneOwnerProject(r.nodeId) === r.projectId
          const m = deps.mirror(r.nodeId)
          base.agentState = m?.state ?? 'unknown'
          base.needsYou = m?.state === 'waiting' || m?.state === 'blocked'
          if (deps.lastTurnErrored) base.lastTurnError = deps.lastTurnErrored(r.nodeId)
        }
        base.pulls = [...(r.pulls ?? [])]
      }
      rows.push(base)
    }
    const result: IntegrationListResult = {
      rows,
      outbox: deps.ledger.outboxOf(p.name, b.outboxSince as number | undefined, key)
    }
    return ok(result)
  }

  return {
    async handle(req) {
      const principal = deps.registry.authenticate(req.name, req.token)
      // One flat refusal: no hint whether the name exists or the token was wrong.
      if (!principal) return fail(403, 'unauthorized', 'integration refused')
      if (!isIntegrationVerb(req.verb)) return fail(404, 'unknown-verb', `verbs: ${INTEGRATION_VERBS.join(', ')}`)
      const body = parseBody(req.body)
      if (!body) return fail(400, 'bad-body', 'the body must be a JSON object')
      switch (req.verb) {
        case 'open':
          return open(principal, body)
        case 'resume':
          return resume(principal, body)
        case 'send':
          return send(principal, body)
        case 'close':
          return close(principal, body)
        case 'list':
          return list(principal, body)
        case 'comment':
          return comment(principal, body)
        case 'link-pull':
          return changePull(principal, body, true)
        case 'unlink-pull':
          return changePull(principal, body, false)
      }
    },
    onQueuedResult(req, outcome) {
      if (req.verb !== INTEGRATION_MESSAGE_VERB) return
      const principal = typeof req.principal === 'string' ? req.principal : undefined
      const sendId = typeof req.sendId === 'string' ? req.sendId : undefined
      if (!principal || !sendId) return
      // Any state: a message may end after its key was closed, and its sender still asks.
      const key = deps.ledger.rowsOf(principal, true).find((r) => r.nodeId === req.targetNodeId)?.key
      if (!key) return
      deps.ledger.recordOutcome({ principal, sendId, key, nodeId: req.targetNodeId, outcome: outcome.kind, at: now() })
    }
  }
}
