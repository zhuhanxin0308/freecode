/** 工作台提交与持久批次的业务验证，不调用真实模型供应商。 */
import { randomBytes, randomUUID } from 'node:crypto'
import { link, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import sharp from 'sharp'
import { afterEach, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import ImageWorkbench from '../src/index.ts'
import { ImageProviders } from '../src/host/providers.ts'
import { ImageStore } from '../src/host/store.ts'
import { ImageQueue } from '../src/host/queue.ts'
import { ImageFailure } from '../src/host/errors.ts'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import { Config, type WorkbenchConfig } from '../src/host/config.ts'
import type { ImageAssetId, ImageJobId, ImageSubmitRequest, ImageSubmissionId } from '../src/types.ts'

const resources: { ctx: Context; root: string }[] = []
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, link: vi.fn(actual.link) }
})
afterEach(async () => {
  for (const { ctx, root } of resources.splice(0)) { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})
async function setup(config: Partial<WorkbenchConfig> = {}, defaultDirectory = false) {
  const root = await mkdtemp(join(tmpdir(), 'freecode-image-service-'))
  const ctx = new Context()
  resources.push({ ctx, root })
  const profile = {
    baseURL: 'https://images.example.invalid/v1', apiKeyEnv: 'IMAGE_TEST_KEY', chatEnabled: false,
    imageModels: [{ id: 'image-model', sizes: ['auto'], qualities: ['auto'], backgrounds: ['auto'], formats: ['png'],
      supportsEdit: true, supportsMask: false, maxReferenceImages: 1 }],
  }
  const settings: Pick<Context['settings'], 'describe'> = { describe: () => [{ ns: 'llm-pi-ai' as import('@deepseek-ai/dsh-settings').SettingsNamespace,
    value: { providers: { fixture: profile } }, autoGenerate: true, schema: {}, revision: 1, applies: 'live' }] }
  ctx.provide('settings', settings)
  ctx.provide('credentials', {
    resolve: async () => ({ value: 'fixture-secret', source: 'fixture' }),
  } satisfies Pick<Context['credentials'], 'resolve'>)
  ctx.provide('typert', { resources: { register: () => async () => {} } satisfies Pick<Context['typert']['resources'], 'register'> })
  const access = { allowed: true }
  ctx.provide('remoteAccess', { allows: () => access.allowed } satisfies Pick<Context['remoteAccess'], 'allows'>)
  const workspace = { id: brandString<WorkspaceId>(randomUUID()), path: join(root, 'workspace'), title: 'Image exports' }
  await mkdir(workspace.path)
  ctx.provide('workspaceRegistry', { list: () => [workspace], get: (id: WorkspaceId) => id === workspace.id ? workspace : undefined } as Context['workspaceRegistry'])
  const entered = Promise.withResolvers<undefined>()
  vi.spyOn(ImageProviders.prototype, 'generateCustom').mockImplementation(async (_request, signal) => {
    entered.resolve(undefined)
    signal.throwIfAborted()
    return new Promise<Buffer>((_resolve, reject) => {
      signal.addEventListener('abort', () => { reject(new Error('fixture request aborted')) }, { once: true })
    })
  })
  if (defaultDirectory) vi.stubEnv('DSH_HOME', root)
  const service = defaultDirectory ? new ImageWorkbench(ctx) : new ImageWorkbench(ctx, { directory: root, ...config })
  await service[Service.init]()
  return { service, ctx, root, workspace, access, profile, entered: entered.promise }
}
function input(): ImageSubmitRequest {
  return { submissionId: randomUUID() as ImageSubmissionId, count: 2,
    request: { model: { source: 'custom', provider: 'fixture', id: 'image-model' }, prompt: 'blue square',
      size: 'auto', quality: 'auto', background: 'auto', format: 'png', referenceImageIds: [] } }
}

it('returns the same durable batch on repeated submissions and refuses identity reuse for changed input', async () => {
  const { service } = await setup()
  const request = input()
  const [first, repeated] = await Promise.all([service.submit(request), service.submit(request)])
  expect(first.map(job => job.id)).toEqual(repeated.map(job => job.id))
  expect((await service.listJobs({ limit: 20 })).jobs).toHaveLength(2)
  await expect(service.submit({ ...request, count: 1 })).rejects.toMatchObject({ details: { reason: 'conflict' } })
  expect(JSON.stringify(first)).not.toContain('fixture-secret')
  expect(JSON.stringify(await service.catalog())).not.toContain('images.example.invalid')
})

it('rejects unsupported parameters and out-of-range batch sizes before creating history', async () => {
  const { service } = await setup()
  const request = input()
  await expect(service.submit({ ...request, count: 0 })).rejects.toMatchObject({ details: { reason: 'invalid-input' } })
  await expect(service.submit({ ...request, request: { ...request.request, quality: 'high' } })).rejects.toMatchObject({ details: { reason: 'invalid-input' } })
  expect((await service.listJobs({ limit: 20 })).jobs).toEqual([])
})

it('imports intact originals and publishes a complete workspace file without replacing existing content', async () => {
  const { service, workspace, access } = await setup()
  const original = await sharp({ create: { width: 16, height: 12, channels: 4, background: '#3355ffaa' } }).png().toBuffer()
  const asset = await service.importImage({ mimeType: 'image/png', dataBase64: original.toString('base64') })
  expect(await service.describeImage(asset.id)).toEqual(asset)
  expect(Buffer.from((await service.readImage(asset.id, 'original')).dataBase64, 'base64')).toEqual(original)
  expect((await service.readImage(asset.id, 'thumbnail')).mimeType).toBe('image/webp')
  expect(await service.listWorkspaces()).toEqual([{ id: workspace.id, name: workspace.title }])
  const destination = { workspaceId: workspace.id, fileName: 'original.png' }
  const exported = await service.exportImage(asset.id, destination)
  expect(await readFile(exported.path)).toEqual(original)
  await writeFile(exported.path, 'user changed content')
  await expect(service.exportImage(asset.id, destination)).rejects.toMatchObject({ details: { reason: 'conflict' } })
  expect(await readFile(exported.path, 'utf8')).toBe('user changed content')
  for (const fileName of ['../escape.png', 'folder\\escape.png', 'CON.png', 'trailing.png ', 'wrong.jpg', '']) {
    await expect(service.exportImage(asset.id, { ...destination, fileName })).rejects.toMatchObject({ details: { reason: 'invalid-input' } })
  }
  access.allowed = false
  expect(await service.listWorkspaces()).toEqual([])
  await expect(service.exportImage(asset.id, { ...destination, fileName: 'denied.png' })).rejects.toMatchObject({ details: { reason: 'not-found' } })
  await expect(service.describeImage('a'.repeat(64) as ImageAssetId)).rejects.toMatchObject({ details: { reason: 'not-found' } })
})

it('keeps favorite, archive, pagination and branch metadata while cancelling only unstarted custom work', async () => {
  const { service, entered } = await setup()
  const batch = await service.submit(input())
  await entered
  const first = batch[0], second = batch[1]
  if (first === undefined || second === undefined) throw new Error('missing submitted batch')
  expect((await service.favorite(first.id, true)).favorite).toBe(true)
  expect((await service.listJobs({ limit: 10, favoritesOnly: true })).jobs.map(job => job.id)).toEqual([first.id])
  expect((await service.archive(first.id, true)).archived).toBe(true)
  expect((await service.listJobs({ limit: 10 })).jobs.map(job => job.id)).toEqual([second.id])
  expect((await service.listJobs({ limit: 10, archived: true })).jobs.map(job => job.id)).toEqual([first.id])
  await service.archive(first.id, false)
  const page = await service.listJobs({ limit: 1 })
  expect(page.nextCursor).toBeDefined()
  if (page.nextCursor === undefined) throw new Error('缺少历史分页游标')
  const next = await service.listJobs({ limit: 1, cursor: page.nextCursor })
  expect(next.jobs).toHaveLength(1)
  expect(next.jobs[0]?.id).not.toBe(page.jobs[0]?.id)
  await expect(service.cancel(first.id)).rejects.toMatchObject({ details: { reason: 'cancel-unavailable' } })
  expect((await service.cancel(second.id)).status).toBe('cancelled')
  const branch = input()
  branch.count = 1
  branch.request.parentJobId = first.id
  expect((await service.submit(branch))[0]?.request.parentJobId).toBe(first.id)
  await expect(service.listJobs({ limit: 0 })).rejects.toMatchObject({ details: { reason: 'invalid-input' } })
  await expect(service.listJobs({ limit: 1, cursor: randomUUID() as ImageJobId })).rejects.toMatchObject({ details: { reason: 'not-found' } })
  await expect(service.favorite(randomUUID() as ImageJobId, true)).rejects.toMatchObject({ details: { reason: 'not-found' } })
})

it('validates reference ownership, mask capability and dimensions before accepting edit requests', async () => {
  const { service, profile } = await setup()
  const original = await sharp({ create: { width: 16, height: 12, channels: 4, background: '#3344ff00' } }).png().toBuffer()
  const asset = await service.importImage({ mimeType: 'image/png', dataBase64: original.toString('base64') })
  const draft = input()
  draft.count = 1
  draft.request.referenceImageIds = [asset.id]
  draft.request.maskImageId = asset.id
  await expect(service.submit(draft)).rejects.toMatchObject({ details: { reason: 'invalid-input' } })
  const model = profile.imageModels[0]
  if (model === undefined) throw new Error('missing fixture model')
  model.supportsMask = true
  const result = await service.submit(draft)
  expect(result[0]?.request.maskImageId).toBe(asset.id)
  const missing = input()
  missing.request.referenceImageIds = ['f'.repeat(64) as ImageAssetId]
  await expect(service.submit(missing)).rejects.toMatchObject({ details: { reason: 'not-found' } })
  const wrongMask = await service.importImage({ mimeType: 'image/png', dataBase64: (await sharp(original).resize(8, 8).png().toBuffer()).toString('base64') })
  await expect(service.submit({ ...input(), request: { ...draft.request, maskImageId: wrongMask.id } }))
    .rejects.toMatchObject({ details: { reason: 'invalid-input' } })
})

it('filters the full history before pagination so older active work and matching prompts remain discoverable', async () => {
  const { service, root, entered } = await setup()
  const batch = await service.submit(input())
  await entered
  const active = batch[0], queued = batch[1]
  if (active === undefined || queued === undefined) throw new Error('missing batch')
  await service.cancel(queued.id)
  const store = new ImageStore({ ...Config({ directory: root }), directory: root })
  await store.transaction((journal) => {
    const first = journal.jobs.find(job => job.id === active.id)
    if (first === undefined) throw new Error('missing active job')
    first.createdAt = 1
    for (let index = 0; index < 30; index++) {
      const completed = structuredClone(first)
      completed.id = randomUUID() as ImageJobId
      completed.createdAt = index + 10
      completed.status = 'failed'
      completed.request.prompt = 'unrelated previous result'
      completed.request.model.id = 'other-model'
      delete completed.owner
      journal.jobs.push(completed)
    }
  })
  expect((await service.listJobs({ limit: 1, activeOnly: true })).jobs.map(job => job.id)).toEqual([active.id])
  const found = await service.listJobs({ limit: 1, search: '  BLUE SQUARE  ', activeOnly: true })
  expect(found.jobs.map(job => job.id)).toEqual([active.id])
  expect(found.nextCursor).toBeUndefined()
  expect((await service.listJobs({ limit: 1, search: 'IMAGE-MODEL', activeOnly: true })).jobs.map(job => job.id)).toEqual([active.id])
  expect((await service.listJobs({ limit: 10, search: 'no matching image' })).jobs).toEqual([])
  await expect(service.listJobs({ limit: 1, search: 'x'.repeat((await service.catalog()).limits.maxPromptLength + 1) }))
    .rejects.toMatchObject({ details: { reason: 'invalid-input' } })
})

it('缺省目录遵循用户数据根，凭据变化只唤醒同一队列', async () => {
  const wake = vi.spyOn(ImageQueue.prototype, 'wake').mockImplementation(() => {})
  const f = await setup({}, true)
  expect(await readdir(f.root)).toContain('image-workbench')
  expect(wake).toHaveBeenCalledOnce()
  f.ctx.emit('credentials/reference-updated', credentialRef('IMAGE_TEST_KEY'))
  f.ctx.emit('credentials/record-updated', credentialKey('provider', 'fixture'))
  expect(wake).toHaveBeenCalledTimes(3)
  await expect(setup({ maxImageBytes: 1024, maxInputImageBytes: 2048 })).rejects.toThrow('图片输入上限不能超过原图存储上限')
})

it('索引初始化期间卸载不会在完成读取后启动队列', async () => {
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  vi.spyOn(ImageStore.prototype, 'initialize').mockImplementation(async () => { entered.resolve(undefined); await release.promise })
  const wake = vi.spyOn(ImageQueue.prototype, 'wake').mockImplementation(() => {})
  const pending = setup()
  await entered.promise
  const owner = resources.at(-1)
  if (owner === undefined) throw new Error('初始化夹具缺少生命周期拥有者')
  await owner.ctx.fiber.dispose()
  release.resolve(undefined)
  const f = await pending
  expect(wake).not.toHaveBeenCalled()
  await expect(f.service.catalog()).rejects.toMatchObject({ code: 'image-workbench/rejected' })
})

it('超长空白输入和不可用目录在创建历史前被拒绝', async () => {
  const f = await setup({ maxPromptLength: 8 })
  for (const prompt of [' ', 'description too long']) {
    await expect(f.service.submit({ ...input(), request: { ...input().request, prompt } }))
      .rejects.toMatchObject({ details: { reason: 'invalid-input' } })
  }
  const missing = input(); missing.request.model.id = 'missing'; missing.request.prompt = 'image'
  await expect(f.service.submit(missing)).rejects.toMatchObject({ details: { reason: 'model-unavailable' } })
  const platform = input(); platform.request.model = { source: 'platform', id: 'online' }; platform.request.prompt = 'image'
  await expect(f.service.submit(platform)).rejects.toMatchObject({ details: { reason: 'account-required' } })
  const catalog = await f.service.catalog()
  const available = catalog.models[0]
  if (available === undefined) throw new Error('缺少图片目录')
  const mocked = vi.spyOn(ImageProviders.prototype, 'catalog')
  for (const unavailable of [{ ...available, available: false },
    { ...available, available: false, unavailableReason: 'credential-required' as const }]) {
    mocked.mockResolvedValueOnce({ ...catalog, models: [unavailable] })
    await expect(f.service.submit({ ...input(), request: { ...input().request, prompt: 'image' } }))
      .rejects.toMatchObject({ details: { reason: unavailable.unavailableReason ?? 'model-unavailable' } })
  }
  mocked.mockResolvedValueOnce({ ...catalog, models: [{ ...available, ref: platform.request.model }], platform: 'available' })
  await expect(f.service.submit(platform)).rejects.toMatchObject({ details: { reason: 'account-required' } })
  expect((await f.service.listJobs({ limit: 20 })).jobs).toEqual([])
})

it('透明JPEG与过大的原图或参考图总量不能成为生成输入', async () => {
  vi.spyOn(ImageQueue.prototype, 'wake').mockImplementation(() => {})
  const f = await setup({ maxInputImageBytes: 1024, maxReferenceBytes: 1024 })
  const catalog = await f.service.catalog()
  const model = catalog.models[0]
  if (model === undefined) throw new Error('缺少图片目录')
  vi.spyOn(ImageProviders.prototype, 'catalog').mockResolvedValueOnce({ ...catalog, models: [{ ...model,
    formats: ['png', 'jpeg'], backgrounds: ['auto', 'transparent'] }] })
  const request = input()
  await expect(f.service.submit({ ...request, request: { ...request.request, format: 'jpeg', background: 'transparent' } }))
    .rejects.toMatchObject({ details: { reason: 'invalid-input' } })
  const config = Config({ directory: f.root })
  const store = new ImageStore({ ...config, directory: f.root })
  const largeBytes = await sharp(randomBytes(64 * 64 * 3), { raw: { width: 64, height: 64, channels: 3 } }).png().toBuffer()
  const large = await store.saveImage(largeBytes, 'image/png')
  await expect(f.service.submit({ ...input(), request: { ...request.request, referenceImageIds: [large.id] } }))
    .rejects.toMatchObject({ details: { reason: 'too-large' } })
  const smallBytes = await sharp({ create: { width: 64, height: 64, channels: 4, background: '#ffffff' } }).png().toBuffer()
  const small = await store.saveImage(smallBytes, 'image/png')
  f.profile.imageModels[0]!.supportsMask = true
  await expect(f.service.submit({ ...input(), request: { ...request.request, referenceImageIds: [small.id], maskImageId: large.id } }))
    .rejects.toMatchObject({ details: { reason: 'too-large' } })
  const limited = await setup({ maxInputImageBytes: 32768, maxReferenceBytes: 1024 })
  limited.profile.imageModels[0]!.supportsMask = true
  const imported = await limited.service.importImage({ mimeType: 'image/png', dataBase64: largeBytes.toString('base64') })
  await expect(limited.service.submit({ ...input(), request: { ...request.request, referenceImageIds: [imported.id] } }))
    .rejects.toMatchObject({ details: { reason: 'too-large' } })
  const tiny = await limited.service.importImage({ mimeType: 'image/png', dataBase64: smallBytes.toString('base64') })
  await expect(limited.service.submit({ ...input(), request: { ...request.request,
    referenceImageIds: [tiny.id], maskImageId: imported.id } }))
    .rejects.toMatchObject({ details: { reason: 'too-large' } })
})

it('平台取消只认可服务端确认，并完整保留实际费用与失败状态', async () => {
  vi.spyOn(ImageQueue.prototype, 'wake').mockImplementation(() => {})
  const f = await setup()
  const batch = await f.service.submit(input())
  const first = batch[0]
  if (first === undefined) throw new Error('缺少任务')
  const store = new ImageStore({ ...Config({ directory: f.root }), directory: f.root })
  await store.transaction((journal) => {
    const item = journal.jobs[0]!
    item.request.model = { source: 'platform', id: 'online' }
    item.remoteId = 'remote-id'; item.accountId = 'account'; item.error = { code: 'upstream-unavailable' }; item.chargedUnits = '10000000'
  })
  const status = vi.spyOn(ImageProviders.prototype, 'platformStatus')
  status.mockResolvedValueOnce({ id: 'remote-id', state: 'running' })
  await expect(f.service.cancel(first.id)).rejects.toMatchObject({ details: { reason: 'cancel-unavailable' } })
  status.mockRejectedValueOnce(new ImageFailure('conflict'))
  await expect(f.service.cancel(first.id)).rejects.toMatchObject({ details: { reason: 'cancel-unavailable' } })
  status.mockRejectedValueOnce(new ImageFailure('account-required'))
  await expect(f.service.cancel(first.id)).rejects.toMatchObject({ details: { reason: 'account-required' } })
  status.mockRejectedValueOnce(new Error('network failed'))
  await expect(f.service.cancel(first.id)).rejects.toMatchObject({ details: { reason: 'upstream-unavailable' } })
  const view = (await f.service.listJobs({ limit: 20 })).jobs.find(job => job.id === first.id)
  expect(view).toMatchObject({ error: { code: 'upstream-unavailable' }, chargedUnits: '10000000' })
  expect(view).not.toHaveProperty('accountId')
  expect(view).not.toHaveProperty('remoteId')
  status.mockResolvedValueOnce({ id: 'remote-id', state: 'cancelled' })
  expect((await f.service.cancel(first.id)).status).toBe('cancelled')
})

it('JPEG原图导出不转换编码，发布文件失败后清理临时文件', async () => {
  const f = await setup()
  const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#4488ff' } }).jpeg().toBuffer()
  const asset = await f.service.importImage({ mimeType: 'image/jpeg', dataBase64: bytes.toString('base64') })
  const saved = await f.service.exportImage(asset.id, { workspaceId: f.workspace.id, fileName: 'original.jpg' })
  expect(await readFile(saved.path)).toEqual(bytes)
  vi.mocked(link).mockRejectedValueOnce(Object.assign(new Error('device unavailable'), { code: 'EIO' }))
  await expect(f.service.exportImage(asset.id, { workspaceId: f.workspace.id, fileName: 'failed.jpeg' }))
    .rejects.toMatchObject({ details: { reason: 'storage' } })
  expect(await readdir(f.workspace.path)).toEqual(['original.jpg'])
})

it('平台提交绑定当时账号，目录下线后重放仍找回已受理的同一任务', async () => {
  vi.spyOn(ImageQueue.prototype, 'wake').mockImplementation(() => {})
  const f = await setup()
  const catalog = await f.service.catalog()
  const model = catalog.models[0]
  if (model === undefined) throw new Error('缺少图片模型')
  const request = input(); request.count = 1; request.request.model = { source: 'platform', id: 'online' }
  const models = vi.spyOn(ImageProviders.prototype, 'catalog').mockResolvedValue({ ...catalog,
    platform: 'available', models: [{ ...model, ref: request.request.model }] })
  vi.spyOn(ImageProviders.prototype, 'accountId').mockResolvedValue('signed-in-account')
  const batch = await f.service.submit(request)
  const store = new ImageStore({ ...Config({ directory: f.root }), directory: f.root })
  expect((await store.read()).jobs[0]?.accountId).toBe('signed-in-account')
  expect(batch[0]).not.toHaveProperty('accountId')
  models.mockResolvedValue({ ...catalog, models: [], platform: 'signed-out' })
  expect(await f.service.submit(request)).toEqual(batch)
  expect(models).toHaveBeenCalledOnce()
})

it('取消在等待文件锁期间遇到任务派发时保留运行状态', async () => {
  vi.spyOn(ImageQueue.prototype, 'wake').mockImplementation(() => {})
  const f = await setup()
  const batch = await f.service.submit({ ...input(), count: 1 })
  const first = batch[0]
  if (first === undefined) throw new Error('缺少排队任务')
  const store = new ImageStore({ ...Config({ directory: f.root }), directory: f.root })
  let cancellation: Promise<unknown> | undefined
  // oxlint-disable-next-line typescript/unbound-method -- 下方用 call(this) 保留实际读取实例。
  const read = ImageStore.prototype.read
  await store.transaction(async (journal) => {
    const observed = Promise.withResolvers<undefined>()
    vi.spyOn(ImageStore.prototype, 'read').mockImplementationOnce(async function (this: ImageStore) {
      const snapshot = await read.call(this); observed.resolve(undefined); return snapshot
    })
    cancellation = f.service.cancel(first.id).then(value => value, (error: unknown) => error)
    await observed.promise
    journal.jobs[0]!.status = 'running'
    journal.jobs[0]!.owner = { pid: process.pid, instance: 'worker' }
  })
  expect(await cancellation).toMatchObject({ details: { reason: 'cancel-unavailable' } })
  expect((await store.read()).jobs[0]?.status).toBe('running')
})
