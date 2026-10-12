import { describe, expect, it } from 'vitest'
import { WINDOW_VISIBILITY_EVENTS, windowVisibilitySignal } from './window-visibility'

describe('windowVisibilitySignal', () => {
  it('maps hide and minimize to hidden, show and restore to shown', () => {
    expect(windowVisibilitySignal('hide')).toBe('hidden')
    expect(windowVisibilitySignal('minimize')).toBe('hidden')
    expect(windowVisibilitySignal('show')).toBe('shown')
    expect(windowVisibilitySignal('restore')).toBe('shown')
  })

  it('covers exactly the four window events the shell subscribes to', () => {
    expect([...WINDOW_VISIBILITY_EVENTS].sort()).toEqual(['hide', 'minimize', 'restore', 'show'])
  })
})
