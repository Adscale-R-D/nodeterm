// Links a SESSION declares on its own kanban card through the canvas-control shim (`link-pr`,
// `unlink-pr`, `link-jira`, `unlink-jira`, `links`; src/server/node-link-verbs.ts): the pull requests
// and Jira tickets it works on. The same two link kinds an integration principal declares on its
// keys (src/core/integration/ledger.ts), but owned by the node itself, so there is no principal and
// no key: one record per node.
//
// Machine-local, durable (core/durable-state.ts, `<userData>/orchestration-state/node-links.json`),
// never in `project.json`. A record names the project the node was in when it declared; the boards
// read it per project, so a node moved to another project starts over. Records of nodes that left
// every canvas are pruned by the verbs (`prune`) and bounded in number.
import { DurableFactFile, isBoundedString, isFiniteNumber, type DurableFactSpec } from '../durable-state'
import { isSafeNodeId } from '../agents/node-auth-token'
import { INTEGRATION_PULLS_MAX, parseDeclaredPulls } from '../../shared/integration-principal'
import {
  INTEGRATION_JIRA_MAX,
  sanitizeJiraTicketLinks,
  upsertJiraTickets,
  type JiraCardLinks,
  type JiraTicketInput,
  type JiraTicketLink
} from '../../shared/integration-jira'

export interface NodeLinkRecord {
  nodeId: string
  projectId: string
  /** Ascending PR numbers in `pullRepository`. */
  pulls?: number[]
  pullRepository?: string
  jira?: JiraTicketLink[]
  updatedAt: number
}

const NODE_LINK_RECORDS_MAX = 4000
const REPOSITORY_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/

export function sanitizeNodeLinkRecord(raw: unknown): NodeLinkRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (typeof r.nodeId !== 'string' || !isSafeNodeId(r.nodeId)) return null
  if (!isBoundedString(r.projectId, 128) || !r.projectId) return null
  if (!isFiniteNumber(r.updatedAt)) return null
  const out: NodeLinkRecord = { nodeId: r.nodeId, projectId: r.projectId, updatedAt: r.updatedAt }
  if (typeof r.pullRepository === 'string' && REPOSITORY_RE.test(r.pullRepository)) {
    const pulls = parseDeclaredPulls(r.pulls)
    if (pulls?.length) {
      out.pulls = pulls
      out.pullRepository = r.pullRepository
    }
  }
  const jira = sanitizeJiraTicketLinks(r.jira)
  if (jira.length) out.jira = jira
  return out.pulls || out.jira ? out : null
}

export const NODE_LINKS_FACT: DurableFactSpec<NodeLinkRecord> = {
  kind: 'node-links',
  version: 1,
  maxRecords: NODE_LINK_RECORDS_MAX,
  sanitize: sanitizeNodeLinkRecord
}

function sameRepository(a: string | undefined, b: string): boolean {
  return !!a && a.toLocaleLowerCase('en-US') === b.toLocaleLowerCase('en-US')
}

export class NodeLinkStore {
  private records: NodeLinkRecord[] = []
  private onChange?: () => void

  constructor(
    private readonly file?: Pick<DurableFactFile<NodeLinkRecord>, 'load' | 'save'>,
    private readonly now: () => number = Date.now
  ) {}

  load(): void {
    const seen = new Set<string>()
    // Latest wins for a duplicated node.
    this.records = [...(this.file?.load() ?? [])].reverse().filter((r) => !seen.has(r.nodeId) && seen.add(r.nodeId)).reverse()
  }

  setOnChange(fn: (() => void) | undefined): void {
    this.onChange = fn
  }

  private save(): void {
    this.records = this.records.filter((r) => r.pulls?.length || r.jira?.length)
    if (this.records.length > NODE_LINK_RECORDS_MAX) {
      this.records = [...this.records].sort((a, b) => a.updatedAt - b.updatedAt).slice(-NODE_LINK_RECORDS_MAX)
    }
    this.file?.save(this.records)
    try {
      this.onChange?.()
    } catch {
      // A listener's failure must not fail the write that already happened.
    }
  }

  /** The node's record for `projectId` (a record from another project is not this card's). */
  get(nodeId: string, projectId: string): NodeLinkRecord | undefined {
    const r = this.records.find((x) => x.nodeId === nodeId)
    return r && r.projectId === projectId ? r : undefined
  }

  /** The node's record, re-homed to `projectId` (a node that moved project starts over). */
  private recordFor(nodeId: string, projectId: string): NodeLinkRecord {
    let r = this.records.find((x) => x.nodeId === nodeId)
    if (r && r.projectId !== projectId) {
      this.records = this.records.filter((x) => x !== r)
      r = undefined
    }
    if (!r) {
      r = { nodeId, projectId, updatedAt: this.now() }
      this.records.push(r)
    }
    return r
  }

