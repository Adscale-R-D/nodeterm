import { execFile } from 'child_process'
import { win32 } from 'path'

/**
 * Windows leg of "copy file-backed nodes as files": a real CF_HDROP via
 * `System.Windows.Forms.Clipboard.SetFileDropList`, run in Windows PowerShell 5.1.
 *
 * - The explicit `System32\WindowsPowerShell\v1.0` path pins 5.1 (always present, .NET Framework,
 *   WinForms available) — `pwsh` 7's `Set-Clipboard` has no `-Path`, and PATH is not trusted.
 * - `-STA`: the OLE clipboard refuses an MTA thread.
 * - The PATHS NEVER RIDE ARGV OR THE SCRIPT TEXT: they arrive as JSON on stdin, so there is no
 *   quoting to get wrong and nothing for a crafted file name to inject into.
 */
export const WINDOWS_FILE_DROP_SCRIPT =
  '$ErrorActionPreference = "Stop"; ' +
  '$p = @([Console]::In.ReadToEnd() | ConvertFrom-Json); ' +
  'Add-Type -AssemblyName System.Windows.Forms; ' +
  '$c = New-Object System.Collections.Specialized.StringCollection; ' +
  'foreach ($x in $p) { [void]$c.Add([string]$x) }; ' +
  '[System.Windows.Forms.Clipboard]::SetFileDropList($c)'

/** PowerShell cold start is ~0.5–1.5 s; past this the copy is reported as failed, never hung. */
export const WINDOWS_FILE_DROP_TIMEOUT_MS = 5000

export type ExecFileLike = (
  file: string,
  args: string[],
  options: { timeout: number; windowsHide: boolean },
  callback: (error: Error | null) => void
) => {
  stdin?: { end(data: string): void; on?(event: 'error', listener: () => void): unknown } | null
} | undefined

export function windowsPowerShellPath(env: Record<string, string | undefined> = process.env): string {
  const root = env.SystemRoot || env.WINDIR || 'C:\\Windows'
  return win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

export function writeWindowsFileDrop(
  paths: string[],
  deps: { execFile?: ExecFileLike; env?: Record<string, string | undefined> } = {}
): Promise<boolean> {
  const run = deps.execFile ?? (execFile as unknown as ExecFileLike)
  return new Promise((resolve) => {
    try {
      const child = run(
        windowsPowerShellPath(deps.env),
        ['-NoProfile', '-NonInteractive', '-STA', '-Command', WINDOWS_FILE_DROP_SCRIPT],
        { timeout: WINDOWS_FILE_DROP_TIMEOUT_MS, windowsHide: true },
        (error) => resolve(!error)
      )
      if (!child?.stdin) {
        resolve(false)
        return
      }
      // A spawn failure surfaces in the callback; swallow the paired EPIPE on stdin.
      child.stdin.on?.('error', () => undefined)
      child.stdin.end(JSON.stringify(paths))
    } catch {
      resolve(false)
    }
  })
}
