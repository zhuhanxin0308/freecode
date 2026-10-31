/** 仅供应商和平台 API 使用本地 HTTP 服务；请求编码、凭据读取及原图传输保持真实。 */
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import sharp from 'sharp'
import { afterEach, expect, it, vi } from 'vitest'
import type { CredentialRecord } from '@deepseek-ai/dsh-credentials'
import type { AccountUserId } from '@deepseek-ai/dsh-deepseek-account/types'
import type { PiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai/src/config.ts'
import type { ImageModelProfile } from '@deepseek-ai/dsh-llm-pi-ai/src/image-models.ts'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { Config } from '../src/host/config.ts'
import { imageBytes, imageMime, ImageProviders } from '../src/host/providers.ts'
import { ImageFailure, imageFailureCode } from '../src/host/errors.ts'
import { ImageStore } from '../src/host/store.ts'
import type { StoredImageJob } from '../src/host/schemas.ts'
import type { ImageGenerationRequest, ImageJobId } from '../src/types.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks() })
async function bodyOf(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  req.on('data', (chunk: Buffer) => { chunks.push(chunk) })
  await once(req, 'end')
  return Buffer.concat(chunks)
}
async function fixture(provider = 'fixture') {
  const root = await mkdtemp(join(tmpdir(), 'freecode-image-provider-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const image = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#5577ff80' } }).png().toBuffer()
  const observed: {
    path: string
    authorization: string | undefined
    method: string | undefined
    headers: IncomingMessage['headers']
    body: Buffer
  }[] = []
  const state = { subject: 'account-one', mode: 'b64', token: 'p'.repeat(43), platformStatus: 200,
    providerStatus: 200, afterPlatformReply: false, resultURL: '' }
  let origin = ''
  const server: Server = createServer((req, res) => {
    void (async () => {
      const body = await bodyOf(req)
      observed.push({ path: req.url ?? '', authorization: req.headers.authorization, method: req.method, headers: req.headers, body })
      const json = (value: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value)) }
      if (req.url?.startsWith('/v1/')) {
        if (req.headers.authorization !== `Bearer ${state.token}`) { res.writeHead(401).end(); return }
        if (state.platformStatus !== 200) { res.writeHead(state.platformStatus).end(); return }
        if (state.afterPlatformReply) state.subject = 'account-two'
        if (req.method === 'GET' && req.headers['content-type'] !== undefined) { res.writeHead(400).end(); return }
        if (req.url === '/v1/image-models') {
          json({ data: [{ id: 'platform-image', name: 'Platform image', sizes: ['auto'], qualities: ['auto'], backgrounds: ['auto'],
            formats: ['png'], optional_parameters: [], supports_edit: true, supports_mask: true, max_references: 2 }],
          price_units: '10000000', units_per_point: '1000000' }); return
        }
        if (req.url.endsWith('/image')) { res.writeHead(200, { 'content-type': 'image/png' }).end(image); return }
        json({ job: { id: 'remote-one', state: req.url.endsWith('/cancel') ? 'cancelled' : req.method === 'POST' ? 'queued' : 'succeeded',
          charged_units: '10000000' } }); return
      }
      if (req.url === '/generated.png') { res.writeHead(200, { 'content-type': 'image/png' }).end(image); return }
      if (state.providerStatus !== 200) { res.writeHead(state.providerStatus).end('private credential diagnostic'); return }
      if (state.mode === 'auth') { res.writeHead(401).end('private credential diagnostic'); return }
      if (state.mode === 'redirect') { res.writeHead(302, { location: '/generated.png' }).end(); return }
      if (state.mode === 'bad') { res.writeHead(200).end('{not json'); return }
      if (state.mode === 'empty') { json({ data: [] }); return }
      if (state.mode === 'missing') { json({ data: [{}] }); return }
      if (state.resultURL !== '') { json({ data: [{ url: state.resultURL }] }); return }
      json({ data: [state.mode === 'url' ? { url: `${origin}/generated.png` }
        : state.mode === 'foreign-url' ? { url: 'https://untrusted.invalid/private' } : { b64_json: image.toString('base64') }] })
    })().catch((_error: unknown) => { res.writeHead(500).end() })
  })
  cleanups.push(() => new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error === undefined) resolve(); else reject(error) }); server.closeAllConnections()
  }))
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('missing fixture listener')
  origin = `http://127.0.0.1:${address.port}`
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  const profile: PiAiProviderProfile & { imageModels: ImageModelProfile[] } = { baseURL: `${origin}/custom/v1`, apiKeyEnv: 'IMAGE_KEY',
    headers: { 'x-fixture': 'provider' }, imageModels: [{ id: 'custom-image', sizes: ['auto'], qualities: ['auto'], backgrounds: ['auto'],
      formats: ['png'], supportsEdit: true, supportsMask: true, maxReferenceImages: 2, optionalParameters: [] }] }
  const keys = new Map([['IMAGE_KEY', 'custom-key']])
  let record: CredentialRecord | undefined
  ctx.provide('settings', { describe: () => [{ ns: 'llm-pi-ai' as SettingsNamespace,
    value: JSON.parse(JSON.stringify({ providers: { [provider]: profile } })) as JsonValue,
    autoGenerate: true, schema: {}, revision: 1, applies: 'live' }] } satisfies Pick<Context['settings'], 'describe'>)
  ctx.provide('credentials', { resolve: async (ref: string) => {
    const value = keys.get(ref)
    return value === undefined ? undefined : { value, source: 'fixture' }
  }, readRecord: async () => record } satisfies Pick<Context['credentials'], 'resolve' | 'readRecord'>)
  ctx.provide('deepseekAccount', {
    getDeviceIdentity: async () => ({ ...state.subject ? { userId: state.subject as AccountUserId } : {}, osVersion: 'fixture' }),
    resolveToken: async (url: string) => new URL(url).origin === origin && state.subject ? state.token : undefined,
    rejectToken: async () => { state.subject = '' },
  } satisfies Pick<Context['deepseekAccount'], 'getDeviceIdentity' | 'resolveToken' | 'rejectToken'>)
  const config = Config({ directory: root, platformOrigin: origin, allowLoopbackHttp: true })
  const store = new ImageStore({ ...config, directory: root })
  await store.initialize()
  const providers = new ImageProviders(ctx, config, store)
  const request: ImageGenerationRequest = { model: { source: 'custom', provider, id: 'custom-image' }, prompt: 'blue square',
    size: 'auto', quality: 'auto', background: 'auto', format: 'png', referenceImageIds: [] }
  return { ctx, providers, store, image, observed, state, profile, keys, request, origin, config,
    setRecordKey: (value: string) => { record = { kind: 'api-key', key: value } },
    setRecord: (value: CredentialRecord | undefined) => { record = value } }
}

