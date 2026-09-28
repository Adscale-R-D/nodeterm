# Chat golden fixtures

This directory holds the reference outputs for the mobile chat view's parser port
(`docs/mobile-chat-view.md`). The TypeScript implementation is the reference. `nodeterm-ios` keeps
a byte-identical copy of this directory, and its Swift port must reproduce every `expected/*.json`
from the same inputs.

Every input is **synthetic**. The inputs are built by `src/core/chat-fixtures.test.ts` from the
record shapes measured on real Claude transcripts. None of them is a slice of a real transcript,
because real transcripts carry customer data. Do not add one.

## Regenerate

```sh
UPDATE_CHAT_FIXTURES=1 npx vitest run src/core/chat-fixtures.test.ts
```

This command rewrites `inputs/`, `pending/`, `decision-cases.json` and `expected/`. Without the
variable, the test requires every file to equal what the code produces, so a parser change that
moves one byte of output fails here. After regenerating, refresh the iOS copy in the same change.

## Layout

| path | what it is |
|---|---|
| `inputs/<name>.jsonl` | A synthetic Claude transcript. |
| `expected/<name>.pages.json` | The page sequence the phone's pager produces from that transcript (see below). |
| `pending/<name>.json` | A held `PermissionRequest` hook payload, in the same form as the pending file the hook writes. |
| `decision-cases.json` | `[{name, pending, answer}]`: each answer that is tried against a pending file. |
| `expected/<case>.decision.json` | The `buildPermissionDecision` result for that case, as it is returned: `{ok:true, content, decision}` or `{ok:false, reason}`. |
| `answer-cases.json` | `[{name, answer}]`: raw answers given to the shape check alone. |
| `expected/<case>.answer.json` | `parsePermissionAnswer(answer)` verbatim. `null` means the shape check refuses the answer. |

The test also requires `inputs/`, `pending/`, `expected/` and the top-level `*-cases.json` files to
hold **exactly** the generated set.
A regenerate removes files that no case produces any more, so a copy taken from this directory never
carries a stale case. Regenerating is refused when `CI` is set.

Every expected file is `JSON.stringify(value, null, 2) + "\n"`. Keys appear in the order the TS
code builds them. Optional keys (`model`, `effort`, `at`, `key`, a tool part's `id`/`body`/
`result`/`questions`) are **absent** when unset. They are never `null`, and never present with an
`undefined` value.

## The pager (the Swift port must replicate this exactly)

The pager mirrors `parseGrowingWindow` in `src/core/transcript-ipc.ts`, one page at a time:

1. The first request is `before = null` (end of file) and `maxBytes = 262144`.
2. Read the window: `end = before ?? size`, `windowStart = max(0, end - maxBytes)`. The buffer
   starts **one byte earlier** (`start = windowStart - 1`) when `windowStart > 0`. This lookbehind
   byte is the only way to recognise a line that begins exactly on the window edge. Call
   `parseChatWindow(buffer, start)`.
3. While the result has `noCompleteLine`, `start != 0` and `maxBytes < 5242880`, set
   `maxBytes = min(5242880, maxBytes * 4)` and re-read the **same `before`**.
4. Record the step. If `olderCursor` is `null`, stop. Otherwise the next request is
   `before = olderCursor`, `maxBytes = 524288`.

Each entry in `*.pages.json` is one step:

```
{ before: number|null, maxBytes: number (requested), grownMaxBytes: number (after growth),
  start: number (absolute offset of the buffer's first byte, lookbehind included),
  parse: { messages, olderCursor, unmatchedResults, model?, effort?, noCompleteLine } }
```

`parse` is `parseChatWindow`'s return value, verbatim. The test also checks that every step equals
what the real desktop producer (`readChatTranscript` with that page) serves. The pager is therefore
the production paging, not a second implementation of it.

## What each fixture pins

