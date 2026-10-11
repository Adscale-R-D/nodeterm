import { posix, win32 } from 'path'

export const FILE_LIST_PASTEBOARD_TYPE = 'NSFilenamesPboardType'
const MAX_CLIPBOARD_FILES = 64

export interface FileClipboardDependencies {
  platform: string
  isFile(path: string): boolean
  writeBuffer(format: string, buffer: Buffer): void
  /**
   * Windows leg: put a real CF_HDROP on the clipboard. `writeBuffer` cannot do it there —
   * Electron registers its format argument as a CUSTOM format name, and CF_HDROP is a predefined
   * format id, not a registerable name. Absent ⇒ Windows refuses, like every other platform.
   */
  writeWindowsFileDrop?(paths: string[]): Promise<boolean>
}

const escapeXml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')

export function fileListPropertyList(paths: string[]): Buffer {
  const entries = paths.map((path) => `    <string>${escapeXml(path)}</string>`).join('\n')
  return Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n` +
      `<plist version="1.0">\n  <array>\n${entries}\n  </array>\n</plist>\n`,
    'utf8'
  )
}

/**
 * Validate a renderer-supplied file selection. Inputs cross an IPC trust boundary, so paths are
 * capped, absolute-only (in the dialect of the platform that will read them — `path.win32` on
 * Windows, so drive and UNC paths validate there and only there), de-duplicated and re-checked
 * against the filesystem. All-or-nothing: `null` for any bad entry, so a multi-selection is never
 * silently truncated or partially copied.
 */
export function validateClipboardFilePaths(
  input: unknown,
  platform: string,
  isFile: (path: string) => boolean
): string[] | null {
  if (!Array.isArray(input)) return null
  const isAbsolute = platform === 'win32' ? win32.isAbsolute : posix.isAbsolute

  const paths: string[] = []
  const seen = new Set<string>()
  for (const value of input) {
    if (typeof value !== 'string' || !isAbsolute(value)) return null
    if (seen.has(value)) continue
    if (paths.length >= MAX_CLIPBOARD_FILES) return null
    try {
      if (!isFile(value)) return null
    } catch {
      return null
    }
    seen.add(value)
    paths.push(value)
  }
  return paths.length ? paths : null
}

/**
 * Put existing local regular files on the OS clipboard as file references, so Finder / File
 * Explorer pastes the actual files. darwin writes the `NSFilenamesPboardType` plist; win32 hands
 * the validated list to `writeWindowsFileDrop` (CF_HDROP); every other platform refuses.
 */
export async function writeFilesToClipboard(
  input: unknown,
  dependencies: FileClipboardDependencies
): Promise<boolean> {
  const { platform } = dependencies
  if (platform !== 'darwin' && !(platform === 'win32' && dependencies.writeWindowsFileDrop)) {
    return false
  }
  const paths = validateClipboardFilePaths(input, platform, dependencies.isFile)
  if (!paths) return false

  try {
    if (platform === 'win32') return (await dependencies.writeWindowsFileDrop?.(paths)) === true
    dependencies.writeBuffer(FILE_LIST_PASTEBOARD_TYPE, fileListPropertyList(paths))
    return true
  } catch {
    return false
  }
}
