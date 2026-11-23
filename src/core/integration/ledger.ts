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
import {
  INTEGRATION_JIRA_MAX,
  mergeJiraCards,
  sanitizeJiraTicketLinks,
  upsertJiraTickets,
  type JiraCardLinks,
  type JiraTicketInput,
  type JiraTicketLink
} from '../../shared/integration-jira'

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
  /** node only, open rows only: Jira tickets the principal DECLARED on the card (`open.jira`,
   *  `link-jira`), with the status and summary it pushed, in declaration order. */
  jira?: JiraTicketLink[]
}

export interface PersistedOutboxEntry extends IntegrationOutboxEntry {
  principal: string
}

const NODE_RECORDS_MAX = 4000
/** A node may hold at most this many open grants (adopted rows). */
export const GRANTS_PER_NODE_MAX = 50
export const OUTBOX_PER_PRINCIPAL = 500
export const OUTBOX_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const CLOSED_ROW_TTL_MS = 30 * 24 * 60 * 60 * 1000
const SESSION_ID_RE = /^[A-Za-z0-9-]{8,128}$/
const REPOSITORY_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/

function sameRepository(a: string | undefined, b: string): boolean {
  return !!a && a.toLocaleLowerCase('en-US') === b.toLocaleLowerCase('en-US')
}

/** An emptied pull request set: the Jira tickets stay. */
function withoutPulls(r: IntegrationNodeRecord): void {
  delete r.pulls
  delete r.pullRepository
}

