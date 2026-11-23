// The Jira chips on a session card and in the card modal. Rendered with react-dom/server: jsdom does
// not start on every host this suite runs on, and zustand serves its INITIAL state under server
// rendering, so the store hook is mocked with the links the host would have pushed.
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { JiraCardLinks } from '@shared/integration-jira'

const SITE = 'https://ad-scale.atlassian.net'
let links: JiraCardLinks[] = []

vi.mock('../ContextMeter', () => ({ ContextMeter: () => null }))
vi.mock('../../state/integrationJira', async (orig) => {
  const real = await orig<typeof import('../../state/integrationJira')>()
  const byNode = (): Record<string, JiraCardLinks[]> => {
    const out: Record<string, JiraCardLinks[]> = {}
    for (const l of links) (out[l.nodeId] ??= []).push(l)
    return out
  }
  return { ...real, useIntegrationJira: (select: (s: { byNode: Record<string, JiraCardLinks[]> }) => unknown) => select({ byNode: byNode() }) }
})

const { SessionCard } = await import('./SessionCard')
const { JiraTicketChips } = await import('./JiraTicketChips')
const session = { id: 'term-1', title: 'A3-6926 ticket', color: '#fff', kind: 'terminal' as const, spawn: {} }
const noop = (): void => {}

describe('Jira ticket chips', () => {
  it('a card shows its declared tickets as buttons that open Jira, status in the tooltip', () => {
    links = [{ projectId: 'p1', nodeId: 'term-1', principal: 'sink', tickets: [{ key: 'A3-6926', site: SITE, status: 'In Review', category: 'in-progress', summary: 'Fix the thing', at: 1 }] }]
    const html = renderToStaticMarkup(
      <SessionCard session={session} onOpen={noop} onDragStart={noop} onDragEnd={noop} onDropAt={noop} onContext={noop} />
    )
    expect(html).toContain('A3-6926')
    expect(html).toMatch(/<button type="button" class="[^"]*jira-ref--in-progress[^"]*pull-ref--link/)
    expect(html).toContain('In Review')
    expect(html).toContain('Fix the thing')
    expect(html).toContain('Open in Jira')
  })

  it('nothing for a card without tickets; a bad site (a hostile push past the sanitizer) is never a link', () => {
    links = []
    expect(renderToStaticMarkup(<JiraTicketChips nodeId="term-1" />)).toBe('')
    links = [{ projectId: 'p1', nodeId: 'term-1', principal: 'sink', tickets: [{ key: 'A3-1', site: 'javascript:alert(1)', at: 1 }] }]
    const html = renderToStaticMarkup(<JiraTicketChips nodeId="term-1" />)
    expect(html).toContain('A3-1')
    expect(html).not.toContain('<button')
  })

  it('caps the card at three and counts the rest; the modal shows all under a heading', () => {
    links = [{ projectId: 'p1', nodeId: 'term-1', principal: 'sink', tickets: [1, 2, 3, 4, 5].map((n) => ({ key: `A3-${n}`, site: SITE, at: 1 })) }]
    const card = renderToStaticMarkup(<JiraTicketChips nodeId="term-1" />)
    expect(card).toContain('A3-3')
    expect(card).not.toContain('>A3-4<')
    expect(card).toContain('+2')
    const modal = renderToStaticMarkup(<JiraTicketChips nodeId="term-1" max={20} heading="Jira" className="pull-refs" />)
    expect(modal).toContain('aria-label="Jira tickets"')
    expect(modal).toContain('A3-5')
  })

  it('picks the entry of the card\'s project when one node id sits in two projects', () => {
    links = [
      { projectId: 'p1', nodeId: 'term-1', principal: 'sink', tickets: [{ key: 'A3-1', site: SITE, at: 1 }] },
      { projectId: 'p2', nodeId: 'term-1', principal: 'sink', tickets: [{ key: 'B2-9', site: SITE, at: 1 }] }
    ]
    const html = renderToStaticMarkup(<JiraTicketChips nodeId="term-1" projectId="p2" />)
    expect(html).toContain('B2-9')
    expect(html).not.toContain('A3-1')
  })
})
