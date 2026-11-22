import { beforeEach, describe, expect, it } from 'vitest'

import { IntegrationLedger } from '../core/integration/ledger'
import { resetMessageFlow } from '../core/agents/agent-message-flow'
import { resetAgentMessageTraceForTests } from '../core/agents/agent-message-trace'
import { MANAGED_SCRIPT_REVISION } from '../core/agents/hooks/managed-script'
import type { AgentMessagingDeps } from '../core/agents/agent-messaging'
import type { PrincipalEntry } from '../core/integration/registry'
import { INTEGRATION_COMMENT_TEXT_MAX, INTEGRATION_MESSAGE_VERB } from '../shared/integration-principal'
import { BOARD_LOG_TEXT_MAX, type BoardLogEntry } from '../shared/types'
import { mentionToken, parseMentions } from '../shared/board-comment'
import type { PrincipalOpenSpec, PrincipalResumeInput } from './headless-node-factory'
import { createIntegrationService, type IntegrationServiceDeps } from './integration-service'

const SINK: PrincipalEntry = { name: 'sink', label: 'Sink', projects: ['p1', 'p2'], tokenSha256: 'a'.repeat(64), createdAt: 1 }
const TOKEN = 'ntp_test-token-xxxxxxxxxxxx'

interface World {
  canvas: Map<string, Array<{ id: string; parentId?: string }>>
  opens: PrincipalOpenSpec[]
  resumes: PrincipalResumeInput[]
  closes: Array<{ projectId: string; nodeId: string; frameId?: string }>
  prompts: Array<{ name: string; text: string }>
  sent: string[]
  state: string
  boardLog: Array<{ projectId: string; entry: BoardLogEntry }>
  noBoardLog: Set<string>
  boardLogFails: boolean
  repositories: Map<string, string>
  pullsChanged: string[]
}

