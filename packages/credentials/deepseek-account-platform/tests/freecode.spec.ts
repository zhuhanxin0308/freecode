import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { randomInt } from 'node:crypto'
import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { credentialKey, type CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { FreeCodeAccount } from '../src/freecode.ts'
import type { AccountBonusOrderId, AccountUserId } from '@deepseek-ai/dsh-deepseek-account'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { vi.useRealTimers(); while (cleanups.length) await cleanups.pop()!(); vi.restoreAllMocks() })
const client = { version: '1', locale: 'zh', timezoneOffsetSeconds: 28800 }
const token = 'a'.repeat(43)
const EPHEMERAL_PORT_START = 49152
const PORT_EXCLUSIVE_END = 65536
const MAX_PORT_BIND_ATTEMPTS = 64

function barrier() {
  const gate = Promise.withResolvers<undefined>()
  return { promise: gate.promise, resolve: () => { gate.resolve(undefined) } }
}

async function bindPort(bind: (port: number) => Promise<void>) {
  // 直接绑定 IANA 动态端口；本机缩小的动态范围可能包含 Fetch 禁止端口。
  for (let attempt = 0; attempt < MAX_PORT_BIND_ATTEMPTS; attempt++) {
    try { await bind(randomInt(EPHEMERAL_PORT_START, PORT_EXCLUSIVE_END)); return }
    catch (error) {
      if (!(error instanceof Error) || !('code' in error)
        || !(error.code === 'EADDRINUSE' || process.platform === 'win32' && error.code === 'EACCES')
        || attempt === MAX_PORT_BIND_ATTEMPTS - 1) throw error
    }
  }
}

async function fixture(options: { attemptTimeoutMs?: number; logoutMaxRetries?: number; logoutRetryDelayMs?: number } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'freecode-account-'))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  const requests: Array<{ path: string; auth: string | undefined }> = []
  let redirect = ''
  let rejected = false
  let logoutFailed = false
  let invalidAuthorization = false
  const overrides = new Map<string, { status: number; body: string }[]>()
  const holds = new Map<string, { entered: ReturnType<typeof barrier>; release: ReturnType<typeof barrier>; body: boolean }>()
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    requests.push({ path: req.url!, auth: req.headers.authorization })
    const buffers: Buffer[] = []
    for await (const chunk of req) {
      const value: unknown = chunk
      if (!Buffer.isBuffer(value)) throw new Error('invalid request stream')
      buffers.push(value)
    }
    const body = buffers.length ? JSON.parse(Buffer.concat(buffers).toString()) as Record<string, string> : {}
    res.setHeader('content-type', 'application/json')
    const hold = holds.get(req.url ?? '')
    if (hold !== undefined && !hold.body) { hold.entered.resolve(); await hold.release.promise }
    const override = overrides.get(req.url ?? '')?.shift()
    if (override !== undefined) {
      res.statusCode = override.status
      if (hold?.body) {
        res.write(override.body.slice(0, 1))
        hold.entered.resolve()
        await hold.release.promise
        res.end(override.body.slice(1))
      } else res.end(override.body)
      return
    }
    if (req.url === '/v1/auth/authorize') {
      redirect = body.redirect_uri!
      res.end(JSON.stringify({ attempt_id: 'attempt-1', authorize_url: `${invalidAuthorization ? 'https://attacker.invalid' : origin}/authorize?state=verified-state`, expires_at: Date.now() + 60000 }))
    } else if (req.url === '/v1/auth/exchange') {
      expect(body).toEqual({ attempt_id: 'attempt-1', state: 'verified-state', code: 'code-1' })
      res.end(JSON.stringify({ access_token: token, token_type: 'Bearer', expires_at: Date.now() + 60000,
        user: { sub: '3', username: 'blues', nickname: 'Blue', avatar: '' } }))
    } else if (req.url === '/v1/me') {
      res.statusCode = rejected ? 401 : 200
      res.end(JSON.stringify({ user: { sub: '3', username: 'blues', nickname: 'Blue', avatar: '' }, is_admin: true }))
    } else if (req.url === '/v1/points') {
      res.end(JSON.stringify({ balance: { available_units: '1234567', held_units: '2000000' }, units_per_point: '1000000' }))
    } else if (req.url === '/v1/auth/logout') {
      res.statusCode = logoutFailed ? 503 : 200
      res.end('{}')
    } else { res.statusCode = 404; res.end('{}') }
  }
  const server = createServer((req, res) => { void handle(req, res).catch(() => { res.destroy() }) })
  await bindPort(port => new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve() })
  }))
  cleanups.push(() => new Promise<void>((resolve, reject) => {
    server.closeAllConnections()
    server.close((error) => { if (error) reject(error); else resolve() })
  }))
  const address = server.address()
  if (typeof address !== 'object' || address === null) throw new Error('missing address')
  const origin = `http://127.0.0.1:${address.port}`
  const ctx = new Context()
  let web: ReturnType<typeof ctx.plugin> | undefined
  await bindPort(async (port) => {
    web = ctx.plugin(WebServer, { host: '127.0.0.1', port })
    try { await web } catch (error) { await web.dispose(); throw error }
  })
  if (web === undefined) throw new Error('missing listener')
  const webFiber = web
  cleanups.push(() => webFiber.dispose())
  const credentials = ctx.plugin(LocalCredentialProvider, { path: join(home, 'credentials.yaml'), watch: false })
  await credentials
  cleanups.push(() => credentials.dispose())
  const authorization = ctx.plugin(AuthorizationService)
  await authorization
  cleanups.push(() => authorization.dispose())
  const settings = { origin, authorizationOrigin: origin, allowLoopbackHttp: true, logoutRetryDelayMs: 1, ...options }
  const provider = ctx.plugin(FreeCodeAccount, settings)
  await provider
  cleanups.push(() => provider.dispose())
  const callbackOrigin = `http://127.0.0.1:${ctx.webServer.port}`
  const login = async () => {
    await ctx.deepseekAccount.startSignIn(client, callbackOrigin, 'desktop')
    await expect.poll(async () => (await ctx.deepseekAccount.getState()).attempt?.phase).toBe('waiting-browser')
    const response = await fetch(`${redirect}?state=verified-state&code=code-1`)
    expect(response.status).toBe(200)
    await expect.poll(async () => (await ctx.deepseekAccount.getState()).attempt?.phase).toBe('succeeded')
  }
  return { ctx, origin, requests, login, callbackOrigin, provider, home, webFiber,
    hold: (path: string, body = false) => {
      const hold = { entered: barrier(), release: barrier(), body }
      holds.set(path, hold)
      cleanups.push(() => { hold.release.resolve(); return Promise.resolve() })
      return hold
    },
    override: (path: string, values: { status: number; body: string }[]) => overrides.set(path, values),
    restart: async () => {
      await provider.dispose()
      const next = ctx.plugin(FreeCodeAccount, settings)
      cleanups.push(() => next.dispose())
      await next
    },
    invalidAuthorization: () => { invalidAuthorization = true },
    setRejected: () => { rejected = true }, failLogout: () => { logoutFailed = true } }
}

