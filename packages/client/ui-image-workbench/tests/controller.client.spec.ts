// @vitest-environment jsdom
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-client-ui-image-workbench/remote'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type {
  ImageAsset, ImageAssetId, ImageCatalog, ImageErrorCode, ImageJob, ImageJobId, ImageJobPage, ImageReadResult,
} from '../src/types.ts'
import { ImageWorkbenchController, imageDataUrl, type ImageWorkbenchRemote } from '../src/client/controller.ts'
import type { DraftSubmission } from '../src/client/draft.ts'

const input: DraftSubmission = { count: 1, request: { model: { source: 'custom', provider: 'studio', id: 'image-model' },
  prompt: '蓝色书店', size: '1024x1024', quality: 'auto', background: 'auto', format: 'png', referenceImageIds: [] } }
const catalog: ImageCatalog = { models: [], platform: 'signed-out', limits: {
  maxImageBytes: 1024, maxPromptLength: 1000, maxBatch: 4, pollIntervalMs: 1000,
} }
const asset: ImageAsset = { id: 'image-1' as ImageAssetId, mimeType: 'image/png', width: 1, height: 1, bytes: 3 }
const pixels: ImageReadResult = { mimeType: 'image/png', dataBase64: 'YWJj' }

function ok<T>(value: T): RemoteResult<T> { return { ok: true, value } }
function failed<T>(reason: ImageErrorCode): RemoteResult<T> {
  return { ok: false, error: new RemoteError('image-workbench/rejected', '失败', { reason }) }
}
function job(index: number, patch: Partial<ImageJob> = {}): ImageJob {
  return { id: `job-${index}` as ImageJobId, createdAt: index, updatedAt: index, status: 'succeeded',
    request: input.request, favorite: false, archived: false, images: [asset], ...patch }
}

function fixture() {
  const remote = {
    catalog: vi.fn<ImageWorkbenchRemote['catalog']>(async () => ok(catalog)),
    listJobs: vi.fn<ImageWorkbenchRemote['listJobs']>(async () => ok({ jobs: [] })),
    listWorkspaces: vi.fn<ImageWorkbenchRemote['listWorkspaces']>(async () => ok([])),
    submit: vi.fn<ImageWorkbenchRemote['submit']>(async () => ok([job(1, { status: 'queued' })])),
    importImage: vi.fn<ImageWorkbenchRemote['importImage']>(async () => ok(asset)),
    describeImage: vi.fn<ImageWorkbenchRemote['describeImage']>(async () => ok(asset)),
    readImage: vi.fn<ImageWorkbenchRemote['readImage']>(async () => ok(pixels)),
    favorite: vi.fn<ImageWorkbenchRemote['favorite']>(async (_id, value) => ok(job(1, { favorite: value }))),
    archive: vi.fn<ImageWorkbenchRemote['archive']>(async (_id, value) => ok(job(1, { archived: value }))),
    cancel: vi.fn<ImageWorkbenchRemote['cancel']>(async () => ok(job(1, { status: 'cancelled' }))),
    exportImage: vi.fn<ImageWorkbenchRemote['exportImage']>(async () => ok({ path: '/workspace/image.png' })),
  }
  const controller = new ImageWorkbenchController(remote)
  const releases: (() => void)[] = []
  onTestFinished(async () => {
    for (const release of releases) release()
    await controller.dispose()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })
  function deferred<T>(fallback: T) {
    const gate = Promise.withResolvers<RemoteResult<T>>()
    releases.push(() => { gate.resolve(ok(fallback)) })
    return gate
  }
  return { controller, remote, deferred, state: () => controller.store.getSnapshot() }
}

