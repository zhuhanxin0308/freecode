/** 装饰层不能拦截交互，动态偏好和透明度偏好必须有确定的退化样式。 */
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { atRuleBlock, parseRules } from './stylesheet-scan.ts'

const css = readFileSync(new URL('../src/styles/ambient.css', import.meta.url), 'utf8')

function block(prelude: string): string {
  const span = atRuleBlock(css, prelude)
  expect(span, prelude).toBeDefined()
  return css.slice(span!.start + 1, span!.end)
}

it('keeps the animated decoration behind the document and out of hit testing', () => {
  const layer = parseRules(css).find(rule => rule.selectors.includes('body::before') && rule.selectors.includes('body::after'))!
  expect(Object.fromEntries(layer.declarations)).toMatchObject({
    position: 'fixed', 'pointer-events': 'none', 'z-index': '-1', content: "''",
  })
  for (const name of ['freecode-ambient-drift', 'freecode-ambient-counter']) {
    for (const rule of parseRules(block(`@keyframes ${name}`))) {
      expect(rule.declarations.length).toBeGreaterThan(0)
      expect(rule.declarations.every(([property]) => property === 'transform' || property === 'opacity')).toBe(true)
    }
  }
})

it('stops decorative motion under reduced motion and hidden document state', () => {
  const reduced = parseRules(block('@media (prefers-reduced-motion: reduce)'))
  expect(reduced.find(rule => rule.selectors.includes('body::before'))?.declarations).toContainEqual(['animation', 'none'])
  const hidden = parseRules(css).find(rule => rule.selectors.includes('html[data-freecode-ambient-paused] body::before'))
  expect(hidden?.declarations).toContainEqual(['animation-play-state', 'paused'])
  expect(block('@media (forced-colors: active)')).toContain('display: none')
})

it('uses opaque feature surfaces when reduced transparency is requested', () => {
  const reduced = parseRules(block('@media (prefers-reduced-transparency: reduce)'))
  for (const selector of ['body', 'body[data-ds-dark-theme]']) {
    const tokens = Object.fromEntries(reduced.find(rule => rule.selectors.includes(selector))!.declarations)
    for (const name of ['--dsw-alias-ambient-workspace-fill', '--dsw-specific-sidebar-fill',
      '--dsw-alias-settings-card-fill', '--dsw-alias-onboarding-card-fill', '--dsw-specific-input-major']) {
      expect(tokens[name], `${selector}: ${name}`).toMatch(/^#[\da-f]{6}$/i)
    }
  }
})
