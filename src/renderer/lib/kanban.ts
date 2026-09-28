// The board transforms live in `src/shared/kanban.ts` so the Server Edition's headless canvas
// control can apply the SAME transforms the desktop does (`board` / `assign`); the card-meta and
// label half lives beside it in `src/shared/kanban-labels.ts`. Re-exported here so renderer call
// sites keep their import path.
export * from '@shared/kanban'