describe('图片工作台查询与生命周期', () => {
  it('共享并发刷新，失败保留目录和作品，成功重试清除错误', async () => {
    const { controller, remote, deferred, state } = fixture()
    const gate = deferred<ImageJobPage>({ jobs: [job(1)] })
    remote.listJobs.mockReturnValueOnce(gate.promise)
    const first = controller.refresh()
    expect(controller.refresh()).toBe(first)
    expect(state().loading).toBe(true)
    gate.resolve(ok({ jobs: [job(1)] }))
    await first
    expect(remote.catalog).toHaveBeenCalledTimes(1)
    remote.listJobs.mockResolvedValueOnce(failed('storage'))
    await controller.refresh()
    expect(state()).toMatchObject({ jobs: [job(1)], catalog, loading: false, error: 'error.storage' })
    remote.catalog.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', '断开', {}) })
    await controller.refresh()
    expect(state().error).toBe('error.connection')
    remote.listWorkspaces.mockResolvedValueOnce(failed('not-found'))
    await controller.refresh()
    expect(state().error).toBe('error.not-found')
    await controller.refresh()
    expect(state().error).toBeUndefined()
  })

  it('筛选切换淘汰旧响应，不把旧页错误或作品发布到新范围', async () => {
    const { controller, remote, deferred, state } = fixture()
    const gate = deferred<ImageJobPage>({ jobs: [job(1)] })
    remote.listJobs.mockReturnValueOnce(gate.promise).mockResolvedValueOnce(ok({ jobs: [job(2, { favorite: true })] }))
    const first = controller.refresh()
    controller.setFilter('favorites')
    gate.resolve(failed('storage'))
    await first
    await controller.refresh()
    expect(state()).toMatchObject({ filter: 'favorites', jobs: [job(2, { favorite: true })], error: undefined })
    expect(remote.listJobs).toHaveBeenLastCalledWith(expect.objectContaining({ favoritesOnly: true, archived: false }))
  })

  it.each(['success', 'failure'] as const)('追加期间换筛选不会留下旧结果：%s', async (outcome) => {
    const { controller, remote, deferred, state } = fixture()
    remote.listJobs.mockResolvedValueOnce(ok({ jobs: Array.from({ length: 24 }, (_value, index) => job(index + 1)),
      nextCursor: job(24).id }))
    controller.activate(true)
    await controller.refresh()
    const gate = deferred<ImageJobPage>({ jobs: [job(2)] })
    remote.listJobs.mockReturnValueOnce(gate.promise).mockResolvedValueOnce(ok({ jobs: [job(3, { archived: true })] }))
    const more = controller.loadMore()
    expect(controller.loadMore()).toBe(more)
    controller.setFilter('archived')
    if (outcome === 'success') gate.resolve(ok({ jobs: [job(2)] }))
    else gate.reject(new Error('旧分页连接中断'))
    await more
    await controller.refresh()
    expect(state()).toMatchObject({ filter: 'archived', jobs: [job(3, { archived: true })], loading: false })
  })

  it('加载超过一百条后用固定页长刷新原范围，重叠项不会重复出现', async () => {
    const { controller, remote, state } = fixture()
    const jobs = Array.from({ length: 130 }, (_unused, index) => job(index + 1))
    remote.listJobs.mockImplementation(async (query) => {
      // 重叠的页边界仍只显示一张作品，并以服务端游标继续读取。
      const start = query.cursor === undefined ? 0 : jobs.findIndex(item => item.id === query.cursor)
      const page = jobs.slice(start, start + query.limit)
      const last = page.at(-1)
      return ok({ jobs: page, ...last !== undefined && start + page.length < jobs.length ? { nextCursor: last.id } : {} })
    })
    await controller.refresh()
    for (let page = 0; page < 5; page++) await controller.loadMore()
    expect(state().jobs).toHaveLength(130)
    remote.listJobs.mockClear()
    await controller.refresh()
    expect(remote.listJobs.mock.calls).toHaveLength(6)
    expect(remote.listJobs.mock.calls.every(([query]) => query.limit === 24)).toBe(true)
    expect(state().jobs).toHaveLength(130)
    await controller.loadMore()
    expect(remote.listJobs.mock.calls).toHaveLength(6)
  })

  it('可见且有进行中任务才轮询，离页与卸载后不再启动查询', async () => {
    vi.useFakeTimers()
    const { controller, remote, state } = fixture()
    remote.listJobs.mockResolvedValue(ok({ jobs: [job(1, { status: 'running' })] }))
    controller.activate(true)
    await controller.refresh()
    await vi.advanceTimersByTimeAsync(catalog.limits.pollIntervalMs)
    expect(remote.listJobs).toHaveBeenCalledTimes(2)
    controller.activate(false)
    await vi.advanceTimersByTimeAsync(catalog.limits.pollIntervalMs * 3)
    expect(remote.listJobs).toHaveBeenCalledTimes(2)
    await controller.dispose()
    const snapshot = state()
    controller.activate(true)
    controller.setFilter('favorites')
    controller.notify('saved')
    await controller.refresh()
    expect(state()).toBe(snapshot)
    expect(remote.listJobs).toHaveBeenCalledTimes(2)
  })

  it('平台待确认任务持续查询直至恢复成功，自定义待确认任务不自动重试', async () => {
    vi.useFakeTimers()
    const { controller, remote, state } = fixture()
    const request = { ...input.request, model: { source: 'platform' as const, id: 'image-model' } }
    const uncertain = job(1, { request, status: 'uncertain' })
    const completed = job(1, { request, status: 'succeeded' })
    remote.listJobs.mockResolvedValueOnce(ok({ jobs: [uncertain] }))
      .mockResolvedValueOnce(ok({ jobs: [uncertain] })).mockResolvedValueOnce(ok({ jobs: [completed] }))
    controller.activate(true)
    await controller.refresh()
    await vi.advanceTimersByTimeAsync(catalog.limits.pollIntervalMs)
    expect(remote.listJobs).toHaveBeenCalledTimes(2)
    expect(state().jobs).toEqual([uncertain])
    await vi.advanceTimersByTimeAsync(catalog.limits.pollIntervalMs)
    expect(state().jobs).toEqual([completed])
    await vi.advanceTimersByTimeAsync(catalog.limits.pollIntervalMs * 3)
    expect(remote.listJobs).toHaveBeenCalledTimes(3)
    remote.listJobs.mockResolvedValueOnce(ok({ jobs: [job(2, { status: 'uncertain' })] }))
    await controller.refresh()
    await vi.advanceTimersByTimeAsync(catalog.limits.pollIntervalMs * 3)
    expect(remote.listJobs).toHaveBeenCalledTimes(4)
    remote.listJobs.mockResolvedValueOnce(ok({ jobs: [uncertain] }))
    await controller.refresh()
    controller.activate(false)
    await vi.advanceTimersByTimeAsync(catalog.limits.pollIntervalMs * 3)
    expect(remote.listJobs).toHaveBeenCalledTimes(5)
  })

  it('同步抛出的Remote错误不会锁死刷新和分页重试', async () => {
    const { controller, remote, state } = fixture()
    remote.catalog.mockImplementationOnce(() => { throw new Error('同步断连') })
    await controller.refresh()
    const firstPage = Array.from({ length: 24 }, (_value, index) => job(index + 1))
    remote.listJobs.mockResolvedValueOnce(ok({ jobs: firstPage, nextCursor: job(24).id }))
    await controller.refresh()
    expect(state().jobs).toEqual(firstPage)
    remote.listJobs.mockImplementationOnce(() => { throw new Error('分页同步断连') })
    await controller.loadMore()
    remote.listJobs.mockResolvedValueOnce(ok({ jobs: [job(25)] }))
    await controller.loadMore()
    expect(state().jobs).toEqual([...firstPage, job(25)])
  })

  it.each(['success', 'failure'] as const)('卸载等待已发出的读取但不发布迟到结果：%s', async (outcome) => {
    const { controller, remote, deferred, state } = fixture()
    const history = deferred<ImageJobPage>({ jobs: [job(1)] })
    const thumbnail = deferred(pixels)
    remote.listJobs.mockReturnValueOnce(history.promise)
    remote.readImage.mockReturnValueOnce(thumbnail.promise)
    const loading = controller.refresh()
    const image = controller.ensureThumbnail(asset.id)
    await Promise.resolve()
    expect(remote.listJobs).toHaveBeenCalledOnce()
    expect(remote.readImage).toHaveBeenCalledOnce()
    const snapshot = state()
    let settled = false
    const disposal = controller.dispose().then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    if (outcome === 'success') {
      history.resolve(ok({ jobs: [job(1)] }))
      thumbnail.resolve(ok(pixels))
    } else {
      history.reject(new Error('卸载后的历史失败'))
      thumbnail.reject(new Error('卸载后的图片失败'))
    }
    await Promise.all([loading, image, disposal])
    expect(state()).toBe(snapshot)
  })

  it('刷新已加载多页时遇到后页失败保留原范围，离页后停止读取后续页', async () => {
    const { controller, remote, deferred, state } = fixture()
    const jobs = Array.from({ length: 48 }, (_value, index) => job(index + 1))
    remote.listJobs.mockImplementation(async query => query.cursor === undefined
      ? ok({ jobs: jobs.slice(0, 24), nextCursor: job(24).id }) : ok({ jobs: jobs.slice(24) }))
    controller.activate(true)
    await controller.refresh()
    await controller.loadMore()
    remote.listJobs.mockResolvedValueOnce(ok({ jobs: [job(100)], nextCursor: job(100).id })).mockResolvedValueOnce(failed('storage'))
    await controller.refresh()
    expect(state().jobs).toEqual(jobs)
    expect(state().error).toBe('error.storage')
    const firstPage = deferred<ImageJobPage>({ jobs: jobs.slice(0, 24), nextCursor: job(24).id })
    remote.listJobs.mockClear().mockReturnValueOnce(firstPage.promise)
    const refreshing = controller.refresh()
    await Promise.resolve()
    controller.activate(false)
    firstPage.resolve(ok({ jobs: jobs.slice(0, 24), nextCursor: job(24).id }))
    await refreshing
    expect(remote.listJobs).toHaveBeenCalledOnce()
    expect(state().jobs).toEqual(jobs)
  })

  it('目录缺失时不猜测轮询周期，分页失败可重试且不重复已有作品', async () => {
    vi.useFakeTimers()
    const { controller, remote, state } = fixture()
    remote.catalog.mockResolvedValueOnce(failed('model-unavailable'))
    remote.listJobs.mockResolvedValueOnce(ok({ jobs: [job(1, { status: 'queued' })] }))
    controller.activate(true)
    await controller.refresh()
    expect(vi.getTimerCount()).toBe(0)
    const initial = Array.from({ length: 24 }, (_value, index) => job(index + 1))
    remote.listJobs.mockResolvedValueOnce(ok({ jobs: initial, nextCursor: job(24).id }))
    await controller.refresh()
    remote.listJobs.mockResolvedValueOnce(failed('storage'))
    await controller.loadMore()
    expect(state()).toMatchObject({ jobs: initial, error: 'error.storage' })
    remote.listJobs.mockResolvedValueOnce(ok({ jobs: [job(24), job(25)] }))
    await controller.loadMore()
    expect(state().jobs).toEqual([...initial, job(25)])
    expect(state().error).toBeUndefined()
  })

  it('卸载后所有动作停止发送请求，已发出的操作不能发布成功结果', async () => {
    const { controller, remote, deferred, state } = fixture()
    const gate = deferred(asset)
    remote.importImage.mockReturnValueOnce(gate.promise)
    const importing = controller.importImage(pixels)
    const snapshot = state()
    const disposal = controller.dispose()
    expect(await controller.submit(input)).toBe(false)
    expect(await controller.describeImage(asset.id)).toBeUndefined()
    expect(await controller.readOriginal(asset.id)).toBeUndefined()
    await controller.ensureThumbnail(asset.id)
    await controller.loadMore()
    controller.setSearch('不会查询')
    controller.dismissNotice(1)
    gate.resolve(ok(asset))
    expect(await importing).toBeUndefined()
    await disposal
    expect(remote.submit).not.toHaveBeenCalled()
    expect(remote.describeImage).not.toHaveBeenCalled()
    expect(remote.readImage).not.toHaveBeenCalled()
    expect(state()).toBe(snapshot)
  })

  it('RPC启动前卸载会撤回待开始的刷新、分页和缩略图读取', async () => {
    const first = fixture()
    const refresh = first.controller.refresh()
    const image = first.controller.ensureThumbnail(asset.id)
    await first.controller.dispose()
    await Promise.all([refresh, image])
    expect(first.remote.catalog).not.toHaveBeenCalled()
    expect(first.remote.readImage).not.toHaveBeenCalled()
    const second = fixture()
    second.remote.listJobs.mockResolvedValueOnce(ok({ jobs: Array.from({ length: 24 }, (_value, index) => job(index + 1)),
      nextCursor: job(24).id }))
    await second.controller.refresh()
    const more = second.controller.loadMore()
    await second.controller.dispose()
    await more
    expect(second.remote.listJobs).toHaveBeenCalledOnce()
  })
})

