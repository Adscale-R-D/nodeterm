// The node menu's "Status ▸" rows (@shared/node-work-status), through the off-canvas context: the
// Omni board and the per-project board's background lanes write through the project's write router.
// Plain node environment on purpose (the menu builder renders nothing).
import { beforeEach, describe, expect, it, vi } from 'vitest'
// The stores read `window.nodeTerminal` at import; jsdom does not start on this toolchain's Node, so
// a bare window stands in (vi.hoisted runs before the imports below).
vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>
  g.window ??= globalThis
  g.addEventListener ??= () => undefined
  g.removeEventListener ??= () => undefined
})
import { DEFAULT_SETTINGS, type CanvasNodeState } from '@shared/types'
import type { MenuItem } from '../components/ContextMenu'
import { useAgentStatus } from '../state/agentStatus'
import { useSettings } from '../state/settings'
import { nodeStatesToFlow } from '../state/workspace'
import { BOARD_NODE_ACTION_IDS, buildNodeActionItems, offCanvasNodeActionCtx, type OffCanvasCtxInput } from './nodeActionItems'

const stored = (id: string, extra: Partial<CanvasNodeState> = {}): CanvasNodeState =>
  ({ id, kind: 'terminal', position: { x: 0, y: 0 }, size: { width: 400, height: 300 }, title: id, color: '#fff', group: null, ...extra }) as CanvasNodeState

function input(nodes: CanvasNodeState[], setWorkStatus = vi.fn()): OffCanvasCtxInput {
  return {
    nodes: nodeStatesToFlow(nodes),
    sessionSource: 'local',
    gatewayModels: [],
    gatewayStatus: 'idle',
    gatewayError: '',
    grokModels: () => [],
    cursorModels: () => [],
    writes: { setColor: vi.fn(), pickIcon: vi.fn(), setWorkStatus },
    connectedProjectIdForHost: () => undefined,
    refuse: vi.fn()
  }
}

const statusMenu = (items: MenuItem[]): Extract<MenuItem, { type: 'submenu' }> | undefined =>
  items.find((i): i is Extract<MenuItem, { type: 'submenu' }> => i.type === 'submenu' && i.label === 'Status')
const labels = (items: MenuItem[]): string[] => items.map((i) => ('label' in i ? i.label : i.type === 'separator' ? '—' : i.type))

beforeEach(() => {
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS } })
  useAgentStatus.setState({ byId: {} } as never)
})

describe('Status ▸ in the node menu', () => {
  it('is on the board card menus too', () => {
    expect(BOARD_NODE_ACTION_IDS).toContain('work-status')
  })

  it('offers the four kinds for a session node, and Clear once one is set', () => {
    const write = vi.fn()
    const fresh = statusMenu(buildNodeActionItems(['t1'], undefined, offCanvasNodeActionCtx(input([stored('t1')], write))))!
    expect(labels(fresh.children)).toEqual(['Clarifying', 'Planning', 'Implementing', 'In review', 'Waiting on someone', 'Ready for you', 'Blocked'])
    const ready = fresh.children[5] as { onClick: () => void }
    ready.onClick()
    expect(write).toHaveBeenCalledWith(['t1'], expect.objectContaining({ kind: 'ready', by: 'user' }))

    const set = statusMenu(
      buildNodeActionItems(['t1'], undefined, offCanvasNodeActionCtx(input([stored('t1', { workStatus: { kind: 'ready', at: 1, by: 'agent' } })], write)))
    )!
    expect(labels(set.children)).toEqual(['Clarifying', 'Planning', 'Implementing', 'In review', 'Waiting on someone', 'Ready for you ✓', 'Blocked', '—', 'Clear status'])
    ;(set.children.at(-1) as { onClick: () => void }).onClick()
    expect(write).toHaveBeenLastCalledWith(['t1'], undefined)
  })

  it('a multi-selection sets them all, and is not offered on a non-session node', () => {
    const write = vi.fn()
    const many = statusMenu(
      buildNodeActionItems(['t1', 't2'], undefined, offCanvasNodeActionCtx(input([stored('t1'), stored('t2')], write)))
    )!
    ;(many.children[0] as { onClick: () => void }).onClick()
    expect(write).toHaveBeenCalledWith(['t1', 't2'], expect.objectContaining({ kind: 'clarifying' }))
    const sticky = buildNodeActionItems(['s1'], undefined, offCanvasNodeActionCtx(input([stored('s1', { kind: 'sticky' })])))
    expect(statusMenu(sticky)).toBeUndefined()
  })

  it('can be hidden in Settings', () => {
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, hiddenNodeMenuItems: ['work-status'] } })
    expect(statusMenu(buildNodeActionItems(['t1'], undefined, offCanvasNodeActionCtx(input([stored('t1')]))))).toBeUndefined()
  })
})
