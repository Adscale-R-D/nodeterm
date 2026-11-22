// A session card with a principal-DECLARED pull request shows the same PullRefChip a branch link
// does. Rendered with react-dom/server: jsdom does not start on every host this suite runs on.
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { GitHubPullBoard } from '@shared/github-pull-status'
import { pullsForCard } from '../../lib/pullLinks'
import { SessionCard } from './SessionCard'
import type { KanbanSession } from './KanbanView'

vi.mock('../ContextMeter', () => ({ ContextMeter: () => null }))

const session: KanbanSession = { id: 'sink-1', title: 'PR #1045 review', color: '#fff', kind: 'terminal', spawn: {} }

const pullBoard: GitHubPullBoard = {
  repository: 'Adscale-R-D/app_ms',
  pulls: [{ number: 1045, lifecycle: 'open', headRefName: 'feat/x', headRefOid: 'a'.repeat(40), ci: 'passed', merge: 'ready', closes: [] }],
  declared: [{ nodeId: 'sink-1', pulls: [1045] }],
  observedAt: 1, stale: false, access: { ci: true, merge: true }, undecided: false, truncated: false
}

const noop = (): void => {}

describe('SessionCard — declared pull request', () => {
  it('shows PullRefChip for a declared PR (the card has no worktree branch and no issue)', () => {
    const pulls = pullsForCard(session, pullBoard, { columns: [], assignments: [] }).linked
    expect(pulls.map((p) => p.number)).toEqual([1045])
    const html = renderToStaticMarkup(
      <SessionCard session={session} onOpen={noop} onDragStart={noop} onDragEnd={noop} onDropAt={noop} onContext={noop} pulls={pulls} />
    )
    expect(html).toContain('PR #1045')
    expect(html).toContain('pull-ref')
  })
})
