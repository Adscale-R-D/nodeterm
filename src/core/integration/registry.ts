// The registry of INTEGRATION PRINCIPALS (docs/integration-principal.md).
//
// `<dataDir>/integrations.json` (0600) lists who may use the `/integration/*` route, which projects
// each may place nodes in, and the SHA-256 of each one's token. The token itself is random (32
// bytes), written ONCE to `<dataDir>/integration-tokens/<name>` (0600 in a 0700 dir) for the
// principal's own program to read, and never stored here. So:
//   - revocation is removing the entry (or rotating it: a new token, the old hash gone);
//   - the server only ever READS this file, re-reading it when it changes (size + mtime + inode), so
//     the CLI that writes it needs no running server and no socket;
//   - the `settings` canvas-control verb cannot reach it: it is not settings.json.
//
// Trust boundary: anything running as the server's unix user can write this file — the same
// boundary `node-tokens/` and `node-auth-key.bin` already have. Not weaker, not stronger.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { promises as fs, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { writeFileAtomic } from '../fs-atomic'
import { isSafePrincipalLabel, isSafePrincipalName } from '../../shared/integration-principal'
import { SYSTEM_NODE_COLORS } from '../../shared/node-colors'

export const REGISTRY_FILE = 'integrations.json'
export const TOKEN_DIR = 'integration-tokens'
const MAX_PRINCIPALS = 32
const MAX_PROJECTS = 16
const MAX_REGISTRY_BYTES = 256 * 1024
const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SHA_RE = /^[0-9a-f]{64}$/

export interface PrincipalEntry {
  name: string
  label: string
  /** A system palette colour for the principal's nodes, or absent. */
  color?: string
  /** Machine-local project entry ids, in preference order. */
  projects: string[]
  tokenSha256: string
  createdAt: number
  rotatedAt?: number
}

export interface Registry {
  version: 1
  principals: PrincipalEntry[]
}

export const registryPath = (dataDir: string): string => join(dataDir, REGISTRY_FILE)
export const tokenDir = (dataDir: string): string => join(dataDir, TOKEN_DIR)
export const tokenPath = (dataDir: string, name: string): string => join(tokenDir(dataDir), name)

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex')
}

/** A new token: 32 random bytes, base64url. Opaque to everyone but the hash compare. */
export function newPrincipalToken(): string {
  return `ntp_${randomBytes(32).toString('base64url')}`
}

function sanitizeEntry(raw: unknown): PrincipalEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (!isSafePrincipalName(r.name)) return null
  if (typeof r.tokenSha256 !== 'string' || !SHA_RE.test(r.tokenSha256)) return null
  if (!Array.isArray(r.projects)) return null
  const projects = r.projects.filter((p): p is string => typeof p === 'string' && PROJECT_ID_RE.test(p))
  if (!projects.length || projects.length > MAX_PROJECTS) return null
  if (typeof r.createdAt !== 'number' || !Number.isFinite(r.createdAt)) return null
  const color =
    typeof r.color === 'string' && (SYSTEM_NODE_COLORS as readonly string[]).includes(r.color)
      ? r.color
      : undefined
  return {
    name: r.name,
    label: isSafePrincipalLabel(r.label) ? r.label : r.name,
    ...(color ? { color } : {}),
    projects: [...new Set(projects)],
    tokenSha256: r.tokenSha256,
    createdAt: r.createdAt,
    ...(typeof r.rotatedAt === 'number' && Number.isFinite(r.rotatedAt) ? { rotatedAt: r.rotatedAt } : {})
  }
}

/** Parse a registry document. Anything unreadable is an EMPTY registry (nobody is admitted). A
 *  duplicate name keeps its first entry. */
