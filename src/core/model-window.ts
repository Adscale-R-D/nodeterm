/** A hook reports only this session's effective env, never nodeterm's global environment.
 * Decimal safe integers only: reject partial parses, exponents, infinities and zero.
 * A window a session REPORTS beats every rule below; both tails consult this first. */
export function sessionContextWindow(value: unknown): number | null {
  if (typeof value !== 'string' || !/^[0-9]{1,16}$/.test(value)) return null
  const window = Number(value)
  return Number.isSafeInteger(window) && window > 0 ? window : null
}

// Resolves a Claude model → its context window (max input tokens), when the session reported none.
//
// ── THE RULE IS THE CLI'S, NOT A FAMILY GUESS ───────────────────────────────────────────────────
// This file used to map the model FAMILY to a window — opus/sonnet/fable → 1M, haiku → 200k — on
// the strength of one `/context` reading. That is backwards, and it under-reported context
// pressure by 5× for every 200k session: the meter read 20% on a session that was about to
// auto-compact. Decompiled from the shipped CLI (2.1.226,
// `@anthropic-ai/claude-code/bin/claude.exe`), the real resolver is:
//
//   function hT(e,t){ let r=Wmf(); if(r!==void 0) return r; if(vPs(e,t)) return Zye; return qmf(e,t) }
//   function Wmf(){ if(env.DISABLE_COMPACT){ let e=env.CLAUDE_CODE_MAX_CONTEXT_TOKENS; if(e>0) return e } }
//   function qmf(e,t){ if(wS(e)) return 1e6; if(t?.includes(betaHeader)&&fW(e)) return 1e6;
//                      if(B$(e)) return 1e6; let r=Zti(e); if(r!==null) return r;
//                      let n=env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
//                      if(n>0 && !id.startsWith("claude-")) return n; return nbr }
//   function wS(e){ if(qne()) return !1; return /\[1m\]/i.test(e) }
//   nbr = 200000   Zye = 200000
//
// In one sentence: **200k unless the model SELECTION STRING literally carries `[1m]`.** Not the
// family — the marker. And the marker is exactly what the transcript throws away (see
// `claude-model-selection.ts` for that measurement), which is why `claudeWindowFor` layers the
// user's recorded selection on top of the bare id.
//
// Unmodelled CLI branches, deliberately (all fall through to the 200k default, i.e. they can only
// make the meter read HIGH — the safe direction):
//   - `vPs`/`Uir()` = `longContext1mCreditsBlocked`, a runtime flag that caps an exhausted-credits
//     1M session back to 200k. Nothing on disk reflects it.
//   - the `context-1m` beta header and `native_1m` registry entries (`fW`/`B$`/`Zti`).
//   - `CLAUDE_CODE_MAX_CONTEXT_TOKENS` without `DISABLE_COMPACT` — the CLI honours it only for
//     ids that do NOT start with `claude-`, i.e. never for a first-party model.
//
// ── 2026-11-26: the `native_1m` branch is no longer an edge case ────────────────────────────────
// CLI 2.1.332 resolves the window from a MODEL CATALOG compiled into the binary, and in it every
// 5-generation model (plus opus-4-7/-4-8) is `context:{window:1e6,native_1m:!0}` — `claude-opus-5`
// and `claude-opus-5-5` included. `CLAUDE_CODE_DISABLE_1M_CONTEXT` (the CLI's `U$()`) is what turns
// it off. MEASURED on this host: the screenshot session (`claude-opus-5`, launched `--model opus`)
// auto-compacted at 168,048 on 2.1.226 (Aug) and at 825,082 on 2.1.332 (today); every
// `claude-opus-5-5` auto-compaction since 2.1.316 landed between 879,295 and 1,195,230. The
// "200k unless `[1m]`" rule therefore read every current session 5× HIGH. `NATIVE_1M_MODELS` is
// copied from that catalog (ids only; extracted with `strings` over the 2.1.332 binary).
// Fully synchronous.
import { claudeConfigDirFromTranscript, selectedClaudeModel } from './claude-model-selection'

