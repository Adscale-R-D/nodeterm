# nodeterm fork — status & change log for an orchestrating agent

**Audience: the agent/manager coordinating work on this box.** It answers three questions —
*what can I do now that I could not before*, *what is actually running*, and *what is known-broken
so I do not chase it*. Written 2026-09-02.

Keep this file in `docs/fork/` (a path upstream will never create, so it does not conflict on a
sync). It is fork-local operational state, not upstream documentation.

---

## 1. What this repo is

| | |
|---|---|
| This checkout | `~/nodeterm` = **`Adscale-R-D/nodeterm`** (our fork), branch `main` |
| Upstream | **`eneskirca/nodeterm`**, remote `upstream` |
| Fork `main` | `6c9564d9` — a merge of upstream `1cd41bd5`, **0 commits behind upstream** |
| What runs the server | a **second checkout**, `~/.nodeterm-server-app`, systemd `nodeterm-server` |

The fork carries **5 patches upstream does not have** (§4). Everything else is upstream's.

---

## 2. NEW CAPABILITIES FOR AN AGENT (read this part)

### 2.1 Canvas control now works on this host at all

This box runs the **Server Edition** (headless Linux + browser UI). Canvas control was refused by
name on that edition until 2026-08-17; it now runs the same code path as the desktop. A session
spawned by nodeterm can create and organise nodes:

```sh
sh ~/.nodeterm-server/canvas-control/nodeterm.sh <verb> [flags]
```

Verbs: `list open-terminal open-claude open-agent show-image show-video show-web open-browser group
ungroup move arrange align link verify spawn-team open-worktree close-worktree branch rename write
close board assign send reply notify sticky` (plus `browser` / `open-project`, refused here — §5).

Two conditions, both of which produce a *named* refusal rather than silence:

- **A browser tab must be attached.** The canvas is React Flow in a renderer, so with no tab open
  there is nothing to act on: `control-no-ui-attached`, which says **retryable** and names the fix.
  Do not treat it as permanent. (Zero tabs is the normal state of a headless host — agent tmux
  sessions outlive every browser.)
- The session must be **nodeterm-spawned** (`NODETERM_CANVAS_CONTROL` in its env). A Claude started
  from a plain SSH shell *sees the skill* but the CLI refuses: `not a nodeterm agent node`. This is
  deliberate — it keeps the CLI inert in ordinary terminals.

### 2.2 New verb flags (this sync, 2026-09-02)

- **`--dry-run`** — validates a spawn call and performs nothing. Applies to exactly
  `open-terminal`, `open-claude`, `open-agent`, `spawn-team`, `open-worktree`; every other verb
  refuses it. **Use it before any fan-out**: it resolves ids against the live canvas, parses the
  team JSON role by role and computes the worktree path, then reports what *would* happen. These
  verbs are cheap to call and expensive to undo.
- **`--prompt-file <path>`** — carries a multi-line brief. The `--prompt` flag is single-line; use
  this for anything with newlines instead of trying to escape them.
- **`--model <id>`** on the open verbs, and a per-role `model` in `spawn-team`'s JSON.
- **`open-worktree --base <station id>`** — base a new worktree on another station's branch.
- **`help`** — prints the verb list, **answered by the shim itself**, so it works even when the app
  is down. Cheapest way to confirm the CLI is reachable.
- **`rename`** to the title a node already has is now a no-op replying `already named` — safe to
  re-assert your own name as often as you like.

### 2.3 Confirm-dialog replies now distinguish two outcomes

`write` and `close` ask the human. Read *which* answer came back:

- `denied by user` — a decision, **final, never re-ask**.
- `no answer within 120s — the confirmation dialog may still be open; safe to retry` — nobody
  reached the dialog. **Worth one retry when the user is back.**

The old wording collapsed both into "timed out (no response / not confirmed)", and agents read it
as a refusal and gave up.

### 2.4 Agent-to-agent messaging works here (but is OFF by default)

`send` / `reply` / `notify` deliver into another agent node's tmux pane. Wired on this edition
2026-08-17. **The gate chain is unchanged**, and you will hit it in this order:

1. `notPermitted (switch-off)` — the **per-project** switch is off. It is Settings → Agents, *per
   project*, and only a human can flip it. **There is no global switch and no agent-facing way to
   enable it.**
2. `notPermitted (unproven-target-owner)` — the target pane was not freshly spawned in this server
   run (e.g. the server restarted). Re-open the target node.
3. Rate limits: one message per sender→target pair per 10 s, max 4 deliveries per turn.

**Until a human enables the switch, coordinate by PULL, not push:** every session you open is
context-linked to you, so read its transcript with the **`get-linked-context`** skill, and use
`--after <id>` to start a node when an upstream session goes idle. That is the intended design —
links are pull-based, nothing is lost.

### 2.5 `verify` (review panels)

- Works on this edition (it needs `contextLink.info`, which was fixed 2026-08-17).
- Reviewers run in **the target's directory**: its own cwd, else the worktree of the frame it sits
  in. Pass **`--cwd`** when the target has neither — a node opened without an explicit cwd stores
  none, and reviewers would otherwise land in the project root and review the wrong tree.

### 2.6 Closing a frame closes its contents

`close --node <groupId>` now closes the frame **and every node inside it, to any depth** — so a
`spawn-team` or `verify` panel is torn down in one call. Use `ungroup` when you want the frame gone
but the work kept. The confirm dialog names how many sessions that ends.

### 2.7 Armed (`--after`) nodes are fixed

An armed node used to die at startup with `claude --resume <uuid>` → "No conversation found",
because it resumed a session its held launch had not created yet. Fixed upstream; armed nodes now
wait properly and start on a PTY-ready signal, with a retry ledger behind delivery.