| fixture | pins |
|---|---|
| `plain-turns` | User/assistant text, markdown (headings, lists, a blockquote, code fences), string and array user content, two text blocks in one message, and non-ASCII text. Metadata-only records (`file-history-snapshot`, `system`) yield no message. |
| `tools-cross-page` | A `tool_use` that lands in the second (older) page while its `tool_result` lands in the tail. The tail carries it in `unmatchedResults`, and the older page carries the tool part with its `id` so the port can attach it. One tool call is matched inside the tail. It also shows the `summarizeResult` rules: three lines joined, capped at 500. |
| `plan-mode` | An `ExitPlanMode` tool call with `input:{plan}`. The tool part carries the full plan as `body` and the approval text as `result`. |
| `ask-question` | `AskUserQuestion` with a single-select and a multi-select question: the rendered `body`, the parsed `questions` (the same reader the answer controls match on) and each result. |
| `utf8-edge` | Multi-byte characters on the window boundaries. The tail window (EOF − 262144) opens **inside** a 4-byte emoji of one line, which must be dropped as the partial line and never decoded torn. The second page (524288) starts **exactly** on the first byte of a multi-byte line, which is kept only because of the lookbehind `\n`. The straddled line reappears whole in that page. The test asserts both placements. |
| `huge-last-line` | The last line is a ~600 KB user record with a base64 image. The 262144 tail has no complete line, so it grows to 1048576. The message still shows its text part, and paging continues from the grown window's `olderCursor`. |
| `model-effort` | `model`/`effort` across records that go medium→xhigh and change model. The newest assistant record wins. |
| `model-effort-no-carry` | ONE record answers both fields. The newest record states no `effort`, so the key is absent, and an older record's value is never carried forward (same rule as `parseLatestUsage`). |
| `model-effort-synthetic` | A `<synthetic>` record (an API error or interrupt, with no effort) is skipped entirely, so both fields come from the real record before it. |
| `model-effort-utf16` | The 100-character cap counts **UTF-16 code units** (Swift `utf16.count`), not bytes or scalars. A model of 50 × U+1F9EA (100 units) is kept, and an effort of 101 units is absent. |
| `thinking` | Thinking blocks (`thinking`, `redacted_thinking`). The current TS reader **drops** them: a thinking-only record yields no message, and a mixed record keeps only its text. The port must match this until the desktop reader changes. |

Decision cases: plan `restore` / `acceptEdits` / `manual` / `revise` (the revise text is trimmed),
question single / multi (labels joined with `, `) / free text (trimmed), and three refusals: a
partial answer (two questions, one answered), an unknown label, and a tool mismatch (a plan answer
against a held `Bash`). The pipeline is
`parsePendingRequest(file text)` → `parsePermissionAnswer(answer)` → `buildPermissionDecision`.
Two more refusals come from the length cap (`ANSWER_TEXT_MAX_CHARS`, 8000 UTF-16 units): a revise
message and a free-text answer one unit over it.

**A decision's `content` is itself a JSON string**: it is the exact text the hook prints to Claude.
Its inner key order and escaping are those of `JSON.stringify`: `hookSpecificOutput` →
`hookEventName` → `decision` → `behavior` → `updatedInput` / `updatedPermissions` / `message`, and
within `updatedInput`, the pending file's own `tool_input` keys followed by `answers`. The port must
reproduce it **byte for byte** (the hook script matches a fixed prefix, `PERMISSION_DECISION_PREFIX`),
or at the very least compare it structurally after parsing. The prefix check alone requires the
first bytes to match exactly.

**Where each refusal happens matters, and the port must put it in the same layer.**
`answer-*.answer.json` records the SHAPE check: a plan `mode:'auto'` and an unknown `kind` are
refused there (`null`). An over-long text is NOT refused there: `answer-revise-too-long-parses`
parses, and the cap is applied by `buildPermissionDecision` (`plan-revise-too-long-refused`,
`question-free-text-too-long-refused`). Text of exactly 8000 units is accepted (`plan-revise-at-cap`,
`question-free-text-at-cap`), so a port with a lower cap fails too.

## Sizes

Most inputs are a few KB. Three inputs have to be larger than a page to exercise paging:
`tools-cross-page` (~290 KB), `utf8-edge` (~790 KB, which is one 512 KB page plus one 256 KB tail by
construction) and `huge-last-line` (~1.1 MB). Their filler is deterministic lorem ipsum, and the
base64 image is generated by a seeded generator.
