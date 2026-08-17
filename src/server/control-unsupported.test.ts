/**
 * The Server Edition's `/control/*` answer, proven on the wire.
 *
 * ORIGINALLY this file measured a WORDING defect with a behavioural cost: `control unavailable` +
 * HTTP 400 is indistinguishable from a transient outage, and a language model retries an outage. So
 * the assertions are about what the CALLER CAN CONCLUDE — a stable machine name, prose containing
 * the literal "do not retry" — never merely about a status code.
 *
 * THE EDITION NOW WIRES CANVAS CONTROL FOR REAL (`core/agents/canvas-control-bridge.ts`), so the
 * blanket per-verb refusal this file was written to prove is GONE, and the tests that asserted it
 * went with it. What is kept, and why:
 *
 *  - The vocabulary itself (`controlUnsupportedMessage`, the `browser` clause) is still exported and
 *    still tested as a PURE unit. It is the dialect for an honestly-unsupported verb, and the
 *    distinction it draws — permanent vs retryable — is now load-bearing in the other direction:
 *    the bridge's no-UI refusal is the retryable one, and an agent must be able to tell them apart.
 *  - The identity-ordering tests are untouched, because they never depended on the handler: the
 *    strict/messaging gates run BEFORE it on every edition, so a tokenless caller still learns
 *    nothing about what this host can do.
 *  - The boot assertion now pins that a handler is registered AT ALL. That is the invariant with
 *    teeth (a null handler is invisible until an agent hits it in production); WHICH handler is a
 *    product decision that has now changed once.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { initPlatform, platform, resetPlatformForTests } from '../core/platform'
import {
  CONTROL_NO_UI_ERROR,
  initCanvasControlBridge
} from '../core/agents/canvas-control-bridge'
import { fakePlatform } from '../core/platform-fake'
import { hookServer, MESSAGING_CONTROL_REFUSAL } from '../core/agents/hook-server'
import { nodeAuthToken } from '../core/agents/node-auth-token'
import { STRICT_CONTROL_REFUSAL } from '../core/agents/node-identity-policy'
import {
  BROWSER_UNSUPPORTED_CLAUSE,
  CONTROL_UNSUPPORTED_ERROR,
  CONTROL_UNSUPPORTED_SENTENCE,
  controlUnsupportedMessage,
  EDITION_UNSUPPORTED_VERBS,
  serverEditionControlHandler,
  withEditionRefusals
} from './control-unsupported'

const SECRET = Buffer.alloc(32, 7)
let dir = ''

function control(verb: string, nodeId: string, accept = 'text/plain', token?: string) {
  const headers: Record<string, string> = {
    'X-Nodeterm-Hook-Token': hookServer.getToken(),
    'content-type': 'application/x-www-form-urlencoded',
    accept
  }
  if (token) headers['X-Nodeterm-Node-Token'] = token
  return fetch(`http://127.0.0.1:${hookServer.getPort()}/control/${verb}`, {
    method: 'POST',
    headers,
    body: `nodeId=${encodeURIComponent(nodeId)}`
  })
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeterm-ctl-unsupported-'))
  resetPlatformForTests()
  initPlatform(fakePlatform({ userDataDir: dir }))
  await hookServer.start()
  hookServer.setNodeAuthSecret(SECRET)
  // The exact registration `src/server/index.ts` performs after `hookServer.start()` — the real
  // bridge, over a platform with NO attached UI, which is the normal state of a headless host.
  hookServer.setControlHandler(
    withEditionRefusals(
      initCanvasControlBridge({ platform: platform(), candidates: () => platform().clientIds() })
    )
  )
})

afterAll(() => {
  hookServer.clearNodeAuthSecretForTests()
  hookServer.stop()
  resetPlatformForTests()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('with no UI attached, the refusal is RETRYABLE and says so', () => {
  it('names the no-UI case for every verb, in JSON, and never claims the edition cannot do it', async () => {
    for (const verb of ['list', 'open-terminal', 'write']) {
      const res = await control(verb, 'n-1', 'application/json')
      expect(res.status, verb).toBe(400)
      const body = (await res.json()) as { ok: boolean; error: string; message: string }
      expect(body.ok, verb).toBe(false)
      // The name is EXACT and stable — this is the field a client is allowed to branch on.
      expect(body.error, verb).toBe(CONTROL_NO_UI_ERROR)
      expect(body.error, verb).not.toBe('control unavailable')
      // The distinction this whole file exists to protect: a browser tab fixes this, so telling the
      // agent it is PERMANENT would strand a canvas that is one click from working.
      expect(body.error, verb).not.toBe(CONTROL_UNSUPPORTED_ERROR)
      expect(body.message, verb).not.toContain('do not retry')
    }
  })

  it('tells a text/plain caller, in words, that it is retryable and what to do', async () => {
    // Verified, so the reply is the refusal alone: an unverified caller inside the warning window
    // gets the identity note prefixed on top, which is existing behaviour and not what is measured
    // here.
    const res = await control('open-terminal', 'n-2', 'text/plain', nodeAuthToken(SECRET, 'n-2'))
    expect(res.status).toBe(400)
    const text = await res.text()
    expect(text).toContain(CONTROL_NO_UI_ERROR)
    expect(text).toContain('retryable')
    // The ACTION, not just the diagnosis: an agent that cannot open a browser tab still has to be
    // able to tell its user what will fix this.
    expect(text).toMatch(/web UI|nodeterm window/)
    // One line: the shim prints the body as-is.
    expect(text.trimEnd()).not.toContain('\n')
  })

  it('the messaging verbs keep the PERMANENT refusal — a browser tab would not have helped', async () => {
    // Task 5.3 of the messaging plan, shared with this mechanism by agreement. `send` is
    // verified-only at the route (requiresVerified runs before the handler on every edition), so a
    // token is presented here for the same reason the `browser` test presents one: the edition answer
    // is what a caller that got PAST identity hears. It must NOT be the bridge's retryable no-UI
    // message: agent messaging has no core service, so no tab can ever deliver it.
    const res = await control('send', 'n-msg', 'text/plain', nodeAuthToken(SECRET, 'n-msg'))
    expect(res.status).toBe(400)
    const text = await res.text()
    expect(text).toContain(CONTROL_UNSUPPORTED_ERROR)
    expect(text).toContain('do not retry')
    expect(text).not.toContain(CONTROL_NO_UI_ERROR)
  })

  it('an unverified `send` is refused on IDENTITY first, and that refusal does not invite a retry either', async () => {
    const res = await control('send', 'n-msg2')
    expect(res.status).toBe(403)
    expect((await res.text()).trim()).toBe(MESSAGING_CONTROL_REFUSAL)
  })

  it('names WHY browser control is structural, not merely unimplemented', async () => {
    // `browser` is a strict verb, so it takes a verified identity even to be told no. That
    // ordering is correct — identity runs before the handler — and it is why this test presents a
    // token where the others do not.
    const res = await control('browser', 'n-3', 'text/plain', nodeAuthToken(SECRET, 'n-3'))
    expect(res.status).toBe(400)
    const text = await res.text()
    expect(text).toContain(CONTROL_UNSUPPORTED_ERROR)
    expect(text).toContain(BROWSER_UNSUPPORTED_CLAUSE)
    expect(text).toContain('renders in your own browser')
  })

  it('adds that clause to `browser` and to nothing else', () => {
    expect(controlUnsupportedMessage('browser')).toContain(BROWSER_UNSUPPORTED_CLAUSE)
    for (const verb of ['list', 'open-terminal', 'browsers', 'BROWSER']) {
      expect(controlUnsupportedMessage(verb), verb).not.toContain(BROWSER_UNSUPPORTED_CLAUSE)
      expect(controlUnsupportedMessage(verb), verb).toContain(CONTROL_UNSUPPORTED_ERROR)
    }
  })

  it('still refuses an unverified `browser` on IDENTITY, before the edition ever answers', async () => {
    // Order matters: the identity gate runs before the handler on both shells, so a tokenless
    // caller learns nothing about the edition. Neither answer is a retryable outage.
    const res = await control('browser', 'n-4')
    expect(res.status).toBe(403)
    expect((await res.text()).trim()).toBe(STRICT_CONTROL_REFUSAL)
  })

  it('never resolves ok — there is nothing on this host for a verb to act on', async () => {
    expect(await serverEditionControlHandler({ verb: 'list' })).toEqual({
      ok: false,
      error: CONTROL_UNSUPPORTED_ERROR,
      message: controlUnsupportedMessage('list')
    })
  })
})

describe('the Server Edition wires it at boot', () => {
  it('registers a handler instead of leaving the null branch, and puts the refusals in FRONT', () => {
    // A hook-server change made on one shell only has shipped wrong three times in this repo, and the
    // null branch is invisible until an agent hits it in production. WHICH handler is a product
    // decision that has already changed once (a blanket refusal → the real bridge); the ORDER is the
    // invariant: the permanent-refusal wrapper must wrap the bridge, not the other way round, or
    // `send` on a tabless host reports "retryable" for something no tab can ever do.
    const src = fs.readFileSync(path.resolve(__dirname, 'index.ts'), 'utf8')
    expect(src).toContain('setControlHandler(')
    expect(src).toMatch(/withEditionRefusals\(\s*initCanvasControlBridge\(/)
  })

  it('every verb the bridge does answer is one the browser renderer implements', () => {
    // The bridge is a pipe: a verb it forwards that `Canvas.tsx` has no case for reaches the agent as
    // a puzzling default reply. So the two sets must agree — anything not in the edition's refusal
    // set has to exist in the renderer's switch.
    const canvas = fs.readFileSync(
      path.resolve(__dirname, '../renderer/canvas/Canvas.tsx'),
      'utf8'
    )
    const core = fs.readFileSync(path.resolve(__dirname, '../core/agents/canvas-control-core.ts'), 'utf8')
    const verbs = [...core.matchAll(/^ {2}\| '([a-z-]+)'$/gm)].map((m) => m[1])
    expect(verbs.length).toBeGreaterThan(20) // the union really was found, not an empty regex
    for (const verb of verbs) {
      if (EDITION_UNSUPPORTED_VERBS.has(verb)) continue
      expect(
        canvas.includes(`case '${verb}'`) || canvas.includes(`verb === '${verb}'`),
        `${verb} is forwarded to a renderer that has no case for it`
      ).toBe(true)
    }
  })
})

/**
 * The reply shape this refusal needed: a FAILURE may now carry a machine name in `error` and a
 * sentence in `message`, and the text dialect prefers the sentence. Every pre-existing handler
 * sends `error` alone, so the fallback is what they all still take — pinned here because a silent
 * change of dialect for every failing verb would be a much bigger deal than this feature.
 */
describe('a failing verb that carries only `error` is rendered exactly as before', () => {
  it('falls back to the error string in text, and keeps the JSON field', async () => {
    hookServer.setControlHandler(async () => ({ ok: false, error: 'boom' }))
    try {
      const text = await control('open-terminal', 'n-5', 'text/plain', nodeAuthToken(SECRET, 'n-5'))
      expect(text.status).toBe(400)
      expect((await text.text()).trim()).toBe('boom')
      const json = await control('open-terminal', 'n-6', 'application/json', nodeAuthToken(SECRET, 'n-6'))
      expect(await json.json()).toEqual({ ok: false, error: 'boom' })
    } finally {
      hookServer.setControlHandler(serverEditionControlHandler)
    }
  })
})
