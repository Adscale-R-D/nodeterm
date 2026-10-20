import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * STRUCTURAL pins for agent-created kanban columns on the desktop side: the delete funnels and the
 * `board` / `assign` control verbs live inside Canvas.tsx's 12,000-line component with no unit seam.
 * The behaviour itself is proven against the real transforms in `@shared/kanban-agent-columns.test`,
 * `@shared/kanban-control.test`, `state/projects.kanban.test` (the setProjectKanban choke point) and,
 * for the Server Edition, `server/headless-node-factory.kanban.test`. What these pin is WIRING —
 * the part a refactor drops without any behavioural test noticing.
 */
const src = readFileSync(new URL('./Canvas.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

function body(start: string, end: string): string {
  const i = src.indexOf(start)
  expect(i, start).toBeGreaterThan(-1)
  const j = src.indexOf(end, i + start.length)
  expect(j, end).toBeGreaterThan(i)
  return src.slice(i, j)
}

describe('agent-created kanban columns (Canvas source pins)', () => {
  it('BOTH delete funnels sweep, passing exactly the set they remove', () => {
    const del = body('const deleteNodes = useCallback(', '/** `canvas.deleteSelection`')
    expect(del).toContain("sweepAgentColumnsForRemoval(useProjects.getState().activeProjectId ?? '', set)")
    const stored = body('const closeStoredNodes = useCallback(', '// Close (end) a session.')
    expect(stored).toContain('sweepAgentColumnsForRemoval(projectId, new Set(ids))')
  })

  it('the removal sweep judges "gone" by the removed set, never by absence from this canvas', () => {
    // A node the Server Edition just created may not have reached this canvas yet; reading its
    // absence as death would delete a live lane's column. See the helper's comment.
    const helper = body('const sweepAgentColumnsForRemoval = useCallback(', 'const deleteNodes = useCallback(')
    expect(helper).toContain('sweepEmptiedAgentColumns(board, board, (id) => !removed.has(id))')
    expect(helper).not.toContain('nodesRef')
  })

  it('`board` answers through the shared snapshot, so both shells share one reply shape', () => {
    const board = body("case 'board': {", "case 'assign': {")
    expect(board).toContain('boardVerbReply(ctlProject?.kanban, sessions)')
    // boardVerbReply (upstream's name, also used by `board --project`) must stay a thin delegate.
    const verb = readFileSync(new URL('../lib/boardVerb.ts', import.meta.url), 'utf8')
    expect(verb).toContain('return boardSnapshot(')
  })

  it('`assign` honours --create and narrates the board setProjectKanban actually STORED', () => {
    const assign = body("case 'assign': {", 'default:')
    expect(assign).toContain('resolveOrCreateColumn(prev, rawCol, wantsCreate(args.create))')
    expect(assign).toMatch(/const next = store\.setProjectKanban\(/)
    expect(assign).toContain('boardLogEvents(prev, next, cardTitle)')
  })
})