it('unifies safe model metadata and sends only declared JSON parameters using the current explicit credential', async () => {
  const f = await fixture()
  const catalog = await f.providers.catalog()
  expect(catalog.models.map(model => model.ref.source)).toEqual(['custom', 'platform'])
  expect(JSON.stringify(catalog)).not.toContain(f.origin)
  expect(JSON.stringify(catalog)).not.toContain('custom-key')
  expect(await f.providers.generateCustom(f.request, new AbortController().signal)).toEqual(f.image)
  const sent = f.observed.find(row => row.path.endsWith('/generations'))
  expect(sent?.authorization).toBe('Bearer custom-key')
  expect(JSON.parse(sent?.body.toString() ?? '{}')).toEqual({ model: 'custom-image', prompt: 'blue square', size: 'auto', n: 1 })
  f.keys.set('IMAGE_KEY', 'rotated-key')
  f.profile.imageModels[0]!.optionalParameters = ['quality', 'background', 'output_format']
  await f.providers.generateCustom(f.request, new AbortController().signal)
  expect(f.observed.at(-1)?.authorization).toBe('Bearer rotated-key')
  expect(JSON.parse(f.observed.at(-1)?.body.toString() ?? '{}')).toMatchObject({ quality: 'auto', background: 'auto', output_format: 'png' })
  f.keys.delete('IMAGE_KEY')
  f.setRecordKey('stored-key')
  await expect(f.providers.generateCustom(f.request, new AbortController().signal)).rejects.toMatchObject({ code: 'credential-required' })
  delete f.profile.apiKeyEnv
  await f.providers.generateCustom(f.request, new AbortController().signal)
  expect(f.observed.at(-1)?.authorization).toBe('Bearer stored-key')
})

