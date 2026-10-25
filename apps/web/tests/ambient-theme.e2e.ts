/** 使用真实 Web 组合验证动态弥散、无障碍退化和浮层交互，不发起模型请求。 */
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, openSettings, REPO_ROOT } from './support.ts'

let scaffold: WebScaffold
let browser: Browser
let shots: string

beforeAll(async () => {
  scaffold = await launchWebScaffold()
  browser = await chromium.launch()
  await mkdir(join(REPO_ROOT, '.artifacts'), { recursive: true })
  shots = await mkdtemp(join(REPO_ROOT, '.artifacts', 'ambient-theme-'))
  console.log(`Ambient theme screenshots: ${shots}`)
})

afterAll(async () => {
  try { await browser?.close() } finally { await scaffold?.close() }
})

async function readyPage(mode: 'light' | 'dark'): Promise<Page> {
  await scaffold.ctx.settings.mutate('ui-theme', [{ op: 'set', path: ['preference'], value: mode }])
  const page = await newEnglishPage(browser)
  try {
    await page.emulateMedia({ reducedMotion: 'no-preference', colorScheme: mode })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.getByRole('textbox', { name: 'Choose workspace', exact: true }).waitFor()
    await expect.poll(() => page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))).toBe(mode === 'dark')
    return page
  } catch (error) {
    await page.close()
    throw error
  }
}

async function ambientTransform(page: Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.body, '::before').transform)
}

it.each(['light', 'dark'] as const)('%s moves behind the workspace while menus and settings remain usable', async (mode) => {
  const page = await readyPage(mode)
  const consoleState = watchConsole(page)
  try {
    const paint = await page.evaluate(() => {
      const style = getComputedStyle(document.body, '::before')
      return { image: style.backgroundImage, hit: style.pointerEvents, position: style.position, filter: style.filter }
    })
    expect(paint.image).toContain('radial-gradient')
    expect(paint).toMatchObject({ hit: 'none', position: 'fixed', filter: 'none' })
    const start = await ambientTransform(page)
    await expect.poll(() => ambientTransform(page)).not.toBe(start)
    await page.screenshot({ path: join(shots, `workspace-${mode}.png`) })

    await openSettings(page, 'en')
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
    await settings.waitFor()
    await page.screenshot({ path: join(shots, `settings-${mode}.png`) })
    await page.keyboard.press('Escape')
    await settings.waitFor({ state: 'hidden' })

    const collapse = page.getByRole('button', { name: 'Collapse sidebar', exact: true })
    await collapse.click()
    await page.getByRole('button', { name: 'Open sidebar', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Open sidebar', exact: true }).click()
    await collapse.waitFor()

    for (const width of [390, 880, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      const menu = page.getByRole('button', { name: 'Account menu', exact: true })
      await menu.click()
      await page.getByRole('menuitem', { name: 'Settings', exact: true }).waitFor()
      await page.keyboard.press('Escape')
      await page.screenshot({ path: join(shots, `workspace-${mode}-${width}.png`) })
    }
    expect(consoleState.pageErrors).toEqual([])
  } finally { await page.close() }
})

it('stops decorative movement when reduced motion is requested', async () => {
  const page = await readyPage('dark')
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.body, '::before').animationName)).toBe('none')
    expect(await page.evaluate(() => getComputedStyle(document.body, '::after').animationName)).toBe('none')
    await page.screenshot({ path: join(shots, 'reduced-motion-dark.png') })
  } finally { await page.close() }
})

it.each(['light', 'dark'] as const)('%s uses opaque surfaces when reduced transparency is requested', async (mode) => {
  const page = await readyPage(mode)
  try {
    const session = await page.context().newCDPSession(page)
    await session.send('Emulation.setEmulatedMedia', { features: [
      { name: 'prefers-reduced-transparency', value: 'reduce' },
      { name: 'prefers-reduced-motion', value: 'reduce' },
    ] })
    await expect.poll(() => page.evaluate(() => matchMedia('(prefers-reduced-transparency: reduce)').matches)).toBe(true)
    const surfaces = await page.evaluate(() => {
      const probe = document.createElement('span')
      probe.hidden = true
      document.body.append(probe)
      try {
        return ['--dsw-alias-ambient-workspace-fill', '--dsw-specific-sidebar-fill', '--dsw-specific-input-major',
          '--dsw-alias-settings-card-fill'].map((name) => {
          probe.style.backgroundColor = `var(${name})`
          return getComputedStyle(probe).backgroundColor
        })
      } finally { probe.remove() }
    })
    expect(surfaces.every(value => /^rgb\(\d+, \d+, \d+\)$/.test(value))).toBe(true)
    await page.screenshot({ path: join(shots, `opaque-${mode}.png`) })
  } finally { await page.close() }
})
