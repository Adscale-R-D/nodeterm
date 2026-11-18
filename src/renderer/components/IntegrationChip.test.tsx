import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { IntegrationChip } from './IntegrationChip'

/** Parse the one rendered span; `null` when the chip drew nothing. */
function render(marker: unknown): { text: string; title: string } | null {
  const html = renderToStaticMarkup(<IntegrationChip marker={marker} />)
  if (!html) return null
  const m = /^<span class="integration-chip nodrag" title="([^"]*)">([^<]*)<\/span>$/.exec(html)
  if (!m) throw new Error(`unexpected markup: ${html}`)
  const un = (s: string): string =>
    s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  return { title: un(m[1]), text: un(m[2]) }
}

describe('IntegrationChip', () => {
  it('shows only the principal name; the full "via label · key" is in the tooltip', () => {
    const el = render({ name: 'sink', key: 'jira:A3-6926', label: 'Ticket sink' })
    expect(el?.text).toBe('sink')
    expect(el?.title).toContain('via Ticket sink · jira:A3-6926')
  })

  it('names the principal in the tooltip when there is no label', () => {
    const el = render({ name: 'sink', key: 'APP-1' })
    expect(el?.text).toBe('sink')
    expect(el?.title).toContain('via sink · APP-1')
  })

  it('draws nothing for a hostile marker and drops a hostile label', () => {
    expect(render({ name: 'Bad Name!', key: 'APP-1' })).toBeNull()
    expect(render({ name: 'sink', key: 'a b‮' })).toBeNull()
    expect(render('via evil')).toBeNull()
    const el = render({ name: 'sink', key: 'APP-1', label: 'x\u0000y' })
    expect(el?.text).toBe('sink')
    expect(el?.title).toContain('via sink · APP-1')
  })
})
