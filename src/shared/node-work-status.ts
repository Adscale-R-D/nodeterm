// A node's WORK STATUS: where its work stands, said by the session itself (`set-status`) or by the
// person (the node and card menus), and kept until one of them changes it. "Investigating",
// "Waiting on someone", "Ready to go", "Blocked", plus an optional one-line note.
//
// It is NOT agent state. RUNNING / NEEDS YOU describe the CLI's turn right now and are transient; an
// unread dot clears when the node is looked at. This is the opposite on purpose: a Jira-linked
// session that agreed the scope with the ticket's author says "Ready to go", and the chip is still
// there tomorrow, after the node has been opened ten times, after a restart. Nothing clears it on
// its own — not a new turn, not a read, not a hook event.
//
// Stored on the node (`CanvasNodeState.workStatus`), so the canvas header, the kanban card and the
// card modal read the same value with no channel of their own. `.nodeterm/project.json` is the file
// that carries it, and that file is hand-editable input: `normalizeWorkStatus` runs at both
// serializer seams and in every reader; anything malformed is no status (the node is kept).

/** In dev-flow order: the stages a ticket session moves through, then the two "someone else is
 *  next" kinds, then blocked. The menus, the board filter and the agent docs use this order. */
export const WORK_STATUS_KINDS = [
  'clarifying',
  'planning',
  'implementing',
  'review',
  'waiting',
  'ready',
  'blocked'
] as const
export type WorkStatusKind = (typeof WORK_STATUS_KINDS)[number]

export const WORK_STATUS_LABELS: Record<WorkStatusKind, string> = {
  clarifying: 'Clarifying',
  planning: 'Planning',
  implementing: 'Implementing',
  review: 'In review',
  waiting: 'Waiting on someone',
  ready: 'Ready for you',
  blocked: 'Blocked'
}

/** What each kind means — the menus' hints and the agent docs. */
export const WORK_STATUS_MEANING: Record<WorkStatusKind, string> = {
  clarifying: 'working out the scope, asking the reporter',
  planning: 'designing the change, agreeing the approach',
  implementing: 'writing the code, running the local gate',
  review: 'a pull request is open, waiting on reviewers or CI',
  waiting: 'a person must answer before it can go on',
  ready: "this session's part is done; the person decides what is next",
  blocked: 'cannot continue (say why in the note)'
}

/** Shorter labels for the chip itself (the full label is in its tooltip and the menus). */
export const WORK_STATUS_SHORT: Record<WorkStatusKind, string> = {
  clarifying: 'Clarifying',
  planning: 'Planning',
  implementing: 'Implementing',
  review: 'In review',
  waiting: 'Waiting',
  ready: 'Ready',
  blocked: 'Blocked'
}

/** Names from the first version of the list, read as their successor (a stored status, a skill
 *  still written against the old name). `investigating` was the first list's "working it out". */
const LEGACY_KINDS: Record<string, WorkStatusKind> = { investigating: 'clarifying' }

/** The note: one printable line. */
export const WORK_STATUS_NOTE_MAX = 120

export interface NodeWorkStatus {
  kind: WorkStatusKind
  note?: string
  /** When it was set (epoch ms). */
  at: number
  /** Who set it: the session (`set-status`) or the person (a menu). Display only. */
  by: 'agent' | 'user'
}

export function isWorkStatusKind(v: unknown): v is WorkStatusKind {
  return typeof v === 'string' && (WORK_STATUS_KINDS as readonly string[]).includes(v)
}

/** A current kind, or a legacy name mapped to its successor; anything else is undefined. */
export function resolveWorkStatusKind(v: unknown): WorkStatusKind | undefined {
  if (isWorkStatusKind(v)) return v
  return typeof v === 'string' && Object.hasOwn(LEGACY_KINDS, v) ? LEGACY_KINDS[v] : undefined
}

/** Controls, format characters (bidi, zero-width) and line breaks go; whitespace is collapsed. */
export function cleanWorkStatusNote(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const one = raw
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!one) return undefined
  const points = Array.from(one)
  return points.length > WORK_STATUS_NOTE_MAX ? `${points.slice(0, WORK_STATUS_NOTE_MAX - 1).join('').trimEnd()}…` : one
}

