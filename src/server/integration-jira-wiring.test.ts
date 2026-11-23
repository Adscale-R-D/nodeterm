// Every hop of the declared-Jira path is optional and compiles when dropped: pin each at source level.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (p: string): string => readFileSync(join(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n')

describe('declared Jira tickets — wiring', () => {
  it('the server broadcasts a changed list and serves the read', () => {
    const cc = read('server/canvas-control.ts')
    expect(cc).toMatch(/const jiraChanged = \(\): void => \{[\s\S]*?broadcast\(IPC\.integrationJiraChanged, links\)/)
    expect(cc).toMatch(/integrationLedger\.ledger\.setOnChange\(jiraChanged\)/)
    expect(cc).toMatch(/nodeLinks\.store\.setOnChange\(jiraChanged\)/)
    expect(cc).toMatch(/mergeJiraCards\(\[\.\.\.integrationLedger\.ledger\.jiraLinks\(\), \.\.\.nodeLinks\.store\.jiraLinks\(\)\]\)/)
    expect(cc).toMatch(/jiraLinks: allJiraLinks,/)
    expect(cc).toMatch(/nodeLinks: \(verb, sourceNodeId, args\) => nodeLinkHandler\(verb, sourceNodeId, args\)/)
    expect(read('server/index.ts')).toMatch(/registerIntegrationJiraIpc\(platform, \(\) => \(canvasControl \? \(\) => canvasControl!\.jiraLinks\(\) : null\)\)/)
  })
  it('the desktop answers an empty list, and the read is host-only', () => {
    expect(read('main/index.ts')).toMatch(/registerIntegrationJiraIpc\(corePlatform, \(\) => null\)/)
    expect(read('shared/host-control.ts')).toMatch(/IPC\.integrationJiraList,/)
  })
  it('the browser bridge is real, the relay tab inert, and the board installs the mirror', () => {
    expect(read('renderer/bridge/ws-bridge.ts')).toMatch(/\.\.\.buildIntegrationJiraApi\(client\)/)
    expect(read('renderer/bridge/relay-api.ts')).toMatch(/integrationJira: stub\.integrationJira/)
    expect(read('renderer/canvas/Canvas.tsx')).toMatch(/installIntegrationJiraWiring\(window\.nodeTerminal\)/)
    expect(read('renderer/components/kanban/SessionCard.tsx')).toMatch(/<JiraTicketChips nodeId=\{session\.id\}/)
    expect(read('renderer/components/kanban/CardModal.tsx')).toMatch(/<JiraTicketChips nodeId=\{session\.id\} projectId=\{projectId\}/)
  })
})
