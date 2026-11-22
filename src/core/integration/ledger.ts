// What each INTEGRATION PRINCIPAL owns, durably (docs/integration-principal.md).
//
// The Server Edition's creator ledger (`createHeadlessNodeOwnership`) is deliberately process-local:
// a NODE caller's only cross-restart record would be `project.json`, which is git-shared and
// hand-editable, so it cannot prove who created a node. A principal is different: its identity is a
// registered token, not a node id, and this ledger lives in `<userData>/orchestration-state/` — the
// same trust level as the node-auth secret and the request ledger, written by this process only,
// keyed by the MACHINE-LOCAL project entry id. A cloned repository cannot write it. So for a
// principal, ownership survives a server restart and a VM reboot, and `project.json` is still never
// read as authority (the node's `integration` marker there is display only).
//
// Two facts, two files (core/durable-state.ts):
//   - `integration-nodes`: principal + key → node (and the principal's frames, by title);
//   - `integration-outbox`: how each QUEUED `send` finally ended. A principal has no pane or board
//     log to be told in, so it pulls these through `list`.
import { DurableFactFile, isBoundedString, isFiniteNumber, type DurableFactSpec } from '../durable-state'
import { isSafeNodeId } from '../agents/node-auth-token'
import {
  INTEGRATION_AGENTS,
  isSafeFrameLabel,
  isSafePrincipalKey,
  isSafePrincipalName,
  parseDeclaredPulls,
  INTEGRATION_PULLS_MAX,
  type IntegrationAgent,
  type IntegrationOutboxEntry
} from '../../shared/integration-principal'

export interface IntegrationNodeRecord {
  principal: string
  /** `node`: an agent session. `frame`: a group frame the principal created (`open --group`). */
  kind: 'node' | 'frame'
  /** The caller's key (node) or the frame's title (frame). */
  key: string
  nodeId: string
  /** Machine-local project entry id. */
  projectId: string
  /** node only. Absent on an ADOPTED row whose node runs another agent. */
  agentId?: IntegrationAgent
  /** node only: the node GRANTED itself to the principal (`integration-grant`, a verified node
   *  acting for itself) rather than being opened by it. The principal may send, comment and link PRs
   *  on it; it never closes the node or relaunches its session — `close` ends only the grant. */
  adopted?: true
  /** node only: the conversation id minted at open (resume target after a reboot). */
  agentSessionId?: string
  createdAt: number
  /** node only: tmux `#{session_created}` of the session THIS server freshly spawned (epoch s). The
   *  pane re-proof after a service restart compares the live session's stamp with this. */
  sessionCreated?: number
  state: 'open' | 'closed'
  closedAt?: number
  /** node only, open rows only: pull requests the principal DECLARED on the card (`open.pulls`,
   *  `link-pull`), ascending. A closed row carries none: closing the key drops its links. */
  pulls?: number[]
  /** The board's GitHub repository when `pulls` were declared. A number means nothing in another
   *  repository, so a re-pointed board starts the set over. */
  pullRepository?: string
}

export interface PersistedOutboxEntry extends IntegrationOutboxEntry {
  principal: string
}

const NODE_RECORDS_MAX = 4000
export const OUTBOX_PER_PRINCIPAL = 500
export const OUTBOX_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const CLOSED_ROW_TTL_MS = 30 * 24 * 60 * 60 * 1000
const SESSION_ID_RE = /^[A-Za-z0-9-]{8,128}$/
const REPOSITORY_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/

function sameRepository(a: string | undefined, b: string): boolean {
  return !!a && a.toLocaleLowerCase('en-US') === b.toLocaleLowerCase('en-US')
}

/** A closed row keeps no declared links. */
function withoutPulls(r: IntegrationNodeRecord): void {
  delete r.pulls
  delete r.pullRepository
}

