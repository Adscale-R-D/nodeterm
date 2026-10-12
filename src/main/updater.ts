// Auto-update client (electron-updater). The packaged app downloads updates automatically
// and forwards the full lifecycle (available → progress → downloaded → error/not-available)
// to the renderer's UpdateCard. Version lookup, manual check, and restart work in dev too;
// the automatic feed checks and event wiring are packaged-only. On macOS, silent self-install
// requires a signed + notarized build; unsigned builds still surface the card for a manual
// download.
import { app, ipcMain, Notification } from 'electron'
import fs from 'fs'
import path from 'path'
// Named import — the default-import + destructure pattern returns undefined under
// electron-vite v5's CJS interop.
import { autoUpdater } from 'electron-updater'
import { IPC } from '../shared/ipc'
import {
  MANUAL_UPDATE_MODE,
  mayQuitAndInstall,
  toUpdateAvailablePayload,
  updateDelivery
} from '../shared/update-platform'
import { getMainWindow, sendToMain } from './main-window'
import { retainUntilDismissed } from './notifications'
import { consumeUpdateFailedMarker, describeUpdateInstallFailure } from './update-install-marker'

const SIX_HOURS = 6 * 60 * 60 * 1000

/** The outcome of the most recent feed check (any trigger). Recorded so a check-only build's
 *  silent automatic failures are still observable — see the 'error' handler. */
export interface UpdateCheckRecord {
  at: number
  ok: boolean
  message?: string
}
let lastCheck: UpdateCheckRecord | null = null
export function lastUpdateCheck(): UpdateCheckRecord | null {
  return lastCheck
}

/**
 * One actionable log line for a failed check in a check-only build. A 404 on a `latest*.yml` is
 * the feed itself missing — the nodeterm.dev/updates mirror not serving that platform's file —
 * which is an ops fix, not a network blip, and reads like one in a device report. Pure; exported
 * for tests.
 */
export function describeCheckFailure(message: string): string {
  const feedMissing = /\b404\b/.test(message) && /latest[\w.-]*\.yml/i.test(message)
  return feedMissing
    ? `update feed is missing this platform's latest*.yml (${message}); the passive update notice cannot fire until the update mirror serves it`
    : `update check failed: ${message}`
}

/**
 * The `nodeTermUpdates` marker a LOCAL package carries in its packaged package.json, injected by
 * the `dist*` scripts via electron-builder's `extraMetadata`. `release` does not set it, so a
 * promoted build is untouched and keeps updating itself. The one RELEASE that carries a marker is
 * the unsigned Windows beta (`dist:win:release` → `manual`): it checks the feed but never
 * downloads or installs — see `updateDelivery`.
 *
 * It exists because a locally packaged app is indistinguishable from a release at runtime —
 * `app.isPackaged` is true for both — so it polled the production feed for a version that was
 * never published there and logged a 404 on `latest*.yml` every six hours.
 *
 * The trade-off, stated plainly: a `dist*` package can no longer smoke-test the updater wiring
 * itself — a manual check there does not go near the network. The old behaviour at least proved
 * the wiring was live, at the cost of a recurring 404 in every local build's log. Verifying the
 * real feed is the job of a `release` package, which carries no marker.
 *
 * The marker is therefore also what `no-channel` means at runtime (see `updateDelivery`): such a
 * build now SAYS it has no channel instead of claiming to be up to date, which is issue #814.
 */
function packagedUpdateMode(): unknown {
  if (!app.isPackaged) return undefined
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8')) as {
      nodeTermUpdates?: unknown
    }
    return pkg.nodeTermUpdates
  } catch (err) {
    // A normal release without the marker must preserve the established updater behavior.
    console.warn('[updater] could not read packaged update mode:', err)
    return undefined
  }
}

/**
 * The window is resolved AT EVENT TIME (getMainWindow/sendToMain) — never captured in a closure.
 * On macOS the window can be closed (the app lives on) and recreated from the dock, so a captured
 * reference is a DESTROYED window: touching it throws `TypeError: Object has been destroyed`. That
 * shipped — an update finishing downloading after a close→dock-reopen crashed the main process on
 * `win.isFocused()`.
 *
 * @param onBeforeRestart Run right before `quitAndInstall()`. Required so the caller can flip its
 *   "quitting" flag: `quitAndInstall()` closes all windows and only then calls `app.quit()`, but
 *   our `win.on('close')` hides the window (keeps the app alive) unless we're already quitting — so
 *   without this the window just hides, `app.quit()` never fires, and the update never installs.
 */
