// Golden fixtures for the mobile chat view's parser port (docs/mobile-chat-view.md). The TS
// implementation is the REFERENCE: `nodeterm-ios` carries a byte-identical copy of
// `src/shared/chat-fixtures/` and its Swift port must reproduce every `expected/*.json` from the
// same inputs. This file is both the drift test and the regenerator:
//
//   UPDATE_CHAT_FIXTURES=1 npx vitest run src/core/chat-fixtures.test.ts
//
// rewrites `inputs/`, `pending/`, `decision-cases.json` and `expected/`. Without the variable every
// file must already equal what this code produces — a change to the parser that moves one byte of
// output fails here, and the iOS copy must be refreshed in the same breath.
//
// Inputs are SYNTHETIC: built below from the record shapes measured on real Claude transcripts
// (never slices of real ones — those carry customer data). See the fixtures README for what each
// one pins.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { parseChatWindow, readChatWindow, type ChatWindowParse } from './transcript-reader'
import { readChatTranscript } from './transcript-ipc'
import {
  buildPermissionDecision,
  parsePendingRequest,
  parsePermissionAnswer
} from './agents/permission-decision'
import { ANSWER_TEXT_MAX_CHARS } from '../shared/agents/permission-answer'
import { CHAT_PAGE_DEFAULT_BYTES, CHAT_PAGE_MAX_BYTES } from '../shared/chat-page'

const DIR = path.join(__dirname, '..', 'shared', 'chat-fixtures')
const UPDATE = process.env.UPDATE_CHAT_FIXTURES === '1'
// Regenerating in CI would turn the drift test into a no-op that always passes.
if (UPDATE && process.env.CI) throw new Error('UPDATE_CHAT_FIXTURES must not be set in CI')

// ── The phone's pager ────────────────────────────────────────────────────────────────────────────
// Mirrors what the phone does (and what core's `parseGrowingWindow` does per page): a 256 KB tail
// read ending at EOF, then 512 KB pages ending at the previous page's `olderCursor`. A window that
// holds no complete line is re-read with the SAME `before` at ×4 the size, up to the 5 MB cap,
// unless it already starts at byte 0. Documented in the README; the Swift port replicates it.
const TAIL_BYTES = 262144
const OLDER_BYTES = 524288
const GROWTH = 4
const MAX_BYTES = 5242880

interface PageStep {
  /** The request: `null` = end of file. */
  before: number | null
  maxBytes: number
  /** The window size actually parsed after growth (= `maxBytes` when no growth happened). */
  grownMaxBytes: number
  /** Absolute offset of the first byte handed to `parseChatWindow` (the lookbehind byte included). */
  start: number
  parse: ChatWindowParse
}

async function pageFile(file: string): Promise<PageStep[]> {
  const steps: PageStep[] = []
  let before: number | null = null
  let maxBytes = TAIL_BYTES
  for (;;) {
    let m = maxBytes
    let w = await readChatWindow(file, { before, maxBytes: m })
    if (!w) throw new Error(`unreadable fixture ${file}`)
    let parse = parseChatWindow(w.data, w.start)
    while (parse.noCompleteLine && w.start !== 0 && m < MAX_BYTES) {
      m = Math.min(MAX_BYTES, m * GROWTH)
      w = await readChatWindow(file, { before, maxBytes: m })
      if (!w) throw new Error(`unreadable fixture ${file}`)
      parse = parseChatWindow(w.data, w.start)
    }
    steps.push({ before, maxBytes, grownMaxBytes: m, start: w.start, parse })
    if (parse.olderCursor === null) return steps
    if (steps.length > 64) throw new Error('pager did not terminate')
    before = parse.olderCursor
    maxBytes = OLDER_BYTES
  }
}

// ── Synthetic records, in the measured shapes ────────────────────────────────────────────────────
const SID = '5f0c2a9e-3b7d-4e61-9a24-7c1d8e0f4b32'
const T0 = Date.parse('2026-09-25T19:00:00.000Z')

