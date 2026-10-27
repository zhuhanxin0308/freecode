// 通过真实 Web Loader 组合验证 free code 授权、回调、积分和头像恢复。
// 仅外部 SSO/网关由本地 HTTP 服务替代，浏览器和主机凭据链保持真实。
import { createServer, type Server } from 'node:http'
import { randomInt } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed, onTestFinished } from 'vitest'
import { compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, saveFailureShot } from './support.ts'

const OVERLAY_TEMPLATE = fileURLToPath(new URL('./fixtures/account-login/cordis.patch.yml', import.meta.url))
const MODE = webSnapshotMode()
const TOKEN = 'f'.repeat(43)
const CODE = 'web-login-code'
const AVATAR_EXPECTED = fileURLToPath(new URL('./expected/account-login/avatar-retry.expected.md', import.meta.url))
const MODELS_EXPECTED = fileURLToPath(new URL('./expected/account-login/platform-models.expected.md', import.meta.url))
const PLATFORM_MODEL = { id: 'platform-code', name: 'Platform Code', protocol: 'chat_completions',
  context_window: 262144, max_input_tokens: 229376, max_output_tokens: 32768,
  reasoning_efforts: ['low', 'medium', 'high'], default_reasoning_effort: 'medium' }

/** 本地 free code 协议服务：授权跳转、换码和登录后的资料读取。 */
async function mockPlatform() {
  const inits: Record<string, unknown>[] = []
  const pages: string[] = []
  const modelRequests: Record<string, unknown>[] = []
  let state: string | undefined
  let redirectUri: string | undefined
  let avatarRequests = 0
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method === 'GET' && req.headers['content-type'] === 'application/json') {
      res.writeHead(400).end('Bad Request')
      return
    }
    const reply = (payload: unknown): void => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    }
    if (url.pathname === '/login') {
      const redirect = url.searchParams.get('redirect')
      if (!redirect?.startsWith('/authorize?')) { res.writeHead(400).end(); return }
      res.writeHead(302, { location: redirect }).end()
      return
    }
    if (url.pathname === '/authorize') {
      pages.push(url.href)
      // The user approves at once: Platform returns the browser to the Host callback.
      const callback = new URL(redirectUri ?? '/')
      callback.searchParams.set('code', CODE)
      callback.searchParams.set('state', state ?? '')
      res.writeHead(302, { location: callback.href }).end()
      return
    }
    if (req.method === 'POST' && url.pathname.startsWith('/v1/auth/')) {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk: string) => { body += chunk })
      req.on('end', () => {
        const payload = JSON.parse(body) as Record<string, unknown>
        if (url.pathname === '/v1/auth/authorize') {
          inits.push(payload)
          state = 'freecode-web-state'
          redirectUri = String(payload.redirect_uri)
          const login = new URL('/login', origin)
          login.searchParams.set('redirect', `/authorize?state=${state}`)
          reply({ authorize_url: login.href, attempt_id: 'web', state, expires_at: Date.now() + 300000 })
          return
        }
        if (url.pathname === '/v1/auth/exchange' && payload.code === CODE && payload.state === state && payload.attempt_id === 'web') {
          reply({ access_token: TOKEN, token_type: 'Bearer', expires_at: Date.now() + 300000,
            user: { sub: 'web-user', username: 'web', nickname: 'Web User', avatar: `${origin}/avatar.svg` } })
          return
        }
        if (url.pathname === '/v1/auth/logout' && req.headers.authorization === `Bearer ${TOKEN}`) { reply({}); return }
        res.writeHead(404).end()
      })
      return
    }
    if (url.pathname === '/avatar.svg') {
      avatarRequests++
      if (avatarRequests < 3) { res.writeHead(503, { 'cache-control': 'no-store' }).end(); return }
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'max-age=3600' })
        .end('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="16" fill="blue"/></svg>')
      return
    }
    if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401).end(); return }
    if (url.pathname === '/v1/me') {
      reply({ user: { sub: 'web-user', username: 'web', nickname: 'Web User', avatar: `${origin}/avatar.svg` }, is_admin: false })
      return
    }
    if (url.pathname === '/v1/points') {
      reply({ balance: { available_units: '1234567', held_units: '2000000' }, units_per_point: '1000000' })
      return
    }
    if (url.pathname === '/v1/models') { reply({ data: [PLATFORM_MODEL] }); return }
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk: string) => { body += chunk })
      req.on('end', () => {
        modelRequests.push(JSON.parse(body) as Record<string, unknown>)
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        for (const event of [
          { choices: [{ index: 0, delta: { role: 'assistant', content: 'PLATFORM_MODEL_OK' }, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 } },
        ]) res.write(`data: ${JSON.stringify(event)}\n\n`)
        res.end('data: [DONE]\n\n')
      })
      return
    }
    res.writeHead(404).end()
  })
  // 本机动态端口范围包含浏览器禁用端口，直接原子绑定 IANA 高端口区间。
  const ephemeralPortStart = 49152
  const portExclusiveEnd = 65536
  const maxPortBindAttempts = 64
  for (let attempt = 0; attempt < maxPortBindAttempts; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(randomInt(ephemeralPortStart, portExclusiveEnd), '127.0.0.1', () => { server.removeListener('error', reject); resolve() })
      })
      break
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error)
        || !(error.code === 'EADDRINUSE' || process.platform === 'win32' && error.code === 'EACCES')
        || attempt === maxPortBindAttempts - 1) throw error
    }
  }
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('account login: missing mock listener')
  const origin = `http://127.0.0.1:${String(address.port)}`
  return {
    origin, inits, pages, modelRequests, avatarRequests: () => avatarRequests,
    close: () => new Promise<void>((resolve) => { server.close(() => { resolve() }); server.closeAllConnections() }),
  }
}

