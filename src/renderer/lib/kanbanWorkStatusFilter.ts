/**
 * The board's work-status filter (@shared/node-work-status): show only the cards whose session said
 * it is Investigating / Waiting / Ready / Blocked. Unlike the Running / Needs you / Unread chips it
 * filters on a STICKY fact, carried on the card itself, so it needs no store subscription — but it is
 * still component state only (not in a saved view): a view is shared content, and "show me what is
 * ready" is one person's question of the moment.
 *
 * ANDed with the label, member and agent-status filters; OR within itself.
 */
import { normalizeWorkStatus, WORK_STATUS_KINDS, type WorkStatusKind } from '@shared/node-work-status'

export interface WorkStatusCard {
  id: string
  kind: string
  workStatus?: unknown
}

/** The kind each card's session reported, keyed by card id (cards with none are absent). */
export function workStatusByCard(cards: readonly WorkStatusCard[]): Map<string, WorkStatusKind> {
  const m = new Map<string, WorkStatusKind>()
  for (const c of cards) {
    if (c.kind !== 'terminal') continue
    const s = normalizeWorkStatus(c.workStatus)
    if (s) m.set(c.id, s.kind)
  }
  return m
}

export function workStatusCounts(byCard: ReadonlyMap<string, WorkStatusKind>): Record<WorkStatusKind, number> {
  const counts = Object.fromEntries(WORK_STATUS_KINDS.map((k) => [k, 0])) as Record<WorkStatusKind, number>
  for (const k of byCard.values()) counts[k]++
  return counts
}

export function matchesWorkStatus(
  byCard: ReadonlyMap<string, WorkStatusKind>,
  id: string,
  filter: readonly WorkStatusKind[]
): boolean {
  if (!filter.length) return true
  const k = byCard.get(id)
  return !!k && filter.includes(k)
}
