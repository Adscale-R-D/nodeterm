// Fork patch #6: the durable pane-owner rows (pane-ownership.ts "DURABLE ROWS").
import { describe, it, expect, beforeEach } from 'vitest'
import {
  attachPaneOwnershipStore,
  forgetPaneOwner,
  hasPaneOwnerRow,
  isPaneStamp,
  paneOwnerProject,
  paneRowVerdict,
  persistFreshSpawnStamp,
  recordFreshSpawnOwner,
  reprovePaneOwners,
  resetPaneOwnershipForTests,
  sanitizePaneOwnerRecord,
  setPaneOwnerMissHook,
  type PaneOwnerRecord
} from './pane-ownership'

const A = '$3|1795005377|443794'
const B = '$4|1795005377|443794'

function store(rows: PaneOwnerRecord[] = []): { saves: PaneOwnerRecord[][]; last(): PaneOwnerRecord[] } {
  const saves: PaneOwnerRecord[][] = []
  attachPaneOwnershipStore({ load: () => rows, save: (r) => saves.push([...r]) })
  return { saves, last: () => saves[saves.length - 1] ?? rows }
}

beforeEach(() => resetPaneOwnershipForTests())

describe('pane stamp + record shape', () => {
  it('accepts only a fully expanded stamp', () => {
    expect(isPaneStamp(A)).toBe(true)
    for (const bad of ['', '||', '$1||9', '|1795005377|1', '$1|x|1', `${A}\n`, 5, null]) expect(isPaneStamp(bad)).toBe(false)
  })

  it('drops a hostile or incomplete row', () => {
    expect(sanitizePaneOwnerRecord({ nodeId: 'n1', ownerProjectId: 'p', stamp: A, at: 1 })).not.toBeNull()
    for (const bad of [
      { nodeId: '../x', ownerProjectId: 'p', stamp: A, at: 1 },
      { nodeId: 'n1', ownerProjectId: '', stamp: A, at: 1 },
      { nodeId: 'n1', ownerProjectId: 'p', stamp: '', at: 1 },
      { nodeId: 'n1', ownerProjectId: 'p', stamp: A, at: Number.NaN },
      [],
      'x'
    ])
      expect(sanitizePaneOwnerRecord(bad)).toBeNull()
  })
})

describe('writing rows', () => {
  it('a fresh spawn writes its row once the stamp is read', () => {
    const s = store()
    const gen = recordFreshSpawnOwner('n1', 'p1')!
    persistFreshSpawnStamp('n1', 'p1', gen, A)
    expect(s.last()).toEqual([expect.objectContaining({ nodeId: 'n1', ownerProjectId: 'p1', stamp: A })])
  })

  it('a stamp read that lands after the pane ended or changed hands writes nothing', () => {
    const s = store()
    const gen = recordFreshSpawnOwner('n1', 'p1')!
    forgetPaneOwner('n1')
    persistFreshSpawnStamp('n1', 'p1', gen, A)
    const gen2 = recordFreshSpawnOwner('n2', 'p1')!
    recordFreshSpawnOwner('n2', 'p2')
    persistFreshSpawnStamp('n2', 'p1', gen2, A)
    expect(s.last()).toEqual([])
  })

  it('an unreadable stamp writes no row (the pane is simply not durable)', () => {
    const s = store()
    persistFreshSpawnStamp('n1', 'p1', recordFreshSpawnOwner('n1', 'p1')!, null)
    expect(s.saves).toEqual([])
  })

  it('a fresh spawn over an old row drops it first; forget deletes the row', () => {
    const s = store([{ nodeId: 'n1', ownerProjectId: 'p-old', stamp: A, at: 1 }])
    recordFreshSpawnOwner('n1', 'p1')
    expect(s.last()).toEqual([])
    expect(hasPaneOwnerRow('n1')).toBe(false)
    persistFreshSpawnStamp('n1', 'p1', recordFreshSpawnOwner('n1', 'p1')!, B)
    forgetPaneOwner('n1')
    expect(s.last()).toEqual([])
  })
})

describe('re-proving rows', () => {
  it('restores the row owner only for a byte-identical stamp', () => {
    store([{ nodeId: 'n1', ownerProjectId: 'p1', stamp: A, at: 1 }])
    expect(paneOwnerProject('n1')).toBeUndefined()
    expect(reprovePaneOwners(() => A)).toEqual(['n1'])
    expect(paneOwnerProject('n1')).toBe('p1')
    expect(paneRowVerdict('n1')).toBe('proven')
  })

  it('a different stamp (same name recreated) or an absent session drops the row', () => {
    const s = store([
      { nodeId: 'n1', ownerProjectId: 'p1', stamp: A, at: 1 },
      { nodeId: 'n2', ownerProjectId: 'p1', stamp: A, at: 2 }
    ])
    expect(reprovePaneOwners((id) => (id === 'n1' ? B : 'absent'))).toEqual([])
    expect(paneOwnerProject('n1')).toBeUndefined()
    expect(paneOwnerProject('n2')).toBeUndefined()
    expect(paneRowVerdict('n1')).toBe('refuted')
    expect(s.last()).toEqual([])
  })

  it('an unreadable answer changes nothing and keeps the row', () => {
    const s = store([{ nodeId: 'n1', ownerProjectId: 'p1', stamp: A, at: 1 }])
    expect(reprovePaneOwners(() => null)).toEqual([])
    expect(paneOwnerProject('n1')).toBeUndefined()
    expect(paneRowVerdict('n1')).toBe('none')
    expect(s.saves).toEqual([])
    expect(reprovePaneOwners(() => A)).toEqual(['n1'])
  })

  it('never overrides an owner this run recorded, and never takes a malformed live value', () => {
    store([{ nodeId: 'n1', ownerProjectId: 'p-row', stamp: A, at: 1 }])
    recordFreshSpawnOwner('n9', 'p-now')
    expect(reprovePaneOwners(() => '')).toEqual([])
    expect(paneRowVerdict('n1')).toBe('refuted')
    expect(paneOwnerProject('n9')).toBe('p-now')
  })

  it('`only` limits the check to the named nodes', () => {
    store([
      { nodeId: 'n1', ownerProjectId: 'p1', stamp: A, at: 1 },
      { nodeId: 'n2', ownerProjectId: 'p1', stamp: A, at: 2 }
    ])
    expect(reprovePaneOwners(() => A, ['n2'])).toEqual(['n2'])
    expect(paneOwnerProject('n1')).toBeUndefined()
  })

  it('a gate that meets an unproven pane with a row asks for a re-proof; without a row it does not', () => {
    store([{ nodeId: 'n1', ownerProjectId: 'p1', stamp: A, at: 1 }])
    const asked: string[] = []
    setPaneOwnerMissHook((id) => asked.push(id))
    paneOwnerProject('n1')
    paneOwnerProject('n-unknown')
    reprovePaneOwners(() => A)
    paneOwnerProject('n1')
    expect(asked).toEqual(['n1'])
  })

  it('with no store attached (a second instance) nothing is durable', () => {
    persistFreshSpawnStamp('n1', 'p1', recordFreshSpawnOwner('n1', 'p1')!, A)
    expect(hasPaneOwnerRow('n1')).toBe(false)
    expect(reprovePaneOwners(() => A)).toEqual([])
  })
})
