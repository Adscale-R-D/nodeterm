# nodeterm fork — status & change log for an orchestrating agent

**Audience: the agent/manager coordinating work on this box.** What you can do now that you could
not before, what is actually running, and what is known-broken so you do not chase it.

Written **2026-09-23** (updated 2026-09-28 for sync #4, 2026-10-15 for sync #5 and 2026-10-20 for sync #6), replacing the 2026-09-02 edition wholesale — most of what that one
described has been retired (§4). Lives in `docs/fork/` (a path upstream never creates, so it adds
no conflict surface); fork-local operational state, not upstream documentation.

---

## 1. What this repo is

| | |
|---|---|
| This checkout | `~/nodeterm` = **`Adscale-R-D/nodeterm`** (our fork), branch `main` |
| Upstream | **`eneskirca/nodeterm`**, remote `upstream` |
| Fork `main` | a merge of upstream `6b03f579` (**v0.4.4+**, sync #6, 2026-10-20), **0 behind upstream** |
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
  **No browser tab is required.**

**It is tab-free but NARROWER, and that trade is the headline.** Our retired bridge served all 25
verbs whenever a tab happened to be attached; the headless runtime serves **19**, always —
upstream's 17, plus `board`/`assign`, which this fork adds (§4):

| Served headless (Server Edition v1) | Refused headless (`control-unsupported-on-this-edition`) |
|---|---|
| `open-project` `open-terminal` `open-agent` `close` `link` `group` `rename` `color` `send` `reply` `notify` `sticky` `settings` `run` `report-outcome` `issues` `prs` **`board` `assign`** | `list` `verify` `spawn-team` `arrange` `align` `move` `ungroup` `open-claude` `open-worktree` `close-worktree` `branch` `write` `show-*` `open-browser` `browser` |

Consequences an orchestrator must plan around:
- **`open-claude` is gone — use `open-agent --agent claude`** (v1 takes `claude|codex|gemini`).
- **No `list`.** An agent cannot read the canvas here, so it cannot discover node ids it did not
  create; it knows only what its own calls returned. **`board` works** and lists every card with
  its id, which is the one way to see ids it did not create (it cannot mutate them — see below).
- **No `verify` and no `spawn-team`.** A review panel or a team has to be assembled by hand from
  `open-agent` + `link` + `group`, and there is no `arrange`/`align` to tidy it.
- SSH: v1 creates **local sessions only** (`project-target-ssh-unsupported`).

### It is behind a flag, default OFF

```
NODETERM_SERVER_CANVAS_CONTROL=1        # or: --canvas-control
```

**This box has it ENABLED** via a systemd drop-in (§6). Upstream's own words on why it defaults
off: enabling it *"lets an agent session run arbitrary commands on this host as the user the server
runs as — `open-terminal --cmd <command>` is executed in a PTY this process spawns, with that
user's environment, files and credentials."* Hook auth, verified node identity and per-project
capability gates still decide **which** agent may ask, not **what** may be asked for.

If **every** verb refuses with `control-unsupported-on-this-edition`, check the flag — that is what
OFF looks like. If only SOME refuse with that name, it is the v1 verb set above, and no flag will
change it. The boot log distinguishes them: with the flag on, the server prints a one-line banner
naming the surface it grants.

### The headless ownership rule — new, and it will surprise you

On the Server Edition, the node-mutating verbs (`close`, `link`, `group`, `rename`, `color`,
`sticky` update, `assign`) accept **only nodes the caller opened during the current server run**, and refuse
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

**New/changed verb surface worth knowing.** Everything below is upstream's CLI contract; on this
host only the 15 verbs in §2 reach it, so treat the rest as desktop-only until v2:

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

## 4. What the fork still adds (3 patches)

| Patch | Why it is still ours |
|---|---|
| **Kanban control on the Server Edition + agent-created columns** | upstream refuses `board`/`assign` headless, and has no way to create a column from an agent anywhere. See below. |
| **`contextLink.info` over the browser bridge** | upstream still stubs it `E_UNSUPPORTED`; without it `verify` cannot build a reviewer's brief |
| **Claude window = 200k unless `[1m]`** | upstream still uses the `opus\|sonnet\|fable` family rule, which under-reports context pressure **5×** on every 200k session |

**Kanban control (added 2026-09-24).** A pipeline files each lane's cards into one column per
TASK, and the column cleans itself up:

```sh
nodeterm.sh assign --node <child> --column "Task A" --create yes   # idempotent: one column per title
nodeterm.sh board                                                  # columns + cards (+ ids), Ungrouped
```

- `--create yes` makes the column when no title matches (case-insensitive), marked
  `origin: 'agent'`. Several agents filing into one title — even at the same instant — land in ONE
  column: the server serializes every control write.
- An agent-created column is **removed automatically** when its last card is closed or moved out,
  on either shell (server `close`/`assign`, and the desktop's delete + drag paths). A column the
  user made is **never** removed, even empty. An agent column that was already empty is left alone
  — only a change that empties it removes it.
- Server Edition `assign` refuses a card the caller did not open this run (`assign-not-owner`);
  `board` has no ownership check. Desktop `assign` is unchanged (no ownership check) but gained
  `--create` too, since the agent-facing docs are one text for both shells.
- Server moves land live on an open board (the full-project publish carries `kanban`) and in the
  card's feed, attributed to the agent's node title.
- Concurrent edits are last-write-wins on the whole board object, the same as nodes: a desktop
  drag landing at the same instant as an agent `assign` keeps one of the two. Each side writes a
  complete, self-consistent board, so the result is always a valid board — never a mix of the two.
- A surface that drops unknown fields on write (the iOS app's direct-SSH writer may) turns an agent
  column into a hand-made one, which then simply stays — the safe direction.
- Upstreamable: the transforms moved to `src/shared/` (`kanban.ts`, `board-log-diff.ts`,
  `kanban-control.ts`), with the renderer files kept as re-exports.

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
| `main` | sync #6 merge of upstream `6b03f579` (v0.4.4+), 2026-10-20 |
| **Running** | sync #5 (`090327b4`) until this merge is deployed |
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

**One** as of sync #5 (2026-10-15): `src/core/agents/hook-server-form.test.ts` → "reads windows-1252
escapes instead of throwing" (a native-Windows-curl form body). It fails identically on
`upstream/main` alone — verified in a throwaway worktree — so it is this box's environment, not the
fork. Everything else is green: **22,291 passing**, both typechecks clean.

`node_modules` here is real and patched. If `node-pty-patch.test.ts` goes red, the install is
unpatched — not the code.

---

## 8. Sync #6 (2026-10-20): what it brought (v0.4.3 → v0.4.4+, 61 commits)

Two conflicts, both in the kanban `board` verb. Upstream added `board --project <id>` with its own
reply builder (`renderer/lib/boardVerb.ts`); it now DELEGATES to our shared `boardSnapshot`
(which gained an optional project name), so the desktop's two `board` paths and the server's
answer in one shape and a `--project` read also marks agent-created columns. One new failure was
ours: upstream's `antigravityWindowFor` reused `staticWindowFor` for Claude models served through
`agy`, and the fork's 200k rule (a Claude Code CLI fact) made it 200k; that path now keeps
upstream's family rule. New on this box: `scripts/patch-smart-whisper.mjs` (run it next to the
node-pty patch, or its test reads red). Server-relevant: held launches claimed in core (#1224),
only the pane's foreground claude speaks for a node (#1236), SSH routing by project (#1238).

---

## 8a. Sync #5 (2026-10-15): what it brought (v0.3.17 → v0.4.3, 1,087 commits)

All three patches survived again — upstream's server still refuses `board`/`assign`, still stubs
`contextLink.info` in the browser, and still treats opus/sonnet as 1M. What changed for us:

- **Pipeline reliability, headless:** `--after-success` + `report-outcome` (wait for a station to
  REPORT success, not just end its turn); queued messages, outcome reports, the `--request-id` ledger
  and `--after` holds now SURVIVE a service restart (`<dataDir>/orchestration-state/`); the opener is
  told once when a station it opened errors, dies or sits blocked 15 min; `run` re-delivers a
  retained launch; `issues`/`prs` read the board's GitHub lane. The server's creator-ownership rule
  is still process-local — a restart still resets which nodes an agent may mutate.
- **Hosted team relay** (opt-in, inert until `team bootstrap`): this core can host a team that
  desktop apps join through nodeterm's relay (`wss://relay.nodeterm.dev`), E2EE, roles enforced
  here. Phones still cannot pair with the server. Do NOT follow its guide's `install-server.sh` step
  on this box (§6); the `team` CLI only needs the running service.
- **The headless factory saves through `castAndSave`**: each write is cast as live canvas ops
  BEFORE the save, then the persisted project is re-published. Our `assign` and the `close`
  sweep now use it, so an open board updates live and a governed project keeps the write.
- **Boards sync item by item** (`src/shared/kanban-ops.ts`). Its column sanitizer is an ALLOWLIST
  and dropped `origin` — fixed in this merge (an agent column reached peers as a hand-made one).
  `setProjectKanban` sweeps BEFORE it publishes, so peers receive the swept board.
- **Card order is rank-based and an unanchored move lands at the TOP** of its column: `assign`
  without `--before` now puts the card first, so the last card an agent filed reads first.
- `defaultKanban(projectId)` now takes the project (default column ids are deterministic).
- Agent brief fixed: upstream's issue contract said "the Server Edition has no `assign` verb"; here
  it says self-assign is refused by the ownership rule, which is what actually happens.

---

## 8b. Sync #4 (2026-09-28): what it brought (v0.3.10 → v0.3.17, 417 commits)

Our three patches all survived. Upstream still refuses `board`/`assign` headless, still stubs
`contextLink.info`, and still treats opus/sonnet as 1M. What changed for us:

- **Armed launches are more reliable on the headless server**: a launch whose delivery fails or is
  not acknowledged is now RETAINED (the node keeps its command, "Run now" can recover it) and the
  reply says honestly whether it was delivered. Launches also check that a shell owns the pane
  first (`paneCommand`). This is the class of bug behind the old `--after` losses.
- **The session's own reported context window now wins** (`sessionContextWindow`, from the hook
  env). Our 200k-unless-`[1m]` rule stays as the fallback when a session reports nothing.
- **⌘M chat view rebuilt**: paged transcripts, a claude.ai-style composer, and Plan / Question
  cards you can ANSWER in place; also in the kanban card modal.
- **Accounts**: switch a running Claude/Codex node to another account; bulk-move sessions.
- Perf (scrollback, transcript and workspace re-reads, glow, pan/zoom), terminal repaint fixes,
  link right-click menu, node menu grouped into Transfer ▸ / Restart ▸, "Liquid Glass" theme.
- Upstream moved the card-meta + label transforms to `src/shared/kanban-labels.ts`; our
  `src/shared/kanban.ts` re-exports it, so nothing that imports the board transforms changed.

---

## 9. Syncing again — what five syncs have taught

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
7. **When upstream extracts code out of a file we moved, apply the same extraction to our copy and
   diff the removed block against upstream's deletion** (sync 4, `kanban.ts` → `kanban-labels.ts`).
   Byte-identical means nothing of ours was lost in the cut.
8. **Upstream's guard tests inventory what we add — read them, do not loosen them** (sync 5). Four
   failed on our patches: the board-writer inventory (our sweep is a new writer), two relay-policy
   guards (our browser `contextLink.info` uses a channel nobody had classified for relay guests),
   and the publish pin (we publish the swept board). Each wanted a decision written down, and the
   relay one caught a real gap: hosted-team guests could have called that channel unclassified.
9. **`npm ci --ignore-scripts` removes the compiled node-pty**; every suite that loads it then fails
   to START, which reads as dozens of failures. Run `node scripts/patch-node-pty.mjs && npm rebuild
   node-pty` before judging a test run.
