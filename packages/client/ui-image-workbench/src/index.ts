/** 图片工作台 Remote 服务：任务、原图和工作区导出均在主机侧完成。 */
import { createHash, randomUUID } from 'node:crypto'
import { link, realpath, unlink, writeFile } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-api-remote-access'
import type {} from '@deepseek-ai/dsh-workspace'
import { z } from 'zod'
import { Config, type WorkbenchConfig } from './host/config.ts'
import { ImageFailure, imageFailureCode } from './host/errors.ts'
import { ImageProviders, imageBytes } from './host/providers.ts'
import { ImageQueue } from './host/queue.ts'
import { generationSchema, type ImageJournal, type StoredImageJob } from './host/schemas.ts'
import { ImageStore } from './host/store.ts'
import type { ImageAsset, ImageAssetId, ImageCatalog, ImageExportDestination, ImageExportResult, ImageImportRequest,
  ImageJob, ImageJobId, ImageJobPage, ImageJobQuery, ImageReadResult, ImageSubmitRequest, ImageWorkbenchId, ImageWorkspace } from './types.ts'

export { Config } from './host/config.ts'
export type * from './types.ts'

const LOCAL_WORKBENCH = brandString<ImageWorkbenchId>('local')
const imageResources = { imageWorkbench: () => LOCAL_WORKBENCH }

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 本机图片工作台与持久后台任务。 */
    imageWorkbench: ImageWorkbench
  }
}

/** 将主机恢复字段留在持久层，只投影前端使用的任务事实。 */
function jobView(job: StoredImageJob): ImageJob {
  return { id: job.id, createdAt: job.createdAt, updatedAt: job.updatedAt, status: job.status, request: job.request,
    favorite: job.favorite, archived: job.archived, images: job.images,
    ...job.error === undefined ? {} : { error: job.error }, ...job.chargedUnits === undefined ? {} : { chargedUnits: job.chargedUnits } }
}

function findJob(journal: ImageJournal, id: ImageJobId): StoredImageJob {
  const job = journal.jobs.find(value => value.id === id)
  if (job === undefined) throw new ImageFailure('not-found')
  return job
}

/** 生命周期独立于图片页面的业务服务。 */
export default class ImageWorkbench extends TypertRemoteService {
  static inject = ['settings', 'credentials', 'remoteAccess', 'workspaceRegistry', 'typert']
  static Config = Config
  private readonly config: WorkbenchConfig
  private readonly store: ImageStore
  private readonly providers: ImageProviders
  private readonly queue: ImageQueue
  private readonly lifetime = new AbortController()
  private readonly operations = new Set<Promise<unknown>>()

  /** @param ctx - 主机设置、凭据、工作区和 Remote 权限服务。 @param config - 持久化与资源限制。 */
  constructor(ctx: Context, config: Partial<WorkbenchConfig> = {}) {
    super(ctx, 'imageWorkbench')
    this.config = Config(config)
    if (this.config.maxInputImageBytes > this.config.maxImageBytes) throw new Error('图片输入上限不能超过原图存储上限')
    const directory = resolve(this.config.directory ?? join(resolveDshHome(), 'image-workbench'))
    this.store = new ImageStore({ ...this.config, directory })
    this.providers = new ImageProviders(ctx, this.config, this.store)
    this.queue = new ImageQueue(this.store, this.providers, this.config)
    ctx.typert.resources.register('imageWorkbench', { field: 'imageWorkbenchId' })
    ctx.on('credentials/reference-updated', () => { this.queue.wake() })
    ctx.on('credentials/record-updated', () => { this.queue.wake() })
    ctx.effect(() => async () => {
      this.lifetime.abort()
      await this.queue.close()
      await Promise.allSettled(this.operations)
    }, 'image-workbench: 后台请求和文件写入')
  }
  async [Service.init](): Promise<void> {
    await this.store.initialize()
    if (!this.lifetime.signal.aborted) this.queue.wake()
  }

