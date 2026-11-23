import { describe, expect, it } from 'vitest'

import { testTmpDir } from '../test-tmp'
import { NodeLinkStore, openNodeLinkStore, sanitizeNodeLinkRecord } from './node-links'

const SITE = 'https://ad-scale.atlassian.net'

describe('NodeLinkStore', () => {
  it('links and unlinks PRs per repository, idempotently, and fires one change per real change', () => {
    let changes = 0
    const s = new NodeLinkStore(undefined, () => 5)
    s.setOnChange(() => changes++)
    expect(s.linkPull('term-a', 'p1', 'a/b', 12)).toEqual({ pulls: [12], changed: true })
    expect(s.linkPull('term-a', 'p1', 'a/b', 3)).toEqual({ pulls: [3, 12], changed: true })
    expect(s.linkPull('term-a', 'p1', 'a/b', 3)).toEqual({ pulls: [3, 12], changed: false })
    expect(changes).toBe(2)
    expect(s.declaredForProject('p1')).toEqual([{ nodeId: 'term-a', pulls: [3, 12], repository: 'a/b' }])
    expect(s.declaredPulls('term-a', 'p1', 'other/repo')).toEqual([])
    expect(s.unlinkPull('term-a', 'p1', 'a/b', 12)).toEqual({ pulls: [3], changed: true })
    expect(s.unlinkPull('term-a', 'p1', 'a/b', 12)).toEqual({ pulls: [3], changed: false })
    for (let n = 100; n < 119; n++) s.linkPull('term-a', 'p1', 'a/b', n)
    expect(s.linkPull('term-a', 'p1', 'a/b', 999)).toBe('too-many')
  })

  it('upserts Jira tickets and keeps them when the PR set empties', () => {
    const s = new NodeLinkStore(undefined, () => 7)
    s.linkPull('term-a', 'p1', 'a/b', 1)
    expect(s.linkJira('term-a', 'p1', { key: 'A3-1', site: SITE, status: 'Open' })).toMatchObject({ changed: true })
    expect(s.linkJira('term-a', 'p1', { key: 'A3-1', site: SITE, status: 'Open' })).toMatchObject({ changed: false })
    s.unlinkPull('term-a', 'p1', 'a/b', 1)
    expect(s.jiraLinks()).toEqual([{ projectId: 'p1', nodeId: 'term-a', tickets: [{ key: 'A3-1', site: SITE, status: 'Open', at: 7 }] }])
    expect(s.unlinkJira('term-a', 'p1', 'A3-1')).toEqual({ jira: [], changed: true })
    expect(s.jiraLinks()).toEqual([])
  })

  it('a node moved to another project starts over; prune drops nodes off their canvas', () => {
    const s = new NodeLinkStore()
    s.linkJira('term-a', 'p1', { key: 'A3-1', site: SITE })
    expect(s.declaredJira('term-a', 'p2')).toEqual([])
    s.linkJira('term-a', 'p2', { key: 'B2-1', site: SITE })
    expect(s.jiraLinks().map((c) => [c.projectId, c.tickets.map((t) => t.key)])).toEqual([['p2', ['B2-1']]])
    s.prune(() => false)
    expect(s.jiraLinks()).toEqual([])
  })

  it('survives a reload of the real file; a hostile record is dropped', () => {
    const dir = testTmpDir('nt-node-links-')
    const a = openNodeLinkStore(dir)
    a.store.linkPull('term-a', 'p1', 'a/b', 4)
    a.store.linkJira('term-a', 'p1', { key: 'A3-1', site: SITE })
    a.dispose()
    const b = openNodeLinkStore(dir)
    expect(b.store.declaredForProject('p1')).toEqual([{ nodeId: 'term-a', pulls: [4], repository: 'a/b' }])
    expect(b.store.declaredJira('term-a', 'p1').map((t) => t.key)).toEqual(['A3-1'])
    b.dispose()
    expect(sanitizeNodeLinkRecord({ nodeId: 'term-a', projectId: 'p1', updatedAt: 1, jira: [{ key: 'A3-1', site: 'javascript:x', at: 1 }] })).toBeNull()
    expect(sanitizeNodeLinkRecord({ nodeId: '../x', projectId: 'p1', updatedAt: 1, pulls: [1], pullRepository: 'a/b' })).toBeNull()
  })
})
