/**
 * The frame-inheritance walk. Its second consumer is the canvas-control `verify` verb, which was
 * reported opening reviewers in the PROJECT root while the code under review sat in a worktree —
 * so the cases below are the ones that failure turned on: a target with no cwd of its own, a nested
 * frame, and the SSH/stale exclusions that must never hand out a worktree path.
 */
import { describe, it, expect } from 'vitest'
import { resolveInheritedCwd, type CwdChainNode } from './nodeCwd'

const plain = (id: string, parentId?: string): CwdChainNode => ({ id, parentId, data: {} })
const withCwd = (id: string, cwd: string, parentId?: string): CwdChainNode => ({
  id,
  parentId,
  data: { cwd }
})
const worktree = (id: string, path: string, parentId?: string): CwdChainNode => ({
  id,
  parentId,
  data: { worktree: { path } }
})
const opts = { staleGroupIds: [] as string[], isSshProject: false }

describe('resolveInheritedCwd', () => {
  it('takes the worktree of the frame the node sits in', () => {
    const nodes = [worktree('g1', '/repo.worktrees/feat'), plain('n1', 'g1')]
    expect(resolveInheritedCwd(nodes, 'g1', opts)).toBe('/repo.worktrees/feat')
  })

  it('walks UP through a nested frame to the worktree — frames nest', () => {
    const nodes = [worktree('g1', '/wt/feat'), plain('g2', 'g1'), plain('n1', 'g2')]
    expect(resolveInheritedCwd(nodes, 'g2', opts)).toBe('/wt/feat')
  })

  it('prefers the NEAREST statement — an inner frame cwd beats an outer worktree', () => {
    const nodes = [worktree('g1', '/wt/feat'), withCwd('g2', '/elsewhere', 'g1')]
    expect(resolveInheritedCwd(nodes, 'g2', opts)).toBe('/elsewhere')
  })

  it('answers undefined at the top level, so the caller can fall back to the project cwd', () => {
    expect(resolveInheritedCwd([plain('n1')], undefined, opts)).toBeUndefined()
  })

  it('never hands out a STALE worktree path — its directory is gone', () => {
    const nodes = [worktree('g1', '/wt/deleted'), plain('n1', 'g1')]
    expect(resolveInheritedCwd(nodes, 'g1', { ...opts, staleGroupIds: ['g1'] })).toBeUndefined()
  })

  it('never hands out a worktree path on an SSH project — worktrees are local-only in v1', () => {
    const nodes = [worktree('g1', '/wt/feat'), plain('n1', 'g1')]
    expect(resolveInheritedCwd(nodes, 'g1', { ...opts, isSshProject: true })).toBeUndefined()
  })

  it('terminates on a parent cycle instead of hanging the render', () => {
    // reparentNode refuses to build one, but this walks whatever is on the canvas — including a
    // hand-edited project.json.
    const nodes: CwdChainNode[] = [
      { id: 'a', parentId: 'b', data: {} },
      { id: 'b', parentId: 'a', data: {} }
    ]
    expect(resolveInheritedCwd(nodes, 'a', opts)).toBeUndefined()
  })

  it('stops at a parent that is not on the canvas', () => {
    expect(resolveInheritedCwd([plain('n1', 'ghost')], 'ghost', opts)).toBeUndefined()
  })
})