export function initUpdater(onBeforeRestart?: () => void): void {
  const send = (channel: string, payload?: unknown) => sendToMain(channel, payload)

  // A self-update the installer refused on the way in (build/installer.nsh writes this note and
  // restarts the previous version). Read once and deleted; Windows only, a no-op elsewhere.
  const failedInstall = consumeUpdateFailedMarker({
    platform: process.platform,
    localAppData: process.env.LOCALAPPDATA
  })
  if (failedInstall) console.warn('[updater]', describeUpdateInstallFailure(failedInstall))

  const updateMode = packagedUpdateMode()
  const delivery = updateDelivery({
    isPackaged: app.isPackaged,
    updateMode,
    platform: process.platform,
    hasAppImage: !!process.env.APPIMAGE
  })

  // Always available, even in dev: current version, manual check, restart.
  ipcMain.handle(IPC.appGetVersion, () => app.getVersion())
  ipcMain.on(IPC.appRestartToUpdate, () => {
    // A build that must not self-install refuses here, in main — not only by the card never
    // offering the button. The unsigned Windows beta (`nodeTermUpdates=manual`) is the reason:
    // quitAndInstall must never run there, whatever the renderer sends. It also skips
    // onBeforeRestart, which would otherwise leave the app flagged as quitting with no quit.
    if (!mayQuitAndInstall(delivery)) {
      console.warn(`[updater] restart-to-update ignored: this build does not self-install (${delivery})`)
      return
    }
    onBeforeRestart?.()
    autoUpdater.quitAndInstall()
  })

  if (delivery === 'dev' || delivery === 'no-channel') {
    // Neither can reach a feed, so automatic networking and updater event wiring stay off — but
    // the two answer a MANUAL check differently, because only one of them has a user to mislead.
    //
    // `no-channel` is a packaged app someone installed from a local `dist*` package. Telling them "up to date" is a statement this build is structurally
    // unable to make — it was issue #814's actual complaint, read by the reporter as a dead
    // button. It now says it has no channel and points at the download page.
    //
    // `dev` keeps the old quiet "up to date": `npm run dev` has no install to be wrong about.
    ipcMain.on(IPC.appCheckForUpdates, () =>
      send(delivery === 'no-channel' ? IPC.appUpdateNoChannel : IPC.appUpdateNotAvailable)
    )
    return
  }

  // A Linux .deb/.rpm install (no APPIMAGE env) cannot self-install and would re-download the
  // full AppImage every 6h only to throw on install; the unsigned Windows beta must not
  // self-install. Degrade both to a manual-download link: don't auto-download; surface
  // update-available with `manual: true` so the card shows a Download link. (electron-updater's
  // NsisUpdater verifies a signature only at install time, which this path never reaches.)
  const manualUpdates = delivery === 'manual-install'

  autoUpdater.autoDownload = !manualUpdates
  autoUpdater.autoInstallOnAppQuit = !manualUpdates

  const recordCheck = (ok: boolean, message?: string): void => {
    lastCheck = { at: Date.now(), ok, ...(message === undefined ? {} : { message }) }
  }

  autoUpdater.on('update-available', (info) => {
    recordCheck(true)
    send(IPC.appUpdateAvailable, toUpdateAvailablePayload(info, manualUpdates))
  })

  autoUpdater.on('download-progress', (p) => {
    send(IPC.appUpdateProgress, {
      percent: p.percent,
      transferred: p.transferred,
      total: p.total,
      bytesPerSecond: p.bytesPerSecond
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    send(IPC.appUpdateDownloaded, { version: info.version })
    // OS notification only when the window is in the background; the card covers the foreground.
    // Resolve the window HERE, not at init: a download can finish long after a close→dock-reopen.
    // No live window (closed on macOS) reads as "not focused", which is exactly when we notify.
    if (!getMainWindow()?.isFocused() && Notification.isSupported()) {
      const n = new Notification({
        title: 'Update ready',
        body: `nodeterm ${info.version} is ready to install.`
      })
      n.on('click', () => {
        // Resolve again on click — the window may have been closed or recreated since.
        const w = getMainWindow()
        if (!w) return
        if (w.isMinimized()) w.restore()
        w.show()
        w.focus()
      })
      // Keep a reference or GC silently kills the click handler (electron/electron#16922).
      retainUntilDismissed(n)
      n.show()
    }
  })

  autoUpdater.on('update-not-available', () => {
    recordCheck(true)
    send(IPC.appUpdateNotAvailable)
  })

  // A check-only build (`nodeTermUpdates=manual`, the unsigned Windows beta) downloads nothing, so
  // every 'error' event it can emit is a CHECK failure — and electron-updater emits one for the
  // silent launch/6h checks too. The beta previously showed nothing at all; an error card on every
  // launch (offline, or a feed mirror that does not serve latest.yml yet) would be a regression
  // for exactly the users this notice exists for. So there the event is not shown — but it is NOT
  // silent either: it is recorded (`lastUpdateCheck`) and logged as one actionable warning, so a
  // feed that 404s (the mirror not serving latest.yml) is visible in the debug log instead of
  // looking like "no update yet". A user-initiated check still surfaces its failure through the
  // catch below. Every other build keeps its historical behaviour.
  const checkOnly = delivery === 'manual-install' && updateMode === MANUAL_UPDATE_MODE
  autoUpdater.on('error', (err) => {
    const message = err?.message ?? String(err)
    recordCheck(false, message)
    if (checkOnly) {
      console.warn('[updater]', describeCheckFailure(message))
      return
    }
    console.error('[updater]', message)
    send(IPC.appUpdateError, message)
  })

  // Manual check from Settings; surfaces failures to the card.
  ipcMain.on(IPC.appCheckForUpdates, () => {
    autoUpdater.checkForUpdates().catch((err) => {
      const message = err?.message ?? String(err)
      console.error('[updater]', message)
      send(IPC.appUpdateError, message)
    })
  })

  // Automatic checks: on launch and every six hours.
  const check = () => {
    autoUpdater.checkForUpdates().catch((err) => console.error('[updater]', err?.message ?? err))
  }
  check()
  setInterval(check, SIX_HOURS)
}
