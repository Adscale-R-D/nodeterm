// Main-window visibility → the renderer's "backgrounded" signal (renderer/terminal/
// window-backgrounded.ts). Pure + Electron-free so the mapping is pressable on any CI box.
//
// Why an explicit signal and not `document.visibilityState`: Chromium's occlusion tracking also
// flips that to `hidden` for a window that is merely COVERED by another app, and a covered window
// must keep its terminals warm — the user is one ⌘Tab away. Only a window the user actually put
// away (close-to-tray / macOS hide-on-close / minimize) is backgrounded.

/** The BrowserWindow events that change whether the user can see the window at all. */
export type WindowVisibilityEvent = 'hide' | 'show' | 'minimize' | 'restore'

export type WindowVisibilitySignal = 'hidden' | 'shown'

export const WINDOW_VISIBILITY_EVENTS: readonly WindowVisibilityEvent[] = [
  'hide',
  'show',
  'minimize',
  'restore'
]

/**
 * Map one window event to the signal the renderer gets. `restore` can also arrive for a window
 * that was never minimized (some Linux window managers emit it on un-maximize); that maps to
 * `'shown'`, which the renderer treats idempotently — "shown" while shown changes nothing.
 */
export function windowVisibilitySignal(event: WindowVisibilityEvent): WindowVisibilitySignal {
  return event === 'hide' || event === 'minimize' ? 'hidden' : 'shown'
}
