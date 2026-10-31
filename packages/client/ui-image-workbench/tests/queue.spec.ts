/** 后台任务在页面关闭和主机重启时仍遵守已派发请求的去重规则。 */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, expect, it, vi } from 'vitest'
import { ImageQueue, type ImageQueueProviders } from '../src/host/queue.ts'
import { ImageStore } from '../src/host/store.ts'
import { Config, type WorkbenchConfig } from '../src/host/config.ts'
import type { StoredImageJob } from '../src/host/schemas.ts'
import type { ImageJobId } from '../src/types.ts'

const roots: string[] = []
const queues: ImageQueue[] = []
afterEach(async () => {
  await Promise.all(queues.splice(0).map(queue => queue.close()))
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
  vi.restoreAllMocks()
})
async function setup(overrides: Partial<WorkbenchConfig> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'freecode-image-queue-'))
  roots.push(directory)
  const config = Config({ directory, ...overrides })
  const store = new ImageStore({ ...config, directory })
  await store.initialize()
  const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#5577ff' } }).png().toBuffer()
  const providers = { accountId: vi.fn<ImageQueueProviders['accountId']>(async () => 'account-one'),
    generateCustom: vi.fn<ImageQueueProviders['generateCustom']>(async () => image),
    createPlatform: vi.fn<ImageQueueProviders['createPlatform']>(async () => ({ id: 'remote-one', state: 'queued' })),
    platformStatus: vi.fn<ImageQueueProviders['platformStatus']>(async () => ({ id: 'remote-one', state: 'succeeded' })),
    platformImage: vi.fn(async () => image) }
  return { config, store, providers }
}
function job(): StoredImageJob {
  return { id: randomUUID() as ImageJobId, createdAt: Date.now(), updatedAt: Date.now(), status: 'queued',
    request: { model: { source: 'custom', provider: 'fixture', id: 'image-model' }, prompt: 'blue square',
      size: 'auto', quality: 'auto', background: 'auto', format: 'png', referenceImageIds: [] },
    favorite: false, archived: false, images: [] }
}

it('resumes queued work but never resends a custom request interrupted during execution', async () => {
  const { config, store, providers } = await setup()
  const first = job(), second = job()
  await store.transaction((state) => { state.jobs.push(first, second) })
  const entered = Promise.withResolvers<undefined>()
  providers.generateCustom.mockImplementationOnce(async (_request, signal) => {
    entered.resolve(undefined)
    return new Promise<Buffer>((_resolve, reject) => {
      signal.addEventListener('abort', () => { reject(new Error('request aborted')) }, { once: true })
    })
  })
  const queue = new ImageQueue(store, providers, config)
  queues.push(queue)
  queue.wake()
  await entered.promise
  expect((await store.read()).jobs.map(row => row.status)).toEqual(['running', 'queued'])
  await queue.close()
  expect((await store.read()).jobs.map(row => row.status)).toEqual(['uncertain', 'queued'])
  const resumed = new ImageQueue(store, providers, config)
  queues.push(resumed)
  resumed.wake()
  await expect.poll(async () => (await store.read()).jobs[1]?.status).toBe('succeeded')
  expect(providers.generateCustom).toHaveBeenCalledTimes(2)
  expect((await store.read()).jobs[0]?.status).toBe('uncertain')
})

it('recovers a platform result by its persisted remote identity without recreating it', async () => {
  const { config, store, providers } = await setup()
  const previous = job()
  previous.request.model = { source: 'platform', id: 'image-model' }
  previous.status = 'running'
  previous.accountId = 'account-one'
  previous.remoteId = 'remote-one'
  await store.transaction((state) => { state.jobs.push(previous) })
  const queue = new ImageQueue(store, providers, config)
  queues.push(queue)
  queue.wake()
  await expect.poll(async () => (await store.read()).jobs[0]?.status).toBe('succeeded')
  expect(providers.createPlatform).not.toHaveBeenCalled()
  expect(providers.platformStatus).toHaveBeenCalledOnce()
  expect((await store.read()).jobs[0]?.images).toHaveLength(1)
})

it('keeps later platform jobs local while the first is pending instead of multiplying account polling traffic', async () => {
  const { config, store, providers } = await setup({ pollIntervalMs: 250 })
  const first = job(), second = job()
  for (const item of [first, second]) { item.request.model = { source: 'platform', id: 'image-model' }; item.accountId = 'account-one' }
  await store.transaction((state) => { state.jobs.push(first, second) })
  let complete = false
  const polled = Promise.withResolvers<undefined>()
  providers.createPlatform.mockImplementation(async item => ({ id: item.id, state: 'queued' }))
  providers.platformStatus.mockImplementation(async (item) => {
    polled.resolve(undefined)
    return { id: item.remoteId ?? item.id, state: complete ? 'succeeded' : 'running' }
  })
  const queue = new ImageQueue(store, providers, config)
  queues.push(queue)
  queue.wake()
  await polled.promise
  expect(providers.createPlatform).toHaveBeenCalledTimes(1)
  expect((await store.read()).jobs[1]).toMatchObject({ status: 'queued' })
  complete = true
  await expect.poll(async () => (await store.read()).jobs.every(item => item.status === 'succeeded'), { timeout: 5000 }).toBe(true)
  expect(providers.createPlatform).toHaveBeenCalledTimes(2)
})

it('does not lose a submission that arrives after the worker reads an empty queue but before it exits', async () => {
  const { config, store, providers } = await setup()
  const idleRead = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const read = store.read.bind(store)
  let reads = 0
  vi.spyOn(store, 'read').mockImplementation(async () => {
    const state = await read()
    // 首次读取属于领取事务，第二次是本轮是否继续等待的检查。
    if (++reads === 2) { idleRead.resolve(undefined); await release.promise }
    return state
  })
  const queue = new ImageQueue(store, providers, config)
  queues.push(queue)
  queue.wake()
  await idleRead.promise
  await store.transaction((state) => { state.jobs.push(job()) })
  queue.wake()
  release.resolve(undefined)
  await expect.poll(async () => (await store.read()).jobs[0]?.status).toBe('succeeded')
  expect(providers.generateCustom).toHaveBeenCalledOnce()
})

it('holds another account’s platform jobs with an explicit reason and resumes them only after the original account returns', async () => {
  const { config, store, providers } = await setup({ pollIntervalMs: 250 })
  const previous = job(), waiting = job()
  for (const item of [previous, waiting]) { item.request.model = { source: 'platform', id: 'image-model' }; item.accountId = 'account-one' }
  previous.status = 'running'
  previous.remoteId = 'remote-one'
  await store.transaction((state) => { state.jobs.push(previous, waiting) })
  providers.accountId.mockResolvedValue('account-two')
  const queue = new ImageQueue(store, providers, config)
  queues.push(queue)
  queue.wake()
  await expect.poll(async () => (await store.read()).jobs.map(item => item.error?.code)).toEqual(['account-changed', 'account-changed'])
  expect((await store.read()).jobs.map(item => item.status)).toEqual(['uncertain', 'queued'])
  expect(providers.platformStatus).not.toHaveBeenCalled()
  expect(providers.createPlatform).not.toHaveBeenCalled()
  providers.accountId.mockResolvedValue(undefined)
  queue.wake()
  await expect.poll(async () => (await store.read()).jobs[0]?.error?.code).toBe('account-required')
  providers.accountId.mockResolvedValue('account-one')
  queue.wake()
  await expect.poll(async () => (await store.read()).jobs.every(item => item.status === 'succeeded'), { timeout: 5000 }).toBe(true)
  expect(providers.createPlatform).toHaveBeenCalledTimes(1)
})
