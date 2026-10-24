/** 从 free code 网关目录建立平台模型路由；账号令牌不进入设置或模型日志。 */
import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { ACCOUNT_QUOTA_EXCEEDED_CODE, LlmAdapter, LlmError, resolveRetryPolicy, type GenerateOptions, type PreparedAdapterCall, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-deepseek-account'
import { PiAiAdapter } from './adapter.ts'
import { authContextFrom, credentialStoreFrom } from './auth.ts'
import { resolveProfiles, type Config } from './config.ts'

const PROVIDER = 'deepseek-account'
type Deployment = NonNullable<Config['freecode']>
interface Model { id: string; name: string; protocol: 'chat_completions' | 'responses'; max_input_tokens: number; max_output_tokens: number }
interface Catalog { token: string; at: number; models: readonly Model[] }

function catalogModels(value: unknown): readonly Model[] {
  if (typeof value !== 'object' || value === null || !('data' in value) || !Array.isArray(value.data)) throw new LlmError('平台模型目录格式错误', 'ACCOUNT_CATALOG_INVALID')
  const ids = new Set<string>()
  return value.data.map((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null || !('id' in entry) || typeof entry.id !== 'string' || !entry.id
      || !('name' in entry) || typeof entry.name !== 'string' || !('protocol' in entry) || !['chat_completions', 'responses'].includes(String(entry.protocol))
      || !('max_input_tokens' in entry) || typeof entry.max_input_tokens !== 'number' || !Number.isSafeInteger(entry.max_input_tokens) || entry.max_input_tokens <= 0
      || !('max_output_tokens' in entry) || typeof entry.max_output_tokens !== 'number' || !Number.isSafeInteger(entry.max_output_tokens) || entry.max_output_tokens <= 0
      || ids.has(entry.id)) throw new LlmError('平台模型目录格式错误', 'ACCOUNT_CATALOG_INVALID')
    ids.add(entry.id)
    return { id: entry.id, name: entry.name, protocol: entry.protocol as Model['protocol'], max_input_tokens: entry.max_input_tokens, max_output_tokens: entry.max_output_tokens }
  })
}

/** 平台账号只走固定网关，协议实现复用已维护的 pi-ai 适配器。 */
export class FreeCodeAdapter extends LlmAdapter {
  private readonly origin: string
  private readonly lifetime = new AbortController()
  private cached: Catalog | undefined
  private loading: { token: string; promise: Promise<Catalog> } | undefined

  /** @param ctx - 账号服务与模型注册的拥有者。 @param deployment - 网关配置。 */
  constructor(private readonly ctx: Context, private readonly deployment: Deployment) {
    super()
    const url = new URL(deployment.origin)
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash
      || !(url.protocol === 'https:' || deployment.allowLoopbackHttp && url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error('freecode: 网关必须为安全的 HTTP(S) origin')
    this.origin = url.origin
    ctx.effect(() => async () => { this.lifetime.abort(); await this.loading?.promise.catch(() => undefined) }, 'freecode: 模型目录请求')
  }

  override providerInfo(provider: string) { return { id: provider, name: 'free code' } }
  override providerRetryPolicy() { return resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, 'freecode: retryPolicy') }

  private async token() {
    const token = await this.ctx.get('deepseekAccount')?.resolveToken(`${this.origin}/v1`)
    if (token === undefined) throw new LlmError('请先登录 free code 或使用自己配置的模型服务。', 'ACCOUNT_SIGN_IN_REQUIRED')
    return token
  }

