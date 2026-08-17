// Installs the outbound canvas-control CLI + per-agent discovery docs. Mirrors
// context-link.ts: a self-contained POSIX-sh CLI (nodeterm.sh) POSTs to the hook server's
// /control/* routes; a Claude skill / codex-gemini instruction blocks tell the agent how +
// when to call it. The CLI no-ops unless NODETERM_CANVAS_CONTROL is set.
//
// The SSH counterpart of this file is RemoteHooks.installCanvasControl, which writes the very
// same shim + skill onto the remote host — the shim carries no machine-specific paths, so one
// script serves both sides.
//
// IT LIVES IN CORE (it was `src/main/canvas-control.ts`) because DISCOVERY was the other half of
// canvas control being dead on the Server Edition. Wiring the verbs is not enough: with no
// `skills/manage-nodeterm-canvas/SKILL.md` and no instruction block, an agent on a headless host is
// never told the CLI exists, and it will not go looking for a shell script it has never heard of.
// Measured on the host that prompted this: `NODETERM_CANVAS_CONTROL=1` was set in the session env,
// `~/.claude/skills` did not exist at all, and the only shim on disk was a months-old stray.
// Everything Electron-specific here was one call — `app.getPath('userData')`, now
// `platform().userDataDir`.
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  CONTROL_SHIM_SCRIPT,
  buildCanvasControlInstructions,
  buildCanvasSkillBody,
  mergeCanvasControlBlock
} from './canvas-control-core'
import { opencodeConfigDir } from './hooks/opencode'
import { copilotHomeDir } from './hooks/copilot'
import { platform } from '../platform'

function dir(): string {
  return path.join(platform().userDataDir, 'canvas-control')
}
function shimPath(): string {
  return path.join(dir(), 'nodeterm.sh')
}
function skillPathIn(configDir: string): string {
  return path.join(configDir, 'skills', 'manage-nodeterm-canvas', 'SKILL.md')
}
function skillBody(): string {
  return buildCanvasSkillBody(shimPath())
}

function writeCliFiles(): void {
  const d = dir()
  fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(shimPath(), CONTROL_SHIM_SCRIPT)
  try {
    fs.chmodSync(shimPath(), 0o755)
  } catch {
    /* fail open */
  }
  // Sweep the retired Electron-as-Node CLI off upgraders' disks — the shim no longer execs it,
  // so it would sit there forever pointing at a binary path that moves with every app update.
  try {
    fs.rmSync(path.join(d, 'canvas-control-cli.mjs'), { force: true })
  } catch {
    /* fail open */
  }
}

/**
 * Install (or refresh) the canvas-control skill into a Claude config dir's `skills/`.
 * Claude Code resolves user skills relative to CLAUDE_CONFIG_DIR, so managed accounts
 * (config dir = {userData}/claude-accounts/<id>) need their own copy — mirroring how the
 * managed status hook is merged into each account dir's settings.json. Best-effort.
 */
export function installCanvasSkillInto(configDir: string): void {
  const p = skillPathIn(configDir)
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, skillBody(), 'utf8')
  } catch (e) {
    console.warn('[canvas-control] skill install failed', p, e)
  }
}

// Codex/Gemini/Copilot/opencode use global instruction files here — merge the canvas-control block
// instruction files (marker-delimited, idempotent, other content preserved). Same pattern
// as context-link's get-linked-context block. The CLI env-gate keeps the block inert in
// the user's normal (non-nodeterm) codex/gemini/opencode sessions.
function installAgentInstructions(): void {
  const block = buildCanvasControlInstructions(shimPath())
  const targets = [
    path.join(os.homedir(), '.codex', 'AGENTS.md'),
    path.join(os.homedir(), '.gemini', 'GEMINI.md'),
    path.join(copilotHomeDir(), 'copilot-instructions.md'),
    path.join(opencodeConfigDir(), 'AGENTS.md')
  ]
  for (const p of targets) {
    try {
      let existing = ''
      try {
        existing = fs.readFileSync(p, 'utf8')
      } catch {
        /* new file */
      }
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, mergeCanvasControlBlock(existing, block), 'utf8')
    } catch (e) {
      console.warn('[canvas-control] instructions install failed', p, e)
    }
  }
}

export function initCanvasControl(): void {
  try {
    writeCliFiles()
    installCanvasSkillInto(path.join(os.homedir(), '.claude'))
    installAgentInstructions()
  } catch (e) {
    console.error('[canvas-control] setup failed', e)
  }
}
