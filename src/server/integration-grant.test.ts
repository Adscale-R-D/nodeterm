// A node grants ITSELF to an integration principal (src/server/integration-grant.ts).
import { describe, expect, it } from 'vitest'
import { GRANTS_PER_NODE_MAX, IntegrationLedger, openIntegrationLedger } from '../core/integration/ledger'
import type { PrincipalEntry } from '../core/integration/registry'
import { testTmpDir } from '../core/test-tmp'
import { createServerEditionControlHandler, type ServerEditionControlActions } from './control-unsupported'
import { createIntegrationGrantHandler } from './integration-grant'

const SINK: PrincipalEntry = { name: 'sink', label: 'Sink', projects: ['p1'], tokenSha256: 'a'.repeat(64), createdAt: 1 }

function setup(placements: Record<string, Array<{ projectId: string; agentId?: string }>> = {
  'lane-1': [{ projectId: 'p1', agentId: 'claude' }],
  'lane-2': [{ projectId: 'p1', agentId: 'codex' }],
  'other-project': [{ projectId: 'p9', agentId: 'claude' }],
  'plain-term': [{ projectId: 'p1' }],
  'twice': [{ projectId: 'p1', agentId: 'claude' }, { projectId: 'p2', agentId: 'claude' }]
}) {
  const ledger = new IntegrationLedger(undefined, undefined, () => 100)
  const handle = createIntegrationGrantHandler({
    registry: { get: (name) => (name === 'sink' ? SINK : undefined) },
    ledger,
    placements: (id) => placements[id] ?? []
  })
  const grant = (node: string, key = 'LANE-1', principal = 'sink') => handle('integration-grant', node, { principal, key })
  return { ledger, handle, grant }
}

