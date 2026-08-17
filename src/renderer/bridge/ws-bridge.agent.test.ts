import { describe, it, expect } from 'vitest'
import { buildAgentApi, buildContextLinkApi } from './ws-bridge'
import { IPC } from '../../shared/ipc'

function fakeClient() {
  const subs: Array<{ channel: string }> = []
  const requests: Array<{ channel: string; arg: unknown }> = []
  const casts: Array<{ method: string; args: unknown[] }> = []
  return {
    subs,
    requests,
    casts,
    subscribe: (channel: string, _fn: (...a: unknown[]) => void) => {
      subs.push({ channel })
      return () => {}
    },
    request: (channel: string, arg?: unknown) => {
      requests.push({ channel, arg })
      return Promise.resolve()
    },
    cast: (method: string, ...args: unknown[]) => {
      casts.push({ method, args })
    }
  }
}

describe('buildAgentApi', () => {
  it('onAgentStatus / onSubagentActivity subscribe to the right channels and return an unsub', () => {
    const c = fakeClient()
    const api = buildAgentApi(c as never)
    const un1 = api.onAgentStatus(() => {})
    const un2 = api.onSubagentActivity(() => {})
    expect(c.subs).toEqual([
      { channel: IPC.agentStatus },
      { channel: IPC.agentSubagentActivity }
    ])
    expect(typeof un1).toBe('function')
    expect(typeof un2).toBe('function')
  })

  it('canvas control is REAL here — a subscription in, a cast out', () => {
    // The pair was `noopUnsub`/`noop` in stubs.ts, which is why no agent on a headless host could
    // open a node even though every verb is implemented in Canvas.tsx, unchanged, in this very tab.
    // The relay tab deliberately keeps the inert pair (relay-api.ts overrides these back) — a host
    // agent's verb would land on the guest's canvas.
    const c = fakeClient()
    const api = buildAgentApi(c as never)
    const un = api.onAgentControl(() => {})
    expect(c.subs).toEqual([{ channel: IPC.agentControl }])
    expect(typeof un).toBe('function')
    api.sendAgentControlResult({ requestId: 'r-1', ok: true, message: 'opened' })
    // A CAST, not a request: the server correlates by requestId and nothing awaits this frame.
    expect(c.casts).toEqual([
      { method: IPC.agentControlResult, args: [{ requestId: 'r-1', ok: true, message: 'opened' }] }
    ])
  })

  it('contextLink.info is a real request, because the `verify` verb depends on it', () => {
    // Reported from a live session: with `info` stubbed as E_UNSUPPORTED, `verify` could not build
    // a reviewer's brief (it needs the shim path so each reviewer can read the target's context),
    // so the whole review panel aborted and the caller fell back to a bare reviewer with no link.
    // core has always served this channel; only the browser refused it.
    const c = fakeClient()
    const { contextLink } = buildContextLinkApi(c as never, {
      setLinks: async () => {},
      info: async () => {
        throw new Error('the stub must not survive')
      }
    })
    void contextLink.info()
    expect(c.requests).toEqual([{ channel: IPC.contextLinkInfo, arg: undefined }])
  })

  it('leaves setLinks alone — the server derives the map from persisted bridges', () => {
    // Not an oversight: with no browser attached there is nobody to push a link map, so the server
    // deriving it from `bridges[]` is the authority. A push from here would be a weaker second one.
    const c = fakeClient()
    const stub = { setLinks: async () => {}, info: async () => ({ shimPath: '/x' }) }
    const { contextLink } = buildContextLinkApi(c as never, stub)
    expect(contextLink.setLinks).toBe(stub.setLinks)
  })

  it('ackDone fires a fire-and-forget request on the ack-done channel', () => {
    const c = fakeClient()
    const api = buildAgentApi(c as never)
    api.ackDone('nt-x')
    expect(c.requests).toEqual([{ channel: IPC.agentAckDone, arg: 'nt-x' }])
  })
})
