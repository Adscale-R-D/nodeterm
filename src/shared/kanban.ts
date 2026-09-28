import type { CanvasNodeState, KanbanAssignment, KanbanColumn, Project, ProjectKanban } from './types'
import { SYSTEM_NODE_COLORS } from './node-colors'
import { DEFAULT_BOARD_COLUMNS, makeColumnId } from './kanban-default-board'
import { autoLabelColor, boardLabels, cardMeta, createLabel, metaList, setCardLabels } from './kanban-labels'

// The card-meta + label transforms live in `./kanban-labels` (the host core applies the same ones
// for the phone's label verb); re-exported so every importer of this module keeps its path.
export * from './kanban-labels'

// Pure kanban board transforms — the ONLY place board structure changes. The UI computes
// the next board here and hands it whole to setProjectKanban (no second live source).
// Every function returns a new board; unknown ids are no-ops returning the input.
// Cards are the project's SESSION NODES — the board stores only column assignments; a
// session with no (or dangling) assignment sits in the virtual Ungrouped column.

const kid = (prefix: string): string => `${prefix}-${Math.random().toString(36).slice(2, 10)}`

/** Default board for a project whose file has no `kanban` yet. NOT written to disk
 *  until the first user edit (the spec's lazy-default rule) — EXCEPT when the phone asks for one
 *  outright (relay `projects.ensureBoard`), which seeds the same three columns from the same
 *  shared definition so a board born on either surface is the same board. */
export function defaultKanban(): ProjectKanban {
  return {
    columns: DEFAULT_BOARD_COLUMNS.map((c) => ({ id: makeColumnId(), title: c.title, color: c.color })),
    assignments: []
  }
}

/** Color for the next added column — cycles the node palette. */
export function nextColumnColor(k: ProjectKanban): string {
  return SYSTEM_NODE_COLORS[k.columns.length % SYSTEM_NODE_COLORS.length]
}

export function addColumn(k: ProjectKanban, title: string, color: string): ProjectKanban {
  const column = { id: kid('kcol'), title, color }
  if (!k.github) return { ...k, columns: [...k.columns, column] }
  const base = `status:${title.trim().toLocaleLowerCase('en-US')
    .normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'column'}`
  const used = new Set(k.github.columnMappings.map((mapping) =>
    mapping.label.normalize('NFKC').toLocaleLowerCase('en-US')))
  let label = base.slice(0, 50)
  for (let suffix = 2; used.has(label.toLocaleLowerCase('en-US')); suffix++) {
    const ending = `-${suffix}`
    label = `${base.slice(0, 50 - ending.length)}${ending}`
  }
  return {
    ...k,
    columns: [...k.columns, column],
    github: {
      ...k.github,
      columnMappings: [...k.github.columnMappings, { columnId: column.id, label }]
    }
  }
}

export function renameColumn(k: ProjectKanban, columnId: string, title: string): ProjectKanban {
  return { ...k, columns: k.columns.map((c) => (c.id === columnId ? { ...c, title } : c)) }
}

export function recolorColumn(k: ProjectKanban, columnId: string, color: string): ProjectKanban {
  return { ...k, columns: k.columns.map((c) => (c.id === columnId ? { ...c, color } : c)) }
}

/** Moves a column before `beforeId` (null = to the end). */
export function moveColumn(k: ProjectKanban, columnId: string, beforeId: string | null): ProjectKanban {
  if (columnId === beforeId) return k
  const dragged = k.columns.find((c) => c.id === columnId)
  if (!dragged) return k
  const without = k.columns.filter((c) => c.id !== columnId)
  const idx = beforeId ? without.findIndex((c) => c.id === beforeId) : -1
  const at = idx === -1 ? without.length : idx
  return { ...k, columns: [...without.slice(0, at), dragged, ...without.slice(at)] }
}

/** Deletes a user column; its assigned sessions return to Ungrouped (assignments drop).
 *  Non-destructive by design — sessions are untouched, so no confirm dialog and no
 *  last-column rule (the virtual Ungrouped column always remains). */