export function parseRegistry(text: string): Registry {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { version: 1, principals: [] }
  }
  const r = raw as { version?: unknown; principals?: unknown } | null
  if (!r || r.version !== 1 || !Array.isArray(r.principals)) return { version: 1, principals: [] }
  const out: PrincipalEntry[] = []
  const seen = new Set<string>()
  for (const e of r.principals.slice(0, MAX_PRINCIPALS)) {
    const entry = sanitizeEntry(e)
    if (!entry || seen.has(entry.name)) continue
    seen.add(entry.name)
    out.push(entry)
  }
  return { version: 1, principals: out }
}

/**
 * The server's read side. Re-reads the file only when its size, mtime or inode changed, so a
 * request costs one `stat`. A missing or unreadable file is an empty registry.
 */
export class PrincipalRegistryReader {
  private cached: Registry = { version: 1, principals: [] }
  private stamp = ''

  constructor(private readonly dataDir: string) {}

  current(): Registry {
    const path = registryPath(this.dataDir)
    let stamp: string
    try {
      const st = statSync(path)
      if (!st.isFile() || st.size > MAX_REGISTRY_BYTES) {
        this.cached = { version: 1, principals: [] }
        this.stamp = 'bad'
        return this.cached
      }
      stamp = `${st.size}:${st.mtimeMs}:${st.ino}`
    } catch {
      this.cached = { version: 1, principals: [] }
      this.stamp = ''
      return this.cached
    }
    if (stamp !== this.stamp) {
      try {
        this.cached = parseRegistry(readFileSync(path, 'utf8'))
      } catch {
        this.cached = { version: 1, principals: [] }
      }
      this.stamp = stamp
    }
    return this.cached
  }

  get(name: string): PrincipalEntry | undefined {
    return this.current().principals.find((p) => p.name === name)
  }

  /**
   * The ONE authentication answer: the named principal is registered AND the presented token hashes
   * to its stored hash. Constant-time on the hash. Any malformed input is a plain `undefined`.
   */
  authenticate(name: unknown, token: unknown): PrincipalEntry | undefined {
    if (!isSafePrincipalName(name)) return undefined
    if (typeof token !== 'string' || token.length < 16 || token.length > 256) return undefined
    const entry = this.get(name)
    if (!entry) return undefined
    const presented = Buffer.from(sha256Hex(token), 'hex')
    const stored = Buffer.from(entry.tokenSha256, 'hex')
    return presented.length === stored.length && timingSafeEqual(presented, stored) ? entry : undefined
  }
}

// ── The CLI's write side ────────────────────────────────────────────────────────────────────────

async function readForWrite(dataDir: string): Promise<Registry> {
  try {
    return parseRegistry(await fs.readFile(registryPath(dataDir), 'utf8'))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, principals: [] }
    throw e
  }
}

async function writeRegistry(dataDir: string, reg: Registry): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true })
  await writeFileAtomic(registryPath(dataDir), `${JSON.stringify(reg, null, 2)}\n`, { mode: 0o600 })
}

async function writeToken(dataDir: string, name: string, token: string): Promise<string> {
  const dir = tokenDir(dataDir)
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  await fs.chmod(dir, 0o700).catch(() => {})
  const path = tokenPath(dataDir, name)
  await writeFileAtomic(path, `${token}\n`, { mode: 0o600 })
  return path
}

export class RegistryError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

export interface AddPrincipalInput {
  name: string
  projects: string[]
  label?: string
  color?: string
  now?: number
}

