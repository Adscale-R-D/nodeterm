import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { claudeConfigDirFromTranscript, selectedClaudeModel, resetClaudeModelSelectionCache } from './claude-model-selection'

describe('claudeConfigDirFromTranscript', () => {
  it('climbs three levels for the canonical transcript shape', () => {
    expect(claudeConfigDirFromTranscript('/home/u/.claude/projects/-home-u-repo/abc.jsonl')).toBe(
      '/home/u/.claude'
    )
    // A managed account has its own config dir — same shape, and that is what makes per-account
    // selections work with no extra plumbing.
    expect(
      claudeConfigDirFromTranscript('/data/claude-accounts/acct-1/projects/-srv-app/x.jsonl')
    ).toBe('/data/claude-accounts/acct-1')
  })

  it('refuses a path whose middle segment is not `projects`', () => {
    // Without this check an unrelated path would nominate an arbitrary directory as a Claude
    // config dir, and we would read whatever `settings.json` happened to live there.
    expect(claudeConfigDirFromTranscript('/tmp/ctxtail-abc/sess.jsonl')).toBeNull()
    expect(claudeConfigDirFromTranscript('/a/b/sessions/c/x.jsonl')).toBeNull()
  })

  it('answers null for no path', () => {
    expect(claudeConfigDirFromTranscript(undefined)).toBeNull()
    expect(claudeConfigDirFromTranscript('')).toBeNull()
  })
})

describe('selectedClaudeModel', () => {
  let dir: string
  const settings = (): string => path.join(dir, 'settings.json')

  beforeEach(() => {
    resetClaudeModelSelectionCache()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sel-'))
  })

  it('reads and trims the `model` key', () => {
    fs.writeFileSync(settings(), JSON.stringify({ model: '  opus[1m] ', other: 1 }))
    expect(selectedClaudeModel(dir)).toBe('opus[1m]')
  })

  it('is null for no dir, no file, no key, a non-string key, or an empty one', () => {
    expect(selectedClaudeModel(null)).toBeNull()
    expect(selectedClaudeModel(dir)).toBeNull() // no settings.json at all
    resetClaudeModelSelectionCache()
    fs.writeFileSync(settings(), JSON.stringify({ statusLine: 'x' }))
    expect(selectedClaudeModel(dir)).toBeNull()
    resetClaudeModelSelectionCache()
    fs.writeFileSync(settings(), JSON.stringify({ model: 5 }))
    expect(selectedClaudeModel(dir)).toBeNull()
    resetClaudeModelSelectionCache()
    fs.writeFileSync(settings(), JSON.stringify({ model: '   ' }))
    expect(selectedClaudeModel(dir)).toBeNull()
  })

  it('is null — not a throw — for a half-written / malformed file', () => {
    // settings.json is hand-edited; catching a mid-save read is normal, and an exception here
    // would take out the whole context-tail tick.
    fs.writeFileSync(settings(), '{ "model": "opus[1m]"')
    expect(selectedClaudeModel(dir)).toBeNull()
  })

  it('serves from cache within the TTL, then re-reads once the mtime moves', () => {
    fs.writeFileSync(settings(), JSON.stringify({ model: 'opus' }))
    const t0 = 1_000_000
    expect(selectedClaudeModel(dir, t0)).toBe('opus')

    fs.writeFileSync(settings(), JSON.stringify({ model: 'opus[1m]' }))
    fs.utimesSync(settings(), new Date(), new Date(Date.now() + 60_000))
    // Inside the TTL the file is not even stat'd, so the edit is invisible…
    expect(selectedClaudeModel(dir, t0 + 1_000)).toBe('opus')
    // …and past it the changed mtime forces the re-parse.
    expect(selectedClaudeModel(dir, t0 + 20_000)).toBe('opus[1m]')
  })

  it('remembers an ABSENT file so it is not stat-thrashed every tick', () => {
    const t0 = 2_000_000
    expect(selectedClaudeModel(dir, t0)).toBeNull()
    fs.writeFileSync(settings(), JSON.stringify({ model: 'opus[1m]' }))
    expect(selectedClaudeModel(dir, t0 + 1_000)).toBeNull() // still within the TTL
    expect(selectedClaudeModel(dir, t0 + 20_000)).toBe('opus[1m]')
  })
})