export function deleteColumn(k: ProjectKanban, columnId: string): ProjectKanban {
  if (!k.columns.some((c) => c.id === columnId)) return k
  const github = (() => {
    if (!k.github) return undefined
    const { completionColumnId, ...rest } = k.github
    return {
      ...rest,
      columnMappings: k.github.columnMappings.filter((mapping) => mapping.columnId !== columnId),
      ...(completionColumnId && completionColumnId !== columnId ? { completionColumnId } : {})
    }
  })()
  return {
    ...k,
    columns: k.columns.filter((c) => c.id !== columnId),
    assignments: k.assignments.filter((a) => a.columnId !== columnId),
    ...(github ? { github } : {})
  }
}

/** Node ids assigned to `columnId`, in board order. */
export function assignedTo(k: ProjectKanban, columnId: string): string[] {
  return k.assignments.filter((a) => a.columnId === columnId).map((a) => a.nodeId)
}

/**
 * Resolve a user-supplied column reference (from the canvas-control `assign` verb) to a column
 * id. Empty or 'ungrouped' (case-insensitive) → `null` (the virtual Ungrouped column = unassign).
 * Otherwise match by exact id first, then by case-insensitive title. Unknown → `undefined`, so the
 * caller can distinguish "send to Ungrouped" (null) from "no such column" (undefined) and report
 * the available columns. Agents naturally pass a title ("In Progress"); ids come from `board`.
 */
export function resolveColumnRef(k: ProjectKanban, ref: string): string | null | undefined {
  const raw = ref.trim()
  if (!raw || raw.toLowerCase() === 'ungrouped') return null
  const byId = k.columns.find((c) => c.id === raw)
  if (byId) return byId.id
  const byTitle = k.columns.find((c) => c.title.toLowerCase() === raw.toLowerCase())
  return byTitle ? byTitle.id : undefined
}

/** Ids from `sessionIds` with no live assignment — never assigned, or assigned to a column
 *  that no longer exists (e.g. a git merge kept the assignment but lost the column). Order
 *  follows `sessionIds` (= canvas order). */
export function unassigned(k: ProjectKanban, sessionIds: string[]): string[] {
  const cols = new Set(k.columns.map((c) => c.id))
  const assigned = new Set(
    k.assignments.filter((a) => cols.has(a.columnId)).map((a) => a.nodeId)
  )
  return sessionIds.filter((id) => !assigned.has(id))
}

/** Assigns/moves a session card. `columnId` null = back to Ungrouped (assignment removed;
 *  Ungrouped order is canvas order, so `beforeNodeId` is ignored there). Inserts before
 *  `beforeNodeId`'s assignment when that assignment is in the target column, else at the
 *  end. Unknown target column is a no-op. */
export function assignNode(
  k: ProjectKanban,
  nodeId: string,
  columnId: string | null,
  beforeNodeId: string | null
): ProjectKanban {
  if (nodeId === beforeNodeId) return k
  if (columnId === null) {
    if (!k.assignments.some((a) => a.nodeId === nodeId)) return k
    return { ...k, assignments: k.assignments.filter((a) => a.nodeId !== nodeId) }
  }
  if (!k.columns.some((c) => c.id === columnId)) return k
  const moved: KanbanAssignment = { nodeId, columnId }
  const without = k.assignments.filter((a) => a.nodeId !== nodeId)
  const before = beforeNodeId
    ? without.find((a) => a.nodeId === beforeNodeId && a.columnId === columnId)
    : undefined
  const idx = before ? without.indexOf(before) : -1
  const at = idx === -1 ? without.length : idx
  return { ...k, assignments: [...without.slice(0, at), moved, ...without.slice(at)] }
}

/** Drops assignments of nodes that no longer exist. Returns the SAME object when nothing
 *  changed, so callers can cheaply skip a no-op persist. */
