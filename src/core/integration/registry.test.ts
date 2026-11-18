import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { testTmpDir } from '../test-tmp'
import {
  PrincipalRegistryReader,
  addPrincipal,
  listPrincipals,
  parseRegistry,
  registryPath,
  removePrincipal,
  rotatePrincipal,
  setPrincipalProjects,
  tokenPath
} from './registry'

const readToken = (dir: string, name: string): string => fs.readFileSync(tokenPath(dir, name), 'utf8').trim()

describe('integration registry', () => {
  it('add writes a 0600 token file in a 0700 dir and stores only its hash', async () => {
    const dir = testTmpDir('nt-int-reg-')
    const { entry, tokenFile } = await addPrincipal(dir, { name: 'sink', projects: ['project-a'], label: 'Sink' })
    const token = readToken(dir, 'sink')
    expect(token).toMatch(/^ntp_[A-Za-z0-9_-]{43}$/)
    expect(tokenFile).toBe(tokenPath(dir, 'sink'))
    if (process.platform !== 'win32') {
      expect(fs.statSync(tokenFile).mode & 0o777).toBe(0o600)
      expect(fs.statSync(path.dirname(tokenFile)).mode & 0o777).toBe(0o700)
      expect(fs.statSync(registryPath(dir)).mode & 0o777).toBe(0o600)
    }
    const text = fs.readFileSync(registryPath(dir), 'utf8')
    expect(text).not.toContain(token)
    expect(entry.tokenSha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('authenticates the right token, and nothing else', async () => {
    const dir = testTmpDir('nt-int-reg-')
    await addPrincipal(dir, { name: 'sink', projects: ['project-a'] })
    const reader = new PrincipalRegistryReader(dir)
    const token = readToken(dir, 'sink')
    expect(reader.authenticate('sink', token)?.name).toBe('sink')
    expect(reader.authenticate('sink', `${token}x`)).toBeUndefined()
    expect(reader.authenticate('other', token)).toBeUndefined()
    expect(reader.authenticate(['sink'], token)).toBeUndefined()
    expect(reader.authenticate('sink', undefined)).toBeUndefined()
    expect(reader.authenticate('../sink', token)).toBeUndefined()
  })

  it('rotate makes the old token stop working at once; remove revokes and deletes the file', async () => {
    const dir = testTmpDir('nt-int-reg-')
    await addPrincipal(dir, { name: 'sink', projects: ['project-a'] })
    const reader = new PrincipalRegistryReader(dir)
    const old = readToken(dir, 'sink')
    expect(reader.authenticate('sink', old)).toBeDefined()
    await rotatePrincipal(dir, 'sink')
    const fresh = readToken(dir, 'sink')
    expect(fresh).not.toBe(old)
    expect(reader.authenticate('sink', old)).toBeUndefined()
    expect(reader.authenticate('sink', fresh)).toBeDefined()
    await removePrincipal(dir, 'sink')
    expect(reader.authenticate('sink', fresh)).toBeUndefined()
    expect(fs.existsSync(tokenPath(dir, 'sink'))).toBe(false)
  })

  it('refuses a bad name, a duplicate, no project, and a colour off the palette', async () => {
    const dir = testTmpDir('nt-int-reg-')
    await expect(addPrincipal(dir, { name: 'Bad Name', projects: ['p'] })).rejects.toMatchObject({ code: 'E_BAD_NAME' })
    await expect(addPrincipal(dir, { name: 'sink', projects: [] })).rejects.toMatchObject({ code: 'E_NO_PROJECT' })
    await expect(addPrincipal(dir, { name: 'sink', projects: ['p'], color: '#123456' })).rejects.toMatchObject({ code: 'E_BAD_COLOR' })
    await addPrincipal(dir, { name: 'sink', projects: ['p'] })
    await expect(addPrincipal(dir, { name: 'sink', projects: ['p'] })).rejects.toMatchObject({ code: 'E_EXISTS' })
  })

  it('projects can be replaced', async () => {
    const dir = testTmpDir('nt-int-reg-')
    await addPrincipal(dir, { name: 'sink', projects: ['a'] })
    await setPrincipalProjects(dir, 'sink', ['b', 'c'])
    expect((await listPrincipals(dir))[0].projects).toEqual(['b', 'c'])
  })

  it('reads a hostile or corrupt file as an empty registry (nobody admitted)', () => {
    expect(parseRegistry('not json').principals).toEqual([])
    expect(parseRegistry(JSON.stringify({ version: 2, principals: [] })).principals).toEqual([])
    const reg = parseRegistry(
      JSON.stringify({
        version: 1,
        principals: [
          { name: 'ok', tokenSha256: 'a'.repeat(64), projects: ['p'], createdAt: 1 },
          { name: 'ok', tokenSha256: 'b'.repeat(64), projects: ['p'], createdAt: 1 },
          { name: 'nohash', tokenSha256: 'zz', projects: ['p'], createdAt: 1 },
          { name: 'noproj', tokenSha256: 'c'.repeat(64), projects: ['../x'], createdAt: 1 }
        ]
      })
    )
    expect(reg.principals.map((p) => p.name)).toEqual(['ok'])
    expect(reg.principals[0].tokenSha256).toBe('a'.repeat(64))
  })

  it('the reader notices a rewrite without a restart', async () => {
    const dir = testTmpDir('nt-int-reg-')
    const reader = new PrincipalRegistryReader(dir)
    expect(reader.current().principals).toEqual([])
    await addPrincipal(dir, { name: 'sink', projects: ['a'] })
    expect(reader.get('sink')).toBeDefined()
  })
})
