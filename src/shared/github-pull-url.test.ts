import { describe, expect, it } from 'vitest'
import { pullRequestUrl } from './github-pull-status'

describe('pullRequestUrl', () => {
  it('builds the PR page for a plain owner/name and a positive number', () => {
    expect(pullRequestUrl('Adscale-R-D/app_ms', 1045)).toBe('https://github.com/Adscale-R-D/app_ms/pull/1045')
  })
  it('refuses anything else', () => {
    for (const repo of [undefined, '', 'x', 'a/b/c', '../x/y', 'a/b?x=1', 'evil.com/a', 'a /b']) {
      expect(pullRequestUrl(repo, 1)).toBeNull()
    }
    for (const n of [0, -1, 1.5, Number.NaN]) expect(pullRequestUrl('o/r', n)).toBeNull()
  })
})
