// Fork patch #5: `findClaudeConversation`, the core lookup behind `/session/<id>` links.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { testTmpDir } from './test-tmp'

const held = vi.hoisted(() => ({ ids: [] as string[] }))
vi.mock('./agent-status-mirror', () => ({ nodesForAgentSession: () => held.ids }))

import { findClaudeConversation, resetRecentConversationsCacheForTests } from './recent-conversations'

const ID = '5f0c2a9e-3b7d-4e61-9a24-7c1d8e0f4b32'
const jl = (...recs: unknown[]): string => recs.map((r) => JSON.stringify(r)).join('\n') + '\n'

function transcript(cwd: string, opts: { sidechain?: boolean } = {}): string {
  return jl(
    { type: 'user', message: { role: 'user', content: 'Fix the flaky test' }, sessionId: ID, cwd, isSidechain: !!opts.sidechain },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'On it.' }] }, sessionId: ID, cwd }
  )
}

function write(file: string, body: string, mtimeSec: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body)
  fs.utimesSync(file, mtimeSec, mtimeSec)
}

let home: string
let root: string

beforeEach(() => {
  resetRecentConversationsCacheForTests()
  held.ids = []
  home = testTmpDir('nt-find-')
  root = path.join(home, 'projects')
})

describe('findClaudeConversation', () => {
  it('refuses a non-UUID id without touching the filesystem', async () => {
    const readdir = vi.spyOn(fs.promises, 'readdir')
    const lstat = vi.spyOn(fs.promises, 'lstat')
    for (const bad of ['../etc/passwd', 'abc', `${ID}/x`, `${ID}.jsonl`, '*', '', 42, null]) {
      expect(await findClaudeConversation(bad, [{ root }])).toEqual({ ok: false, reason: 'invalid' })
    }
    expect(readdir).not.toHaveBeenCalled()
    expect(lstat).not.toHaveBeenCalled()
    readdir.mockRestore()
    lstat.mockRestore()
  })

  it('finds a session in any project dir and returns its cwd and folder state', async () => {
    const cwd = testTmpDir('nt-find-cwd-')
    write(path.join(root, '-srv-demo', `${ID}.jsonl`), transcript(cwd), 1_000)
    const res = await findClaudeConversation(ID, [{ root }])
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.item).toMatchObject({ agentId: 'claude', sessionId: ID, cwd, cwdState: 'present' })
    expect(res.heldBy).toEqual([])
  })

  it('reports a folder that no longer exists as absent, keeping the original path', async () => {
    const gone = path.join(home, 'removed-worktree')
    write(path.join(root, '-x', `${ID}.jsonl`), transcript(gone), 1_000)
    const res = await findClaudeConversation(ID, [{ root }])
    expect(res.ok && res.item).toMatchObject({ cwd: gone, cwdState: 'absent' })
  })

  it('answers not-found for a missing transcript and for a sidechain one', async () => {
    expect(await findClaudeConversation(ID, [{ root }])).toEqual({ ok: false, reason: 'not-found' })
    write(path.join(root, '-x', `${ID}.jsonl`), transcript('/srv/demo', { sidechain: true }), 1_000)
    expect(await findClaudeConversation(ID, [{ root }])).toEqual({ ok: false, reason: 'not-found' })
  })

  it('searches every account root and prefers the newest copy, keeping its account', async () => {
    const other = path.join(home, 'acct', 'projects')
    write(path.join(root, '-a', `${ID}.jsonl`), transcript('/srv/old'), 1_000)
    write(path.join(other, '-b', `${ID}.jsonl`), transcript('/srv/new'), 2_000)
    const res = await findClaudeConversation(ID, [{ root }, { root: other, accountId: 'acc1' }])
    expect(res.ok && res.item).toMatchObject({ cwd: '/srv/new', accountId: 'acc1' })
  })

  it('names the nodes the mirror says are running the session', async () => {
    write(path.join(root, '-a', `${ID}.jsonl`), transcript('/srv/demo'), 1_000)
    held.ids = ['term-1']
    const res = await findClaudeConversation(ID, [{ root }])
    expect(res.ok && res.heldBy).toEqual(['term-1'])
  })
})
