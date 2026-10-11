import { afterEach, describe, expect, it } from 'vitest'
import { TerminalEmulator } from './terminal-emulator'

const emulators: TerminalEmulator[] = []
function emulator(cols = 20, rows = 4): TerminalEmulator {
  const e = new TerminalEmulator({ cols, rows, scrollback: 1000 })
  emulators.push(e)
  return e
}
afterEach(() => {
  for (const e of emulators.splice(0)) e.dispose()
})

/** The visible text of a keyframe, with SGR and cursor-move CSIs removed. */
function text(screen: string): string {
  // eslint-disable-next-line no-control-regex
  return screen.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
}

describe('TerminalEmulator.captureVisible (live link keyframe)', () => {
  it('returns exactly the visible rows — no history — with the cursor and SGR', async () => {
    const e = emulator()
    let data = ''
    for (let i = 0; i < 300; i++) data += `line ${i}\r\n`
    data += '\x1b[31mred\x1b[0m tail'
    await e.write(data)
    const cap = e.captureVisible()
    expect(cap.altScreen).toBe(false)
    expect(cap.screen.endsWith('\n')).toBe(true)
    expect(cap.screen).toContain('\x1b[31mred')
    expect(cap.screen).not.toContain('\r\n')
    expect(text(cap.screen).split('\n').slice(0, 4)).toEqual([
      'line 297',
      'line 298',
      'line 299',
      'red tail'
    ])
    expect(cap.cursor).toEqual({ x: 8, y: 3 })
    // The scrollback is still there for the warm-attach replay; the keyframe just never carries it.
    expect(e.serialize()).toContain('line 0')
  })

  it('reports the cursor where the app moved it, viewport-relative', async () => {
    const e = emulator()
    await e.write('a\r\nb\r\nc\x1b[1;5H')
    expect(e.captureVisible().cursor).toEqual({ x: 4, y: 0 })
  })

  it('captures the ALTERNATE screen alone, and says so', async () => {
    const e = emulator()
    await e.write('shell line\r\n$ vim\r\n')
    await e.write('\x1b[?1049h\x1b[Hfull screen app\r\n~')
    const cap = e.captureVisible()
    expect(cap.altScreen).toBe(true)
    expect(text(cap.screen)).toContain('full screen app')
    expect(text(cap.screen)).not.toContain('shell line')
    expect(cap.screen).not.toContain('\x1b[?1049h')
    // Back on the normal screen, the keyframe is the shell's again.
    await e.write('\x1b[?1049l')
    const back = e.captureVisible()
    expect(back.altScreen).toBe(false)
    expect(text(back.screen)).toContain('shell line')
    expect(text(back.screen)).not.toContain('full screen app')
  })

  it('keeps the private-mode tail a mid-stream viewer never saw', async () => {
    const e = emulator()
    await e.write('\x1b[?2004h\x1b[?1hprompt> ')
    const cap = e.captureVisible()
    expect(cap.screen).toContain('\x1b[?2004h')
    expect(cap.screen).toContain('\x1b[?1h')
  })

  it('is empty for a session that never painted', () => {
    expect(emulator().captureVisible()).toEqual({
      screen: '',
      cursor: { x: 0, y: 0 },
      altScreen: false
    })
  })
})

describe('captureVisible tail', () => {
  it("drops the serializer's relative cursor restore so the trailing newline cannot misplace it", async () => {
    const e = emulator()
    await e.write('one\r\ntwo\x1b[1;1H')
    const cap = e.captureVisible()
    expect(cap.screen).toBe('one\ntwo\n')
    expect(cap.cursor).toEqual({ x: 0, y: 0 })
  })
})
