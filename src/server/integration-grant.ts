// A NODE grants itself to an integration principal (docs/integration-principal.md, "Granting a node
// to a principal"): `integration-grant`, `integration-revoke`, `integration-grants` on the canvas-
// control shim. The consent is the node's own, proven by its verified node identity (the hook server
// and the Server Edition handler refuse an unverified caller before this runs). A principal can never
// claim a node: there is no principal-side verb for it, and the grant is always for the CALLER.
//
// What a grant gives the principal is the ledger row (`adopted: true`): `send`, `comment`,
// `link-pull` / `unlink-pull` and `list` work as on its own rows. `close` ends the grant only, and
// `resume` is refused — the node's lifecycle stays with whoever opened it.
import { canControlCanvas } from '../shared/agents/config'
import {
  INTEGRATION_AGENTS,
  isSafePrincipalKey,
  isSafePrincipalName,
  type IntegrationAgent
} from '../shared/integration-principal'
import { GRANTS_PER_NODE_MAX, type IntegrationLedger } from '../core/integration/ledger'
import type { PrincipalEntry } from '../core/integration/registry'
import type { ServerControlReply } from './headless-node-factory'

export { INTEGRATION_GRANT_VERBS, type IntegrationGrantVerb } from '../shared/integration-principal'
import type { IntegrationGrantVerb } from '../shared/integration-principal'

export interface IntegrationGrantDeps {
  registry: { get(name: string): PrincipalEntry | undefined }
  ledger: IntegrationLedger
  /** Every project holding the node, with the node's agent as that project recorded it. */
  placements(nodeId: string): Array<{ projectId: string; agentId?: string }>
  /** The node's running agent from its own hooks, when the project file names none. */
  agentIdOf?(nodeId: string): string | undefined
}

export interface IntegrationGrantResult {
  principal: string
  key: string
  nodeId: string
  status: 'granted' | 'already-granted' | 'moved'
}

const refuse = (error: string, message: string): ServerControlReply => ({ ok: false, error, message })

export function createIntegrationGrantHandler(deps: IntegrationGrantDeps): (
  verb: IntegrationGrantVerb,
  nodeId: string,
  args: Record<string, string>
) => ServerControlReply {
  /** The caller's one project and its agent, or a refusal. */
  const caller = (nodeId: string): { projectId: string; agentId?: string } | ServerControlReply => {
    const places = deps.placements(nodeId)
    if (places.length !== 1) {
      return refuse(
        'integration-grant-no-project',
        places.length ? 'this node is in more than one project, so the grant cannot name one' : 'this node is not on a saved canvas'
      )
    }
    const agentId = places[0].agentId || deps.agentIdOf?.(nodeId)
    if (!agentId || !canControlCanvas(agentId)) {
      return refuse('integration-grant-not-agent', 'only an agent node can grant itself to an integration')
    }
    return { projectId: places[0].projectId, agentId }
  }

  return (verb, nodeId, args) => {
    if (verb === 'integration-grants') {
      const grants = deps.ledger.grantsOf(nodeId).map((r) => ({ principal: r.principal, key: r.key }))
      const lines = grants.length
        ? grants.map((g) => `${g.principal}  ${g.key}`).join('\n')
        : 'no integration grants on this node'
      return { ok: true, message: lines, result: { grants } }
    }
    const principal = args.principal
    const key = args.key
    if (!isSafePrincipalName(principal)) {
      return refuse('integration-grant-bad-principal', '--principal: a registered integration name (a-z, 0-9, -)')
    }
    if (!isSafePrincipalKey(key)) {
      return refuse('integration-grant-bad-key', '--key: 1-64 characters of A-Z a-z 0-9 . _ : # / -, starting with a letter or digit')
    }
    const who = caller(nodeId)
    if ('ok' in who) return who

    if (verb === 'integration-revoke') {
      const r = deps.ledger.revokeGrant(principal, key, nodeId)
      if (r === 'unknown-key') return refuse('unknown-key', `no open grant of key ${key} to ${principal}`)
      if (r === 'not-yours') return refuse('not-your-grant', `key ${key} is granted by another node; only that node can revoke it`)
      return { ok: true, message: `revoked ${principal} ${key}`, result: { principal, key, revoked: true } }
    }

    // One refusal for "no such principal" and "not registered for your project": the caller learns
    // nothing about principals of other projects.
    const entry = deps.registry.get(principal)
    if (!entry || !entry.projects.includes(who.projectId)) {
      return refuse('principal-not-registered', `no integration named ${principal} is registered for this node's project`)
    }
    const agentId = (INTEGRATION_AGENTS as readonly string[]).includes(who.agentId ?? '')
      ? (who.agentId as IntegrationAgent)
      : undefined
    const status = deps.ledger.grant({ principal, key, nodeId, projectId: who.projectId, ...(agentId ? { agentId } : {}) })
    if (status === 'key-owned') {
      return refuse('key-owned', `key ${key} belongs to a node ${principal} opened itself; it cannot be granted to another node`)
    }
    if (status === 'node-held') {
      return refuse('node-held', 'this node was opened by an integration and already belongs to it')
    }
    if (status === 'too-many-grants') {
      return refuse('too-many-grants', `this node already holds ${GRANTS_PER_NODE_MAX} grants; revoke some first (integration-revoke)`)
    }
    const result: IntegrationGrantResult = { principal, key, nodeId, status }
    const said = status === 'moved' ? `moved ${principal} ${key} to this node` : `${status} ${principal} ${key}`
    return { ok: true, message: said, result }
  }
}
