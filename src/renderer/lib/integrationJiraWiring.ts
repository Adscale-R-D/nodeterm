/**
 * Mirror the host's declared Jira tickets into `useIntegrationJira`: the initial pull (a push that
 * fired before this renderer loaded, or while its socket was down, is otherwise lost) and every later
 * push. Installed once, on the app's own api.
 */
import type { NodeTerminalApi } from '@shared/types'
import { sanitizeJiraCardLinks } from '@shared/integration-jira'
import { useIntegrationJira } from '../state/integrationJira'

export function installIntegrationJiraWiring(api: Pick<NodeTerminalApi, 'integrationJira'>): () => void {
  const set = (raw: unknown): void => useIntegrationJira.getState().setLinks(sanitizeJiraCardLinks(raw))
  let live = true
  const pull = (): void => {
    void api.integrationJira
      .list()
      .then((links) => {
        if (live) set(links)
      })
      .catch(() => undefined)
  }
  pull()
  const off = api.integrationJira.onChanged((links) => set(links))
  // A push missed while the connection was down: read again when the page comes back into view.
  const onVisible = (): void => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') pull()
  }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
  return () => {
    live = false
    off()
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
  }
}