function setup(over: Partial<IntegrationServiceDeps> = {}) {
  const w: World = { canvas: new Map([['p1', []], ['p2', []]]), opens: [], resumes: [], closes: [], prompts: [], sent: [], state: 'done', boardLog: [], noBoardLog: new Set(), boardLogFails: false, repositories: new Map([['p1', 'Adscale-R-D/app_ms']]), pullsChanged: [] }
  let seq = 0
  const ledger = new IntegrationLedger(undefined, undefined, () => 5000)
  const messaging: AgentMessagingDeps = {
    paneOwner: async () => ({ tty: '/dev/pts/1', panePid: 1, paneId: '%1', command: 'claude', argv: ['claude'], pids: [2] }),
    sendEnvelope: async (_id, payload) => {
      w.sent.push(payload)
      return true
    },
    hasLiveSession: () => true,
    mirrorEntry: () => ({ state: w.state as never, updatedAt: 1, stateVerified: true, clientRevision: MANAGED_SCRIPT_REVISION }),
    projects: () => [...w.canvas].map(([id, nodes]) => ({ id, nodes: nodes.map((n) => ({ id: n.id, agentId: 'claude' })) })),
    isRemoteNode: () => false,
    messagingEnabled: () => false,
    paneOwnerProject: (id) => [...w.canvas].find(([, nodes]) => nodes.some((n) => n.id === id))?.[0],
    principalOwnsTarget: (p, id) => ledger.owns(p, id),
    customAgents: () => undefined,
    appendBoardLog: async () => false,
    subscribeReceipts: (cb) => {
      const t = setTimeout(() => [...w.canvas.values()].flat().forEach((n) => cb({ nodeId: n.id, newTurn: true, verified: true })), 5)
      return () => clearTimeout(t)
    }
  }
  const service = createIntegrationService({
    boardRepository: async (projectId) => w.repositories.get(projectId) ?? null,
    onPullsChanged: (projectId) => w.pullsChanged.push(projectId),
    registry: { authenticate: (name, token) => (name === 'sink' && token === TOKEN ? SINK : undefined) },
    ledger,
    messaging,
    factory: {
      principalOpen: async (spec, beforeLaunch) => {
        w.opens.push(spec)
        const nodeId = `term-${++seq}`
        let frameId: string | undefined
        let frameCreated = false
        if (spec.frame && 'title' in spec.frame) {
          frameId = `group-${seq}`
          frameCreated = true
          w.canvas.get(spec.projectId)!.push({ id: frameId })
        } else if (spec.frame) frameId = spec.frame.id
        w.canvas.get(spec.projectId)!.push({ id: nodeId, ...(frameId ? { parentId: frameId } : {}) })
        beforeLaunch({ nodeId, frameId, frameCreated, agentSessionId: `sess-${seq}-0000-0000` })
        return {
          ok: true, nodeId, frameId, frameCreated, agentSessionId: `sess-${seq}-0000-0000`, session: 'started', sessionCreated: 1700,
          ...(spec.column !== undefined ? { column: spec.column.toLowerCase() === 'jira' ? 'col-jira' : 'missing' } : {})
        }
      },
      principalResume: async (input) => {
        w.resumes.push(input)
        return { ok: true, outcome: 'resumed', sessionCreated: 1800 }
      },
      principalClose: async (input) => {
        w.closes.push(input)
        const list = w.canvas.get(input.projectId)!
        const next = list.filter((n) => n.id !== input.nodeId)
        const frameRemoved = !!input.frameId && !next.some((n) => n.parentId === input.frameId)
        w.canvas.set(input.projectId, frameRemoved ? next.filter((n) => n.id !== input.frameId) : next)
        return { ok: true, nodeMissing: !list.some((n) => n.id === input.nodeId), frameRemoved }
      },
      holdsSession: () => true
    },
    canvases: () => [...w.canvas].map(([id, nodes]) => ({ id, nodes })),
    sessionVerdict: async () => 'present',
    mirror: () => ({ state: w.state }),
    paneOwnerProject: (id) => [...w.canvas].find(([, nodes]) => nodes.some((n) => n.id === id))?.[0],
    transcriptPresence: async () => 'present',
    savePrompt: async (name, base64) => {
      w.prompts.push({ name, text: Buffer.from(base64, 'base64').toString('utf8') })
      return `/data/launch-prompts/x/${name}`
    },
    isDirectory: async (p) => p === '/work/repo',
    boardLogReachable: (projectId) => !w.noBoardLog.has(projectId),
    appendBoardLog: async (projectId, entry) => {
      if (w.boardLogFails) return false
      w.boardLog.push({ projectId, entry })
      return true
    },
    now: () => 5000,
    ...over
  })
  const call = (verb: string, body: unknown, token = TOKEN) =>
    service.handle({ verb, name: 'sink', token, body: JSON.stringify(body) })
  return { w, ledger, service, call }
}

beforeEach(() => {
  resetMessageFlow()
  resetAgentMessageTraceForTests()
})

describe('integration service — auth', () => {
  it('one flat 403 for a wrong token or name, before anything else (even an unknown verb)', async () => {
    const { call, service, w } = setup()
    for (const r of [await call('open', { key: 'A' }, 'nope'), await call('nonsense', {}, 'nope'), await service.handle({ verb: 'list', name: 'x', token: TOKEN, body: '{}' })]) {
      expect(r).toEqual({ status: 403, body: { ok: false, error: 'unauthorized', message: 'integration refused' } })
    }
    expect(w.opens).toEqual([])
  })
  it('an authenticated unknown verb is a 404; a non-object body a 400', async () => {
    const { call, service } = setup()
    expect((await call('write', {})).status).toBe(404)
    expect((await service.handle({ verb: 'list', name: 'sink', token: TOKEN, body: '[1]' })).body).toMatchObject({ ok: false, error: 'bad-body' })
  })
})

