import { describe, it, expect } from 'vitest'
import { useProjects } from './projects'

describe('setProjectKanban', () => {
  it('sets the board on the target project and carries it through toWorkspace()', () => {
    useProjects.getState().hydrate({
      version: 2,
      activeProjectId: 'p1',
      projects: [{ id: 'p1', name: 'x', color: '#fff', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [] }]
    })
    const board = { columns: [{ id: 'c1', title: 'To Do', color: '#0a84ff' }], assignments: [] }
    useProjects.getState().setProjectKanban('p1', board)
    expect(useProjects.getState().getProject('p1')?.kanban).toEqual(board)
    expect(useProjects.getState().toWorkspace().projects[0].kanban).toEqual(board)
  })

  it('removes an agent-created column the change emptied, and returns the board it STORED', () => {
    const agentCol = { id: 'c2', title: 'Task A', color: '#30d158', origin: 'agent' as const }
    const mine = { id: 'c1', title: 'Mine', color: '#0a84ff' }
    const start = {
      columns: [mine, agentCol],
      assignments: [{ nodeId: 'n1', columnId: 'c2' }]
    }
    useProjects.getState().hydrate({
      version: 2,
      activeProjectId: 'p1',
      projects: [
        { id: 'p1', name: 'x', color: '#fff', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], kanban: start }
      ]
    })
    // A drag of the last card out of the agent column (to the hand-made one).
    const next = { ...start, assignments: [{ nodeId: 'n1', columnId: 'c1' }] }
    const stored = useProjects.getState().setProjectKanban('p1', next)
    expect(stored.columns).toEqual([mine])
    expect(useProjects.getState().getProject('p1')?.kanban).toEqual(stored)
    // …while emptying a HAND-MADE column stores the argument untouched.
    const emptied = { ...stored, assignments: [] }
    expect(useProjects.getState().setProjectKanban('p1', emptied)).toBe(emptied)
  })
})
