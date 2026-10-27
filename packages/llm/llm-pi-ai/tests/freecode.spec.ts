import { afterEach, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { FreeCodeAdapter, registerFreeCode } from '../src/freecode.ts'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); await closeMockServers(); vi.restoreAllMocks() })
const token = 'test-platform-token'
const model = { id: 'platform-model', name: '平台模型', protocol: 'chat_completions', max_input_tokens: 261120, max_output_tokens: 1024,
  context_window: 262144, reasoning_efforts: ['low', 'medium', 'high'], default_reasoning_effort: 'medium' }
const listing = JSON.stringify({ data: [model] })
const message = createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'model', provider: 'test', model: 'test' } })

function barrier() {
  const gate = Promise.withResolvers<undefined>()
  return { promise: gate.promise, resolve: () => { gate.resolve(undefined) } }
}

async function fixture(origin: string, available = true) {
  let current: string | undefined = available ? token : undefined
  const ctx = new Context()
  class Account extends Service {
    constructor(context: Context) { super(context, 'deepseekAccount') }
    async resolveToken(url: string) { expect(url).toBe(`${origin}/v1`); return current }
    async rejectToken(rejected: string) { if (rejected === current) current = undefined }
  }
  const account = ctx.plugin(Account)
  await account
  cleanups.push(() => account.dispose())
  const llm = ctx.plugin(LlmRuntime)
  await llm
  cleanups.push(() => llm.dispose())
  const deployment = { origin, modelsTimeoutMs: 5000, modelsMaxAgeMs: 60000, maxCatalogBytes: 65536, allowLoopbackHttp: true }
  const plugin = ctx.plugin({ inject: ['llm'], apply: (context: Context) => { registerFreeCode(context, deployment) } })
  await plugin
  cleanups.push(() => plugin.dispose())
  return { ctx, deployment, plugin, replace: () => { current = 'different-token' } }
}

it('平台 Chat 调用发送 Bearer 和输出上限，模型目录不泄露凭据', async () => {
  const server = await mockServer([{ body: listing }, { events: textEvents }])
  const f = await fixture(server.url)
  const result = await assemble(f.ctx, { provider: 'deepseek-account', model: model.id, messages: [message] })
  expect(result.message.content).toEqual([{ type: 'text', text: 'hello' }])
  expect(server.paths).toEqual(['/v1/models', '/v1/chat/completions'])
  expect(server.headers.every(headers => headers.authorization === `Bearer ${token}`)).toBe(true)
  expect(server.headers.every(headers => headers['x-dsh-auth-token'] === undefined)).toBe(true)
  expect(server.headers[1]?.['idempotency-key']).toMatch(/^[a-f0-9-]{36}$/)
  expect(server.requests[1]).toMatchObject({ max_tokens: 1024, reasoning_effort: 'medium', stream: true, stream_options: { include_usage: true } })
})

it('游客没有平台模型，但仍保留 BYOK 的注册空间', async () => {
  const server = await mockServer([])
  const f = await fixture(server.url, false)
  const adapter = new FreeCodeAdapter(f.ctx, f.deployment)
  expect(await adapter.listModels('deepseek-account')).toEqual([])
  expect(server.paths).toEqual([])
})

it('账号切换后不发送按前一账号准备的请求', async () => {
  const server = await mockServer([{ body: listing }])
  const f = await fixture(server.url)
  const adapter = new FreeCodeAdapter(f.ctx, f.deployment)
  const call = await adapter.prepareCall('deepseek-account', model.id)
  f.replace()
  await expect((async () => { for await (const _ of call.stream({ provider: 'deepseek-account', model: model.id, messages: [message] })) {} })()).rejects.toMatchObject({ code: 'ACCOUNT_TOKEN_INVALID' })
  expect(server.paths).toEqual(['/v1/models'])
})

it('拒绝目录重复模型和非安全网关地址', async () => {
  const server = await mockServer([{ body: JSON.stringify({ data: [model, model] }) }])
  const f = await fixture(server.url)
  const adapter = new FreeCodeAdapter(f.ctx, f.deployment)
  await expect(adapter.listModels('deepseek-account')).rejects.toMatchObject({ code: 'ACCOUNT_CATALOG_INVALID' })
  expect(() => new FreeCodeAdapter(f.ctx, { ...f.deployment, origin: 'http://remote.invalid' })).toThrow()
})

