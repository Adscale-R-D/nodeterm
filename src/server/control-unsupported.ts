/**
 * The Server Edition's answer to `/control/*`: a NAMED, permanent refusal.
 *
 * `src/server/index.ts` starts the same hook server as the desktop but never calls
 * `setControlHandler`, so every control verb fell through to the null branch's
 * `{ ok: false, error: 'control unavailable' }` → HTTP 400. That sentence reads to a language model
 * exactly like a transient outage, **and a model retries an outage** — so an agent on a headless
 * host burned its turns re-sending a request that can never succeed, and the operator saw a stream
 * of 400s with nothing naming the cause.
 *
 * Registering a refusing handler rather than leaving the branch null is deliberate: the refusal
 * then travels the same reply shape as every other verb (JSON gets a machine-readable `error`, the
 * POSIX-sh shim gets one printable line), and nobody has to special-case "unavailable" downstream.
 *
 * Shared with the agent-messaging plan by agreement — one string, one mechanism, every verb.
 */

/** The machine-readable name. Structured clients key on this, never on the prose. */
export const CONTROL_UNSUPPORTED_ERROR = 'control-unsupported-on-this-edition'

/**
 * The prose, which must say the thing a retrying model needs to hear IN WORDS: the literal
 * "do not retry". A refusal that only a status code distinguishes from an outage is not a refusal
 * an agent can act on.
 *
 * IT NAMES THE VERB, and that stopped being cosmetic the day this edition gained real canvas
 * control. This used to read "Canvas control is not available on the nodeterm Server Edition",
 * which was true when EVERY verb was refused and became a lie the moment only a handful were: an
 * agent that asked for `send` was told the whole feature was missing, so it went looking for a
 * switch to turn on (Settings → Agents) and asked its user to check — for a setting that could not
 * have helped. Reported from a live session, within the hour. A per-verb refusal must scope its
 * claim to the verb, or it teaches the reader something false about everything else.
 */
export function controlUnsupportedSentence(verb: string): string {
  return (
    `The \`${verb}\` verb is not available on the nodeterm Server Edition (other canvas-control ` +
    'verbs work here). This is permanent on this host, not a temporary failure — do not retry.'
  )
}

/** The invariant tail, kept as a constant because it is what a caller may match on. */
export const CONTROL_UNSUPPORTED_SENTENCE =
  'This is permanent on this host, not a temporary failure — do not retry.'

/**
 * `browser` gets one extra clause naming WHY it is structural, so nobody files it as unimplemented
 * and nobody tries to implement it here. A browser node on this edition renders in the VIEWER's own
 * Chrome tab: there is no Electron, no `webContents`, no `<webview>` and no CDP on this host, and
 * the server has no debugger for a page in somebody else's browser and never can.
 */
export const BROWSER_UNSUPPORTED_CLAUSE =
  'There is no browser control on this edition: a browser node here renders in your own browser ' +
  'tab, which this server has no debugger for.'

/**
 * One line, always — control replies are rendered as a single line by the shim, and a multi-line
 * body buries whichever half the reader stops at. The machine name is repeated inside the prose so
 * the text/plain dialect (which carries no `error` field) still names the refusal.
 */
export function controlUnsupportedMessage(verb: string): string {
  return `${CONTROL_UNSUPPORTED_ERROR}: ${controlUnsupportedSentence(verb)}${unsupportedClause(verb)}`
}

/** The per-verb "why", empty for a verb that needs no elaboration. */
function unsupportedClause(verb: string): string {
  return verb === 'browser' ? ` ${BROWSER_UNSUPPORTED_CLAUSE}` : ''
}

/**
 * The permanent refusal, for a verb this edition genuinely cannot perform. Never resolves `ok: true`.
 *
 * It is no longer the answer to EVERY verb — the edition wires canvas control for real now
 * (`core/agents/canvas-control-bridge.ts`) — so this is what `withEditionRefusals` puts in front of
 * the bridge for the verbs below.
 */
export async function serverEditionControlHandler({ verb }: { verb: string }): Promise<{
  ok: false
  error: string
  message: string
}> {
  return { ok: false, error: CONTROL_UNSUPPORTED_ERROR, message: controlUnsupportedMessage(verb) }
}

/**
 * The verbs that stay permanently refused on this edition, even with a browser tab attached.
 *
 * WHY A SET IN FRONT OF THE BRIDGE, rather than letting these fall through to the browser and be
 * refused there: the bridge needs an attached UI to reach any refusal at all, and with zero tabs —
 * the normal state of a headless host — it answers its own no-UI message, which says *retryable*.
 * For a verb that can never work here that is a lie with a cost: the agent waits for a browser tab
 * that would not have helped. A permanent fact must not be reported behind a transient one.
 *
 *  - `browser` — structural, and the clause above says why: a browser node on this edition renders
 *    in the VIEWER's own Chrome tab. There is no `<webview>`, no `webContents` and no CDP on this
 *    host, so the server has no debugger for it and never can. (It is also not a verb this app has
 *    yet — `ControlVerb` lists 24 and the browser one is `open-browser`, which is deliberately NOT
 *    here: opening a surface is not driving one, and `open-browser` works fine in the browser.)
 * A verb LEAVES this set the day its dependency reaches core. That is the whole checklist, and it has
 * already been collected once: `send`/`reply`/`notify` were here because agent messaging lived in
 * `src/main/agent-messaging.ts` — and it turned out nothing in that module needed Electron (every
 * import was core/shared; its whole surface is an injected deps object). Only its WIRING sat in
 * main's boot. Both shells now boot it from `core/agents/agent-messaging-boot.ts`, so the three verbs
 * work here, under the same gates as the desktop: the per-project capability GRANT (off by default),
 * the runtime pane-ownership check, flow budgets, and hook-server's verified-only route.
 *
 * The lesson is the checklist's, not messaging's: before adding a verb here, check whether the
 * dependency is really Electron-bound or merely LIVES in `src/main`. Twice now it has been the latter.
 */
export const EDITION_UNSUPPORTED_VERBS: ReadonlySet<string> = new Set(['browser'])

/**
 * Wrap the real control bridge so the verbs above keep their permanent, named refusal and everything
 * else reaches the canvas. `handler` is `initCanvasControlBridge(...)`; the signature is structural
 * so this file stays free of the bridge (and of core) — it is vocabulary, not transport.
 */
export function withEditionRefusals<
  H extends (req: { verb: string; nodeId: string; args: Record<string, string> }) => Promise<unknown>
>(handler: H): H {
  return (async (req) =>
    EDITION_UNSUPPORTED_VERBS.has(req.verb)
      ? await serverEditionControlHandler(req)
      : await handler(req)) as H
}