describe('图片提交、操作与按需读取', () => {
  it('双击只提交一次，响应丢失后同请求复用提交身份，成功后的新创作使用新身份', async () => {
    const { controller, remote, deferred, state } = fixture()
    const gate = deferred<ImageJob[]>([job(1)])
    remote.submit.mockReturnValueOnce(gate.promise)
    const first = controller.submit(input)
    expect(controller.submit(structuredClone(input))).toBe(first)
    gate.reject(new Error('响应丢失'))
    expect(await first).toBe(false)
    expect(state().notice?.key).toBe('error.connection')
    expect(await controller.submit(structuredClone(input))).toBe(true)
    const firstId = remote.submit.mock.calls[0]?.[0].submissionId
    expect(remote.submit.mock.calls[1]?.[0].submissionId).toBe(firstId)
    expect(await controller.submit(input)).toBe(true)
    expect(remote.submit.mock.calls[2]?.[0].submissionId).not.toBe(firstId)
    expect(state().notice?.key).toBe('submitted')
  })

  it('已受理任务不因随后历史读取失败而被误报提交失败，改动草稿也不复用失败请求身份', async () => {
    const { controller, remote, state } = fixture()
    controller.activate(true)
    await controller.refresh()
    remote.submit.mockResolvedValueOnce(failed('insufficient-points'))
    expect(await controller.submit(input)).toBe(false)
    expect(state().notice?.key).toBe('error.insufficient-points')
    const firstId = remote.submit.mock.calls[0]?.[0].submissionId
    remote.listJobs.mockRejectedValueOnce(new Error('历史暂不可读'))
    expect(await controller.submit({ ...input, request: { ...input.request, prompt: '另一幅画' } })).toBe(true)
    expect(remote.submit.mock.calls[1]?.[0].submissionId).not.toBe(firstId)
    expect(state()).toMatchObject({ error: 'error.connection', notice: { key: 'submitted' } })
  })

  it('并发操作的busy直到最后一个请求结束，错误通知不会被旧关闭事件清除', async () => {
    const { controller, remote, deferred, state } = fixture()
    const importing = deferred(asset)
    const reading = deferred(pixels)
    remote.importImage.mockReturnValueOnce(importing.promise)
    remote.readImage.mockReturnValueOnce(reading.promise)
    const first = controller.importImage(pixels)
    const second = controller.readOriginal(asset.id)
    expect(state().busy).toBe(true)
    importing.resolve(ok(asset))
    expect(await first).toEqual(asset)
    expect(state().busy).toBe(true)
    reading.resolve(failed('not-found'))
    expect(await second).toBeUndefined()
    expect(state().busy).toBe(false)
    const old = state().notice?.seq ?? 0
    controller.notify('saved')
    controller.dismissNotice(old)
    expect(state().notice?.key).toBe('saved')
    controller.dismissNotice(state().notice?.seq ?? 0)
    expect(state().notice).toBeUndefined()
    expect(await controller.describeImage(asset.id)).toEqual(asset)
  })

  it('缩略图合并并发读取，失败后只在显式重试时重读，同步抛错也能恢复', async () => {
    const { controller, remote, deferred, state } = fixture()
    const gate = deferred(pixels)
    remote.readImage.mockReturnValueOnce(gate.promise)
    const first = controller.ensureThumbnail(asset.id)
    expect(controller.ensureThumbnail(asset.id)).toBe(first)
    gate.resolve(failed('storage'))
    await first
    await controller.ensureThumbnail(asset.id)
    expect(remote.readImage).toHaveBeenCalledTimes(1)
    remote.readImage.mockImplementationOnce(() => { throw new Error('同步读取失败') })
    await controller.ensureThumbnail(asset.id, true)
    await controller.ensureThumbnail(asset.id, true)
    expect(remote.readImage).toHaveBeenCalledTimes(3)
    expect(state().thumbnails[asset.id]).toEqual({ status: 'ready', url: imageDataUrl(pixels) })
    expect(state().busy).toBe(false)
  })

  it('收藏、归档与取消只在成功后刷新，导出成功与拒绝给出各自通知', async () => {
    const { controller, remote, state } = fixture()
    controller.activate(true)
    await controller.refresh()
    remote.catalog.mockClear()
    remote.favorite.mockResolvedValueOnce(failed('conflict'))
    await controller.favorite(job(1))
    expect(remote.catalog).not.toHaveBeenCalled()
    await controller.favorite(job(1, { favorite: true }))
    expect(remote.favorite).toHaveBeenLastCalledWith(job(1).id, false)
    await controller.archive(job(1))
    expect(state().notice?.key).toBe('updated')
    await controller.cancel(job(1).id)
    expect(remote.cancel).toHaveBeenCalledExactlyOnceWith(job(1).id)
    const destination = { workspaceId: 'workspace' as WorkspaceId, fileName: 'image.png' }
    expect(await controller.exportImage(asset.id, destination)).toBe(true)
    expect(remote.exportImage).toHaveBeenCalledWith(asset.id, destination)
    expect(state().notice?.key).toBe('saved')
    remote.exportImage.mockResolvedValueOnce(failed('unsafe-url'))
    expect(await controller.exportImage(asset.id, destination)).toBe(false)
    expect(state().notice?.key).toBe('error.unsafe-url')
  })

  it('离页期间提交成功仍通知受理，但不启动隐藏页面的刷新；非安全上下文也能产生提交身份', async () => {
    const originalCrypto = globalThis.crypto
    vi.stubGlobal('crypto', { getRandomValues: originalCrypto.getRandomValues.bind(originalCrypto) })
    const { controller, remote, deferred, state } = fixture()
    controller.activate(true)
    await controller.refresh()
    const gate = deferred<ImageJob[]>([job(1)])
    remote.submit.mockReturnValueOnce(gate.promise)
    const submitting = controller.submit(input)
    controller.activate(false)
    gate.resolve(ok([job(1)]))
    expect(await submitting).toBe(true)
    expect(remote.catalog).toHaveBeenCalledTimes(1)
    expect(state().notice?.key).toBe('submitted')
    expect(remote.submit.mock.calls[0]?.[0].submissionId).toMatch(/^[0-9a-f-]{36}$/)
    controller.activate(true)
    await controller.refresh()
    const archiving = deferred(job(1, { archived: true }))
    remote.archive.mockReturnValueOnce(archiving.promise)
    const archived = controller.archive(job(1))
    controller.activate(false)
    archiving.resolve(ok(job(1, { archived: true })))
    await archived
    expect(remote.catalog).toHaveBeenCalledTimes(2)
    expect(state().notice?.key).toBe('updated')
    remote.archive.mockRejectedValueOnce(new Error('归档断连'))
    await controller.archive(job(1))
    expect(state().notice?.key).toBe('error.connection')
    remote.cancel.mockResolvedValueOnce(failed('cancel-unavailable'))
    await controller.cancel(job(1).id)
    expect(state().notice?.key).toBe('error.cancel-unavailable')
  })
})

