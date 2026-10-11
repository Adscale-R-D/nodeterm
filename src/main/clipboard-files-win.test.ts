import { describe, expect, it, vi } from 'vitest'
import {
  WINDOWS_FILE_DROP_SCRIPT,
  WINDOWS_FILE_DROP_TIMEOUT_MS,
  windowsPowerShellPath,
  writeWindowsFileDrop,
  type ExecFileLike
} from './clipboard-files-win'

function fakeExec(error: Error | null = null) {
  const stdin = { end: vi.fn(), on: vi.fn() }
  const calls: Array<{ file: string; args: string[]; options: unknown }> = []
  const run: ExecFileLike = (file, args, options, callback) => {
    calls.push({ file, args, options })
    queueMicrotask(() => callback(error))
    return { stdin }
  }
  return { run, stdin, calls }
}

describe('writeWindowsFileDrop', () => {
  it('runs Windows PowerShell 5.1 in STA and sends the paths on stdin, never argv', async () => {
    const { run, stdin, calls } = fakeExec()
    const paths = ['C:\\a"; Remove-Item x; ".png', 'C:\\b $(evil).txt']
    expect(await writeWindowsFileDrop(paths, { execFile: run, env: { SystemRoot: 'D:\\Win' } })).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].file).toBe('D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(calls[0].args).toEqual(['-NoProfile', '-NonInteractive', '-STA', '-Command', WINDOWS_FILE_DROP_SCRIPT])
    for (const arg of calls[0].args) for (const p of paths) expect(arg).not.toContain(p)
    expect(calls[0].options).toEqual({ timeout: WINDOWS_FILE_DROP_TIMEOUT_MS, windowsHide: true })
    expect(stdin.end).toHaveBeenCalledWith(JSON.stringify(paths))
  })

  it('maps a nonzero exit or a timeout kill to false', async () => {
    expect(await writeWindowsFileDrop(['C:\\a'], { execFile: fakeExec(new Error('exit 1')).run })).toBe(false)
    const killed = Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' })
    expect(await writeWindowsFileDrop(['C:\\a'], { execFile: fakeExec(killed).run })).toBe(false)
  })

  it('fails closed when the process cannot be spawned', async () => {
    const throwing: ExecFileLike = () => {
      throw new Error('ENOENT')
    }
    expect(await writeWindowsFileDrop(['C:\\a'], { execFile: throwing })).toBe(false)
    expect(await writeWindowsFileDrop(['C:\\a'], { execFile: () => ({ stdin: null }) })).toBe(false)
  })

  it('writes a real CF_HDROP through SetFileDropList', () => {
    expect(WINDOWS_FILE_DROP_SCRIPT).toContain('[System.Windows.Forms.Clipboard]::SetFileDropList')
    expect(WINDOWS_FILE_DROP_SCRIPT).toContain('[Console]::In.ReadToEnd()')
  })
})

describe('windowsPowerShellPath', () => {
  it('pins the inbox 5.1 binary and falls back to C:\\Windows', () => {
    expect(windowsPowerShellPath({})).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(windowsPowerShellPath({ WINDIR: 'E:\\W' })).toBe('E:\\W\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  })
})