export function sanitizeNodeRecord(raw: unknown): IntegrationNodeRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (!isSafePrincipalName(r.principal)) return null
  if (r.kind !== 'node' && r.kind !== 'frame') return null
  if (r.kind === 'node' ? !isSafePrincipalKey(r.key) : !isSafeFrameLabel(r.key)) return null
  if (typeof r.nodeId !== 'string' || !isSafeNodeId(r.nodeId)) return null
  if (!isBoundedString(r.projectId, 128) || !r.projectId) return null
  if (!isFiniteNumber(r.createdAt)) return null
  if (r.state !== 'open' && r.state !== 'closed') return null
  const out: IntegrationNodeRecord = {
    principal: r.principal,
    kind: r.kind,
    key: r.key as string,
    nodeId: r.nodeId,
    projectId: r.projectId,
    createdAt: r.createdAt,
    state: r.state
  }
  if (r.kind === 'node') {
    const knownAgent = typeof r.agentId === 'string' && (INTEGRATION_AGENTS as readonly string[]).includes(r.agentId)
    if (r.adopted === true) out.adopted = true
    // An opened node always runs one of the principal's agents; an adopted one may run anything.
    else if (!knownAgent) return null
    if (knownAgent) out.agentId = r.agentId as IntegrationAgent
    if (typeof r.agentSessionId === 'string' && SESSION_ID_RE.test(r.agentSessionId)) out.agentSessionId = r.agentSessionId
    if (isFiniteNumber(r.sessionCreated)) out.sessionCreated = r.sessionCreated
    if (r.state === 'open' && typeof r.pullRepository === 'string' && REPOSITORY_RE.test(r.pullRepository)) {
      const pulls = parseDeclaredPulls(r.pulls)
      if (pulls?.length) {
        out.pulls = pulls
        out.pullRepository = r.pullRepository
      }
    }
  }
  if (isFiniteNumber(r.closedAt)) out.closedAt = r.closedAt
  return out
}

export function sanitizeOutboxEntry(raw: unknown): PersistedOutboxEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (!isSafePrincipalName(r.principal) || !isSafePrincipalKey(r.key)) return null
  if (typeof r.nodeId !== 'string' || !isSafeNodeId(r.nodeId)) return null
  if (!isBoundedString(r.sendId, 200) || !r.sendId) return null
  if (!isBoundedString(r.outcome, 64) || !r.outcome) return null
  if (!isFiniteNumber(r.at)) return null
  return { principal: r.principal, key: r.key, nodeId: r.nodeId, sendId: r.sendId, outcome: r.outcome, at: r.at }
}

export const INTEGRATION_NODES_FACT: DurableFactSpec<IntegrationNodeRecord> = {
  kind: 'integration-nodes',
  version: 1,
  maxRecords: NODE_RECORDS_MAX,
  sanitize: sanitizeNodeRecord
}

export const INTEGRATION_OUTBOX_FACT: DurableFactSpec<PersistedOutboxEntry> = {
  kind: 'integration-outbox',
  version: 1,
  maxRecords: OUTBOX_PER_PRINCIPAL * 32,
  sanitize: sanitizeOutboxEntry
}

/**
 * The in-memory ledger over the two files. Every mutation saves (coalesced by the file layer).
 * Uniqueness, enforced on load and on every write: one OPEN node row per (principal, key), one open
 * frame row per (principal, project, title), and a node id belongs to at most one open row.
 */
export class IntegrationLedger {
  private rows: IntegrationNodeRecord[] = []
  private outbox: PersistedOutboxEntry[] = []

  constructor(
    private readonly nodesFile?: Pick<DurableFactFile<IntegrationNodeRecord>, 'load' | 'save'>,
    private readonly outboxFile?: Pick<DurableFactFile<PersistedOutboxEntry>, 'load' | 'save'>,
    private readonly now: () => number = Date.now
  ) {}

  load(): void {
    const seenOpen = new Set<string>()
    const seenNode = new Set<string>()
    const rows: IntegrationNodeRecord[] = []
    // Latest first, so a duplicate keeps the newest open row; the older one is closed.
    for (const r of [...(this.nodesFile?.load() ?? [])].reverse()) {
      const id = this.rowKey(r)
      if (r.state === 'open' && (seenOpen.has(id) || seenNode.has(r.nodeId))) {
        const closed: IntegrationNodeRecord = { ...r, state: 'closed', closedAt: r.closedAt ?? this.now() }
        withoutPulls(closed)
        rows.push(closed)
        continue
      }
      if (r.state === 'open') {
        seenOpen.add(id)
        seenNode.add(r.nodeId)
      }
      rows.push(r)
    }
    this.rows = rows.reverse()
    this.outbox = this.outboxFile?.load() ?? []
    this.prune()
  }

  private rowKey(r: Pick<IntegrationNodeRecord, 'principal' | 'kind' | 'key' | 'projectId'>): string {
    return r.kind === 'node' ? `n|${r.principal}|${r.key}` : `f|${r.principal}|${r.projectId}|${r.key}`
  }

  private prune(): void {
    const now = this.now()
    this.rows = this.rows.filter((r) => r.state === 'open' || now - (r.closedAt ?? r.createdAt) < CLOSED_ROW_TTL_MS)
    this.outbox = this.outbox.filter((e) => now - e.at < OUTBOX_TTL_MS)
  }

  private save(): void {
    this.prune()
    this.nodesFile?.save(this.rows)
  }

