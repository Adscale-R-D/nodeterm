// Fork patch #5 (docs/fork/STATUS.md): the renderer half of `/session/<id>` links.
//
// The server redirects a link to `/?session=<id>`. Once the workspace has loaded, Canvas reads the
// param ONCE, strips it from the address bar (a reload must not run it again), asks core for the
// session (`recentConversations.find`) and acts on the answer:
//   - a node core sees running that session  -> focus it (never a second `--resume`);
//   - its folder is gone                     -> say so, with the path, and start nothing;
//   - otherwise                              -> the "Open recent" planner, which focuses a node
//                                               that holds it, or resumes it in the project that
//                                               owns its folder (opening the folder if none does).
import {
  CLAUDE_SESSION_UUID_RE,
  type RecentConversation,
  type RecentConversationFindResult
} from '@shared/recent-conversations'

export const SESSION_LINK_PARAM = 'session'

/** Reads `?session=<uuid>` and removes it from the URL. Null when absent or not a session id. */
export function takeSessionLinkParam(
  loc: Pick<Location, 'search' | 'pathname' | 'hash'> = window.location,
  hist: Pick<History, 'replaceState' | 'state'> = window.history
): string | null {
  const params = new URLSearchParams(loc.search)
  if (!params.has(SESSION_LINK_PARAM)) return null
  const id = params.get(SESSION_LINK_PARAM) ?? ''
  params.delete(SESSION_LINK_PARAM)
  const rest = params.toString()
  try {
    hist.replaceState(hist.state, '', `${loc.pathname}${rest ? `?${rest}` : ''}${loc.hash}`)
  } catch {
    /* a URL we cannot rewrite still opens the session once */
  }
  return CLAUDE_SESSION_UUID_RE.test(id) ? id : null
}

export type SessionLinkAction =
  | { kind: 'focus'; nodeId: string }
  | { kind: 'resume'; conv: RecentConversation }
  | { kind: 'refuse'; text: string }

/**
 * What a looked-up session link does. `nodeKnown` says whether a node id is on any canvas: a
 * running node core reports but no project holds cannot be travelled to, and then the planner's
 * own holder check decides.
 */
export function sessionLinkAction(
  id: string,
  res: RecentConversationFindResult,
  nodeKnown: (nodeId: string) => boolean
): SessionLinkAction {
  if (!res.ok) {
    switch (res.reason) {
      case 'not-found':
        return {
          kind: 'refuse',
          text: `No Claude session ${id} on this machine — its transcript is not on disk (expired, or the session ran on another machine).`
        }
      case 'invalid':
        return { kind: 'refuse', text: `${id} is not a Claude session id.` }
      default:
        return { kind: 'refuse', text: `Could not look up Claude session ${id}. Try the link again.` }
    }
  }
  const held = res.heldBy.find(nodeKnown)
  if (held) return { kind: 'focus', nodeId: held }
  if (res.item.cwd && res.item.cwdState === 'absent') {
    return {
      kind: 'refuse',
      text: `Claude session ${id} ran in ${res.item.cwd}, which no longer exists (a removed worktree?). Nothing was started.`
    }
  }
  return { kind: 'resume', conv: res.item }
}
