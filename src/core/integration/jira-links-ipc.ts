// The board's read of the Jira tickets integration principals declared on cards
// (src/shared/integration-jira.ts). Registered by BOTH shells: the Server Edition answers from its
// integration ledger, the desktop (which has no integration principals) answers an empty list, so a
// board never meets an unregistered channel. `source` is a thunk because the Server Edition builds
// its ledger with canvas control, after the platform handlers.
import { IPC } from '../../shared/ipc'
import type { JiraCardLinks } from '../../shared/integration-jira'
import type { CorePlatform } from '../platform'

export function registerIntegrationJiraIpc(
  platform: Pick<CorePlatform, 'handle'>,
  source: () => (() => JiraCardLinks[]) | null
): void {
  platform.handle(IPC.integrationJiraList, () => source()?.() ?? [])
}
