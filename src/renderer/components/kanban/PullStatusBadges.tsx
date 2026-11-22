import type {
  GitHubPullStatus,
  PullCiState,
  PullMergeState,
  PullReviewState,
  PullStatusFreshness
} from '@shared/github-pull-status'
import { pullRequestUrl } from '@shared/github-pull-status'
import { githubClock } from '../../lib/githubSyncStatus'

// ONE vocabulary for a pull request's state on every surface that shows it — the PR card, an issue
// card's "PR #M" chip, a session card's chip, and both modals. Two rules live here and nowhere else:
//  - CI renders only for a real result. `none` (GitHub reports no checks) and an ABSENT ci (the
//    token may not read checks, or the only result is for another commit) both render NOTHING:
//    no tick is ever drawn for checks that do not exist or cannot be seen.
//  - "Ready to merge" renders only for `ready`, which only `mergeStateStatus === CLEAN` produces.

const CI_LABEL: Record<Exclude<PullCiState, 'none'>, { text: string; glyph: string }> = {
  passed: { text: 'Checks passed', glyph: '✓' },
  failed: { text: 'Checks failing', glyph: '✗' },
  pending: { text: 'Checks running', glyph: '●' }
}

/** Merge states worth a word. `unstable` is said by the CI badge already, and `hooks` is neither a
 *  problem nor "ready" — both render nothing rather than a label that means little. */
const MERGE_LABEL: Partial<Record<PullMergeState, string>> = {
  ready: 'Ready to merge',
  conflict: 'Conflicts',
  blocked: 'Blocked',
  behind: 'Behind base',
  undecided: 'Checking mergeability…'
}

const LIFECYCLE_WORD = { draft: 'draft', merged: 'merged', closed: 'closed' } as const

export const REVIEW_LABEL: Record<PullReviewState, string> = {
  approved: 'Approved',
  changes: 'Changes requested',
  requested: 'Review requested',
  none: 'No review yet'
}

/** One small icon per review state, drawn apart from the CI glyphs (✓ ✗ ●) so the two cannot be
 *  read for each other: a check or a cross INSIDE a circle, an eye, a hollow circle. */
export function ReviewIcon({ review }: { review: PullReviewState }): React.JSX.Element {
  const common = { width: 10, height: 10, viewBox: '0 0 16 16', 'aria-hidden': true as const, className: 'pull-review__icon' }
  switch (review) {
    case 'approved':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <path d="M5 8.2l2 2 4-4.4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
    case 'changes':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      )
    case 'requested':
      return (
        <svg {...common}>
          <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
          <circle cx="8" cy="8" r="2" fill="currentColor" />
        </svg>
      )
    case 'none':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeDasharray="2.4 2" />
        </svg>
      )
  }
}

export function ciLabel(ci: PullCiState | undefined): { text: string; glyph: string } | null {
  return ci && ci !== 'none' ? CI_LABEL[ci] : null
}

export function mergeLabel(merge: PullMergeState | undefined): string | null {
  return merge ? MERGE_LABEL[merge] ?? null : null
}

function staleTitle(freshness: PullStatusFreshness, observedAt: number | undefined): string | undefined {
  if (freshness === 'fresh') return undefined
  return observedAt === undefined
    ? 'GitHub could not be reached to check this pull request.'
    : `Last checked at ${githubClock(observedAt)}. GitHub could not be reached since.`
}

/** The CI + merge line of an open PR, for the PR card and the PR modal. */
export function PullStatusLine({
  status,
  freshness,
  observedAt
}: {
  status: GitHubPullStatus | undefined
  freshness: PullStatusFreshness
  observedAt?: number
}): React.JSX.Element | null {
  if (!status) return null
  const ci = ciLabel(status.ci)
  const merge = mergeLabel(status.merge)
  const review = status.review
  if (!ci && !merge && !review) return null
  return (
    <div
      className={`pull-status pull-status--${freshness}`}
      title={staleTitle(freshness, observedAt)}
      data-testid="pull-status"
    >
      {ci && (
        <span className={`pull-status__ci pull-status__ci--${status.ci}`}>
          <span aria-hidden="true">{ci.glyph}</span> {ci.text}
        </span>
      )}
      {review && (
        <span className={`pull-status__review pull-review--${review}`}>
          <ReviewIcon review={review} /> {REVIEW_LABEL[review]}
        </span>
      )}
      {merge && <span className={`pull-status__merge pull-status__merge--${status.merge}`}>{merge}</span>}
      {freshness !== 'fresh' && <span className="pull-status__stale">stale</span>}
    </div>
  )
}

/** "PR #12 ✓ Ready" — the compact form an issue card or a session card carries. */
export function PullRefChip({
  status,
  freshness,
  repository
}: {
  status: GitHubPullStatus
  freshness: PullStatusFreshness
  /** The pull board's `owner/name`. Given, the chip is a button that opens the PR on GitHub. */
  repository?: string
}): React.JSX.Element {
  const open = status.lifecycle === 'open' || status.lifecycle === 'draft'
  const ci = open ? ciLabel(status.ci) : null
  const merge = open && status.lifecycle === 'open' ? mergeLabel(status.merge) : null
  const word = status.lifecycle === 'open' ? null : LIFECYCLE_WORD[status.lifecycle]
  const review = open ? status.review : undefined
  const parts = [`PR #${status.number}`, word, ci?.text, review ? REVIEW_LABEL[review] : undefined, merge].filter(Boolean)
  const url = pullRequestUrl(repository, status.number)
  const className = `pull-ref pull-ref--${status.lifecycle}${open ? ` pull-status--${freshness}` : ''}${url ? ' pull-ref--link' : ''}`
  const title = [parts.join(' · '), open ? staleTitle(freshness, undefined) : undefined, url ? 'Open on GitHub' : undefined]
    .filter(Boolean).join('\n')
  const body = (
    <>
      PR #{status.number}
      {word && <span className="pull-ref__word"> {word}</span>}
      {ci && <span className={`pull-ref__ci pull-status__ci--${status.ci}`} aria-label={ci.text}> {ci.glyph}</span>}
      {review && (
        <span className={`pull-ref__review pull-review--${review}`} aria-label={REVIEW_LABEL[review]}>
          {' '}<ReviewIcon review={review} />
        </span>
      )}
      {merge && status.merge === 'ready' && <span className="pull-ref__ready"> ready</span>}
      {merge && status.merge === 'conflict' && <span className="pull-ref__conflict"> conflicts</span>}
    </>
  )
  if (url) {
    // Sits inside a card (click = open the card modal, press = start a drag): the chip keeps its
    // click and its press to itself.
    return (
      <button
        type="button"
        className={`${className} nodrag`}
        title={title}
        draggable={false}
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          window.nodeTerminal.shell.openExternal(url)
        }}
      >
        {body}
      </button>
    )
  }
  return (
    <span className={className} title={title}>
      {body}
    </span>
  )
}
