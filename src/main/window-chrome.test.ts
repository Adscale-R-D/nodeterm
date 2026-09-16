import { describe, expect, it } from 'vitest'
import { macTitleBarOptions } from './window-chrome'
import {
  TABBAR_HEIGHT_PX,
  TRAFFIC_LIGHT_DIAMETER_PX,
  trafficLightY
} from '@shared/window-chrome-metrics'

describe('macTitleBarOptions', () => {
  it('hides the title bar and centres the traffic lights in the tab bar on macOS', () => {
    expect(macTitleBarOptions('darwin')).toEqual({
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 16, y: trafficLightY() }
    })
  })

  it('puts the lights on the bar\'s vertical centre, whatever the bar height is', () => {
    // Electron takes the light's TOP edge, so centre = y + radius must equal half the bar.
    const y = trafficLightY()
    const centre = y + TRAFFIC_LIGHT_DIAMETER_PX / 2
    expect(Math.abs(centre - TABBAR_HEIGHT_PX / 2)).toBeLessThanOrEqual(0.5)
    // The literal it replaced: 15 was right for 44px and only for 44px.
    expect(trafficLightY(44)).toBe(16)
    expect(trafficLightY(36)).toBe(12)
  })

  // Issue #564: both options are macOS-only. Claiming them elsewhere is what made the renderer's
  // 86px traffic-light reservation look justified on a window that has a native frame.
  it('claims neither on Windows or Linux', () => {
    expect(macTitleBarOptions('win32')).toEqual({})
    expect(macTitleBarOptions('linux')).toEqual({})
  })
})