/** A closed row keeps no declared links (pull requests or Jira tickets). */
function withoutLinks(r: IntegrationNodeRecord): void {
  delete r.pulls
  delete r.pullRepository
  delete r.jira
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
    if (r.state === 'open') {
      const jira = sanitizeJiraTicketLinks(r.jira)
      if (jira.length) out.jira = jira
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
  private onNodesChanged?: () => void

  constructor(
    private readonly nodesFile?: Pick<DurableFactFile<IntegrationNodeRecord>, 'load' | 'save'>,
    private readonly outboxFile?: Pick<DurableFactFile<PersistedOutboxEntry>, 'load' | 'save'>,
    private readonly now: () => number = Date.now
  ) {}

  load(): void {
    const seenOpen = new Set<string>()
    const seenNode = new Set<string>()
    const ownedNode = new Set<string>()
    const rows: IntegrationNodeRecord[] = []
    // Latest first, so a duplicate keeps the newest open row; the older one is closed.
    for (const r of [...(this.nodesFile?.load() ?? [])].reverse()) {
      const id = this.rowKey(r)
      // A node holds at most one row it does not merely ADOPT (an opened node, a frame); adopted rows
      // (grants) may share a node with each other, never with an owning row.
      const nodeTaken = r.adopted ? ownedNode.has(r.nodeId) : seenNode.has(r.nodeId)
      if (r.state === 'open' && (seenOpen.has(id) || nodeTaken)) {
        const closed: IntegrationNodeRecord = { ...r, state: 'closed', closedAt: r.closedAt ?? this.now() }
        withoutLinks(closed)
        rows.push(closed)
        continue
      }
      if (r.state === 'open') {
        seenOpen.add(id)
        seenNode.add(r.nodeId)
        if (!r.adopted) ownedNode.add(r.nodeId)
      }
      rows.push(r)
    }
    // An owning row read after (older than) a grant on the same node still wins: close those grants.
    for (const r of rows) {
      if (r.state === 'open' && r.adopted && ownedNode.has(r.nodeId)) {
        r.state = 'closed'
        r.closedAt = r.closedAt ?? this.now()
        withoutLinks(r)
      }
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
    try {
      this.onNodesChanged?.()
    } catch {
      // A listener's failure must not fail the write that already happened.
    }
  }

  /** Called after every change to the node rows (open, close, grant, declarations). */
  setOnChange(fn: (() => void) | undefined): void {
    this.onNodesChanged = fn
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

  /** The open row that OWNS this node id — a node or frame a principal opened — or undefined. A
   *  grant (an adopted row) never owns its node. */
  ownerOf(nodeId: string): IntegrationNodeRecord | undefined {
    return this.rows.find((r) => r.state === 'open' && r.nodeId === nodeId && !r.adopted)
  }

  /**
   * The creator check for a principal's `send`: may `principal` deliver into the agent node `nodeId`?
   * With `key`, only that key's open row counts — a node may hold several grants, and revoking one
   * must stop that key's queued sends even while the node still holds others.
   */
  owns(principal: string, nodeId: string, key?: string): boolean {
    if (key !== undefined) {
      const r = this.openNode(principal, key)
      return !!r && r.nodeId === nodeId
    }
    return this.rows.some(
      (r) => r.kind === 'node' && r.state === 'open' && r.principal === principal && r.nodeId === nodeId
    )
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

  /** Close a row: the given row, or the row that OWNS a node id (an opened node or a frame). */
  close(target: string | IntegrationNodeRecord): void {
    const r = typeof target === 'string' ? this.ownerOf(target) : this.rows.includes(target) && target.state === 'open' ? target : undefined
    if (!r) return
    r.state = 'closed'
    r.closedAt = this.now()
    withoutLinks(r)
    this.save()
  }

  /** Close every open row whose node is not in `liveNodeIds` (a person removed it). Answers the ids. */
  closeMissing(isLive: (row: IntegrationNodeRecord) => boolean): string[] {
    const gone: string[] = []
    for (const r of this.rows) {
      if (r.state === 'open' && !isLive(r)) {
        r.state = 'closed'
        r.closedAt = this.now()
        withoutLinks(r)
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
   *  - this node was OPENED by a principal → `node-held`, nothing changes (a node may hold many grants,
   *    of any principals and keys, but not beside an owning row);
   *  - this node already holds `GRANTS_PER_NODE_MAX` grants → `too-many-grants`.
   */
  grant(input: {
    principal: string
    key: string
    nodeId: string
    projectId: string
    agentId?: IntegrationAgent
  }): 'granted' | 'already-granted' | 'moved' | 'key-owned' | 'node-held' | 'too-many-grants' {
    const existing = this.openNode(input.principal, input.key)
    if (existing && !existing.adopted) return 'key-owned'
    if (existing && existing.nodeId === input.nodeId) return 'already-granted'
    if (this.ownerOf(input.nodeId)) return 'node-held'
    if (this.grantsOf(input.nodeId).length >= GRANTS_PER_NODE_MAX) return 'too-many-grants'
    let carried: Pick<IntegrationNodeRecord, 'pulls' | 'pullRepository' | 'jira'> = {}
    if (existing) {
      if (existing.pulls?.length && existing.pullRepository) {
        carried = { pulls: [...existing.pulls], pullRepository: existing.pullRepository }
      }
      if (existing.jira?.length) carried.jira = existing.jira.map((t) => ({ ...t }))
      existing.state = 'closed'
      existing.closedAt = this.now()
      withoutLinks(existing)
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
    this.close(row)
    return 'revoked'
  }

  /** The open adopted rows of a node. */
  grantsOf(nodeId: string): IntegrationNodeRecord[] {
    return this.rows.filter((r) => r.kind === 'node' && r.state === 'open' && r.adopted && r.nodeId === nodeId)
  }

  /** The pull requests declared on an open node row, for `repository` (another repository's = none). */
  declaredPulls(row: IntegrationNodeRecord, repository: string): number[] {
    const r = this.openRow(row)
    return r?.kind === 'node' && sameRepository(r.pullRepository, repository) ? [...(r.pulls ?? [])] : []
  }

  /** The row itself while it is still an open row of this ledger. */
  private openRow(row: IntegrationNodeRecord): IntegrationNodeRecord | undefined {
    return this.rows.includes(row) && row.state === 'open' ? row : undefined
  }

  /**
   * Adds declared pull requests to an open node row (idempotent). A set recorded for ANOTHER
   * repository is dropped first. 'too-many' (nothing changed) when the union would pass
   * `INTEGRATION_PULLS_MAX`; undefined when there is no open node row.
   */
  declarePulls(row: IntegrationNodeRecord, repository: string, add: readonly number[]): number[] | 'too-many' | undefined {
    const r = this.openRow(row)
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
  undeclarePull(row: IntegrationNodeRecord, repository: string, pull: number): number[] | undefined {
    const r = this.openRow(row)
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

  /** The Jira tickets declared on an open node row. */
  declaredJira(row: IntegrationNodeRecord): JiraTicketLink[] {
    const r = this.openRow(row)
    return r?.kind === 'node' ? (r.jira ?? []).map((t) => ({ ...t })) : []
  }

  /**
   * Upserts Jira tickets on an open node row, by ticket key: a known ticket's status, group and
   * summary are replaced in place, a new one is appended. `changed` is false when every ticket said
   * the same as before (nothing is written then). 'too-many' (nothing changed) when the set would
   * pass `INTEGRATION_JIRA_MAX`; undefined when there is no open node row.
   */
  declareJira(
    row: IntegrationNodeRecord,
    tickets: readonly JiraTicketInput[],
    at: number
  ): { jira: JiraTicketLink[]; changed: boolean } | 'too-many' | undefined {
    const r = this.openRow(row)
    if (!r || r.kind !== 'node') return undefined
    const { jira: next, changed } = upsertJiraTickets(r.jira ?? [], tickets, at)
    if (next.length > INTEGRATION_JIRA_MAX) return 'too-many'
    if (!changed) return { jira: next, changed }
    r.jira = next
    this.save()
    return { jira: next.map((t) => ({ ...t })), changed }
  }

  /** Removes one declared Jira ticket (idempotent). Undefined when there is no open node row. */
  undeclareJira(row: IntegrationNodeRecord, key: string): { jira: JiraTicketLink[]; changed: boolean } | undefined {
    const r = this.openRow(row)
    if (!r || r.kind !== 'node') return undefined
    const current = r.jira ?? []
    const next = current.filter((t) => t.key !== key)
    if (next.length === current.length) return { jira: next.map((t) => ({ ...t })), changed: false }
    if (next.length) r.jira = next
    else delete r.jira
    this.save()
    return { jira: next.map((t) => ({ ...t })), changed: true }
  }

  /** The declared Jira tickets of every card (all projects), ONE entry per (project, node): a node
   *  may hold several keys (grants), merged by `mergeJiraCards`. */
  jiraLinks(): JiraCardLinks[] {
    return mergeJiraCards(
      this.rows
        .filter((r) => r.kind === 'node' && r.state === 'open' && r.jira?.length)
        .map((r) => ({ projectId: r.projectId, nodeId: r.nodeId, principal: r.principal, tickets: r.jira! }))
    )
  }

  /** Would upserting `tickets` take the row past `INTEGRATION_JIRA_MAX`? (Checked before an `open`
   *  changes anything else.) */
  jiraWouldOverflow(row: IntegrationNodeRecord, tickets: readonly JiraTicketInput[]): boolean {
    const keys = new Set([...this.declaredJira(row).map((t) => t.key), ...tickets.map((t) => t.key)])
    return keys.size > INTEGRATION_JIRA_MAX
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
