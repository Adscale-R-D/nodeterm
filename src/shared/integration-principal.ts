// INTEGRATION PRINCIPALS (docs/integration-principal.md).
//
// A principal is a local program that drives agent sessions on a Server Edition canvas WITHOUT
// being a node itself — an issue-tracker poller that opens one session per ticket, delivers later
// updates into it and closes it when the ticket is done. It authenticates with a registered token
// (src/core/integration/registry.ts), talks to its own route on the hook server
// (`/integration/<verb>`), and owns exactly the nodes it opened, durably
// (src/core/integration/ledger.ts). Everything here is generic: nodeterm never interprets a
// principal's KEY (the caller's own id for an item, e.g. a ticket id).
//
// This module holds what both ends must agree on: the names, the validators and the wire shapes.

/** The hook-server path prefix every principal verb lives under. */
export const INTEGRATION_ROUTE_PREFIX = '/integration/'

/** Request headers carrying the principal's identity. The app-wide bearer is still required too. */
export const INTEGRATION_NAME_HEADER = 'x-nodeterm-integration'
export const INTEGRATION_TOKEN_HEADER = 'x-nodeterm-integration-token'

/** The verbs. Anything else is a 404-shaped refusal. */
export const INTEGRATION_VERBS = [
  'open',
  'resume',
  'send',
  'close',
  'list',
  'comment',
  'link-pull',
  'unlink-pull'
] as const
export type IntegrationVerb = (typeof INTEGRATION_VERBS)[number]

export function isIntegrationVerb(v: string): v is IntegrationVerb {
  return (INTEGRATION_VERBS as readonly string[]).includes(v)
}

/** The agents a principal may open: exactly the Server Edition's own open allowlist. */
export const INTEGRATION_AGENTS = ['claude', 'codex', 'gemini'] as const
export type IntegrationAgent = (typeof INTEGRATION_AGENTS)[number]

/** The internal messaging verb a principal's `send` travels under. NOT in `AGENT_MESSAGE_VERBS`, so
 *  no IPC or shim can reach the messaging service with it. */
export const INTEGRATION_MESSAGE_VERB = 'integration-message'

/** What the target agent reads as `reply-to:` — a principal has no pane to answer into. */
export const INTEGRATION_REPLY_TO =
  'none (an external integration; it watches this session but cannot read replies)'

/** The longest a principal's queued `send` may wait. The queue's own persisted ceiling (24 h). */
export const INTEGRATION_SEND_TTL_MAX_MS = 24 * 60 * 60 * 1000
/** A `send` body larger than this is refused (the envelope is typed into a pane). */
export const INTEGRATION_SEND_TEXT_MAX = 32 * 1024
/** A launch prompt larger than this is refused (it is spilled to a file, read at launch). */
export const INTEGRATION_PROMPT_MAX = 256 * 1024

/** At most this many pull requests may be DECLARED on one key's card (`open.pulls`, `link-pull`). */
export const INTEGRATION_PULLS_MAX = 20

/** A pull request number: a positive integer GitHub's GraphQL `Int` can carry. */
export function isDeclarablePull(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v <= 2_147_483_647
}

/** `open.pulls`: a list of at most `INTEGRATION_PULLS_MAX` PR numbers, deduplicated and sorted, or
 *  null when anything in it is not one. */
export function parseDeclaredPulls(v: unknown): number[] | null {
  if (!Array.isArray(v) || v.length > INTEGRATION_PULLS_MAX || !v.every(isDeclarablePull)) return null
  return [...new Set(v)].sort((a, b) => a - b)
}

/** A principal name: a path segment (token file) and part of a flow key. */
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/
export function isSafePrincipalName(v: unknown): v is string {
  return typeof v === 'string' && NAME_RE.test(v)
}

/** A caller's opaque key for one item. Never a path segment, never typed into a pane, but shown on
 *  the canvas, so it is a short, printable token. */
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:#/-]{0,63}$/
export function isSafePrincipalKey(v: unknown): v is string {
  return typeof v === 'string' && KEY_RE.test(v)
}

/** A display label: one printable line. */
const LABEL_BAD = /[\p{Cc}\p{Cf}]/u
export function isSafePrincipalLabel(v: unknown): v is string {
  return typeof v === 'string' && v.length >= 1 && v.length <= 48 && !LABEL_BAD.test(v) && v.trim() === v
}

/** A frame label for `open --group`. Same rule as a principal label. */
export const isSafeFrameLabel = isSafePrincipalLabel

/**
 * The display-only marker on a node a principal opened (`CanvasNodeState.integration`). It is in
 * the git-shared project file, so it is hostile input and NEVER authority — the ledger is. Re-checked
 * at both serializer seams; anything malformed becomes no marker (the node is kept).
 */
export interface IntegrationMarker {
  name: string
  key: string
  label?: string
}

export function normalizeIntegrationMarker(raw: unknown): IntegrationMarker | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  if (!isSafePrincipalName(r.name) || !isSafePrincipalKey(r.key)) return undefined
  return {
    name: r.name,
    key: r.key,
    ...(isSafePrincipalLabel(r.label) ? { label: r.label } : {})
  }
}

// ── Wire shapes ─────────────────────────────────────────────────────────────────────────────────
// Every request body is JSON. Every reply is JSON `{ok: true, result}` or
// `{ok: false, error, message}`, where `error` is a stable code and `message` a sentence.

