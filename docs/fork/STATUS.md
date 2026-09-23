# nodeterm fork — status & change log for an orchestrating agent

**Audience: the agent/manager coordinating work on this box.** What you can do now that you could
not before, what is actually running, and what is known-broken so you do not chase it.

Written **2026-09-23**, replacing the 2026-09-02 edition wholesale — most of what that one
described has been retired (§4). Lives in `docs/fork/` (a path upstream never creates, so it adds
no conflict surface); fork-local operational state, not upstream documentation.

---

## 1. What this repo is

| | |
|---|---|
| This checkout | `~/nodeterm` = **`Adscale-R-D/nodeterm`** (our fork), branch `main` |
| Upstream | **`eneskirca/nodeterm`**, remote `upstream` |
| Fork `main` | `fabfeb45` — a merge of upstream `1e56e1c3` (v0.3.9), **0 behind upstream** |
| What runs the server | a **second checkout**, `~/.nodeterm-server-app`, systemd `nodeterm-server` |

The fork now carries **2 patches** upstream lacks (§4), down from 5.

---

## 2. THE BIG CHANGE: canvas control is headless now, and it is OFF unless enabled

Upstream rebuilt Server-Edition canvas control, and it replaced our implementation:

- **Before (our patch):** the server forwarded each verb to an **attached browser tab**, whose
  React Flow performed it. With no tab open you got `control-no-ui-attached` — the normal state of
  a headless host.
- **Now (upstream's):** `src/server/headless-node-factory.ts` creates and mutates nodes **directly
  against the WorkspaceStore** and publishes through `canvas-sync`, so attached tabs converge.
  **No browser tab is required.** Strictly better here.

### It is behind a flag, default OFF

```
NODETERM_SERVER_CANVAS_CONTROL=1        # or: --canvas-control
```

**This box has it ENABLED** via a systemd drop-in (§6). Upstream's own words on why it defaults
off: enabling it *"lets an agent session run arbitrary commands on this host as the user the server
runs as — `open-terminal --cmd <command>` is executed in a PTY this process spawns, with that
user's environment, files and credentials."* Hook auth, verified node identity and per-project
capability gates still decide **which** agent may ask, not **what** may be asked for.

If the verbs suddenly refuse with `control-unsupported-on-this-edition`, the flag is the first
thing to check — that is exactly what OFF looks like.

### The headless ownership rule — new, and it will surprise you

On the Server Edition, the node-mutating verbs (`close`, `link`, `group`, `rename`, `color`,
`sticky` update) accept **only nodes the caller opened during the current server run**, and refuse
the whole request before any partial mutation. A server restart resets that; nodes from a previous
run are not yours to mutate. Desktop is unchanged (it asks the user instead).

---

## 3. What an agent can do here

```sh
sh ~/.nodeterm-server/canvas-control/nodeterm.sh <verb> [flags]
sh ~/.nodeterm-server/canvas-control/nodeterm.sh help     # answered by the shim, works app-down
```

Still true from before: the session must be **nodeterm-spawned** (`NODETERM_CANVAS_CONTROL` in its
env). A Claude started from a plain SSH shell sees the skill but the CLI refuses — deliberate, so
the CLI stays inert in ordinary terminals.

**New/changed verb surface worth knowing:**

- **`close --node <id,id>`** takes a **comma list**, confirmed in ONE dialog. Close a finished wave
  in a single call — one call per node asked the user once per node and refused every call after
  the first while a dialog was open. An unknown id refuses the whole request and closes nothing.
- **`--dry-run`** on `open-terminal`/`open-claude`/`open-agent`/`spawn-team`/`open-worktree`:
  validates everything (ids against the live canvas, team JSON role by role, worktree path) and
  performs nothing. Use it before any fan-out.
- **`--prompt-file <path>`** for a multi-line brief (`--prompt` is single-line).
- **`--model <id>`** on the open verbs; per-role `model` in `spawn-team`.
- **`settings` verb** — allowlisted reads, and every change is user-confirmed. Notably
  `--set agentMessaging --value true` is how you *ask* for messaging instead of telling the human
  to go find a switch.
- **Waivable destructive confirms** + a **per-project "don't ask again"** that lasts, and
  **self-expiring dialogs** (`expired before the user answered` — a distinct outcome).
- **`--color` takes a name**, and the agent brand colors are in the node palette.
- **`rename`** to the name a node already has is a no-op replying `already named`.

**Confirm-dialog outcomes — read WHICH one came back:**

| Reply | Meaning |
|---|---|
| `denied by user` | a decision. **Final. Never re-ask.** |
| `no answer within 120s …safe to retry` | nobody reached the dialog. Worth one retry. |
| `expired before the user answered` | the dialog self-expired. Same as above. |

**Agent messaging** (`send`/`reply`/`notify`) is delivered **host-side** inside the canvas-control
runtime now. Gates in the order you will hit them: the per-project `agentMessaging` switch (ships
**off**, machine-local default) → caller must have spawned the target **this run** → rate limits
(one per sender→target pair per 10s, max 4 per turn). Until it is on, **coordinate by PULL**:
`get-linked-context` to read a linked session, `--after <id>` to start on an upstream's idle.

**`verify`** works. Reviewers run in the target's directory (its own cwd, else its frame's
worktree); pass **`--cwd`** when the target has neither, or they review the wrong tree.

