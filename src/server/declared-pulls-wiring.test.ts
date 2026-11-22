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
    expect(integration).toMatch(/boardRepository:\s*\(projectId\)\s*=>\s*deps\.issueRepository/)
    expect(integration).toMatch(/onPullsChanged:\s*deps\.onDeclaredPullsChanged/)
    expect(src).toMatch(/declaredPulls:\s*\(projectId\)\s*=>\s*integrationLedger\.ledger\.declaredForProject\(projectId\)/)
  })
})
