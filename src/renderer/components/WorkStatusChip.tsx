import { useEffect, useRef, useState } from 'react'
import { isTopDialog, nextDialogId, popDialog, pushDialog } from './dialog-stack'
import {
  normalizeWorkStatus,
  WORK_STATUS_KINDS,
  WORK_STATUS_LABELS,
  WORK_STATUS_SHORT,
  type NodeWorkStatus,
  type WorkStatusKind
} from '@shared/node-work-status'
import { ContextMenu, type MenuItem } from './ContextMenu'

/**
 * A node's WORK STATUS chip (@shared/node-work-status): where the session's work stands, said by the
 * session (`set-status`) or by the person, and kept until one of them changes it. Drawn by the canvas
 * node header, the board card and the card modal — one component, so the three views of one node
 * cannot disagree.
 *
 * Deliberately NOT drawn like the agent-state badges: RUNNING / NEEDS YOU are filled, uppercase and
 * pulse; this is an outline pill with a coloured dot, never animated, so "Blocked" beside a red
 * NEEDS YOU and "Ready" beside an unread glow read as different kinds of fact.
 */

export function WorkStatusDot({ kind }: { kind: WorkStatusKind }): React.JSX.Element {
  return <span className={`work-status-dot work-status-dot--${kind}`} aria-hidden />
}

/** The tooltip: the full label, the note, who said it and when. */
export function workStatusTitle(s: NodeWorkStatus, now: number = Date.now()): string {
  const who = s.by === 'agent' ? 'the session' : 'you'
  const lines = [`${WORK_STATUS_LABELS[s.kind]}${s.note ? ` — ${s.note}` : ''}`, `Set by ${who} ${ago(now - s.at)}.`]
  return lines.join('\n')
}

function ago(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return 'just now'
  const m = Math.floor(ms / 60_000)
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h} h ago`
  return `${Math.floor(h / 24)} days ago`
}

/**
 * The rows that set or clear a status, for the node menu's "Status ▸" and the chip's own menu. A
 * menu pick replaces the status with the person's own (no note: a note is the session's account of
 * its work, and a person changing the kind is overruling it).
 */
export function workStatusMenuItems(
  current: NodeWorkStatus | undefined,
  onSet: (status: NodeWorkStatus | undefined) => void,
  now: () => number = Date.now
): MenuItem[] {
  const rows: MenuItem[] = WORK_STATUS_KINDS.map((kind) => ({
    label: current?.kind === kind ? `${WORK_STATUS_LABELS[kind]} ✓` : WORK_STATUS_LABELS[kind],
    icon: <WorkStatusDot kind={kind} />,
    onClick: () => {
      if (current?.kind === kind) return
      onSet({ kind, at: now(), by: 'user' })
    }
  }))
  if (current) {
    rows.push({ type: 'separator' }, { label: 'Clear status', onClick: () => onSet(undefined) })
  }
  return rows
}

export function WorkStatusChip({
  status,
  onSet,
  compact
}: {
  status: unknown
  /** Present when the person may change it from here: a click opens the status menu. */
  onSet?: (status: NodeWorkStatus | undefined) => void
  /** The card face: dot + short label only, the note stays in the tooltip. */
  compact?: boolean
}): React.JSX.Element | null {
  const s = normalizeWorkStatus(status)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  if (!s) return null
  const title = `${workStatusTitle(s)}${onSet ? '\nClick to change.' : ''}`
  const body = (
    <>
      <WorkStatusDot kind={s.kind} />
      <span className="work-status-chip__label">{WORK_STATUS_SHORT[s.kind]}</span>
      {!compact && s.note ? <span className="work-status-chip__note">{s.note}</span> : null}
    </>
  )
  if (!onSet) {
    return (
      <span className={`work-status-chip work-status-chip--${s.kind} nodrag`} title={title}>
        {body}
      </span>
    )
  }
  return (
    <>
      <button
        type="button"
        className={`work-status-chip work-status-chip--${s.kind} work-status-chip--button nodrag`}
        title={title}
        aria-label={`Status: ${WORK_STATUS_LABELS[s.kind]}${s.note ? ` — ${s.note}` : ''}. Change status`}
        onPointerDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation()
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
          setMenu({ x: r.left, y: r.bottom + 4 })
        }}
      >
        {body}
      </button>
      {menu && <ChipMenu at={menu} items={workStatusMenuItems(s, onSet)} onClose={() => setMenu(null)} />}
    </>
  )
}

/**
 * The chip's own menu. Two things a plain `ContextMenu` here would get wrong:
 *  - React events bubble through a portal to the component tree it is MOUNTED in, so a click on a
 *    row would also reach the board card behind it (opening the card modal) or the node header.
 *    The wrapper stops every pointer/click event at the chip.
 *  - Escape: the card modal listens in the capture phase and closes the whole modal. The menu
 *    therefore registers on the dialog stack, so the modal is no longer the top dialog, and takes
 *    Escape itself.
 */
function ChipMenu({
  at,
  items,
  onClose
}: {
  at: { x: number; y: number }
  items: MenuItem[]
  onClose: () => void
}): React.JSX.Element {
  // The menu registers ONCE for its lifetime; the latest close callback is read through a ref.
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const id = nextDialogId()
    pushDialog(id)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || !isTopDialog(id)) return
      e.preventDefault()
      e.stopPropagation()
      close.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      popDialog(id)
    }
  }, [])
  const stop = (e: React.SyntheticEvent): void => e.stopPropagation()
  return (
    <span
      className="nodrag"
      onClick={stop}
      onPointerDown={stop}
      onMouseDown={stop}
      onDoubleClick={stop}
      onContextMenu={stop}
    >
      <ContextMenu x={at.x} y={at.y} zIndex={70} items={items} onClose={onClose} />
    </span>
  )
}
