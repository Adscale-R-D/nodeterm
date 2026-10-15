import { describe, expect, it } from 'vitest'
import type { ProjectKanban } from './types'
import {
  AGENT_COLUMN_TITLE_MAX,
  assignNode,
  defaultKanban,
  resolveOrCreateColumn,
  sweepEmptiedAgentColumns
} from './kanban'

// Agent-created columns (`assign --create yes`) and their automatic removal. The removal rule is
// the dangerous half — a column a person made must never disappear — so most of these cases are
// about what the sweep must NOT do.

const board = (): ProjectKanban => ({
  columns: [
    { id: 'kcol-mine', title: 'Mine', color: '#0a84ff' },
    { id: 'kcol-agent', title: 'Task A', color: '#30d158', origin: 'agent' }
  ],
  assignments: [
    { nodeId: 'n1', columnId: 'kcol-agent' },
    { nodeId: 'n2', columnId: 'kcol-mine' }
  ]
})

const created = (r: ReturnType<typeof resolveOrCreateColumn>) => {
  if (!('k' in r)) throw new Error(`expected a resolution, got ${JSON.stringify(r)}`)
  return r
}

describe('resolveOrCreateColumn', () => {
  it('resolves an existing column by title (case-insensitive) or id, creating nothing', () => {
    const k = board()
    expect(created(resolveOrCreateColumn(k, 'task a', true))).toEqual({ k, columnId: 'kcol-agent', created: false })
    expect(created(resolveOrCreateColumn(k, 'kcol-mine', true))).toEqual({ k, columnId: 'kcol-mine', created: false })
  })

  it('a title that names a HAND-MADE column files into it — create never shadows a person’s column', () => {
    const r = created(resolveOrCreateColumn(board(), 'MINE', true))
    expect(r.columnId).toBe('kcol-mine')
    expect(r.created).toBe(false)
  })

  it('keeps `ungrouped` meaning unassign, even with create on', () => {
    expect(created(resolveOrCreateColumn(board(), 'Ungrouped', true)).columnId).toBeNull()
    expect(created(resolveOrCreateColumn(board(), '', true)).columnId).toBeNull()
  })

  it('without create, an unknown title is `unknown` — the caller lists the columns', () => {
    expect(resolveOrCreateColumn(board(), 'Task Z', false)).toEqual({ unknown: true })
  })

  it('creates an agent column titled with the trimmed ref, and is idempotent on the result', () => {
    const r = created(resolveOrCreateColumn(board(), '  Task Z  ', true))
    expect(r.created).toBe(true)
    const col = r.k.columns.find((c) => c.id === r.columnId)!
    expect(col).toMatchObject({ title: 'Task Z', origin: 'agent' })
    // The next agent filing into the same task resolves to that column.
    const again = created(resolveOrCreateColumn(r.k, 'task z', true))
    expect(again).toEqual({ k: r.k, columnId: r.columnId, created: false })
  })

  it('REFUSES rather than truncates an over-long title (a truncated title would duplicate forever)', () => {
    const long = 'x'.repeat(AGENT_COLUMN_TITLE_MAX + 1)
    expect(resolveOrCreateColumn(board(), long, true)).toEqual({ error: expect.stringContaining('longer than') })
    expect(created(resolveOrCreateColumn(board(), 'x'.repeat(AGENT_COLUMN_TITLE_MAX), true)).created).toBe(true)
  })

  it('refuses a title carrying a control character', () => {
    expect(resolveOrCreateColumn(board(), 'Task\nA2', true)).toEqual({ error: expect.stringContaining('single line') })
  })

  it('keeps a GitHub column mapping in step for a created column (addColumn does the bookkeeping)', () => {
    const k: ProjectKanban = { ...defaultKanban('p1'), github: { columnMappings: [] } as never }
    const r = created(resolveOrCreateColumn(k, 'Task A', true))
    expect(r.k.github!.columnMappings).toEqual([{ columnId: r.columnId, label: 'status:task-a' }])
  })
})

describe('sweepEmptiedAgentColumns', () => {
  it('removes an agent column when its last card moves out', () => {
    const prev = board()
    const next = assignNode(prev, 'n1', 'kcol-mine', null)
    const swept = sweepEmptiedAgentColumns(prev, next)
    expect(swept.columns.map((c) => c.id)).toEqual(['kcol-mine'])
  })

  it('NEVER removes a hand-made column, however it empties', () => {
    const prev = board()
    const next = assignNode(prev, 'n2', null, null)
    expect(sweepEmptiedAgentColumns(prev, next)).toBe(next)
    expect(sweepEmptiedAgentColumns(prev, prev, (id) => id !== 'n2')).toBe(prev)
  })

  it('keeps an agent column that still holds a card', () => {
    const prev: ProjectKanban = {
      ...board(),
      assignments: [...board().assignments, { nodeId: 'n3', columnId: 'kcol-agent' }]
    }
    const next = assignNode(prev, 'n1', null, null)
    expect(sweepEmptiedAgentColumns(prev, next)).toBe(next)
  })

  it('leaves an agent column that was ALREADY empty — nothing went away in this change', () => {
    const k: ProjectKanban = { ...board(), assignments: [] }
    expect(sweepEmptiedAgentColumns(k, k, () => false)).toBe(k)
  })

  it('deletion shape: removes the column when every card in it is one being removed', () => {
    const k = board()
    const swept = sweepEmptiedAgentColumns(k, k, (id) => id !== 'n1')
    expect(swept.columns.map((c) => c.id)).toEqual(['kcol-mine'])
    expect(swept.assignments).toEqual([{ nodeId: 'n2', columnId: 'kcol-mine' }])
  })

  it('returns the SAME object when nothing is swept, so callers can skip the write', () => {
    const k = board()
    expect(sweepEmptiedAgentColumns(k, k)).toBe(k)
  })
})

describe('live board sync carries the agent marker (kanban-ops column allowlist)', () => {
  it('keeps origin: agent on a column op, and drops any other origin value', async () => {
    const { sanitizeKanbanOp } = await import('./kanban-ops')
    const agent = sanitizeKanbanOp({
      op: 'kb-column',
      column: { id: 'kcol-a', title: 'Task A', color: '#fff', origin: 'agent' }
    })
    expect(agent).toMatchObject({ op: 'kb-column', column: { origin: 'agent' } })
    // A closed value: anything else is not a marker this build knows, so a peer never acts on it.
    const other = sanitizeKanbanOp({
      op: 'kb-column',
      column: { id: 'kcol-b', title: 'Mine', color: '#fff', origin: 'robot' }
    }) as unknown as { column: Record<string, unknown> }
    expect(other.column).not.toHaveProperty('origin')
  })
})
