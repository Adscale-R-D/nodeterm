import { normalizeIntegrationMarker } from '@shared/integration-principal'

/**
 * "via <principal> · <key>" — the node was opened by an INTEGRATION PRINCIPAL
 * (docs/integration-principal.md), a local program that polls an outside system and opens one
 * session per item. Drawn by the canvas node header, the session's board card and its card modal
 * (one component, so the three views of one node cannot disagree). Display only: the value comes
 * from git-shared node data, so it is re-validated here and an invalid marker draws nothing — and
 * nothing anywhere reads it as authority (the server's integration ledger is the authority).
 */
export function IntegrationChip({ marker }: { marker: unknown }): React.JSX.Element | null {
  const m = normalizeIntegrationMarker(marker)
  if (!m) return null
  const who = m.label ?? m.name
  return (
    <span
      className="integration-chip nodrag"
      title={`Opened by the integration "${who}" for ${m.key}. It may send this session updates and close it.`}
    >
      via {who} · {m.key}
    </span>
  )
}
