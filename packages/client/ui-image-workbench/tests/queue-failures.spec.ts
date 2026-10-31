/** 后台拥有权、失败结果与关闭顺序的确定性验证。 */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as timers from 'node:timers/promises'
import sharp from 'sharp'
import { afterEach, expect, it, vi } from 'vitest'
import { Config } from '../src/host/config.ts'
import { ImageQueue, type ImageQueueProviders } from '../src/host/queue.ts'
import { ImageStore } from '../src/host/store.ts'
import { ImageFailure } from '../src/host/errors.ts'
import type { StoredImageJob } from '../src/host/schemas.ts'
import type { ImageJobId } from '../src/types.ts'

vi.mock('node:timers/promises', async (original) => {
  const actual = await original<typeof import('node:timers/promises')>()
  return { ...actual, setTimeout: vi.fn(actual.setTimeout) }
})
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
  vi.mocked(timers.setTimeout).mockRestore()
  vi.restoreAllMocks()
})
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'freecode-image-queue-failure-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const config = Config({ directory, pollIntervalMs: 250 })
  const store = new ImageStore({ ...config, directory })
  await store.initialize()
  const bytes = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#5577ff' } }).png().toBuffer()
  const providers = { accountId: vi.fn<ImageQueueProviders['accountId']>(async () => 'account-one'),
    generateCustom: vi.fn<ImageQueueProviders['generateCustom']>(async () => bytes),
    createPlatform: vi.fn<ImageQueueProviders['createPlatform']>(async () => ({ id: 'remote-one', state: 'queued' })),
    platformStatus: vi.fn<ImageQueueProviders['platformStatus']>(async () => ({ id: 'remote-one', state: 'succeeded', charged_units: '10000000' })),
    platformImage: vi.fn<ImageQueueProviders['platformImage']>(async () => bytes) }
  const queue = new ImageQueue(store, providers, config)
  cleanups.push(() => queue.close())
  return { store, providers, queue }
}
function job(platform = false): StoredImageJob {
  return { id: randomUUID() as ImageJobId, createdAt: 1, updatedAt: 1, status: 'queued', favorite: false, archived: false, images: [],
    request: { model: platform ? { source: 'platform', id: 'image' } : { source: 'custom', provider: 'fixture', id: 'image' },
      prompt: 'blue sky', size: 'auto', quality: 'auto', format: 'png', background: 'auto', referenceImageIds: [] },
    ...platform ? { accountId: 'account-one' } : {} }
}

it.each([
  { error: Object.assign(new Error('not permitted'), { code: 'EPERM' }), alive: true },
  { error: new Error('unclassified system failure'), alive: true },
  { error: 'unclassified native failure', alive: true },
  { error: Object.assign(new Error('missing process'), { code: 'ESRCH' }), alive: false },
])('只有确认旧进程不存在才释放拥有权 $alive', async ({ error, alive }) => {
  const f = await setup()
  const previous = job()
  previous.status = 'running'
  previous.owner = { pid: 7654321, instance: 'previous-process' }
  await f.store.transaction((state) => { state.jobs.push(previous) })
  const checked = Promise.withResolvers<undefined>()
  vi.spyOn(process, 'kill').mockImplementation(() => { checked.resolve(undefined); throw error })
  f.queue.wake()
  await checked.promise
  if (alive) {
    await expect.poll(async () => (await f.store.read()).jobs[0]?.owner?.instance).toBe('previous-process')
  } else {
    await expect.poll(async () => (await f.store.read()).jobs[0]?.status).toBe('uncertain')
    expect((await f.store.read()).jobs[0]?.owner).toBeUndefined()
  }
  expect(f.providers.generateCustom).not.toHaveBeenCalled()
  await f.queue.close()
})

it('仍活着的拥有进程阻止另一执行器重复派发', async () => {
  const f = await setup()
  const previous = job()
  previous.status = 'running'; previous.owner = { pid: process.pid, instance: 'another-instance' }
  await f.store.transaction((state) => { state.jobs.push(previous) })
  const signal = Promise.withResolvers<undefined>()
  const kill = process.kill.bind(process)
  vi.spyOn(process, 'kill').mockImplementation((pid, value) => { const result = kill(pid, value); signal.resolve(undefined); return result })
  f.queue.wake()
  await signal.promise
  await f.queue.close()
  expect(f.providers.generateCustom).not.toHaveBeenCalled()
  expect((await f.store.read()).jobs[0]?.owner).toEqual(previous.owner)
})

