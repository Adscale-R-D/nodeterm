// The rule under test is the CLI's, restated in model-window.ts: **200k unless the model
// SELECTION carries `[1m]`** — never the family. These cases exist because the previous family
// table (opus/sonnet → 1M) under-reported context pressure by 5× on every 200k session, and a
// family table is exactly the kind of thing a later refactor re-introduces as "obvious".
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  isOneMillionSelection,
  staticWindowFor,
  cachedWindowFor,
  claudeWindowFor,
  geminiWindowFor
} from './model-window'
import { resetClaudeModelSelectionCache } from './claude-model-selection'

/** A config dir holding `settings.json`, plus the transcript path that points back at it. */
function fakeConfigDir(settings: unknown | null): { configDir: string; transcript: string } {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-cfg-'))
  if (settings !== null) {
    fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify(settings))
  }
  const projectDir = path.join(configDir, 'projects', '-home-someone-repo')
  fs.mkdirSync(projectDir, { recursive: true })
  return { configDir, transcript: path.join(projectDir, 'sess.jsonl') }
}

describe('isOneMillionSelection (the CLI\'s `wS`)', () => {
  it('matches the literal marker, case-insensitively, anywhere in the string', () => {
    expect(isOneMillionSelection('opus[1m]')).toBe(true)
    expect(isOneMillionSelection('claude-opus-5[1M]')).toBe(true)
    expect(isOneMillionSelection('Claude Opus 5 [1m] (extra)')).toBe(true)
  })

  it('does NOT match a family, a bare id, or a lookalike', () => {
    // Every one of these read as 1M under the old family table.
    expect(isOneMillionSelection('claude-opus-5')).toBe(false)
    expect(isOneMillionSelection('claude-sonnet-5')).toBe(false)
    expect(isOneMillionSelection('opus')).toBe(false)
    // "1m" without the brackets is not the marker — the CLI tests `/\[1m\]/i`, not `/1m/i`.
    expect(isOneMillionSelection('some-model-1m')).toBe(false)
    expect(isOneMillionSelection(null)).toBe(false)
    expect(isOneMillionSelection(undefined)).toBe(false)
    expect(isOneMillionSelection('')).toBe(false)
  })
})

describe('staticWindowFor', () => {
  it('defaults to 200k for every bare first-party id', () => {
    expect(staticWindowFor('claude-opus-5')).toBe(200_000)
    expect(staticWindowFor('claude-sonnet-5')).toBe(200_000)
    expect(staticWindowFor('claude-haiku-4-5-20251001')).toBe(200_000)
    expect(staticWindowFor(null)).toBe(200_000)
  })

  it('answers 1M only for a marked selection', () => {
    expect(staticWindowFor('claude-opus-5[1m]')).toBe(1_000_000)
    expect(staticWindowFor('opus[1M]')).toBe(1_000_000)
  })

  it('cachedWindowFor is the same answer (call-site alias)', () => {
    expect(cachedWindowFor('claude-opus-5')).toBe(staticWindowFor('claude-opus-5'))
    expect(cachedWindowFor('opus[1m]')).toBe(1_000_000)
  })
})

describe('the CLAUDE_CODE_MAX_CONTEXT_TOKENS override (the CLI\'s `Wmf`)', () => {
  const saved = { ...process.env }
  afterEach(() => {
    process.env = { ...saved }
  })

  it('wins over everything — but ONLY together with DISABLE_COMPACT', () => {
    process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = '350000'
    // No DISABLE_COMPACT: the CLI ignores it for first-party ids, so we do too.
    expect(staticWindowFor('claude-opus-5')).toBe(200_000)
    expect(staticWindowFor('opus[1m]')).toBe(1_000_000)

    process.env.DISABLE_COMPACT = '1'
    expect(staticWindowFor('claude-opus-5')).toBe(350_000)
    // …and it outranks the marker, matching `Wmf` returning before `qmf` is ever called.
    expect(staticWindowFor('opus[1m]')).toBe(350_000)
  })

  it('ignores a non-positive or unparseable value instead of dividing by it', () => {
    process.env.DISABLE_COMPACT = '1'
    for (const v of ['0', '-5', 'lots', '']) {
      process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = v
      expect(staticWindowFor('claude-opus-5')).toBe(200_000)
    }
  })
})

describe('claudeWindowFor (id + the selection recovered from the transcript path)', () => {
  beforeEach(() => resetClaudeModelSelectionCache())

  it('recovers 1M from the config dir when the transcript id is bare', () => {
    // The case the user hit from the other side: the transcript NEVER carries `[1m]`, so without
    // this leg every 1M session would read as 200k and peg the meter.
    const { transcript } = fakeConfigDir({ model: 'opus[1m]' })
    expect(claudeWindowFor('claude-opus-5', transcript)).toBe(1_000_000)
  })

  it('stays at 200k when the selection is unmarked, missing, or unreadable', () => {
    expect(claudeWindowFor('claude-opus-5', fakeConfigDir({ model: 'opus' }).transcript)).toBe(200_000)
    resetClaudeModelSelectionCache()
    expect(claudeWindowFor('claude-opus-5', fakeConfigDir({}).transcript)).toBe(200_000)
    resetClaudeModelSelectionCache()
    expect(claudeWindowFor('claude-opus-5', fakeConfigDir(null).transcript)).toBe(200_000)
  })

  it('never second-guesses an id that already states its variant', () => {
    const { transcript } = fakeConfigDir({ model: 'opus' })
    expect(claudeWindowFor('claude-opus-5[1m]', transcript)).toBe(1_000_000)
  })

  it('is the plain default with no path at all', () => {
    expect(claudeWindowFor('claude-opus-5')).toBe(200_000)
    expect(claudeWindowFor('claude-opus-5[1m]')).toBe(1_000_000)
    expect(claudeWindowFor(null)).toBe(200_000)
  })
})

describe('geminiWindowFor (gemini\'s own tokenLimit)', () => {
  it('is the 1M catch-all for anything but the two gemma models', () => {
    expect(geminiWindowFor('gemini-3.5-flash')).toBe(1_048_576)
    expect(geminiWindowFor('a-model-released-after-this-test')).toBe(1_048_576)
    expect(geminiWindowFor('gemma-4-31b-it')).toBe(256_000)
    expect(geminiWindowFor('gemma-4-26b-a4b-it')).toBe(256_000)
  })

  it('answers null — not a guess — when no model was named', () => {
    expect(geminiWindowFor(null)).toBeNull()
  })
})
