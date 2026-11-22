# Integration principals

An **integration principal** is a local program that drives agent sessions on a **Server Edition**
canvas without being a node itself. The motivating case is a poller: it watches an issue tracker,
opens one agent session per item, sends the session later updates, and closes it when the item is
finished. It must survive a server restart and a reboot of the machine.

Nothing here is specific to any tracker. nodeterm never interprets a principal's **key** (the
caller's own id for one item, such as `APP-1234` or `gh:owner/repo#567`).

Surfaces: **Server Edition only**, and only while canvas control is on
(`NODETERM_SERVER_CANVAS_CONTROL=1` / `--canvas-control`). On any other shell, or with canvas control
off, the route answers 404. The desktop is out of scope (its open path lives in the renderer).
Mobile: N/A. The canvas node, its kanban card and the card modal show a chip with the principal's
name (`sink`); its tooltip carries the full "via <label> · <key>".

## Why it is not a node

Canvas control is built around a *source node*. Every Server Edition verb needs the caller to be a
control-capable agent node in exactly one saved project (`sourceProject` + `sourceCanControl`). When
this was designed, everything it granted was process-local (fork patch #6 has since made the first
two durable for agents too):

| Fact | Lost on | Effect for an outside program |
|---|---|---|
| creator ledger (`createHeadlessNodeOwnership`) | server restart | every `send` / `close` → `*-not-owner` |
| pane ownership (`pane-ownership.ts`) | server restart with tmux alive | `send` → `unproven-target-owner` |
| restored queue's creator check | server restart | queued messages refused at flush |

A principal is therefore its own caller kind, with its own route, credential and **durable** ledger.

## Setup

```sh
# On the server host, as the server's user (no running server needed):
node out/server/main.cjs integration add sink --project ~/app_ms --label "Ticket sink"
#   registered sink  label="Ticket sink"  projects=project-mslxm1bv-5
#   token file: ~/.nodeterm-server/integration-tokens/sink
```

- `--project` takes a project entry id or the folder of an open local project (repeatable; the first
  is the default for `open`). SSH projects are refused.
- `--color` takes a system palette value (the frame and node colour).
- `rotate <name>` writes a new token; the old one stops working at once.
- `projects <name> --project …` replaces the project list.
- `remove <name>` unregisters (close its keys first; its nodes stay on the canvas).
- `list`, and `--json` on every command.

The CLI writes `<dataDir>/integrations.json` (0600) and `<dataDir>/integration-tokens/<name>` (0600 in
a 0700 dir) directly. The token is 32 random bytes; the registry stores only its SHA-256. The running
server re-reads the registry whenever it changes (size + mtime + inode), so registering needs no
restart. The CLI never prints a token; the principal's program reads the file.

## Transport

`POST` to the hook server, over its unix socket (`<dataDir>/sock/hook.sock`, the
`NODETERM_HOOK_SOCK` line of `<dataDir>/hook-endpoint.env`) or its loopback TCP port. Headers:

| Header | Value |
|---|---|
| `X-Nodeterm-Hook-Token` | the app bearer (`NODETERM_HOOK_TOKEN` in `hook-endpoint.env`) |
| `X-Nodeterm-Integration` | the principal name |
| `X-Nodeterm-Integration-Token` | the contents of the token file (trimmed) |
| `Content-Type` | `application/json` |
| `Host` | `localhost` (or `127.0.0.1`); never send an `Origin` header |

Read both credentials from their files and pass them in the request, never on a command line
(with curl: `curl --config -` fed by `printf`). Re-read `hook-endpoint.env` after any connection
error: a server restart writes a new bearer.

Every reply is JSON:

```ts
{ ok: true, result: <verb result> }
{ ok: false, error: string /* stable code */, message: string /* a sentence */ }
```

HTTP status: 200 success; 400 malformed input; 403 `unauthorized` (one flat refusal for a wrong name
or token); 404 `unknown-key` / `unknown-verb` / `integration-unavailable`; 409 a refused action; 500
`prompt-not-saved` / `comment-not-saved`; 503 `stopping` / `not-saved` (the server is shutting down).

## The verbs

### `POST /integration/open`