it('浏览器登录只保存 free code 凭据，积分独立投影且不传给官方服务', async () => {
  const f = await fixture()
  expect(await f.ctx.deepseekAccount.getProfile(client)).toBeNull()
  expect(await f.ctx.deepseekAccount.getBalance(client)).toBeNull()
  expect(await f.ctx.deepseekAccount.getDeviceIdentity()).not.toHaveProperty('userId')
  expect((await f.ctx.deepseekAccount.signOut(client)).status).toBe('signed-out')
  await f.login()
  expect(await f.ctx.deepseekAccount.resolveToken(`${f.origin}/v1/chat/completions`)).toBe(token)
  expect(await f.ctx.deepseekAccount.resolveToken('https://api.deepseek.com')).toBeUndefined()
  expect(await f.ctx.deepseekAccount.getPlatformSession()).toBeNull()
  expect(JSON.stringify(await f.ctx.deepseekAccount.getState())).not.toContain(token)
  expect(await f.ctx.deepseekAccount.getProfile(client)).toMatchObject({ status: 'ready', value: { name: 'Blue', id: '3' } })
  expect(await f.ctx.deepseekAccount.getBalance(client)).toEqual({ status: 'ready', value: [], bonusWallets: [], points: { availableUnits: '1234567', heldUnits: '2000000', unitsPerPoint: '1000000' } })
  expect(await f.ctx.deepseekAccount.getUnnotifiedBonuses(client)).toBeNull()
  expect(await f.ctx.deepseekAccount.ackBonusNotified('3' as AccountUserId, 'legacy' as AccountBonusOrderId, client)).toBe(false)
  expect(f.requests.every(request => !request.path.includes('auth-api') && !request.path.includes('bonus'))).toBe(true)
  expect(f.requests.filter(r => ['/v1/me', '/v1/points'].includes(r.path)).every(r => r.auth === `Bearer ${token}`)).toBe(true)
})

it('错误 state 不消费登录，取消后回调不再写入凭据', async () => {
  const f = await fixture()
  await f.ctx.deepseekAccount.startSignIn(client, f.callbackOrigin, 'desktop')
  await expect.poll(async () => (await f.ctx.deepseekAccount.getState()).attempt?.phase).toBe('waiting-browser')
  expect((await fetch(`${f.callbackOrigin}/oauth/callback?state=bad&code=code-1`)).status).toBe(400)
  const state = await f.ctx.deepseekAccount.getState()
  await f.ctx.deepseekAccount.cancelSignIn(state.attempt!.id)
  expect((await f.ctx.deepseekAccount.getState()).attempt?.phase).toBe('cancelled')
  expect(await f.ctx.credentials.readRecord(credentialKey('freecode-account', 'default'))).toBeUndefined()
})