  declaredPulls(nodeId: string, projectId: string, repository: string): number[] {
    const r = this.get(nodeId, projectId)
    return r && sameRepository(r.pullRepository, repository) ? [...(r.pulls ?? [])] : []
  }

  /** Adds one PR (idempotent). 'too-many' when the set would pass `INTEGRATION_PULLS_MAX`. */
  linkPull(nodeId: string, projectId: string, repository: string, pull: number): { pulls: number[]; changed: boolean } | 'too-many' {
    const current = this.declaredPulls(nodeId, projectId, repository)
    if (current.includes(pull)) return { pulls: current, changed: false }
    if (current.length >= INTEGRATION_PULLS_MAX) return 'too-many'
    const r = this.recordFor(nodeId, projectId)
    r.pulls = [...current, pull].sort((a, b) => a - b)
    r.pullRepository = repository
    r.updatedAt = this.now()
    this.save()
    return { pulls: [...r.pulls], changed: true }
  }

  unlinkPull(nodeId: string, projectId: string, repository: string, pull: number): { pulls: number[]; changed: boolean } {
    const current = this.declaredPulls(nodeId, projectId, repository)
    if (!current.includes(pull)) return { pulls: current, changed: false }
    const r = this.get(nodeId, projectId)!
    const next = current.filter((n) => n !== pull)
    if (next.length) r.pulls = next
    else {
      delete r.pulls
      delete r.pullRepository
    }
    r.updatedAt = this.now()
    this.save()
    return { pulls: next, changed: true }
  }

  declaredJira(nodeId: string, projectId: string): JiraTicketLink[] {
    return (this.get(nodeId, projectId)?.jira ?? []).map((t) => ({ ...t }))
  }

  /** Upserts one ticket (the shared rule). 'too-many' when the set would pass `INTEGRATION_JIRA_MAX`. */
  linkJira(nodeId: string, projectId: string, ticket: JiraTicketInput): { jira: JiraTicketLink[]; changed: boolean } | 'too-many' {
    const at = this.now()
    const { jira, changed } = upsertJiraTickets(this.declaredJira(nodeId, projectId), [ticket], at)
    if (jira.length > INTEGRATION_JIRA_MAX) return 'too-many'
    if (!changed) return { jira, changed }
    const r = this.recordFor(nodeId, projectId)
    r.jira = jira
    r.updatedAt = at
    this.save()
    return { jira: jira.map((t) => ({ ...t })), changed }
  }

  unlinkJira(nodeId: string, projectId: string, key: string): { jira: JiraTicketLink[]; changed: boolean } {
    const current = this.declaredJira(nodeId, projectId)
    const next = current.filter((t) => t.key !== key)
    if (next.length === current.length) return { jira: next, changed: false }
    const r = this.get(nodeId, projectId)!
    if (next.length) r.jira = next
    else delete r.jira
    r.updatedAt = this.now()
    this.save()
    return { jira: next, changed: true }
  }

  /** The PRs nodes declared on their own cards in a project (the board's declared source). */
  declaredForProject(projectId: string): Array<{ nodeId: string; pulls: number[]; repository: string }> {
    return this.records
      .filter((r) => r.projectId === projectId && r.pulls?.length && r.pullRepository)
      .map((r) => ({ nodeId: r.nodeId, pulls: [...r.pulls!], repository: r.pullRepository! }))
  }

  /** Every card's own Jira tickets (all projects); no principal. */
  jiraLinks(): JiraCardLinks[] {
    return this.records
      .filter((r) => r.jira?.length)
      .map((r) => ({ projectId: r.projectId, nodeId: r.nodeId, tickets: r.jira!.map((t) => ({ ...t })) }))
  }

  /** Drop the records of nodes no longer on their project's canvas. */
  prune(isLive: (nodeId: string, projectId: string) => boolean): void {
    const before = this.records.length
    this.records = this.records.filter((r) => isLive(r.nodeId, r.projectId))
    if (this.records.length !== before) this.save()
  }
}

export function openNodeLinkStore(userDataDir: string, opts: { standDown?: boolean } = {}): {
  store: NodeLinkStore
  dispose(): void
} {
  const file = new DurableFactFile(NODE_LINKS_FACT, { userDataDir })
  if (opts.standDown) file.standDown()
  const store = new NodeLinkStore(file)
  store.load()
  return { store, dispose: () => file.dispose() }
}
