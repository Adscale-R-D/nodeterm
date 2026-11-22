// Review state on a PR chip. The table rows are real app_ms answers (2026-11-22, read-only probe):
// `reviewDecision`, pending `reviewRequests`, and the latest approving / blocking reviews.
import { describe, expect, it } from 'vitest'
import { pullStatusFrom, reviewStateFrom, type PullStatusFacts } from './github-pull-status'

describe('reviewStateFrom', () => {
  it.each([
    ['#1400 approved, a re-review requested', 'APPROVED', 1, ['APPROVED'], 'approved'],
    ['#1437 changes requested', 'CHANGES_REQUESTED', 1, ['CHANGES_REQUESTED'], 'changes'],
    ['#1409 approved by one, blocked by another', 'CHANGES_REQUESTED', 1, ['APPROVED', 'CHANGES_REQUESTED'], 'changes'],
    ['#1430 required, nobody asked yet', 'REVIEW_REQUIRED', 0, [], 'none'],
    ['required and asked for', 'REVIEW_REQUIRED', 2, [], 'requested'],
    ['#1441 no decision (reviews not required), nothing', null, 0, [], 'none'],
    ['no decision, an approval', null, 0, ['APPROVED'], 'approved'],
    ['no decision, a blocking review beats an approval', null, 0, ['APPROVED', 'CHANGES_REQUESTED'], 'changes'],
    ['no decision, asked for', null, 1, [], 'requested']
  ] as const)('%s', (_name, decision, requested, opinions, expected) => {
    expect(reviewStateFrom(decision, requested, opinions)).toBe(expected)
  })

  it('a decision value GitHub adds later claims nothing', () => {
    expect(reviewStateFrom('SOMETHING_NEW', 1, ['APPROVED'])).toBeUndefined()
  })

  it('pullStatusFrom carries a known review and omits an unknown one', () => {
    const facts: PullStatusFacts = {
      number: 1, headRefName: 'x', headRefOid: 'a'.repeat(40), crossRepository: false, isDraft: false,
      mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', rollup: null, rollupOid: null, closes: []
    }
    const access = { ci: true, merge: true }
    expect(pullStatusFrom({ ...facts, review: 'approved' }, access).review).toBe('approved')
    expect(pullStatusFrom({ ...facts, review: null }, access)).not.toHaveProperty('review')
    expect(pullStatusFrom(facts, access)).not.toHaveProperty('review')
  })
})
