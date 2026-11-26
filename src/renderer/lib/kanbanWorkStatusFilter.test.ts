import { describe, expect, it } from 'vitest'
import { matchesWorkStatus, workStatusByCard, workStatusCounts } from './kanbanWorkStatusFilter'

const cards = [
  { id: 'a', kind: 'terminal', workStatus: { kind: 'ready', at: 1 } },
  { id: 'b', kind: 'terminal', workStatus: { kind: 'waiting', at: 1 } },
  { id: 'c', kind: 'terminal' },
  { id: 'd', kind: 'terminal', workStatus: { kind: 'bogus', at: 1 } },
  { id: 'e', kind: 'sticky', workStatus: { kind: 'ready', at: 1 } }
]

describe('work-status filter', () => {
  it('counts only well-formed statuses on session cards', () => {
    const by = workStatusByCard(cards)
    expect([...by]).toEqual([
      ['a', 'ready'],
      ['b', 'waiting']
    ])
    expect(workStatusCounts(by)).toEqual({ clarifying: 0, planning: 0, implementing: 0, review: 0, waiting: 1, ready: 1, blocked: 0 })
  })

  it('no filter shows everything; a filter shows only its kinds (OR within)', () => {
    const by = workStatusByCard(cards)
    expect(cards.filter((c) => matchesWorkStatus(by, c.id, [])).map((c) => c.id)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(cards.filter((c) => matchesWorkStatus(by, c.id, ['ready'])).map((c) => c.id)).toEqual(['a'])
    expect(cards.filter((c) => matchesWorkStatus(by, c.id, ['ready', 'waiting'])).map((c) => c.id)).toEqual(['a', 'b'])
  })
})