const DEFAULT_WINDOW = 200_000
const LARGE_WINDOW = 1_000_000

/** The CLI 2.1.332 catalog's `native_1m` models (see the header). A dated suffix
 *  (`claude-opus-4-8-20260101`) still names the model. */
const NATIVE_1M_MODELS = [
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-sonnet-5-5',
  'claude-sonnet-5',
  'claude-haiku-5-5',
  'claude-fable-5-2',
  'claude-fable-5-1',
  'claude-fable-5',
  'claude-mythos-5-2',
  'claude-mythos-5-1',
  'claude-mythos-5'
] as const

/** True for a model id the current CLI runs with a native 1M window. Matches the id exactly or
 *  followed by a date / variant suffix, never a longer version (`claude-opus-5` is not
 *  `claude-opus-5-5`'s prefix match: the list is checked longest first). */
export function isNative1mModel(model: string | null | undefined): boolean {
  if (!model) return false
  const id = model.toLowerCase().replace(/\[[^\]]*\]$/, '')
  return NATIVE_1M_MODELS.some((m) => id === m || (id.startsWith(`${m}-`) && /^\d{8}$/.test(id.slice(m.length + 1))))
}

/** The CLI's `U$()`: `CLAUDE_CODE_DISABLE_1M_CONTEXT` turns the 1M window off everywhere. Read from
 *  the host env (a session started with it set in its own env is not visible here). */
function oneMillionDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.CLAUDE_CODE_DISABLE_1M_CONTEXT
  return !!v && v !== '0' && v.toLowerCase() !== 'false'
}

/** The CLI's `wS`: the ONLY thing that buys a 1M window is the literal `[1m]` marker. */
const ONE_M_MARKER = /\[1m\]/i

/** True when a model SELECTION string asks for the 1M window. Mirrors the CLI's `wS`. */
export function isOneMillionSelection(model: string | null | undefined): boolean {
  return !!model && ONE_M_MARKER.test(model)
}

/**
 * The CLI's `Wmf`: `CLAUDE_CODE_MAX_CONTEXT_TOKENS` overrides everything, but ONLY together with
 * `DISABLE_COMPACT`. Read from the host env — both shells run beside the sessions they measure.
 */
