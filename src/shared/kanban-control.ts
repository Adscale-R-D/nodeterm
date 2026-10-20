import type { ProjectKanban } from './types'
import { assignedTo, isAgentColumn, unassigned } from './kanban'

// The canvas-control `board` / `assign` pieces that BOTH shells run — the desktop dispatch
// (renderer/canvas/Canvas.tsx) and the Server Edition's headless factory
// (server/headless-node-factory.ts). One definition, so an agent reading the board through either
// shell reads the same text and the same result shape.

/** A kanban card as the control verbs see it: an id and the label the board shows. */
export interface ControlCard {
  id: string
  title: string
}

/**
 * The card a PERSISTED node becomes, or null when the kind never becomes a card. Same kinds and
 * titles as the renderer's `toKanbanSession` / `toKanbanSessionState` (browser, sticky, terminal):
 * a server reading the board must not list a card the board would not show, nor name it
 * differently. `title` is the raw label — '' for an untitled terminal; `boardSnapshot` renders it.
 */
export function persistedControlCard(n: {
  id: string
  kind?: string
  title?: string
  text?: string
}): ControlCard | null {
  if (n.kind === 'browser') return { id: n.id, title: n.title || 'Browser' }
  if (n.kind === 'sticky') return { id: n.id, title: stickyCardTitle(n.text ?? '') }
  if (n.kind === 'terminal' || n.kind === undefined) return { id: n.id, title: n.title ?? '' }
  return null
}

/** A note has no title of its own — its trimmed first line is the card label (heading marker
 *  stripped, 80 chars). The renderer's two card mappers apply the same rule. */
export function stickyCardTitle(text: string): string {
  return text.trim().split('\n')[0].replace(/^#{1,6}\s+/, '').trim().slice(0, 80) || 'Note'
}

/** `--create yes` takes a VALUE, never bare presence (the repo rule for new flags: an SSH host
 *  keeps the shim it got at connect, whose loop reads a value after every flag). Same truthiness
 *  as `sticky --create`. */
export function wantsCreate(raw: string | undefined): boolean {
  return /^(yes|true|1)$/i.test(raw ?? '')
}

export interface BoardSnapshotColumn {
  id: string
  title: string
  cards: string[]
  /** Present only on columns canvas control created (and will remove once they empty). */
  origin?: 'agent'
}

/**
 * The `board` reply: every column with the cards filed in it, then the virtual Ungrouped column.
 * `board === undefined` is the lazy default — nothing has been written yet, so every card is
 * Ungrouped and the three default columns appear on the first edit (a `--create` is one).
 */
export function boardSnapshot(
  board: ProjectKanban | undefined,
  cards: readonly ControlCard[],
  /** Names the project in the header — `board --project <id>` reads a board other than the caller's. */
  projectName?: string
): { message: string; result: { columns: BoardSnapshotColumn[]; ungrouped: string[] } } {
  const titleOf = new Map(cards.map((c) => [c.id, c.title || 'Untitled']))
  const cardIds = cards.map((c) => c.id)
  const fmt = (ids: string[]): string[] => ids.map((id) => `  - ${titleOf.get(id)} (id: ${id})`)
  const head = projectName ? `Kanban board of project "${projectName}"` : 'Kanban board'
  if (!board) {
    return {
      message: [
        `${head}: (no columns yet — default To Do / In Progress / Done appears on first edit)`,
        `Ungrouped (${cardIds.length}):`,
        ...fmt(cardIds)
      ].join('\n'),
      result: { columns: [], ungrouped: cardIds }
    }
  }
  const columns: BoardSnapshotColumn[] = board.columns.map((c) => ({
    id: c.id,
    title: c.title,
    cards: assignedTo(board, c.id).filter((id) => titleOf.has(id)),
    ...(isAgentColumn(c) ? { origin: 'agent' as const } : {})
  }))
  const ungrouped = unassigned(board, cardIds)
  return {
    message: [
      `${head}:`,
      ...columns.flatMap((c) => [
        `${c.title} (${c.cards.length}) [column id: ${c.id}]${c.origin ? ' (agent-created)' : ''}:`,
        ...fmt(c.cards)
      ]),
      `Ungrouped (${ungrouped.length}):`,
      ...fmt(ungrouped)
    ].join('\n'),
    result: { columns, ungrouped }
  }
}
