// The board-log diff lives in `src/shared/board-log-diff.ts` so the Server Edition's headless
// `assign` narrates a move exactly as a desktop move does. Re-exported for renderer call sites.
export * from '@shared/board-log-diff'