---

## 4. What the fork still adds (2 patches, down from 5)

| Patch | Why it is still ours |
|---|---|
| **`contextLink.info` over the browser bridge** | upstream still stubs it `E_UNSUPPORTED`; without it `verify` cannot build a reviewer's brief |
| **Claude window = 200k unless `[1m]`** | upstream still uses the `opus\|sonnet\|fable` family rule, which under-reports context pressure **5×** on every 200k session |

Plus one UI keep: **the frame context menu's "close group and its nodes"** (`closeGroupWithChildren`
+ `groupSubtreeIds`). Upstream deleted the frame's `×` rather than implementing it, so this is the
only way to tear a `spawn-team`/`verify` panel down from the UI in one action.

**Retired this sync** (upstream did it better): our canvas-control bridge, our agent-messaging
boot factory, our canvas-control installer, and the agent-facing group-subtree `close`.

---

## 5. Known limits on THIS edition

| Thing | Status |
|---|---|
| `browser` verb (drive a page) | **permanently refused** — needs Electron `<webview>` + CDP |
| Node-mutating verbs on old nodes | refused — current-run creations only (§2) |
| Agent messaging | works, but the per-project switch ships **off** |
| Dictation / speech | `smart-whisper` is not built here — reports "local whisper unavailable" |
| SSH projects, worktree ops on remote repos | desktop-only |

---

## 6. Deploy state

| | |
|---|---|
| `main` | `fabfeb45` (v0.3.9) |
| **Running** | same — deployed 2026-09-23 |
| Canvas-control flag | **ON**, via `/etc/systemd/system/nodeterm-server.service.d/canvas-control.conf` |

Deploy sequence (deps change most syncs, so a bare rebuild is not enough):

```sh
cd ~/.nodeterm-server-app
export PATH="$HOME/.nodeterm-server-app/runtime/node/bin:$PATH"
git fetch origin main && git reset --hard origin/main
npm ci --ignore-scripts
node scripts/patch-node-pty.mjs     # NOT optional — darwin fd-leak + Windows ConPTY
npm rebuild node-pty                # Node's ABI. NEVER `npm run rebuild` (that is electron-rebuild)
npm run build && npm run server:build
sudo systemctl restart nodeterm-server
```

Then **hard-reload the browser tab** (the renderer bundle changes every deploy).

- Terminals survive a restart (`KillMode=process`); they also cold-restore after a machine reboot.
- Rollback point: `~/nodeterm-deploy-rollback.txt`, same steps with the old commit (~2 min).
- **Never run `scripts/install-server.sh` here.** As root it drops `User=`/`HOME=` (service runs as
  root, data dir moves to `/root`) and sets `NODETERM_HEADLESS=1`, which binds **no HTTP listener**
  — the browser UI disappears.

---

## 7. Known-red tests (do not chase)

**One**, and it reproduces on `upstream/main` alone — verified in a throwaway worktree:
`src/core/tmux-paste.realtmux.test.ts` → "CONTROL: without the gated cancel, copy mode unframes the
paste" (environment-sensitive real tmux). Everything else is green: **12,109 passing**, both
typechecks clean. Upstream fixed the four `opencode.test.ts` cases and `headless-e2e` that were red
last sync.

`node_modules` here is real and patched. If `node-pty-patch.test.ts` goes red, the install is
unpatched — not the code.

---

## 8. Syncing again — what three syncs have taught

1. **Check whether upstream already fixed it before resolving anything.** It has, every time:
   the armed-node bug (sync 2), then canvas control, messaging and the group `×` (sync 3). Carrying
   a duplicate patch in files upstream is actively reworking re-conflicts forever.
2. **"Put it in core" is not automatically the right shape.** Our canvas-control fix did that and
   still required the other shell's UI to be present. A seam that needs the other shell's renderer
   has not crossed the boundary.
3. **Never `git stash` across a branch switch during a merge** — it wipes `MERGE_HEAD`, and the
   commit then has ONE parent, which makes every future sync re-conflict everything. Use
   `git worktree add` to test another ref instead.
4. **Before "keep ours" on a conflict, ask whether upstream IMPROVED the thing our patch replaced.**
   The control-timeout wording was exactly that trap in sync 2.
5. **Verify every new test failure against upstream alone** (throwaway worktree) before blaming the
   merge.
6. Watch for **files upstream moved to a different path than we did** — `canvas-control-core.ts`
   (ours `src/core/agents/`, theirs `src/core/`) and the messaging tests (theirs stay in `src/main`)
   both bit this sync as "module not found" after a clean-looking resolution.