export function normalizeWorkStatus(raw: unknown): NodeWorkStatus | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  const kind = resolveWorkStatusKind(r.kind)
  if (!kind) return undefined
  if (typeof r.at !== 'number' || !Number.isFinite(r.at) || r.at < 0) return undefined
  const note = cleanWorkStatusNote(r.note)
  return { kind, ...(note ? { note } : {}), at: r.at, by: r.by === 'agent' ? 'agent' : 'user' }
}

/** Same status, as every reader sees it (the time and author count: they are on the tooltip). */
export function sameWorkStatus(a: NodeWorkStatus | undefined, b: NodeWorkStatus | undefined): boolean {
  if (!a || !b) return !a && !b
  return a.kind === b.kind && a.note === b.note && a.at === b.at && a.by === b.by
}

/** The kinds that tell a station's OPENER (the node that opened it through canvas control): the
 *  moments the opener may have to act. The stage kinds (clarifying … review) stay on the chip. */
export const WORK_STATUS_HANDOFF_KINDS: ReadonlySet<WorkStatusKind> = new Set(['waiting', 'ready', 'blocked'])

/** Does a change from `before` to `next` (set by the session itself) owe the opener a notice? Only
 *  ENTERING a hand-off kind: a note edit, a repeat, a clear or a stage move does not. */
export function workStatusNotifiesOpener(before: NodeWorkStatus | undefined, next: NodeWorkStatus | undefined): boolean {
  return !!next && next.by === 'agent' && WORK_STATUS_HANDOFF_KINDS.has(next.kind) && before?.kind !== next.kind
}

// ── The control verb ────────────────────────────────────────────────────────────────────────────

export const SET_STATUS_VERB = 'set-status'
/** `--status none` clears it (every flag takes a value, so a clear is a value too). */
export const WORK_STATUS_CLEAR = 'none'
export const SET_STATUS_FLAGS: ReadonlySet<string> = new Set(['status', 'note', 'node'])

export const SET_STATUS_REQUIRES = `${SET_STATUS_VERB} requires --status ${[...WORK_STATUS_KINDS, WORK_STATUS_CLEAR].join('|')}`

/** The flat refusal for an unverified `set-status` (house style: no diagnosis). */
export const SET_STATUS_CONTROL_REFUSAL = 'Status change refused.'

export type SetStatusRequest = { clear: true } | { clear: false; kind: WorkStatusKind; note?: string }

/** Shape gate shared by every shell: a refusal sentence, or the request. `--node` may only name the
 *  caller (`selfId`) — a node says where ITS work stands, never another's. */
export function parseSetStatusArgs(args: Record<string, string>, selfId: string): SetStatusRequest | { error: string } {
  const unknown = Object.keys(args).find((k) => !SET_STATUS_FLAGS.has(k))
  if (unknown) return { error: `${SET_STATUS_VERB}: unknown flag --${unknown}` }
  if (args.node !== undefined && args.node.trim() !== selfId) {
    return { error: `${SET_STATUS_VERB}-not-self: a node sets only its own status; omit --node` }
  }
  const status = (args.status ?? '').trim().toLowerCase()
  if (!status) return { error: SET_STATUS_REQUIRES }
  if (status === WORK_STATUS_CLEAR) {
    if (args.note !== undefined) return { error: `${SET_STATUS_VERB}: --note needs a status; --status none clears it` }
    return { clear: true }
  }
  const kind = resolveWorkStatusKind(status)
  if (!kind) {
    return { error: `${SET_STATUS_VERB}: unknown status "${status.slice(0, 40)}" — use ${[...WORK_STATUS_KINDS, WORK_STATUS_CLEAR].join('|')}` }
  }
  const note = cleanWorkStatusNote(args.note)
  return { clear: false, kind, ...(note ? { note } : {}) }
}

export function workStatusLine(s: NodeWorkStatus | undefined): string {
  if (!s) return 'no status'
  return `${WORK_STATUS_LABELS[s.kind]}${s.note ? ` — ${s.note}` : ''}`
}