describe('integration-grant', () => {
  it('grants, re-grants (idempotent) and moves (latest wins, declared PRs move along)', () => {
    const { grant, ledger } = setup()
    expect(grant('lane-1')).toMatchObject({ ok: true, result: { principal: 'sink', key: 'LANE-1', nodeId: 'lane-1', status: 'granted' } })
    expect(ledger.openNode('sink', 'LANE-1')).toMatchObject({ nodeId: 'lane-1', adopted: true, projectId: 'p1', agentId: 'claude' })
    expect(grant('lane-1')).toMatchObject({ ok: true, result: { status: 'already-granted' } })
    ledger.declarePulls(ledger.openNode('sink', 'LANE-1')!, 'o/r', [12])
    expect(grant('lane-2')).toMatchObject({ ok: true, result: { nodeId: 'lane-2', status: 'moved' } })
    expect(ledger.grantsOf('lane-1')).toEqual([])
    expect(ledger.openNode('sink', 'LANE-1')).toMatchObject({ nodeId: 'lane-2', pulls: [12] })
  })

  it('refuses a key the principal opened a node for itself (key-owned)', () => {
    const { grant, ledger } = setup()
    ledger.add({ principal: 'sink', kind: 'node', key: 'APP-1', nodeId: 'term-9', projectId: 'p1', agentId: 'claude', createdAt: 1, state: 'open' })
    expect(grant('lane-1', 'APP-1')).toMatchObject({ ok: false, error: 'key-owned' })
    expect(ledger.openNode('sink', 'APP-1')?.nodeId).toBe('term-9')
  })

  it('a node may hold several grants (several keys); a node a principal OPENED is node-held', () => {
    const { grant, handle, ledger } = setup()
    expect(grant('lane-1', 'gh:1283')).toMatchObject({ ok: true, result: { status: 'granted' } })
    expect(grant('lane-1', 'gh:1379')).toMatchObject({ ok: true, result: { status: 'granted' } })
    expect(handle('integration-grants', 'lane-1', {})).toMatchObject({
      result: { grants: [{ principal: 'sink', key: 'gh:1283' }, { principal: 'sink', key: 'gh:1379' }] }
    })
    expect(ledger.owns('sink', 'lane-1', 'gh:1283')).toBe(true)
    expect(ledger.owns('sink', 'lane-1', 'gh:1379')).toBe(true)
    // Revoking one key leaves the other; the per-key creator check follows.
    handle('integration-revoke', 'lane-1', { principal: 'sink', key: 'gh:1283' })
    expect(ledger.owns('sink', 'lane-1', 'gh:1283')).toBe(false)
    expect(ledger.owns('sink', 'lane-1', 'gh:1379')).toBe(true)
    // A node the principal opened itself takes no grants.
    ledger.add({ principal: 'sink', kind: 'node', key: 'APP-1', nodeId: 'lane-2', projectId: 'p1', agentId: 'codex', createdAt: 1, state: 'open' })
    expect(grant('lane-2', 'gh:1')).toMatchObject({ ok: false, error: 'node-held' })
  })

  it('caps the grants on one node', () => {
    const { grant } = setup()
    for (let i = 0; i < GRANTS_PER_NODE_MAX; i++) expect(grant('lane-1', `gh:${i + 1}`)).toMatchObject({ ok: true })
    expect(grant('lane-1', 'gh:9999')).toMatchObject({ ok: false, error: 'too-many-grants' })
  })

  it('refuses an unregistered principal, and one not registered for the caller\'s project, alike', () => {
    const { grant } = setup()
    expect(grant('lane-1', 'K', 'nobody')).toMatchObject({ ok: false, error: 'principal-not-registered' })
    expect(grant('other-project')).toMatchObject({ ok: false, error: 'principal-not-registered' })
  })

  it('refuses a caller that is not an agent, or not in exactly one project, and bad flags', () => {
    const { grant, handle } = setup()
    expect(grant('plain-term')).toMatchObject({ ok: false, error: 'integration-grant-not-agent' })
    expect(grant('twice')).toMatchObject({ ok: false, error: 'integration-grant-no-project' })
    expect(grant('ghost')).toMatchObject({ ok: false, error: 'integration-grant-no-project' })
    expect(grant('lane-1', 'bad key!')).toMatchObject({ ok: false, error: 'integration-grant-bad-key' })
    expect(handle('integration-grant', 'lane-1', { principal: 'Bad Name', key: 'K' })).toMatchObject({ ok: false, error: 'integration-grant-bad-principal' })
  })

  it('revoke: only the node that holds the grant', () => {
    const { grant, handle, ledger } = setup()
    grant('lane-1')
    expect(handle('integration-revoke', 'lane-2', { principal: 'sink', key: 'LANE-1' })).toMatchObject({ ok: false, error: 'not-your-grant' })
    expect(handle('integration-revoke', 'lane-1', { principal: 'sink', key: 'NOPE' })).toMatchObject({ ok: false, error: 'unknown-key' })
    expect(handle('integration-revoke', 'lane-1', { principal: 'sink', key: 'LANE-1' })).toMatchObject({ ok: true, result: { principal: 'sink', key: 'LANE-1', revoked: true } })
    expect(ledger.openNode('sink', 'LANE-1')).toBeUndefined()
  })

  it('integration-grants lists the caller\'s own grants only', () => {
    const { grant, handle } = setup()
    grant('lane-1', 'LANE-1')
    expect(handle('integration-grants', 'lane-1', {})).toMatchObject({ ok: true, result: { grants: [{ principal: 'sink', key: 'LANE-1' }] } })
    expect(handle('integration-grants', 'lane-2', {})).toMatchObject({ ok: true, result: { grants: [] } })
  })

  it('a grant survives a reload of the ledger file', () => {
    const dir = testTmpDir('nt-int-grant-')
    const a = openIntegrationLedger(dir)
    a.ledger.grant({ principal: 'sink', key: 'LANE-1', nodeId: 'lane-1', projectId: 'p1' })
    a.dispose()
    const b = openIntegrationLedger(dir)
    expect(b.ledger.openNode('sink', 'LANE-1')).toMatchObject({ nodeId: 'lane-1', adopted: true })
    expect(b.ledger.owns('sink', 'lane-1')).toBe(true)
    b.dispose()
  })
})

describe('integration grant verbs at the Server Edition control boundary', () => {
  it('an unverified caller is refused before the handler runs; a missing flag is a parse error', async () => {
    let calls = 0
    const actions = new Proxy({}, {
      get: (_t, name) => name === 'integrationGrant'
        ? async () => { calls += 1; return { ok: true } }
        : async () => ({ ok: true })
    }) as ServerEditionControlActions
    const handler = createServerEditionControlHandler(actions)
    const unverified = await handler({ verb: 'integration-grant', nodeId: 'lane-1', args: { principal: 'sink', key: 'K' }, verified: false })
    expect(unverified).toMatchObject({ ok: false })
    expect(unverified.error).toMatch(/identity-refused/)
    expect(await handler({ verb: 'integration-grant', nodeId: 'lane-1', args: { principal: 'sink' }, verified: true }))
      .toMatchObject({ ok: false, error: expect.stringMatching(/requires --principal/) })
    expect(calls).toBe(0)
    await handler({ verb: 'integration-grants', nodeId: 'lane-1', args: {}, verified: true })
    expect(calls).toBe(1)
  })
})
