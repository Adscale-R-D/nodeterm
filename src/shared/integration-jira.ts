// Jira tickets an INTEGRATION PRINCIPAL declares on a card (docs/integration-principal.md, "Declared
// Jira tickets"). nodeterm holds no Jira credential and never asks Jira anything: the principal
// already polls Jira, so it pushes each ticket's status and summary with the declaration and pushes
// again when they change. nodeterm stores what it was told and draws it.
//
// Everything here is hostile input on the way in (a principal is a registered local program, but a
// Jira status and summary are text anyone with access to the ticket can write):
//  - the link is never taken from the caller. It is BUILT from a validated https origin and a
//    strict ticket key, `${site}/browse/${key}`, and the renderer re-checks it before opening;
//  - status and summary are one displayable line (no controls, no bidi or zero-width characters),
//    capped;
//  - the status group is a closed set; an unknown value is dropped and draws neutral.
import { oneLine } from './one-line'

/** At most this many tickets may be declared on one key's card. */
export const INTEGRATION_JIRA_MAX = 20
export const JIRA_STATUS_MAX = 40
export const JIRA_SUMMARY_MAX = 120

/** Jira's status categories, as the principal maps them (Jira: new / indeterminate / done). */
export const JIRA_CATEGORIES = ['todo', 'in-progress', 'done'] as const
export type JiraCategory = (typeof JIRA_CATEGORIES)[number]

/** A ticket as declared on a card. */
export interface JiraTicketLink {
  /** `A3-6926`: an upper-case project key, a dash, a number. */
  key: string
  /** The Jira site's https origin, e.g. `https://ad-scale.atlassian.net`. */
  site: string
  status?: string
  category?: JiraCategory
  summary?: string
  /** When this server last saw the ticket's record CHANGE (ms epoch). An identical re-send changes
   *  nothing, so this is "status last changed", not "last confirmed". */
  at: number
}

/** The request form: what a principal sends for one ticket (`at` is stamped on receipt). */
export type JiraTicketInput = Omit<JiraTicketLink, 'at'>

/** One card's tickets, as the host lists them to the renderer. */
export interface JiraCardLinks {
  projectId: string
  nodeId: string
  /** The principal that last changed a ticket here (shown in the tooltip). Absent: the session
   *  declared them itself (`link-jira` on the canvas-control shim). */
  principal?: string
  tickets: JiraTicketLink[]
}

const KEY_RE = /^[A-Z][A-Z0-9_]{1,9}-[1-9][0-9]{0,8}$/
const FORMAT_CHARS = /\p{Cf}+/gu

export function isJiraKey(v: unknown): v is string {
  return typeof v === 'string' && KEY_RE.test(v)
}

/** A ticket key from a request: trimmed and upper-cased first, then checked. */
export function parseJiraKey(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const key = v.trim().toUpperCase()
  return KEY_RE.test(key) ? key : null
}

/** An https origin (no credentials, no path, query or fragment), normalized; null otherwise. A
 *  trailing slash is accepted. */
export function parseJiraSite(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 200) return null
  let u: URL
  try {
    u = new URL(v)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) return null
  if (u.pathname !== '/' && u.pathname !== '') return null
  if (!u.hostname || u.hostname.includes('%')) return null
  return u.origin
}

/** The ticket's browse page, or null when either half does not validate. The only way a link is
 *  made — on the host and again in the renderer before it is opened. */
export function jiraTicketUrl(site: unknown, key: unknown): string | null {
  const origin = parseJiraSite(site)
  return origin && isJiraKey(key) ? `${origin}/browse/${key}` : null
}

/** One displayable line, capped in code points with a trailing `…`; undefined when nothing is left. */
function line(raw: unknown, max: number): string | undefined {
  if (typeof raw !== 'string') return undefined
  const flat = oneLine(raw.replace(FORMAT_CHARS, '')).trim()
  if (!flat) return undefined
  const points = Array.from(flat)
  return points.length > max ? `${points.slice(0, max - 1).join('')}…` : flat
}

/**
 * One ticket from a request: null when the key or the site does not validate. Status and summary
 * that are not strings are refused too (a caller bug, not text to clean); strings are cleaned to
 * one line and capped. An unknown `category` is refused.
 */
export function parseJiraTicketInput(raw: unknown): JiraTicketInput | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const key = parseJiraKey(r.key)
  const site = parseJiraSite(r.site)
  if (!key || !site) return null
  if (r.status !== undefined && typeof r.status !== 'string') return null
  if (r.summary !== undefined && typeof r.summary !== 'string') return null
  if (r.category !== undefined && !(JIRA_CATEGORIES as readonly unknown[]).includes(r.category)) return null
  const status = line(r.status, JIRA_STATUS_MAX)
  const summary = line(r.summary, JIRA_SUMMARY_MAX)
  return {
    key,
    site,
    ...(status ? { status } : {}),
    ...(r.category !== undefined ? { category: r.category as JiraCategory } : {}),
    ...(summary ? { summary } : {})
  }
}

/** `open.jira`: at most `INTEGRATION_JIRA_MAX` tickets, a later duplicate key replacing an earlier
 *  one; null when any entry does not validate. */
export function parseJiraTicketInputs(v: unknown): JiraTicketInput[] | null {
  if (!Array.isArray(v) || v.length > INTEGRATION_JIRA_MAX) return null
  const byKey = new Map<string, JiraTicketInput>()
  for (const raw of v) {
    const t = parseJiraTicketInput(raw)
    if (!t) return null
    byKey.delete(t.key)
    byKey.set(t.key, t)
  }
  return [...byKey.values()]
}

