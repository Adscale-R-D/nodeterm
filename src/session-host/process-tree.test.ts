import { describe, expect, it } from 'vitest'
import { paneCommandFromRows, type ProcRow } from './process-tree'

const row = (pid: number, ppid: number, name: string): ProcRow => ({ pid, ppid, name })

describe('paneCommandFromRows', () => {
  it('answers the idle shell when it has no children', () => {
    expect(paneCommandFromRows([row(10, 1, 'pwsh.exe')], 10)).toBe('pwsh.exe')
  })

  it('answers null when the root is gone', () => {
    expect(paneCommandFromRows([row(11, 1, 'pwsh.exe')], 10)).toBeNull()
  })

  it('answers a nested shell the user typed into (pwsh -> cmd)', () => {
    expect(paneCommandFromRows([row(10, 1, 'pwsh.exe'), row(20, 10, 'cmd.exe')], 10)).toBe('cmd.exe')
  })

  it('answers the agent, not the shell its tool spawned as a leaf (pwsh -> node -> bash.exe)', () => {
    const rows = [row(10, 1, 'pwsh.exe'), row(20, 10, 'node.exe'), row(30, 20, 'bash.exe')]
    expect(paneCommandFromRows(rows, 10)).toBe('node.exe')
  })

  it('answers a non-shell for an MCP server launched via cmd /c (node -> cmd -> node)', () => {
    const rows = [
      row(10, 1, 'pwsh.exe'),
      row(20, 10, 'cmd.exe'),
      row(30, 20, 'node.exe'),
      row(40, 30, 'cmd.exe'),
      row(50, 30, 'powershell.exe')
    ]
    expect(paneCommandFromRows(rows, 10)).toBe('node.exe')
  })

  it('still answers the deepest non-shell process otherwise', () => {
    const rows = [row(10, 1, 'pwsh.exe'), row(20, 10, 'node.exe'), row(30, 20, 'codex.exe')]
    expect(paneCommandFromRows(rows, 10)).toBe('codex.exe')
  })

  it('answers a non-shell root (a session spawned straight into a program)', () => {
    expect(paneCommandFromRows([row(10, 1, 'node.exe'), row(20, 10, 'cmd.exe')], 10)).toBe('node.exe')
  })
})
