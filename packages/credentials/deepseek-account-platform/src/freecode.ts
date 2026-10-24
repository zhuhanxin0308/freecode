/** free code 登录提供方；SSO 凭据始终留在服务端，本机只保存独立会话。 */
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { platform, release } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import type { ServerResponse } from 'node:http'
import { Context, Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { DeepSeekAccount, installAccountTaskCancellation, type AccountClientMetadata, type AccountDetails, type AccountUserId, type AccountView, type SignInAttemptId, type SignInAttemptView } from '@deepseek-ai/dsh-deepseek-account'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { loginOrigin, platformOrigin, PlatformAuthError } from './protocol.ts'

const KEY = credentialKey('freecode-account', 'default')
const userSchema = z.object({ sub: z.string().min(1), username: z.string(), nickname: z.string(), avatar: z.string() })
const storedSchema = z.object({
  version: z.literal(1), issuer: z.url(), token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  expiresAt: z.number().int().positive(), user: userSchema, revoked: z.boolean().optional(),
})
const initSchema = z.object({
  attempt_id: z.string().min(1), authorize_url: z.url(), expires_at: z.number().int().positive(), state: z.string().min(1).optional(),
})
const exchangeSchema = z.object({ access_token: storedSchema.shape.token, token_type: z.literal('Bearer'), expires_at: z.number().int().positive(), user: userSchema })
const pointsSchema = z.object({
  balance: z.object({ available_units: z.string().regex(/^\d+$/), held_units: z.string().regex(/^\d+$/) }),
  units_per_point: z.string().regex(/^[1-9]\d*$/),
})

/** free code 的服务地址和各操作时限。 */
export interface FreeCodeConfig {
  origin?: string
  authorizationOrigin?: string
  allowLoopbackHttp?: boolean
  requestTimeoutMs?: number
  attemptTimeoutMs?: number
  maxResponseBytes?: number
  logoutMaxRetries?: number
  logoutRetryDelayMs?: number
}
/** 加载时验证部署配置；开发 HTTP 仅允许回环地址。 */
export const FreeCodeConfig = Schema.object({
  origin: Schema.string().default('https://freecode.mymyjd.cn'),
  authorizationOrigin: Schema.string().default('https://auth.mymyjd.com'),
  allowLoopbackHttp: Schema.boolean().default(false),
  requestTimeoutMs: Schema.number().min(1).max(120_000).default(30_000),
  attemptTimeoutMs: Schema.number().min(1).max(3_600_000).default(600_000),
  maxResponseBytes: Schema.number().min(1024).max(1_048_576).default(65_536),
  logoutMaxRetries: Schema.number().min(0).max(5).step(1).default(5),
  logoutRetryDelayMs: Schema.number().min(1).max(60_000).default(1_000),
})

interface Attempt {
  view: SignInAttemptView
  origin: string
  chinese: boolean
  controller: AbortController
  done: Promise<void>
  running: Promise<void>
  response?: ServerResponse
  dispose?: () => Promise<void>
}

/** 承载浏览器授权、凭据持久化和安全账号投影。 */
export class FreeCodeAccount extends DeepSeekAccount {
  static inject = ['credentials', 'authorization']
  static Config = FreeCodeConfig
  private readonly options: ReturnType<typeof FreeCodeConfig>
  private readonly origin: string
  private readonly authorizationOrigin: string
  private readonly lifetime = new AbortController()
  private readonly listeners = new Set<() => void>()
  private readonly revocations = new Set<Promise<void>>()
  private readonly requests = new Set<Promise<unknown>>()
  private attempt: Attempt | undefined
  private removing: Promise<AccountView> | undefined
  private generation = 0

  /** @param ctx - 本机凭据和授权服务。 @param config - 服务地址和超时设置。 */
  constructor(ctx: Context, config: FreeCodeConfig = {}) {
    super(ctx)
    this.options = FreeCodeConfig(config)
    this.origin = platformOrigin(this.options.origin, this.options.allowLoopbackHttp)
    this.authorizationOrigin = platformOrigin(this.options.authorizationOrigin, this.options.allowLoopbackHttp)
    installAccountTaskCancellation(ctx)
    ctx.authorization.registerFlow({ key: KEY, label: 'free code', methods: [{ id: 'browser', label: 'SSO' }], run: (session) => {
      const attempt = this.attempt
      if (attempt === undefined) return Promise.reject(new PlatformAuthError('protocol'))
      attempt.running = this.run(session, attempt)
      return attempt.running
    } })
    ctx.on('credentials/record-updated', (key) => {
      if (key !== KEY) return
      this.generation++
      this.changed()
    })
    ctx.effect(() => async () => {
      this.lifetime.abort()
      if (this.attempt !== undefined) await this.cancelSignIn(this.attempt.view.id)
      await this.removing
      await Promise.all(this.revocations)
      await Promise.allSettled(this.requests)
      this.changed()
    }, 'freecode: 账号操作生命周期')
  }

  async [Service.init](): Promise<void> {
    const record = await this.ctx.credentials.readRecord(KEY)
    if (record === undefined) return
    if (record.kind !== 'grant') throw new PlatformAuthError('storage')
    const parsed = storedSchema.safeParse(record.payload)
    if (!parsed.success) throw new PlatformAuthError('storage')
    if (parsed.data.issuer !== this.origin || parsed.data.expiresAt <= Date.now()) await this.ctx.credentials.deleteRecord(KEY)
  }

  private async stored() {
    if (this.lifetime.signal.aborted) return undefined
    const record = await this.ctx.credentials.readRecord(KEY)
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 等待存储期间插件可能已经卸载。
    if (record === undefined || this.lifetime.signal.aborted) return undefined
    if (record.kind !== 'grant') throw new PlatformAuthError('storage')
    const parsed = storedSchema.safeParse(record.payload)
    if (!parsed.success || parsed.data.issuer !== this.origin) throw new PlatformAuthError('storage')
    if (parsed.data.revoked) return undefined
    if (parsed.data.expiresAt <= Date.now()) {
      await this.rejectToken(parsed.data.token)
      return undefined
    }
    return parsed.data
  }

  override async getState(): Promise<AccountView> {
    const stored = await this.stored()
    return { status: stored === undefined ? 'signed-out' : 'credential-stored', provider: 'freecode',
      links: { usageUrl: `${this.origin}/account`, topUpUrl: `${this.origin}/account`, external: true },
      attempt: this.attempt?.view ?? null }
  }

  override async getProfile(_client: AccountClientMetadata): Promise<AccountDetails['profile'] | null> {
    const result = await this.detail('/v1/me', z.object({ user: userSchema, is_admin: z.boolean() }))
    if (result === null || result === false) return result === null ? null : { status: 'failed' }
    return { status: 'ready', value: { id: result.user.sub as AccountUserId,
      name: result.user.nickname || result.user.username, contact: result.user.username,
      avatarUrl: result.user.avatar || null } }
  }

  override async getBalance(_client: AccountClientMetadata): Promise<AccountDetails['balance'] | null> {
    const result = await this.detail('/v1/points', pointsSchema)
    if (result === null || result === false) return result === null ? null : { status: 'failed' }
    return { status: 'ready', value: [], bonusWallets: [], points: {
      availableUnits: result.balance.available_units, heldUnits: result.balance.held_units, unitsPerPoint: result.units_per_point,
    } }
  }

  override getUnnotifiedBonuses() { return Promise.resolve(null) }
  override ackBonusNotified() { return Promise.resolve(false) }
  override getPlatformSession() { return Promise.resolve(null) }
  override async getDeviceIdentity() {
    const stored = await this.stored()
    return { ...(stored === undefined ? {} : { userId: stored.user.sub as AccountUserId }), osVersion: `${platform()} ${release()}` }
  }

  override async resolveToken(url: string): Promise<string | undefined> {
    if (this.removing !== undefined || this.lifetime.signal.aborted) return undefined
    const destination = new URL(url)
    if (destination.origin !== this.origin || destination.username || destination.password) return undefined
    if (destination.pathname !== '/v1' && !destination.pathname.startsWith('/v1/')) return undefined
    return (await this.stored())?.token
  }

  override async rejectToken(token: string): Promise<void> {
    if (this.lifetime.signal.aborted) return
    const removal = { committed: false }
    await this.ctx.credentials.modifyRecord(KEY, (record) => {
      if (record?.kind !== 'grant') return Promise.resolve(undefined)
      const parsed = storedSchema.safeParse(record.payload)
      if (!parsed.success || parsed.data.issuer !== this.origin || parsed.data.token !== token) return Promise.resolve(undefined)
      removal.committed = true
      return Promise.resolve({ kind: 'grant', payload: { ...parsed.data, revoked: true } })
    })
    if (removal.committed) {
      this.ctx.emit('deepseek-account/session-expired')
      this.ctx.emit('deepseek-account/signed-out')
      this.changed()
    }
  }

  override async startSignIn(client: AccountClientMetadata, callbackOrigin: string, _source: 'web' | 'desktop'): Promise<AccountView> {
    if (this.removing !== undefined) await this.removing
    this.lifetime.signal.throwIfAborted()
    const origin = loginOrigin(callbackOrigin)
    const previous = this.attempt
    if (previous !== undefined) {
      if (['initializing', 'waiting-browser', 'exchanging', 'committing'].includes(previous.view.phase)) return this.getState()
      await previous.done
      this.lifetime.signal.throwIfAborted()
      if (this.attempt !== previous) return this.getState()
    }
    const attempt: Attempt = { origin, chinese: client.locale.toLowerCase().startsWith('zh'),
      view: { id: randomUUID() as SignInAttemptId, phase: 'initializing' }, controller: new AbortController(),
      done: Promise.resolve(), running: Promise.resolve() }
    this.attempt = attempt
    attempt.done = this.ctx.authorization.begin({ key: KEY, signal: attempt.controller.signal,
      interaction: { notify: () => undefined, prompt: () => Promise.reject(new PlatformAuthError('protocol')) },
    }).then((outcome) => {
      this.update(attempt, { phase: outcome.status === 'authorized' ? 'succeeded' : 'cancelled' })
    }).catch((error: unknown) => {
      const code = error instanceof PlatformAuthError ? error.code : 'protocol'
      this.update(attempt, { phase: code === 'expired' ? 'expired' : 'failed', errorCode: code })
    }).then(async () => {
      await attempt.running.catch(() => undefined)
      const success = attempt.view.phase === 'succeeded'
      const message = attempt.chinese
        ? success ? '登录成功，请返回 free code。' : '登录未完成，请返回 free code 重试。'
        : success ? 'Signed in. Return to free code.' : 'Sign-in did not finish. Return to free code and try again.'
      attempt.response?.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store',
        'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'" }).end(message)
      await attempt.dispose?.()
    })
    this.changed()
    return this.getState()
  }

  override async cancelSignIn(id: SignInAttemptId): Promise<AccountView> {
    const attempt = this.attempt
    if (attempt?.view.id === id) {
      if (attempt.view.phase !== 'committing') {
        attempt.controller.abort()
        this.ctx.authorization.cancel(KEY)
      }
      await attempt.done
    }
    return this.getState()
  }

  override signOut(_client: AccountClientMetadata): Promise<AccountView> {
    this.removing ??= (async () => {
      if (this.attempt !== undefined) await this.cancelSignIn(this.attempt.view.id)
      const current = await this.stored()
      await this.ctx.credentials.deleteRecord(KEY)
      this.attempt = undefined
      this.ctx.emit('deepseek-account/signed-out')
      this.changed()
      if (current !== undefined) this.revoke(current.token)
      return this.getState()
    })().finally(() => { this.removing = undefined })
    return this.removing
  }

  override async *watch(signal: AbortSignal): AsyncIterable<AccountView> {
    let dirty = true
    let wake: (() => void) | undefined
    const changed = () => { dirty = true; wake?.() }
    this.listeners.add(changed)
    signal.addEventListener('abort', changed, { once: true })
    try {
      while (!signal.aborted && !this.lifetime.signal.aborted) {
        if (dirty) { dirty = false; yield await this.getState(); continue }
        await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally {
      this.listeners.delete(changed)
      signal.removeEventListener('abort', changed)
    }
  }

  private changed() { for (const listener of this.listeners) listener() }
  private update(attempt: Attempt, value: Partial<SignInAttemptView>) {
    const { authorizeUrl: _url, ...previous } = attempt.view
    attempt.view = { ...previous, ...value }
    this.changed()
  }

  private async detail<T>(path: string, schema: z.ZodType<T>): Promise<T | null | false> {
    const generation = this.generation
    const stored = await this.stored()
    if (stored === undefined) return null
    try {
      const result = schema.parse(await this.request(path, undefined, this.lifetime.signal, stored.token))
      return generation === this.generation && !this.lifetime.signal.aborted ? result : null
    } catch (error) {
      if (error instanceof Unauthorized) { await this.rejectToken(stored.token); return null }
      return generation === this.generation && !this.lifetime.signal.aborted ? false : null
    }
  }

  private revoke(token: string) {
    const pending = (async () => {
      for (let attempt = 0; attempt <= this.options.logoutMaxRetries; attempt++) {
        try { await this.request('/v1/auth/logout', {}, this.lifetime.signal, token); return }
        catch (error) {
          if (error instanceof Unauthorized || this.lifetime.signal.aborted) return
          if (attempt === this.options.logoutMaxRetries) break
          try { await delay(this.options.logoutRetryDelayMs * 2 ** attempt, undefined, { signal: this.lifetime.signal }) }
          catch { return }
        }
      }
      // 本地凭据已移除；远端失败不恢复登录，也不把令牌写入诊断输出。
      console.warn('[freecode-account] remote sign-out unavailable')
    })().finally(() => { this.revocations.delete(pending) })
    this.revocations.add(pending)
  }

  private request(path: string, body: unknown, signal: AbortSignal, token?: string): Promise<unknown> {
    const request = this.readResponse(path, body, signal, token).finally(() => { this.requests.delete(request) })
    this.requests.add(request)
    return request
  }

  private async readResponse(path: string, body: unknown, signal: AbortSignal, token?: string): Promise<unknown> {
    let response: Response
    try {
      response = await fetch(`${this.origin}${path}`, { method: body === undefined ? 'GET' : 'POST',
        redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(this.options.requestTimeoutMs)]),
        headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    } catch { throw new PlatformAuthError('no-response') }
    if (response.status === 401) { await response.body?.cancel(); throw new Unauthorized() }
    if (!response.ok) { await response.body?.cancel(); throw new PlatformAuthError('network') }
    const reader = response.body?.getReader()
    if (reader === undefined) throw new PlatformAuthError('protocol')
    const chunks: Uint8Array[] = []
    let length = 0
    try {
      for (;;) {
        const item = await reader.read()
        if (item.done) break
        length += item.value.byteLength
        if (length > this.options.maxResponseBytes) throw new PlatformAuthError('protocol')
        chunks.push(item.value)
      }
      const result: unknown = JSON.parse(Buffer.concat(chunks).toString())
      return result
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
  }

  private async run(session: AuthorizationSession, attempt: Attempt) {
    const webServer = this.ctx.get('webServer')
    if (webServer === undefined) throw new PlatformAuthError('protocol')
    const deadline = new AbortController()
    const signal = AbortSignal.any([session.signal, deadline.signal, this.lifetime.signal])
    const code = Promise.withResolvers<string>()
    void code.promise.catch(() => undefined)
    const abort = () => { code.reject(new PlatformAuthError('expired')) }
    signal.addEventListener('abort', abort, { once: true })
    let timer = setTimeout(() => { deadline.abort() }, this.options.attemptTimeoutMs)
    const localExpiresAt = Date.now() + this.options.attemptTimeoutMs
    let expectedState = ''
    try {
      attempt.dispose = this.ctx.effect(() => webServer.register({ kind: 'exact', path: '/oauth/callback', handler: (req, res) => {
        let url: URL
        try { url = new URL(req.url ?? '/', attempt.origin) }
        catch { res.writeHead(400, { 'cache-control': 'no-store' }).end(); return }
        const state = url.searchParams.get('state') ?? ''
        const received = url.searchParams.get('code')
        const valid = expectedState.length > 0 && Buffer.byteLength(state) === Buffer.byteLength(expectedState)
          && timingSafeEqual(Buffer.from(state), Buffer.from(expectedState))
        const success = received !== null && received.length > 0 && url.searchParams.getAll('code').length === 1
          && !url.searchParams.has('error')
        const denied = url.searchParams.getAll('error').length === 1 && !url.searchParams.has('code')
        if (req.method !== 'GET' || !valid || url.searchParams.getAll('state').length !== 1
          || (!success && !denied)) {
          res.writeHead(400, { 'cache-control': 'no-store' }).end(); return
        }
        if (signal.aborted || attempt.response !== undefined || attempt.view.phase !== 'waiting-browser') {
          res.writeHead(410, { 'cache-control': 'no-store' }).end(); return
        }
        attempt.response = res
        if (success) code.resolve(received)
        else code.reject(new PlatformAuthError('protocol'))
      } }), 'freecode: 浏览器回调')
      const init = initSchema.parse(await this.request('/v1/auth/authorize', { redirect_uri: `${attempt.origin}/oauth/callback` }, signal))
      const authorization = new URL(init.authorize_url)
      if (authorization.origin !== this.authorizationOrigin || authorization.username || authorization.password || authorization.hash) {
        throw new PlatformAuthError('protocol')
      }
      let target = authorization
      if (authorization.pathname === '/login') {
        const redirect = authorization.searchParams.get('redirect')
        if (redirect === null || authorization.searchParams.getAll('redirect').length !== 1) throw new PlatformAuthError('protocol')
        target = new URL(redirect, this.authorizationOrigin)
      }
      const states = target.searchParams.getAll('state')
      const state = states[0]
      if (target.origin !== this.authorizationOrigin || target.pathname !== '/authorize' || target.username || target.password || target.hash
        || !state || states.length !== 1) throw new PlatformAuthError('protocol')
      expectedState = state
      if (init.state !== undefined && init.state !== expectedState) throw new PlatformAuthError('protocol')
      const expiresAt = Math.min(init.expires_at, localExpiresAt)
      clearTimeout(timer)
      if (expiresAt <= Date.now()) throw new PlatformAuthError('expired')
      timer = setTimeout(() => { deadline.abort() }, expiresAt - Date.now())
      signal.throwIfAborted()
      this.update(attempt, { phase: 'waiting-browser', authorizeUrl: authorization.href, expiresAt })
      const received = await code.promise
      signal.throwIfAborted()
      this.update(attempt, { phase: 'exchanging' })
      const result = exchangeSchema.parse(await this.request('/v1/auth/exchange', { attempt_id: init.attempt_id, state: expectedState, code: received }, signal))
      if (Date.now() >= expiresAt || result.expires_at <= Date.now()) {
        this.revoke(result.access_token)
        throw new PlatformAuthError('expired')
      }
      try { signal.throwIfAborted() }
      catch (error) { this.revoke(result.access_token); throw error }
      this.update(attempt, { phase: 'committing' })
      clearTimeout(timer)
      try { await session.commit({ kind: 'grant', payload: { version: 1, issuer: this.origin, token: result.access_token, expiresAt: result.expires_at, user: result.user } }) }
      catch { this.revoke(result.access_token); throw new PlatformAuthError('storage') }
    } catch (error) {
      if (deadline.signal.aborted) throw new PlatformAuthError('expired')
      throw error
    } finally { clearTimeout(timer); signal.removeEventListener('abort', abort) }
  }
}

class Unauthorized extends Error {}
