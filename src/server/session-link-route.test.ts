// Fork patch #5: `/session/<id>` links on the Server Edition, against the real handler.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import http from 'http'
import fs from 'fs'
import path from 'path'
import { testTmpDir } from '../core/test-tmp'
import { Auth } from './auth'
import { createHttpHandler } from './http'
import { safeSessionNext, sessionLinkTarget } from './session-link-route'

const ID = '5f0c2a9e-3b7d-4e61-9a24-7c1d8e0f4b32'
const PASSWORD = 'correct-horse-battery'

describe('sessionLinkTarget / safeSessionNext', () => {
  it('redirects a session id and refuses anything else under /session/', () => {
    expect(sessionLinkTarget(`/session/${ID}`)).toEqual({ ok: true, location: `/?session=${ID}` })
    for (const bad of ['/session/', '/session/abc', `/session/${ID}/x`, `/session/${ID}x`, '/session/..%2f']) {
      expect(sessionLinkTarget(bad)).toEqual({ ok: false })
    }
    expect(sessionLinkTarget('/')).toBeNull()
    expect(sessionLinkTarget('/sessions')).toBeNull()
  })

  it('accepts only an exact session path as a return path', () => {
    expect(safeSessionNext(`/session/${ID}`)).toBe(`/session/${ID}`)
    for (const bad of ['//evil.example', '/\\evil.example', 'https://evil.example/session/' + ID, '/', `/session/${ID}?x=1`, null, 5]) {
      expect(safeSessionNext(bad)).toBeNull()
    }
  })
})

let servers: http.Server[] = []
let auth: Auth

beforeEach(() => {
  servers = []
})
afterEach(async () => {
  for (const s of servers) {
    s.closeAllConnections()
    await new Promise((r) => s.close(r))
  }
})

async function serve(): Promise<number> {
  const dir = testTmpDir('nt-session-link-')
  const rendererDir = path.join(dir, 'renderer')
  fs.mkdirSync(rendererDir)
  fs.writeFileSync(path.join(rendererDir, 'index.html'), '<div id="root"></div>')
  auth = new Auth(dir)
  auth.setPassword(PASSWORD)
  const srv = http.createServer(createHttpHandler({ auth, rendererDir }))
  servers.push(srv)
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  return (srv.address() as { port: number }).port
}

function request(
  port: number,
  method: string,
  p: string,
  headers: Record<string, string> = {},
  body?: string
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const h = { ...headers }
    if (body !== undefined) {
      h['content-type'] = 'application/x-www-form-urlencoded'
      h['content-length'] = String(Buffer.byteLength(body))
    }
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: h }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }))
    })
    r.on('error', reject)
    r.end(body)
  })
}

const html = { accept: 'text/html', host: '127.0.0.1', origin: 'http://127.0.0.1' }

describe('/session/<id> through the handler', () => {
  it('a signed-in click redirects to /?session=<id>; a bad id is a 404 page', async () => {
    const port = await serve()
    const cookie = `nt_session=${auth.createSession()}`
    const ok = await request(port, 'GET', `/session/${ID}`, { ...html, cookie })
    expect(ok.status).toBe(302)
    expect(ok.headers.location).toBe(`/?session=${ID}`)
    const bad = await request(port, 'GET', '/session/not-a-uuid', { ...html, cookie })
    expect(bad.status).toBe(404)
    expect(bad.body).toContain('Not a session link')
  })

  it('a signed-out click keeps the link through the login page', async () => {
    const port = await serve()
    const gate = await request(port, 'GET', `/session/${ID}`, html)
    expect(gate.status).toBe(302)
    expect(gate.headers.location).toBe(`/login?next=${encodeURIComponent(`/session/${ID}`)}`)

    const page = await request(port, 'GET', gate.headers.location!, html)
    expect(page.body).toContain(`name="next" value="/session/${ID}"`)

    const wrong = await request(port, 'POST', '/auth/login', html, `password=nope&next=${encodeURIComponent(`/session/${ID}`)}`)
    expect(wrong.headers.location).toBe(`/login?error=1&next=${encodeURIComponent(`/session/${ID}`)}`)

    const right = await request(port, 'POST', '/auth/login', html, `password=${PASSWORD}&next=${encodeURIComponent(`/session/${ID}`)}`)
    expect(right.status).toBe(303)
    expect(right.headers.location).toBe(`/session/${ID}`)
  })

  it('an open-redirect next is ignored: login lands on /', async () => {
    const port = await serve()
    const res = await request(port, 'POST', '/auth/login', html, `password=${PASSWORD}&next=${encodeURIComponent('//evil.example')}`)
    expect(res.headers.location).toBe('/')
    const page = await request(port, 'GET', `/login?next=${encodeURIComponent('//evil.example')}`, html)
    expect(page.body).not.toContain('name="next"')
  })
})