it('服务端拒绝凭据后清理当前账号；过期响应不能删除后来的凭据', async () => {
  const f = await fixture()
  await f.login()
  await f.ctx.deepseekAccount.rejectToken('other-token')
  expect((await f.ctx.deepseekAccount.getState()).status).toBe('credential-stored')
  f.setRejected()
  expect(await f.ctx.deepseekAccount.getProfile(client)).toBeNull()
  expect((await f.ctx.deepseekAccount.getState()).status).toBe('signed-out')
})

it('退出先删除本地凭据，远端暂时不可用也不能恢复登录', async () => {
  const f = await fixture()
  await f.login()
  f.failLogout()
  expect((await f.ctx.deepseekAccount.signOut(client)).status).toBe('signed-out')
  expect(await f.ctx.deepseekAccount.resolveToken(`${f.origin}/v1`)).toBeUndefined()
})

it('重启恢复独立账号会话，已过期凭据不再提供给网关', async () => {
  const f = await fixture()
  await f.login()
  await f.restart()
  expect(await f.ctx.deepseekAccount.resolveToken(`${f.origin}/v1`)).toBe(token)
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.now() + 120000)
  expect(await f.ctx.deepseekAccount.resolveToken(`${f.origin}/v1`)).toBeUndefined()
  expect((await f.ctx.deepseekAccount.getState()).status).toBe('signed-out')
})

it('服务端返回其他站点的授权地址时拒绝导航', async () => {
  const f = await fixture()
  f.invalidAuthorization()
  await f.ctx.deepseekAccount.startSignIn(client, f.callbackOrigin, 'desktop')
  await expect.poll(async () => (await f.ctx.deepseekAccount.getState()).attempt?.phase).toBe('failed')
  expect((await f.ctx.deepseekAccount.getState()).attempt?.authorizeUrl).toBeUndefined()
})

it('用户拒绝授权能结束等待，卸载会移除回调并结束订阅', async () => {
  const f = await fixture()
  await f.ctx.deepseekAccount.startSignIn(client, f.callbackOrigin, 'desktop')
  await expect.poll(async () => (await f.ctx.deepseekAccount.getState()).attempt?.phase).toBe('waiting-browser')
  expect((await fetch(`${f.callbackOrigin}/oauth/callback?state=verified-state&error=access_denied`)).status).toBe(200)
  await expect.poll(async () => (await f.ctx.deepseekAccount.getState()).attempt?.phase).toBe('failed')
  const subscription = f.ctx.deepseekAccount.watch(new AbortController().signal)[Symbol.asyncIterator]()
  expect((await subscription.next()).done).toBe(false)
  const pending = subscription.next()
  await f.provider.dispose()
  expect((await pending).done).toBe(true)
  expect((await fetch(`${f.callbackOrigin}/oauth/callback?state=verified-state&code=code-1`)).status).toBe(404)
})

it('只允许回环 HTTP 回调，令牌不会提供给同域的其他网页', async () => {
  const f = await fixture()
  await expect(f.ctx.deepseekAccount.startSignIn(client, 'https://remote.invalid', 'web')).rejects.toThrow()
  await f.login()
  expect(await f.ctx.deepseekAccount.resolveToken(`${f.origin}/account`)).toBeUndefined()
  expect(await f.ctx.deepseekAccount.resolveToken(`${f.origin.replace('://', '://user:password@')}/v1`)).toBeUndefined()
  expect(await f.ctx.deepseekAccount.getDeviceIdentity()).toMatchObject({ userId: '3' })
})

it('重复发起加入同一次登录，旧取消标识不能终止当前登录', async () => {
  const f = await fixture()
  const first = await f.ctx.deepseekAccount.startSignIn(client, f.callbackOrigin, 'desktop')
  const joined = await f.ctx.deepseekAccount.startSignIn(client, f.callbackOrigin, 'desktop')
  expect(joined.attempt?.id).toBe(first.attempt?.id)
  await f.ctx.deepseekAccount.cancelSignIn('older-attempt' as NonNullable<typeof first.attempt>['id'])
  await expect.poll(async () => (await f.ctx.deepseekAccount.getState()).attempt?.phase).toBe('waiting-browser')
  await f.ctx.deepseekAccount.cancelSignIn(first.attempt!.id)
  const retried = await f.ctx.deepseekAccount.startSignIn(client, f.callbackOrigin, 'desktop')
  expect(retried.attempt?.id).not.toBe(first.attempt?.id)
  await f.ctx.deepseekAccount.cancelSignIn(retried.attempt!.id)
})

