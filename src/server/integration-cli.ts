// `node out/server/main.cjs integration <command>` — register and manage INTEGRATION PRINCIPALS
// (docs/integration-principal.md). It writes `<dataDir>/integrations.json` and the principal's token
// file directly; the running server re-reads the registry when it changes, so no socket and no
// restart are involved. It never prints a token: the token file's PATH is printed, and the
// principal's own program reads the file.
//
// Exit codes: 0 done, 1 refused, 2 the command line is wrong.
import { readFileSync } from 'node:fs'
import path from 'node:path'

import {
  RegistryError,
  addPrincipal,
  listPrincipals,
  removePrincipal,
  rotatePrincipal,
  setPrincipalProjects,
  type PrincipalEntry
} from '../core/integration/registry'

export const INTEGRATION_USAGE = [
  'usage: integration <command> [--data-dir <dir>] [--json]',
  '  add <name> --project <id|folder> [--project …] [--label <text>] [--color <hex>]',
  '                                   register a principal; writes its token file',
  '  rotate <name>                    new token (the old one stops working at once)',
  '  projects <name> --project <id|folder> [--project …]   replace its projects',
  '  remove <name>                    unregister (close its keys first; its nodes stay)',
  '  list                             registered principals'
].join('\n')

interface Parsed {
  cmd: string
  name?: string
  projects: string[]
  label?: string
  color?: string
  json: boolean
  dataDir?: string
}

function parse(argv: string[]): Parsed | string {
  const out: Parsed = { cmd: '', projects: [], json: false }
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]
    const value = (flag: string): string | null => {
      if (tok.startsWith(`${flag}=`)) return tok.slice(flag.length + 1)
      const v = argv[i + 1]
      if (v === undefined || v.startsWith('--')) return null
      i++
      return v
    }
    if (tok === '--json') out.json = true
    else if (tok === '--project' || tok.startsWith('--project=')) {
      const v = value('--project')
      if (v === null) return '--project needs a value'
      out.projects.push(v)
    } else if (tok === '--label' || tok.startsWith('--label=')) {
      const v = value('--label')
      if (v === null) return '--label needs a value'
      out.label = v
    } else if (tok === '--color' || tok.startsWith('--color=')) {
      const v = value('--color')
      if (v === null) return '--color needs a value'
      out.color = v
    } else if (tok === '--data-dir' || tok.startsWith('--data-dir=')) {
      const v = value('--data-dir')
      if (v === null) return '--data-dir needs a value'
      out.dataDir = path.resolve(v)
    } else if (tok.startsWith('--')) return `unknown option ${tok}`
    else positional.push(tok)
  }
  out.cmd = positional[0] ?? ''
  out.name = positional[1]
  if (positional.length > 2) return `unexpected argument ${positional[2]}`
  return out
}

/** A `--project` value: a project entry id, or a folder that a workspace entry has as its `cwd`. */
export function resolveProjectArg(dataDir: string, value: string): string | { error: string } {
  let entries: Array<{ id?: unknown; cwd?: unknown; ssh?: unknown }> = []
  try {
    const ws = JSON.parse(readFileSync(path.join(dataDir, 'workspace.json'), 'utf8')) as { entries?: unknown }
    if (Array.isArray(ws.entries)) entries = ws.entries as typeof entries
  } catch {
    // Unreadable index: only a literal id can be taken, and the server re-checks it per request.
  }
  if (path.isAbsolute(value)) {
    const want = path.resolve(value)
    const hits = entries.filter((e) => typeof e.cwd === 'string' && path.resolve(e.cwd) === want)
    if (hits.length !== 1 || typeof hits[0].id !== 'string')
      return { error: hits.length ? `${value} belongs to several projects; pass the project id` : `no project has the folder ${value}; open it in nodeterm first, or pass a project id` }
    if (hits[0].ssh) return { error: `${value} is an SSH project; Server Edition opens local sessions only` }
    return hits[0].id
  }
  const hit = entries.find((e) => e.id === value)
  if (entries.length && !hit) return { error: `no project with the id ${value} in this data dir` }
  if (hit?.ssh) return { error: `${value} is an SSH project; Server Edition opens local sessions only` }
  return value
}

function describe(e: PrincipalEntry): string {
  return `${e.name}  label="${e.label}"  projects=${e.projects.join(',')}${e.color ? `  color=${e.color}` : ''}`
}

export async function runIntegrationCli(
  argv: string[],
  defaultDataDir: string,
  out: (s: string) => void,
  err: (s: string) => void
): Promise<number> {
  const p = parse(argv)
  if (typeof p === 'string') {
    err(`${p}\n${INTEGRATION_USAGE}`)
    return 2
  }
  const dataDir = p.dataDir ?? defaultDataDir
  const needName = ['add', 'rotate', 'projects', 'remove'].includes(p.cmd)
  if (!p.cmd || !['add', 'rotate', 'projects', 'remove', 'list'].includes(p.cmd) || (needName && !p.name)) {
    err(INTEGRATION_USAGE)
    return 2
  }
  const projects: string[] = []
  for (const v of p.projects) {
    const r = resolveProjectArg(dataDir, v)
    if (typeof r !== 'string') {
      err(r.error)
      return 1
    }
    projects.push(r)
  }
  try {
    switch (p.cmd) {
      case 'add': {
        const { entry, tokenFile } = await addPrincipal(dataDir, {
          name: p.name!,
          projects,
          ...(p.label !== undefined ? { label: p.label } : {}),
          ...(p.color !== undefined ? { color: p.color } : {})
        })
        if (p.json) out(JSON.stringify({ ok: true, principal: entry.name, projects: entry.projects, tokenFile }))
        else out(`registered ${describe(entry)}\ntoken file: ${tokenFile}`)
        return 0
      }
      case 'rotate': {
        const { entry, tokenFile } = await rotatePrincipal(dataDir, p.name!)
        if (p.json) out(JSON.stringify({ ok: true, principal: entry.name, tokenFile }))
        else out(`rotated ${entry.name}; the old token no longer works\ntoken file: ${tokenFile}`)
        return 0
      }
      case 'projects': {
        const entry = await setPrincipalProjects(dataDir, p.name!, projects)
        if (p.json) out(JSON.stringify({ ok: true, principal: entry.name, projects: entry.projects }))
        else out(`updated ${describe(entry)}`)
        return 0
      }
      case 'remove': {
        await removePrincipal(dataDir, p.name!)
        if (p.json) out(JSON.stringify({ ok: true, principal: p.name }))
        else out(`removed ${p.name}; its token no longer works (its nodes stay on the canvas)`)
        return 0
      }
      case 'list': {
        const list = await listPrincipals(dataDir)
        if (p.json)
          out(JSON.stringify({ ok: true, principals: list.map(({ tokenSha256: _h, ...rest }) => rest) }))
        else out(list.length ? list.map(describe).join('\n') : 'no integration principals')
        return 0
      }
    }
  } catch (e) {
    const code = e instanceof RegistryError ? e.code : 'E_FAILED'
    const message = e instanceof Error ? e.message : String(e)
    if (p.json) out(JSON.stringify({ ok: false, code, error: message }))
    err(message)
    return 1
  }
  return 2
}