describe('integration service — open', () => {
  it('opens into the first registered project, spills the prompt, and records ownership', async () => {
    const { call, w, ledger } = setup()
    const r = await call('open', { key: 'APP-1', agent: 'claude', prompt: 'line one\nline two' })
    expect(r).toEqual({ status: 200, body: { ok: true, result: { key: 'APP-1', nodeId: 'term-1', projectId: 'p1', status: 'created', session: 'started' } } })
    expect(w.opens[0]).toMatchObject({ principal: 'sink', label: 'Sink', key: 'APP-1', projectId: 'p1', agent: 'claude', title: 'APP-1 · Claude Code' })
    expect(w.prompts[0].text).toBe('line one\nline two')
    expect(w.opens[0].promptFile).toBe(`/data/launch-prompts/x/${w.prompts[0].name}`)
    expect(w.prompts[0].name).toMatch(/^nodeterm-prompt-/)
    expect(ledger.openNode('sink', 'APP-1')).toMatchObject({ nodeId: 'term-1', sessionCreated: 1700, agentSessionId: 'sess-1-0000-0000' })
  })

  it('is an upsert: the same key answers existing and opens nothing', async () => {
    const { call, w } = setup()
    await call('open', { key: 'APP-1', agent: 'claude' })
    const r = await call('open', { key: 'APP-1', agent: 'codex' })
    expect(r.body).toEqual({ ok: true, result: { key: 'APP-1', nodeId: 'term-1', projectId: 'p1', status: 'existing' } })
    expect(w.opens).toHaveLength(1)
  })

  it('passes column through and returns the column it landed in, or missing', async () => {
    const { call, w } = setup()
    expect((await call('open', { key: 'A', agent: 'claude', column: 'Jira' })).body).toMatchObject({ ok: true, result: { column: 'col-jira' } })
    expect(w.opens[0].column).toBe('Jira')
    expect((await call('open', { key: 'B', agent: 'claude', column: 'Backlog' })).body).toMatchObject({ ok: true, result: { column: 'missing' } })
  })

  it('an existing upsert does not move the card (and reports no column)', async () => {
    const { call, w } = setup()
    await call('open', { key: 'A', agent: 'claude', column: 'Jira' })
    const r = await call('open', { key: 'A', agent: 'claude', column: 'PR reviews' })
    expect(r.body).toEqual({ ok: true, result: { key: 'A', nodeId: 'term-1', projectId: 'p1', status: 'existing' } })
    expect(w.opens).toHaveLength(1)
  })

  it('two concurrent opens of one key make one node', async () => {
    const { call, w } = setup()
    const [a, b] = await Promise.all([call('open', { key: 'APP-1', agent: 'claude' }), call('open', { key: 'APP-1', agent: 'claude' })])
    expect(w.opens).toHaveLength(1)
    expect([a.body, b.body].map((x) => (x as { result: { status: string } }).result.status).sort()).toEqual(['created', 'existing'])
  })

  it('a key whose node a person removed opens a NEW node', async () => {
    const { call, w } = setup()
    await call('open', { key: 'APP-1', agent: 'claude' })
    w.canvas.set('p1', [])
    const r = await call('open', { key: 'APP-1', agent: 'claude' })
    expect(r.body).toMatchObject({ ok: true, result: { status: 'created', nodeId: 'term-2' } })
  })

  it('reuses its frame by title, and starts a new one if a person removed it', async () => {
    const { call, w } = setup()
    await call('open', { key: 'A', agent: 'claude', group: 'Jira' })
    await call('open', { key: 'B', agent: 'claude', group: 'Jira' })
    expect(w.opens[1].frame).toEqual({ id: 'group-1' })
    w.canvas.set('p1', w.canvas.get('p1')!.filter((n) => n.id !== 'group-1'))
    await call('open', { key: 'C', agent: 'claude', group: 'Jira' })
    expect(w.opens[2].frame).toEqual({ title: 'Jira' })
  })

  it('refuses what it cannot honour, opening nothing', async () => {
    const { call, w } = setup()
    const cases: Array<[unknown, string]> = [
      [{ key: '../x', agent: 'claude' }, 'bad-key'],
      [{ key: 'A', agent: 'grok' }, 'bad-agent'],
      [{ key: 'A', agent: 'claude', project: 'p9' }, 'project-not-registered'],
      [{ key: 'A', agent: 'claude', cwd: 'relative/dir' }, 'bad-cwd'],
      [{ key: 'A', agent: 'claude', cwd: '/not/a/dir' }, 'bad-cwd'],
      [{ key: 'A', agent: 'claude', model: 'x; rm -rf /' }, 'bad-model'],
      [{ key: 'A', agent: 'claude', group: 'a‮b' }, 'bad-group'],
      [{ key: 'A', agent: 'claude', title: 'a\nb' }, 'bad-title'],
      [{ key: 'A', agent: 'claude', column: 'x'.repeat(49) }, 'bad-column'],
      [{ key: 'A', agent: 'claude', column: ' ' }, 'bad-column'],
      [{ key: 'A', agent: 'claude', column: 5 }, 'bad-column']
    ]
    for (const [body, error] of cases) expect((await call('open', body)).body).toMatchObject({ ok: false, error })
    expect(w.opens).toEqual([])
    expect((await call('open', { key: 'A', agent: 'claude', project: 'p2', cwd: '/work/repo' })).body).toMatchObject({ ok: true, result: { projectId: 'p2' } })
  })
})