it.each([
  { status: 503, body: '{}', code: 'network' },
  { status: 200, body: '{', code: 'protocol' },
  { status: 200, body: ' '.repeat(65537), code: 'protocol' },
])('授权响应被拒绝时保留可重试状态：$code', async ({ status, body, code }) => {
  const f = await fixture()
  f.override('/v1/auth/authorize', [{ status, body }])
  await f.ctx.deepseekAccount.startSignIn(client, f.callbackOrigin, 'desktop')
  await expect.poll(async () => (await f.ctx.deepseekAccount.getState()).attempt?.phase).toBe('failed')
  expect((await f.ctx.deepseekAccount.getState()).attempt?.errorCode).toBe(code)
})

it('服务器已过期的授权不能进入浏览器等待', async () => {
  const f = await fixture()
  f.override('/v1/auth/authorize', [{ status: 200, body: JSON.stringify({ attempt_id: 'expired', authorize_url: `${f.origin}/authorize?state=x`, expires_at: Date.now() - 1 }) }])
  await f.ctx.deepseekAccount.startSignIn(client, f.callbackOrigin, 'desktop')
  await expect.poll(async () => (await f.ctx.deepseekAccount.getState()).attempt?.phase).toBe('expired')
})

it('积分读取失败不会制造零余额，也不会清除仍有效的账号', async () => {
  const f = await fixture()
  await f.login()
  f.override('/v1/points', [{ status: 200, body: '{}' }])
  expect(await f.ctx.deepseekAccount.getBalance(client)).toEqual({ status: 'failed' })
  f.override('/v1/me', [{ status: 503, body: '{}' }])
  expect(await f.ctx.deepseekAccount.getProfile(client)).toEqual({ status: 'failed' })
  expect((await f.ctx.deepseekAccount.getState()).status).toBe('credential-stored')
})

it('临时失败的远端退出会在本地移除后重试', async () => {
  const f = await fixture()
  await f.login()
  f.override('/v1/auth/logout', [{ status: 503, body: '{}' }])
  await f.ctx.deepseekAccount.signOut(client)
  await expect.poll(() => f.requests.filter(request => request.path === '/v1/auth/logout').length).toBe(2)
  expect((await f.ctx.deepseekAccount.getState()).status).toBe('signed-out')
})

it('凭据提交失败不宣布登录成功，并撤销已签发的远端会话', async () => {
  const f = await fixture()
  await f.ctx.deepseekAccount.startSignIn(client, f.callbackOrigin, 'desktop')
  await expect.poll(async () => (await f.ctx.deepseekAccount.getState()).attempt?.phase).toBe('waiting-browser')
  await mkdir(join(f.home, 'credentials.yaml'))
  const response = await fetch(`${f.callbackOrigin}/oauth/callback?state=verified-state&code=code-1`)
  expect(await response.text()).toContain('登录未完成')
  await expect.poll(() => f.requests.some(request => request.path === '/v1/auth/logout')).toBe(true)
  await rm(join(f.home, 'credentials.yaml'), { recursive: true })
  expect((await f.ctx.deepseekAccount.getState()).attempt).toMatchObject({ phase: 'failed', errorCode: 'storage' })
})

it('重新启动不会复用其他环境签发的会话', async () => {
  const f = await fixture()
  await f.login()
  await f.ctx.credentials.modifyRecord(credentialKey('freecode-account', 'default'), (current) => {
    if (current?.kind !== 'grant' || typeof current.payload !== 'object' || current.payload === null || Array.isArray(current.payload)) throw new Error('missing grant')
    return Promise.resolve({ kind: 'grant', payload: { ...current.payload, issuer: 'https://another.invalid' } })
  })
  await expect(f.ctx.deepseekAccount.getState()).rejects.toThrow()
  await f.restart()
  expect((await f.ctx.deepseekAccount.getState()).status).toBe('signed-out')
})

it('卸载正在等待的登录会结束工作并清理路由', async () => {
  const f = await fixture()
  const account = f.ctx.deepseekAccount
  await account.startSignIn(client, f.callbackOrigin, 'desktop')
  await expect.poll(async () => (await account.getState()).attempt?.phase).toBe('waiting-browser')
  await f.provider.dispose()
  expect(await account.resolveToken(`${f.origin}/v1`)).toBeUndefined()
  expect((await fetch(`${f.callbackOrigin}/oauth/callback?state=verified-state&code=code-1`)).status).toBe(404)
})