### 2.8 Triggers — new subsystem, NOT agent-drivable

A host-side scheduler (booted by both shells) with a TriggerNode UI, consent, run-now and run
history. **There is no control verb for it** — an agent cannot create or arm a trigger. Mentioned
so you do not go looking for one.

---

## 3. Other upstream changes worth knowing (2026-08-27 → 2026-09-02, 367 commits)

- **Session pause** — a session can be paused so it does not auto-resume on reopen.
- **Eco/hibernation is phone-compatible** — SLEEPING on the mirror, wake on relay attach, phone
  viewers count as watched.
- **Kanban PR cards** (read-only) alongside issue cards.
- Per-account default node colours; closed-session history in the sessions sidebar; folder
  drag-drop; a searchable language picker; wheel-vs-trackpad zoom routed by real gesture facts.
- Codex: native `SubagentStart`/`SubagentStop` subagent visualisation.
- 3 Windows fixes; Windows ships as an unsigned beta.

From the previous sync (2026-08-27, 485 commits), in case it was missed: the whole `browser` drive
set (desktop-only), Codex multi-account support, a remappable keybindings registry, breadcrumb
camera navigation, focus mode / node maximize / tidy canvas / layout zones.

---

## 4. What the fork adds on top of upstream (5 patches)

| Patch | Why it matters here |
|---|---|
| Canvas control on the Server Edition | without it, no verb works on this box at all |
| Agent messaging on the Server Edition | `send`/`reply`/`notify` exist here (still switch-gated) |
| `contextLink.info` over the browser bridge | makes `verify` and the codex/gemini discovery note work |
| Group `×` closes its children | one-call teardown of a panel/team |
| Claude window = 200k unless `[1m]` | the context meter under-reported pressure **5×** on 200k sessions |

A sixth patch (the armed-node fix) was **dropped in this sync** because upstream fixed the same bug
independently and better-integrated. Nothing regressed; theirs is in.

---

## 5. Known limits on THIS edition

| Thing | Status |
|---|---|
| `browser` verb (drive a page) | **permanently refused** — needs Electron `<webview>` + CDP |
| `open-project`, and any verb carrying `--project` | **refused** — the authorization (verified caller, path resolution, grant cap) lives in the desktop shell only |
| Agent messaging | works, but per-project switch is OFF by default (human-only) |
| Triggers | run, but no agent-facing surface |
| Dictation / speech | `smart-whisper` is not built here — reports "local whisper unavailable" |
| SSH projects, worktree ops on remote repos | desktop-only |

---

## 6. Deploy state — IMPORTANT

**`main` is ahead of what is running.**

| | commit |
|---|---|
| `main` (pushed) | `6c9564d9` |
| **Running server** | `25d444ab` (the 2026-08-27 sync) |

The 367-commit jump is **not deployed**. Deploying is a human call because it restarts the service.
Sequence (deps changed, so a plain rebuild is not enough):

```sh
cd ~/.nodeterm-server-app
export PATH="$HOME/.nodeterm-server-app/runtime/node/bin:$PATH"
git fetch origin main && git reset --hard origin/main
npm ci --ignore-scripts
node scripts/patch-node-pty.mjs      # NOT optional; now patches darwin fd-leak + Windows ConPTY
npm rebuild node-pty                 # Node's ABI — never `npm run rebuild` (that is electron-rebuild)
npm run build && npm run server:build
sudo systemctl restart nodeterm-server
```

Then **hard-reload the browser tab** (the renderer bundle changes on every deploy).

- Terminals survive a restart (`KillMode=process` — tmux keeps running).
- Rollback point: `~/nodeterm-deploy-rollback.txt`; same steps with the old commit, ~2 min.
- **Never run `scripts/install-server.sh` on this box.** As root it drops `User=`/`HOME=` (service
  runs as root, data dir moves to `/root`) and sets `NODETERM_HEADLESS=1`, which binds **no HTTP
  listener** — the browser UI disappears.
- New on the boot path this sync: `startTriggerService`. Unexercised here; worth watching the first
  boot.

---

## 7. Known-red tests (do not chase these)

All six reproduce on **`upstream/main` alone** — verified in a throwaway worktree, not assumed:

- `src/core/agents/hooks/opencode.test.ts` — 4 cases under "generated plugin behavior (executed)".
- `src/core/tmux-paste.realtmux.test.ts` — 1 environment-sensitive CONTROL case.
- `test/server/headless-e2e.test.ts` — pre-existing; touches the server boot path.

Everything else is green: **9801 passing**, both typechecks clean.

**This checkout's `node_modules` is real and patched** (`npm ci --ignore-scripts` +
`patch-node-pty.mjs` + `npm rebuild node-pty`). If `node-pty-patch.test.ts` goes red, the
`node_modules` is unpatched — not the code.

---

## 8. Syncing with upstream again

Upstream moves fast (485 commits in one week, then 367 in six days). The routine that works:

1. `git fetch upstream main` and compare — check whether upstream has independently fixed anything
   the fork patches. **It has, once.** Carrying a duplicate patch in a file upstream is reworking
   re-conflicts on every sync; drop ours when theirs is equivalent or better.
2. Trial-merge on a scratch branch to size conflicts before committing to the work.
3. **Never `git stash` across a branch switch during a merge** — it wipes `MERGE_HEAD`, and
   committing then produces a single-parent commit that makes every future sync re-conflict
   everything.
4. Before "keep ours" on any conflict, check whether upstream *improved* the thing our patch
   replaced (the timeout wording was exactly that trap).
5. Gate on both typechecks + the full suite, and verify any new failure against upstream alone in a
   worktree before blaming the merge.
