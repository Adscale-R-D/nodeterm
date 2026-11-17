// Fork patch #5: the renderer half of `/session/<id>` links.
import { describe, it, expect, vi } from 'vitest'
import { sessionLinkAction, takeSessionLinkParam } from './sessionLink'
import type { RecentConversation } from '@shared/recent-conversations'

const ID = '5f0c2a9e-3b7d-4e61-9a24-7c1d8e0f4b32'
const conv = (over: Partial<RecentConversation> = {}): RecentConversation => ({
  agentId: 'claude',
  sessionId: ID,
  cwd: '/srv/demo',
  lastActiveAt: 1,
  title: 'x',
  titleSource: 'prompt',
  cwdState: 'present',
  ...over
})

describe('takeSessionLinkParam', () => {
  it('reads the id and strips it from the URL, keeping the rest', () => {
    const replaceState = vi.fn()
    const id = takeSessionLinkParam({ search: `?a=1&session=${ID}`, pathname: '/', hash: '#h' }, { replaceState, state: null })
    expect(id).toBe(ID)
    expect(replaceState).toHaveBeenCalledWith(null, '', '/?a=1#h')
  })

  it('strips but refuses a value that is not a session id; ignores a URL without it', () => {
    const replaceState = vi.fn()
    expect(takeSessionLinkParam({ search: '?session=../x', pathname: '/', hash: '' }, { replaceState, state: null })).toBeNull()
    expect(replaceState).toHaveBeenCalledWith(null, '', '/')
    const untouched = vi.fn()
    expect(takeSessionLinkParam({ search: '', pathname: '/', hash: '' }, { replaceState: untouched, state: null })).toBeNull()
    expect(untouched).not.toHaveBeenCalled()
  })
})

describe('sessionLinkAction', () => {
  const known = (id: string): boolean => id === 'term-1'

  it('focuses a node core sees running the session, never resumes it', () => {
    expect(sessionLinkAction(ID, { ok: true, item: conv(), heldBy: ['gone', 'term-1'] }, known)).toEqual({ kind: 'focus', nodeId: 'term-1' })
  })

  it('refuses a vanished folder, naming the path', () => {
    const act = sessionLinkAction(ID, { ok: true, item: conv({ cwd: '/w/old', cwdState: 'absent' }), heldBy: [] }, known)
    expect(act.kind).toBe('refuse')
    expect(act.kind === 'refuse' && act.text).toContain('/w/old')
  })

  it('resumes otherwise, through the Open recent planner', () => {
    const item = conv({ cwdState: 'unknown' })
    expect(sessionLinkAction(ID, { ok: true, item, heldBy: ['not-on-a-canvas'] }, known)).toEqual({ kind: 'resume', conv: item })
  })

  it('says so for an unknown session, with the id', () => {
    const act = sessionLinkAction(ID, { ok: false, reason: 'not-found' }, known)
    expect(act.kind === 'refuse' && act.text).toContain(ID)
  })
})