/** A stored ticket (the ledger file, a host reply): the input rules plus a finite `at`. */
export function sanitizeJiraTicketLink(raw: unknown): JiraTicketLink | null {
  const t = parseJiraTicketInput(raw)
  const at = (raw as { at?: unknown } | null)?.at
  if (!t || typeof at !== 'number' || !Number.isFinite(at)) return null
  return { ...t, at }
}

/** A stored set: bad entries dropped, duplicates collapsed (the last wins), capped at `max`. */
export function sanitizeJiraTicketLinks(raw: unknown, max = INTEGRATION_JIRA_MAX): JiraTicketLink[] {
  if (!Array.isArray(raw)) return []
  const byKey = new Map<string, JiraTicketLink>()
  for (const r of raw.slice(0, max * 2)) {
    const t = sanitizeJiraTicketLink(r)
    if (!t) continue
    byKey.delete(t.key)
    byKey.set(t.key, t)
  }
  return [...byKey.values()].slice(-max)
}

/** A card's merged list (a node may hold several keys) is capped higher than one key's set. */
export const JIRA_CARD_TICKETS_MAX = INTEGRATION_JIRA_MAX * 4

const PROJECT_ID_RE = /^[\w.:-]{1,128}$/
const NODE_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/
const PRINCIPAL_RE = /^[a-z0-9][a-z0-9-]{0,31}$/

/** The host's list, as the renderer reads it: malformed entries are dropped. */
export function sanitizeJiraCardLinks(raw: unknown): JiraCardLinks[] {
  if (!Array.isArray(raw)) return []
  const out: JiraCardLinks[] = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const e = r as Record<string, unknown>
    if (typeof e.projectId !== 'string' || !PROJECT_ID_RE.test(e.projectId)) continue
    if (typeof e.nodeId !== 'string' || !NODE_ID_RE.test(e.nodeId)) continue
    if (e.principal !== undefined && (typeof e.principal !== 'string' || !PRINCIPAL_RE.test(e.principal))) continue
    const tickets = sanitizeJiraTicketLinks(e.tickets, JIRA_CARD_TICKETS_MAX)
    if (tickets.length) {
      out.push({ projectId: e.projectId, nodeId: e.nodeId, ...(typeof e.principal === 'string' ? { principal: e.principal } : {}), tickets })
    }
  }
  return out
}

/** Do two stored ticket records say the same thing (ignoring when they were received)? */
export function sameJiraTicket(a: JiraTicketInput, b: JiraTicketInput): boolean {
  return (
    a.key === b.key && a.site === b.site && a.status === b.status && a.category === b.category && a.summary === b.summary
  )
}

/**
 * Upserts tickets into a declared set by ticket key: a known ticket whose record differs is replaced
 * WHOLE (a field left out is cleared) and stamped `at`, a new one is appended. `changed` is false when
 * every ticket said the same as before. The one rule, for principal rows and a node's own links.
 */
export function upsertJiraTickets(
  current: readonly JiraTicketLink[],
  tickets: readonly JiraTicketInput[],
  at: number
): { jira: JiraTicketLink[]; changed: boolean } {
  const next = current.map((t) => ({ ...t }))
  let changed = false
  for (const t of tickets) {
    const i = next.findIndex((x) => x.key === t.key)
    if (i >= 0) {
      if (!sameJiraTicket(next[i], t)) {
        next[i] = { ...t, at }
        changed = true
      }
    } else {
      next.push({ ...t, at })
      changed = true
    }
  }
  return { jira: next, changed }
}

/**
 * ONE entry per (project, node) out of any number of sources (a node's principal keys, its own
 * links): a ticket declared twice appears once. An INTEGRATION's record always beats the session's
 * own for the same ticket (the integration reads Jira; a session's `link-jira` may carry no status
 * at all), and between two records of the same kind the most recently changed one wins. `principal`
 * is that of the most recently changed winning ticket; absent when that one is the session's own.
 */
export function mergeJiraCards(entries: readonly JiraCardLinks[]): JiraCardLinks[] {
  const byCard = new Map<string, { card: JiraCardLinks; newest: number; fromPrincipal: Set<string> }>()
  for (const e of entries) {
    const id = `${e.projectId}\n${e.nodeId}`
    let slot = byCard.get(id)
    if (!slot) {
      slot = { card: { projectId: e.projectId, nodeId: e.nodeId, tickets: [] }, newest: -Infinity, fromPrincipal: new Set() }
      byCard.set(id, slot)
    }
    for (const t of e.tickets) {
      const i = slot.card.tickets.findIndex((x) => x.key === t.key)
      const held = i >= 0 && slot.fromPrincipal.has(t.key)
      const wins =
        i < 0 || (e.principal ? !held || t.at > slot.card.tickets[i].at : !held && t.at > slot.card.tickets[i].at)
      if (!wins) continue
      if (i < 0) slot.card.tickets.push({ ...t })
      else slot.card.tickets[i] = { ...t }
      if (e.principal) slot.fromPrincipal.add(t.key)
      if (t.at >= slot.newest) {
        slot.newest = t.at
        if (e.principal) slot.card.principal = e.principal
        else delete slot.card.principal
      }
    }
  }
  return [...byCard.values()].map(({ card }) => ({ ...card, tickets: card.tickets.slice(0, JIRA_CARD_TICKETS_MAX) }))
}

/** The most recently used Jira site among declared tickets (a `link-jira` without `--site`). */
export function newestJiraSite(entries: readonly JiraCardLinks[]): string | undefined {
  let best: JiraTicketLink | undefined
  for (const e of entries) for (const t of e.tickets) if (!best || t.at > best.at) best = t
  return best?.site
}