it('sends original reference and mask bytes in multipart while result downloads omit credentials', async () => {
  const f = await fixture()
  const reference = await f.store.saveImage(f.image, 'image/png')
  await f.providers.generateCustom({ ...f.request, referenceImageIds: [reference.id], maskImageId: reference.id },
    new AbortController().signal)
  const sent = f.observed.at(-1)
  expect(sent?.path).toBe('/custom/v1/images/edits')
  const form = await new Response(new Uint8Array(sent?.body ?? []), { headers: { 'content-type': String(sent?.headers['content-type']) } }).formData()
  expect(form.get('n')).toBe('1')
  const image = form.get('image'), mask = form.get('mask')
  if (!(image instanceof File) || !(mask instanceof File)) throw new Error('missing multipart images')
  expect(Buffer.from(await image.arrayBuffer())).toEqual(f.image)
  expect(Buffer.from(await mask.arrayBuffer())).toEqual(f.image)
  f.state.mode = 'url'
  expect(await f.providers.generateCustom(f.request, new AbortController().signal)).toEqual(f.image)
  expect(f.observed.at(-1)).toMatchObject({ path: '/generated.png', authorization: undefined })
  f.state.mode = 'foreign-url'
  await expect(f.providers.generateCustom(f.request, new AbortController().signal)).rejects.toMatchObject({ code: 'unsafe-url' })
})

it('keeps platform idempotency and original transfer within its signed-in account', async () => {
  const f = await fixture()
  const job: StoredImageJob = { id: randomUUID() as ImageJobId, status: 'running', createdAt: Date.now(), updatedAt: Date.now(),
    request: { ...f.request, model: { source: 'platform', id: 'platform-image' } }, accountId: f.state.subject,
    favorite: false, archived: false, images: [] }
  const created = await f.providers.createPlatform(job, new AbortController().signal)
  expect(f.observed.at(-1)?.headers['idempotency-key']).toBe(job.id)
  job.remoteId = created.id
  expect((await f.providers.platformStatus(job, false, new AbortController().signal)).state).toBe('succeeded')
  expect(await f.providers.platformImage(job, new AbortController().signal)).toEqual(f.image)
  expect((await f.providers.platformStatus(job, true, new AbortController().signal)).state).toBe('cancelled')
  const requests = f.observed.length
  f.state.subject = 'account-two'
  await expect(f.providers.platformStatus(job, false, new AbortController().signal)).rejects.toMatchObject({ code: 'account-changed' })
  expect(f.observed).toHaveLength(requests)
  f.state.platformStatus = 401
  expect((await f.providers.catalog()).platform).toBe('signed-out')
  expect(f.state.subject).toBe('')
})

it.each(['redirect', 'bad', 'auth'])('does not turn a %s provider reply into a successful image or expose its diagnostics', async (mode) => {
  const f = await fixture()
  f.state.mode = mode
  await expect(f.providers.generateCustom(f.request, new AbortController().signal)).rejects.toMatchObject({
    code: mode === 'redirect' ? 'unsafe-url' : mode === 'auth' ? 'credential-required' : 'upstream-rejected',
  })
  expect(f.observed).toHaveLength(1)
})

it('平台地址与结果下载白名单只能配置纯源，未知模型不能触发请求', async () => {
  const f = await fixture()
  expect(() => new ImageProviders(f.ctx, { ...f.config, platformOrigin: `${f.origin}/path` }, f.store))
    .toThrow('unsafe-url')
  expect(() => new ImageProviders(f.ctx, { ...f.config, downloadOrigins: [`${f.origin}/path`] }, f.store))
    .toThrow('unsafe-url')
  const signal = new AbortController().signal
  await expect(f.providers.generateCustom({ ...f.request, model: { source: 'platform', id: 'platform-image' } }, signal))
    .rejects.toMatchObject({ code: 'model-unavailable' })
  await expect(f.providers.generateCustom({ ...f.request, model: { source: 'custom', provider: 'missing', id: 'custom-image' } }, signal))
    .rejects.toMatchObject({ code: 'model-unavailable' })
  await expect(f.providers.generateCustom({ ...f.request, model: { source: 'custom', provider: 'fixture', id: 'missing' } }, signal))
    .rejects.toMatchObject({ code: 'model-unavailable' })
  expect(f.observed).toEqual([])
})

