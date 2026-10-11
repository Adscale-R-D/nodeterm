// The session-host leg of the session-memory sweep (Windows parity) and its Windows process table.
// Runs on every CI host: the platform and the process table are injected, never read.
import { describe, it, expect } from 'vitest'
import {
  collectSessionHostMemory,
  parseWin32ProcessTable,
  win32ProcessTable,
  WIN32_PROCESS_TABLE_SCRIPT,
  type ProcEntry
} from './session-memory'
import { cimRows, powershellArgs, powershellExe } from './win32-powershell'
import type { SessionHostListing } from './session-host-client'
import { sessionName } from './tmux-naming'

const P = (pid: number, ppid: number, rssKb: number): ProcEntry => ({ pid, ppid, rssKb })
const MEM = { availableMb: 8000, totalMb: 16000 }
const row = (name: string, pid: number) => ({
  name,
  pid,
  subscribers: 0,
  lastOutputMs: 1,
  createdMs: 1,
  generation: 'gen-aaaaaaaa'
})

describe('cimRows (ConvertTo-Json shapes)', () => {
  it('accepts an array, a bare object (one-element pipeline) and nothing (empty pipeline)', () => {
    expect(cimRows('[{"a":1},{"a":2}]')).toEqual([{ a: 1 }, { a: 2 }])
    expect(cimRows('{"a":1}\r\n')).toEqual([{ a: 1 }])
    expect(cimRows('  \r\n')).toEqual([])
  })
  it('anything else is unreadable (null), never "no rows"', () => {
    expect(cimRows('[{"a":1},')).toBeNull()
    expect(cimRows('42')).toBeNull()
    expect(cimRows('[1,2]')).toBeNull()
    expect(cimRows('WARNING: something')).toBeNull()
  })
  it('argv is the unattended, profile-free form with the script as ONE element', () => {
    expect(powershellArgs('x | y')).toEqual(['-NoProfile', '-NonInteractive', '-Command', 'x | y'])
  })
})

describe('parseWin32ProcessTable', () => {
  it('maps CIM rows to pid/ppid/kB, working set in BYTES', () => {
    const json = JSON.stringify([
      { ProcessId: 4000, ParentProcessId: 900, WorkingSetSize: 10 * 1024 * 1024 },
      { ProcessId: 4100, ParentProcessId: 4000, WorkingSetSize: 2048 }
    ])
    expect(parseWin32ProcessTable(json)).toEqual([P(4000, 900, 10 * 1024), P(4100, 4000, 2)])
  })
  it('accepts a single object; a missing working set is 0, not a dropped process', () => {
    expect(parseWin32ProcessTable('{"ProcessId":7,"ParentProcessId":1,"WorkingSetSize":null}')).toEqual([P(7, 1, 0)])
  })
  it('skips rows without numeric ids; bad JSON or an empty table is null', () => {
    expect(parseWin32ProcessTable('[{"ProcessId":"x","ParentProcessId":1},{"ProcessId":2,"ParentProcessId":1}]')).toEqual([
      P(2, 1, 0)
    ])
    expect(parseWin32ProcessTable('not json')).toBeNull()
    expect(parseWin32ProcessTable('')).toBeNull()
  })
  it('the reader goes through the exec seam with the fixed script, and a failed exec is null', async () => {
    const calls: Array<{ bin: string; args: string[] }> = []
    const table = await win32ProcessTable(async (bin, args) => {
      calls.push({ bin, args })
      return '{"ProcessId":7,"ParentProcessId":1,"WorkingSetSize":1024}'
    })
    expect(table).toEqual([P(7, 1, 1)])
    expect(calls).toEqual([{ bin: powershellExe(), args: powershellArgs(WIN32_PROCESS_TABLE_SCRIPT) }])
    await expect(
      win32ProcessTable(async () => {
        throw new Error('exit 1')
      })
    ).resolves.toBeNull()
  })
})

