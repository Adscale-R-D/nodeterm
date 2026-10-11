// The one way core asks Windows a question through PowerShell (session memory's process table,
// dev-server ports' listeners). Pure argv + parsing; the subprocess itself always runs through the
// caller's injectable exec seam, so every consumer stays testable on any CI host.

/** Windows PowerShell 5.1 ships with every supported Windows; `pwsh` is optional and not assumed. */
export const POWERSHELL_EXE = 'powershell.exe'

/**
 * Argv for one unattended script. `-NoProfile`: a user profile can take seconds and print into the
 * stdout we parse (the same reason session-host/process-tree.ts passes it). `-NonInteractive`: a
 * prompt would hang until the exec timeout instead of failing. The script is ONE argv element —
 * never a shell-interpolated string — and is a constant written in this repo, never user input.
 */
export function powershellArgs(script: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-Command', script]
}

/**
 * Parse `ConvertTo-Json -Compress` output into rows. `ConvertTo-Json` prints a bare OBJECT for a
 * one-element pipeline, an ARRAY for several, and NOTHING for an empty one, so all three are
 * accepted (`''` → `[]`). Anything else — truncated or non-JSON text, a scalar — is `null`: a reply
 * we cannot read is never "no rows".
 */
export function cimRows(text: string): Record<string, unknown>[] | null {
  const trimmed = text.trim()
  if (trimmed === '') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  const list = Array.isArray(parsed) ? parsed : [parsed]
  if (!list.every((r) => r !== null && typeof r === 'object' && !Array.isArray(r))) return null
  return list as Record<string, unknown>[]
}