describe('integration service — resume / send / close / list', () => {
  it('resume passes the recorded session and stamp, and stores the new stamp', async () => {
    const { call, w, ledger } = setup()
    await call('open', { key: 'APP-1', agent: 'claude' })
    const r = await call('resume', { key: 'APP-1' })
    expect(r.body).toEqual({ ok: true, result: { key: 'APP-1', nodeId: 'term-1', outcome: 'resumed' } })
    expect(w.resumes[0]).toMatchObject({ projectId: 'p1', nodeId: 'term-1', agent: 'claude', agentSessionId: 'sess-1-0000-0000', sessionCreated: 1700 })
    expect(ledger.openNode('sink', 'APP-1')?.sessionCreated).toBe(1800)
  })

  it('an unknown key is a 404 for resume, send and close', async () => {
    const { call } = setup()
    for (const verb of ['resume', 'send', 'close']) expect((await call(verb, { key: 'NOPE', text: 'x' })).status).toBe(404)
  })

  it('send delivers into the node and reports accepted with a sendId', async () => {
    const { call, w } = setup()
    await call('open', { key: 'APP-1', agent: 'claude' })
    const r = await call('send', { key: 'APP-1', text: 'new comment\x1b[31m' })
    expect(r.body).toMatchObject({ ok: true, result: { key: 'APP-1', nodeId: 'term-1', outcome: 'delivered', accepted: true, sendId: expect.any(String) } })
    // The control sequence was stripped before it reached the envelope.
    expect(w.sent[0]).not.toContain('\x1b')
  })

  it('a queued send ends up in the outbox under its sendId', async () => {
    const { call, service, ledger } = setup()
    await call('open', { key: 'APP-1', agent: 'claude' })
    service.onQueuedResult(
      { verb: INTEGRATION_MESSAGE_VERB, principal: 'sink', sendId: 'S-1', sourceNodeId: 'integration:sink', targetNodeId: 'term-1', sourceTitle: '', body: '' },
      { kind: 'expired', traceId: 't', queuedForMs: 1 }
    )
    // Not an integration message ⇒ ignored.
    service.onQueuedResult({ verb: 'send', sendId: 'S-2', sourceNodeId: 'a', targetNodeId: 'term-1', sourceTitle: '', body: '' }, { kind: 'delivered' } as never)
    expect(ledger.outboxOf('sink')).toEqual([{ sendId: 'S-1', key: 'APP-1', nodeId: 'term-1', outcome: 'expired', at: 5000 }])
    const list = await call('list', { outboxSince: 4000 })
    expect((list.body as { result: { outbox: unknown[] } }).result.outbox).toHaveLength(1)
  })

  it('close ends the node, closes the key, and closes a frame it emptied', async () => {
    const { call, w, ledger } = setup()
    await call('open', { key: 'APP-1', agent: 'claude', group: 'Jira' })
    const r = await call('close', { key: 'APP-1' })
    expect(r.body).toEqual({ ok: true, result: { key: 'APP-1', nodeId: 'term-1', closed: true } })
    expect(w.closes[0]).toEqual({ projectId: 'p1', nodeId: 'term-1', frameId: 'group-1' })
    expect(ledger.openNode('sink', 'APP-1')).toBeUndefined()
    expect(ledger.openFrame('sink', 'p1', 'Jira')).toBeUndefined()
  })

  it('list reports live facts for open rows and marks a removed node', async () => {
    const { call, w } = setup()
    await call('open', { key: 'A', agent: 'claude' })
    await call('open', { key: 'B', agent: 'claude' })
    w.state = 'blocked'
    w.canvas.set('p1', w.canvas.get('p1')!.filter((n) => n.id !== 'term-2'))
    const r = await call('list', {})
    const rows = (r.body as { result: { rows: Array<Record<string, unknown>> } }).result.rows
    expect(rows[0]).toMatchObject({ key: 'A', state: 'open', session: 'live', attached: true, paneProven: true, agentState: 'blocked', needsYou: true })
    expect(rows[1]).toMatchObject({ key: 'B', state: 'open', nodeMissing: true })
    expect(rows[1]).not.toHaveProperty('session')
  })
})

