// The desktop's remote leg of a PAGED ⌘M transcript read, pulled out of `src/main/index.ts` so its
// one load-bearing rule is testable without booting the shell: on a failed read, forget a ref WE
// located (so Retry locates it again instead of replaying a dead path), but KEEP a hook-fed one
// (an empty read there is usually a ControlMaster blip, and dropping it would send the next read
// down the LOCAL resolver — the wrong machine).
import type { RemoteTranscriptPage, TranscriptQuery } from '../core/transcript-ipc'
import type { ChatTranscriptPage } from '../shared/chat-page'
import type { TranscriptPage } from '../core/remote-ssh/transcript-window'
import type { RemoteFileRef } from './remote-ssh/remote-file'

/** Remote transcript refs by sessionId, and which of them we located ourselves (vs hook-fed). */
export interface RemoteTranscriptRefCache {
  bySession: Map<string, RemoteFileRef>
  located: Set<string>
}

/** Forget `sessionId`'s ref only if WE located it. True when something was dropped. */
export function forgetLocatedRef(cache: RemoteTranscriptRefCache, sessionId: string): boolean {
  if (!cache.located.delete(sessionId)) return false
  cache.bySession.delete(sessionId)
  return true
}

/** A hook event named this session's transcript: the ref is now hook-fed. Clearing the `located`
 *  mark matters — left in place, a later failed read would drop the authoritative hook-fed ref. */
export function rememberHookRef(cache: RemoteTranscriptRefCache, sessionId: string, ref: RemoteFileRef): void {
  cache.bySession.set(sessionId, ref)
  cache.located.delete(sessionId)
}

export function createReadRemotePage(deps: {
  cache: RemoteTranscriptRefCache
  /** The session's remote ref (cached, or located on the host); undefined = not a remote session. */
  refFor(q: TranscriptQuery): Promise<RemoteFileRef | undefined>
  /** Strict ranged read (`RemoteFile.readTranscriptPage`): throws on any failure. */
  readPage(ref: RemoteFileRef, before: number | null, maxBytes: number): Promise<TranscriptPage>
}): (q: TranscriptQuery, page: ChatTranscriptPage) => Promise<RemoteTranscriptPage | null> {
  return async (q, page) => {
    const ref = await deps.refFor(q)
    if (!ref) return null
    try {
      const w = await deps.readPage(ref, page.before, page.maxBytes)
      return { ok: true, data: w.data, start: w.start }
    } catch {
      if (q.sessionId) forgetLocatedRef(deps.cache, q.sessionId)
      return { ok: false }
    }
  }
}

/** Which ControlMaster a remote transcript read for `nodeId` goes over: the node's LIVE pty session
 *  when there is one (the exact master it spawned over), else its SSH PROJECT's master — an idle
 *  tab, or any node after a desktop restart, has no attached pty, and resolving only through the pty
 *  made such a node read as "not remote". `undefined` = a local node, or a project with no master. */
export function remoteTargetForNode<T extends { conn: unknown; controlPath: string }>(
  nodeId: string,
  deps: {
    live(nodeId: string): T | undefined
    projectIdFor(nodeId: string): string | undefined
    refForProject(projectId: string): T | undefined
  }
): T | undefined {
  const live = deps.live(nodeId)
  if (live) return live
  const projectId = deps.projectIdFor(nodeId)
  return projectId ? deps.refForProject(projectId) : undefined
}
