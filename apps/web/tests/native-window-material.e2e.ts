/** 在真实 Chromium 中加载原生窗口 HTML、脚本和样式；仅预加载 IPC 由夹具提供。 */
import { mkdir, mkdtemp } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium, type Browser } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolveDesktopLocale } from '../../desktop/src/locale.ts'
import type { UpdateDialogView } from '../../desktop/src/update-dialog.ts'
import type { MandatoryUpdateView } from '../../desktop/src/mandatory-update-window.ts'

/** 按 WCAG 的 sRGB 相对亮度计算文字与实色基底的对比度。 */
function contrast(first: string, second: string): number {
  const luminance = (color: string) => {
    const channels = color.match(/[\d.]+/g)?.map(Number)
    if (channels?.length !== 3) throw new Error(`Expected opaque RGB color: ${color}`)
    const [r, g, b] = channels.map((channel) => {
      const value = channel / 255
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
  }
  const a = luminance(first), b = luminance(second)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

describe('native window ambient material', { retry: 0 }, () => {
  let browser: Browser
  let screenshots: string

  beforeAll(async () => {
    const artifacts = fileURLToPath(new URL('../../../.artifacts/', import.meta.url))
    await mkdir(artifacts, { recursive: true })
    screenshots = await mkdtemp(join(artifacts, 'native-material-'))
    browser = await chromium.launch()
  })
  afterAll(async () => { await browser?.close() })

  for (const surface of ['welcome', 'update-dialog', 'mandatory-update'] as const) {
    it.each(['light', 'dark'] as const)(`${surface} %s preserves controls with moving, reduced-motion and opaque materials`, async (scheme) => {
      const viewport = surface === 'welcome' ? { width: 600, height: 700 } : { width: 880, height: 680 }
      const page = await browser.newPage({ viewport, colorScheme: scheme })
      const errors: string[] = []
      page.on('pageerror', (error) => { errors.push(error.message) })
      const locale = resolveDesktopLocale('zh-CN')
      const dialog: UpdateDialogView = { revision: 1, locale: locale.id, title: locale.messages.updateTitle,
        message: locale.messages.updateFailedTitle, detail: locale.messages.updateStopFailed,
        buttons: [locale.messages.updateAcknowledge], cancelId: 0, closeLabel: locale.messages.updateClose,
        technicalDetailsLabel: locale.messages.updateTechnicalDetails, technicalDetails: 'LOCAL_FIXTURE: update was not applied' }
      const mandatory: MandatoryUpdateView = { locale, deferred: false, policy: { blocking: true, checking: false },
        update: { phase: 'downloading', version: '0.2.1', percent: 48 } }
      try {
        await page.addInitScript(({ locale, dialog, mandatory }) => {
          Object.defineProperty(window, 'dshWelcome', { value: {
            ...locale, analyticsEnabled: async () => false, takeNotice: async () => undefined,
            onAccountState: () => () => {}, saveApiKey: async () => ({ ok: true }), skip: async () => {},
          } })
          Object.defineProperty(window, 'dshUpdateDialog', { value: {
            status: async () => dialog, respond: async () => {}, subscribe: () => () => {},
          } })
          Object.defineProperty(window, 'dshMandatoryUpdate', { value: {
            status: async () => mandatory, action: async () => {}, subscribe: () => () => {},
          } })
        }, { locale, dialog, mandatory })
        await page.goto(new URL(`../../desktop/renderer/${surface}.html`, import.meta.url).href)
        await page.locator(surface === 'welcome' ? '#api-key' : surface === 'update-dialog' ? '#actions button' : '#status').waitFor()
        await expect.poll(() => page.evaluate(() => getComputedStyle(document.body, '::before').animationName)).toBe('native-ambient-drift')
        const moving = await page.evaluate(async () => {
          const animations = document.getAnimations().filter(animation => animation.effect?.getTiming().iterations === Infinity)
          const running = animations.every(animation => animation.playState === 'running')
          const properties = animations.flatMap(animation => animation.effect instanceof KeyframeEffect
            ? animation.effect.getKeyframes().flatMap(frame => Object.keys(frame)) : [])
          for (const animation of animations) { animation.pause(); animation.currentTime = 0 }
          const start = getComputedStyle(document.body, '::before').transform
          for (const animation of animations) animation.currentTime = 12000
          await new Promise<void>((resolve) => { requestAnimationFrame(() => { resolve() }) })
          return { count: animations.length, running, start, end: getComputedStyle(document.body, '::before').transform,
            properties: [...new Set(properties)], pointerEvents: getComputedStyle(document.body, '::before').pointerEvents,
            filter: getComputedStyle(document.body, '::before').filter }
        })
        expect(moving.count).toBe(2)
        expect(moving.running).toBe(true)
        expect(moving.end).not.toBe(moving.start)
        expect(moving.properties.every(property => ['offset', 'computedOffset', 'easing', 'composite', 'transform', 'opacity'].includes(property))).toBe(true)
        expect(moving.pointerEvents).toBe('none')
        expect(moving.filter).toBe('none')
        const colors = await page.evaluate(() => {
          const sample = document.createElement('span')
          sample.hidden = true
          document.body.append(sample)
          try {
            return ['ink', 'muted', 'ground', 'solid', 'action', 'on-action'].map((name) => {
              sample.style.color = `var(--dsw-ambient-native-${name})`
              return getComputedStyle(sample).color
            })
          } finally { sample.remove() }
        })
        const [ink, muted, ground, solid, action, onAction] = colors
        for (const [foreground, background] of [[ink!, ground!], [muted!, ground!], [muted!, solid!], [onAction!, action!]] as const) {
          expect(contrast(foreground, background)).toBeGreaterThanOrEqual(4.5)
        }
        const control = page.locator(surface === 'welcome' ? '#api-key' : surface === 'update-dialog' ? '#close' : '#progress')
        expect(await control.evaluate((element) => {
          const box = element.getBoundingClientRect()
          return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))
        })).toBe(true)
        if (surface === 'welcome') {
          expect(await page.locator('.titlebar').evaluate(element => getComputedStyle(element).getPropertyValue('-webkit-app-region'))).toBe('drag')
          await page.screenshot({ path: join(screenshots, `welcome-entry-${scheme}.png`) })
          await control.click()
          await page.locator('#key-form input').waitFor()
          expect(await page.locator('#key-form input').evaluate(element => document.activeElement === element)).toBe(true)
        } else if (surface === 'update-dialog') {
          await page.keyboard.press('Tab')
          expect(await page.locator('#close').evaluate(element => document.activeElement === element)).toBe(true)
          await page.locator('summary').click()
          await page.locator('pre').waitFor()
        }
        await page.evaluate(async () => {
          await Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity)
            .map(animation => animation.finished))
        })
        await page.screenshot({ path: join(screenshots, `${surface}-${scheme}.png`) })
        if (surface !== 'welcome') {
          await page.setViewportSize({ width: 390, height: 600 })
          expect(await page.locator('main').evaluate((element) => {
            const box = element.getBoundingClientRect()
            return box.x >= 0 && box.y >= 0 && box.right <= innerWidth && box.bottom <= innerHeight
          })).toBe(true)
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
          await page.screenshot({ path: join(screenshots, `${surface}-${scheme}-compact.png`) })
        }
        await page.emulateMedia({ reducedMotion: 'reduce' })
        expect(await page.evaluate(() => getComputedStyle(document.body, '::before').animationName)).toBe('none')
        expect(await page.evaluate(() => document.getAnimations()
          .filter(animation => animation.effect?.getTiming().iterations === Infinity).length)).toBe(0)
        const session = await page.context().newCDPSession(page)
        await session.send('Emulation.setEmulatedMedia', { features: [
          { name: 'prefers-color-scheme', value: scheme }, { name: 'prefers-reduced-motion', value: 'reduce' },
          { name: 'prefers-reduced-transparency', value: 'reduce' },
        ] })
        expect(await page.evaluate(() => matchMedia('(prefers-reduced-transparency: reduce)').matches)).toBe(true)
        const opaque = await page.evaluate(() => ({
          display: getComputedStyle(document.body, '::before').display,
          background: getComputedStyle(document.body).backgroundColor,
          glass: [...document.querySelectorAll('main, input, .secondary')].map(element => getComputedStyle(element).backdropFilter),
        }))
        expect(opaque.display).toBe('none')
        expect(opaque.background).toBe(scheme === 'dark' ? 'rgb(13, 18, 32)' : 'rgb(247, 249, 255)')
        expect(opaque.glass.every(filter => filter === 'none')).toBe(true)
        await page.screenshot({ path: join(screenshots, `${surface}-${scheme}-opaque.png`) })
        expect(errors).toEqual([])
      } finally { await page.close() }
    })
  }
})