export function pruneAssignments(k: ProjectKanban, liveIds: string[]): ProjectKanban {
  const live = new Set(liveIds)
  const assignments = k.assignments.filter((a) => live.has(a.nodeId))
  const meta = metaList(k).filter((m) => m && live.has(m.nodeId))
  const sameAssignments = assignments.length === k.assignments.length
  const sameMeta = meta.length === metaList(k).length
  if (sameAssignments && sameMeta) return k
  const next: ProjectKanban = { ...k, assignments }
  if (Array.isArray(k.meta)) {
    if (meta.length) next.meta = meta
    else delete next.meta
  }
  return next
}

/** The column a node is assigned to, resolved against a project's board — undefined when
 *  unassigned, dangling (column deleted elsewhere), or the project has no board yet. All
 *  three mean Ungrouped, and the canvas shows no column pill for Ungrouped. */
export function columnForNode(
  k: ProjectKanban | undefined,
  nodeId: string
): KanbanColumn | undefined {
  if (!k) return undefined
  const a = k.assignments.find((x) => x.nodeId === nodeId)
  return a ? k.columns.find((c) => c.id === a.columnId) : undefined
}

// ── Unification: legacy free-text node tags → board labels ────────────────────────────────────

/** Fold each node's free-text tags into board labels: reuse an existing label by name (case-
 *  insensitive) or create one (auto-colored), then apply its id to that card. Pure; the caller
 *  clears the nodes' `tags`. Idempotent by construction (an empty tag list contributes nothing). */
export function migrateTagsToLabels(
  k: ProjectKanban,
  nodeTags: Array<{ nodeId: string; tags: string[] }>
): ProjectKanban {
  let board = k
  for (const { nodeId, tags } of nodeTags) {
    const names = [...new Set(tags.map((t) => t.trim()).filter(Boolean))]
    if (!names.length) continue
    const ids: string[] = []
    for (const name of names) {
      const existing = boardLabels(board).find((l) => l.name.toLowerCase() === name.toLowerCase())
      if (existing) ids.push(existing.id)
      else {
        const res = createLabel(board, name, autoLabelColor(board))
        board = res.k
        ids.push(res.id)
      }
    }
    const cur = cardMeta(board, nodeId)?.labels ?? []
    board = setCardLabels(board, nodeId, [...cur, ...ids])
  }
  return board
}

/**
 * One-time per-project unification, run at workspace hydrate (idempotent — a project whose nodes
 * carry no `tags` is returned UNCHANGED, by identity). For every node with `tags`:
 *  - the legacy `['claude']` MARKER is honored (agentId ← 'claude' when unset) — it was never a
 *    user tag, so it is NOT turned into a label (mirrors nodeStatesToFlow's own claude migration);
 *  - every other tag becomes a board label (reused/created) applied to that card;
 *  - the node's `tags` field is dropped (so the next hydrate is a no-op).
 */
export function migrateProjectTags(project: Project): Project {
  const tagged = project.nodes.filter((n) => Array.isArray(n.tags) && n.tags.length > 0)
  if (!tagged.length) return project
  const nodeTags = tagged
    .map((n) => ({ nodeId: n.id, tags: (n.tags as string[]).filter((t) => t !== 'claude') }))
    .filter((x) => x.tags.length > 0)
  const kanban = migrateTagsToLabels(project.kanban ?? defaultKanban(), nodeTags)
  const nodes: CanvasNodeState[] = project.nodes.map((n) => {
    if (!Array.isArray(n.tags) || !n.tags.length) return n
    const hadClaude = n.tags.includes('claude')
    const { tags: _t, ...rest } = n
    return !n.agentId && hadClaude ? { ...rest, agentId: 'claude' } : rest
  })
  return { ...project, nodes, kanban }
}

// ── Agent-created columns (canvas control `assign --create yes`) ────────────────────────────

/** Longest title `assign --create yes` will create. A longer ref is REFUSED, never truncated:
 *  a truncated title would not match the same ref next time, so every agent filing into that
 *  task would mint another column — the duplicate the whole create path exists to prevent. */
