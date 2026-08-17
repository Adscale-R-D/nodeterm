// Reads the Claude model SELECTION (e.g. "opus[1m]") out of a config dir's settings.json.
//
// WHY THIS FILE EXISTS — the `[1m]` marker is the only signal, and the transcript drops it.
// Claude Code decides a session's context window from the model SELECTION STRING, not from the
// model id it later writes into the transcript. Decompiled from the shipped CLI (2.1.226,
// `bin/claude.exe`):
//
//   function wS(e){ if(qne()) return !1; return /\[1m\]/i.test(e) }        // ← the whole 1M rule
//   nbr = 200000                                                          // the default window
//   function qmf(e,t){ if(wS(e)) return 1e6; … return nbr }
//
// The selection is `opus[1m]` / `opus` / `claude-opus-5[1m]` / …; the transcript's
// `message.model` is always the bare canonical id (`claude-opus-5`). Measured across every
// transcript on this machine: the distinct ids are `claude-opus-5`, `claude-sonnet-5`,
// `claude-haiku-4-5-20251001`, `sonnet` — never a `[1m]` variant. Nor is the variant anywhere
// else Claude writes: not in any of the 16 transcript record types (`mode`, `permission-mode`,
// `custom-title`, … — there is no `model` record), not in `~/.claude/sessions/<pid>.json` (the
// live registry: pid/sessionId/cwd/tmux/status, no model), and not in `~/.claude.json`
// (`lastModelUsage` is keyed by the bare id too).
//
// So the family CANNOT imply the window, which is exactly what `model-window.ts` used to assume.
// The selection can, and this is where we read it.
//
// ── WHAT WE DO NOT MODEL (stated, so nobody "fixes" a deliberate gap) ──────────────────────────
//  - PROJECT-scoped settings (`<cwd>/.claude/settings.json`, `settings.local.json`) can also set
//    `model`. We read only the config dir's user-scope file, because the transcript path gives us
//    the config dir for free while the project cwd would have to be recovered from Claude's lossy
//    directory encoding (`/` → `-`). A project that overrides `model` therefore falls back to the
//    200k default — the safe direction (over-reports pressure, never under-reports).
//  - `--model` on the launch command line. nodeterm builds that line, so this is a real follow-up:
//    thread the flag through and it beats every heuristic here.
//  - `longContext1mCreditsBlocked` (the CLI's `Uir()`), a RUNTIME flag that caps an exhausted-
//    credits session back to 200k. Nothing on disk reflects it.
//  - `native_1m` model-registry entries and the `context-1m` beta header, both of which the CLI
//    also honours. Neither is readable from here.
import fs from 'fs'
import path from 'path'

/** Re-stat a config dir's settings.json at most this often. The value is a per-machine setting
 *  that changes when a human edits it, so a stat per quarter-minute is generous. */
const TTL_MS = 15_000

interface Entry {
  /** Last time we stat'd. */
  checkedAt: number
  /** mtime of settings.json at the last READ, so an unchanged file is never re-parsed. */
  mtimeMs: number
  /** The `model` value, or null for "no file / no key / unreadable". */
  model: string | null
}

const cache = new Map<string, Entry>()

/**
 * The Claude config dir that owns a transcript, or null when the path is not a transcript we
 * recognize. Shape: `<configDir>/projects/<encoded-cwd>/<sessionId>.jsonl`, so the config dir is
 * three levels up — but ONLY when the middle segment really is `projects`, or an unrelated path
 * would silently name some arbitrary directory as a Claude config dir.
 */
export function claudeConfigDirFromTranscript(transcriptPath: string | undefined): string | null {
  if (!transcriptPath) return null
  const projectDir = path.dirname(transcriptPath)
  const projectsRoot = path.dirname(projectDir)
  if (path.basename(projectsRoot) !== 'projects') return null
  const configDir = path.dirname(projectsRoot)
  return configDir && configDir !== projectsRoot ? configDir : null
}

/**
 * The `model` selection recorded in `<configDir>/settings.json`, or null when there is none.
 * Cached per config dir behind a TTL'd mtime check — this is consulted on every context-tail tick
 * (1 Hz per tracked session) and a bare read there would be a settings.json parse per session per
 * second. Sync on purpose: one `statSync` per config dir per {@link TTL_MS} is far cheaper than
 * the async plumbing, and the caller (`claudeWindowFor`) is sync so the meter never flaps between
 * a "not resolved yet" and a resolved denominator.
 */
export function selectedClaudeModel(configDir: string | null, now = Date.now()): string | null {
  if (!configDir) return null
  const hit = cache.get(configDir)
  if (hit && now - hit.checkedAt < TTL_MS) return hit.model

  const file = path.join(configDir, 'settings.json')
  let mtimeMs = -1
  try {
    mtimeMs = fs.statSync(file).mtimeMs
  } catch {
    // No settings.json (or unreadable) — remember the absence so we don't stat it every tick.
    cache.set(configDir, { checkedAt: now, mtimeMs: -1, model: null })
    return null
  }
  if (hit && hit.mtimeMs === mtimeMs) {
    hit.checkedAt = now
    return hit.model
  }

  let model: string | null = null
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as { model?: unknown }
    if (typeof raw.model === 'string' && raw.model.trim()) model = raw.model.trim()
  } catch {
    // Hand-edited settings.json mid-save, or not an object. Unknown, not 1M.
    model = null
  }
  cache.set(configDir, { checkedAt: now, mtimeMs, model })
  return model
}

/** Test seam only: drop the memoized selections between cases. */
export function resetClaudeModelSelectionCache(): void {
  cache.clear()
}
