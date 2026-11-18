// The `/integration/<verb>` route on the REAL hook server (docs/integration-principal.md): behind the
// browser guard and the app bearer like every route, then handed to the principal handler with its
// own identity headers — never through the node identity gate (a principal is not a node).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { request } from 'node:http'

import { hookServer } from './hook-server'
import { initPlatform, resetPlatformForTests } from '../platform'
import { fakePlatform } from '../platform-fake'
import { testTmpDir } from '../test-tmp'
import { INTEGRATION_NAME_HEADER, INTEGRATION_TOKEN_HEADER } from '../../shared/integration-principal'

let seen: Array<{ verb: string; name: unknown; token: unknown; body: string }> = []

beforeAll(async () => {
  resetPlatformForTests()
  initPlatform(fakePlatform({ userDataDir: testTmpDir('nt-hook-integration-') }))
  await hookServer.start()
})

afterAll(() => {
  hookServer.setIntegrationHandler(null)
  hookServer.stop()
  resetPlatformForTests()
})

beforeEach(() => {
  seen = []
  hookServer.setIntegrationHandler(async (req) => {
    seen.push(req)
    return { status: 201, body: { ok: true, result: { echoed: req.verb } } }
  })
})

function post(path: string, headers: Record<string, string>, body = '{}'): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { socketPath: hookServer.getSockPath(), path, method: 'POST', headers: { host: 'localhost', 'content-type': 'application/json', ...headers } },
      (res) => {
        let text = ''
        res.on('data', (c) => (text += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }))
      }
    )
    req.on('error', reject)
    req.end(body)
  })
}

const bearer = (): Record<string, string> => ({ 'x-nodeterm-hook-token': hookServer.getToken() })

describe.skipIf(process.platform === 'win32')('/integration/ on the real hook server', () => {
  it('hands verb, principal headers and body to the handler, and returns its status and JSON', async () => {
    const r = await post('/integration/open', { ...bearer(), [INTEGRATION_NAME_HEADER]: 'sink', [INTEGRATION_TOKEN_HEADER]: 'ntp_x' }, '{"key":"A"}')
    expect(r.status).toBe(201)
    expect(JSON.parse(r.text)).toEqual({ ok: true, result: { echoed: 'open' } })
    expect(seen).toEqual([{ verb: 'open', name: 'sink', token: 'ntp_x', body: '{"key":"A"}' }])
  })

  it('no app bearer: 403 and the handler never runs', async () => {
    const r = await post('/integration/list', { [INTEGRATION_NAME_HEADER]: 'sink', [INTEGRATION_TOKEN_HEADER]: 'ntp_x' })
    expect(r.status).toBe(403)
    expect(seen).toEqual([])
  })

  it('a browser (Origin header) is refused before the bearer and the handler', async () => {
    const r = await post('/integration/list', { ...bearer(), origin: 'https://evil.example' })
    expect(r.status).toBe(403)
    expect(seen).toEqual([])
  })

  it('a handler that throws answers 500 JSON, never the hooks\' empty 204', async () => {
    hookServer.setIntegrationHandler(async () => {
      throw new Error('boom')
    })
    const r = await post('/integration/open', bearer())
    expect(r.status).toBe(500)
    expect(JSON.parse(r.text)).toMatchObject({ ok: false, error: 'internal' })
  })

  it('no handler registered (every shell but a Server Edition with canvas control): 404', async () => {
    hookServer.setIntegrationHandler(null)
    const r = await post('/integration/list', bearer())
    expect(r.status).toBe(404)
    expect(JSON.parse(r.text)).toMatchObject({ ok: false, error: 'integration-unavailable' })
  })
})