it('SSO 登录页保留内层授权 state，公开 state 与内层一致后才接受回调', async () => {
  const f = await fixture()
  const authorization = new URL('/login', f.origin)
  authorization.searchParams.set('redirect', '/authorize?state=verified-state')
  f.override('/v1/auth/authorize', [{ status: 200, body: JSON.stringify({ attempt_id: 'attempt-1', authorize_url: authorization.href,
    state: 'verified-state', expires_at: Date.now() + 60000 }) }])
  await f.ctx.deepseekAccount.startSignIn(client, f.callbackOrigin, 'desktop')
  await expect.poll(async () => (await f.ctx.deepseekAccount.getState()).attempt?.phase).toBe('waiting-browser')
  expect((await f.ctx.deepseekAccount.getState()).attempt?.authorizeUrl).toBe(authorization.href)
  expect((await fetch(`${f.callbackOrigin}/oauth/callback?state=verified-state&code=code-1`)).status).toBe(200)
  expect((await f.ctx.deepseekAccount.getState()).status).toBe('credential-stored')
})

it.each([
  { redirect: 'https://attacker.invalid/authorize?state=x', state: 'x' },
  { redirect: '/authorize?state=x', state: 'different' },
  { redirect: '/authorize?state=x&state=y', state: 'x' },
  { redirect: '/account?state=x', state: 'x' },
])('拒绝被修改的登录后跳转：$redirect', async ({ redirect, state }) => {
  const f = await fixture()
  const login = new URL('/login', f.origin)
  login.searchParams.set('redirect', redirect)
  f.override('/v1/auth/authorize', [{ status: 200, body: JSON.stringify({ attempt_id: 'attempt-1', authorize_url: login.href,
    state, expires_at: Date.now() + 60000 }) }])
  await f.ctx.deepseekAccount.startSignIn(client, f.callbackOrigin, 'desktop')
  await expect.poll(async () => (await f.ctx.deepseekAccount.getState()).attempt?.phase).toBe('failed')
  expect((await f.ctx.deepseekAccount.getState()).attempt?.authorizeUrl).toBeUndefined()
})

it.each([
  { kind: 'api-key', key: 'unrelated-key' },
  { kind: 'grant', payload: { version: 99, token: 'damaged' } },
] satisfies CredentialRecord[])('损坏的磁盘账号记录拒绝恢复且不会发出认证请求：$kind', async (record) => {
  const f = await fixture()
  await f.ctx.credentials.modifyRecord(credentialKey('freecode-account', 'default'), () => Promise.resolve(record))
  await expect(f.ctx.deepseekAccount.getState()).rejects.toThrow()
  await expect(f.restart()).rejects.toThrow()
  expect(f.requests).toEqual([])
})

it('其他提供方的凭据变动不刷新或覆盖 free code 账号', async () => {
  const f = await fixture()
  await f.login()
  await f.ctx.credentials.modifyRecord(credentialKey('other-provider', 'default'), () => Promise.resolve({ kind: 'grant', payload: {} }))
  expect(await f.ctx.deepseekAccount.resolveToken(`${f.origin}/v1`)).toBe(token)
  await f.ctx.deepseekAccount.rejectToken('not-current')
  expect((await f.ctx.deepseekAccount.getState()).status).toBe('credential-stored')
})

it('本地退出提交期间禁止重用令牌，新登录等待退出完成', async () => {
  const f = await fixture()
  await f.login()
  const entered = barrier()
  const release = barrier()
  const original = f.ctx.credentials.deleteRecord.bind(f.ctx.credentials)
  const spy = vi.spyOn(f.ctx.credentials, 'deleteRecord').mockImplementation(async (key) => {
    entered.resolve()
    await release.promise
    return original(key)
  })
  try {
    const out = f.ctx.deepseekAccount.signOut(client)
    await entered.promise
    expect(await f.ctx.deepseekAccount.resolveToken(`${f.origin}/v1`)).toBeUndefined()
    const login = f.ctx.deepseekAccount.startSignIn(client, f.callbackOrigin, 'desktop')
    expect(f.requests.filter(request => request.path === '/v1/auth/authorize')).toHaveLength(1)
    release.resolve()
    expect((await out).status).toBe('signed-out')
    expect((await login).attempt?.phase).toBe('initializing')
  } finally { release.resolve(); spy.mockRestore() }
})

it.each([200, 503])('退出后的迟到资料响应不会恢复旧账号：HTTP %s', async (status) => {
  const f = await fixture()
  await f.login()
  const hold = f.hold('/v1/me')
  if (status !== 200) f.override('/v1/me', [{ status, body: '{}' }])
  const profile = f.ctx.deepseekAccount.getProfile(client)
  await hold.entered.promise
  await f.ctx.deepseekAccount.signOut(client)
  hold.release.resolve()
  expect(await profile).toBeNull()
  expect((await f.ctx.deepseekAccount.getState()).status).toBe('signed-out')
})

