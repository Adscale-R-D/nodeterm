/**
 * The `board` control verb's answer: the kanban board's columns, the session cards filed in each,
 * and the virtual Ungrouped column. Pure, so the two callers — the caller's own project (the
 * dispatch's `case 'board'`) and `board --project <id>` (an own or granted project, issue #1179) —
 * cannot describe a board two ways.
 *
 * `sessions` are the project's session cards (`toKanbanSession` over that project's nodes): the
 * board file only stores column assignments, so a session with no/dangling assignment sits
 * Ungrouped, and an assignment for a node that is not a session is not listed.
 */
import type { ProjectKanban } from '@shared/types'
import { boardSnapshot, type BoardSnapshotColumn } from '@shared/kanban-control'

// Fork: ONE definition of the board reply. `@shared/kanban-control`'s `boardSnapshot` is what the
// Server Edition's headless `board` answers with, and it marks agent-created columns; this keeps
// upstream's name for its callers and delegates, so the desktop's two `board` paths and the
// server's cannot describe a board three ways.
export interface BoardVerbReply {
  message: string
  result: { columns: BoardSnapshotColumn[]; ungrouped: string[] }
}

export function boardVerbReply(
  board: ProjectKanban | undefined,
  sessions: readonly { id: string; title?: string }[],
  projectName?: string
): BoardVerbReply {
  return boardSnapshot(board, sessions.map((s) => ({ id: s.id, title: s.title ?? '' })), projectName)
}
