import { describe, expect, it } from 'vitest'

import { testTmpDir } from '../test-tmp'
import {
  CLOSED_ROW_TTL_MS,
  IntegrationLedger,
  OUTBOX_PER_PRINCIPAL,
  openIntegrationLedger,
  sanitizeNodeRecord,
  type IntegrationNodeRecord
} from './ledger'

const row = (over: Partial<IntegrationNodeRecord> = {}): IntegrationNodeRecord => ({
  principal: 'sink',
  kind: 'node',
  key: 'APP-1',
  nodeId: 'term-a',
  projectId: 'project-1',
  agentId: 'claude',
  createdAt: 1,
  state: 'open',
  ...over
})

describe('IntegrationLedger', () => {
  it('owns exactly the open agent rows of a principal', () => {
    const l = new IntegrationLedger()
    l.add(row())
    l.add(row({ kind: 'frame', key: 'Jira', nodeId: 'group-1', agentId: undefined }))
    expect(l.owns('sink', 'term-a')).toBe(true)
    expect(l.owns('other', 'term-a')).toBe(false)
    // A frame is owned, but it is not a send target.
    expect(l.owns('sink', 'group-1')).toBe(false)
    l.close('term-a')
    expect(l.owns('sink', 'term-a')).toBe(false)
    expect(l.openNode('sink', 'APP-1')).toBeUndefined()
  })

  it('refuses a second open row for a key or a node', () => {
    const l = new IntegrationLedger()
    l.add(row())
    expect(() => l.add(row({ nodeId: 'term-b' }))).toThrow()
    expect(() => l.add(row({ key: 'APP-2' }))).toThrow()
    // After close, the key may be opened again (a new node).
    l.close('term-a')
    l.add(row({ nodeId: 'term-b' }))
    expect(l.openNode('sink', 'APP-1')?.nodeId).toBe('term-b')
  })

  it('survives a restart through its files (the whole point)', () => {
    const dir = testTmpDir('nt-int-ledger-')
    const a = openIntegrationLedger(dir)
    a.ledger.add(row({ agentSessionId: '11111111-2222-3333-4444-555555555555' }))
    a.ledger.update('term-a', { sessionCreated: 1700000000 })
    a.ledger.recordOutcome({ principal: 'sink', sendId: 's1', key: 'APP-1', nodeId: 'term-a', outcome: 'delivered', at: Date.now() })
    a.dispose()
    const b = openIntegrationLedger(dir)
    expect(b.ledger.openNode('sink', 'APP-1')).toMatchObject({ nodeId: 'term-a', sessionCreated: 1700000000, agentSessionId: '11111111-2222-3333-4444-555555555555' })
    expect(b.ledger.outboxOf('sink')).toEqual([expect.objectContaining({ sendId: 's1', outcome: 'delivered' })])
    b.dispose()
  })

  it('a stood-down instance (not the endpoint owner) neither loads nor writes', () => {
    const dir = testTmpDir('nt-int-ledger-')
    const a = openIntegrationLedger(dir)
    a.ledger.add(row())
    a.dispose()
    const b = openIntegrationLedger(dir, { standDown: true })
    expect(b.ledger.openNode('sink', 'APP-1')).toBeUndefined()
    b.dispose()
  })

  it('loading a file with two open rows for one key keeps the newest and closes the other', () => {
    const rows = [row({ nodeId: 'term-old', createdAt: 1 }), row({ nodeId: 'term-new', createdAt: 2 })]
    const l = new IntegrationLedger({ load: () => rows, save: () => {} }, undefined, () => 10)
    l.load()
    expect(l.openNode('sink', 'APP-1')?.nodeId).toBe('term-new')
    expect(l.rowsOf('sink', true).find((r) => r.nodeId === 'term-old')?.state).toBe('closed')
  })

  it('drops closed rows after their TTL and bounds the outbox per principal', () => {
    let now = 1_000_000
    const l = new IntegrationLedger(undefined, undefined, () => now)
    l.add(row())
    l.close('term-a')
    now += CLOSED_ROW_TTL_MS + 1
    l.add(row({ key: 'APP-2', nodeId: 'term-b' }))
    expect(l.rowsOf('sink', true).map((r) => r.nodeId)).toEqual(['term-b'])
    for (let i = 0; i < OUTBOX_PER_PRINCIPAL + 5; i++)
      l.recordOutcome({ principal: 'sink', sendId: `s${i}`, key: 'APP-2', nodeId: 'term-b', outcome: 'delivered', at: now })
    const out = l.outboxOf('sink')
    expect(out).toHaveLength(OUTBOX_PER_PRINCIPAL)
    expect(out[0].sendId).toBe('s5')
  })

  it('sanitizes hostile records off disk', () => {
    expect(sanitizeNodeRecord(row())).not.toBeNull()
    expect(sanitizeNodeRecord(row({ nodeId: '../x' }))).toBeNull()
    expect(sanitizeNodeRecord(row({ principal: 'Bad' }))).toBeNull()
    expect(sanitizeNodeRecord(row({ agentId: 'grok' as never }))).toBeNull()
    expect(sanitizeNodeRecord({ ...row(), agentSessionId: '$(rm -rf /)' })).not.toHaveProperty('agentSessionId')
  })
})
