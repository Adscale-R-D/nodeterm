import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  COMPACT_MIN_TAB_PX,
  ROOMY_MIN_TAB_PX,
  TAB_BASE_FURNITURE_PX,
  TAB_CARET_PX,
  TAB_NAME_MIN_PX,
  TAB_SSH_CHIP_PX,
  tabDensity
} from './tabDensity'

describe('tabDensity', () => {
  // The strip inner width a 1340px macOS window leaves 8 tabs, measured before the fix: 1114 minus
  // 16px of flare padding. Every number below is from that run or derived from its furniture.
  const STRIP_1340_MAC = 1114 - 16

  it('answers roomy until measured', () => {
    expect(tabDensity(null, 8)).toBe('roomy')
    expect(tabDensity(Number.NaN, 8)).toBe('roomy')
    expect(tabDensity(1000, 0)).toBe('roomy')
  })

  it('keeps everything while a tab can hold chip + caret + a readable name', () => {
    expect(ROOMY_MIN_TAB_PX).toBe(TAB_BASE_FURNITURE_PX + TAB_SSH_CHIP_PX + TAB_CARET_PX + TAB_NAME_MIN_PX)
    expect(tabDensity(ROOMY_MIN_TAB_PX * 4, 4)).toBe('roomy')
    // 4 projects at their 168px basis: what a typical window shows.
    expect(tabDensity(168 * 4, 4)).toBe('roomy')
  })

  it('defers the CARET first, so the field report at 8 tabs in 1340px KEEPS its SSH chips', () => {
    // 1098 / 8 = 137px per tab — enough for the chip + 60px of name, not for the caret as well.
    // Reported from the running app after the first version shed the chip here instead: the `SSH`
    // label went missing from every remote tab at the width people actually work at.
    expect(tabDensity(STRIP_1340_MAC, 8)).toBe('compact')
    expect(COMPACT_MIN_TAB_PX).toBe(TAB_BASE_FURNITURE_PX + TAB_SSH_CHIP_PX + TAB_NAME_MIN_PX)
    expect(STRIP_1340_MAC / 8).toBeGreaterThanOrEqual(COMPACT_MIN_TAB_PX)
  })

  it('hides the SSH chip only when the chip itself would squeeze the name', () => {
    // 1098 / 12 = 91.5px per tab: below the chip floor, above the bare floor.
    expect(tabDensity(STRIP_1340_MAC, 12)).toBe('tight')
    expect(tabDensity(COMPACT_MIN_TAB_PX * 12 - 12, 12)).toBe('tight')
    expect(tabDensity(COMPACT_MIN_TAB_PX * 12, 12)).toBe('compact')
  })

  it('the caret is deferred, never removed — it returns on hover at every level', () => {
    // A pin on the CSS, because the whole trade rests on it: the caret is one hover away, the
    // chip (at `tight`) is not on the tab at all. Both selectors must keep the hover escape.
    const css = readFileSync(join(__dirname, '../styles.css'), 'utf8').replace(/\r\n/g, '\n')
    for (const level of ['compact', 'tight']) {
      expect(css).toContain(
        `.tabbar__tabs[data-density='${level}'] .tab:not(.active):not(:hover):not(.tab--menu-open) .tab__actions`
      )
    }
  })

  it('never lets the name floor fall below the width of a short word', () => {
    // Below this the fade zone (18px) eats most of what is left; 24px was the reported bug.
    expect(TAB_NAME_MIN_PX).toBeGreaterThanOrEqual(56)
  })
})