  private async load(signal?: AbortSignal): Promise<Catalog> {
    const token = await this.token()
    if (this.cached?.token === token && Date.now() - this.cached.at < this.deployment.modelsMaxAgeMs) return this.cached
    const signalForRequest = AbortSignal.any([
      this.lifetime.signal, AbortSignal.timeout(this.deployment.modelsTimeoutMs), ...(signal === undefined ? [] : [signal]),
    ])
    if (this.loading?.token === token) return this.loading.promise
    const promise = (async () => {
      const response = await fetch(`${this.origin}/v1/models`, { headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: signalForRequest })
      if (response.status === 401) { await response.body?.cancel(); await this.ctx.get('deepseekAccount')?.rejectToken(token); throw new LlmError('free code 登录已失效。', 'ACCOUNT_TOKEN_INVALID') }
      if (!response.ok) { await response.body?.cancel(); throw new LlmError('无法加载 free code 模型目录，请稍后重试。', 'ACCOUNT_CATALOG_UNAVAILABLE') }
      const reader = response.body?.getReader()
      if (reader === undefined) throw new LlmError('平台模型目录为空。', 'ACCOUNT_CATALOG_INVALID')
      const parts: Uint8Array[] = []
      let bytes = 0
      try {
        for (;;) {
          const value = await reader.read()
          if (value.done) break
          bytes += value.value.byteLength
          if (bytes > this.deployment.maxCatalogBytes) throw new LlmError('平台模型目录超出大小限制。', 'ACCOUNT_CATALOG_INVALID')
          parts.push(value.value)
        }
        const raw: unknown = JSON.parse(Buffer.concat(parts).toString())
        const result = { token, at: Date.now(), models: catalogModels(raw) }
        if (await this.token() !== token) throw new LlmError('账号已切换，请重新发起请求。', 'ACCOUNT_TOKEN_INVALID')
        this.cached = result
        return result
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
    })()
    const loading = { token, promise }
    this.loading = loading
    try { return await promise } finally { if (this.loading === loading) this.loading = undefined }
  }

  private delegate(catalog: Catalog, id: string): PiAiAdapter {
    const model = catalog.models.find(entry => entry.id === id)
    if (model === undefined) throw new LlmError('平台未提供此模型，请重新选择模型。', 'MODEL_UNSUPPORTED')
    const profiles = resolveProfiles({ [PROVIDER]: { displayName: 'free code', baseURL: `${this.origin}/v1`,
      api: model.protocol === 'responses' ? 'openai-responses' : 'openai-completions', transport: 'sse',
      headers: { 'Idempotency-Key': randomUUID() },
      models: [{ id: model.id, name: model.name,
        contextWindow: model.max_input_tokens + model.max_output_tokens, maxTokens: model.max_output_tokens }],
      ...(model.protocol === 'chat_completions' ? { compat: { supportsUsageInStreaming: true, maxTokensField: 'max_tokens' as const } } : {}),
      retryPolicy: { mode: 'normal', maxRetries: 0 },
    } })
    return new PiAiAdapter({ profiles: () => profiles,
      resolveApiKey: async () => {
        if (await this.token() !== catalog.token) throw new LlmError('账号已切换，请重新发起请求。', 'ACCOUNT_TOKEN_INVALID')
        return catalog.token
      },
      // 显式令牌在 SDK 调用前验证；缺失时立即失败，不进入提供方的环境凭据解析。
      auth: { credentials: credentialStoreFrom(this.ctx), authContext: authContextFrom(this.ctx) },
    })
  }

  override async listModels(provider: string) {
    let catalog: Catalog
    try { catalog = await this.load() } catch (error) { if (error instanceof LlmError && error.code === 'ACCOUNT_SIGN_IN_REQUIRED') return []; throw error }
    return catalog.models.map(model => ({ provider, id: model.id, name: model.name }))
  }
  override async resolveModel(provider: string, model: string, signal?: AbortSignal) {
    const catalog = await this.load(signal)
    return this.delegate(catalog, model).resolveModel(provider, model, signal)
  }
  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const catalog = await this.load(signal)
    const prepared = await this.delegate(catalog, model).prepareCall(provider, model, signal)
    return { ...prepared, stream: options => this.observe(prepared.stream(options), catalog.token) }
  }
  override async *stream(options: GenerateOptions) {
    const prepared = await this.prepareCall(options.provider, options.model, options.signal)
    yield* prepared.stream(options)
  }
  private async *observe(stream: AsyncIterable<StreamChunk>, token: string): AsyncGenerator<StreamChunk> {
    for await (const chunk of stream) {
      if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
        const failure = chunk.reason.failure
        // pi-ai 将 HTTP 失败序列化为结束事件，保留的状态码位于 SDK 错误文本中。
        if (failure.code === 'AUTH' && /^401\b/.test(failure.message)) {
          await this.ctx.get('deepseekAccount')?.rejectToken(token)
          yield { ...chunk, reason: { kind: 'error', failure: { ...failure, code: 'ACCOUNT_TOKEN_INVALID' } } }
          continue
        }
        if (/^402\b/.test(failure.message)) {
          yield { ...chunk, reason: { kind: 'error', failure: { ...failure, code: ACCOUNT_QUOTA_EXCEEDED_CODE } } }
          continue
        }
      }
      yield chunk
    }
  }
}

/** @param ctx - 插件生命周期。 @param config - 网关目录设置。 */
export function registerFreeCode(ctx: Context, config: Deployment): void {
  const adapter = new FreeCodeAdapter(ctx, config)
  ctx.effect(() => ctx.llm.registerAdapter([PROVIDER], adapter), 'freecode: 平台模型')
}