it.each([401, 402, 503])('网关 %s 失败不会暗中重试，账号和积分错误使用对应提示', async (status) => {
  const server = await mockServer([{ body: listing }, { status, body: JSON.stringify({ error: { message: 'gateway rejected request' } }) }])
  const f = await fixture(server.url)
  const result = await assemble(f.ctx, { provider: 'deepseek-account', model: model.id, messages: [message] })
  expect(result.finish).toMatchObject({ kind: 'error', failure: { code: status === 401 ? 'ACCOUNT_TOKEN_INVALID' : status === 402 ? 'ACCOUNT_QUOTA' : 'SERVER' } })
  expect(server.paths).toEqual(['/v1/models', '/v1/chat/completions'])
  if (status === 401) expect(await f.ctx.deepseekAccount.resolveToken(`${server.url}/v1`)).toBeUndefined()
})

it('Responses 模型发送到对应端点且保留输出上限', async () => {
  const server = await mockServer([{ body: JSON.stringify({ data: [{ ...model, protocol: 'responses' }] }) },
    { status: 503, body: JSON.stringify({ error: { message: 'expected wire capture' } }) }])
  const f = await fixture(server.url)
  await assemble(f.ctx, { provider: 'deepseek-account', model: model.id, messages: [message] })
  expect(server.paths).toEqual(['/v1/models', '/v1/responses'])
  expect(server.requests[1]).toMatchObject({ model: model.id, max_output_tokens: 1024, reasoning: { effort: 'medium' }, stream: true })
  expect(server.headers[1]?.authorization).toBe(`Bearer ${token}`)
})

it('模型列表缓存绑定账号，精确模型查询采用服务端容量且拒绝未知模型', async () => {
  const server = await mockServer([{ body: listing }, { events: textEvents }])
  const f = await fixture(server.url)
  const adapter = new FreeCodeAdapter(f.ctx, f.deployment)
  expect(await adapter.listModels('deepseek-account')).toEqual([{ provider: 'deepseek-account', id: model.id, name: model.name }])
  expect(await adapter.resolveModel('deepseek-account', model.id)).toMatchObject({ id: model.id, context: { contextWindow: 262144 }, defaultMaxTokens: 1024,
    reasoning: { defaultEffort: 'medium', efforts: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }] } })
  await expect(adapter.resolveModel('deepseek-account', 'unknown')).rejects.toMatchObject({ code: 'MODEL_UNSUPPORTED' })
  for await (const _chunk of adapter.stream({ provider: 'deepseek-account', model: model.id, messages: [message] })) { /* 流消费到终结以验证清理。 */ }
  expect(server.paths).toEqual(['/v1/models', '/v1/chat/completions'])
})

it.each(['low', 'medium', 'high'] as const)('平台 Chat 请求发送用户选择的 %s 思考等级，上下文始终为 256k', async (effort) => {
  const server = await mockServer([{ body: listing }, { events: textEvents }])
  const f = await fixture(server.url)
  await assemble(f.ctx, { provider: 'deepseek-account', model: model.id, messages: [message], reasoningEffort: ReasoningEffortId(effort) })
  expect(server.requests[1]).toMatchObject({ reasoning_effort: effort })
  expect(await f.ctx.llm.resolveModelInfo('deepseek-account', model.id)).toMatchObject({ context: { contextWindow: 262144 } })
})

it.each(['low', 'medium', 'high'] as const)('平台 Responses 请求发送用户选择的 %s 思考等级', async (effort) => {
  const server = await mockServer([{ body: JSON.stringify({ data: [{ ...model, protocol: 'responses' }] }) },
    { status: 503, body: JSON.stringify({ error: { message: 'expected wire capture' } }) }])
  const f = await fixture(server.url)
  await assemble(f.ctx, { provider: 'deepseek-account', model: model.id, messages: [message], reasoningEffort: ReasoningEffortId(effort) })
  expect(server.requests[1]).toMatchObject({ reasoning: { effort }, max_output_tokens: 1024 })
  expect(server.requests[1]).not.toHaveProperty('reasoning_effort')
})

it.each(['off', 'xhigh', 'max'])('平台拒绝未提供的 %s 思考等级且不发送模型请求', async (effort) => {
  const server = await mockServer([{ body: listing }])
  const f = await fixture(server.url)
  const result = await assemble(f.ctx, { provider: 'deepseek-account', model: model.id, messages: [message], reasoningEffort: ReasoningEffortId(effort) })
  expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'UNSUPPORTED_REASONING_EFFORT' } })
  expect(server.paths).toEqual(['/v1/models'])
})