describe('integration service — comment', () => {
  it('appends one comment on the key\'s card, authored as the principal, and answers its id', async () => {
    const { call, w } = setup()
    await call('open', { key: 'APP-1', agent: 'claude' })
    const r = await call('comment', { key: 'APP-1', text: 'PR: [#42](https://example.test/pr/42)\n\nticket ok' })
    expect(r.status).toBe(200)
    const result = (r.body as { ok: true; result: { key: string; nodeId: string; commentId: string } }).result
    expect(result).toMatchObject({ key: 'APP-1', nodeId: 'term-1' })
    expect(result.commentId).toMatch(/^[0-9a-f-]{36}$/)
    expect(w.boardLog).toEqual([
      {
        projectId: 'p1',
        entry: {
          id: result.commentId,
          ts: 5000,
          author: { name: 'Sink', color: '#888888' },
          nodeId: 'term-1',
          kind: 'comment',
          text: 'PR: [#42](https://example.test/pr/42)\n\nticket ok'
        }
      }
    ])
  })

  it('uses the principal colour when it has one', async () => {
    const { call, w } = setup({
      registry: { authenticate: (name, token) => (name === 'sink' && token === TOKEN ? { ...SINK, color: '#0a84ff' } : undefined) }
    })
    await call('open', { key: 'APP-1', agent: 'claude' })
    await call('comment', { key: 'APP-1', text: 'hi' })
    expect(w.boardLog[0].entry.author).toEqual({ name: 'Sink', color: '#0a84ff' })
  })

  it('never reaches the session: a mention of its own node is flattened and nothing is typed', async () => {
    const { call, w } = setup()
    await call('open', { key: 'APP-1', agent: 'claude' })
    const r = await call('comment', { key: 'APP-1', text: `${mentionToken('term-1', 'APP-1 · Claude Code')} please look` })
    expect(r.status).toBe(200)
    expect(w.boardLog[0].entry.text).toBe('@APP-1 · Claude Code please look')
    // A nested token: flattening the inner one must not leave a valid outer one behind.
    await call('comment', { key: 'APP-1', text: '@[@[x](node:a)](node:term-1)' })
    expect(w.boardLog[1].entry.text).toBe('@@x')
    expect(parseMentions(w.boardLog[1].entry.text!)).toEqual([])
    expect(w.sent).toEqual([])
  })

  it('strips controls and bidi overrides, keeps newlines and tabs, and clamps to the board-log cap', async () => {
    const { call, w } = setup()
    await call('open', { key: 'APP-1', agent: 'claude' })
    await call('comment', { key: 'APP-1', text: 'a\x1b[31mb\r\n\tc\u202Ed' })
    expect(w.boardLog[0].entry.text).toBe('a[31mb\n\tcd')
    await call('comment', { key: 'APP-1', text: 'x'.repeat(BOARD_LOG_TEXT_MAX + 10) })
    expect(w.boardLog[1].entry.text).toBe('x'.repeat(BOARD_LOG_TEXT_MAX) + '…')
  })

  it('refuses bad input, an unknown or closed key, a project with no board log, and a failed write', async () => {
    const { call, w } = setup()
    await call('open', { key: 'APP-1', agent: 'claude' })
    expect((await call('comment', { key: 'APP-1', text: '  \x07 ' })).body).toMatchObject({ ok: false, error: 'bad-text' })
    expect((await call('comment', { key: 'APP-1', text: 5 })).body).toMatchObject({ ok: false, error: 'bad-text' })
    expect((await call('comment', { key: 'APP-1', text: 'x'.repeat(INTEGRATION_COMMENT_TEXT_MAX + 1) })).status).toBe(400)
    expect((await call('comment', { text: 'hi' })).body).toMatchObject({ ok: false, error: 'bad-key' })
    expect(await call('comment', { key: 'NOPE-1', text: 'hi' })).toMatchObject({ status: 404, body: { error: 'unknown-key' } })

    w.noBoardLog.add('p1')
    expect(await call('comment', { key: 'APP-1', text: 'hi' })).toMatchObject({ status: 409, body: { error: 'board-log-unavailable' } })
    w.noBoardLog.clear()
    w.boardLogFails = true
    expect(await call('comment', { key: 'APP-1', text: 'hi' })).toMatchObject({ status: 500, body: { error: 'comment-not-saved' } })
    w.boardLogFails = false

    await call('close', { key: 'APP-1' })
    expect(await call('comment', { key: 'APP-1', text: 'hi' })).toMatchObject({ status: 404, body: { error: 'unknown-key' } })
    expect(w.boardLog).toEqual([])
  })

  it('a node a person removed is an unknown key (and its row closes)', async () => {
    const { call, w, ledger } = setup()
    await call('open', { key: 'APP-1', agent: 'claude' })
    w.canvas.set('p1', [])
    expect(await call('comment', { key: 'APP-1', text: 'hi' })).toMatchObject({ status: 404, body: { error: 'unknown-key' } })
    expect(ledger.openNode('sink', 'APP-1')).toBeUndefined()
  })
})