it('领取后的关闭会归还尚未派发任务，关闭完成后不接受新唤醒', async () => {
  const f = await setup()
  const pending = job()
  await f.store.transaction((state) => { state.jobs.push(pending) })
  const claimed = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const transaction = f.store.transaction.bind(f.store)
  let delayed = false
  vi.spyOn(f.store, 'transaction').mockImplementation(async (mutate) => {
    const result = await transaction(mutate)
    if (!delayed) { delayed = true; claimed.resolve(undefined); await release.promise }
    return result
  })
  f.queue.wake()
  await claimed.promise
  const closing = f.queue.close()
  release.resolve(undefined)
  await closing
  expect((await f.store.read()).jobs[0]).toMatchObject({ status: 'queued' })
  expect((await f.store.read()).jobs[0]?.owner).toBeUndefined()
  expect(f.providers.generateCustom).not.toHaveBeenCalled()
  expect(() => { f.queue.assertHealthy() }).toThrow('cancel-unavailable')
  f.queue.wake()
  expect(f.providers.generateCustom).not.toHaveBeenCalled()
})

it('读取或计时基础设施失效后暂停受理，不把后台异常静默当成空队列', async () => {
  const brokenRead = await setup()
  vi.spyOn(brokenRead.store, 'transaction').mockRejectedValueOnce(new ImageFailure('storage'))
  brokenRead.queue.wake()
  await expect.poll(() => { try { brokenRead.queue.assertHealthy(); return '' } catch (error) { return String(error) } })
    .toContain('storage')
  brokenRead.queue.wake()
  expect(brokenRead.providers.generateCustom).not.toHaveBeenCalled()
  const brokenTimer = await setup()
  await brokenTimer.store.transaction((state) => { state.jobs.push(job(true)) })
  vi.mocked(timers.setTimeout).mockRejectedValueOnce(new Error('timer failure'))
  brokenTimer.queue.wake()
  await expect.poll(() => { try { brokenTimer.queue.assertHealthy(); return '' } catch (error) { return String(error) } })
    .toContain('storage')
})

it.each(['deleted', 'released', 'reassigned'] as const)('迟到结果不改写已经%s的任务', async (change) => {
  const f = await setup()
  const pending = job()
  await f.store.transaction((state) => { state.jobs.push(pending) })
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<Buffer>()
  f.providers.generateCustom.mockImplementationOnce(() => { entered.resolve(undefined); return release.promise })
  f.queue.wake()
  await entered.promise
  await f.store.transaction((state) => {
    const active = state.jobs[0]!
    if (change === 'deleted') state.jobs = []
    else if (change === 'released') { active.status = 'cancelled'; delete active.owner }
    else { active.owner = { pid: process.pid, instance: 'new-owner' } }
  })
  release.resolve(await sharp({ create: { width: 1, height: 1, channels: 3, background: '#555555' } }).png().toBuffer())
  await expect.poll(async () => (await f.store.read()).assets.length).toBe(1)
  await f.queue.close()
  const state = await f.store.read()
  if (change === 'deleted') expect(state.jobs).toEqual([])
  else {
    expect(state.jobs[0]?.images).toEqual([])
    expect(state.jobs[0]?.status).toBe(change === 'released' ? 'cancelled' : 'running')
  }
})

it.each([
  { error: new ImageFailure('upstream-rejected'), expected: 'failed' },
  { error: new ImageFailure('result-unavailable', true), expected: 'uncertain' },
  { error: new Error('unexpected connection termination'), expected: 'uncertain' },
])('自定义任务将请求失败明确保存为$expected且不盲目重发', async ({ error, expected }) => {
  const f = await setup()
  await f.store.transaction((state) => { state.jobs.push(job()) })
  f.providers.generateCustom.mockRejectedValueOnce(error)
  f.queue.wake()
  await expect.poll(async () => (await f.store.read()).jobs[0]?.status).toBe(expected)
  expect(f.providers.generateCustom).toHaveBeenCalledOnce()
})

