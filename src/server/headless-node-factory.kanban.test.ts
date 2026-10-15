import fs from 'node:fs'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { fakePlatform } from '../core/platform-fake'
import { testTmpDir } from '../core/test-tmp'
import { initPlatform, resetPlatformForTests } from '../core/platform'
import { WorkspaceStore } from '../core/workspace-store'
import {
  DEFAULT_SETTINGS,
  type BoardLogEntry,
  type CanvasMutation,
  type CanvasNodeState,
  type Project,
  type ProjectKanban,
  type PtyCreateOptions,
  type PtyCreateResult,
  type Workspace
} from '../shared/types'
import {
  createHeadlessNodeOwnership,
  HeadlessNodeFactory,
  type HeadlessNodeOwnership,
  type HeadlessPty
} from './headless-node-factory'

// Server Edition kanban control: `board` (read) and `assign` (write, with `--create yes`), plus the
// automatic removal of agent-created columns. Children are created through the REAL `openTerminal`
// so creator ownership is earned the way production earns it, not seeded.

class FakePty implements HeadlessPty {
  readonly live = new Set<string>()
  private readonly taps = new Map<string, Set<(c: string) => void>>()
  private readonly lines = new Map<string, string>()
  // The same interactive-shell model as upstream's fake in headless-node-factory.test.ts: it echoes
  // what it is typed and Enter submits the line. These tests open terminals with no command, so no
  // launch is ever typed — the members exist to keep this fake honest about the interface.
  persistentSpawnAvailable(): boolean {
    return true
  }
  onOutput(key: string, cb: (c: string) => void): () => void {
    let set = this.taps.get(key)
    if (!set) this.taps.set(key, (set = new Set()))
    set.add(cb)
    return () => set!.delete(cb)
  }
  writeHeadless(key: string, data: string): boolean {
    if (!this.live.has(key)) return false
    if (data === '\r' || data === '\x15' || data === '\x1b') {
      this.lines.set(key, '')
      return true
    }
    this.lines.set(key, (this.lines.get(key) ?? '') + data)
    for (const cb of [...(this.taps.get(key) ?? [])]) cb(data)
    return true
  }
  releaseHeadless(): void {}
  async createHeadless(options: PtyCreateOptions): Promise<PtyCreateResult> {
    if (options.persistKey) this.live.add(options.persistKey)
    return { sessionId: `pty-${options.persistKey}`, fresh: true, persistent: true }
  }
  /** A shell owns every pane — the same answer upstream's fake gives. */
  async paneCommand(): Promise<string | null> {
    return 'bash'
  }
  async sessionExists(persistKey: string): Promise<boolean> {
    return this.live.has(persistKey)
  }
  async sendText(): Promise<boolean> {
    return true
  }
  async destroySession(_clientId: number | null, nodeId: string): Promise<void> {
    this.live.delete(nodeId)
  }
}

const agent = (id: string, title: string, x = 20): CanvasNodeState => ({
  id,
  kind: 'terminal',
  position: { x, y: 30 },
  size: { width: 640, height: 440 },
  title,
  color: '#d97757',
  group: null,
  agentId: 'claude'
})