function envOverrideWindow(env: NodeJS.ProcessEnv = process.env): number | null {
  if (!env.DISABLE_COMPACT) return null
  const n = Number(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS)
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * Context window from a model string ALONE: 1M when it carries `[1m]` or is a native-1M model of the
 * current CLI's catalog (`claude-opus-5`, `claude-opus-5-5`, …), else 200k; 200k everywhere when
 * `CLAUDE_CODE_DISABLE_1M_CONTEXT` is set. Callers that can also see the user's selection should
 * prefer {@link claudeWindowFor}, which also gets an older model with an `opus[1m]` selection right.
 */
export function staticWindowFor(model: string | null): number {
  const override = envOverrideWindow()
  if (override !== null) return override
  if (oneMillionDisabled()) return DEFAULT_WINDOW
  return isOneMillionSelection(model) || isNative1mModel(model) ? LARGE_WINDOW : DEFAULT_WINDOW
}

/**
 * The window for a claude session, given the transcript's (bare) model id and, when known, the
 * path of the transcript itself — from which the owning config dir, and therefore the user's
 * `model` selection, is recovered. A managed account has its own config dir and so its own
 * selection; deriving it from the path is what makes that work with no extra plumbing.
 *
 * Precedence mirrors the CLI: env override → `[1m]` on the id → `[1m]` on the selection → 200k.
 * The selection is consulted only as a fallback, so an id that already states its variant is
 * never second-guessed.
 */
export function claudeWindowFor(model: string | null, transcriptPath?: string): number {
  const override = envOverrideWindow()
  if (override !== null) return override
  if (oneMillionDisabled()) return DEFAULT_WINDOW
  if (isOneMillionSelection(model) || isNative1mModel(model)) return LARGE_WINDOW
  const selection = selectedClaudeModel(claudeConfigDirFromTranscript(transcriptPath))
  return isOneMillionSelection(selection) ? LARGE_WINDOW : DEFAULT_WINDOW
}

/** Synchronous best guess for the model's window (no cache/network needed). */
export function cachedWindowFor(model: string | null): number {
  return staticWindowFor(model)
}

// ---------------------------------------------------------------------------------------------
// Gemini. Its transcript states no window, so the model id is the only signal — but gemini does
// not need a guess, because the CLI's own resolver is a FAMILY rule with a catch-all default.
// Mirrored from the shipped bundle rather than restated as a per-model table:
//   gemini-cli 0.54.4, bundle/chunk-BS6BSLZD.js:331674-331686
//     var DEFAULT_TOKEN_LIMIT = 1048576
//     var GEMMA_4_TOKEN_LIMIT = 256e3
//     function tokenLimit(model) { switch (model) {
//       case GEMMA_4_31B_IT_MODEL: case GEMMA_4_26B_A4B_IT_MODEL:  return GEMMA_4_TOKEN_LIMIT
//       case PREVIEW_GEMINI_MODEL: … case DEFAULT_GEMINI_FLASH_LITE_MODEL: return 1048576
//       default: return DEFAULT_TOKEN_LIMIT } }
// Because that `default:` is 1M, the five named 1M cases are redundant and copying them would only
// create something to go stale: an unknown or newly released gemini model gets the RIGHT answer
// from the default, which is exactly what a per-model allowlist would get wrong (silently, with a
// confident wrong denominator). So the two gemma models are the only special case here, as they
// are there. The transcript we measured names `gemini-3.5-flash`, which is in neither list and
// lands on the default — evidence the default branch is the one that carries the feature.
const GEMINI_DEFAULT_TOKEN_LIMIT = 1_048_576
const GEMINI_GEMMA_4_TOKEN_LIMIT = 256_000
// GEMMA_4_31B_IT_MODEL / GEMMA_4_26B_A4B_IT_MODEL (bundle/chunk-QXLHAGLO.js:279469-279470)
const GEMMA_4_MODELS = new Set(['gemma-4-31b-it', 'gemma-4-26b-a4b-it'])

/**
 * Context window for a gemini model id, per gemini's own `tokenLimit`. `null` only when there is no
 * model at all — a transcript that never named one tells us nothing, and the meter then stays
 * hidden rather than dividing by a number we invented.
 */
export function geminiWindowFor(model: string | null): number | null {
  if (!model) return null
  return GEMMA_4_MODELS.has(model) ? GEMINI_GEMMA_4_TOKEN_LIMIT : GEMINI_DEFAULT_TOKEN_LIMIT
}

/**
 * Context window for an Antigravity (`agy`) model id or display name (`modelName` in hook payloads
 * or `Model Selection` in `USER_INPUT` steps).
 *
 * MEASURED catalogue (`agy models`, 1.2.7):
 * - `gemini-4-argon-*`, `gemini-3.8-flash-*` ("Gemini 4 Argon ...", "Gemini 3.8 Flash ...") → 1M
 * - `claude-opus-*`, `claude-sonnet-*` ("Claude Opus ...", "Claude Sonnet ...") → `staticWindowFor`
 * - `gpt-oss-120b-*` ("GPT-OSS 120B ...") → 128k
 * - Unknown or empty → `null` (never guess a denominator).
 */
export function antigravityWindowFor(model: string | null | undefined): number | null {
  const m = model?.trim()
  if (!m) return null
  if (/^gemini\b|^gemini-/i.test(m)) return LARGE_WINDOW
  // Fork: NOT staticWindowFor — that is the fork's Claude Code rule (200k unless `[1m]`), which
  // describes what the claude CLI does. agy serves Claude through Google with its own catalogue,
  // where upstream measured opus/sonnet at 1M; keep upstream's family answer for this path only.
  if (/^claude\b|^claude-/i.test(m)) return /opus|sonnet|fable/i.test(m) ? LARGE_WINDOW : DEFAULT_WINDOW
  if (/^gpt-oss-120b\b|^gpt-oss-120b-/i.test(m)) return 128_000
  return null
}

