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
  it('the chip is a button that opens the PR on GitHub when the board knows the repository', () => {
    const pulls = pullsForCard(session, pullBoard, { columns: [], assignments: [] }).linked
    const linked = renderToStaticMarkup(
      <SessionCard session={session} onOpen={noop} onDragStart={noop} onDragEnd={noop} onDropAt={noop} onContext={noop}
        pulls={pulls} pullRepository="Adscale-R-D/app_ms" />
    )
    expect(linked).toMatch(/<button type="button" class="[^"]*pull-ref--link[^"]*"/)
    expect(linked).toContain('Open on GitHub')
    // Without a repository (an older host, a hostile value) it stays a plain chip.
    for (const repository of [undefined, 'not a repo', 'a/b/c']) {
      const plain = renderToStaticMarkup(
        <SessionCard session={session} onOpen={noop} onDragStart={noop} onDragEnd={noop} onDropAt={noop} onContext={noop}
          pulls={pulls} pullRepository={repository} />
      )
      expect(plain).not.toContain('<button type="button" class="pull-ref')
      expect(plain).toContain('PR #1045')
    }
  })
  it('shows the review state as an icon with its name for a reader', () => {
    const reviewed = { ...pullBoard, pulls: [{ ...pullBoard.pulls[0], review: 'changes' as const }] }
    const pulls = pullsForCard(session, reviewed, { columns: [], assignments: [] }).linked
    const html = renderToStaticMarkup(
      <SessionCard session={session} onOpen={noop} onDragStart={noop} onDragEnd={noop} onDropAt={noop} onContext={noop} pulls={pulls} />
    )
    expect(html).toContain('pull-review--changes')
    expect(html).toContain('aria-label="Changes requested"')
    expect(html).toContain('<svg')
  })
})