  /**
   * 汇总已授权的平台与自定义图片模型，不返回凭据。
   * @returns 同一选择器中的平台与自定义图片模型。
   */
  @Remote({ resources: imageResources })
  async catalog(): Promise<ImageCatalog> {
    return this.perform(async () => {
      this.queue.assertHealthy()
      return this.providers.catalog(this.lifetime.signal)
    })
  }
  /**
   * 在完整历史上筛选后分页，并按当前调用者权限返回。
   * @param query - 分页、搜索、活动状态、收藏与归档筛选。
   * @returns 不包含原图正文或恢复凭据的一页历史。
   */
  @Remote({ resources: imageResources })
  async listJobs(query: ImageJobQuery): Promise<ImageJobPage> {
    return this.perform(async () => {
      if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > this.config.maxHistoryPageSize) throw new ImageFailure('invalid-input')
      if (query.search !== undefined && query.search.length > this.config.maxPromptLength) throw new ImageFailure('invalid-input')
      this.queue.assertHealthy()
      const search = query.search?.trim().toLowerCase() ?? ''
      const all = (await this.store.read()).jobs
        .filter(job => this.ctx.remoteAccess.allows({ kind: 'imageWorkbench', id: LOCAL_WORKBENCH })
          && job.archived === (query.archived ?? false) && (!query.favoritesOnly || job.favorite)
          && (!query.activeOnly || ['queued', 'running', 'uncertain'].includes(job.status))
          && (search === '' || job.request.prompt.toLowerCase().includes(search) || job.request.model.id.toLowerCase().includes(search)))
        .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
      const start = query.cursor === undefined ? 0 : all.findIndex(job => job.id === query.cursor) + 1
      if (query.cursor !== undefined && start === 0) throw new ImageFailure('not-found')
      const selected = all.slice(start)
      const jobs = selected.slice(0, query.limit).map(jobView)
      this.queue.wake()
      const last = jobs.at(-1)
      return { jobs, ...selected.length > jobs.length && last !== undefined ? { nextCursor: last.id } : {} }
    })
  }
  /**
   * 校验生成能力并原子受理整批任务，重复提交复用已持久记录。
   * @param input - 用户稳定提交身份、生成参数与批量数。
   * @returns 同一次提交对应的持久任务，重放不会创建新任务。
   */
  @Remote({ resources: imageResources })
  async submit(input: ImageSubmitRequest): Promise<ImageJob[]> {
    return this.perform(async () => {
      this.queue.assertHealthy()
      const submission = z.uuid().safeParse(input.submissionId)
      const parsed = generationSchema.safeParse(input.request)
      if (!submission.success || !parsed.success || !Number.isSafeInteger(input.count)
        || input.count < 1 || input.count > this.config.maxBatch) {
        throw new ImageFailure('invalid-input')
      }
      const request = parsed.data
      if (request.prompt.trim() === '' || request.prompt.length > this.config.maxPromptLength) throw new ImageFailure('invalid-input')
      const hash = createHash('sha256').update(JSON.stringify({ request, count: input.count })).digest('hex')
      const previous = this.previousSubmission(await this.store.read(), submission.data, hash)
      if (previous !== undefined) return previous
      const catalog = await this.providers.catalog(this.lifetime.signal)
      const model = catalog.models.find(value => JSON.stringify(value.ref) === JSON.stringify(request.model))
      if (model === undefined) throw new ImageFailure(request.model.source === 'platform' && catalog.platform === 'signed-out' ? 'account-required' : 'model-unavailable')
      if (!model.available) throw new ImageFailure(model.unavailableReason ?? 'model-unavailable')
      if (!model.sizes.includes(request.size) || !model.qualities.includes(request.quality)
        || !model.backgrounds.includes(request.background)
        || !model.formats.includes(request.format) || request.background === 'transparent' && request.format === 'jpeg'
        || request.referenceImageIds.length > model.maxReferenceImages || request.referenceImageIds.length > 0 && !model.supportsEdit
        || new Set(request.referenceImageIds).size !== request.referenceImageIds.length
        || request.maskImageId !== undefined && (!model.supportsMask || request.referenceImageIds.length === 0)) {
        throw new ImageFailure('invalid-input')
      }
      const accountId = request.model.source === 'platform' ? await this.providers.accountId() : undefined
      if (request.model.source === 'platform' && accountId === undefined) throw new ImageFailure('account-required')
      const jobs = await this.store.transaction((journal) => {
        const repeated = this.previousSubmission(journal, submission.data, hash)
        if (repeated !== undefined) return repeated
        const references = request.referenceImageIds.map((id) => {
          const image = journal.assets.find(asset => asset.id === id)
          if (image === undefined) throw new ImageFailure('not-found')
          if (image.bytes > this.config.maxInputImageBytes) throw new ImageFailure('too-large')
          return image
        })
        if (references.reduce((bytes, image) => bytes + image.bytes, 0) > this.config.maxReferenceBytes) throw new ImageFailure('too-large')
        if (request.maskImageId !== undefined) {
          const mask = journal.assets.find(asset => asset.id === request.maskImageId)
          const first = references[0]
          if (mask === undefined || first === undefined || mask.mimeType !== 'image/png' || mask.width !== first.width || mask.height !== first.height) {
            throw new ImageFailure('invalid-input')
          }
          if (mask.bytes > this.config.maxInputImageBytes
            || references.reduce((bytes, image) => bytes + image.bytes, mask.bytes) > this.config.maxReferenceBytes) throw new ImageFailure('too-large')
        }
        if (request.parentJobId !== undefined) findJob(journal, request.parentJobId)
        const batch: StoredImageJob[] = Array.from({ length: input.count }, () => ({ id: randomUUID() as ImageJobId,
          createdAt: Date.now(), updatedAt: Date.now(), status: 'queued', request: structuredClone(request),
          favorite: false, archived: false, images: [], ...accountId === undefined ? {} : { accountId } }))
        journal.jobs.push(...batch)
        journal.submissions.push({ id: submission.data, hash, jobIds: batch.map(job => job.id) })
        return batch.map(jobView)
      })
      this.queue.wake()
      return jobs
    })
  }
  /**
   * 验证上传图片的编码与大小并保存原图。
   * @param input - 原始编码和字节。
   * @returns 未经聊天图片压缩的持久资源。
   */
  @Remote({ resources: imageResources })
  async importImage(input: ImageImportRequest): Promise<ImageAsset> {
    return this.perform(async () => this.store.saveImage(imageBytes(input.dataBase64, this.config.maxInputImageBytes), input.mimeType))
  }
  /**
   * 查询已保存图片的生成输入元数据。
   * @param imageId - 已登记资源标识。
   * @returns 原图尺寸、编码与字节数。
   */
  @Remote({ resources: imageResources })
  async describeImage(imageId: ImageAssetId): Promise<ImageAsset> {
    return this.perform(async () => {
      const image = (await this.store.read()).assets.find(asset => asset.id === imageId)
      if (image === undefined) throw new ImageFailure('not-found')
      return image
    })
  }
  /**
   * 按需读取经完整性验证的图片字节。
   * @param imageId - 已登记资源标识。
   * @param variant - 原图或缩略图。
   * @returns 有界图片正文。
   */
  @Remote({ resources: imageResources })
  async readImage(imageId: ImageAssetId, variant: 'thumbnail' | 'original'): Promise<ImageReadResult> {
    return this.perform(async () => {
      const result = await this.store.readImage(imageId, variant)
      return { mimeType: result.mimeType, dataBase64: result.bytes.toString('base64') }
    })
  }
  /**
   * 过滤调用方没有访问权的工作区。
   * @returns 当前调用方可写入的工作区目录。
   */
  @Remote({ resources: imageResources })
  async listWorkspaces(): Promise<ImageWorkspace[]> {
    return this.perform(() => this.ctx.workspaceRegistry.list()
      .filter(workspace => this.ctx.remoteAccess.allows({ kind: 'workspace', id: workspace.id }))
      .map(workspace => ({ id: workspace.id, name: workspace.title })))
  }
  /**
   * 将完整原图写入有授权的工作区，拒绝路径穿越和覆盖。
   * @param imageId - 原图标识。
   * @param destination - 授权工作区内的新文件名。
   * @returns 成功写入的路径；已有文件不会被覆盖。
   */
  @Remote({ resources: { ...imageResources, workspace: (_imageId, destination) => destination.workspaceId } })
  async exportImage(imageId: ImageAssetId, destination: ImageExportDestination): Promise<ImageExportResult> {
    return this.perform(async () => {
      const workspace = this.ctx.workspaceRegistry.get(destination.workspaceId)
      if (workspace === undefined || !this.ctx.remoteAccess.allows({ kind: 'workspace', id: destination.workspaceId })) throw new ImageFailure('not-found')
      const name = destination.fileName
      if (name.length === 0 || name.length > 240 || /[\\/<>:"|?*\u0000-\u001f]/.test(name) || /[. ]$/.test(name)
        || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw new ImageFailure('invalid-input')
      const image = await this.store.readImage(imageId, 'original')
      const extensions = image.mimeType === 'image/jpeg' ? ['.jpg', '.jpeg'] : [`.${image.mimeType.split('/')[1]}`]
      if (!extensions.includes(extname(name).toLowerCase())) throw new ImageFailure('invalid-input')
      const directory = await realpath(workspace.path)
      const target = join(directory, name)
      const temporary = join(directory, `.freecode-image-${randomUUID()}.tmp`)
      await writeFile(temporary, image.bytes, { flag: 'wx', mode: 0o600 })
      try {
        // 同目录硬链接发布完整文件，同时以 EEXIST 拒绝覆盖现有内容。
        await link(temporary, target)
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'EEXIST') throw new ImageFailure('conflict')
        throw new ImageFailure('storage')
      } finally { await unlink(temporary) }
      return { path: target }
    })
  }
  /**
   * 持久更新作品的收藏状态。
   * @param jobId - 任务标识。
   * @param value - 收藏状态。
   * @returns 提交后的任务。
   */
  @Remote({ resources: imageResources })
  async favorite(jobId: ImageJobId, value: boolean): Promise<ImageJob> {
    return this.perform(async () => this.store.transaction((journal) => {
      const job = findJob(journal, jobId); job.favorite = value; job.updatedAt = Date.now(); return jobView(job)
    }))
  }
  /**
   * 持久更新归档状态，保留原图以便恢复。
   * @param jobId - 任务标识。
   * @param value - 是否归档。
   * @returns 归档状态，原图仍保留。
   */
  @Remote({ resources: imageResources })
  async archive(jobId: ImageJobId, value: boolean): Promise<ImageJob> {
    return this.perform(async () => this.store.transaction((journal) => {
      const job = findJob(journal, jobId); job.archived = value; job.updatedAt = Date.now(); return jobView(job)
    }))
  }
  /**
   * 仅在确认未派发或平台确认取消时终结任务。
   * @param jobId - 本机或平台排队任务。
   * @returns 取消后的任务；已经派发的自定义请求不伪装为已取消。
   */
  @Remote({ resources: imageResources })
  async cancel(jobId: ImageJobId): Promise<ImageJob> {
    return this.perform(async () => {
      const job = findJob(await this.store.read(), jobId)
      if (job.remoteId !== undefined && job.request.model.source === 'platform') {
        try {
          const remote = await this.providers.platformStatus(job, true, this.lifetime.signal)
          if (remote.state !== 'cancelled') throw new ImageFailure('cancel-unavailable')
        } catch (error) {
          if (error instanceof ImageFailure && error.code === 'conflict') throw new ImageFailure('cancel-unavailable')
          throw error
        }
      } else if (job.status !== 'queued' || job.owner !== undefined) throw new ImageFailure('cancel-unavailable')
      return this.store.transaction((journal) => {
        const current = findJob(journal, jobId)
        if (job.remoteId === undefined && (current.status !== 'queued' || current.owner !== undefined)) throw new ImageFailure('cancel-unavailable')
        current.status = 'cancelled'; current.updatedAt = Date.now(); delete current.error; delete current.owner
        return jobView(current)
      })
    })
  }
  private previousSubmission(journal: ImageJournal, id: string, hash: string): ImageJob[] | undefined {
    const previous = journal.submissions.find(value => value.id === id)
    if (previous === undefined) return undefined
    if (previous.hash !== hash) throw new ImageFailure('conflict')
    return previous.jobIds.map(jobId => jobView(findJob(journal, jobId)))
  }
  private perform<T>(operation: () => T | Promise<T>): Promise<T> {
    const promise = (async () => {
      try { this.lifetime.signal.throwIfAborted(); return await operation() }
      catch (error) { throw new RemoteError('image-workbench/rejected', '图片操作未完成', { reason: imageFailureCode(error) }) }
    })()
    this.operations.add(promise)
    void promise.finally(() => { this.operations.delete(promise) }).catch((_error: unknown) => { /* 失败由调用方读取。 */ })
    return promise
  }
}
