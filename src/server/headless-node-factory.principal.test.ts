import fs from 'node:fs'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { fakePlatform } from '../core/platform-fake'
import { initPlatform, resetPlatformForTests } from '../core/platform'
import { WorkspaceStore } from '../core/workspace-store'
import { testTmpDir } from '../core/test-tmp'
import { paneOwnerProject, resetPaneOwnershipForTests } from '../core/agents/pane-ownership'
import {
  DEFAULT_SETTINGS,
  type CanvasNodeState,
  type PtyCreateOptions,
  type PtyCreateResult,
  type Settings,
  type Workspace
} from '../shared/types'
import { HeadlessNodeFactory, type HeadlessPty } from './headless-node-factory'

/** A shell-like fake: echoes typed bytes, Enter submits; plus the two probes `resume` needs. */
class FakePty implements HeadlessPty {
  readonly creates: PtyCreateOptions[] = []
  readonly sends: Array<{ nodeId: string; text: string }> = []
  readonly destroyed: string[] = []
  readonly live = new Set<string>()
  readonly stamps = new Map<string, number>()
  /** What owns each pane: a shell until a launch line is submitted, then that agent. */
  readonly paneCmd = new Map<string, string>()
  verdict: 'present' | 'absent' | 'unknown' | null = null
  /** Called on every createHeadless, before the session exists. */
  onCreate: (() => void) | null = null
  private readonly taps = new Map<string, Set<(c: string) => void>>()
  private readonly lines = new Map<string, string>()
  private nextStamp = 1_700_000_000

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
    if (data === '\r') {
      const line = this.lines.get(key) ?? ''
      this.sends.push({ nodeId: key, text: line })
      const agent = /^(claude|codex|gemini)\b/.exec(line)?.[1]
      if (agent) this.paneCmd.set(key, agent)
      this.lines.set(key, '')
      return true
    }
    if (data === '\x15' || data === '\x1b') {
      this.lines.set(key, '')
      return true
    }
    this.lines.set(key, (this.lines.get(key) ?? '') + data)
    for (const cb of [...(this.taps.get(key) ?? [])]) cb(data)
    return true
  }
  releaseHeadless(): void {}
  async createHeadless(options: PtyCreateOptions): Promise<PtyCreateResult> {
    this.onCreate?.()
    this.creates.push(options)
    const key = options.persistKey!
    const fresh = !this.live.has(key)
    this.live.add(key)
    if (fresh) {
      this.stamps.set(key, this.nextStamp++)
      this.paneCmd.delete(key)
    }
    return { sessionId: `pty-${key}`, fresh, persistent: true }
  }
  async paneCommand(key: string): Promise<string | null> {
    return this.paneCmd.get(key) ?? 'bash'
  }
  async sessionExists(key: string): Promise<boolean> {
    return this.live.has(key)
  }
  async sendText(nodeId: string, text: string): Promise<boolean> {
    this.sends.push({ nodeId, text })
    return true
  }
  async destroySession(_c: number | null, nodeId: string): Promise<void> {
    this.live.delete(nodeId)
    this.stamps.delete(nodeId)
    this.paneCmd.delete(nodeId)
    this.destroyed.push(nodeId)
  }
  async sessionVerdict(key: string): Promise<'present' | 'absent' | 'unknown'> {
    return this.verdict ?? (this.live.has(key) ? 'present' : 'absent')
  }
  async sessionCreatedAt(key: string): Promise<number | null> {
    return this.stamps.get(key) ?? null
  }
}