describe.skipIf(MODE === 'record')('web e2e: free code account sign-in in a plain browser', () => {
  let root: string | undefined
  let scaffold: WebScaffold
  let browser: Browser
  let platform: Awaited<ReturnType<typeof mockPlatform>>

  beforeAll(async () => {
    platform = await mockPlatform()
    root = await mkdtemp(join(tmpdir(), 'dsh-web-account-login-'))
    const overlay = join(root, 'account-login.overlay.yml')
    await writeFile(overlay, (await readFile(OVERLAY_TEMPLATE, 'utf8')).replaceAll('{{origin}}', platform.origin))
    scaffold = await launchWebScaffold({ extraOverlayPath: overlay })
    await scaffold.ctx.settings.update('llm-pi-ai', { providers: { 'user-owned': {
      displayName: 'Self Managed', api: 'openai-completions', baseURL: 'https://byok.example/v1',
      models: [{ id: 'private-model', contextWindow: 65536, maxTokens: 4096 }],
    } } })
    browser = await chromium.launch()
  })

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    await platform?.close()
    if (root !== undefined) await rm(root, { recursive: true, force: true })
  })

  it('登录后恢复头像、启用平台模型和三档思考，退出后保留自备模型配置', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: 'en-US', colorScheme: 'dark' })
    onTestFinished(() => context.close())
    const page = await context.newPage()
    const console = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'web-e2e-account-login'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    const observations: string[] = []
    observations.push(`signed-out.platform-models=${(await scaffold.ctx.llm.listModels('deepseek-account')).length}`)
    const menu = page.getByRole('button', { name: 'Account menu', exact: true })
    await menu.click()
    const tab = context.waitForEvent('page')
    await page.getByRole('menuitem', { name: 'Sign in', exact: true }).click()
    const authorization = await tab
    await authorization.waitForURL(url => url.pathname === '/oauth/callback', { timeout: 30_000 })
    expect(await authorization.evaluate(() => window.opener === null)).toBe(true)
    await expect.poll(() => menu.textContent(), { timeout: 30_000 }).toBe('Web User')

    const pageOrigin = new URL(scaffold.authenticatedUrl).origin
    expect(platform.inits).toHaveLength(1)
    expect(platform.inits[0]).toEqual({ redirect_uri: `${pageOrigin}/oauth/callback` })
    const [authorize] = platform.pages.map(href => new URL(href))
    expect(authorize?.searchParams.get('state')).toBe('freecode-web-state')
    expect(await authorization.locator('body').innerText()).toBe('Signed in. Return to free code.')
    await expect.poll(platform.avatarRequests).toBe(1)
    await menu.locator('[data-avatar-status="failed"]').waitFor()
    expect(await menu.locator('img').count()).toBe(0)
    const states: string[] = []
    const capture = async (stage: string): Promise<void> => {
      const sidebar = menu.locator('[data-avatar-status]')
      const account = page.getByRole('region', { name: 'Account', exact: true })
      const mounted = await account.count() > 0
      const settingsStatus = mounted
        ? await account.locator('[data-avatar-status]').getAttribute('data-avatar-status') : 'unmounted'
      states.push(`${stage}: sidebar=${await sidebar.getAttribute('data-avatar-status')}, settings=${settingsStatus}, `
        + `sidebarImages=${await menu.locator('img').count()}, settingsImages=${mounted ? await account.locator('img').count() : 0}, `
        + `requests=${platform.avatarRequests()}`)
    }
    await capture('Initial load')
    await menu.click()
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click()
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
    const account = settings.getByRole('region', { name: 'Account', exact: true })
    await account.getByText('Available points', { exact: true }).waitFor()
    expect(await account.getByText('1.234567', { exact: true }).count()).toBe(1)
    expect(await account.getByRole('link', { name: 'Account portal', exact: true }).getAttribute('href')).toBe(`${platform.origin}/account`)
    expect(await account.getByRole('link', { name: 'Top up', exact: true }).count()).toBe(0)
    await expect.poll(platform.avatarRequests).toBe(2)
    await account.locator('[data-avatar-status="failed"]').waitFor()
    expect(await menu.locator('img').count()).toBe(0)
    expect(await account.locator('img').count()).toBe(0)
    await capture('First Settings entry')
    await settings.getByRole('button', { name: 'Close', exact: true }).click()
    await settings.waitFor({ state: 'detached' })
    await menu.click()
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click()
    await expect.poll(() => menu.locator('img').count()).toBe(1)
    await expect.poll(() => account.locator('img').count()).toBe(1)
    for (const image of [menu.locator('img'), account.locator('img')]) {
      await expect.poll(() => image.evaluate(element =>
        element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0)).toBe(true)
      expect(await image.getAttribute('src')).toBe(`${platform.origin}/avatar.svg`)
    }
    await capture('Second Settings entry')
    await settings.getByRole('button', { name: 'Close', exact: true }).click()
    await settings.waitFor({ state: 'detached' })
    await menu.click()
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click()
    await account.waitFor()
    expect(await menu.locator('img').count()).toBe(1)
    expect(await account.locator('img').count()).toBe(1)
    expect(platform.avatarRequests()).toBe(3)
    await capture('Third Settings entry')
    await menu.locator('img').dispatchEvent('error')
    await menu.locator('[data-avatar-status="failed"]').waitFor()
    await account.locator('[data-avatar-status="failed"]').waitFor()
    expect(await menu.locator('img').count()).toBe(0)
    expect(await account.locator('img').count()).toBe(0)
    await capture('Rendered image failure')
    await settings.getByRole('button', { name: 'Close', exact: true }).click()
    await settings.waitFor({ state: 'detached' })
    await menu.click()
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click()
    await expect.poll(() => menu.locator('img').count()).toBe(1)
    await expect.poll(() => account.locator('img').count()).toBe(1)
    await capture('Settings entry after rendered failure')
    await compareOrRefreshGolden(AVATAR_EXPECTED, states.join('\n'), MODE)
    await settings.getByRole('button', { name: 'Close', exact: true }).click()
    await settings.waitFor({ state: 'detached' })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const trigger = page.getByRole('button', { name: /^Select model/ })
    await trigger.click()
    const modelCell = page.getByRole('menuitem', { name: /^Model / })
    if (await modelCell.isVisible()) await modelCell.click()
    await page.getByRole('menuitemradio', { name: PLATFORM_MODEL.name, exact: true }).click()
    await expect.poll(() => trigger.getAttribute('aria-label')).toBe('Select model, current Platform Code, reasoning effort Medium')
    await trigger.click()
    await page.getByRole('menuitem', { name: /^Effort / }).click()
    const levels = page.getByRole('menuitemradio')
    await expect.poll(() => levels.allTextContents()).toEqual(['Low', 'Medium', 'High'])
    observations.push(`signed-in.efforts=${(await levels.allTextContents()).join(',')}`)
    observations.push(`signed-in.default=${await page.getByRole('menuitemradio', { name: 'Medium', exact: true }).getAttribute('aria-checked')}`)
    await page.getByRole('menuitemradio', { name: 'High', exact: true }).click()
    const settled = scaffold.whenTurnSettled()
    await page.locator('[data-composer-input][contenteditable="true"]').last().fill('Confirm the platform model connection.')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    const sessionId = await settled
    await page.getByText('PLATFORM_MODEL_OK', { exact: true }).first().waitFor()
    const request = platform.modelRequests.find(value => value.model === PLATFORM_MODEL.id)
    expect(request).toMatchObject({ model: PLATFORM_MODEL.id, reasoning_effort: 'high', max_tokens: PLATFORM_MODEL.max_output_tokens })
    const session = scaffold.ctx.sessions.get(sessionId)
    const contextEvent = session?.snapshotEvents().find(event => event.type === 'request/context')
    expect(contextEvent).toMatchObject({ data: { contextWindow: PLATFORM_MODEL.context_window } })
    observations.push(`request.effort=${String(request?.reasoning_effort)}`)
    observations.push(`request.context-window=${contextEvent?.type === 'request/context' ? contextEvent.data.contextWindow : 'missing'}`)
    await menu.click()
    await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click()
    await page.getByRole('dialog', { name: 'Sign out', exact: true }).getByRole('button', { name: 'Sign out', exact: true }).click()
    await expect.poll(() => menu.textContent()).not.toBe('Web User')
    observations.push(`signed-out.platform-models=${(await scaffold.ctx.llm.listModels('deepseek-account')).length}`)
    const byok = await scaffold.ctx.llm.resolveModelInfo('user-owned', 'private-model')
    observations.push(`byok.context-window=${String(byok.context?.contextWindow)}`)
    await compareOrRefreshGolden(MODELS_EXPECTED, observations.join('\n'), MODE)
    expect(console.pageErrors).toEqual([])
    await context.close()
  }, 90_000)
})