export interface IntegrationOpenRequest {
  key: string
  agent: IntegrationAgent
  /** A machine-local project entry id from the principal's registration. Default: its first. */
  project?: string
  /** Absolute, existing directory. Default: the project's folder. */
  cwd?: string
  /** The first prompt. Spilled to a file and read by the launch, so newlines survive. */
  prompt?: string
  model?: string
  /** A frame (group) title. Created on first use, reused after; owned by the principal. */
  group?: string
  /** Node title. Default: "<key> · <agent label>". */
  title?: string
  /** File the session's kanban card at the TOP of the existing column with this title
   *  (case-insensitive, ≤ 48 chars). Never creates a column. Ignored by an `existing` upsert. */
  column?: string
  /** Pull requests (numbers in the board's GitHub repository) this card is about. Recorded for the
   *  key; an `existing` upsert UNIONS them into what is already declared. Ignored (not refused) on a
   *  project whose board has no GitHub repository. ≤ `INTEGRATION_PULLS_MAX`. */
  pulls?: number[]
}

export interface IntegrationOpenResult {
  key: string
  nodeId: string
  projectId: string
  /** `existing` = the ledger already had an open node for this key; only `pulls` (unioned) changed. */
  status: 'created' | 'existing'
  /** `created` only: whether the agent launch was delivered. */
  session?: 'started' | 'failed'
  reason?: string
  frameId?: string
  /** Only when `column` was asked for and the node was created: the column id it was filed in, or
   *  'missing' (no column has that title; the card is in Ungrouped). */
  column?: string
  /** Only when the request carried `pulls`: the key's declared set after this call. */
  pulls?: number[]
  /** `pulls` were not recorded: the project has no GitHub repository (no board repository and no
   *  GitHub git remote). */
  pullsIgnored?: 'no-repository'
}

/** `link-pull` / `unlink-pull`. */
export interface IntegrationPullRequest {
  key: string
  pull: number
}

export interface IntegrationPullResult {
  key: string
  nodeId: string
  /** The key's declared set after the call, ascending. */
  pulls: number[]
}

export interface IntegrationKeyRequest {
  key: string
}

export type IntegrationResumeOutcome =
  /** The session was running; this server reattached to it and re-proved its pane. */
  | 'attached'
  /** The session was gone; the agent was restarted on its saved conversation. */
  | 'resumed'
  /** The session was gone and its conversation could not be found; a fresh agent was started. */
  | 'started-fresh'
  /** This server already holds the session; nothing to do. */
  | 'already-running'
  | 'refused'

export interface IntegrationResumeResult {
  key: string
  nodeId: string
  outcome: IntegrationResumeOutcome
  reason?: string
}

export interface IntegrationSendRequest {
  key: string
  text: string
  /** Queue when the agent is busy (default true). `false` refuses instead (`targetBusy`). */
  queue?: boolean
  /** How long a queued message may wait, ms. Default 5 min, at most 24 h. */
  ttlMs?: number
}

export interface IntegrationSendResult {
  key: string
  nodeId: string
  /** This send's id. A `queued` send's final outcome appears in the outbox under it. */
  sendId: string
  /** The messaging outcome kind: delivered | stalled | queued | targetGone | notPermitted | … */
  outcome: string
  /** The bytes reached (`delivered`, `stalled`) or will reach (`queued`) the pane. Never resend an
   *  accepted message: `stalled` may already sit in the composer. */
  accepted: boolean
  /** The messaging trace id (support / board log). */
  traceId?: string
  message: string
  retryAfterMs?: number
  /** `notPermitted` only. */
  reason?: string
}

/** Longest `comment` text accepted on the wire. Longer is refused (`bad-text`); text over
 *  `BOARD_LOG_TEXT_MAX` (16 KiB) but under this is clamped to it with a trailing '…'. */
export const INTEGRATION_COMMENT_TEXT_MAX = 64 * 1024

export interface IntegrationCommentRequest {
  key: string
  /** Plain markdown. Control characters (except newline and tab) are removed. */
  text: string
}

export interface IntegrationCommentResult {
  key: string
  nodeId: string
  /** The board-log entry id of the new comment. */
  commentId: string
}

export interface IntegrationCloseRequest {
  key: string
}

export interface IntegrationCloseResult {
  key: string
  nodeId: string
  closed: true
  /** The node had already been removed from the canvas (by a person); the ledger row is closed. */
  nodeMissing?: boolean
}

export interface IntegrationListRequest {
  key?: string
  includeClosed?: boolean
  /** Return only outbox entries newer than this (ms epoch). */
  outboxSince?: number
}

export interface IntegrationListRow {
  key: string
  nodeId: string
  projectId: string
  agent: IntegrationAgent
  agentSessionId?: string
  state: 'open' | 'closed'
  createdAt: number
  closedAt?: number
  /** The node is no longer on its canvas. */
  nodeMissing?: boolean
  /** live | absent | unknown — the tmux session. Open rows only. */
  session?: 'live' | 'absent' | 'unknown'
  /** This server holds a client on the session (it is not reaper-eligible). */
  attached?: boolean
  /** The pane's owner is proven this run, so `send` can reach it. */
  paneProven?: boolean
  /** working | waiting | blocked | done | unknown — from the agent's own hooks. */
  agentState?: string
  /** waiting/blocked: a permission or question dialog waits on a person. */
  needsYou?: boolean
  /** The last turn ended on an API/model error. */
  lastTurnError?: boolean
  /** Open rows: the pull requests declared on the card (`open.pulls`, `link-pull`), ascending. */
  pulls?: number[]
}

/** How a queued `send` ended. Pull-based: returned by `list`. */
export interface IntegrationOutboxEntry {
  /** The `sendId` the `send` reply returned. */
  sendId: string
  key: string
  nodeId: string
  /** delivered | stalled | expired | targetGone | notPermitted | … */
  outcome: string
  at: number
}

export interface IntegrationListResult {
  rows: IntegrationListRow[]
  outbox: IntegrationOutboxEntry[]
}

export type IntegrationReply<T> =
  | { ok: true; result: T }
  | { ok: false; error: string; message: string; retryAfterMs?: number }
