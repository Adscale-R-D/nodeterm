// The Jira tickets an integration principal declared on a card (src/shared/integration-jira.ts):
// `A3-6926` with a status dot, the status and summary in the tooltip, and a click that opens the
// ticket in Jira. nodeterm never reads Jira — the status is what the principal last pushed, so the
// tooltip says when that was. Mounted on the session card (both boards) and in the card modal.
import { jiraTicketUrl, type JiraCategory, type JiraTicketLink } from '@shared/integration-jira'
import { useIntegrationJira, jiraLinksFor } from '../../state/integrationJira'

const CATEGORY_WORD: Record<JiraCategory, string> = {
  todo: 'To do',
  'in-progress': 'In progress',
  done: 'Done'
}

function received(at: number): string {
  const d = new Date(at)
  return Number.isNaN(d.getTime()) ? '' : `Status as of ${d.toLocaleString()}`
}

export function JiraTicketChip({ ticket, principal }: { ticket: JiraTicketLink; principal?: string }): React.JSX.Element {
  const url = jiraTicketUrl(ticket.site, ticket.key)
  const category = ticket.category
  const status = ticket.status ?? (category ? CATEGORY_WORD[category] : undefined)
  const title = [
    [ticket.key, status].filter(Boolean).join(' · '),
    ticket.summary,
    [received(ticket.at), principal ? `from ${principal}` : ''].filter(Boolean).join(', '),
    url ? 'Open in Jira' : undefined
  ]
    .filter(Boolean)
    .join('\n')
  const className = `pull-ref jira-ref jira-ref--${category ?? 'unknown'}${url ? ' pull-ref--link' : ''}`
  const body = (
    <>
      <span className="jira-ref__dot" aria-hidden="true" />
      {ticket.key}
    </>
  )
  const label = [ticket.key, status].filter(Boolean).join(', ')
  if (!url) return <span className={className} title={title} aria-label={label}>{body}</span>
  // Inside a card (click = open the card modal, press = start a drag): the chip keeps both.
  return (
    <button
      type="button"
      className={`${className} nodrag`}
      title={title}
      aria-label={`${label}. Open in Jira`}
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

/** The card's declared tickets, at most `max` (the rest counted). Nothing when none are declared. */
export function JiraTicketChips({
  nodeId,
  projectId,
  max = 3,
  className = 'pull-refs pull-refs--session',
  heading
}: {
  nodeId: string
  projectId?: string
  max?: number
  className?: string
  /** Given: a titled section (the card modal), like its Pull requests section. */
  heading?: string
}): React.JSX.Element | null {
  const links = useIntegrationJira((state) => jiraLinksFor(state.byNode, nodeId, projectId))
  const tickets = links?.tickets ?? []
  if (!tickets.length) return null
  const shown = tickets.slice(0, max)
  const rest = tickets.length - shown.length
  const chips = (
    <div className={className} data-testid="jira-refs">
      {shown.map((t) => (
        <JiraTicketChip key={t.key} ticket={t} principal={links?.principal} />
      ))}
      {rest > 0 && (
        <span className="pull-ref" title={tickets.slice(max).map((t) => t.key).join(', ')}>
          +{rest}
        </span>
      )}
    </div>
  )
  if (!heading) return chips
  return (
    <section className="card-pulls" aria-label="Jira tickets">
      <div className="card-pulls__head">
        <span className="card-pulls__title">{heading}</span>
      </div>
      {chips}
    </section>
  )
}
