import { describe, it, expect } from 'vitest'
import {
  dependencyEdges,
  launchesToFire,
  mountLaunchAction,
  unmetDeps,
  type ArmedNode,
  type StatusById
} from './pendingLaunch'

const armed = (id: string, after: string[], command = `echo ${id}`): ArmedNode => ({
  id,
  data: { pendingLaunch: { after, command } }
})
const plain = (id: string): ArmedNode => ({ id, data: {} })

describe('launchesToFire', () => {
  const live = new Set(['a', 'b', 'c'])

  it('fires when every dep has reported done', () => {
    const status: StatusById = { a: { state: 'done' }, b: { state: 'done' } }
    expect(launchesToFire([armed('c', ['a', 'b'])], status, live)).toEqual([
      { id: 'c', command: 'echo c' }
    ])
  })

  it('does NOT fire while a dep is still working', () => {
    const status: StatusById = { a: { state: 'done' }, b: { state: 'working' } }
    expect(launchesToFire([armed('c', ['a', 'b'])], status, live)).toEqual([])
  })

  it('does NOT fire on an unknown state — "no news" is not "finished"', () => {
    // The whole point: right after a fan-out the upstream stations have emitted nothing yet.
    expect(launchesToFire([armed('c', ['a'])], {}, live)).toEqual([])
  })

  it('treats waiting/blocked as not satisfied — the station still needs its user', () => {
    expect(launchesToFire([armed('c', ['a'])], { a: { state: 'waiting' } }, live)).toEqual([])
    expect(launchesToFire([armed('c', ['a'])], { a: { state: 'blocked' } }, live)).toEqual([])
  })

  it('treats a dep that is no longer on the canvas as satisfied', () => {
    // A deleted node can never report; waiting on it would strand the dependent forever.
    const status: StatusById = { a: { state: 'done' } }
    expect(launchesToFire([armed('c', ['a', 'ghost'])], status, new Set(['a', 'c']))).toEqual([
      { id: 'c', command: 'echo c' }
    ])
  })

  it('ignores nodes that are not armed, and armed nodes with an empty command', () => {
    const status: StatusById = { a: { state: 'done' } }
    expect(launchesToFire([plain('c'), armed('d', ['a'], '')], status, live)).toEqual([])
  })

  it('fires immediately when there are no deps left to wait on', () => {
    expect(launchesToFire([armed('c', [])], {}, live)).toEqual([{ id: 'c', command: 'echo c' }])
  })
})

describe('unmetDeps', () => {
  it('reports only the deps still outstanding', () => {
    const live = new Set(['a', 'b', 'c'])
    const status: StatusById = { a: { state: 'done' }, b: { state: 'working' } }
    expect(unmetDeps(armed('c', ['a', 'b']), status, live)).toEqual(['b'])
  })

  it('is empty for a node that is not armed', () => {
    expect(unmetDeps(plain('c'), {}, new Set(['c']))).toEqual([])
  })
})

describe('dependencyEdges', () => {
  it('draws one edge per live dep, pointing dep → dependent', () => {
    expect(dependencyEdges([armed('c', ['a', 'b'])], new Set(['a', 'b', 'c']))).toEqual([
      { id: 'dep-a-c', source: 'a', target: 'c' },
      { id: 'dep-b-c', source: 'b', target: 'c' }
    ])
  })

  it('draws nothing for a dep that is gone', () => {
    expect(dependencyEdges([armed('c', ['ghost'])], new Set(['c']))).toEqual([])
  })

  it('draws nothing once the node is no longer armed', () => {
    expect(dependencyEdges([plain('c')], new Set(['c']))).toEqual([])
  })
})

describe('mountLaunchAction — who owns the first keystroke', () => {
  const base = { fresh: true, agentId: 'claude', resumable: true }

  it('an ARMED node types NOTHING, even though it looks cold-restorable', () => {
    // THE REGRESSION, in the shape it was reported: armAfter leaves initialCommand unset, so an
    // armed node is indistinguishable from a cold restore from inside the mount effect. It used to
    // fall through to 'resume' and run `claude --resume <mintedSessionId>` for a session whose
    // launch had not run yet — "No conversation found with session ID: …", in every reviewer of a
    // verify panel, each with its own uuid.
    expect(
      mountLaunchAction({ ...base, pendingLaunch: { after: ['n-1'], command: 'claude -p "review"' } })
    ).toBe('armed')
  })

  it('stays armed on a WARM reattach too — the launch is pending either way', () => {
    expect(
      mountLaunchAction({ ...base, fresh: false, pendingLaunch: { after: ['n-1'], command: 'x' } })
    ).toBe('armed')
  })

  it('armed outranks initialCommand only in the impossible case — initialCommand still wins', () => {
    // armAfter moves the command, so both should never be set at once. If they somehow are, running
    // the one-shot is the safe answer: it is what the node would have done before it was armed, and
    // Canvas's launchInFlight ledger still keeps the pending delivery exactly-once.
    expect(
      mountLaunchAction({ ...base, initialCommand: 'claude', pendingLaunch: { after: [], command: 'y' } })
    ).toBe('initial')
  })

  it('a cold start of a resumable agent still resumes — the fix must not disable cold restore', () => {
    expect(mountLaunchAction(base)).toBe('resume')
  })

  it('a warm reattach types nothing (tmux redraws its own screen)', () => {
    expect(mountLaunchAction({ ...base, fresh: false })).toBe('none')
  })

  it('a plain terminal and a non-resumable agent get nothing but the restored shell', () => {
    expect(mountLaunchAction({ ...base, agentId: undefined, resumable: false })).toBe('none')
    expect(mountLaunchAction({ ...base, resumable: false })).toBe('none')
  })
})
