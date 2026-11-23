/**
 * The Jira tickets integration principals declared on kanban cards — a MIRROR of the host's list
 * (src/core/integration/ledger.ts `jiraLinks`), replaced whole on every push, never edited here.
 * Keyed by node id; an entry carries its project, because one node id can sit in two projects (a
 * team tab and the SSH project it was shared from).
 */
import { create } from 'zustand'
import type { JiraCardLinks } from '@shared/integration-jira'

interface IntegrationJiraStore {
  byNode: Record<string, JiraCardLinks[]>
  setLinks(links: readonly JiraCardLinks[]): void
}

export const useIntegrationJira = create<IntegrationJiraStore>((set) => ({
  byNode: Object.create(null) as Record<string, JiraCardLinks[]>,
  setLinks: (links) => {
    // No prototype: `__proto__` passes the node-id charset.
    const byNode = Object.create(null) as Record<string, JiraCardLinks[]>
    for (const l of links) (byNode[l.nodeId] ??= []).push(l)
    set({ byNode })
  }
}))

/** A card's declared tickets: the entry for its project when known, else the node's first. */
export function jiraLinksFor(
  byNode: Record<string, JiraCardLinks[]>,
  nodeId: string,
  projectId?: string
): JiraCardLinks | undefined {
  const entries = byNode[nodeId]
  if (!entries?.length) return undefined
  return (projectId ? entries.find((e) => e.projectId === projectId) : undefined) ?? entries[0]
}