it('原生提供商先读取记录环境，再读取现有环境凭据；授权凭据不被当作图片密钥', async () => {
  const f = await fixture('openai')
  delete f.profile.apiKeyEnv
  f.keys.set('OPENAI_API_KEY', 'environment-key')
  f.setRecord({ kind: 'api-key', env: { OPENAI_API_KEY: 'record-environment-key' } })
  await f.providers.generateCustom(f.request, new AbortController().signal)
  expect(f.observed.at(-1)?.authorization).toBe('Bearer record-environment-key')
  f.setRecord(undefined)
  await f.providers.generateCustom(f.request, new AbortController().signal)
  expect(f.observed.at(-1)?.authorization).toBe('Bearer environment-key')
  f.keys.delete('OPENAI_API_KEY')
  expect((await f.providers.catalog()).models[0]).toMatchObject({ available: false, unavailableReason: 'credential-required' })
  f.setRecord({ kind: 'grant', payload: { private: 'not-an-image-key' } })
  f.keys.set('OPENAI_API_KEY', 'must-not-fall-through')
  await expect(f.providers.generateCustom(f.request, new AbortController().signal)).rejects.toMatchObject({ code: 'credential-required' })
  expect(f.observed.filter(item => item.path.endsWith('/generations'))).toHaveLength(2)
})

it('缺少凭据服务或非法记录路径时目录仍可检查，但模型不可用', async () => {
  const f = await fixture('custom/image')
  delete f.profile.apiKeyEnv
  const read = vi.spyOn(f.ctx.credentials, 'readRecord')
  expect((await f.providers.catalog()).models[0]?.available).toBe(false)
  expect(read).not.toHaveBeenCalled()
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  ctx.provide('settings', f.ctx.settings)
  const missing = new ImageProviders(ctx, f.config, f.store)
  expect(await missing.catalog()).toMatchObject({ platform: 'signed-out', models: [{ available: false }] })
  const empty = new Context()
  cleanups.push(() => empty.fiber.dispose())
  expect((await new ImageProviders(empty, f.config, f.store).catalog()).models).toEqual([])
})

it.each([
  [403, 'credential-required'], [402, 'insufficient-points'], [409, 'conflict'],
  [422, 'upstream-rejected'], [503, 'upstream-unavailable'],
] as const)('将供应商 HTTP %s 映射为公开分类而不泄露正文', async (status, code) => {
  const f = await fixture()
  f.state.providerStatus = status
  await expect(f.providers.generateCustom(f.request, new AbortController().signal)).rejects.toMatchObject({ code, message: code })
})

it.each([['empty', 'upstream-rejected'], ['missing', 'result-unavailable']] as const)('拒绝 %s 图片结果而不伪装生成成功', async (mode, code) => {
  const f = await fixture()
  f.state.mode = mode
  await expect(f.providers.generateCustom(f.request, new AbortController().signal)).rejects.toMatchObject({ code, uncertain: true })
})

it('平台服务错误只影响平台目录，自定义目录继续可用', async () => {
  const f = await fixture()
  f.state.platformStatus = 503
  expect(await f.providers.catalog()).toMatchObject({ platform: 'unavailable', models: [{ ref: { source: 'custom' } }] })
  vi.spyOn(f.ctx.deepseekAccount, 'resolveToken').mockRejectedValueOnce(new Error('connection interrupted'))
  expect((await f.providers.catalog()).platform).toBe('unavailable')
})

it('多参考图使用 image[] 且不附加不存在的选区，平台编辑传输同一原始字节', async () => {
  const f = await fixture()
  const first = await f.store.saveImage(f.image, 'image/png')
  const otherBytes = await sharp(f.image).jpeg().toBuffer()
  const second = await f.store.saveImage(otherBytes, 'image/jpeg')
  await f.providers.generateCustom({ ...f.request, referenceImageIds: [first.id, second.id] }, new AbortController().signal)
  const sent = f.observed.at(-1)
  const form = await new Response(new Uint8Array(sent?.body ?? []), { headers: { 'content-type': String(sent?.headers['content-type']) } }).formData()
  expect(form.getAll('image[]')).toHaveLength(2)
  expect(form.has('mask')).toBe(false)
  const job: StoredImageJob = { id: randomUUID() as ImageJobId, status: 'running', createdAt: 1, updatedAt: 1,
    request: { ...f.request, model: { source: 'platform', id: 'platform-image' }, referenceImageIds: [first.id], maskImageId: first.id },
    accountId: f.state.subject, favorite: false, archived: false, images: [] }
  await f.providers.createPlatform(job, new AbortController().signal)
  expect(JSON.parse(f.observed.at(-1)?.body.toString() ?? '{}')).toMatchObject({
    references: [{ mime_type: 'image/png', data_base64: f.image.toString('base64') }],
    mask: { mime_type: 'image/png', data_base64: f.image.toString('base64') },
  })
})

