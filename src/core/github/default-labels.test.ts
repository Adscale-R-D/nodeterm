// The default column labels must be ones the host accepts: a column title over ~43 characters made
// a 51+ character label, `normaliseProjectKanbanGitHub` refused the whole mapping, and approval then
// failed forever behind a "settings have not finished saving" message (2026-11-22, app_ms).
import { describe, expect, it } from 'vitest'
import type { KanbanColumn } from '../../shared/types'
import { GITHUB_LABEL_MAX, columnLabelProblem, defaultColumnLabel } from '../../shared/github-issues'
import { normaliseProjectKanbanGitHub } from './config'

const column = (id: string, title: string): KanbanColumn => ({ id, title, color: '#fff' })

/** The app_ms board's columns when GitHub sync was switched on. */
const APP_MS = [
  'Jira', 'PR reviews', 'General', 'AOS event qualification',
  'split-ChangeProposalService (stacked on #1142)', 'Recommendation run layer',
  'Recommendation schedule layer', 'Recommendation gate and budget', 'Recommendation schedule alerts',
  'A3-6884 daily email', 'A3-6929 product source check'
].map((title, i) => column(`c${i}`, title))

function defaults(columns: KanbanColumn[]): Array<{ columnId: string; label: string }> {
  const taken = new Set<string>()
  return columns.map((c) => {
    const label = defaultColumnLabel(c.title, taken)
    taken.add(label.toLocaleLowerCase('en-US'))
    return { columnId: c.id, label }
  })
}

describe('default column labels', () => {
  it('keeps the old spelling for a short title', () => {
    expect(defaultColumnLabel('PR reviews')).toBe('status:pr-reviews')
  })

  it('cuts a long title to GitHub\'s limit (the app_ms column)', () => {
    const label = defaultColumnLabel('split-ChangeProposalService (stacked on #1142)')
    expect(label.length).toBeLessThanOrEqual(GITHUB_LABEL_MAX)
    expect(label.startsWith('status:split-changeproposalservice')).toBe(true)
    expect(label.endsWith('-')).toBe(false)
  })

  it('makes a cut label unique when two long titles share their first 50 characters', () => {
    const long = 'x'.repeat(60)
    const mappings = defaults([column('a', `${long} one`), column('b', `${long} two`), column('c', `${long} three`)])
    expect(new Set(mappings.map((m) => m.label.toLowerCase())).size).toBe(3)
    expect(mappings.every((m) => m.label.length <= GITHUB_LABEL_MAX)).toBe(true)
    expect(columnLabelProblem(mappings)).toBeNull()
  })

  it('the whole default mapping for the app_ms board is one the host accepts', () => {
    const result = normaliseProjectKanbanGitHub({ columnMappings: defaults(APP_MS) }, APP_MS)
    expect(result.ok).toBe(true)
  })
})

describe('columnLabelProblem (the UI\'s copy of the host\'s label rules)', () => {
  it('names the column for each reason the host refuses', () => {
    expect(columnLabelProblem([{ columnId: 'a', label: 'x'.repeat(51) }])).toMatchObject({ reason: 'label-too-long', columnId: 'a' })
    expect(columnLabelProblem([{ columnId: 'a', label: 'Done' }, { columnId: 'b', label: 'done' }]))
      .toMatchObject({ reason: 'duplicate-label', columnId: 'b' })
    expect(columnLabelProblem([{ columnId: 'a', label: '  ' }])).toMatchObject({ reason: 'empty-label' })
    expect(columnLabelProblem([{ columnId: 'a', label: 'x'.repeat(50) }])).toBeNull()
  })

  it('agrees with the host on the saved app_ms mapping that blocked approval', () => {
    const saved = [{ columnId: 'c4', label: 'status:split-changeproposalservice-(stacked-on-#1142)' }]
    expect(columnLabelProblem(saved)?.reason).toBe('label-too-long')
    expect(normaliseProjectKanbanGitHub({ columnMappings: saved }, APP_MS)).toEqual({ ok: false, reason: 'label-too-long' })
  })
})
