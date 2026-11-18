/**
 * The runtime pane-ownership ledger: nodeId → the project that actually SPAWNED that node's pane,
 * this process run. It exists because the persisted store cannot be trusted to answer "who owns
 * this pane?" — `.nodeterm/project.json` is git-shared and hand-editable, so a hostile/cloned
 * project can LIST any node id, including one a different project is really running. A messaging
 * grant is per project, and panes are keyed by the BARE node id globally (tmux `nt-<nodeId>`), so
 * ownership derived from the file is a confused-deputy hole: PR #237's re-review drove it end to
 * end (a granted project A delivered into ungranted project B's live pane just by listing B's id).
 *
 * THE ONE FACT THAT IS NOT FORGEABLE BY A CLONED FILE is which project's `create()` actually
 * brought the tmux session into being. That is what this records, and only that:
 *
 *  - Recorded ONLY on a GENUINE FRESH SPAWN (`PtyManager.spawnNew` with `fresh === true` — no live
 *    session existed to reattach to). An attach/co-attach to a session someone else spawned never
 *    records, so a second project that merely OPENS a node id another project is running cannot
 *    claim it. `fresh` is the manager's own signal, not anything off the wire or the file.
 *  - The owner value is the machine-local project id the renderer passed at the create call
 *    (`PtyCreateOptions.ownerProjectId`) — the entry id (`IndexEntryV3.id`), never the file's
 *    git-copied `id`. A cloned repo gets a fresh entry id, so it cannot inherit another copy's
 *    ownership either.
 *
 * ── COLD STATE / RESTART ───────────────────────────────────────────────────────────────────────
 * The map is IN-MEMORY and starts empty every run. Before fork patch #6 that was the whole story:
 * after an app restart the tmux SERVER usually survives, the re-open ATTACHES (`fresh === false`)
 * and records nothing, so every surviving pane was UNPROVEN and messaging to it was REFUSED until
 * the session was truly respawned. The owner is still never taken from the ATTACHING caller (that
 * is how an attacker would re-acquire ownership by opening the victim's id first), nor from a tmux
 * session-env var (settable from any pane's shell). What patch #6 adds is a durable row written at
 * the fresh spawn and restored only when tmux's own stamp of the live session is unchanged — see
 * "DURABLE ROWS" below. Without that proof the pane stays unproven, which still fails closed and is
 * pinned by a test (`ownerOf` empty ⇒ the delivery gate refuses).
 *
 * ── SCOPE ───────────────────────────────────────────────────────────────────────────────────────
 * This is scoped to tmux-pane messaging ownership but is intentionally feature-neutral: S8 PR 4's
 * BrowserControlLedger and messaging PR 7's deliver-on-idle queue want the same "who really spawned
 * this node" answer and can consume `paneOwnerProject` directly. It lives in `src/core` (no
 * electron, no main import) so it ships on both shells; the opt-in Server Edition control runtime
 * now records and reads it through the same PtyManager and messaging service as desktop.
 */

import type { DurableFactFile, DurableFactSpec } from '../durable-state'

/** nodeId → owning projectId (machine-local entry id), for panes freshly spawned THIS run — or
 *  spawned in an earlier run and RE-PROVEN by their tmux stamp (see "DURABLE ROWS" below). */
const owners = new Map<string, string>()

// ── DURABLE ROWS (fork patch #6, docs/fork/STATUS.md) ──────────────────────────────────────────
// The in-memory map above dies with the process, so after an app or Server Edition restart every
// surviving pane read as unproven and messaging to it was refused. The fact that makes a pane
// re-provable without trusting anything a pane or a cloned file can write is tmux's own:
// `#{session_id}|#{session_created}|#{pid}` (PANE_STAMP_FORMAT). `session_id` ($N) is assigned by
// the tmux server and only ever increases, so a session killed and recreated under the same
// `nt-<id>` name — even in the same second — gets a new one (measured, tmux 3.4: `$1` → `$2`); a
// new server (reboot, kill-server) has a new pid. None of it is settable from a pane's shell.
//
// So a FRESH spawn also writes a row `{nodeId, ownerProjectId, stamp}` to
// `<userData>/orchestration-state/pane-owners.json`, and a later run restores the owner from the
// row ONLY when the live session's stamp is byte-identical. The owner always comes from the ROW,
// never from whoever attaches. A stamp that differs, or a session the tmux server positively does
// not have, drops the row; an unreadable answer keeps it and leaves the pane unproven. Local tmux
// sessions only: a remote node, the Windows session host and Zellij read no stamp, write no row and
// behave exactly as before (unproven after a restart).

