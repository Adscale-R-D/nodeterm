// WHICH DIRECTORY A NEW NODE INHERITS from the frame it lands in — one pure copy of the walk, used
// by Canvas's `cwdForNewNodeIn` callback (the human paths: add-menu, drop, worktree binding) and by
// the canvas-control `verify` verb, which must resolve it for a node it did not create.
//
// It exists as a leaf because the two callers cannot share a closure. The control effect runs with an
// EMPTY dependency array — deliberately: it resolves everything per request through refs and
// `getState()`, so a project switch can never leave it acting on a stale canvas. Reusing the
// component callback from in there would have captured the FIRST render's `isSshProject`, so a
// session that started on a local project and switched to an SSH one could hand out a local worktree
// path for a remote node. Passing the facts in makes that unrepresentable.
//
// A frame's worktree OUTRANKS its `cwd`, and frames NEST: the answer is the nearest ancestor that
// states either, so a node in a sub-frame of a worktree frame still belongs to that checkout.

/** The subset of a canvas node this walk reads. */
export interface CwdChainNode {
  id: string
  parentId?: string
  data: { cwd?: string; worktree?: { path: string } }
}

export function resolveInheritedCwd(
  nodes: readonly CwdChainNode[],
  parentId: string | undefined,
  opts: {
    /** Frames whose worktree directory has gone missing (see state/worktrees.ts). */
    staleGroupIds: readonly string[]
    /** SSH projects have no worktree support (v1), so a bound path must never be handed out. */
    isSshProject: boolean
  }
): string | undefined {
  // `seen` guards a parent cycle. `reparentNode` refuses to create one, but this walk runs against
  // whatever is on the canvas — including a hand-edited project.json — and an infinite loop here
  // would hang the render, not fail it.
  const seen = new Set<string>()
  let currentId = parentId
  while (currentId && !seen.has(currentId)) {
    seen.add(currentId)
    const parent = nodes.find((n) => n.id === currentId)
    if (!parent) return undefined
    const stale = opts.staleGroupIds.includes(currentId)
    if (parent.data.worktree && !stale && !opts.isSshProject) return parent.data.worktree.path
    if (parent.data.cwd) return parent.data.cwd
    currentId = parent.parentId
  }
  return undefined
}
