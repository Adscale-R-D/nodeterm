import { describe, expect, it } from 'vitest'

import {
  INTEGRATION_JIRA_MAX,
  JIRA_SUMMARY_MAX,
  jiraTicketUrl,
  parseJiraKey,
  parseJiraSite,
  parseJiraTicketInput,
  parseJiraTicketInputs,
  sanitizeJiraCardLinks,
  sanitizeJiraTicketLinks
} from './integration-jira'

const SITE = 'https://ad-scale.atlassian.net'

describe('declared Jira tickets — validation', () => {
  it('keys: trimmed and upper-cased, a project key of 2-10 characters, a dash, a number', () => {
    expect(parseJiraKey(' a3-6926 ')).toBe('A3-6926')
    for (const bad of ['A-1', '3A-1', 'ABC-0', 'ABC-', 'ABC 1', 'ABC-1/x', 'ABCDEFGHIJK-1', '', 7, null]) {
      expect(parseJiraKey(bad)).toBeNull()
    }
  })

  it('sites: an https origin only; a link is built, never taken', () => {
    expect(parseJiraSite(`${SITE}/`)).toBe(SITE)
    for (const bad of [
      'http://ad-scale.atlassian.net',
      'javascript:alert(1)',
      `${SITE}/browse/A3-1`,
      `${SITE}?x=1`,
      `${SITE}#x`,
      'https://user:pw@ad-scale.atlassian.net',
      'file:///etc/passwd',
      'not a url',
      `https://${'a'.repeat(220)}.net`
    ]) {
      expect(parseJiraSite(bad)).toBeNull()
    }
    expect(jiraTicketUrl(SITE, 'A3-6926')).toBe(`${SITE}/browse/A3-6926`)
    expect(jiraTicketUrl(SITE, 'a3-6926/../../x')).toBeNull()
    expect(jiraTicketUrl('http://x.test', 'A3-1')).toBeNull()
  })

  it('status and summary become one capped line; the group is a closed set', () => {
    const t = parseJiraTicketInput({
      key: 'A3-1',
      site: SITE,
      status: 'In‮ Review\nnext',
      category: 'in-progress',
      summary: 'x'.repeat(500)
    })
    expect(t).toMatchObject({ key: 'A3-1', site: SITE, category: 'in-progress' })
    expect(t!.status).not.toMatch(/[‮\n]/)
    expect(Array.from(t!.summary!)).toHaveLength(JIRA_SUMMARY_MAX)
    expect(parseJiraTicketInput({ key: 'A3-1', site: SITE, category: 'blocked' })).toBeNull()
    expect(parseJiraTicketInput({ key: 'A3-1', site: SITE, status: 5 })).toBeNull()
    // Blank text is dropped, not stored.
    expect(parseJiraTicketInput({ key: 'A3-1', site: SITE, status: '  ​ ' })).toEqual({ key: 'A3-1', site: SITE })
  })

  it('a list: capped, the later duplicate replaces the earlier, one bad entry refuses the whole list', () => {
    expect(parseJiraTicketInputs([{ key: 'A3-1', site: SITE, status: 'Open' }, { key: 'a3-1', site: SITE, status: 'Done' }])).toEqual([
      { key: 'A3-1', site: SITE, status: 'Done' }
    ])
    expect(parseJiraTicketInputs([{ key: 'A3-1', site: SITE }, { key: 'bad' }])).toBeNull()
    expect(parseJiraTicketInputs(Array.from({ length: INTEGRATION_JIRA_MAX + 1 }, (_, i) => ({ key: `A3-${i + 1}`, site: SITE })))).toBeNull()
    expect(parseJiraTicketInputs('A3-1')).toBeNull()
  })

  it('stored and listed values are re-checked: bad entries dropped, never repaired into links', () => {
    expect(sanitizeJiraTicketLinks([{ key: 'A3-1', site: SITE, at: 1 }, { key: 'A3-2', site: 'http://x', at: 1 }, { key: 'A3-3', site: SITE }])).toEqual([
      { key: 'A3-1', site: SITE, at: 1 }
    ])
    expect(
      sanitizeJiraCardLinks([
        { projectId: 'p1', nodeId: 'term-1', principal: 'sink', tickets: [{ key: 'A3-1', site: SITE, at: 1 }] },
        { projectId: 'p1', nodeId: 'term-2', principal: 'Not Valid', tickets: [{ key: 'A3-1', site: SITE, at: 1 }] },
        { projectId: 'p1', nodeId: 'term-3', principal: 'sink', tickets: [] },
        null
      ])
    ).toEqual([{ projectId: 'p1', nodeId: 'term-1', principal: 'sink', tickets: [{ key: 'A3-1', site: SITE, at: 1 }] }])
  })
})