```ts
// request
{ key: string, agent: 'claude' | 'codex' | 'gemini',
  project?: string,   // a registered project id; default: the principal's first
  cwd?: string,       // absolute existing directory; default: the project's folder
  prompt?: string,    // ≤ 256 KiB; written to a file the launch reads, so newlines survive
  model?: string, group?: string /* frame title, ≤ 48 chars */, title?: string /* ≤ 120 */,
  column?: string /* an existing kanban column's title, ≤ 48 chars */,
  pulls?: number[] /* PR numbers in the board's GitHub repository, ≤ 20 (see "Declared pull requests") */ }
// result
{ key, nodeId, projectId, status: 'created' | 'existing',
  session?: 'started' | 'failed', reason?: string, frameId?: string,
  column?: string /* the column id, or 'missing'; only when `column` was asked and the node created */,
  pulls?: number[] /* only when `pulls` was sent: the key's declared set after this call */,
  pullsIgnored?: 'no-repository' /* `pulls` not recorded: the project has no GitHub repository */ }
```

An upsert by key: if the principal already has an open node for the key, it answers `existing` and
changes nothing but the declared `pulls` — it does not look at the session, so call `resume` when the daemon (re)starts. A key whose node a person removed opens a new node. `group` creates a frame with
that title on first use and puts later nodes into the same frame. The default title is
`<key> · <agent label>`. The node is written and the ledger row recorded **before** anything is
spawned.

