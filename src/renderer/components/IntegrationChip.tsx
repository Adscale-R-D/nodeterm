import { normalizeIntegrationMarker, type IntegrationMarker } from '@shared/integration-principal'

/**
 * The node was opened by an INTEGRATION PRINCIPAL (docs/integration-principal.md), a local program
 * that polls an outside system and opens one session per item. Drawn by the canvas node header, the
 * session's board card and its card modal (one component, so the three views of one node cannot
 * disagree). Display only: the value comes from git-shared node data, so it is re-validated here and
 * an invalid marker draws nothing — and nothing anywhere reads it as authority (the server's
 * integration ledger is the authority).
 *
 * The chip shows only the principal's registered NAME (`sink`): a short `[a-z0-9-]` token, so it
 * never squeezes a card title onto two lines, and the key usually repeats the title anyway. The full
 * "via <label> · <key>" lives in the tooltip.
 */
export function integrationChipText(m: IntegrationMarker): { text: string; title: string } {
  const who = m.label ?? m.name
  return {
    text: m.name,
    title: `via ${who} · ${m.key}\nOpened by the integration "${who}" for ${m.key}. It may send this session updates and close it.`
  }
}

export function IntegrationChip({ marker }: { marker: unknown }): React.JSX.Element | null {
  const m = normalizeIntegrationMarker(marker)
  if (!m) return null
  const { text, title } = integrationChipText(m)
  return (
    <span className="integration-chip nodrag" title={title}>
      {text}
    </span>
  )
}
