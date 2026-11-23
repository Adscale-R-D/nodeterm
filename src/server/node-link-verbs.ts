// A session declares the pull requests and Jira tickets it works on, on its OWN kanban card, through
// the canvas-control shim (docs/integration-principal.md, "Links a session declares itself"):
//
//   link-pr --pull <n>            unlink-pr --pull <n>
//   link-jira --ticket <KEY> [--site <https origin>] [--status <s>] [--category todo|in-progress|done]
//             [--summary <s>]     unlink-jira --ticket <KEY>
//   links
//
// The same two link kinds an integration principal declares on its keys, stored per NODE
// (src/core/integration/node-links.ts) and shown the same way: PRs through the pull board's
// `declared` source, tickets through the `integration-jira` channel. The caller is the only card a
// verb can touch (verified-only at the hook server). Server Edition only.
import { canControlCanvas } from '../shared/agents/config'
import { INTEGRATION_PULLS_MAX, isDeclarablePull, type NodeLinkVerb } from '../shared/integration-principal'
import {
  INTEGRATION_JIRA_MAX,
  JIRA_CATEGORIES,
  parseJiraKey,
  parseJiraTicketInput,
  type JiraTicketLink
} from '../shared/integration-jira'
import type { NodeLinkStore } from '../core/integration/node-links'
import type { ServerControlReply } from './headless-node-factory'

export { NODE_LINK_VERBS, type NodeLinkVerb } from '../shared/integration-principal'

export interface NodeLinkVerbDeps {
  store: NodeLinkStore
  /** Every project holding the node, with the node's agent as that project recorded it. */
  placements(nodeId: string): Array<{ projectId: string; agentId?: string }>
  agentIdOf?(nodeId: string): string | undefined
  /** The GitHub repository PR numbers are recorded against (the board's, else the git remote). */
  boardRepository(projectId: string): Promise<{ repository: string } | { refused: 'no-repository' }>
  /** The Jira site a `link-jira` without `--site` uses: the newest one any declared ticket names. */
  defaultJiraSite(): string | undefined
  /** What integration principals declared on this card (shown by `links`, read-only). */
  principalLinks(nodeId: string, projectId: string): { pulls: number[]; jira: JiraTicketLink[] }
  /** Is the node still on its project's canvas (`prune`)? */
  isLive(nodeId: string, projectId: string): boolean
  onPullsChanged?(projectId: string): void
}

const refuse = (error: string, message: string): ServerControlReply => ({ ok: false, error, message })

const ticketLine = (t: JiraTicketLink): string =>
  [t.key, t.status ? `(${t.status})` : '', t.summary ? `— ${t.summary}` : ''].filter(Boolean).join(' ')

