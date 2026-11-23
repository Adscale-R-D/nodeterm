import { describe, expect, it } from 'vitest'

import { NodeLinkStore } from '../core/integration/node-links'
import { createNodeLinkVerbHandler, type NodeLinkVerbDeps } from './node-link-verbs'

const SITE = 'https://ad-scale.atlassian.net'

function setup(over: Partial<NodeLinkVerbDeps> = {}) {
  const store = new NodeLinkStore(undefined, () => 9)
  const changed: string[] = []
  const canvas = new Map<string, string[]>([['p1', ['term-a', 'note-1']]])
  const handle = createNodeLinkVerbHandler({
    store,
    placements: (nodeId) =>
      [...canvas].filter(([, ids]) => ids.includes(nodeId)).map(([projectId]) => ({ projectId, ...(nodeId.startsWith('term') ? { agentId: 'claude' } : {}) })),
    boardRepository: async () => ({ repository: 'Adscale-R-D/app_ms' }),
    defaultJiraSite: () => undefined,
    principalLinks: () => ({ pulls: [77], jira: [] }),
    liveNodes: () => (nodeId, projectId) => canvas.get(projectId)?.includes(nodeId) ?? true,
    onPullsChanged: (projectId) => changed.push(projectId),
    ...over
  })
  return { store, handle, changed, canvas }
}

describe('card link verbs', () => {
  it('link-pr / unlink-pr on the caller\'s own card refresh the boards on a change only', async () => {
    const { handle, store, changed } = setup()
    expect(await handle('link-pr', 'term-a', { pull: '#1045' })).toMatchObject({ ok: true, result: { pulls: [1045] } })
    expect(await handle('link-pr', 'term-a', { pull: '1045' })).toMatchObject({ ok: true, message: expect.stringContaining('already linked') })
    expect(changed).toEqual(['p1'])
    expect(store.declaredForProject('p1')).toEqual([{ nodeId: 'term-a', pulls: [1045], repository: 'Adscale-R-D/app_ms' }])
    expect(await handle('unlink-pr', 'term-a', { pull: '1045' })).toMatchObject({ ok: true, result: { pulls: [] } })
    expect(changed).toEqual(['p1', 'p1'])
  })

  it('link-jira: needs a site when none is known, then defaults to the newest one', async () => {
    const { handle } = setup()
    expect(await handle('link-jira', 'term-a', { ticket: 'A3-1' })).toMatchObject({ ok: false, error: 'link-jira-no-site' })
    const r = await handle('link-jira', 'term-a', { ticket: 'a3-1', site: SITE, status: 'In Review', category: 'in-progress', summary: 'Fix it' })
    expect(r).toMatchObject({ ok: true, result: { jira: [{ key: 'A3-1', site: SITE, status: 'In Review', category: 'in-progress', summary: 'Fix it', at: 9 }] } })
    const withDefault = setup({ defaultJiraSite: (projectId) => (projectId === 'p1' ? SITE : undefined) })
    expect(await withDefault.handle('link-jira', 'term-a', { ticket: 'A3-2' })).toMatchObject({ ok: true, result: { jira: [{ key: 'A3-2', site: SITE }] } })
  })

  it('refusals: bad flags, a non-agent node, no repository; links lists own and integration links apart', async () => {
    const { handle } = setup()
    expect(await handle('link-pr', 'term-a', { pull: 'abc' })).toMatchObject({ ok: false, error: 'link-pr-bad-pull' })
    expect(await handle('link-jira', 'term-a', { ticket: 'nope', site: SITE })).toMatchObject({ ok: false, error: 'link-jira-bad-ticket' })
    expect(await handle('link-jira', 'term-a', { ticket: 'A3-1', site: 'http://x.test' })).toMatchObject({ ok: false, error: 'link-jira-bad-site' })
    expect(await handle('link-jira', 'term-a', { ticket: 'A3-1', site: SITE, category: 'blocked' })).toMatchObject({ ok: false, error: 'link-jira-bad-category' })
    expect(await handle('link-pr', 'note-1', { pull: '1' })).toMatchObject({ ok: false, error: 'link-pr-not-agent' })
    expect(await handle('links', 'term-zzz', {})).toMatchObject({ ok: false, error: 'links-no-project' })
    const noRepo = setup({ boardRepository: async () => ({ refused: 'no-repository' }) })
    expect(await noRepo.handle('link-pr', 'term-a', { pull: '1' })).toMatchObject({ ok: false, error: 'link-pr-no-repository' })
    await handle('link-pr', 'term-a', { pull: '5' })
    const listed = await handle('links', 'term-a', {})
    expect(listed).toMatchObject({ ok: true, result: { pulls: [5], jira: [], integrations: { pulls: [77] } } })
    expect(listed.ok && listed.message).toContain('not yours to unlink')
  })

  it('a project the canvas snapshot does not hold keeps its links (not loaded is not gone)', async () => {
    const { handle, store, canvas } = setup()
    store.linkJira('term-x', 'p9', { key: 'A3-9', site: SITE })
    await handle('links', 'term-a', {})
    expect(store.jiraLinks().map((c) => c.nodeId)).toEqual(['term-x'])
    canvas.set('p9', [])
    await handle('links', 'term-a', {})
    expect(store.jiraLinks()).toEqual([])
  })

  it('a node no longer on its canvas loses its links on the next verb', async () => {
    const { handle, store, canvas } = setup()
    await handle('link-jira', 'term-a', { ticket: 'A3-1', site: SITE })
    canvas.set('p1', ['term-b'])
    canvas.set('p2', ['term-a'])
    await handle('links', 'term-a', {})
    expect(store.jiraLinks()).toEqual([])
  })
})