it.each([
  { context_window: 1048576 }, { context_window: undefined }, { max_input_tokens: 262144 },
  { max_output_tokens: 262144 }, { reasoning_efforts: ['low', 'high'] }, { reasoning_efforts: ['low', 'medium', 'max'] },
  { reasoning_efforts: ['low', 'medium', 'medium'] }, { reasoning_efforts: null }, { reasoning_efforts: undefined },
  { default_reasoning_effort: 'high' }, { default_reasoning_effort: undefined },
])('拒绝偏离平台固定窗口或思考规则的模型目录：%j', async (changes) => {
  const server = await mockServer([{ body: JSON.stringify({ data: [{ ...model, ...changes }] }) }])
  const f = await fixture(server.url)
  await expect(f.ctx.llm.resolveModelInfo('deepseek-account', model.id)).rejects.toMatchObject({ code: 'ACCOUNT_CATALOG_INVALID' })
  expect(server.paths).toEqual(['/v1/models'])
})

it.each([401, 503])('模型目录 %s 失败不会返回其他账号缓存', async (status) => {
  const server = await mockServer([{ status, body: '{}' }])
  const f = await fixture(server.url)
  const adapter = new FreeCodeAdapter(f.ctx, f.deployment)
  await expect(adapter.listModels('deepseek-account')).rejects.toMatchObject({ code: status === 401 ? 'ACCOUNT_TOKEN_INVALID' : 'ACCOUNT_CATALOG_UNAVAILABLE' })
})

it.each([
  { status: 204, body: '' },
  { status: 200, body: '{}' },
  { status: 200, body: ' '.repeat(65537) },
])('拒绝空目录或越界目录：$status/$body.length', async ({ status, body }) => {
  const server = await mockServer([{ status, body }])
  const f = await fixture(server.url)
  const adapter = new FreeCodeAdapter(f.ctx, f.deployment)
  await expect(adapter.listModels('deepseek-account')).rejects.toMatchObject({ code: 'ACCOUNT_CATALOG_INVALID' })
})

it('同时查询同一账号共享目录请求，单个调用者取消不影响其他调用者', async () => {
  const release = barrier()
  cleanups.push(() => { release.resolve(); return Promise.resolve() })
  const server = await mockServer([{ body: listing, beforeReply: release.promise }])
  const f = await fixture(server.url)
  const adapter = new FreeCodeAdapter(f.ctx, f.deployment)
  const cancellation = new AbortController()
  const first = adapter.resolveModel('deepseek-account', model.id, cancellation.signal)
  const cancelled = expect(first).rejects.toThrow()
  await server.requestReceived
  const second = adapter.listModels('deepseek-account')
  cancellation.abort()
  await cancelled
  release.resolve()
  expect(await second).toEqual([{ provider: 'deepseek-account', id: model.id, name: model.name }])
  expect(server.paths).toEqual(['/v1/models'])
})

it('目录响应到达前切换账号时拒绝旧目录，新账号可以独立加载', async () => {
  const release = barrier()
  cleanups.push(() => { release.resolve(); return Promise.resolve() })
  const server = await mockServer([{ body: listing, beforeReply: release.promise }, { body: listing }])
  const f = await fixture(server.url)
  const adapter = new FreeCodeAdapter(f.ctx, f.deployment)
  const old = adapter.listModels('deepseek-account')
  const refused = expect(old).rejects.toMatchObject({ code: 'ACCOUNT_TOKEN_INVALID' })
  await server.requestReceived
  f.replace()
  expect(await adapter.listModels('deepseek-account')).toHaveLength(1)
  release.resolve()
  await refused
  expect(server.headers.map(headers => headers.authorization)).toEqual([`Bearer ${token}`, 'Bearer different-token'])
})

it('插件卸载中止正在加载的目录并等待连接释放', async () => {
  const server = await mockServer([{ events: ['{"data":['], holdOpen: true }])
  const f = await fixture(server.url)
  const models = f.ctx.llm.listModels('deepseek-account')
  const rejected = expect(models).rejects.toThrow()
  await server.requestReceived
  await f.plugin.dispose()
  await rejected
  await server.responseClosed
  expect(server.closedResponses).toBe(1)
})

it('目录正文读取被取消时，清理读取器的拒绝不会泄漏未处理异常', async () => {
  const server = await mockServer([{ events: ['{"data":['], holdOpen: true }])
  const f = await fixture(server.url)
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
  const models = f.ctx.llm.listModels('deepseek-account')
  const rejected = expect(models).rejects.toThrow()
  await reading.promise
  await f.plugin.dispose()
  await rejected
  await server.responseClosed
  expect(server.closedResponses).toBe(1)
})