export const AGENT_COLUMN_TITLE_MAX = 120

export function isAgentColumn(c: KanbanColumn): boolean {
  return c.origin === 'agent'
}

export type ColumnRefResolution =
  /** `columnId` null = the virtual Ungrouped column (unassign). */
  | { k: ProjectKanban; columnId: string | null; created: boolean }
  /** No column matches and `create` was off — the caller lists what exists. */
  | { unknown: true }
  | { error: string }

/**
 * `resolveColumnRef`, plus an opt-in create: with `create` on, a ref that matches nothing becomes a
 * new column titled exactly `ref.trim()` and marked `origin: 'agent'`.
 *
 * IDEMPOTENT by construction: the created title is the literal ref, and `resolveColumnRef` matches
 * titles case-insensitively, so the next call with the same ref (from this agent or a sibling
 * filing into the same task) resolves to the column instead of creating another. Concurrency is the
 * CALLER's job and both callers have it — the desktop dispatch runs synchronously against one store,
 * and the Server Edition runs every control write through one serialized queue (`runExclusive`), so
 * two agents creating the same title "at the same moment" still see each other's column.
 *
 * A ref that already names a column — including one a person made — resolves to that column and
 * creates nothing. `ungrouped` keeps its meaning (unassign) even with `create` on.
 */
export function resolveOrCreateColumn(
  k: ProjectKanban,
  ref: string,
  create: boolean
): ColumnRefResolution {
  const hit = resolveColumnRef(k, ref)
  if (hit !== undefined) return { k, columnId: hit, created: false }
  if (!create) return { unknown: true }
  const title = ref.trim()
  // A control character would be stored verbatim (a board title is one line on every surface) and
  // is almost certainly a quoting accident; refusing beats a column nobody can address by title.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(title)) {
    return { error: 'column title must be a single line with no control characters' }
  }
  if (title.length > AGENT_COLUMN_TITLE_MAX) {
    return { error: `column title is longer than ${AGENT_COLUMN_TITLE_MAX} characters` }
  }
  const next = addColumn(k, title, nextColumnColor(k))
  const column = next.columns[next.columns.length - 1]
  return {
    k: { ...next, columns: next.columns.map((c) => (c.id === column.id ? { ...c, origin: 'agent' } : c)) },
    columnId: column.id,
    created: true
  }
}

/**
 * Remove the agent-created columns that THIS transition emptied.
 *
 * A column is emptied when `prev` filed at least one card in it and `next` files none that
 * `stillHolds`. The prev half is the safety property: an agent column that was ALREADY empty is not
 * this change's business (nothing here "went away"), and a column a person made is never touched,
 * however empty — `origin` is the only thing that makes a column removable.
 *
 * Two shapes of caller:
 * - a MOVE (`prev` → `next`, default `stillHolds`): the last card left the column;
 * - a DELETION (`prev === next`, `stillHolds` = "not one of the nodes being removed"): the card is
 *   still filed but its node is gone. Pass the narrowest predicate you can PROVE — the renderer
 *   passes "not in the set I am deleting" rather than "exists on my canvas", because a node the
 *   server has just created may not have reached this canvas yet, and reading that as dead would
 *   delete a live column. The Server Edition, which holds the authoritative node list, passes
 *   existence.
 *
 * Returns `next` itself (same object) when nothing is removed, so callers can skip a no-op write.
 */
export function sweepEmptiedAgentColumns(
  prev: ProjectKanban,
  next: ProjectKanban,
  stillHolds: (nodeId: string) => boolean = () => true
): ProjectKanban {
  let out = next
  for (const c of next.columns) {
    if (!isAgentColumn(c)) continue
    const wasOccupied = prev.assignments.some((a) => a.columnId === c.id)
    if (!wasOccupied) continue
    const stillOccupied = next.assignments.some((a) => a.columnId === c.id && stillHolds(a.nodeId))
    if (!stillOccupied) out = deleteColumn(out, c.id)
  }
  return out
}