  /** The open node row for a key. */
  openNode(principal: string, key: string): IntegrationNodeRecord | undefined {
    return this.rows.find((r) => r.kind === 'node' && r.state === 'open' && r.principal === principal && r.key === key)
  }

  /** The open frame a principal created with this title in this project. */
  openFrame(principal: string, projectId: string, title: string): IntegrationNodeRecord | undefined {
    return this.rows.find(
      (r) => r.kind === 'frame' && r.state === 'open' && r.principal === principal && r.projectId === projectId && r.key === title
    )
  }

  /** Which principal owns this node id (open rows only), or undefined. */
  ownerOf(nodeId: string): IntegrationNodeRecord | undefined {
    return this.rows.find((r) => r.state === 'open' && r.nodeId === nodeId)
  }

  /** Does `principal` own the OPEN agent node `nodeId`? The creator check for its `send`. */
  owns(principal: string, nodeId: string): boolean {
    const r = this.ownerOf(nodeId)
    return !!r && r.kind === 'node' && r.principal === principal
  }

  rowsOf(principal: string, includeClosed: boolean): IntegrationNodeRecord[] {
    return this.rows.filter((r) => r.kind === 'node' && r.principal === principal && (includeClosed || r.state === 'open'))
  }

  /** Every open node row (any principal). */
  openNodes(): IntegrationNodeRecord[] {
    return this.rows.filter((r) => r.kind === 'node' && r.state === 'open')
  }

  /** Record a new open row. Throws if the key (or node id) is already held — callers check first. */
  add(row: IntegrationNodeRecord): void {
    if (row.state !== 'open') throw new Error('integration ledger: add takes an open row')
    if (this.rows.some((r) => r.state === 'open' && (this.rowKey(r) === this.rowKey(row) || r.nodeId === row.nodeId)))
      throw new Error('integration ledger: key or node already held')
    this.rows.push(row)
    this.save()
  }

  update(nodeId: string, patch: Partial<Pick<IntegrationNodeRecord, 'sessionCreated' | 'agentSessionId'>>): void {
    const r = this.ownerOf(nodeId)
    if (!r) return
    Object.assign(r, patch)
    this.save()
  }

  close(nodeId: string): void {
    const r = this.ownerOf(nodeId)
    if (!r) return
    r.state = 'closed'
    r.closedAt = this.now()
    withoutPulls(r)
    this.save()
  }

  /** Close every open row whose node is not in `liveNodeIds` (a person removed it). Answers the ids. */
  closeMissing(isLive: (row: IntegrationNodeRecord) => boolean): string[] {
    const gone: string[] = []
    for (const r of this.rows) {
      if (r.state === 'open' && !isLive(r)) {
        r.state = 'closed'
        r.closedAt = this.now()
        withoutPulls(r)
        gone.push(r.nodeId)
      }
    }
    if (gone.length) this.save()
    return gone
  }

  /**
   * A node GRANTS itself to a principal for a key (`integration-grant`). The caller has already been
   * checked (verified node, principal registered for its project). The latest grant wins:
   *  - the key is open on THIS node, adopted → `already-granted`;
   *  - the key is open on another node, adopted → that row closes and the key MOVES here (its
   *    declared PRs move with it: a restarted lane continues the same work) → `moved`;
   *  - the key is open on a node the principal OPENED → `key-owned`, nothing changes;
   *  - this node already holds another open row (a different key or principal, or it was opened by a
   *    principal) → `node-held`, nothing changes: one open row per node.
   */
  grant(input: {
    principal: string
    key: string
    nodeId: string
    projectId: string
    agentId?: IntegrationAgent
  }): 'granted' | 'already-granted' | 'moved' | 'key-owned' | 'node-held' {
    const existing = this.openNode(input.principal, input.key)
    if (existing && !existing.adopted) return 'key-owned'
    if (existing && existing.nodeId === input.nodeId) return 'already-granted'
    const held = this.ownerOf(input.nodeId)
    if (held) return 'node-held'
    let carried: Pick<IntegrationNodeRecord, 'pulls' | 'pullRepository'> = {}
    if (existing) {
      if (existing.pulls?.length && existing.pullRepository) {
        carried = { pulls: [...existing.pulls], pullRepository: existing.pullRepository }
      }
      existing.state = 'closed'
      existing.closedAt = this.now()
      withoutPulls(existing)
    }
    this.rows.push({
      principal: input.principal,
      kind: 'node',
      key: input.key,
      nodeId: input.nodeId,
      projectId: input.projectId,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      adopted: true,
      createdAt: this.now(),
      state: 'open',
      ...carried
    })
    this.save()
    return existing ? 'moved' : 'granted'
  }