it('平台任务没有账号或远端身份时不发出请求', async () => {
  const f = await fixture()
  const job: StoredImageJob = { id: randomUUID() as ImageJobId, status: 'running', createdAt: 1, updatedAt: 1,
    request: { ...f.request, model: { source: 'platform', id: 'platform-image' } }, favorite: false, archived: false, images: [] }
  const signal = new AbortController().signal
  await expect(f.providers.createPlatform(job, signal)).rejects.toMatchObject({ code: 'account-required' })
  await expect(f.providers.platformStatus(job, false, signal)).rejects.toMatchObject({ code: 'not-found' })
  await expect(f.providers.platformImage(job, signal)).rejects.toMatchObject({ code: 'not-found' })
  job.accountId = 'account-one'
  await expect(f.providers.platformStatus(job, false, signal)).rejects.toMatchObject({ code: 'not-found' })
  await expect(f.providers.platformImage(job, signal)).rejects.toMatchObject({ code: 'not-found' })
  expect(f.observed).toEqual([])
})

it('在令牌读取期间或远端响应前切换账号，不接受旧账号结果', async () => {
  const f = await fixture()
  const job: StoredImageJob = { id: randomUUID() as ImageJobId, status: 'running', createdAt: 1, updatedAt: 1,
    request: { ...f.request, model: { source: 'platform', id: 'platform-image' } }, accountId: 'account-one',
    remoteId: 'remote-one', favorite: false, archived: false, images: [] }
  const signal = new AbortController().signal
  const token = vi.spyOn(f.ctx.deepseekAccount, 'resolveToken')
  token.mockResolvedValueOnce(undefined)
  await expect(f.providers.platformImage(job, signal)).rejects.toMatchObject({ code: 'account-required' })
  token.mockImplementationOnce(async () => { f.state.subject = 'account-two'; return f.state.token })
  await expect(f.providers.platformImage(job, signal)).rejects.toMatchObject({ code: 'account-changed' })
  expect(f.observed).toEqual([])
  f.state.subject = 'account-one'
  f.state.afterPlatformReply = true
  await expect(f.providers.platformImage(job, signal)).rejects.toMatchObject({ code: 'account-changed', uncertain: true })
  expect(f.observed).toHaveLength(1)
})

it('允许单独配置的结果源，但下载不发送用户或提供商凭据', async () => {
  const f = await fixture()
  const result = await fixture()
  f.state.resultURL = `${result.origin}/generated.png`
  const configured = new ImageProviders(f.ctx, { ...f.config, downloadOrigins: [result.origin] }, f.store)
  expect(await configured.generateCustom(f.request, new AbortController().signal)).toEqual(result.image)
  expect(result.observed.at(-1)?.authorization).toBeUndefined()
})

it('图片签名与标准 base64 检查拒绝截断和超限输入', async () => {
  const f = await fixture()
  expect(imageMime(f.image)).toBe('image/png')
  expect(imageMime(await sharp(f.image).jpeg().toBuffer())).toBe('image/jpeg')
  expect(imageMime(await sharp(f.image).webp().toBuffer())).toBe('image/webp')
  for (const bytes of [Buffer.from([255]), Buffer.from([255, 216]), Buffer.from('RIFFnotwebp'), Buffer.from('bad')]) {
    expect(() => imageMime(bytes)).toThrow('invalid-input')
  }
  expect(() => imageBytes('AAAAAA==', 1)).toThrow('too-large')
  expect(() => imageBytes('A QI=', 8)).toThrow('invalid-input')
  expect(() => imageBytes('AQID', 2)).toThrow('too-large')
  expect(imageBytes('AQID', 3)).toEqual(Buffer.from([1, 2, 3]))
})

it('公开失败分类保留可恢复业务原因，未知异常不携带内部诊断', () => {
  expect(imageFailureCode(new ImageFailure('insufficient-points'))).toBe('insufficient-points')
  expect(imageFailureCode(new Error('request failed at https://private.example/?key=secret'))).toBe('upstream-unavailable')
})