it('换码在途时重复回调返回410，只有首个回调可以提交账号', async () => {
  const f = await fixture()
  const hold = f.hold('/v1/auth/exchange')
  await f.ctx.deepseekAccount.startSignIn(client, f.callbackOrigin, 'desktop')
  await expect.poll(async () => (await f.ctx.deepseekAccount.getState()).attempt?.phase).toBe('waiting-browser')
  const url = `${f.callbackOrigin}/oauth/callback?state=verified-state&code=code-1`
  const first = fetch(url)
  await hold.entered.promise
  expect((await fetch(url)).status).toBe(410)
  hold.release.resolve()
  expect((await first).status).toBe(200)
  expect(f.requests.filter(request => request.path === '/v1/auth/exchange')).toHaveLength(1)
})

it('换码迟于授权期限时不提交已签发令牌，并撤销该远端会话', async () => {
  const f = await fixture()
  const hold = f.hold('/v1/auth/exchange')
  await f.ctx.deepseekAccount.startSignIn(client, f.callbackOrigin, 'desktop')
  await expect.poll(async () => (await f.ctx.deepseekAccount.getState()).attempt?.phase).toBe('waiting-browser')
  const pending = fetch(`${f.callbackOrigin}/oauth/callback?state=verified-state&code=code-1`)
  await hold.entered.promise
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.now() + 120000)
  hold.release.resolve()
  expect((await pending).status).toBe(200)
  expect((await f.ctx.deepseekAccount.getState()).attempt?.phase).toBe('expired')
  expect(await f.ctx.deepseekAccount.resolveToken(`${f.origin}/v1`)).toBeUndefined()
  await expect.poll(() => f.requests.some(request => request.path === '/v1/auth/logout')).toBe(true)
})

it('等待浏览器的真实期限到达后清理回调；取消订阅不影响登录操作', async () => {
  const f = await fixture({ attemptTimeoutMs: 10000 })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const signal = new AbortController()
  const wait = (async () => {
    for await (const state of f.ctx.deepseekAccount.watch(signal.signal)) if (state.attempt?.phase === 'waiting-browser') return state
    throw new Error('missing waiting state')
  })()
  await f.ctx.deepseekAccount.startSignIn(client, f.callbackOrigin, 'desktop')
  await wait
  signal.abort()
  await vi.advanceTimersByTimeAsync(10000)
  expect((await f.ctx.deepseekAccount.getState()).attempt?.phase).toBe('expired')
  vi.useRealTimers()
  expect((await fetch(`${f.callbackOrigin}/oauth/callback?state=verified-state&code=code-1`)).status).toBe(404)
})

it('卸载会中止正在读取的资料流，并等待请求清理完成', async () => {
  const f = await fixture()
  await f.login()
  const hold = f.hold('/v1/me', true)
  f.override('/v1/me', [{ status: 200, body: '{"user":' }])
  const profile = f.ctx.deepseekAccount.getProfile(client)
  await hold.entered.promise
  await f.provider.dispose()
  expect(await profile).toBeNull()
  hold.release.resolve()
})

it('未经账号入口发起的授权拒绝旁路，不读取其他凭据', async () => {
  const f = await fixture()
  await expect(f.ctx.authorization.begin({ key: credentialKey('freecode-account', 'default'),
    interaction: { notify: () => undefined, prompt: () => Promise.reject(new Error('unexpected prompt')) } })).rejects.toThrow()
  await f.ctx.deepseekAccount.rejectToken('absent')
  const account = f.ctx.deepseekAccount
  await f.provider.dispose()
  await account.rejectToken(token)
  expect(f.requests).toEqual([])
})

it('回调服务器被卸载时拒绝登录，不调用远端授权', async () => {
  const f = await fixture()
  await f.webFiber.dispose()
  await f.ctx.deepseekAccount.startSignIn(client, f.callbackOrigin, 'desktop')
  await expect.poll(async () => (await f.ctx.deepseekAccount.getState()).attempt?.phase).toBe('failed')
  expect(f.requests).toEqual([])
})

it('缺少昵称时使用账号名，英文授权拒绝回执不包含远端原始错误', async () => {
  const f = await fixture()
  await f.login()
  f.override('/v1/me', [{ status: 200, body: JSON.stringify({ user: { sub: '3', username: 'blues', nickname: '', avatar: '' }, is_admin: false }) }])
  expect(await f.ctx.deepseekAccount.getProfile(client)).toMatchObject({ status: 'ready', value: { name: 'blues' } })
  await f.ctx.deepseekAccount.signOut(client)
  await f.ctx.deepseekAccount.startSignIn({ ...client, locale: 'en' }, f.callbackOrigin, 'desktop')
  await expect.poll(async () => (await f.ctx.deepseekAccount.getState()).attempt?.phase).toBe('waiting-browser')
  const response = await fetch(`${f.callbackOrigin}/oauth/callback?state=verified-state&error=access_denied&error_description=private-detail`)
  expect(await response.text()).toBe('Sign-in did not finish. Return to free code and try again.')
})

