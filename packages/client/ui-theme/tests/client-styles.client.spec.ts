// @vitest-environment jsdom
/** Dynamic ui-theme entry owns the global styles in dependency order. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installThemeStyles } from '../src/client/styles.ts'

const PLUGIN_ID = '@deepseek-ai/dsh-client-ui-theme'
const fibers = new Set<ReturnType<Context['plugin']>>()

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all([...fibers].map(fiber => fiber.dispose()))
  fibers.clear()
  document.head.querySelectorAll(`style[data-plugin="${PLUGIN_ID}"]`).forEach((node) => { node.remove() })
  document.documentElement.removeAttribute('data-freecode-ambient-paused')
  vi.restoreAllMocks()
})

describe('ui-theme client styles', () => {
  it('mounts every global sheet in dependency order and removes them on dispose', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin({
      apply(scope) { installThemeStyles(scope) },
    })
    fibers.add(fiber)
    await fiber.await()

    const styles = [...document.head.querySelectorAll<HTMLStyleElement>(`style[data-plugin="${PLUGIN_ID}"]`)]
    expect(styles.map(style => style.dataset.pluginCss)).toEqual([
      `${PLUGIN_ID}/base.css`,
      `${PLUGIN_ID}/corner-shape.css`,
      `${PLUGIN_ID}/design-platform.css`,
      `${PLUGIN_ID}/focus.css`,
      `${PLUGIN_ID}/onboarding.css`,
      `${PLUGIN_ID}/scrollbar.css`,
      `${PLUGIN_ID}/gradient-shadow-text.css`,
      `${PLUGIN_ID}/shiki.css`,
      `${PLUGIN_ID}/ambient.css`,
    ])
    await fiber.dispose()
    expect(document.head.querySelectorAll(`style[data-plugin="${PLUGIN_ID}"]`)).toHaveLength(0)
  })

  it('pauses decorative motion while hidden and releases its visibility subscription', async () => {
    const visibility = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    const ctx = new Context()
    const fiber = ctx.plugin({ apply(scope) { installThemeStyles(scope) } })
    fibers.add(fiber)
    await fiber.await()
    expect(document.documentElement.hasAttribute('data-freecode-ambient-paused')).toBe(false)
    visibility.mockReturnValue(true)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(document.documentElement.hasAttribute('data-freecode-ambient-paused')).toBe(true)
    visibility.mockReturnValue(false)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(document.documentElement.hasAttribute('data-freecode-ambient-paused')).toBe(false)
    await fiber.dispose()
    visibility.mockReturnValue(true)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(document.documentElement.hasAttribute('data-freecode-ambient-paused')).toBe(false)
  })

  it('restores a pre-existing paused marker when the theme is unloaded', async () => {
    document.documentElement.setAttribute('data-freecode-ambient-paused', 'previous')
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    const ctx = new Context()
    const fiber = ctx.plugin({ apply(scope) { installThemeStyles(scope) } })
    fibers.add(fiber)
    await fiber.await()
    expect(document.documentElement.hasAttribute('data-freecode-ambient-paused')).toBe(false)
    await fiber.dispose()
    expect(document.documentElement.getAttribute('data-freecode-ambient-paused')).toBe('previous')
  })

  it('does not acquire document effects outside a browser', () => {
    vi.stubGlobal('document', undefined)
    expect(() => { installThemeStyles(new Context()) }).not.toThrow()
  })
})
