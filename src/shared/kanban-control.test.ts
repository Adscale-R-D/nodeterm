import { describe, expect, it } from 'vitest'
import type { ProjectKanban } from './types'
import { boardSnapshot, persistedControlCard, stickyCardTitle, wantsCreate } from './kanban-control'

describe('persistedControlCard — the same kinds and labels the board shows', () => {
  it('maps terminal, sticky and browser nodes; nothing else is a card', () => {
    expect(persistedControlCard({ id: 't', kind: 'terminal', title: 'Build' })).toEqual({ id: 't', title: 'Build' })
    expect(persistedControlCard({ id: 'u', kind: 'terminal' })).toEqual({ id: 'u', title: '' })
    // A persisted node with no kind is a terminal (nodeStatesToFlow's backward-compat default).
    expect(persistedControlCard({ id: 'l', title: 'Legacy' })).toEqual({ id: 'l', title: 'Legacy' })
    expect(persistedControlCard({ id: 's', kind: 'sticky', text: '# Plan\nsteps' })).toEqual({ id: 's', title: 'Plan' })
    expect(persistedControlCard({ id: 'b', kind: 'browser' })).toEqual({ id: 'b', title: 'Browser' })
    for (const kind of ['group', 'editor', 'diff', 'files', 'trigger', 'dino']) {
      expect(persistedControlCard({ id: 'x', kind })).toBeNull()
    }
  })

  it('a note with no text is labelled Note', () => {
    expect(stickyCardTitle('   ')).toBe('Note')
  })
})

describe('wantsCreate', () => {
  it('takes a value, never bare presence', () => {
    for (const v of ['yes', 'YES', 'true', '1']) expect(wantsCreate(v)).toBe(true)
    for (const v of [undefined, '', 'no', 'false', '0']) expect(wantsCreate(v)).toBe(false)
  })
})

describe('boardSnapshot', () => {
  const cards = [
    { id: 'a', title: 'Alpha' },
    { id: 'b', title: '' },
    { id: 'c', title: 'Gamma' }
  ]

  it('answers the lazy default with every card Ungrouped', () => {
    const snap = boardSnapshot(undefined, cards)
    expect(snap.result).toEqual({ columns: [], ungrouped: ['a', 'b', 'c'] })
    expect(snap.message).toContain('Untitled (id: b)')
  })

  it('lists columns with their live cards, flags agent columns, and drops dangling assignments', () => {
    const k: ProjectKanban = {
      columns: [
        { id: 'k1', title: 'Mine', color: '#fff' },
        { id: 'k2', title: 'Task A', color: '#fff', origin: 'agent' }
      ],
      assignments: [
        { nodeId: 'a', columnId: 'k2' },
        { nodeId: 'gone', columnId: 'k2' },
        { nodeId: 'c', columnId: 'k1' }
      ]
    }
    const snap = boardSnapshot(k, cards)
    expect(snap.result).toEqual({
      columns: [
        { id: 'k1', title: 'Mine', cards: ['c'] },
        { id: 'k2', title: 'Task A', cards: ['a'], origin: 'agent' }
      ],
      ungrouped: ['b']
    })
    expect(snap.message).toContain('Task A (1) [column id: k2] (agent-created):')
    expect(snap.message).toContain('Mine (1) [column id: k1]:')
  })
})