export function createNodeLinkVerbHandler(deps: NodeLinkVerbDeps): (
  verb: NodeLinkVerb,
  nodeId: string,
  args: Record<string, string>
) => Promise<ServerControlReply> {
  const caller = (verb: string, nodeId: string): { projectId: string } | ServerControlReply => {
    const places = deps.placements(nodeId)
    if (places.length !== 1) {
      return refuse(
        `${verb}-no-project`,
        places.length ? 'this node is in more than one project, so its card cannot be named' : 'this node is not on a saved canvas'
      )
    }
    const agentId = places[0].agentId || deps.agentIdOf?.(nodeId)
    if (!agentId || !canControlCanvas(agentId)) return refuse(`${verb}-not-agent`, 'only an agent node can link to its card')
    return { projectId: places[0].projectId }
  }

  const repositoryOf = async (projectId: string): Promise<string | undefined> => {
    try {
      const r = await deps.boardRepository(projectId)
      return 'repository' in r && typeof r.repository === 'string' && r.repository ? r.repository : undefined
    } catch {
      return undefined
    }
  }

  return async (verb, nodeId, args) => {
    const who = caller(verb, nodeId)
    if ('ok' in who) return who
    const projectId = who.projectId
    deps.store.prune(deps.isLive)

    if (verb === 'links') {
      const repository = await repositoryOf(projectId)
      const own = {
        pulls: repository ? deps.store.declaredPulls(nodeId, projectId, repository) : [],
        jira: deps.store.declaredJira(nodeId, projectId)
      }
      const fromIntegrations = deps.principalLinks(nodeId, projectId)
      const lines = [
        `pull requests: ${own.pulls.length ? own.pulls.map((n) => `#${n}`).join(', ') : 'none'}`,
        `jira: ${own.jira.length ? own.jira.map(ticketLine).join('; ') : 'none'}`
      ]
      if (fromIntegrations.pulls.length || fromIntegrations.jira.length) {
        lines.push(
          'declared by an integration (not yours to unlink): ' +
            [...fromIntegrations.pulls.map((n) => `#${n}`), ...fromIntegrations.jira.map((t) => t.key)].join(', ')
        )
      }
      return { ok: true, message: lines.join('\n'), result: { ...own, ...(repository ? { repository } : {}), integrations: fromIntegrations } }
    }

    if (verb === 'link-pr' || verb === 'unlink-pr') {
      const pull = /^#?\d{1,10}$/.test(args.pull ?? '') ? Number(args.pull.replace('#', '')) : NaN
      if (!isDeclarablePull(pull)) return refuse(`${verb}-bad-pull`, `--pull: a pull request number, e.g. --pull 1045`)
      const repository = await repositoryOf(projectId)
      if (!repository) {
        return refuse(`${verb}-no-repository`, "this project has no GitHub repository (no board repository and no GitHub git remote) to link pull requests in")
      }
      if (verb === 'link-pr') {
        const r = deps.store.linkPull(nodeId, projectId, repository, pull)
        if (r === 'too-many') return refuse('link-pr-too-many', `a card declares at most ${INTEGRATION_PULLS_MAX} pull requests; unlink some first`)
        if (r.changed) deps.onPullsChanged?.(projectId)
        return { ok: true, message: `${r.changed ? 'linked' : 'already linked'} PR #${pull} (${repository}) to this card`, result: { pulls: r.pulls, repository } }
      }
      const r = deps.store.unlinkPull(nodeId, projectId, repository, pull)
      if (r.changed) deps.onPullsChanged?.(projectId)
      return { ok: true, message: `${r.changed ? 'unlinked' : 'was not linked:'} PR #${pull}`, result: { pulls: r.pulls, repository } }
    }

    // link-jira / unlink-jira
    const key = parseJiraKey(args.ticket)
    if (!key) return refuse(`${verb}-bad-ticket`, '--ticket: a Jira ticket key, e.g. --ticket A3-6926')
    if (verb === 'unlink-jira') {
      const r = deps.store.unlinkJira(nodeId, projectId, key)
      return { ok: true, message: `${r.changed ? 'unlinked' : 'was not linked:'} ${key}`, result: { jira: r.jira } }
    }
    const site = args.site ?? deps.defaultJiraSite()
    if (!site) {
      return refuse('link-jira-no-site', '--site: the Jira site, e.g. --site https://<your>.atlassian.net (no ticket on this server names one yet)')
    }
    if (args.category !== undefined && !(JIRA_CATEGORIES as readonly string[]).includes(args.category)) {
      return refuse('link-jira-bad-category', `--category: one of ${JIRA_CATEGORIES.join(', ')}`)
    }
    const ticket = parseJiraTicketInput({
      key,
      site,
      ...(args.status !== undefined ? { status: args.status } : {}),
      ...(args.category !== undefined ? { category: args.category } : {}),
      ...(args.summary !== undefined ? { summary: args.summary } : {})
    })
    if (!ticket) return refuse('link-jira-bad-site', '--site: an https origin with no path, e.g. https://<your>.atlassian.net')
    const r = deps.store.linkJira(nodeId, projectId, ticket)
    if (r === 'too-many') return refuse('link-jira-too-many', `a card declares at most ${INTEGRATION_JIRA_MAX} Jira tickets; unlink some first`)
    return { ok: true, message: `${r.changed ? 'linked' : 'already linked'} ${key} to this card`, result: { jira: r.jira } }
  }
}
