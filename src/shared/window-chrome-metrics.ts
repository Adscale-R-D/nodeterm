/**
 * The one place the tab bar's height is a NUMBER.
 *
 * Two things depend on it from opposite sides of the process boundary and cannot read each other:
 * the stylesheet (`--tabbar-h` in `renderer/styles.css`, which every top-anchored panel, the
 * kanban overlay and the usage popover position against) and the main process, which has to put
 * the macOS traffic lights on the bar's vertical centre (`trafficLightPosition` — a bar that gets
 * shorter while the lights stay put looks broken at once). CSS cannot import a constant and main
 * cannot read a stylesheet, so the number lives here and `renderer/styles.tabbar.test.ts` pins the
 * stylesheet's token to it.
 */

/** Height of `.tabbar`, in CSS px. Chrome's strip is ~40; this is one text line plus padding. */
export const TABBAR_HEIGHT_PX = 36

/** The macOS traffic lights are 12px discs (measured on a 2x capture: 24 device px). */
export const TRAFFIC_LIGHT_DIAMETER_PX = 12

/** Distance from the window's left edge to the first light. Unchanged from the 44px bar. */
export const TRAFFIC_LIGHT_X = 16

/**
 * The `y` that centres the lights inside a bar of the given height. Electron takes the top edge
 * of the light, not its centre, hence the diameter subtraction. Rounded down, never up: a light
 * one pixel high in a bar reads as sitting in the bar; one pixel low reads as hanging off it.
 */
export function trafficLightY(barHeight: number = TABBAR_HEIGHT_PX): number {
  return Math.floor((barHeight - TRAFFIC_LIGHT_DIAMETER_PX) / 2)
}