it('无内容的认证响应不能被当成有效 JSON 或成功登录', async () => {
  const f = await fixture()
  f.override('/v1/auth/authorize', [{ status: 204, body: '' }])
  await f.ctx.deepseekAccount.startSignIn(client, f.callbackOrigin, 'desktop')
  await expect.poll(async () => (await f.ctx.deepseekAccount.getState()).attempt?.phase).toBe('failed')
})

it('远端退出重试达到配置上限后仍保持本地退出，并给出不含令牌的诊断', async () => {
  const f = await fixture({ logoutMaxRetries: 1 })
  await f.login()
  f.failLogout()
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  await f.ctx.deepseekAccount.signOut(client)
  await expect.poll(() => warn.mock.calls.length).toBe(1)
  expect(f.requests.filter(request => request.path === '/v1/auth/logout')).toHaveLength(2)
  expect(warn).toHaveBeenCalledWith('[freecode-account] remote sign-out unavailable')
  expect((await f.ctx.deepseekAccount.getState()).status).toBe('signed-out')
})

it('插件卸载取消等待中的远端退出重试', async () => {
  const f = await fixture({ logoutRetryDelayMs: 60000 })
  await f.login()
  f.failLogout()
  await f.ctx.deepseekAccount.signOut(client)
  await expect.poll(() => f.requests.filter(request => request.path === '/v1/auth/logout').length).toBe(1)
  await f.provider.dispose()
  expect(f.requests.filter(request => request.path === '/v1/auth/logout')).toHaveLength(1)
})

it('初始化请求未完成时总授权期限仍会中止请求', async () => {
  const f = await fixture({ attemptTimeoutMs: 10000 })
  const hold = f.hold('/v1/auth/authorize')
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  await f.ctx.deepseekAccount.startSignIn(client, f.callbackOrigin, 'desktop')
  await hold.entered.promise
  await vi.advanceTimersByTimeAsync(10000)
  vi.useRealTimers()
  await expect.poll(async () => (await f.ctx.deepseekAccount.getState()).attempt?.phase).toBe('expired')
  hold.release.resolve()
})

it.each(['/login', '/login?redirect=%2Fauthorize%3Fstate%3Dx&redirect=%2Fauthorize%3Fstate%3Dy'])('拒绝缺失或重复的登录重定向：%s', async (path) => {
  const f = await fixture()
  f.override('/v1/auth/authorize', [{ status: 200, body: JSON.stringify({ attempt_id: 'attempt-1', authorize_url: `${f.origin}${path}`, expires_at: Date.now() + 60000 }) }])
  await f.ctx.deepseekAccount.startSignIn(client, f.callbackOrigin, 'desktop')
  await expect.poll(async () => (await f.ctx.deepseekAccount.getState()).attempt?.phase).toBe('failed')
})

it('终态之后同时重试只创建一次新授权', async () => {
  const f = await fixture()
  const first = await f.ctx.deepseekAccount.startSignIn(client, f.callbackOrigin, 'desktop')
  await f.ctx.deepseekAccount.cancelSignIn(first.attempt!.id)
  const [one, two] = await Promise.all([
    f.ctx.deepseekAccount.startSignIn(client, f.callbackOrigin, 'desktop'),
    f.ctx.deepseekAccount.startSignIn(client, f.callbackOrigin, 'desktop'),
  ])
  expect(one.attempt?.id).toBe(two.attempt?.id)
  expect(one.attempt?.id).not.toBe(first.attempt?.id)
})

it('已准入的凭据提交不会被取消打断，取消等待相同提交完成', async () => {
  const f = await fixture()
  const entered = barrier()
  const release = barrier()
  const original = f.ctx.credentials.modifyRecord.bind(f.ctx.credentials)
  const modify = vi.spyOn(f.ctx.credentials, 'modifyRecord').mockImplementation(async (key, mutate) => {
    entered.resolve()
    await release.promise
    return original(key, mutate)
  })
  try {
    await f.ctx.deepseekAccount.startSignIn({ ...client, locale: 'en' }, f.callbackOrigin, 'desktop')
    await expect.poll(async () => (await f.ctx.deepseekAccount.getState()).attempt?.phase).toBe('waiting-browser')
    const callback = fetch(`${f.callbackOrigin}/oauth/callback?state=verified-state&code=code-1`)
    await entered.promise
    const state = await f.ctx.deepseekAccount.getState()
    expect(state.attempt?.phase).toBe('committing')
    const cancellation = f.ctx.deepseekAccount.cancelSignIn(state.attempt!.id)
    release.resolve()
    expect((await cancellation).status).toBe('credential-stored')
    expect(await (await callback).text()).toBe('Signed in. Return to free code.')
  } finally { release.resolve(); modify.mockRestore() }
})