  /** The node ends its own grant. `not-yours` when the key's open adopted row is another node's. */
  revokeGrant(principal: string, key: string, nodeId: string): 'revoked' | 'unknown-key' | 'not-yours' {
    const row = this.openNode(principal, key)
    if (!row || !row.adopted) return 'unknown-key'
    if (row.nodeId !== nodeId) return 'not-yours'
    this.close(row.nodeId)
    return 'revoked'
  }

  /** The open adopted rows of a node. */
  grantsOf(nodeId: string): IntegrationNodeRecord[] {
    return this.rows.filter((r) => r.kind === 'node' && r.state === 'open' && r.adopted && r.nodeId === nodeId)
  }

  /** The pull requests declared on an open node row, for `repository` (another repository's = none). */
  declaredPulls(nodeId: string, repository: string): number[] {
    const r = this.ownerOf(nodeId)
    return r?.kind === 'node' && sameRepository(r.pullRepository, repository) ? [...(r.pulls ?? [])] : []
  }

  /**
   * Adds declared pull requests to an open node row (idempotent). A set recorded for ANOTHER
   * repository is dropped first. 'too-many' (nothing changed) when the union would pass
   * `INTEGRATION_PULLS_MAX`; undefined when there is no open node row.
   */
  declarePulls(nodeId: string, repository: string, add: readonly number[]): number[] | 'too-many' | undefined {
    const r = this.ownerOf(nodeId)
    if (!r || r.kind !== 'node') return undefined
    const current = sameRepository(r.pullRepository, repository) ? r.pulls ?? [] : []
    const next = [...new Set([...current, ...add])].sort((a, b) => a - b)
    if (next.length > INTEGRATION_PULLS_MAX) return 'too-many'
    if (next.length === current.length && r.pullRepository === repository) return next
    if (next.length) {
      r.pulls = next
      r.pullRepository = repository
    } else withoutPulls(r)
    this.save()
    return next
  }

  /** Removes one declared pull request (idempotent). Undefined when there is no open node row. */
  undeclarePull(nodeId: string, repository: string, pull: number): number[] | undefined {
    const r = this.ownerOf(nodeId)
    if (!r || r.kind !== 'node') return undefined
    const current = sameRepository(r.pullRepository, repository) ? r.pulls ?? [] : []
    if (!current.includes(pull)) return [...current]
    const next = current.filter((n) => n !== pull)
    if (next.length) r.pulls = next
    else withoutPulls(r)
    this.save()
    return next
  }

  /** Every open node row of `projectId` that declares pull requests (the board's third link source). */
  declaredForProject(projectId: string): Array<{ nodeId: string; pulls: number[]; repository: string }> {
    return this.rows
      .filter((r) => r.kind === 'node' && r.state === 'open' && r.projectId === projectId && r.pulls?.length && r.pullRepository)
      .map((r) => ({ nodeId: r.nodeId, pulls: [...r.pulls!], repository: r.pullRepository! }))
  }

  recordOutcome(entry: PersistedOutboxEntry): void {
    this.outbox.push(entry)
    // Per-principal bound: drop that principal's oldest.
    const mine = this.outbox.filter((e) => e.principal === entry.principal)
    if (mine.length > OUTBOX_PER_PRINCIPAL) {
      const drop = new Set(mine.slice(0, mine.length - OUTBOX_PER_PRINCIPAL))
      this.outbox = this.outbox.filter((e) => !drop.has(e))
    }
    this.prune()
    this.outboxFile?.save(this.outbox)
  }

  outboxOf(principal: string, since?: number, key?: string): IntegrationOutboxEntry[] {
    return this.outbox
      .filter((e) => e.principal === principal && (since === undefined || e.at > since) && (key === undefined || e.key === key))
      .map(({ principal: _p, ...rest }) => rest)
  }
}

export function openIntegrationLedger(userDataDir: string, opts: { standDown?: boolean } = {}): {
  ledger: IntegrationLedger
  dispose(): void
} {
  const nodesFile = new DurableFactFile(INTEGRATION_NODES_FACT, { userDataDir })
  const outboxFile = new DurableFactFile(INTEGRATION_OUTBOX_FACT, { userDataDir })
  if (opts.standDown) {
    nodesFile.standDown()
    outboxFile.standDown()
  }
  const ledger = new IntegrationLedger(nodesFile, outboxFile)
  ledger.load()
  return {
    ledger,
    dispose: () => {
      nodesFile.dispose()
      outboxFile.dispose()
    }
  }
}