it.each([
  { state: 'failed' as const, error_code: 'insufficient_points', code: 'insufficient-points' },
  { state: 'failed' as const, error_code: 'provider_refused', code: 'upstream-rejected' },
  { state: 'cancelled' as const, error_code: '', code: undefined },
])('平台$state保留真实结束状态与原因', async ({ state, error_code, code }) => {
  const f = await setup()
  await f.store.transaction((value) => { value.jobs.push(job(true)) })
  f.providers.createPlatform.mockResolvedValueOnce({ id: 'remote-one', state, error_code })
  f.queue.wake()
  await expect.poll(async () => (await f.store.read()).jobs[0]?.status).toBe(state)
  expect((await f.store.read()).jobs[0]?.error?.code).toBe(code)
  expect(f.providers.platformImage).not.toHaveBeenCalled()
})

it('平台待核对和已生成图片读取失败只恢复原任务，完成后记录实际扣费', async () => {
  const f = await setup()
  await f.store.transaction((state) => { state.jobs.push(job(true)) })
  f.providers.createPlatform.mockResolvedValueOnce({ id: 'remote-one', state: 'uncertain', error_code: 'pending' })
  f.providers.platformImage.mockRejectedValueOnce(new ImageFailure('storage'))
  f.queue.wake()
  await expect.poll(async () => (await f.store.read()).jobs[0]?.status, { timeout: 5000 }).toBe('succeeded')
  expect(f.providers.createPlatform).toHaveBeenCalledOnce()
  expect(f.providers.platformStatus).toHaveBeenCalledTimes(2)
  expect((await f.store.read()).jobs[0]?.chargedUnits).toBe('10000000')
})

it('平台确定拒绝创建时结束任务，不误用本机幂等键重试收费', async () => {
  const f = await setup()
  await f.store.transaction((state) => { state.jobs.push(job(true)) })
  f.providers.createPlatform.mockRejectedValueOnce(new ImageFailure('insufficient-points'))
  f.queue.wake()
  await expect.poll(async () => (await f.store.read()).jobs[0]?.status).toBe('failed')
  expect(f.providers.createPlatform).toHaveBeenCalledOnce()
})

it('重复收到同一账号不匹配事件时不刷新任务的真实更新时间', async () => {
  const f = await setup()
  const pending = job(true)
  pending.status = 'uncertain'; pending.error = { code: 'account-changed' }
  await f.store.transaction((state) => { state.jobs.push(pending) })
  f.providers.accountId.mockResolvedValue('different-account')
  const completed = Promise.withResolvers<undefined>()
  const transaction = f.store.transaction.bind(f.store)
  vi.spyOn(f.store, 'transaction').mockImplementation(async (mutate) => {
    const result = await transaction(mutate); completed.resolve(undefined); return result
  })
  f.queue.wake()
  await completed.promise
  await f.queue.close()
  expect((await f.store.read()).jobs[0]?.updatedAt).toBe(pending.updatedAt)
  expect(f.providers.createPlatform).not.toHaveBeenCalled()
})

it('轮询器异常不能伪装成主动关闭，持久队列停止受理并保留原任务', async () => {
  const f = await setup()
  await f.store.transaction((state) => { state.jobs.push(job(true)) })
  vi.mocked(timers.setTimeout).mockRejectedValueOnce(new Error('timer failure'))
  f.queue.wake()
  await expect.poll(() => {
    try { f.queue.assertHealthy(); return false } catch { return true }
  }).toBe(true)
  expect(() => { f.queue.assertHealthy() }).toThrow('storage')
  expect((await f.store.read()).jobs[0]?.remoteId).toBe('remote-one')
  expect(f.providers.createPlatform).toHaveBeenCalledOnce()
})

it('关闭正在等待轮询的队列时等待计时器结束，不产生新平台请求', async () => {
  const f = await setup()
  await f.store.transaction((state) => { state.jobs.push(job(true)) })
  const entered = Promise.withResolvers<undefined>()
  const released = Promise.withResolvers<undefined>()
  vi.mocked(timers.setTimeout).mockImplementationOnce(async () => {
    entered.resolve(undefined); await released.promise; throw new Error('timer aborted')
  })
  f.queue.wake()
  await entered.promise
  const closing = f.queue.close()
  released.resolve(undefined)
  await closing
  expect(f.providers.platformStatus).not.toHaveBeenCalled()
  expect(f.providers.createPlatform).toHaveBeenCalledOnce()
})