type Rec = Record<string, unknown>
const user = (content: unknown): Rec => ({ type: 'user', message: { role: 'user', content } })
const assistant = (content: unknown[], model: string = 'claude-opus-5-5', effort: string | null = 'high'): Rec => ({
  type: 'assistant',
  // `null` = the record states no effort. NOT `undefined`: a default parameter fires on an explicit
  // `undefined`, which once silently gave the no-carry fixture's newest record `effort: "high"`.
  ...(effort === null ? {} : { effort }),
  message: { id: 'msg_synthetic', type: 'message', role: 'assistant', model, content, stop_reason: null }
})
const text = (t: string): Rec => ({ type: 'text', text: t })
const toolUse = (id: string, name: string, input: unknown): Rec => ({ type: 'tool_use', id, name, input })
const toolResult = (id: string, content: unknown): Rec =>
  user([{ type: 'tool_result', tool_use_id: id, content, is_error: false }])
const meta = (type: string): Rec => ({ type, snapshot: { trackedFileBackups: {} }, isSnapshotUpdate: false })

/** One JSONL line. Envelope fields are fixed-width (uuid, ISO timestamp) so a record's byte length
 *  does not depend on its index — which is what lets the boundary fixtures be laid out exactly. */
function line(r: Rec, i: number): string {
  const uuid = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
  const timestamp = new Date(T0 + i * 1000).toISOString()
  return JSON.stringify({ ...r, isSidechain: false, sessionId: SID, cwd: '/srv/demo', version: '2.1.290', uuid, timestamp }) + '\n'
}
const jsonl = (recs: Rec[]): string => recs.map((r, i) => line(r, i)).join('')
const len = (r: Rec): number => Buffer.byteLength(line(r, 0))

/** Deterministic filler turns: `n` user/assistant pairs of ~1 KB each. */
function filler(n: number, tag: string): Rec[] {
  const out: Rec[] = []
  for (let i = 0; i < n; i++) {
    const body = `${tag} turn ${i}: ` + 'lorem ipsum dolor sit amet '.repeat(36)
    out.push(user(`${tag} question ${i}`), assistant([text(body)]))
  }
  return out
}

/** Filler records totalling EXACTLY `bytes` (one tunable padding line at the end). */
function fillExactly(bytes: number, tag: string): Rec[] {
  const out: Rec[] = []
  let used = 0
  let i = 0
  for (;;) {
    const pair = filler(1, `${tag}${i++}`)
    const l = pair.reduce((s, r) => s + len(r), 0)
    if (used + l + 2048 > bytes) break
    out.push(...pair)
    used += l
  }
  const base = len(assistant([text('')]))
  const pad = bytes - used - base
  if (pad < 0) throw new Error('fillExactly: no room for the padding line')
  out.push(assistant([text('p'.repeat(pad))]))
  return out
}

/** Deterministic pseudo-random bytes (LCG) — an incompressible-looking base64 "screenshot". */
function pseudoRandomBase64(nBytes: number): string {
  const b = Buffer.alloc(nBytes)
  let x = 0x2545f491
  for (let i = 0; i < nBytes; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0
    b[i] = x >>> 24
  }
  return b.toString('base64')
}

const PLAN = [
  '# Plan: add a chat view to the phone',
  '',
  '1. **Core** — export `readChatTranscript` and report `model` / `effort`.',
  '2. **Fixtures** — golden files the Swift port is locked to.',
  '',
  '```ts',
  "const page = await readChatTranscript(q, { maxBytes: 262144 }, deps)",
  '```',
  '',
  '- Risks: a line larger than the window (grow ×4).'
].join('\n')

const Q_SINGLE = {
  question: 'Which transport should the phone use first?',
  header: 'Transport',
  multiSelect: false,
  options: [
    { label: 'Relay (Recommended)', description: 'Works from anywhere.' },
    { label: 'SSH', description: 'Direct to the host.' }
  ]
}
const Q_MULTI = {
  question: 'Which surfaces should get it?',
  header: 'Surfaces',
  multiSelect: true,
  options: [
    { label: 'Desktop', description: 'Electron' },
    { label: 'Server Edition', description: 'Browser' },
    { label: 'Mobile', description: 'iOS' }
  ]
}

