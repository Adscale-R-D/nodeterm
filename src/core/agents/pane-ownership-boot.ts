// Fork patch #6 (docs/fork/STATUS.md): boot the durable pane-owner rows (agents/pane-ownership.ts).
// One function for both shells, so neither can forget a leg.
//
// Only the instance that owns the hook endpoint owns the file (the durable-state rule): a second
// instance on the same userData attaches no store at all, so it writes no row and restores no owner
// — exactly the pre-patch behaviour for it.
import { DurableFactFile } from '../durable-state'
import { PANE_OWNER_FACT, attachPaneOwnershipStore, type PaneOwnerRecord } from './pane-ownership'

export interface DurablePaneOwnershipPty {
  restorePaneOwnership(only?: readonly string[]): Promise<string[]>
  enableDurablePaneOwnership(): void
}

export function initDurablePaneOwnership(
  pty: DurablePaneOwnershipPty,
  opts: { userDataDir: string; ownsDurableState: boolean },
  makeFile: (dir: string) => Pick<DurableFactFile<PaneOwnerRecord>, 'load' | 'save' | 'dispose'> = (dir) =>
    new DurableFactFile(PANE_OWNER_FACT, { userDataDir: dir })
): { ready: Promise<string[]>; dispose(): void } {
  if (!opts.ownsDurableState) return { ready: Promise.resolve([]), dispose: () => undefined }
  const file = makeFile(opts.userDataDir)
  attachPaneOwnershipStore(file)
  pty.enableDurablePaneOwnership()
  const ready = pty.restorePaneOwnership().catch(() => [] as string[])
  return { ready, dispose: () => file.dispose() }
}
