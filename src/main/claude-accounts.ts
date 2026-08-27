// Desktop wiring for the managed-Claude-account lifecycle. The lifecycle itself lives in
// src/core/claude-accounts-service.ts so the Server Edition serves the same four channels
// (issue #313); this file supplies the SSH project manager, which core cannot reach.
//
// The canvas-control skill installer is ALSO injected here, but no longer because it has to be:
// it moved to `core/agents/canvas-control-install.ts` (its one Electron dependency was
// `app.getPath('userData')`, now `platform().userDataDir`) so the Server Edition could install the
// skill at all. Left as an injected dep because that is this file's shape and the call site reads
// the same; core calling it directly is an available simplification, not a fix.
import { registerClaudeAccountsIpc } from '../core/claude-accounts-service'
import { installCanvasSkillInto } from '../core/agents/canvas-control-install'
import type { SshProjectManager } from './remote-ssh/ssh-project'

// Re-exported for this module's other consumers (claude-usage.ts) so their import path is
// unchanged; the implementation now lives in core (../core/claude-config-dir).
export { claudeConfigDirFor } from '../core/claude-config-dir'

/**
 * @param getSshManager Lazily resolves the SSH project manager (created after this init in index.ts).
 * Returns undefined when SSH isn't wired — every remote path then falls back to local behavior.
 */
export function initClaudeAccounts(getSshManager?: () => SshProjectManager | undefined): void {
  registerClaudeAccountsIpc({
    installSkill: installCanvasSkillInto,
    remote: () => {
      const mgr = getSshManager?.()
      if (!mgr) return undefined
      return {
        add: (projectId, id) => mgr.remoteAccountAdd(projectId, id),
        readLogin: (projectId, id) => mgr.remoteAccountReadLogin(projectId, id),
        remove: (projectId, id) => mgr.remoteAccountRemove(projectId, id)
      }
    }
  })
}
