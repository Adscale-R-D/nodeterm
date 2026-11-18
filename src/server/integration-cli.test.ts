import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { testTmpDir } from '../core/test-tmp'
import { listPrincipals, tokenPath } from '../core/integration/registry'
import { SETTINGS_VERB_KEY_LIST } from '../shared/settings-verb'
import { resolveProjectArg, runIntegrationCli } from './integration-cli'
import { subcommandArgv } from './team-cli'

function dataDirWithWorkspace(): string {
  const dir = testTmpDir('nt-int-cli-')
  fs.writeFileSync(
    path.join(dir, 'workspace.json'),
    JSON.stringify({
      version: 3,
      entries: [
        { id: 'project-a', cwd: '/home/u/app' },
        { id: 'project-ssh', cwd: '/home/u/remote', ssh: { server: 'x' } }
      ]
    })
  )
  return dir
}

async function cli(dir: string, ...argv: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = []
  const err: string[] = []
  const code = await runIntegrationCli(argv, dir, (s) => out.push(s), (s) => err.push(s))
  return { code, out, err }
}

describe('integration CLI', () => {
  it('is recognised as a subcommand, with a --data-dir before it carried over', () => {
    expect(subcommandArgv(['--data-dir', '/d', 'integration', 'list'], 'integration')).toEqual(['list', '--data-dir', '/d'])
    expect(subcommandArgv(['team', 'status'], 'integration')).toBeNull()
  })

  it('add takes a project by folder, prints the token FILE (never the token)', async () => {
    const dir = dataDirWithWorkspace()
    const r = await cli(dir, 'add', 'sink', '--project', '/home/u/app', '--label', 'Sink')
    expect(r.code).toBe(0)
    const token = fs.readFileSync(tokenPath(dir, 'sink'), 'utf8').trim()
    expect(r.out.join('\n')).toContain(tokenPath(dir, 'sink'))
    expect(r.out.join('\n')).not.toContain(token)
    expect((await listPrincipals(dir))[0]).toMatchObject({ name: 'sink', label: 'Sink', projects: ['project-a'] })
  })

  it('--json answers machine-readably, success and refusal', async () => {
    const dir = dataDirWithWorkspace()
    const ok = await cli(dir, 'add', 'sink', '--project', 'project-a', '--json')
    expect(JSON.parse(ok.out[0])).toMatchObject({ ok: true, principal: 'sink', projects: ['project-a'] })
    const dup = await cli(dir, 'add', 'sink', '--project', 'project-a', '--json')
    expect(dup.code).toBe(1)
    expect(JSON.parse(dup.out[0])).toMatchObject({ ok: false, code: 'E_EXISTS' })
    const list = await cli(dir, 'list', '--json')
    expect(JSON.parse(list.out[0]).principals[0]).not.toHaveProperty('tokenSha256')
  })

  it('refuses an SSH project, an unknown project and a folder no project has', () => {
    const dir = dataDirWithWorkspace()
    expect(resolveProjectArg(dir, 'project-ssh')).toMatchObject({ error: expect.stringContaining('SSH') })
    expect(resolveProjectArg(dir, 'project-zzz')).toMatchObject({ error: expect.stringContaining('no project') })
    expect(resolveProjectArg(dir, '/elsewhere')).toMatchObject({ error: expect.stringContaining('no project') })
    expect(resolveProjectArg(dir, 'project-a')).toBe('project-a')
  })

  it('a wrong command line exits 2 with the usage', async () => {
    const dir = dataDirWithWorkspace()
    expect((await cli(dir)).code).toBe(2)
    expect((await cli(dir, 'add')).code).toBe(2)
    expect((await cli(dir, 'list', '--bogus')).code).toBe(2)
  })

  it('the `settings` canvas-control verb cannot reach the principal registry', () => {
    // The registry is its own file (integrations.json), not settings.json, and no key of the verb's
    // allowlist names it — the allowlist is the only thing the verb can write.
    expect(SETTINGS_VERB_KEY_LIST.some((k) => /integration/i.test(k))).toBe(false)
  })
})