describe('HeadlessNodeFactory kanban control', () => {
  let dataDir = ''
  let projectDir = ''
  let store: WorkspaceStore
  let factory: HeadlessNodeFactory
  let ownership: HeadlessNodeOwnership
  let published: Project[]
  let log: Array<{ projectId: string; entry: BoardLogEntry }>
  let ops: CanvasMutation[]

  const seed = async (kanban?: ProjectKanban): Promise<void> => {
    const initial: Workspace = {
      version: 2,
      activeProjectId: 'project-1',
      projects: [
        {
          id: 'project-1',
          name: 'Test',
          color: '#0a84ff',
          cwd: projectDir,
          viewport: { x: 0, y: 0, zoom: 1 },
          nodes: [
            agent('term-source', 'Implementer'),
            agent('term-source-2', 'Implementer 2', 700),
            agent('term-foreign', 'Somebody else', 1400)
          ],
          bridges: [],
          ropes: [],
          ...(kanban ? { kanban } : {})
        }
      ]
    }
    await store.save(initial)
  }

  const project = async (): Promise<Project> =>
    (await new WorkspaceStore().load({ sideline: false })).projects[0]

  /** Two terminals spawned BY `source`, so `source` owns them this run. */
  const spawn = async (source: string, count = 2): Promise<string[]> => {
    const reply = await factory.openTerminal(source, { cwd: projectDir, count: String(count) }, true)
    expect(reply.ok).toBe(true)
    return (reply.result as { ids: string[] }).ids
  }

  beforeEach(async () => {
    dataDir = testTmpDir('nodeterm-headless-kanban-')
    projectDir = path.join(dataDir, 'project')
    fs.mkdirSync(projectDir, { recursive: true })
    resetPlatformForTests()
    initPlatform(fakePlatform({ userDataDir: dataDir }))
    store = new WorkspaceStore()
    ownership = createHeadlessNodeOwnership()
    published = []
    log = []
    ops = []
    await seed()
    factory = new HeadlessNodeFactory({
      workspaceStore: store,
      ptyManager: new FakePty(),
      settings: () => ({ ...DEFAULT_SETTINGS, claudePermissionMode: 'manual' }),
      cliCaps: async () => ({
        version: null,
        autoPermissionMode: false,
        fullscreenTui: false,
        sessionIdFlag: false
      }),
      grokCaps: async () => ({ sessionIdFlag: false, models: [] }),
      codexCaps: async () => ({ approvalValues: ['on-request', 'never'] }),
      codexSharedIdentity: async () => false,
      ownership,
      stateOf: () => undefined,
      publishMutation: (_projectId, m) => ops.push(m),
      publishProject: (p) => published.push(structuredClone(p)),
      appendBoardLog: async (projectId, entry) => {
        log.push({ projectId, entry })
        return true
      },
      now: () => 1_700_000_000_000
    })
  })

  afterEach(() => {
    factory.stop()
    resetPlatformForTests()
  })

  it('board answers the lazy default for a project with no saved board, and writes nothing', async () => {
    const reply = await factory.board('term-source', {})
    expect(reply).toMatchObject({
      ok: true,
      result: { columns: [], ungrouped: ['term-source', 'term-source-2', 'term-foreign'] }
    })
    expect(reply.message).toContain('no columns yet')
    expect((await project()).kanban).toBeUndefined()
    expect(published).toEqual([])
  })

  it('ACCEPTANCE: two children filed with --create land in ONE agent column, live and persisted', async () => {
    const [a, b] = await spawn('term-source')
    published = []
    const first = await factory.assign('term-source', { node: a, column: 'Task A', create: 'yes' })
    const second = await factory.assign('term-source', { node: b, column: 'task a', create: 'yes' })
    expect(first).toMatchObject({ ok: true, result: { created: true } })
    expect(first.message).toContain('created column "Task A"')
    // Case-insensitive title match: the second call finds the column, it does not mint another.
    expect(second).toMatchObject({ ok: true, result: { created: false } })

    const board = (await project()).kanban!
    const taskA = board.columns.filter((c) => c.title.toLowerCase() === 'task a')
    expect(taskA).toHaveLength(1)
    expect(taskA[0].origin).toBe('agent')
    // The lazy default was materialized on the first write, exactly as a desktop first edit does.
    expect(board.columns.map((c) => c.title)).toEqual(['To Do', 'In Progress', 'Done', 'Task A'])
    // Placement only: every assignment now also carries an order `rank` (@shared/kanban-order).
    expect(board.assignments.map(({ nodeId, columnId }) => ({ nodeId, columnId }))).toEqual(
      expect.arrayContaining([
        { nodeId: a, columnId: taskA[0].id },
        { nodeId: b, columnId: taskA[0].id }
      ])
    )
    expect(board.assignments).toHaveLength(2)

    // Live: the board change is CAST as board ops before the save — the path an open board and a
    // canvas authority follow — and the agent column travels WITH its marker (the op sanitizer is
    // an allowlist; without `origin` there a peer would hold a column it never removes).
    expect(ops).toContainEqual(
      expect.objectContaining({
        op: 'kb-column',
        column: expect.objectContaining({ title: 'Task A', origin: 'agent' })
      })
    )
    // …and the persisted project is re-published whole, as every other headless write is.
    expect(published.at(-1)!.kanban).toEqual(board)

    const read = await factory.board('term-source', {})
    const col = (read.result as { columns: Array<{ title: string; cards: string[]; origin?: string }> })
      .columns.find((c) => c.title === 'Task A')
    // Newest on top: an unanchored `assign` lands at the TOP of its column (upstream's rule — the card
    // an agent just filed is the first one a reader sees), so the second card filed reads first.
    expect(col).toEqual(expect.objectContaining({ cards: [b, a], origin: 'agent' }))
    expect(read.message).toContain('(agent-created)')
  })

  it('two agents creating the same title at the same moment still produce one column', async () => {
    const [a] = await spawn('term-source', 1)
    const [b] = await spawn('term-source-2', 1)
    const replies = await Promise.all([
      factory.assign('term-source', { node: a, column: 'Task B', create: 'yes' }),
      factory.assign('term-source-2', { node: b, column: 'Task B', create: 'yes' })
    ])
    expect(replies.every((r) => r.ok)).toBe(true)
    expect(replies.filter((r) => (r.result as { created: boolean }).created)).toHaveLength(1)
    const board = (await project()).kanban!
    expect(board.columns.filter((c) => c.title === 'Task B')).toHaveLength(1)
    expect(new Set(board.assignments.map((x) => x.columnId)).size).toBe(1)
  })

  it('refuses a node the caller did not spawn, and writes nothing', async () => {
    const reply = await factory.assign('term-source', {
      node: 'term-foreign',
      column: 'Task A',
      create: 'yes'
    })
    expect(reply).toMatchObject({ ok: false, error: expect.stringContaining('assign-not-owner') })
    // A sibling's child is just as foreign as a stranger's.
    const [theirs] = await spawn('term-source-2', 1)
    const cross = await factory.assign('term-source', { node: theirs, column: 'Done' })
    expect(cross).toMatchObject({ ok: false, error: expect.stringContaining('assign-not-owner') })
    expect((await project()).kanban).toBeUndefined()
  })

  it('refuses an unknown column without --create, naming the columns and the flag', async () => {
    const [a] = await spawn('term-source', 1)
    const reply = await factory.assign('term-source', { node: a, column: 'Nope' })
    expect(reply.ok).toBe(false)
    expect(reply.error).toContain('To Do, In Progress, Done')
    expect(reply.error).toContain('--create yes')
    expect((await project()).kanban).toBeUndefined()
  })

  it('refuses flags it does not know rather than ignoring them', async () => {
    const [a] = await spawn('term-source', 1)
    const reply = await factory.assign('term-source', { node: a, column: 'Done', project: 'x' })
    expect(reply).toMatchObject({ ok: false, error: expect.stringContaining('--project') })
    const board = await factory.board('term-source', { verbose: 'yes' })
    expect(board).toMatchObject({ ok: false, error: expect.stringContaining('--verbose') })
  })

  it('a no-op retry saves and publishes nothing', async () => {
    const [a] = await spawn('term-source', 1)
    await factory.assign('term-source', { node: a, column: 'Done' })
    const count = published.length
    const again = await factory.assign('term-source', { node: a, column: 'Done' })
    expect(again.ok).toBe(true)
    expect(published).toHaveLength(count)
    // Unassigning on a board that was never written does not materialize the lazy default.
    await seed()
    const [c] = await spawn('term-source', 1)
    await factory.assign('term-source', { node: c, column: 'ungrouped' })
    expect((await project()).kanban).toBeUndefined()
  })

  it('narrates the move in the card feed, attributed to the agent', async () => {
    const [a] = await spawn('term-source', 1)
    await factory.assign('term-source', { node: a, column: 'Task A', create: 'yes' })
    const events = log.map((l) => l.entry.event)
    expect(events).toContainEqual({ type: 'column-added', title: 'Task A' })
    expect(events).toContainEqual({ type: 'card-moved', from: 'Ungrouped', to: 'Task A' })
    const move = log.find((l) => l.entry.event?.type === 'card-moved')!
    expect(move).toMatchObject({
      projectId: 'project-1',
      entry: { nodeId: a, kind: 'event', author: { name: 'Implementer' } }
    })
  })

  it('closing the last cards removes the agent column; a hand-made column survives, even emptied', async () => {
    await seed({
      columns: [
        { id: 'kcol-mine', title: 'Mine', color: '#0a84ff' },
        { id: 'kcol-empty', title: 'Empty mine', color: '#30d158' }
      ],
      assignments: []
    })
    const [a, b, c] = await spawn('term-source', 3)
    await factory.assign('term-source', { node: a, column: 'Task A', create: 'yes' })
    await factory.assign('term-source', { node: b, column: 'Task A', create: 'yes' })
    await factory.assign('term-source', { node: c, column: 'Mine' })

    // One card gone: the column still holds the other, so it stays.
    await factory.close('term-source', { node: a }, true)
    expect((await project()).kanban!.columns.map((col) => col.title)).toContain('Task A')

    log = []
    await factory.close('term-source', { node: `${b},${c}` }, true)
    const board = (await project()).kanban!
    expect(board.columns.map((col) => col.title)).toEqual(['Mine', 'Empty mine'])
    expect(log.map((l) => l.entry.event)).toEqual([{ type: 'column-deleted', title: 'Task A' }])
    // The removal rides the same op batch as the node removals, so a live board drops it too.
    const taskA = published.flatMap((p) => p.kanban?.columns ?? []).find((c) => c.title === 'Task A')
    expect(ops).toContainEqual({ op: 'kb-column-remove', id: taskA!.id })
    // …and the browser hears about it through the same full-project publish.
    expect(published.at(-1)!.kanban!.columns.map((col) => col.title)).toEqual(['Mine', 'Empty mine'])
  })

  it('moving the last card out removes the agent column', async () => {
    const [a] = await spawn('term-source', 1)
    await factory.assign('term-source', { node: a, column: 'Task A', create: 'yes' })
    const reply = await factory.assign('term-source', { node: a, column: 'In Progress' })
    expect(reply.ok).toBe(true)
    const board = (await project()).kanban!
    expect(board.columns.map((c) => c.title)).toEqual(['To Do', 'In Progress', 'Done'])
    expect(board.assignments.map(({ nodeId, columnId }) => ({ nodeId, columnId }))).toEqual([
      { nodeId: a, columnId: board.columns[1].id }
    ])
  })
})