export const PANE_STAMP_FORMAT = '#{session_id}|#{session_created}|#{pid}'
const PANE_STAMP_RE = /^\$\d{1,9}\|\d{1,12}\|\d{1,10}$/

/** A stamp is usable only when every part expanded: an unknown format expands to '' on tmux. */
export function isPaneStamp(v: unknown): v is string {
  return typeof v === 'string' && PANE_STAMP_RE.test(v)
}

export interface PaneOwnerRecord {
  nodeId: string
  ownerProjectId: string
  stamp: string
  at: number
}

const NODE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/

export function sanitizePaneOwnerRecord(raw: unknown): PaneOwnerRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (typeof r.nodeId !== 'string' || !NODE_ID_RE.test(r.nodeId)) return null
  if (typeof r.ownerProjectId !== 'string' || !r.ownerProjectId || r.ownerProjectId.length > 128) return null
  if (!isPaneStamp(r.stamp)) return null
  if (typeof r.at !== 'number' || !Number.isFinite(r.at)) return null
  return { nodeId: r.nodeId, ownerProjectId: r.ownerProjectId, stamp: r.stamp, at: r.at }
}

export const PANE_OWNER_FACT: DurableFactSpec<PaneOwnerRecord> = {
  kind: 'pane-owners',
  version: 1,
  maxRecords: 4000,
  sanitize: sanitizePaneOwnerRecord
}

type PaneOwnerFile = Pick<DurableFactFile<PaneOwnerRecord>, 'load' | 'save'>

let durable: { file: PaneOwnerFile; rows: Map<string, PaneOwnerRecord> } | null = null
/** Bumped by every record/forget, so a stamp read that lands after the pane changed hands (or
 *  ended) cannot write a row for a session that is no longer the one recorded. */
const generation = new Map<string, number>()
let missHook: ((nodeId: string) => void) | null = null
/** Node ids whose row a positive stamp mismatch (or absence) dropped this run. */
const refuted = new Set<string>()

function bump(nodeId: string): number {
  const g = (generation.get(nodeId) ?? 0) + 1
  generation.set(nodeId, g)
  return g
}

function saveRows(): void {
  if (!durable) return
  durable.file.save([...durable.rows.values()].sort((a, b) => a.at - b.at))
}

/** Boot: read the rows. Restores NO owner by itself — `reprovePaneOwners` does, against tmux. */
export function attachPaneOwnershipStore(file: PaneOwnerFile): void {
  const rows = new Map<string, PaneOwnerRecord>()
  for (const r of file.load()) rows.set(r.nodeId, r)
  durable = { file, rows }
}

/** Is there a durable row for this node (cheap; lets a caller skip a tmux read)? */
export function hasPaneOwnerRow(nodeId: string): boolean {
  return !!durable?.rows.has(nodeId)
}

/** Called when a gate meets an unproven pane that has a durable row (a throttled re-proof). */
export function setPaneOwnerMissHook(fn: ((nodeId: string) => void) | null): void {
  missHook = fn
}

/** Write the row for a FRESH spawn, once its stamp has been read. A no-op when the pane changed
 *  hands or ended since (`gen` is what `recordFreshSpawnOwner` returned). */
export function persistFreshSpawnStamp(nodeId: string, ownerProjectId: string, gen: number, stamp: string | null): void {
  if (!durable || !isPaneStamp(stamp)) return
  if (generation.get(nodeId) !== gen || owners.get(nodeId) !== ownerProjectId) return
  durable.rows.set(nodeId, { nodeId, ownerProjectId, stamp, at: Date.now() })
  saveRows()
}

/** Is `gen` still the live fresh spawn of `nodeId` by `ownerProjectId`? (Lets a retrying stamp
 *  read stop as soon as the pane ended or changed hands.) */
export function isCurrentFreshSpawn(nodeId: string, ownerProjectId: string, gen: number): boolean {
  return !!durable && generation.get(nodeId) === gen && owners.get(nodeId) === ownerProjectId
}

/** The durable rows' verdict for one node, for a caller with its own older proof to fall back on. */
export function paneRowVerdict(nodeId: string): 'proven' | 'refuted' | 'none' {
  const row = durable?.rows.get(nodeId)
  if (!row) return refuted.has(nodeId) ? 'refuted' : 'none'
  return owners.get(nodeId) === row.ownerProjectId ? 'proven' : 'none'
}

/**
 * Compare durable rows with what tmux answers now. `live(nodeId)`: the live stamp, `'absent'` when
 * the tmux server positively has no such session, or `null` when it could not be asked. Equal ⇒ the
 * row's owner is restored (never an owner this run already recorded over it); different or absent
 * ⇒ the row is dropped (the pane stays unproven); unknown ⇒ nothing changes. Answers the node ids
 * restored.
 */