describe('integration service — declared pull requests', () => {
  const result = (r: { body: unknown }) => (r.body as { result: Record<string, unknown> }).result

  it('open records pulls (sorted, deduplicated) and answers the declared set', async () => {
    const { call, ledger, w } = setup()
    const r = await call('open', { key: 'PR-12', agent: 'claude', pulls: [12, 3, 12] })
    expect(result(r)).toMatchObject({ status: 'created', pulls: [3, 12] })
    expect(ledger.declaredForProject('p1')).toEqual([{ nodeId: 'term-1', pulls: [3, 12], repository: 'Adscale-R-D/app_ms' }])
    expect(w.pullsChanged).toEqual(['p1'])
  })

  it('an existing upsert UNIONS pulls into the declared set and opens nothing', async () => {
    const { call, w } = setup()
    await call('open', { key: 'PR-12', agent: 'claude', pulls: [12] })
    const r = await call('open', { key: 'PR-12', agent: 'claude', pulls: [40, 12] })
    expect(r.body).toEqual({ ok: true, result: { key: 'PR-12', nodeId: 'term-1', projectId: 'p1', status: 'existing', pulls: [12, 40] } })
    expect(w.opens).toHaveLength(1)
    // An existing open without pulls changes nothing and reports none.
    expect(result(await call('open', { key: 'PR-12', agent: 'claude' }))).not.toHaveProperty('pulls')
  })

  it('open ignores pulls on a project with no repository (never refuses there)', async () => {
    const { call, ledger, w } = setup()
    const r = await call('open', { key: 'T-1', agent: 'claude', project: 'p2', pulls: [5] })
    expect(result(r)).toMatchObject({ status: 'created', pulls: [], pullsIgnored: 'no-repository' })
    expect(ledger.declaredForProject('p2')).toEqual([])
    expect(w.pullsChanged).toEqual([])
  })

  it('open refuses a malformed pulls list before opening anything', async () => {
    const { call, w } = setup()
    for (const pulls of [5, [0], [-1], [1.5], ['7'], [2 ** 31], Array.from({ length: 21 }, (_, i) => i + 1)]) {
      expect((await call('open', { key: 'X', agent: 'claude', pulls })).body).toMatchObject({ ok: false, error: 'bad-pull' })
    }
    // Even on a project without a repository: malformed input is still 400.
    expect((await call('open', { key: 'X', agent: 'claude', project: 'p2', pulls: [0] })).status).toBe(400)
    expect(w.opens).toEqual([])
  })

  it('link-pull / unlink-pull: shapes and idempotency', async () => {
    const { call, w } = setup()
    await call('open', { key: 'PR-12', agent: 'claude' })
    expect(await call('link-pull', { key: 'PR-12', pull: 12 })).toEqual({ status: 200, body: { ok: true, result: { key: 'PR-12', nodeId: 'term-1', pulls: [12] } } })
    expect(result(await call('link-pull', { key: 'PR-12', pull: 12 }))).toEqual({ key: 'PR-12', nodeId: 'term-1', pulls: [12] })
    expect(result(await call('link-pull', { key: 'PR-12', pull: 7 }))).toEqual({ key: 'PR-12', nodeId: 'term-1', pulls: [7, 12] })
    expect(result(await call('unlink-pull', { key: 'PR-12', pull: 12 }))).toEqual({ key: 'PR-12', nodeId: 'term-1', pulls: [7] })
    expect(result(await call('unlink-pull', { key: 'PR-12', pull: 12 }))).toEqual({ key: 'PR-12', nodeId: 'term-1', pulls: [7] })
    // A change re-reads the boards; a no-op does not.
    expect(w.pullsChanged).toEqual(['p1', 'p1', 'p1'])
  })

  it('link-pull / unlink-pull errors: bad-key, bad-pull, unknown-key, no-repository, too-many-pulls', async () => {
    const { call } = setup()
    await call('open', { key: 'A', agent: 'claude' })
    await call('open', { key: 'B', agent: 'claude', project: 'p2' })
    for (const verb of ['link-pull', 'unlink-pull']) {
      expect(await call(verb, { pull: 1 })).toMatchObject({ status: 400, body: { error: 'bad-key' } })
      for (const pull of [undefined, 0, -3, 1.5, '4', 2 ** 31]) {
        expect(await call(verb, { key: 'A', pull })).toMatchObject({ status: 400, body: { error: 'bad-pull' } })
      }
      expect(await call(verb, { key: 'NOPE', pull: 1 })).toMatchObject({ status: 404, body: { error: 'unknown-key' } })
      expect(await call(verb, { key: 'B', pull: 1 })).toMatchObject({ status: 409, body: { error: 'no-repository' } })
    }
    for (let n = 1; n <= 20; n++) await call('link-pull', { key: 'A', pull: n })
    expect(await call('link-pull', { key: 'A', pull: 21 })).toMatchObject({ status: 409, body: { error: 'too-many-pulls' } })
    expect(await call('open', { key: 'A', agent: 'claude', pulls: [99] })).toMatchObject({ status: 409, body: { error: 'too-many-pulls' } })
    expect(result(await call('link-pull', { key: 'A', pull: 20 })).pulls).toHaveLength(20)
  })

  it('list returns pulls on open rows; close drops the links and a reopened key starts empty', async () => {
    const { call, ledger } = setup()
    await call('open', { key: 'PR-12', agent: 'claude', pulls: [12] })
    const listed = result(await call('list', {})) as { rows: Array<Record<string, unknown>> }
    expect(listed.rows[0]).toMatchObject({ key: 'PR-12', state: 'open', pulls: [12] })
    await call('close', { key: 'PR-12' })
    expect(ledger.declaredForProject('p1')).toEqual([])
    const closed = result(await call('list', { includeClosed: true })) as { rows: Array<Record<string, unknown>> }
    expect(closed.rows[0]).toMatchObject({ state: 'closed' })
    expect(closed.rows[0]).not.toHaveProperty('pulls')
    await call('open', { key: 'PR-12', agent: 'claude' })
    expect(result(await call('list', {})).rows).toEqual([expect.objectContaining({ key: 'PR-12', pulls: [] })])
  })

  it('a node a person removed drops its declared links with its row', async () => {
    const { call, ledger, w } = setup()
    await call('open', { key: 'PR-12', agent: 'claude', pulls: [12] })
    w.canvas.set('p1', [])
    expect(await call('link-pull', { key: 'PR-12', pull: 13 })).toMatchObject({ status: 404 })
    expect(ledger.declaredForProject('p1')).toEqual([])
  })
})
