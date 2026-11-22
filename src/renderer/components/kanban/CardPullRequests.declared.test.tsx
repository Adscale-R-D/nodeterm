// The card modal's "Pull requests" section lists a principal-DECLARED PR like a branch link, and a
// person's unlink still wins. Rendered with react-dom/server (jsdom does not start on every host).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ProjectKanban } from '@shared/types'
import type { GitHubPullBoard } from '@shared/github-pull-status'
import { unlinkPull } from '@shared/kanban-pull-links'
import { CardPullRequests } from './CardPullRequests'
import type { KanbanSession } from './KanbanView'

// Server rendering reads a zustand store's INITIAL state, so the three stores are replaced by plain
// selectors over this one object.
const world: { projects: unknown; github: unknown } = { projects: {}, github: {} }
vi.mock('../../state/projects', () => ({ useProjects: (sel: (s: unknown) => unknown) => sel(world.projects) }))
vi.mock('../../state/githubIssues', () => ({ useGitHubIssues: (sel: (s: unknown) => unknown) => sel(world.github) }))
vi.mock('../../state/settings', () => ({ useSettings: (sel: (s: unknown) => unknown) => sel({ settings: {} }) }))
vi.mock('../../session/owning-project', () => ({ useOwningProjectId: () => undefined }))

const board: ProjectKanban = {
  columns: [{ id: 'done', title: 'Done', color: '#fff' }],
  assignments: [],
  github: { columnMappings: [], repository: 'o/r' }
}
const session: KanbanSession = { id: 'sink-1', title: 'review', color: '#fff', kind: 'terminal', spawn: {} }

function setPullBoard(pullBoard: GitHubPullBoard, ssh = false): void {
  world.projects = {
    activeProjectId: 'p1',
    projects: [{ id: 'p1', nodes: [], ...(ssh ? { ssh: { remoteCwd: '~' } } : {}) }]
  }
  world.github = { projects: { p1: { pullBoard } } }
}

const base: GitHubPullBoard = {
  repository: 'o/r',
  pulls: [{ number: 1045, lifecycle: 'open', headRefName: 'x', headRefOid: 'a'.repeat(40), ci: 'failed', closes: [] }],
  declared: [{ nodeId: 'sink-1', pulls: [1045] }],
  observedAt: 1, stale: false, access: { ci: true, merge: true }, undecided: false, truncated: false
}

const render = (k: ProjectKanban = board): string =>
  renderToStaticMarkup(<CardPullRequests session={session} board={k} onChangeBoard={() => {}} />)

beforeEach(() => setPullBoard(base))

describe('CardPullRequests — declared', () => {
  it('lists the declared PR with its state, on a card with no worktree and no issue', () => {
    const html = render()
    expect(html).toContain('declared #1045')
    expect(html).toContain('PR #1045')
    expect(html).toContain('Unlink')
  })

  it('also on an SSH project (a declared link needs no worktree)', () => {
    setPullBoard(base, true)
    expect(render()).toContain('PR #1045')
  })

  it('a person\'s unlink wins: offered back as "Link again"', () => {
    const html = render(unlinkPull(board, 'sink-1', 1045))
    expect(html).toContain('(unlinked)')
    expect(html).toContain('Link again')
  })

  it('a declared PR not read yet says so instead of disappearing', () => {
    setPullBoard({ ...base, pulls: [] })
    expect(render()).toContain('has not been read yet')
  })

  it('a board WITHOUT GitHub sync shows declared PRs from the declared-only board (no auto-move offer)', () => {
    const { github: _g, ...unsynced } = board
    world.github = { projects: {}, declaredBoards: { p1: base } }
    const html = render(unsynced)
    expect(html).toContain('PR #1045')
    expect(html).not.toContain('when its pull requests merge')
    world.github = { projects: {}, declaredBoards: {} }
    expect(render(unsynced)).toBe('')
  })

  it('nothing declared, no branch, no issue: no section', () => {
    setPullBoard({ ...base, declared: undefined })
    expect(render()).toBe('')
  })
})