`column` files the new session's kanban card at the **top** of the target project's existing column
with that title, matched case-insensitively (the `assign` verb's title rule). It never creates a
column: when no column has that title the node opens normally, its card stays in Ungrouped, and the
result says `column: 'missing'`. Create the columns by hand; a person-made column is never removed
automatically, so it stays even when its last card closes. An `existing` upsert does not move the
card and returns no `column`.

`pulls` is recorded for the key, also on an `existing` upsert, where it is UNIONED into the set
already declared (the only thing an `existing` upsert changes). A malformed list is 400 `bad-pull`
before anything opens; a union past 20 is 409 `too-many-pulls`. On a project with no GitHub
repository (no board repository and no GitHub git remote) `pulls` is ignored, never refused: the node
opens and the result says `pullsIgnored: 'no-repository'`.

`session: 'failed'` keeps the launch on the node for its Run now, with `reason`
(`no-shell`, `line-too-long`, `spawn-failed`, …).

### `POST /integration/resume`

```ts
{ key: string }
// result
{ key, nodeId, outcome: 'attached' | 'resumed' | 'started-fresh' | 'already-running', reason?: string }
```

Idempotent; call it for every open key whenever the daemon starts.

- **Session running, and this server holds it**: `already-running`.
- **Session running after a server restart**: the server reattaches its client (so the 6 h
  detached-session reaper cannot cull it) and **re-proves the pane** only if tmux's
  `#{session_created}` stamp equals the one recorded at this server's fresh spawn. A pane's shell
  cannot change that stamp; a session killed and recreated under the same name carries a new one.
  Mismatch or no recorded stamp: refused `session-replaced` (409); close the key and open it again.
- **Session running but the agent exited** (an OOM kill, a crash, a typed `/exit`: a bare shell owns
  the pane): after the checks above, the agent is relaunched in that same session on its
  conversation, `resumed` / `started-fresh` with `reason: 'agent-exited'` (or `transcript-missing`).
  An unreadable pane is never typed into.
- **Session gone (reboot, reaped)**: the agent is restarted on its conversation
  (`claude --resume <id>`, codex/gemini likewise when an id is known): `resumed`. When claude reports
  that transcript definitely gone, or no id is known, a fresh agent starts with a new id:
  `started-fresh` with `reason: 'transcript-missing' | 'no-session-id'`. A fresh spawn proves the
  pane by itself.
- Refusals (409): `node-missing` (a person removed it; the key is closed), `session-unreadable`
  (tmux could not be asked; retry later), `session-replaced`, `attach-failed`, `launch-failed`.

The server never resumes anything by itself at boot. It never types into a pane unless a caller asks.

### `POST /integration/send`

```ts
{ key: string, text: string /* ≤ 32 KiB */, queue?: boolean /* default true */, ttlMs?: number }
// result (always ok: true once the message reached the messaging layer)
{ key, nodeId, sendId, outcome: string, accepted: boolean,
  traceId?: string, message: string, retryAfterMs?: number, reason?: string }
```

It runs the same delivery path as an agent's `send`: pane probes, envelope, receipt, deliver-on-idle
queue and trace. The envelope reads `from: integration <label>` and
`reply-to: none (an external integration; …)`. Control characters are stripped from `text`.
The per-project agent-messaging switch does **not** apply: registering the principal for the project
is that consent. `ttlMs` is clamped to 1 s … 24 h (default 5 min).

| Target state | `outcome` | `accepted` | What to do |
|---|---|---|---|
| idle (`done`) | `delivered` (turn started) or `stalled` (pasted, no turn seen) | true | done; **never resend `stalled`** (it may sit in the composer) |
| working | `queued` (flushed on the next verified `done`) | true | watch the outbox for `sendId` |
| waiting / blocked (a dialog) | `queued`; waits for a person to answer | true | do not resend; `list` shows `needsYou` |
| not started yet | `queued` (long TTL) | true | `resume` |
| no session | `targetGone` | false | `resume`, then send again |
| pane unproven after a restart | `notPermitted`, `reason: 'unproven-target-owner'` | false | `resume`, then send again |
| node removed by a person | 404 `unknown-key` | — | treat the item as cancelled |
| over budget (one per 10 s per node) | `rateLimited`, `retryAfterMs` | false | retry after |
| `queue: false` and busy | `targetBusy` | false | retry on your own schedule |

### `POST /integration/close`

```ts
{ key: string }
// result
{ key, nodeId, closed: true, nodeMissing?: true }
```

Ends the session and removes the node, and its frame when that frame is now empty and was created by
this principal. The key is closed; a later `open` with the same key makes a new node.

### `POST /integration/comment`

```ts
{ key: string, text: string /* plain markdown, ≤ 64 KiB */ }
// result
{ key, nodeId, commentId }
```

Appends one comment to the project's kanban board log on the card of the key's node: the same
`kind: 'comment'` entry a person's card comment writes, with `author.name` = the principal's label
(e.g. "Ticket sink") and `author.color` = its colour (grey when none). `commentId` is the entry's id.
Use it for notes a person should see on the card, such as PR and ticket links.

- **Display only.** The comment is never delivered into the session. A board comment reaches an
  agent only when a person sends it from the composer; nothing that reads the log types into a pane.
  A mention token (`@[label](node:<id>)`) in the text is flattened to plain `@label` as well.
  Use `send` to tell the agent something.
- Control characters (except newline and tab) and bidi overrides are removed; text over 16 KiB
  (`BOARD_LOG_TEXT_MAX`) is cut to it with a trailing `…`.
- Errors: 400 `bad-key` / `bad-text` (not a string, over 64 KiB, or empty once cleaned); 404
  `unknown-key` (never opened, closed, or removed from the canvas); 409 `board-log-unavailable` (the
  project has no local folder to keep `.nodeterm/board-log.jsonl` in); 500 `comment-not-saved` (the
  write failed; nothing was posted).

### `POST /integration/link-pull` and `POST /integration/unlink-pull`

```ts
{ key: string, pull: number /* a PR number in the board's GitHub repository */ }
// result
{ key, nodeId, pulls: number[] /* the key's declared set after the call, ascending */ }
```

Add or remove one declared pull request on the key's card. Both are idempotent: linking a PR already
declared, or unlinking one that is not, answers the current set and changes nothing.

- Errors: 400 `bad-key` / `bad-pull` (not a positive integer ≤ 2³¹−1); 404 `unknown-key`; 409
  `no-repository` (no board repository and no GitHub git remote); 409 `too-many-pulls` (a key
  declares at most 20).

### Declared pull requests

A card's pull requests come from three sources, and the card shows their union:

1. **Branch**: the card sits in a worktree group and a PR's head branch is that group's branch.
2. **Issue**: the session was started on a GitHub issue that the PR closes.
3. **Declared**: a principal said so (`open.pulls`, `link-pull`). A fork's PR counts too.

Declared links render exactly like the other two: the `PR #N` chip on the kanban card and a row in
the card modal's "Pull requests" section, with the same CI and merge state.

- **The ledger is the authority.** The set lives on the key's row in `integration-nodes.json`, next to
  the key → node mapping, so it survives a server restart and a reboot. It is never written to or read
  from `project.json`.
- **Closing the key drops its links.** A reopened key starts empty; declare again.
- **A person's unlink wins.** Unlinking the PR in the card modal writes the board's tombstone; the
  card stops showing it while the declaration stays in the ledger. "Link again" in the modal brings it
  back. `unlink-pull` removes the declaration itself.
- **One repository.** The numbers are recorded against the board's repository at declare time. If
  the board is later pointed at another repository, the old set is not shown, and the next
  `link-pull` starts a new set. `list` still shows the stored numbers.
- **Old PRs get their state.** The board's status read covers the 50 most recently updated open PRs
  and the 30 most recently finished ones. A declared PR outside that window is read on its own, one PR
  per request, in the same pass (at most 10 per pass, on the same `graphql` budget, which a background
  read leaves a floor of). A finished PR is read once; a number that is not a PR is not asked again
  for an hour. The first read after `link-pull` starts at once when a board for the project is open;
  otherwise the PR is read when one opens.
- **The board does not need GitHub sync.** On a board that is not connected to GitHub (or not approved
  on this machine) the declared PRs are the only PRs read: one GraphQL request per declared PR, at most
  once a minute per project and only while the board is open in a browser. No GitHub lane appears and
  the repository's issues and PR list are never read. The repository is the project's git remote, and
  the server uses its GitHub sign-in (the gh CLI). Registering the principal for the project is the
  consent for these reads. On such a board the PR's state is kept in memory only, and auto-move on
  merge does not run (it needs a synced board's column settings).
- **Auto-move on merge** (synced boards) treats declared links like the others. It is off unless this machine turned
  it on, and a card moves only for a merge this machine observed after it saw the PR open on that
  card: a PR declared after it merged never moves the card.

### `POST /integration/list`

```ts
{ key?: string, includeClosed?: boolean, outboxSince?: number /* ms epoch */ }
// result
{ rows: Array<{
    key, nodeId, projectId, agent, agentSessionId?, state: 'open' | 'closed', createdAt, closedAt?,
    nodeMissing?: true,                       // open row whose node a person removed
    session?: 'live' | 'absent' | 'unknown',  // open rows on the canvas
    attached?: boolean,                       // this server holds a client (not reaper-eligible)
    paneProven?: boolean,                     // send can reach it
    agentState?: string,                      // working | waiting | blocked | done | unknown
    needsYou?: boolean,                       // a dialog waits on a person
    lastTurnError?: boolean,
    pulls?: number[] }>,                      // open rows: the declared pull requests
  outbox: Array<{ sendId, key, nodeId, outcome: string, at: number }> }
```

The **outbox** is how a queued `send` reports its end: `delivered`, `stalled`, `expired`,
`targetGone`, `notPermitted`, … under the `sendId` the `send` reply returned. A principal has no pane
or board log to be told in, so it pulls. The outbox is bounded to 500 entries per principal for 7
days. Closed rows are kept 30 days.

## Granting a node to a principal

A principal can also work with an agent session it did NOT open (for example a `/ship` lane opened by
another node), but only when that node asks for it. The node grants ITSELF, with three canvas-control
verbs (Server Edition only; the desktop refuses them by name):

```sh
nodeterm.sh integration-grant  --principal sink --key LANE-1   # deliver events for LANE-1 to me
nodeterm.sh integration-revoke --principal sink --key LANE-1   # stop (only the node holding it)
nodeterm.sh integration-grants                                  # my grants
```

Replies (JSON with `Accept: application/json`, else one line of text):

```ts
// integration-grant
{ principal, key, nodeId /* the caller */, status: 'granted' | 'already-granted' | 'moved' }
// integration-revoke
{ principal, key, revoked: true }
// integration-grants
{ grants: Array<{ principal, key }> }
```

- **Who may grant:** a verified agent node, for itself only. There is no flag naming another node,
  and no principal-side verb that claims one. An unverified caller is refused (`Integration grant
  refused.`). The principal must be registered for the caller's project; an unknown principal and one
  registered elsewhere get the same refusal, `principal-not-registered`.
- **The latest grant wins:** granting a key that another node holds moves it here (`moved`); the
  previous grant closes, and the key's declared pull requests move with it.
- **Refusals:** `key-owned` (the principal opened a node for that key itself; it cannot be granted),
  `node-held` (this node already holds a grant, or was opened by a principal; revoke first),
  `not-your-grant` / `unknown-key` (revoke).
- **Durable:** the grant is a row in `integration-nodes.json` (`adopted: true`), so it survives a
  restart and a reboot. A node removed from the canvas closes it.

What the principal can do with an adopted row:

| Verb | On an adopted row |
|---|---|
| `send` | allowed: same delivery path, gates, queue, outbox and envelope. The pane must be proven like for any sender (`notPermitted` otherwise); no bypass |
| `comment`, `link-pull`, `unlink-pull` | allowed |
| `list` | listed with `adopted: true` (`agent` only when it is claude, codex or gemini) |
| `close` | ends the GRANT only: `{ key, nodeId, closed: true, adopted: true }`. The node and its session are untouched |
| `resume` | refused, 409 `adopted-node`: the principal never relaunches a node it did not open |
| `open` (same key) | answers `existing`; no spawn, no title or column change (declared `pulls` still union) |

A revoked or moved grant stops authorizing at once: a `send` queued before the revoke is refused when
the queue flushes, because the creator check reads the ledger again.

## Ownership and restarts

`<dataDir>/orchestration-state/integration-nodes.json` and `integration-outbox.json` (the
`core/durable-state.ts` files, 0600) hold principal → key → node (+ frames, the conversation id, the
tmux creation stamp) and the outbox. They survive a server restart and a reboot. The registry,
ledger and token live in the server's data dir, written by this process and the CLI only, keyed by
machine-local project ids. A cloned repository cannot write them. The node's `integration` marker in
`project.json` is display only and never read as authority.

Only the instance that owns the hook endpoint loads and writes the ledger (a second instance on the
same data dir stands down, like the other orchestration facts).

## What it does not do

- No boot adoption, no automatic resume, no polling on the principal's behalf.
- No worktrees. Create one yourself (`git worktree add`) and pass `cwd`.
- No `--after`, `link`, kanban `assign`, or agents beyond claude/codex/gemini. `comment` writes a
  note on the card; it does not move it. A declared PR link shows on the kanban card only, not on the
  canvas node's header.
- No station-failure notices to the principal; read `list` (`lastTurnError`, `needsYou`,
  `session: 'absent'`).
- The tmux creation stamp has one-second resolution. A session killed and recreated under the same
  name within the same second would pass the re-proof. That needs a same-uid process, which could
  read the token file anyway.
- A principal's frame grows as nodes are added; it can come to overlap a neighbour.

## Code map

| File | What |
|---|---|
| `src/shared/integration-principal.ts` | names, validators, wire types, the display marker |
| `src/core/integration/registry.ts` | registry file, token hash check, CLI write side |
| `src/core/integration/ledger.ts` | the durable ownership ledger and outbox |
| `src/core/agents/hook-server.ts` | the `/integration/` route |
| `src/core/agents/agent-messaging.ts` | `integration-message` delivery (scope, creator check, no switch) |
| `src/core/agents/pane-ownership.ts` | `recordReprovedOwner` (the one attach that may record) |
| `src/core/pty-manager.ts` | `sessionCreatedAt` (exact target) |
| `src/server/headless-node-factory.ts` | `principalOpen` / `principalResume` / `principalClose` |
| `src/server/integration-service.ts` | authentication, validation, the eight verbs |
| `src/core/github/service.ts` | `setDeclaredPulls`, `declaredPullsChanged`, `readPullBoard` (single-PR reads) |
| `src/shared/pull-card-links.ts` | `pullsForCard`: branch ∪ issue ∪ declared, tombstones win |
| `src/server/integration-cli.ts` | `main.cjs integration …` |
| `src/renderer/components/IntegrationChip.tsx` | the principal-name chip (full "via … · key" in its tooltip) |
