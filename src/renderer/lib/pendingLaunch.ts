// Pure logic for ARMED terminal nodes — the canvas-control `--after` dependency edge. A node
// opened with `--after <ids>` holds its launch command (see PendingLaunch in @shared/types)
// until every station it waits on has gone idle; this module decides when that is, and which
// dependency edges to draw meanwhile. Kept free of React/store imports so the satisfaction
// matrix is unit-testable — Canvas.tsx only wraps these in an effect and a setState.
import type { AgentState } from '@shared/agents/normalize'
import type { PendingLaunch } from '@shared/types'

/** The subset of a canvas node this module reads. */
export interface ArmedNode {
  id: string
  data: { pendingLaunch?: PendingLaunch }
}

/** The subset of the agentStatus store this module reads. */
export type StatusById = Record<string, { state?: AgentState } | undefined>

export interface LaunchToFire {
  id: string
  command: string
}

/**
 * Is one dependency satisfied?
 *
 * `done` is the agent's busy→idle edge — the same signal that drives the completion badge and
 * notification. It means "this station has produced something and stopped", which is exactly
 * when a downstream station should start reading it. It does NOT mean "this station will never
 * run again": an agent that finishes turn 1 and awaits more input is also `done`. That is the
 * intended semantics for a station given one self-contained prompt, and it is documented as
 * such rather than being papered over with a turn counter that would guess differently.
 *
 * A dep that is no longer on the canvas counts as satisfied — a deleted node can never report,
 * so treating it as pending would strand the dependent forever. An UNKNOWN state (the dep
 * exists but has reported nothing yet) is deliberately NOT satisfied: right after a fan-out the
 * upstream stations have not emitted a hook event yet, and reading "no news" as "finished"
 * would fire every dependent immediately — the exact bug that makes a dependency edge useless.
 */
function depSatisfied(depId: string, status: StatusById, live: ReadonlySet<string>): boolean {
  if (!live.has(depId)) return true
  return status[depId]?.state === 'done'
}

/**
 * Which armed nodes are ready to launch, given the live canvas and the current agent states.
 * `live` is passed in (rather than derived from `nodes`) because the caller already holds the
 * full node list while `nodes` here may be pre-filtered.
 */
export function launchesToFire(
  nodes: readonly ArmedNode[],
  status: StatusById,
  live: ReadonlySet<string>
): LaunchToFire[] {
  const out: LaunchToFire[] = []
  for (const n of nodes) {
    const p = n.data.pendingLaunch
    if (!p || !p.command) continue
    if (p.after.every((d) => depSatisfied(d, status, live))) out.push({ id: n.id, command: p.command })
  }
  return out
}

/** The deps an armed node is still waiting on — what the node badge and tooltip report. */
export function unmetDeps(
  node: ArmedNode,
  status: StatusById,
  live: ReadonlySet<string>
): string[] {
  const p = node.data.pendingLaunch
  if (!p) return []
  return p.after.filter((d) => !depSatisfied(d, status, live))
}

export interface DependencyEdge {
  id: string
  source: string
  target: string
}

/**
 * The dashed dep→node edges to draw for everything still waiting. Derived from node data on
 * every render rather than persisted as edges: a pending dependency is a STATE, not a durable
 * relation, and it disappears when the launch fires. (The durable relation `--after` also
 * creates is an ordinary context bridge, so the downstream node can still read its upstream
 * long after the arrow is gone.)
 */
export function dependencyEdges(
  nodes: readonly ArmedNode[],
  live: ReadonlySet<string>
): DependencyEdge[] {
  const out: DependencyEdge[] = []
  for (const n of nodes) {
    for (const dep of n.data.pendingLaunch?.after ?? []) {
      // A dep that is gone draws nothing — it is already satisfied, and an edge to a node that
      // isn't there would be dropped by React Flow anyway.
      if (live.has(dep)) out.push({ id: `dep-${dep}-${n.id}`, source: dep, target: n.id })
    }
  }
  return out
}

/**
 * WHAT A TERMINAL NODE TYPES INTO ITS PANE THE MOMENT IT MOUNTS — the ordering between three
 * features that each own that first keystroke, and which read alike from inside the mount effect.
 *
 *  - `initial`  — a one-shot `initialCommand` (first open of a fresh node: the agent CLI, or a
 *                 `gh auth login`). Consumed and cleared by the caller.
 *  - `armed`    — NOTHING. An `--after` node's launch has not run yet; Canvas fires
 *                 `pendingLaunch.command` when its dependencies report done.
 *  - `resume`   — cold restore (machine reboot, first open post-`fresh`) of a resumable agent:
 *                 relaunch the CLI, resuming its prior conversation when an id is known.
 *  - `none`     — a warm reattach (tmux redraws), or a plain terminal (just the restored shell).
 *
 * `armed` OUTRANKS `resume`, and that ordering is the whole reason this function exists. `armAfter`
 * moves the factory's command into `pendingLaunch` and leaves `initialCommand` unset, so an armed
 * node is byte-identical to a cold-restored one from inside the effect — it fell through to
 * `resume` and resumed `data.agentSessionId`, the id `createAgentNode` MINTS up front and bakes into
 * the launch as `--session-id`. That session does not exist yet (the pending launch is what would
 * create it), so every armed node opened with `claude --resume <uuid>` → "No conversation found with
 * session ID: …". Reported from a live `verify` panel whose four reviewers all read as dead; it hit
 * every `--after` node. Both features are correct alone — minting is what stops a cold restore from
 * opening a BLANK conversation — so this is an ordering fix, not a repair of either.
 */
export function mountLaunchAction(input: {
  initialCommand?: string
  pendingLaunch?: PendingLaunch
  /** `PtyCreateResult.fresh` — a cold start (first open or post-reboot), not a warm reattach. */
  fresh: boolean
  /** The node's agent, if any. A plain terminal has none. */
  agentId?: string
  /** `canResume(agentId)` — membership of RESUMABLE_AGENTS, injected to keep this leaf pure. */
  resumable: boolean
}): 'initial' | 'armed' | 'resume' | 'none' {
  if (input.initialCommand) return 'initial'
  if (input.pendingLaunch) return 'armed'
  if (input.fresh && input.agentId && input.resumable) return 'resume'
  return 'none'
}