describe('工作台搜索', () => {
  it('300ms合并输入并传递全历史搜索与进行中筛选，离页清除未启动的搜索', async () => {
    vi.useFakeTimers()
    const { controller, remote, state } = fixture()
    controller.activate(true)
    await controller.refresh()
    controller.setSearch('蓝')
    await vi.advanceTimersByTimeAsync(299)
    expect(remote.listJobs).toHaveBeenCalledTimes(1)
    controller.setSearch('蓝色')
    await vi.advanceTimersByTimeAsync(300)
    expect(state().search).toBe('蓝色')
    expect(remote.listJobs).toHaveBeenLastCalledWith(expect.objectContaining({ search: '蓝色' }))
    controller.setFilter('active')
    await controller.refresh()
    expect(remote.listJobs).toHaveBeenLastCalledWith(expect.objectContaining({ search: '蓝色', activeOnly: true }))
    controller.setSearch('新查询')
    controller.activate(false)
    const calls = remote.listJobs.mock.calls.length
    await vi.advanceTimersByTimeAsync(1000)
    expect(remote.listJobs).toHaveBeenCalledTimes(calls)
    controller.activate(true)
    await controller.refresh()
    expect(remote.listJobs).toHaveBeenLastCalledWith(expect.objectContaining({ search: '新查询' }))
  })

  it('输入期间的旧刷新结果被淘汰，最新查询只在防抖结束后发出', async () => {
    vi.useFakeTimers()
    const { controller, remote, deferred, state } = fixture()
    const old = deferred<ImageJobPage>({ jobs: [job(1)] })
    remote.listJobs.mockReturnValueOnce(old.promise).mockResolvedValueOnce(ok({ jobs: [job(2)] }))
    controller.activate(true)
    const first = controller.refresh()
    await Promise.resolve()
    controller.setSearch('新主题')
    controller.setSearch('新主题')
    old.resolve(ok({ jobs: [job(1)] }))
    await first
    expect(state().jobs).toEqual([])
    expect(state().loading).toBe(true)
    expect(remote.listJobs).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(300)
    expect(state().jobs).toEqual([job(2)])
    expect(remote.listJobs).toHaveBeenLastCalledWith(expect.objectContaining({ search: '新主题' }))
    controller.setFilter('all')
    expect(remote.listJobs).toHaveBeenCalledTimes(2)
  })

  it('切换筛选后的旧连接异常不显示到新页面，离页迟到输入不触发查询', async () => {
    const { controller, remote, deferred, state } = fixture()
    const gate = deferred<ImageJobPage>({ jobs: [job(1)] })
    remote.listJobs.mockReturnValueOnce(gate.promise).mockResolvedValueOnce(ok({ jobs: [job(2, { favorite: true })] }))
    controller.activate(true)
    const first = controller.refresh()
    await Promise.resolve()
    controller.setFilter('favorites')
    gate.reject(new Error('旧筛选响应丢失'))
    await first
    await controller.refresh()
    expect(state()).toMatchObject({ filter: 'favorites', jobs: [job(2, { favorite: true })], error: undefined })
    controller.activate(false)
    const before = remote.listJobs.mock.calls.length
    controller.setSearch('尚未再次打开')
    expect(state().search).toBe('尚未再次打开')
    expect(remote.listJobs).toHaveBeenCalledTimes(before)
  })
})