function plainTurns(): string {
  return jsonl([
    meta('file-history-snapshot'),
    user('How do I list the files in a directory, sorted by size?'),
    assistant([
      text(
        '## Sorted by size\n\nUse `ls` with **-S**:\n\n```sh\nls -lS\n```\n\n- `-l` long format\n- `-S` sort by size, largest first\n\n> Add `-r` to reverse.'
      )
    ]),
    user([text('And recursively?')]),
    assistant([text('Use `find` with `du`:'), text('```sh\nfind . -type f -exec du -h {} + | sort -rh | head\n```')]),
    { type: 'system', subtype: 'informational', content: 'metadata-only record' },
    user('thanks — çok iyi 👍'),
    assistant([text('Rica ederim! 🎉')], 'claude-opus-5-5', 'medium')
  ])
}

function toolsCrossPage(): string {
  return jsonl([
    user('Run the test suite and tell me what fails.'),
    assistant([text('Running the suite.'), toolUse('toolu_cross_01', 'Bash', { command: 'npx vitest run', description: 'Run tests' })]),
    // Enough history between the call and its result that the result lands in the TAIL window and
    // the call in the next older one.
    ...filler(175, 'history'),
    toolResult('toolu_cross_01', ' Test Files  2 failed | 40 passed (42)\n      Tests  3 failed | 900 passed\nsecond line\nthird line'),
    assistant([text('Two files fail.'), toolUse('toolu_local_02', 'Read', { file_path: '/srv/demo/src/a.ts' })]),
    toolResult('toolu_local_02', [{ type: 'text', text: 'export const a = 1\n' }]),
    assistant([text('`a.ts` looks fine.')])
  ])
}

function planMode(): string {
  return jsonl([
    user('Plan how to add a chat view to the phone. Do not write code yet.'),
    assistant([text('Here is my plan.'), toolUse('toolu_plan_01', 'ExitPlanMode', { plan: PLAN })], 'claude-opus-5-5', 'xhigh'),
    toolResult('toolu_plan_01', 'User has approved your plan. You can now start coding. Start with updating your todo list if applicable'),
    assistant([text('Starting with step 1.')], 'claude-opus-5-5', 'xhigh')
  ])
}

function askQuestion(): string {
  return jsonl([
    user('Help me decide the rollout.'),
    assistant([toolUse('toolu_ask_01', 'AskUserQuestion', { questions: [Q_SINGLE] })]),
    toolResult(
      'toolu_ask_01',
      'User has answered your questions: "Which transport should the phone use first?"="Relay (Recommended)". You can now continue with the user\'s answers in mind.'
    ),
    assistant([toolUse('toolu_ask_02', 'AskUserQuestion', { questions: [Q_MULTI] })]),
    toolResult(
      'toolu_ask_02',
      'User has answered your questions: "Which surfaces should get it?"="Desktop, Mobile". You can now continue with the user\'s answers in mind.'
    ),
    assistant([text('Relay first, on desktop and mobile.')])
  ])
}

/**
 * Multi-byte characters placed ON the window boundaries:
 *   - the TAIL window's first byte (EOF − 262144) falls INSIDE a 4-byte emoji of line S, so the
 *     window opens mid-character and S must be dropped as the partial line, never decoded torn;
 *   - the second page (`before` = start of the line after S, 524288 bytes) starts EXACTLY on the
 *     first byte of line L0 — whose text is multi-byte — so only the lookbehind byte (a `\n`) lets
 *     L0 be recognized as complete; S reappears whole in that page.
 */
function utf8Edge(): { body: string; l0: string } {
  const head = [user('Başlangıç — the head of the file.'), assistant([text('Önce baş kısım.')])]
  const l0 = user('L0: ğüşçöı ĞÜŞÇÖİ — この行はページの境界で始まる 🚀')
  const s = assistant([text('S: straddle ' + '😀'.repeat(64) + ' end of straddle')])
  const tailEnd = [user('last question — son soru?'), assistant([text('last answer — son cevap ✅')])]
  const sBytes = Buffer.from(line(s, 0))
  const e0 = sBytes.indexOf(Buffer.from('😀'))
  // Bytes from L0's first byte through S's newline: exactly one older page.
  const middle = fillExactly(OLDER_BYTES - len(l0) - len(s), 'mid')
  // S + everything after it = TAIL_BYTES + (offset of the cut inside S): the cut is the 2nd byte of
  // the 11th emoji.
  const cutInS = e0 + 4 * 10 + 1
  const tailEndBytes = tailEnd.reduce((n, r) => n + len(r), 0)
  const after = fillExactly(TAIL_BYTES + cutInS - sBytes.length - tailEndBytes, 'tail')
  const recs = [...head, l0, ...middle, s, ...after, ...tailEnd]
  return { body: jsonl(recs), l0: line(l0, 0) }
}

