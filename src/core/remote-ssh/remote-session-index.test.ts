import { describe, it, expect, vi } from 'vitest'
import {
  RemoteSessionIndex,
  REMOTE_SESSION_INDEX_TTL_MS,
  type SessionListOutcome
} from './remote-session-index'

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('RemoteSessionIndex', () => {
  it('answers N concurrent callers with ONE list read (the burst this exists for)', async () => {
    const list = vi.fn(async (): Promise<SessionListOutcome> => ({ kind: 'names', names: ['nt-a', 'nt-b'] }))
    const idx = new RemoteSessionIndex<null>({ list })

    const answers = await Promise.all(
      ['nt-a', 'nt-b', 'nt-c', 'nt-d'].map((id) => idx.exists('/cm/p1', id, null))
    )

    expect(answers).toEqual([true, true, false, false])
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('keeps hosts separate — one control path per read', async () => {
    const list = vi.fn(async (cp: string): Promise<SessionListOutcome> =>
      cp === '/cm/p1' ? { kind: 'names', names: ['nt-a'] } : { kind: 'names', names: [] }
    )
    const idx = new RemoteSessionIndex<null>({ list })

    expect(await idx.exists('/cm/p1', 'nt-a', null)).toBe(true)
    expect(await idx.exists('/cm/p2', 'nt-a', null)).toBe(false)
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('a failed READ answers "exists" — never evidence of absence', async () => {
    const idx = new RemoteSessionIndex<null>({ list: async () => ({ kind: 'unknown' }) })
    expect(await idx.exists('/cm/p1', 'nt-a', null)).toBe(true)
  })

  it('a THROWN list is a failed read, not an absence', async () => {
    const idx = new RemoteSessionIndex<null>({
      list: async () => {
        throw new Error('ssh 255')
      }
    })
    expect(await idx.exists('/cm/p1', 'nt-a', null)).toBe(true)
  })

  it('an empty name list IS absence (tmux has no server / no sessions)', async () => {
    const idx = new RemoteSessionIndex<null>({ list: async () => ({ kind: 'names', names: [] }) })
    expect(await idx.exists('/cm/p1', 'nt-a', null)).toBe(false)
  })

  it('markPresent beats a cached absence — a session we just spawned is never cold', async () => {
    const list = vi.fn(async (): Promise<SessionListOutcome> => ({ kind: 'names', names: [] }))
    const idx = new RemoteSessionIndex<null>({ list })

    expect(await idx.exists('/cm/p1', 'nt-a', null)).toBe(false)
    idx.markPresent('/cm/p1', 'nt-a')
    expect(await idx.exists('/cm/p1', 'nt-a', null)).toBe(true)
    // ...and only for that session.
    expect(await idx.exists('/cm/p1', 'nt-b', null)).toBe(false)
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('markPresent applies to a read that is still on the wire', async () => {
    const gate = deferred<SessionListOutcome>()
    const idx = new RemoteSessionIndex<null>({ list: () => gate.promise })

    const pending = idx.exists('/cm/p1', 'nt-a', null)
    idx.markPresent('/cm/p1', 'nt-a') // the spawn raced the probe
    gate.resolve({ kind: 'names', names: [] })
    await pending

    expect(await idx.exists('/cm/p1', 'nt-a', null)).toBe(true)
  })

  it('re-reads once the window has passed', async () => {
    let now = 1_000
    const list = vi.fn(async (): Promise<SessionListOutcome> => ({ kind: 'names', names: ['nt-a'] }))
    const idx = new RemoteSessionIndex<null>({ list, now: () => now })

    await idx.exists('/cm/p1', 'nt-a', null)
    now += REMOTE_SESSION_INDEX_TTL_MS - 1
    await idx.exists('/cm/p1', 'nt-a', null)
    expect(list).toHaveBeenCalledTimes(1)

    now += 2
    await idx.exists('/cm/p1', 'nt-a', null)
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('invalidate forgets the host, markPresent included', async () => {
    const list = vi.fn(async (): Promise<SessionListOutcome> => ({ kind: 'names', names: [] }))
    const idx = new RemoteSessionIndex<null>({ list })

    idx.markPresent('/cm/p1', 'nt-a')
    idx.invalidate('/cm/p1')
    expect(await idx.exists('/cm/p1', 'nt-a', null)).toBe(false)
  })

  it('hands the caller ctx through to the list builder', async () => {
    const list = vi.fn(async (_cp: string, ctx: { host: string }): Promise<SessionListOutcome> => ({
      kind: 'names',
      names: [ctx.host]
    }))
    const idx = new RemoteSessionIndex<{ host: string }>({ list })
    expect(await idx.exists('/cm/p1', 'nt-x', { host: 'nt-x' })).toBe(true)
    expect(list).toHaveBeenCalledWith('/cm/p1', { host: 'nt-x' })
  })
})
