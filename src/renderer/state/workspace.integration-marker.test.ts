// The integration-principal marker (`CanvasNodeState.integration`, docs/integration-principal.md) is
// DISPLAY ONLY and arrives in a git-shared file, so both serializer seams re-check it: a hostile or
// malformed value becomes no marker, the node itself is kept.
import { describe, expect, it } from 'vitest'

import { duplicateNode, flowToNodeStates, nodeStatesToFlow } from './workspace'
import type { CanvasNodeState } from '@shared/types'

const node = (integration: unknown): CanvasNodeState =>
  ({
    id: 'term-1',
    kind: 'terminal',
    position: { x: 0, y: 0 },
    size: { width: 640, height: 440 },
    title: 'APP-1',
    color: '#0a84ff',
    group: null,
    tags: [],
    agentId: 'claude',
    integration
  }) as CanvasNodeState

describe('integration marker at the serializer seams', () => {
  it('round-trips a valid marker', () => {
    const m = { name: 'sink', key: 'APP-1', label: 'Sink' }
    const flow = nodeStatesToFlow([node(m)])
    expect(flow[0].data.integration).toEqual(m)
    expect(flowToNodeStates(flow)[0].integration).toEqual(m)
  })

  it('drops a hostile marker on the way IN and keeps the node', () => {
    for (const bad of [{ name: '../x', key: 'A' }, { name: 'sink', key: 'a b' }, 'sink', [1], { name: 'sink' }]) {
      const flow = nodeStatesToFlow([node(bad)])
      expect(flow).toHaveLength(1)
      expect(flow[0].data.integration).toBeUndefined()
    }
  })

  it('drops a bad label but keeps the marker', () => {
    const flow = nodeStatesToFlow([node({ name: 'sink', key: 'A', label: 'x‮y' })])
    expect(flow[0].data.integration).toEqual({ name: 'sink', key: 'A' })
  })

  it('re-checks on the way OUT too', () => {
    const flow = nodeStatesToFlow([node(undefined)])
    flow[0].data.integration = { name: 'BAD NAME', key: 'A' } as never
    expect(flowToNodeStates(flow)[0].integration).toBeUndefined()
  })

  it('a duplicate is not the principal\'s node', () => {
    const flow = nodeStatesToFlow([node({ name: 'sink', key: 'A' })])
    expect(duplicateNode(flow[0]).data.integration).toBeUndefined()
  })
})