function hugeLastLine(): string {
  return jsonl([
    ...filler(300, 'before-screenshot'),
    user([
      text('What is wrong in this screenshot?'),
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: pseudoRandomBase64(450 * 1024) } }
    ])
  ])
}

function modelEffort(): string {
  return jsonl([
    user('one'),
    assistant([text('a')], 'claude-opus-5-5', 'medium'),
    user('two'),
    assistant([text('b')], 'claude-opus-5-5', 'xhigh'),
    user('three'),
    assistant([text('c')], 'claude-fable-5', 'medium'),
    user('four'),
    assistant([text('d')], 'claude-fable-5-1', 'xhigh')
  ])
}

/** D1 rule: ONE record answers both fields — the newest states no effort, so there is none. */
const modelEffortNoCarry = (): string =>
  jsonl([assistant([text('a')], 'claude-opus-5', 'high'), user('next'), assistant([text('b')], 'claude-fable-5', null)])

/** D1 rule: a `<synthetic>` record (API error / interrupt, no effort) is skipped entirely. */
const modelEffortSynthetic = (): string =>
  jsonl([
    assistant([text('a')], 'claude-opus-5-5', 'xhigh'),
    assistant([text('API Error: Request was aborted.')], '<synthetic>', null)
  ])

/** D1 rule: the 100 cap counts UTF-16 code units (Swift `utf16.count`) — not bytes, not scalars. A
 *  model of 50 × U+1F9EA (100 units, 200 bytes, 50 scalars) is kept; an effort of 101 units is not. */
const modelEffortUtf16 = (): string =>
  jsonl([assistant([text('a')], 'claude-opus-5', 'low'), assistant([text('b')], '🧪'.repeat(50), '🧪'.repeat(50) + 'x')])

function thinking(): string {
  return jsonl([
    user('Why is the sky blue?'),
    assistant([{ type: 'thinking', thinking: 'Rayleigh scattering scales with 1/λ⁴…', signature: 'EqQBCkgIBhABGAIiQL' }]),
    assistant([
      { type: 'thinking', thinking: 'Keep it short.', signature: 'EqQBCkgIBhABGAIiQM' },
      text('Shorter (blue) wavelengths scatter more — **Rayleigh scattering**.')
    ]),
    assistant([{ type: 'redacted_thinking', data: 'c2VjcmV0' }, text('(redacted thinking above)')])
  ])
}

// ── Held permission requests + the answers tried against them ────────────────────────────────────
const pendingPayload = (tool_name: string, tool_input: unknown, permission_mode = 'default'): string =>
  JSON.stringify(
    {
      session_id: SID,
      transcript_path: `/home/demo/.claude/projects/-srv-demo/${SID}.jsonl`,
      cwd: '/srv/demo',
      permission_mode,
      hook_event_name: 'PermissionRequest',
      tool_name,
      tool_input,
      permission_suggestions: []
    },
    null,
    2
  ) + '\n'

const PENDING: Record<string, string> = {
  'plan.json': pendingPayload('ExitPlanMode', { plan: PLAN, planFilePath: '/home/demo/.claude/plans/demo.md' }, 'plan'),
  'question-single.json': pendingPayload('AskUserQuestion', { questions: [Q_SINGLE] }),
  'question-multi.json': pendingPayload('AskUserQuestion', { questions: [Q_MULTI] }),
  'question-pair.json': pendingPayload('AskUserQuestion', { questions: [Q_SINGLE, Q_MULTI] }),
  'bash.json': pendingPayload('Bash', { command: 'rm -rf build', description: 'Clean the build dir' })
}