/** Register a principal and write its token file. Refuses an existing name (use rotate). */
export async function addPrincipal(dataDir: string, input: AddPrincipalInput): Promise<{ entry: PrincipalEntry; tokenFile: string }> {
  if (!isSafePrincipalName(input.name))
    throw new RegistryError('E_BAD_NAME', 'a principal name is 1-32 characters of a-z, 0-9 and -, starting with a letter or digit')
  const projects = [...new Set(input.projects)]
  if (!projects.length) throw new RegistryError('E_NO_PROJECT', 'name at least one project (--project)')
  if (projects.length > MAX_PROJECTS || projects.some((p) => !PROJECT_ID_RE.test(p)))
    throw new RegistryError('E_BAD_PROJECT', 'a project is a project entry id from workspace.json')
  if (input.label !== undefined && !isSafePrincipalLabel(input.label))
    throw new RegistryError('E_BAD_LABEL', 'a label is one printable line of at most 48 characters')
  if (input.color !== undefined && !(SYSTEM_NODE_COLORS as readonly string[]).includes(input.color))
    throw new RegistryError('E_BAD_COLOR', `a colour is one of ${SYSTEM_NODE_COLORS.join(', ')}`)
  const reg = await readForWrite(dataDir)
  if (reg.principals.some((p) => p.name === input.name))
    throw new RegistryError('E_EXISTS', `principal ${input.name} already exists (use rotate for a new token)`)
  if (reg.principals.length >= MAX_PRINCIPALS) throw new RegistryError('E_FULL', 'too many principals')
  const token = newPrincipalToken()
  const entry: PrincipalEntry = {
    name: input.name,
    label: input.label ?? input.name,
    ...(input.color ? { color: input.color } : {}),
    projects,
    tokenSha256: sha256Hex(token),
    createdAt: input.now ?? Date.now()
  }
  // Token file first: a registry entry whose token nobody has is useless but harmless; a token file
  // with no entry is refused at the route. Either order fails safe; this one leaves no dead entry.
  const tokenFile = await writeToken(dataDir, input.name, token)
  await writeRegistry(dataDir, { version: 1, principals: [...reg.principals, entry] })
  return { entry, tokenFile }
}

/** A new token for a principal; the old one stops working at once. */
export async function rotatePrincipal(dataDir: string, name: string, now = Date.now()): Promise<{ entry: PrincipalEntry; tokenFile: string }> {
  const reg = await readForWrite(dataDir)
  const i = reg.principals.findIndex((p) => p.name === name)
  if (i < 0) throw new RegistryError('E_UNKNOWN', `no principal named ${name}`)
  const token = newPrincipalToken()
  const entry = { ...reg.principals[i], tokenSha256: sha256Hex(token), rotatedAt: now }
  const principals = reg.principals.slice()
  principals[i] = entry
  // Registry first here: the old token must stop working even if the token write then fails.
  await writeRegistry(dataDir, { version: 1, principals })
  const tokenFile = await writeToken(dataDir, name, token)
  return { entry, tokenFile }
}

/** Remove a principal and its token file. Its nodes stay on the canvas (close them first). */
export async function removePrincipal(dataDir: string, name: string): Promise<void> {
  const reg = await readForWrite(dataDir)
  if (!reg.principals.some((p) => p.name === name)) throw new RegistryError('E_UNKNOWN', `no principal named ${name}`)
  await writeRegistry(dataDir, { version: 1, principals: reg.principals.filter((p) => p.name !== name) })
  await fs.rm(tokenPath(dataDir, name), { force: true })
}

export async function listPrincipals(dataDir: string): Promise<PrincipalEntry[]> {
  return (await readForWrite(dataDir)).principals
}

/** Change a principal's projects (the order is the default-project preference). */
export async function setPrincipalProjects(dataDir: string, name: string, projects: string[]): Promise<PrincipalEntry> {
  const unique = [...new Set(projects)]
  if (!unique.length || unique.length > MAX_PROJECTS || unique.some((p) => !PROJECT_ID_RE.test(p)))
    throw new RegistryError('E_BAD_PROJECT', 'name 1-16 project entry ids')
  const reg = await readForWrite(dataDir)
  const i = reg.principals.findIndex((p) => p.name === name)
  if (i < 0) throw new RegistryError('E_UNKNOWN', `no principal named ${name}`)
  const principals = reg.principals.slice()
  principals[i] = { ...principals[i], projects: unique }
  await writeRegistry(dataDir, { version: 1, principals })
  return principals[i]
}
