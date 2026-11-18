// Fork patch #6: the Server Edition's creator ledger, durable (headless-node-factory.ts
// `createHeadlessNodeOwnership(file)`).
import { describe, it, expect } from 'vitest'
import {
  createHeadlessNodeOwnership,
  sanitizeHeadlessOwnerRecord,
  type HeadlessOwnerRecord
} from './headless-node-factory'

function file(initial: HeadlessOwnerRecord[] = []) {
  let disk = initial
  const saves: HeadlessOwnerRecord[][] = []
  return {
    load: () => disk,
    save: (rows: readonly HeadlessOwnerRecord[]) => {
      disk = [...rows]
      saves.push(disk)
    },
    saves,
    disk: () => disk
  }
}

describe('durable creator ledger', () => {
  it('a row written in one run is the creator answer in the next, but not "spawned this run"', () => {
    const f = file()
    const a = createHeadlessNodeOwnership(f, () => 10)
    a.record('child-1', { sourceNodeId: 'boss', projectId: 'p1' })
    expect(a.spawnedThisRun?.('child-1')).toBe(true)
    a.clear() // stop(): memory only
    expect(f.disk()).toHaveLength(1)
    const b = createHeadlessNodeOwnership(f)
    expect(b.ownerOf('child-1')).toEqual({ sourceNodeId: 'boss', projectId: 'p1' })
    expect(b.spawnedThisRun?.('child-1')).toBe(false)
  })

  it('forget deletes the row; a re-record replaces it', () => {
    const f = file()
    const o = createHeadlessNodeOwnership(f)
    o.record('c', { sourceNodeId: 'a', projectId: 'p' })
    o.record('c', { sourceNodeId: 'b', projectId: 'p' })
    expect(f.disk()).toEqual([expect.objectContaining({ nodeId: 'c', sourceNodeId: 'b' })])
    o.forget('c')
    expect(f.disk()).toEqual([])
    expect(o.ownerOf('c')).toBeUndefined()
  })

  it('pruneTo drops rows of nodes no project holds', () => {
    const f = file([
      { nodeId: 'keep', sourceNodeId: 's', projectId: 'p', at: 1 },
      { nodeId: 'gone', sourceNodeId: 's', projectId: 'p', at: 2 }
    ])
    const o = createHeadlessNodeOwnership(f)
    o.pruneTo?.(new Set(['keep']))
    expect(f.disk().map((r) => r.nodeId)).toEqual(['keep'])
    o.pruneTo?.(new Set(['keep']))
    expect(f.saves).toHaveLength(1)
  })

  it('without a file it is process-local, as before', () => {
    const o = createHeadlessNodeOwnership()
    o.record('c', { sourceNodeId: 'a', projectId: 'p' })
    o.clear()
    expect(createHeadlessNodeOwnership().ownerOf('c')).toBeUndefined()
  })

  it('drops a hostile row', () => {
    expect(sanitizeHeadlessOwnerRecord({ nodeId: 'c', sourceNodeId: 'a', projectId: 'p', at: 1 })).not.toBeNull()
    for (const bad of [
      { nodeId: '../c', sourceNodeId: 'a', projectId: 'p', at: 1 },
      { nodeId: 'c', sourceNodeId: '', projectId: 'p', at: 1 },
      { nodeId: 'c', sourceNodeId: 'a', projectId: '', at: 1 },
      { nodeId: 'c', sourceNodeId: 'a', projectId: 'p' },
      null
    ])
      expect(sanitizeHeadlessOwnerRecord(bad)).toBeNull()
  })
})