// Answers the shape check itself must refuse (or accept) before any pending file is consulted —
// `expected/<name>.answer.json` records `parsePermissionAnswer`'s result verbatim (`null` = refused).
const ANSWER_CASES: Array<{ name: string; answer: unknown }> = [
  // No `auto` exists in the plan table on purpose (the hook-reply rule: never setMode auto).
  { name: 'answer-plan-auto-refused', answer: { kind: 'plan', mode: 'auto' } },
  { name: 'answer-unknown-kind-refused', answer: { kind: 'approve-all' } },
  // The SHAPE check does not cap text: an over-long revise passes parsing and is refused by
  // `buildPermissionDecision` (decision case `plan-revise-too-long-refused`). Recorded so the port
  // puts the cap in the same layer.
  { name: 'answer-revise-too-long-parses', answer: { kind: 'plan-revise', message: 'x'.repeat(ANSWER_TEXT_MAX_CHARS + 1) } }
]

const DECISION_CASES: Array<{ name: string; pending: string; answer: unknown }> = [
  { name: 'plan-restore', pending: 'plan.json', answer: { kind: 'plan', mode: 'restore' } },
  { name: 'plan-accept-edits', pending: 'plan.json', answer: { kind: 'plan', mode: 'acceptEdits' } },
  { name: 'plan-manual', pending: 'plan.json', answer: { kind: 'plan', mode: 'manual' } },
  { name: 'plan-revise', pending: 'plan.json', answer: { kind: 'plan-revise', message: '  Split step 2 into two PRs.  ' } },
  {
    name: 'question-single',
    pending: 'question-single.json',
    answer: { kind: 'question', answers: { [Q_SINGLE.question]: 'Relay (Recommended)' } }
  },
  {
    name: 'question-multi',
    pending: 'question-multi.json',
    answer: { kind: 'question', answers: { [Q_MULTI.question]: ['Desktop', 'Mobile'] } }
  },
  {
    name: 'question-free-text',
    pending: 'question-single.json',
    answer: { kind: 'question', answers: { [Q_SINGLE.question]: '  Both, behind a flag  ' }, freeText: [Q_SINGLE.question] }
  },
  {
    name: 'question-partial-refused',
    pending: 'question-pair.json',
    answer: { kind: 'question', answers: { [Q_SINGLE.question]: 'SSH' } }
  },
  {
    name: 'question-unknown-label-refused',
    pending: 'question-single.json',
    answer: { kind: 'question', answers: { [Q_SINGLE.question]: 'Carrier pigeon' } }
  },
  { name: 'tool-mismatch-refused', pending: 'bash.json', answer: { kind: 'plan', mode: 'restore' } },
  {
    name: 'plan-revise-too-long-refused',
    pending: 'plan.json',
    answer: { kind: 'plan-revise', message: 'x'.repeat(ANSWER_TEXT_MAX_CHARS + 1) }
  },
  {
    name: 'question-free-text-too-long-refused',
    pending: 'question-single.json',
    answer: {
      kind: 'question',
      answers: { [Q_SINGLE.question]: 'x'.repeat(ANSWER_TEXT_MAX_CHARS + 1) },
      freeText: [Q_SINGLE.question]
    }
  },
  // Exactly AT the cap (8000 UTF-16 units) is accepted — a port with a lower cap fails here.
  { name: 'plan-revise-at-cap', pending: 'plan.json', answer: { kind: 'plan-revise', message: 'x'.repeat(ANSWER_TEXT_MAX_CHARS) } },
  {
    name: 'question-free-text-at-cap',
    pending: 'question-single.json',
    answer: {
      kind: 'question',
      answers: { [Q_SINGLE.question]: 'x'.repeat(ANSWER_TEXT_MAX_CHARS) },
      freeText: [Q_SINGLE.question]
    }
  }
]

const edge = utf8Edge()
const INPUTS: Record<string, string> = {
  'plain-turns.jsonl': plainTurns(),
  'tools-cross-page.jsonl': toolsCrossPage(),
  'plan-mode.jsonl': planMode(),
  'ask-question.jsonl': askQuestion(),
  'utf8-edge.jsonl': edge.body,
  'huge-last-line.jsonl': hugeLastLine(),
  'model-effort.jsonl': modelEffort(),
  'model-effort-no-carry.jsonl': modelEffortNoCarry(),
  'model-effort-synthetic.jsonl': modelEffortSynthetic(),
  'model-effort-utf16.jsonl': modelEffortUtf16(),
  'thinking.jsonl': thinking()
}