describe('collectSessionHostMemory', () => {
  const listing = (over: Partial<SessionHostListing> = {}): SessionHostListing => ({
    running: true,
    names: ['nt-a', 'nt-b'],
    sessions: [row('nt-a', 100), row('nt-b', 200)],
    ...over
  })
  const table = [P(100, 1, 1024), P(101, 100, 300 * 1024), P(200, 1, 2048), P(999, 1, 5000)]

  it('rolls each session\'s pty pid up through its tree, sorted by total', async () => {
    const r = await collectSessionHostMemory({
      list: async () => listing(),
      readTable: async () => table,
      readMem: () => MEM
    })
    expect(r.ok).toBe(true)
    expect(r.mem).toEqual(MEM)
    expect(r.unmeasured).toBeUndefined()
    expect(r.rows.map((x) => [x.session, x.nodeId, x.panePid, x.totalMb, x.childCount])).toEqual([
      ['nt-a', 'a', 100, 301, 1],
      ['nt-b', 'b', 200, 2, 0]
    ])
  })

  it('the Windows table is read through PowerShell when the platform is win32', async () => {
    const bins: string[] = []
    const r = await collectSessionHostMemory({
      list: async () => listing({ names: ['nt-a'], sessions: [row('nt-a', 100)] }),
      readMem: () => MEM,
      platformName: 'win32',
      exec: async (bin) => {
        bins.push(bin)
        return JSON.stringify([{ ProcessId: 100, ParentProcessId: 1, WorkingSetSize: 4 * 1024 * 1024 }])
      }
    })
    expect(bins).toEqual([powershellExe()])
    expect(r.rows[0]).toMatchObject({ session: 'nt-a', totalMb: 4 })
  })

  it('a failed host read is ok:false, and so is an unreadable process table', async () => {
    expect(await collectSessionHostMemory({ list: async () => null, readMem: () => MEM })).toEqual({
      ok: false,
      rows: [],
      mem: MEM
    })
    const threw = await collectSessionHostMemory({
      list: async () => {
        throw new Error('pipe gone')
      },
      readMem: () => MEM
    })
    expect(threw.ok).toBe(false)
    const noTable = await collectSessionHostMemory({ list: async () => listing(), readTable: async () => null, readMem: () => MEM })
    expect(noTable).toEqual({ ok: false, rows: [], mem: MEM })
  })

  it('no host running is an ANSWER (ok, no rows) and reads no process table', async () => {
    let read = 0
    const r = await collectSessionHostMemory({
      list: async () => ({ running: false, names: [], sessions: [] }),
      readTable: async () => {
        read++
        return table
      },
      readMem: () => MEM
    })
    expect(r).toEqual({ ok: true, rows: [], mem: MEM })
    expect(read).toBe(0)
  })

  it('an older host (names only) reports every nt- session as unmeasured, never "no sessions"', async () => {
    const r = await collectSessionHostMemory({
      list: async () => listing({ names: ['nt-a', 'nt-b', 'other'], sessions: null }),
      readTable: async () => table,
      readMem: () => MEM
    })
    expect(r).toEqual({ ok: true, rows: [], mem: MEM, unmeasured: 2, unmeasuredBackend: 'session-host' })
  })

  it('a named session without a row is unmeasured beside the measured ones', async () => {
    const r = await collectSessionHostMemory({
      list: async () => listing({ sessions: [row('nt-a', 100)] }),
      readTable: async () => table,
      readMem: () => MEM
    })
    expect(r.rows.map((x) => x.session)).toEqual(['nt-a'])
    expect(r.unmeasured).toBe(1)
    expect(r.unmeasuredBackend).toBe('session-host')
  })

  it('a row whose session name maps back to its node id (the kill round trip)', async () => {
    const r = await collectSessionHostMemory({
      list: async () => listing({ names: ['nt-node-1'], sessions: [row('nt-node-1', 100)] }),
      readTable: async () => table,
      readMem: () => MEM
    })
    // The panel's × kills `transport.destroy(nodeId)`, which re-derives the name via sessionName().
    expect(sessionName(r.rows[0].nodeId)).toBe('nt-node-1')
  })
})
