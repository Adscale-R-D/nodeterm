// A board without GitHub sync shows principal-declared PRs only through `useDeclaredPullBoard`; a
// dropped call compiles and shows nothing. Pinned at source level (jsdom does not start everywhere).
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (file: string): string => readFileSync(path.join(__dirname, file), 'utf8').replace(/\r\n/g, '\n')

describe('declared-only pull board wiring', () => {
  it('KanbanView polls it for a board without GitHub sync and links cards from it', () => {
    const src = read('KanbanView.tsx')
    expect(src).toMatch(/useDeclaredPullBoard\(api\.githubIssues, projectId, !board\.github\)/)
    expect(src).toMatch(/const pullBoard = board\.github \? github\?\.pullBoard : declaredBoard/)
    expect(src).toMatch(/if \(!board\.github && !pullBoard\?\.declared\?\.length\) return byCard/)
  })

  it('the poll asks pullStatus and stores only a declared answer', () => {
    const src = read('useDeclaredPullBoard.ts')
    expect(src).toMatch(/api\.pullStatus\(projectId\)/)
    expect(src).toMatch(/setDeclaredBoard\(projectId, next\.declared\?\.length \? next : undefined\)/)
  })
})