// ── Plumbing ─────────────────────────────────────────────────────────────────────────────────────
const serialize = (x: unknown): string => JSON.stringify(x, null, 2) + '\n'
const fixture = (rel: string): string => path.join(DIR, rel)

/** Write under UPDATE, else require the checked-in file to equal `content` exactly. */
function golden(rel: string, content: string): void {
  const p = fixture(rel)
  if (UPDATE) {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content)
    return
  }
  expect(fs.existsSync(p), `${rel} is missing — run UPDATE_CHAT_FIXTURES=1`).toBe(true)
  // A plain string compare: one differing byte fails, and vitest prints the diff.
  expect(fs.readFileSync(p, 'utf8'), rel).toBe(content)
}

describe('chat golden fixtures', () => {
  // The older-page size (the renderer's CHAT_OLDER_PAGE_BYTES) cannot be imported here — core's
  // tsconfig does not include the renderer — so it stays a literal pinned by the global constraints.
  it('the pager constants are the ones core uses', () => {
    expect(TAIL_BYTES).toBe(CHAT_PAGE_DEFAULT_BYTES)
    expect(MAX_BYTES).toBe(CHAT_PAGE_MAX_BYTES)
    expect(OLDER_BYTES).toBe(2 * TAIL_BYTES)
  })

  it('inputs are what the synthetic builders produce (checked in, never real transcripts)', () => {
    for (const [name, body] of Object.entries(INPUTS)) golden(`inputs/${name}`, body)
    for (const [name, body] of Object.entries(PENDING)) golden(`pending/${name}`, body)
    golden('decision-cases.json', serialize(DECISION_CASES))
    golden('answer-cases.json', serialize(ANSWER_CASES))
  })

  it('no orphan files: every directory holds exactly the generated set', () => {
    const CASE_FILES = ['answer-cases.json', 'decision-cases.json']
    const topLevelCases = (): string[] =>
      fs.readdirSync(DIR).filter((f) => f.endsWith('-cases.json')).sort()
    const listing = (dir: string): string[] =>
      fs.existsSync(fixture(dir)) ? fs.readdirSync(fixture(dir)).sort() : []
    const expected = [
      ...Object.keys(INPUTS).map((n) => n.replace(/\.jsonl$/, '.pages.json')),
      ...DECISION_CASES.map((c) => `${c.name}.decision.json`),
      ...ANSWER_CASES.map((c) => `${c.name}.answer.json`)
    ].sort()
    if (UPDATE) {
      // A renamed or removed case must not leave its old expected file behind.
      for (const f of listing('expected')) if (!expected.includes(f)) fs.rmSync(fixture(`expected/${f}`))
      for (const f of listing('inputs')) if (!(f in INPUTS)) fs.rmSync(fixture(`inputs/${f}`))
      for (const f of listing('pending')) if (!(f in PENDING)) fs.rmSync(fixture(`pending/${f}`))
      for (const f of topLevelCases()) if (!CASE_FILES.includes(f)) fs.rmSync(fixture(f))
      return
    }
    expect(topLevelCases()).toEqual(CASE_FILES)
    expect(listing('inputs')).toEqual(Object.keys(INPUTS).sort())
    expect(listing('pending')).toEqual(Object.keys(PENDING).sort())
    expect(listing('expected')).toEqual(expected)
  })

  for (const name of Object.keys(INPUTS)) {
    const base = name.replace(/\.jsonl$/, '')
    it(`${base}: paged parse matches expected/${base}.pages.json`, async () => {
      const file = fixture(`inputs/${name}`)
      const steps = await pageFile(file)
      // The pager is not a second implementation: every page equals what the real producer
      // (`readChatTranscript` → `readChatPage` → `parseGrowingWindow`) answers for that request.
      for (const s of steps) {
        const served = await readChatTranscript(
          { sessionId: SID },
          s.before === null ? { maxBytes: s.maxBytes } : { before: s.before, maxBytes: s.maxBytes },
          { pathFor: () => file }
        )
        const { noCompleteLine: _n, ...rest } = s.parse
        expect(served).toStrictEqual({ found: true, ...rest })
      }
      golden(`expected/${base}.pages.json`, serialize(steps))
    })
  }

  for (const c of ANSWER_CASES) {
    it(`${c.name}: answer parse matches expected/${c.name}.answer.json`, () => {
      golden(`expected/${c.name}.answer.json`, serialize(parsePermissionAnswer(c.answer)))
    })
  }

  for (const c of DECISION_CASES) {
    it(`${c.name}: decision matches expected/${c.name}.decision.json`, () => {
      const pending = parsePendingRequest(fs.readFileSync(fixture(`pending/${c.pending}`), 'utf8'))
      const answer = parsePermissionAnswer(c.answer)
      expect(answer, 'answer shape').not.toBeNull()
      golden(`expected/${c.name}.decision.json`, serialize(buildPermissionDecision(pending, answer!)))
    })
  }

  // What the boundary fixtures exist to exercise — pinned so a builder edit cannot quietly turn
  // them into ordinary files.
  it('utf8-edge: the tail opens mid-emoji and the older page opens exactly on a multi-byte line', async () => {
    const file = fixture('inputs/utf8-edge.jsonl')
    const buf = fs.readFileSync(file)
    const [tail, older] = await pageFile(file)
    const tailWindowStart = tail.start + 1
    expect(tailWindowStart).toBe(buf.length - TAIL_BYTES)
    expect(buf[tailWindowStart] & 0xc0).toBe(0x80) // a UTF-8 continuation byte
    expect(buf.subarray(tailWindowStart - 8, tailWindowStart + 8).toString('utf8')).toContain('�')
    const olderWindowStart = older.start + 1
    expect(older.before! - olderWindowStart).toBe(OLDER_BYTES)
    expect(buf[older.start]).toBe(0x0a)
    // L0 (same byte length at any index — fixed-width envelope) starts exactly at the window start.
    const l0InFile = buf.subarray(olderWindowStart, olderWindowStart + Buffer.byteLength(edge.l0)).toString('utf8')
    expect(l0InFile.startsWith('{"type":"user"')).toBe(true)
    expect(l0InFile.endsWith('\n')).toBe(true)
    expect(older.parse.messages[0].key).toBe(olderWindowStart)
    expect(JSON.stringify(older.parse.messages[0])).toContain('ğüşçöı')
    expect(JSON.stringify(older.parse.messages.at(-1))).toContain('😀'.repeat(64))
    expect(JSON.stringify(tail.parse.messages)).not.toContain('�')
  })

  it('model-effort-no-carry: the newest record states no effort, so the key is ABSENT', async () => {
    const buf = fs.readFileSync(fixture('inputs/model-effort-no-carry.jsonl'), 'utf8')
    const last = JSON.parse(buf.trimEnd().split('\n').at(-1)!)
    expect('effort' in last).toBe(false) // the input really omits it
    const [tail] = await pageFile(fixture('inputs/model-effort-no-carry.jsonl'))
    expect(tail.parse.model).toBe('claude-fable-5')
    expect('effort' in tail.parse).toBe(false)
  })

  it('model-effort-synthetic: the <synthetic> record carries no effort (measured shape)', () => {
    const buf = fs.readFileSync(fixture('inputs/model-effort-synthetic.jsonl'), 'utf8')
    const last = JSON.parse(buf.trimEnd().split('\n').at(-1)!)
    expect(last.message.model).toBe('<synthetic>')
    expect('effort' in last).toBe(false)
  })

  it('huge-last-line: the tail grows past its first window and still shows the last message', async () => {
    const [tail] = await pageFile(fixture('inputs/huge-last-line.jsonl'))
    expect(tail.grownMaxBytes).toBeGreaterThan(TAIL_BYTES)
    expect(tail.parse.noCompleteLine).toBe(false)
    expect(tail.parse.olderCursor).not.toBeNull()
    expect(JSON.stringify(tail.parse.messages.at(-1))).toContain('What is wrong in this screenshot?')
  })
})