describe('HeadlessNodeFactory — integration principals', () => {
  let dataDir = ''
  let projectDir = ''
  let store: WorkspaceStore
  let pty: FakePty
  let factory: HeadlessNodeFactory
  let sessionIdFlag = true

  const settings = (): Settings => ({ ...DEFAULT_SETTINGS, claudePermissionMode: 'manual' })

  const load = async (): Promise<Workspace> => store.load({ sideline: false })
  const nodes = async (projectId = 'project-1'): Promise<CanvasNodeState[]> =>
    (await load()).projects.find((p) => p.id === projectId)!.nodes

  beforeEach(async () => {
    sessionIdFlag = true
    resetPaneOwnershipForTests()
    dataDir = testTmpDir('nodeterm-principal-factory-')
    projectDir = path.join(dataDir, 'project')
    fs.mkdirSync(projectDir, { recursive: true })
    resetPlatformForTests()
    initPlatform(fakePlatform({ userDataDir: dataDir }))
    store = new WorkspaceStore()
    pty = new FakePty()
    await store.save({
      version: 2,
      activeProjectId: 'project-1',
      projects: [
        { id: 'project-1', name: 'Inbox', color: '#0a84ff', cwd: projectDir, viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], bridges: [], ropes: [] }
      ]
    })
    factory = new HeadlessNodeFactory({
      workspaceStore: store,
      ptyManager: pty,
      settings,
      cliCaps: async () => ({ version: null, autoPermissionMode: false, fullscreenTui: false, sessionIdFlag }),
      grokCaps: async () => ({ sessionIdFlag: false, models: [] }),
      codexCaps: async () => ({ approvalValues: ['on-request', 'never'] }),
      codexSharedIdentity: async () => false,
      stateOf: () => undefined,
      launchTiming: { quietMs: 0, capMs: 0 },
      publishMutation: () => {},
      publishProject: () => {}
    })
  })

  afterEach(() => {
    factory.stop()
    resetPlatformForTests()
  })

  const spec = (over: Partial<Parameters<HeadlessNodeFactory['principalOpen']>[0]> = {}) => ({
    principal: 'sink',
    label: 'Sink',
    key: 'APP-1',
    projectId: 'project-1',
    agent: 'claude' as const,
    title: 'APP-1 · Claude',
    ...over
  })

  it('writes the node (with its display marker) and calls beforeLaunch BEFORE anything is spawned', async () => {
    let createsAtRecord = -1
    const r = await factory.principalOpen(spec(), () => {
      createsAtRecord = pty.creates.length
    })
    expect(r).toMatchObject({ ok: true, session: 'started' })
    expect(createsAtRecord).toBe(0)
    const node = (await nodes()).find((n) => n.kind === 'terminal')!
    expect(node).toMatchObject({
      title: 'APP-1 · Claude',
      agentId: 'claude',
      cwd: projectDir,
      integration: { name: 'sink', key: 'APP-1', label: 'Sink' }
    })
    // Delivered ⇒ the held launch is cleared; the minted conversation id is on the node.
    expect(node.pendingLaunch).toBeUndefined()
    expect(r.ok && r.agentSessionId).toBe(node.agentSessionId)
    expect(pty.sends[0].text).toMatch(/^claude --session-id /)
    expect(r.ok && r.sessionCreated).toBe(pty.stamps.get(node.id))
    // A fresh spawn with the project as owner: what records pane ownership in the real PtyManager.
    expect(pty.creates[0]).toMatchObject({ persistKey: node.id, ownerProjectId: 'project-1' })
  })

  it('launches a prompt FILE, so a multi-line brief keeps its newlines and never hits the line limit', async () => {
    const r = await factory.principalOpen(spec({ promptFile: '/data/launch-prompts/x/nodeterm-prompt-1.md' }), () => {})
    expect(r.ok).toBe(true)
    expect(pty.sends[0].text).toContain(`"$(cat '/data/launch-prompts/x/nodeterm-prompt-1.md')"`)
  })

  it('creates a frame by title, then places the next node inside it', async () => {
    const first = await factory.principalOpen(spec({ frame: { title: 'Jira' } }), () => {})
    expect(first).toMatchObject({ ok: true, frameCreated: true, frameId: expect.stringMatching(/^group-/) })
    const frameId = first.ok ? first.frameId! : ''
    const second = await factory.principalOpen(spec({ key: 'APP-2', frame: { id: frameId } }), () => {})
    expect(second).toMatchObject({ ok: true, frameId })
    expect(second.ok && second.frameCreated).toBeFalsy()
    const all = await nodes()
    const children = all.filter((n) => n.parentId === frameId)
    expect(children).toHaveLength(2)
    // No two children overlap.
    const [a, b] = children
    const overlap =
      a.position.x < b.position.x + b.size.width && b.position.x < a.position.x + a.size.width &&
      a.position.y < b.position.y + b.size.height && b.position.y < a.position.y + a.size.height
    expect(overlap).toBe(false)
  })

  describe('column', () => {
    const withBoard = async (): Promise<void> => {
      const ws = await load()
      ws.projects[0].nodes.push({ id: 'term-human', kind: 'terminal', position: { x: 0, y: 0 }, size: { width: 640, height: 440 }, title: 'Mine', color: '#0a84ff', group: null, tags: [] })
      ws.projects[0].kanban = {
        columns: [
          { id: 'col-reviews', title: 'PR reviews', color: '#0a84ff' },
          { id: 'col-jira', title: 'Jira', color: '#30d158' }
        ],
        assignments: [{ nodeId: 'term-human', columnId: 'col-jira' }]
      } as never
      await store.save(ws)
    }

    it('files the card at the TOP of an existing column, matched by title case-insensitively', async () => {
      await withBoard()
      const r = await factory.principalOpen(spec({ column: '  jIRA ' }), () => {})
      expect(r).toMatchObject({ ok: true, column: 'col-jira' })
      const k = (await load()).projects[0].kanban!
      const jira = k.assignments.filter((a) => a.columnId === 'col-jira').map((a) => a.nodeId)
      expect(jira).toEqual([r.ok ? r.nodeId : '', 'term-human'])
      expect(k.columns.map((c) => c.id)).toEqual(['col-reviews', 'col-jira'])
    })

    it('a title no column has creates nothing and leaves the card in Ungrouped', async () => {
      await withBoard()
      const r = await factory.principalOpen(spec({ column: 'Backlog' }), () => {})
      expect(r).toMatchObject({ ok: true, column: 'missing' })
      const k = (await load()).projects[0].kanban!
      expect(k.columns.map((c) => c.title)).toEqual(['PR reviews', 'Jira'])
      expect(k.assignments.some((a) => a.nodeId === (r.ok ? r.nodeId : ''))).toBe(false)
    })

    it('a project with no board at all answers missing and seeds no board', async () => {
      const r = await factory.principalOpen(spec({ column: 'Jira' }), () => {})
      expect(r).toMatchObject({ ok: true, column: 'missing' })
      expect((await load()).projects[0].kanban).toBeUndefined()
    })

    it('without a column, the result carries no column field', async () => {
      await withBoard()
      const r = await factory.principalOpen(spec(), () => {})
      expect(r.ok && 'column' in r).toBe(false)
    })

    it('closing the last card leaves the person-made column in place', async () => {
      await withBoard()
      const ws = await load()
      ws.projects[0].kanban!.assignments = []
      await store.save(ws)
      const r = await factory.principalOpen(spec({ column: 'PR reviews' }), () => {})
      if (!r.ok) throw new Error('open failed')
      await factory.principalClose({ projectId: 'project-1', nodeId: r.nodeId })
      expect((await load()).projects[0].kanban!.columns.map((c) => c.id)).toEqual(['col-reviews', 'col-jira'])
    })
  })

  it('refuses an unknown project and an SSH project, writing nothing', async () => {
    expect(await factory.principalOpen(spec({ projectId: 'nope' }), () => {})).toMatchObject({ ok: false, error: 'project-unavailable' })
    const ws = await load()
    ws.projects[0].ssh = { server: 'x', remoteCwd: '/r' } as never
    await store.save(ws)
    expect(await factory.principalOpen(spec(), () => {})).toMatchObject({ ok: false, error: 'project-ssh-unsupported' })
    expect(pty.creates).toHaveLength(0)
  })

  it('a failed launch keeps the command for Run now and says so', async () => {
    pty.persistentSpawnAvailable = () => true
    pty.createHeadless = async () => ({ sessionId: null as unknown as string, fresh: false })
    const r = await factory.principalOpen(spec(), () => {})
    expect(r).toMatchObject({ ok: true, session: 'failed' })
    const node = (await nodes()).find((n) => n.kind === 'terminal')!
    expect(node.pendingLaunch).toMatchObject({ manualOnly: true })
  })

  describe('resume', () => {
    const openOne = async (): Promise<{ nodeId: string; sessionId?: string; stamp?: number }> => {
      const r = await factory.principalOpen(spec(), () => {})
      if (!r.ok) throw new Error('open failed')
      return { nodeId: r.nodeId, sessionId: r.agentSessionId, stamp: r.sessionCreated }
    }

    it('session present with the recorded stamp: attaches and RE-PROVES the pane (after a restart)', async () => {
      const { nodeId, sessionId, stamp } = await openOne()
      // A new server run: a fresh factory, empty pane-ownership ledger, the tmux session survived.
      factory.stop()
      resetPaneOwnershipForTests()
      factory = new HeadlessNodeFactory({
        workspaceStore: store,
        ptyManager: pty,
        settings,
        cliCaps: async () => ({ version: null, autoPermissionMode: false, fullscreenTui: false, sessionIdFlag }),
        grokCaps: async () => ({ sessionIdFlag: false, models: [] }),
        codexCaps: async () => ({ approvalValues: ['on-request', 'never'] }),
        codexSharedIdentity: async () => false,
        stateOf: () => undefined,
        launchTiming: { quietMs: 0, capMs: 0 },
        publishMutation: () => {},
        publishProject: () => {}
      })
      expect(paneOwnerProject(nodeId)).toBeUndefined()
      const r = await factory.principalResume({ projectId: 'project-1', nodeId, agent: 'claude', agentSessionId: sessionId, sessionCreated: stamp })
      expect(r).toMatchObject({ ok: true, outcome: 'attached' })
      expect(paneOwnerProject(nodeId)).toBe('project-1')
      expect(factory.holdsSession(nodeId)).toBe(true)
      // Nothing typed into the running agent.
      expect(pty.sends).toHaveLength(1)
    })

    it('session present with ANOTHER stamp (killed and recreated under the same name): refused, pane unproven', async () => {
      const { nodeId, sessionId, stamp } = await openOne()
      factory.stop()
      resetPaneOwnershipForTests()
      factory = new HeadlessNodeFactory({
        workspaceStore: store,
        ptyManager: pty,
        settings,
        cliCaps: async () => ({ version: null, autoPermissionMode: false, fullscreenTui: false, sessionIdFlag }),
        grokCaps: async () => ({ sessionIdFlag: false, models: [] }),
        codexCaps: async () => ({ approvalValues: ['on-request', 'never'] }),
        codexSharedIdentity: async () => false,
        stateOf: () => undefined,
        launchTiming: { quietMs: 0, capMs: 0 }
      })
      pty.stamps.set(nodeId, (stamp ?? 0) + 99)
      const r = await factory.principalResume({ projectId: 'project-1', nodeId, agent: 'claude', agentSessionId: sessionId, sessionCreated: stamp })
      expect(r).toMatchObject({ ok: false, error: 'session-replaced' })
      expect(paneOwnerProject(nodeId)).toBeUndefined()
      // And with no recorded stamp at all, the same refusal.
      const r2 = await factory.principalResume({ projectId: 'project-1', nodeId, agent: 'claude', agentSessionId: sessionId })
      expect(r2).toMatchObject({ ok: false, error: 'session-replaced' })
    })

    it('session absent (reboot): restarts the agent ON its conversation', async () => {
      const { nodeId, sessionId } = await openOne()
      pty.live.delete(nodeId)
      const r = await factory.principalResume({
        projectId: 'project-1',
        nodeId,
        agent: 'claude',
        agentSessionId: sessionId,
        transcriptPresence: async () => 'present'
      })
      expect(r).toMatchObject({ ok: true, outcome: 'resumed' })
      expect(pty.sends.at(-1)!.text).toBe(`claude --resume ${sessionId}`)
      expect(r.ok && r.sessionCreated).toBe(pty.stamps.get(nodeId))
    })

    it('session absent and the transcript gone: a fresh agent with a NEW id, persisted', async () => {
      const { nodeId, sessionId } = await openOne()
      pty.live.delete(nodeId)
      const r = await factory.principalResume({
        projectId: 'project-1',
        nodeId,
        agent: 'claude',
        agentSessionId: sessionId,
        transcriptPresence: async () => 'absent'
      })
      expect(r).toMatchObject({ ok: true, outcome: 'started-fresh', reason: 'transcript-missing' })
      const newId = r.ok ? r.agentSessionId : undefined
      expect(newId).toBeTruthy()
      expect(newId).not.toBe(sessionId)
      expect((await nodes()).find((n) => n.id === nodeId)!.agentSessionId).toBe(newId)
    })

    it('an unknown transcript answer still resumes (only a positive absent drops the id)', async () => {
      const { nodeId, sessionId } = await openOne()
      pty.live.delete(nodeId)
      const r = await factory.principalResume({ projectId: 'project-1', nodeId, agent: 'claude', agentSessionId: sessionId, transcriptPresence: async () => 'unknown' })
      expect(r).toMatchObject({ ok: true, outcome: 'resumed' })
    })

    it('an unreadable tmux is refused, never guessed', async () => {
      const { nodeId } = await openOne()
      pty.verdict = 'unknown'
      expect(await factory.principalResume({ projectId: 'project-1', nodeId, agent: 'claude' })).toMatchObject({ ok: false, error: 'session-unreadable' })
    })

    it('a node a person removed is reported, not resurrected', async () => {
      const { nodeId } = await openOne()
      const ws = await load()
      ws.projects[0].nodes = []
      await store.save(ws)
      expect(await factory.principalResume({ projectId: 'project-1', nodeId, agent: 'claude' })).toMatchObject({ ok: false, error: 'node-missing' })
    })

    it('session alive but the AGENT exited (OOM, crash, /exit): relaunched on its conversation', async () => {
      const { nodeId, sessionId, stamp } = await openOne()
      pty.paneCmd.set(nodeId, 'bash')
      const r = await factory.principalResume({
        projectId: 'project-1',
        nodeId,
        agent: 'claude',
        agentSessionId: sessionId,
        sessionCreated: stamp,
        transcriptPresence: async () => 'present'
      })
      expect(r).toMatchObject({ ok: true, outcome: 'resumed', reason: 'agent-exited' })
      expect(pty.sends.at(-1)!.text).toBe(`claude --resume ${sessionId}`)
      // The same session: no second spawn of a new one.
      expect(pty.stamps.get(nodeId)).toBe(stamp)
    })

    it('an unreadable pane is never typed into', async () => {
      const { nodeId, stamp } = await openOne()
      pty.paneCommand = async () => null
      const before = pty.sends.length
      expect(await factory.principalResume({ projectId: 'project-1', nodeId, agent: 'claude', sessionCreated: stamp })).toMatchObject({ ok: true, outcome: 'already-running' })
      expect(pty.sends).toHaveLength(before)
    })

    it('a session this server already holds is already-running', async () => {
      const { nodeId, stamp } = await openOne()
      expect(await factory.principalResume({ projectId: 'project-1', nodeId, agent: 'claude', sessionCreated: stamp })).toMatchObject({ ok: true, outcome: 'already-running' })
    })
  })

  describe('close', () => {
    it('ends the session, removes the node, and removes a frame this close emptied', async () => {
      const r = await factory.principalOpen(spec({ frame: { title: 'Jira' } }), () => {})
      if (!r.ok) throw new Error('open failed')
      const c = await factory.principalClose({ projectId: 'project-1', nodeId: r.nodeId, frameId: r.frameId })
      expect(c).toEqual({ ok: true, nodeMissing: false, frameRemoved: true })
      expect(pty.destroyed).toEqual([r.nodeId])
      expect(await nodes()).toEqual([])
    })

    it('keeps a frame that still holds another node', async () => {
      const a = await factory.principalOpen(spec({ frame: { title: 'Jira' } }), () => {})
      if (!a.ok) throw new Error('open failed')
      const b = await factory.principalOpen(spec({ key: 'APP-2', frame: { id: a.frameId! } }), () => {})
      if (!b.ok) throw new Error('open failed')
      const c = await factory.principalClose({ projectId: 'project-1', nodeId: a.nodeId, frameId: a.frameId })
      expect(c).toMatchObject({ ok: true, frameRemoved: false })
      expect((await nodes()).map((n) => n.id).sort()).toEqual([a.frameId, b.nodeId].sort())
    })

    it('a node already removed by a person: session still ended, nodeMissing', async () => {
      const r = await factory.principalOpen(spec(), () => {})
      if (!r.ok) throw new Error('open failed')
      const ws = await load()
      ws.projects[0].nodes = []
      await store.save(ws)
      expect(await factory.principalClose({ projectId: 'project-1', nodeId: r.nodeId })).toEqual({ ok: true, nodeMissing: true, frameRemoved: false })
      expect(pty.destroyed).toEqual([r.nodeId])
    })
  })
})
