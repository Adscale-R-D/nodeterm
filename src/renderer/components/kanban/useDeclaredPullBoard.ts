// The pull board of a kanban board WITHOUT GitHub sync (docs/integration-principal.md, "Declared pull
// requests"): only the PRs an integration principal declared on its cards. No GitHub lane, no
// harvest. The host reads those PRs one by one, at most once a minute, and only while a board asks;
// this asks every `DECLARED_POLL_MS` while the board is mounted and the page is visible. A board that
// IS synced reads the full pull board through its subscription instead and never runs this.
import { useEffect } from 'react'
import type { GitHubIssuesApi } from '@shared/github-issues'
import type { GitHubPullBoard } from '@shared/github-pull-status'
import { useGitHubIssues } from '../../state/githubIssues'

export const DECLARED_POLL_MS = 30_000

export function useDeclaredPullBoard(
  api: Pick<GitHubIssuesApi, 'pullStatus'> | undefined,
  projectId: string | undefined,
  active: boolean
): GitHubPullBoard | undefined {
  const board = useGitHubIssues((state) => (projectId ? state.declaredBoards[projectId] : undefined))
  useEffect(() => {
    if (!active || !api || !projectId) return
    let live = true
    const ask = (): void => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      void api.pullStatus(projectId).then(
        (next) => {
          if (!live) return
          // Only a declared-only answer belongs here; anything else (none declared) clears it.
          useGitHubIssues.getState().setDeclaredBoard(projectId, next.declared?.length ? next : undefined)
        },
        () => {
          // No sync and nothing declared (the host throws), or a transient failure: keep what is shown.
        }
      )
    }
    ask()
    // The host's first read starts on this ask; the answer arrives on the next one.
    const soon = setTimeout(ask, 3_000)
    const timer = setInterval(ask, DECLARED_POLL_MS)
    return () => {
      live = false
      clearTimeout(soon)
      clearInterval(timer)
    }
  }, [api, projectId, active])
  return active ? board : undefined
}
