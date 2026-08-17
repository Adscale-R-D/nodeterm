/**
 * Agent messaging must be BOOTED and FED on both shells — asserted at source level, because this is
 * the class of miss this repo has shipped three times (see CLAUDE.md rule 10 and
 * `hook-verified-parity.test.ts`, which exists for the same reason on the hook path).
 *
 * The boundary tests cannot help here. A shell that never calls `initAgentMessaging` compiles, boots,
 * and answers every delivery with a plain "no handler" — and a shell that boots it but never feeds
 * `onAgentEvent` is worse: deliveries to an IDLE target work, so it looks wired, while every delivery
 * to a BUSY target is answered `queued` and then waits forever, since the flush trigger is the
 * target's own `done` event. Both failures are invisible until an agent is mid-handoff.
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const read = (rel: string): string =>
  fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf8')

describe('both shells boot agent messaging from the one core factory', () => {
  const shells = [
    { name: 'desktop', src: 'main/index.ts' },
    { name: 'server', src: 'server/index.ts' }
  ]

  for (const shell of shells) {
    it(`${shell.name} calls initAgentMessaging`, () => {
      const src = read(shell.src)
      expect(src).toContain('initAgentMessaging({')
      // From CORE, never a shell-local copy: the deps object carries the capability grant and the
      // pane-ownership gate, and two copies of those would drift.
      expect(src).toMatch(/from '.*core\/agents\/agent-messaging-boot'/)
    })

    it(`${shell.name} feeds every agent event to the queue`, () => {
      const src = read(shell.src)
      // Desktop calls it inline in its raw listener; the server passes the sink into wireAgentStatus,
      // whose listener calls it. Either shape is fine — dropping it is not.
      expect(src).toMatch(/messaging\.onAgentEvent|onMessagingEvent: messaging\.onAgentEvent/)
    })
  }

  it('the server listener actually invokes the sink it is handed', () => {
    // The wiring above passes `onMessagingEvent` in; this is the other half — that
    // `src/server/agent-status.ts` calls it from the listener that receives every hook event.
    const src = read('server/agent-status.ts')
    expect(src).toContain('opts.onMessagingEvent?.(enriched)')
    // The ENRICHED event, the same one the desktop hands it and the same one the browser gets: the
    // needs-you edge is computed once, and a delivery gate keying off a different event than the
    // badges would disagree with what the user sees.
    expect(src).not.toMatch(/onMessagingEvent\?\.\(e\)/)
  })

  it('neither shell reaches for the retired src/main module', () => {
    for (const shell of shells) {
      expect(read(shell.src)).not.toMatch(/from '.*\/agent-messaging'/)
    }
  })
})