export function reprovePaneOwners(live: (nodeId: string) => string | 'absent' | null, only?: readonly string[]): string[] {
  if (!durable) return []
  const restored: string[] = []
  let dropped = false
  for (const id of only ?? [...durable.rows.keys()]) {
    const row = durable.rows.get(id)
    if (!row) continue
    const now = live(id)
    if (now === null) continue
    if (now === 'absent' || !isPaneStamp(now) || now !== row.stamp) {
      durable.rows.delete(id)
      refuted.add(id)
      dropped = true
      continue
    }
    if (!owners.has(id)) {
      owners.set(id, row.ownerProjectId)
      restored.push(id)
    }
  }
  if (dropped) saveRows()
  return restored
}

/**
 * THE FRESH-GATE, pure and pinned: may this create() record pane ownership? True ONLY for a
 * genuine fresh spawn (`fresh === true`) of a persistent node (`persistKey`) whose owner is known
 * (`ownerProjectId`). This is the load-bearing security property — recording on an ATTACH
 * (`fresh === false`) would let a project claim a pane it merely re-opened after a restart, which
 * is exactly the confused deputy this ledger closes. Extracted so the gate has its own unit test
 * (`pane-ownership.test.ts`) rather than living only inside `spawnNew`.
 */
export function shouldRecordOwnership(
  fresh: boolean,
  persistKey: string | undefined,
  ownerProjectId: string | undefined
): boolean {
  return fresh === true && !!persistKey && !!ownerProjectId
}

/**
 * Record the owner of a node whose pane was just GENUINELY spawned. Call site: `spawnNew`, guarded
 * by `fresh === true` and a present `persistKey` + `ownerProjectId`. A fresh spawn for an id that
 * somehow already has an entry OVERWRITES it — the live pane is the one that just came into being.
 * A missing owner is a no-op (old callers / tests that pass no `ownerProjectId` simply leave the
 * pane unproven, which fails closed downstream — the correct direction).
 */
export function recordFreshSpawnOwner(nodeId: string, ownerProjectId: string | undefined): number | undefined {
  if (!nodeId || !ownerProjectId) return undefined
  owners.set(nodeId, ownerProjectId)
  refuted.delete(nodeId)
  // The row (if any) describes the session this spawn replaced; the caller writes the new one
  // once it has read the new session's stamp (`persistFreshSpawnStamp`).
  if (durable?.rows.delete(nodeId)) saveRows()
  return bump(nodeId)
}

/**
 * Re-record the owner of a pane an INTEGRATION PRINCIPAL's server spawned in an EARLIER run, after a
 * service restart where tmux survived (docs/integration-principal.md, decision D1-a). Besides
 * `reprovePaneOwners` (the durable rows, fork patch #6), the only place an attach may record — and
 * only because the caller proved, against the durable integration ledger, that the live tmux session
 * is the very one that run freshly spawned: its `#{session_created}` stamp equals the one recorded
 * at that spawn (its fallback for a node with no durable row). A pane's shell cannot change
 * that stamp (it is tmux server state, unlike a session-env var); a session killed and recreated
 * under the same `nt-<id>` name carries a new stamp and is refused. Callers: the integration
 * service's `resume` only. Never call this on a renderer's or an agent's attach.
 */
export function recordReprovedOwner(nodeId: string, ownerProjectId: string): void {
  if (!nodeId || !ownerProjectId) return
  owners.set(nodeId, ownerProjectId)
}

/** The project that provably spawned this node's pane this run, or `undefined` when unproven
 *  (never spawned here, or only ever attached — e.g. after a restart). Undefined MUST fail closed
 *  at every gate: an unprovable owner is not an absent restriction. */
export function paneOwnerProject(nodeId: string): string | undefined {
  const owner = owners.get(nodeId)
  if (owner === undefined && durable?.rows.has(nodeId)) missHook?.(nodeId)
  return owner
}

/** Drop a node's ownership — its session is ending (delete or recycle). A later genuine respawn
 *  re-records; until then the id is unproven again, which fails closed. */
export function forgetPaneOwner(nodeId: string): void {
  owners.delete(nodeId)
  bump(nodeId)
  if (durable?.rows.delete(nodeId)) saveRows()
}

/** Test seam only: wipe the ledger between cases. Never called in production. */
export function resetPaneOwnershipForTests(): void {
  owners.clear()
  generation.clear()
  refuted.clear()
  durable = null
  missHook = null
}
