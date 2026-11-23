// Every hop that carries principal-declared PR links to the board is OPTIONAL (the GitHub service's
// provider, the change hook, the integration service's `onPullsChanged`), so a dropped one compiles
// and ships inert: the verbs answer, the ledger records, and no card ever shows the link. Pinned at
// source level, like the other shell wiring.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (file: string): string => readFileSync(path.join(__dirname, file), 'utf8').replace(/\r\n/g, '\n')

describe('declared pull links: the Server Edition wiring', () => {
  it('index.ts hands the ledger to the GitHub service and the change hook to canvas control', () => {
    const src = read('index.ts')
    expect(src).toMatch(/github\.service\.setDeclaredPulls\(canvasControl\.declaredPulls\)/)
    expect(src).toMatch(/onDeclaredPullsChanged:\s*\(projectId\)\s*=>\s*github\.service\.declaredPullsChanged\(projectId\)/)
  })

  it('canvas-control.ts gives the integration service the board repository and the change hook', () => {
    const src = read('canvas-control.ts')
    const integration = src.slice(src.indexOf('createIntegrationService({'), src.indexOf('const stationNotices'))
    expect(integration).toMatch(/boardRepository:\s*\(projectId\)\s*=>\s*deps\.boardRepository/)
    expect(read('index.ts')).toMatch(/boardRepository:\s*\(projectId\)\s*=>\s*github\.controller\.boardRepository\(projectId\)/)
    expect(integration).toMatch(/onPullsChanged:\s*deps\.onDeclaredPullsChanged/)
    // Both declared sources: principals' keys and the sessions' own `link-pr`.
    expect(src).toMatch(
      /declaredPulls:\s*\(projectId\)\s*=>\s*\[\s*\.\.\.integrationLedger\.ledger\.declaredForProject\(projectId\),\s*\.\.\.nodeLinks\.store\.declaredForProject\(projectId\)\s*\]/
    )
    // A session's `link-pr` refreshes the boards through the same hook.
    const links = src.slice(src.indexOf('createNodeLinkVerbHandler({'), src.indexOf('const actions'))
    expect(links).toMatch(/onPullsChanged: deps\.onDeclaredPullsChanged/)
  })
  it('the principal creator check passes the KEY (a node may hold several grants; revoking one key must stop its sends)', () => {
    expect(read('canvas-control.ts')).toMatch(
      /principalOwnsTarget = \(principal, nodeId, key\) => integrationLedger\.ledger\.owns\(principal, nodeId, key\)/
    )
  })
})