it('浏览器授权不接受额外的交互式密钥提示，底层错误只投影固定错误码', async () => {
  const f = await fixture()
  const begin = vi.spyOn(f.ctx.authorization, 'begin').mockImplementation(async (request) => {
    request.interaction.notify({ message: 'private diagnostics' })
    await expect(request.interaction.prompt({ kind: 'text', message: 'unexpected credential prompt' })).rejects.toThrow()
    throw new Error('private diagnostics')
  })
  try {
    await f.ctx.deepseekAccount.startSignIn(client, f.callbackOrigin, 'desktop')
    await expect.poll(async () => (await f.ctx.deepseekAccount.getState()).attempt?.phase).toBe('failed')
    expect(JSON.stringify(await f.ctx.deepseekAccount.getState())).not.toContain('private diagnostics')
  } finally { begin.mockRestore() }
})

it('回调拒绝缺失 URL、畸形 URL 和无 state 参数的请求', async () => {
  const f = await fixture()
  const register = vi.spyOn(f.ctx.webServer, 'register')
  await f.ctx.deepseekAccount.startSignIn(client, f.callbackOrigin, 'desktop')
  await expect.poll(async () => (await f.ctx.deepseekAccount.getState()).attempt?.phase).toBe('waiting-browser')
  const route = register.mock.calls.find(([value]) => value.kind === 'exact' && value.path === '/oauth/callback')?.[0]
  if (route === undefined) throw new Error('missing callback')
  for (const url of [undefined, 'http://[', '/oauth/callback?code=code-1']) {
    const socket = new Socket()
    const request = new IncomingMessage(socket)
    request.method = 'GET'
    request.url = url
    const response = new ServerResponse(request)
    await route.handler(request, response)
    expect(response.statusCode).toBe(400)
    socket.destroy()
  }
})

it('回调不能同时声明成功码与授权错误', async () => {
  const f = await fixture()
  await f.ctx.deepseekAccount.startSignIn(client, f.callbackOrigin, 'desktop')
  await expect.poll(async () => (await f.ctx.deepseekAccount.getState()).attempt?.phase).toBe('waiting-browser')
  const response = await fetch(`${f.callbackOrigin}/oauth/callback?state=verified-state&code=code-1&error=access_denied`)
  expect(response.status).toBe(400)
  expect((await f.ctx.deepseekAccount.getState()).attempt?.phase).toBe('waiting-browser')
})

it('资料正文读取期间退出插件会等待读取器清理完成', async () => {
  const f = await fixture()
  await f.login()
  const hold = f.hold('/v1/me', true)
  f.override('/v1/me', [{ status: 200, body: '{"user":' }])
  const reading = barrier()
  const nativeFetch = globalThis.fetch
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const response = await nativeFetch(input, init)
    if (response.body === null) throw new Error('missing streaming body')
    const getReader = response.body.getReader.bind(response.body)
    vi.spyOn(response.body, 'getReader').mockImplementation(() => {
      const reader = getReader()
      const read = reader.read.bind(reader)
      let count = 0
      vi.spyOn(reader, 'read').mockImplementation(() => {
        const pending = read()
        if (++count === 2) reading.resolve()
        return pending
      })
      return reader
    })
    return response
  })
  const profile = f.ctx.deepseekAccount.getProfile(client)
  await reading.promise
  await f.provider.dispose()
  expect(await profile).toBeNull()
  hold.release.resolve()
})

it('换码正文读取结束但提交尚未准入时取消，会撤销已返回的会话', async () => {
  const f = await fixture()
  const nativeFetch = globalThis.fetch
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const response = await nativeFetch(input, init)
    if (typeof input === 'string' && input.endsWith('/v1/auth/exchange') && response.body !== null) {
      const getReader = response.body.getReader.bind(response.body)
      vi.spyOn(response.body, 'getReader').mockImplementation(() => {
        const reader = getReader()
        const cancel = reader.cancel.bind(reader)
        vi.spyOn(reader, 'cancel').mockImplementation(async (reason) => {
          await cancel(reason)
          f.ctx.authorization.cancel(credentialKey('freecode-account', 'default'))
        })
        return reader
      })
    }
    return response
  })
  await f.ctx.deepseekAccount.startSignIn(client, f.callbackOrigin, 'desktop')
  await expect.poll(async () => (await f.ctx.deepseekAccount.getState()).attempt?.phase).toBe('waiting-browser')
  await fetch(`${f.callbackOrigin}/oauth/callback?state=verified-state&code=code-1`)
  expect((await f.ctx.deepseekAccount.getState()).status).toBe('signed-out')
  await expect.poll(() => f.requests.some(request => request.path === '/v1/auth/logout')).toBe(true)
})
