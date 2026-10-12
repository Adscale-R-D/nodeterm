import { describe, expect, it } from 'vitest'
import { cimRows, powershellExe } from './win32-powershell'

describe('powershellExe', () => {
  it('is an ABSOLUTE System32 path — never a bare name Windows would resolve against the cwd first', () => {
    expect(powershellExe({ SystemRoot: 'D:\\Win' })).toBe(
      'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    )
    expect(powershellExe({ WINDIR: 'E:\\W' })).toBe('E:\\W\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(powershellExe({})).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  })
})

describe('cimRows', () => {
  it('accepts an object, an array and empty output; rejects anything else', () => {
    expect(cimRows('{"a":1}')).toEqual([{ a: 1 }])
    expect(cimRows('[{"a":1},{"a":2}]')).toHaveLength(2)
    expect(cimRows('  ')).toEqual([])
    expect(cimRows('[{"a":1}')).toBeNull()
    expect(cimRows('3')).toBeNull()
  })
})
