// Principal-declared PR links (docs/integration-principal.md): the board's third link source.
import { describe, expect, it } from 'vitest'
import type { ProjectKanban } from './types'
import type { GitHubPullBoard, GitHubPullStatus } from './github-pull-status'
import { unlinkPull } from './kanban-pull-links'
import { declaredPullsFor, pullsForCard } from './pull-card-links'

const pull = (number: number, over: Partial<GitHubPullStatus> = {}): GitHubPullStatus =>
  ({ number, lifecycle: 'open', headRefName: `feat/${number}`, closes: [], ...over })

const pullBoard = (declared?: GitHubPullBoard['declared']): GitHubPullBoard => ({
  repository: 'Adscale-R-D/app_ms',
  pulls: [
    pull(10, { headRefName: 'feat/wt' }),
    pull(20, { closes: [7] }),
    pull(1045, { crossRepository: true, headRefName: 'someone:main' }),
    pull(900, { lifecycle: 'merged' })
  ],
  stale: false,
  access: { ci: true, merge: true },
  undecided: false,
  truncated: false,
  ...(declared ? { declared } : {})
})

const board: ProjectKanban = { columns: [], assignments: [] }
const numbers = (list: GitHubPullStatus[]): number[] => list.map((p) => p.number).sort((a, b) => a - b)

describe('pullsForCard — declared links', () => {
  it('a card with only declared links (no branch, no issue) gets them, a fork PR included', () => {
    const links = pullsForCard({ id: 'sink-1' }, pullBoard([{ nodeId: 'sink-1', pulls: [1045, 900] }]), board)
    expect(numbers(links.linked)).toEqual([900, 1045])
  })

  it('declared ∪ branch ∪ issue', () => {
    const links = pullsForCard(
      { id: 'c', worktreeBranch: 'feat/wt', issueRef: { owner: 'Adscale-R-D', repo: 'app_ms', number: 7 } },
      pullBoard([{ nodeId: 'c', pulls: [900] }]),
      board
    )
    expect(numbers(links.linked)).toEqual([10, 20, 900])
  })

  it('another card\'s declarations do not leak, and a declared number the board has not read is not shown', () => {
    const pb = pullBoard([{ nodeId: 'other', pulls: [1045] }, { nodeId: 'c', pulls: [55] }])
    expect(pullsForCard({ id: 'c' }, pb, board).linked).toEqual([])
    expect([...declaredPullsFor('c', pb)]).toEqual([55])
  })

  it('a user\'s unlink tombstone wins over a declaration', () => {
    const pb = pullBoard([{ nodeId: 'c', pulls: [1045, 900] }])
    const links = pullsForCard({ id: 'c' }, pb, unlinkPull(board, 'c', 1045))
    expect(numbers(links.linked)).toEqual([900])
    expect(numbers(links.unlinked)).toEqual([1045])
  })

  it('no declarations (a closed key\'s links are gone from the board): nothing', () => {
    expect(pullsForCard({ id: 'c' }, pullBoard(), board)).toEqual({ linked: [], unlinked: [] })
    expect(pullsForCard({ id: 'c' }, undefined, board)).toEqual({ linked: [], unlinked: [] })
  })
})
