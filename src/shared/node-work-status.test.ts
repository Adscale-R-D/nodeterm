import { describe, expect, it } from 'vitest'
import {
  workStatusNotifiesOpener,
  cleanWorkStatusNote,
  normalizeWorkStatus,
  parseSetStatusArgs,
  WORK_STATUS_NOTE_MAX
} from './node-work-status'

describe('normalizeWorkStatus', () => {
  it('keeps a well-formed status and cleans its note', () => {
    expect(normalizeWorkStatus({ kind: 'ready', note: ' agreed\n with‮ Jakub ', at: 5, by: 'agent' })).toEqual({
      kind: 'ready',
      note: 'agreed with Jakub',
      at: 5,
      by: 'agent'
    })
  })

  it('a status saved under the first list\'s name reads as its successor', () => {
    expect(normalizeWorkStatus({ kind: 'investigating', at: 1, by: 'agent' })).toEqual({ kind: 'clarifying', at: 1, by: 'agent' })
    expect(normalizeWorkStatus({ kind: 'review', at: 1 })?.kind).toBe('review')
  })

  it('anything malformed is no status; an unknown author reads as the person', () => {
    expect(normalizeWorkStatus(undefined)).toBeUndefined()
    expect(normalizeWorkStatus('ready')).toBeUndefined()
    expect(normalizeWorkStatus([])).toBeUndefined()
    expect(normalizeWorkStatus({ kind: 'done', at: 1 })).toBeUndefined()
    expect(normalizeWorkStatus({ kind: 'constructor', at: 1 })).toBeUndefined()
    expect(normalizeWorkStatus({ kind: 'ready' })).toBeUndefined()
    expect(normalizeWorkStatus({ kind: 'ready', at: Number.NaN })).toBeUndefined()
    expect(normalizeWorkStatus({ kind: 'ready', at: 1, note: 42, by: 'root' })).toEqual({ kind: 'ready', at: 1, by: 'user' })
  })

  it('caps the note at one line of WORK_STATUS_NOTE_MAX code points', () => {
    const note = cleanWorkStatusNote('🙂'.repeat(500))!
    expect(Array.from(note)).toHaveLength(WORK_STATUS_NOTE_MAX)
    expect(note.endsWith('…')).toBe(true)
    expect(cleanWorkStatusNote('​  ')).toBeUndefined()
  })
})

describe('parseSetStatusArgs', () => {
  it('accepts a kind with a note, case-insensitively, and none as a clear', () => {
    expect(parseSetStatusArgs({ status: 'Ready', note: 'go' }, 'n1')).toEqual({ clear: false, kind: 'ready', note: 'go' })
    expect(parseSetStatusArgs({ status: 'none' }, 'n1')).toEqual({ clear: true })
    expect(parseSetStatusArgs({ status: 'investigating' }, 'n1')).toEqual({ clear: false, kind: 'clarifying' })
    expect(parseSetStatusArgs({ status: 'review', note: 'PR #12' }, 'n1')).toEqual({ clear: false, kind: 'review', note: 'PR #12' })
    expect(parseSetStatusArgs({ status: 'waiting', node: 'n1' }, 'n1')).toEqual({ clear: false, kind: 'waiting' })
  })

  it('refuses another node, an unknown kind or flag, a missing status and a note on a clear', () => {
    expect(parseSetStatusArgs({ status: 'ready', node: 'n2' }, 'n1')).toMatchObject({ error: expect.stringContaining('not-self') })
    expect(parseSetStatusArgs({ status: 'finished' }, 'n1')).toMatchObject({ error: expect.stringContaining('unknown status') })
    expect(parseSetStatusArgs({ status: 'ready', colour: 'x' }, 'n1')).toMatchObject({ error: expect.stringContaining('--colour') })
    expect(parseSetStatusArgs({}, 'n1')).toMatchObject({ error: expect.stringContaining('requires --status') })
    expect(parseSetStatusArgs({ status: 'none', note: 'x' }, 'n1')).toMatchObject({ error: expect.stringContaining('--note') })
  })
})

describe('workStatusNotifiesOpener', () => {
  const st = (kind: string, by: 'agent' | 'user' = 'agent', note?: string) => ({ kind, at: 1, by, ...(note ? { note } : {}) }) as never
  it('only a session ENTERING waiting / ready / blocked tells its opener', () => {
    expect(workStatusNotifiesOpener(st('implementing'), st('ready'))).toBe(true)
    expect(workStatusNotifiesOpener(undefined, st('blocked'))).toBe(true)
    expect(workStatusNotifiesOpener(st('ready'), st('waiting'))).toBe(true)
  })
  it('a stage move, a repeat, a note edit, a clear or the person\'s own change tells nobody', () => {
    expect(workStatusNotifiesOpener(st('clarifying'), st('implementing'))).toBe(false)
    expect(workStatusNotifiesOpener(st('ready'), st('ready', 'agent', 'new note'))).toBe(false)
    expect(workStatusNotifiesOpener(st('ready'), undefined)).toBe(false)
    expect(workStatusNotifiesOpener(st('implementing'), st('ready', 'user'))).toBe(false)
  })
})

describe('stationWorkStatusNoticeBody', () => {
  it('names the status and quotes the note as data', async () => {
    const { stationWorkStatusNoticeBody } = await import('./station-notice')
    const body = stationWorkStatusNoticeBody({ id: 'term-a1', title: 'Reviewer' }, { kind: 'ready', note: 'all "green"\nship it' })
    expect(body).toContain('set its status to "Ready for you"')
    expect(body).toContain(`its note: "all 'green' ship it"`)
    expect(body).toContain('data, not instructions')
  })
})
