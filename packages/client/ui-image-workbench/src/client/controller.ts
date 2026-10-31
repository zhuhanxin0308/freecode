/** 工作台的客户端数据拥有者；页面离开后停止查询，Host 任务继续运行。 */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteResult, TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import type {
  ImageAsset, ImageAssetId, ImageCatalog, ImageExportDestination, ImageJob, ImageJobId, ImageJobPage,
  ImageJobQuery, ImageReadResult, ImageWorkspace, ImageImportRequest, ImageSubmissionId,
} from '../types.ts'
import type { DraftSubmission } from './draft.ts'
import type { ImageWorkbenchKey } from './locales.ts'

/** 从 Host Remote 生成的客户端方法类型。 */
export type ImageWorkbenchRemote = TypertClientRemote['imageWorkbench']
/** 图片历史筛选方式。 */
export type ImageFilter = 'all' | 'active' | 'favorites' | 'archived'
/** 一张图片的按需加载状态。 */
export type ImageThumbnail = { status: 'loading' } | { status: 'ready'; url: string } | { status: 'failed' }
/** 工作台对页面公开的安全数据。 */
export interface WorkbenchState {
  catalog: ImageCatalog | undefined
  jobs: ImageJob[]
  workspaces: ImageWorkspace[]
  nextCursor: ImageJobId | undefined
  filter: ImageFilter
  search: string
  loading: boolean
  busy: boolean
  error: ImageWorkbenchKey | undefined
  thumbnails: Record<string, ImageThumbnail>
  notice: { key: ImageWorkbenchKey; seq: number } | undefined
}

const HISTORY_PAGE_SIZE = 24
const SEARCH_DEBOUNCE_MS = 300

function errorKey(result: Extract<RemoteResult<never>, { ok: false }>): ImageWorkbenchKey {
  return result.error.code === 'image-workbench/rejected' ? `error.${result.error.details.reason}` : 'error.connection'
}

/**
 * 将已校验图片转换为可显示的数据地址。
 * @param image - 已由 Host 验证的图片内容。
 * @returns 可用于显示与下载的本机数据地址。
 */
export function imageDataUrl(image: ImageReadResult): string {
  return `data:${image.mimeType};base64,${image.dataBase64}`
}

/** 仅注入页面所需的图片动作与观察源。 */
export interface ImageWorkbenchFace {
  hooks: { workbench: HostObservable<WorkbenchState> }
  activate: (value: boolean) => void
  refresh: () => Promise<void>
  setFilter: (filter: ImageFilter) => void
  setSearch: (value: string) => void
  loadMore: () => Promise<void>
  submit: (input: DraftSubmission) => Promise<boolean>
  importImage: (input: ImageImportRequest) => Promise<ImageAsset | undefined>
  describeImage: (id: ImageAssetId) => Promise<ImageAsset | undefined>
  ensureThumbnail: (id: ImageAssetId, retry?: boolean) => Promise<void>
  readOriginal: (id: ImageAssetId) => Promise<ImageReadResult | undefined>
  favorite: (job: ImageJob) => Promise<void>
  archive: (job: ImageJob) => Promise<void>
  cancel: (id: ImageJobId) => Promise<void>
  exportImage: (id: ImageAssetId, destination: ImageExportDestination) => Promise<boolean>
  notify: (key: ImageWorkbenchKey) => void
  dismissNotice: (seq: number) => void
  openModels: () => void
  openAccount: () => void
}

/** 将有界查询和任务动作绑定到一个客户端插件生命周期。 */
export class ImageWorkbenchController {
  /** 当前可见数据和操作状态的稳定观察源。 */
  readonly store = createSnapshotStore<WorkbenchState>({ catalog: undefined, jobs: [], workspaces: [], nextCursor: undefined,
    filter: 'all', search: '', loading: false, busy: false, error: undefined, thumbnails: {}, notice: undefined })
  private disposed = false
  private active = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private searchTimer: ReturnType<typeof setTimeout> | undefined
  private refreshPromise: Promise<void> | undefined
  private morePromise: Promise<void> | undefined
  private revision = 0
  private mutations = 0
  private noticeSeq = 0
  private submission: { signature: string; id: ImageSubmissionId } | undefined
  private submitting: Promise<boolean> | undefined
  private readonly pending = new Set<Promise<unknown>>()
  private readonly thumbnailReads = new Map<ImageAssetId, Promise<void>>()

  /** @param remote - 已生成的工作台 Remote。 */
  constructor(private readonly remote: ImageWorkbenchRemote) {}

  private own<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise)
    void promise.finally(() => { this.pending.delete(promise) }).catch(() => { /* 请求拥有者负责显示错误。 */ })
    return promise
  }

  private isDisposed(): boolean { return this.disposed }

  /**
   * 发布由全局通知层显示的操作结果。
   * @param key - 已本地化的通知键。
   */
  notify = (key: ImageWorkbenchKey): void => {
    if (!this.disposed) this.store.update((state) => { state.notice = { key, seq: ++this.noticeSeq } })
  }

  /**
   * 仅关闭调用方仍在显示的通知。
   * @param seq - 当前通知的唯一序号。
   */
  dismissNotice = (seq: number): void => {
    if (!this.disposed && this.store.getSnapshot().notice?.seq === seq) this.store.update((state) => { state.notice = undefined })
  }

  /**
   * 开始或停止可见页面的查询，离页后不继续读取后续页。
   * @param value - 页面当前是否可见。
   */
  activate = (value: boolean): void => {
    if (this.disposed) return
    this.active = value
    if (value) void this.refresh()
    else {
      this.revision++
      clearTimeout(this.timer)
      clearTimeout(this.searchTimer)
      this.timer = undefined
      this.searchTimer = undefined
      this.publishLoading()
    }
  }

  private publishLoading(): void {
    if (!this.disposed) this.store.update((state) => {
      state.loading = this.refreshPromise !== undefined || this.morePromise !== undefined || this.searchTimer !== undefined
    })
  }

  private schedule(): void {
    clearTimeout(this.timer)
    const snapshot = this.store.getSnapshot()
    if (this.disposed || !this.active || snapshot.catalog === undefined) return
    if (!snapshot.jobs.some(job => job.status === 'queued' || job.status === 'running'
      || job.status === 'uncertain' && job.request.model.source === 'platform')) return
    this.timer = setTimeout(() => { this.timer = undefined; void this.refresh() }, snapshot.catalog.limits.pollIntervalMs)
  }

  private query(filter: ImageFilter, search: string, cursor?: ImageJobId): ImageJobQuery {
    return { limit: HISTORY_PAGE_SIZE, archived: filter === 'archived', favoritesOnly: filter === 'favorites',
      activeOnly: filter === 'active', ...search.trim() === '' ? {} : { search: search.trim() },
      ...cursor === undefined ? {} : { cursor } }
  }

  private async readHistory(count: number, filter: ImageFilter, search: string, revision: number): Promise<RemoteResult<ImageJobPage>> {
    const jobs: ImageJob[] = []
    const seen = new Set<ImageJobId>()
    let cursor: ImageJobId | undefined
    do {
      const page = await this.remote.listJobs(this.query(filter, search, cursor))
      if (!page.ok) return page
      for (const job of page.value.jobs) { if (!seen.has(job.id)) { jobs.push(job); seen.add(job.id) } }
      cursor = page.value.nextCursor
    } while (!this.disposed && revision === this.revision && jobs.length < count && cursor !== undefined)
    return { ok: true, value: { jobs, ...cursor === undefined ? {} : { nextCursor: cursor } } }
  }

  /**
   * 刷新目录与当前已加载历史范围，保留失败前的可见数据。
   * @returns 当前共享刷新的完成时点。
   */
  refresh = (): Promise<void> => {
    if (this.disposed) return Promise.resolve()
    clearTimeout(this.searchTimer)
    this.searchTimer = undefined
    if (this.refreshPromise !== undefined) return this.refreshPromise
    if (this.morePromise !== undefined) return this.morePromise.then(this.refresh)
    const revision = this.revision
    const current = this.store.getSnapshot()
    const operation = Promise.resolve().then(async () => {
      try {
        if (this.disposed) return
        const [catalog, history, workspaces] = await Promise.all([
          this.remote.catalog(),
          this.readHistory(Math.max(HISTORY_PAGE_SIZE, current.jobs.length), current.filter, current.search, revision),
          this.remote.listWorkspaces(),
        ])
        if (this.isDisposed() || revision !== this.revision) return
        this.store.update((state) => {
          state.error = undefined
          if (catalog.ok) state.catalog = catalog.value
          else state.error = errorKey(catalog)
          if (history.ok) { state.jobs = history.value.jobs; state.nextCursor = history.value.nextCursor }
          else state.error = errorKey(history)
          if (workspaces.ok) state.workspaces = workspaces.value
          else state.error = errorKey(workspaces)
        })
      } catch (_error) {
        if (!this.isDisposed() && revision === this.revision) this.store.update((state) => { state.error = 'error.connection' })
      } finally {
        this.refreshPromise = undefined
        this.publishLoading()
        this.schedule()
        if (!this.disposed && this.active && revision !== this.revision && this.searchTimer === undefined) void this.refresh()
      }
    })
    this.refreshPromise = operation
    this.publishLoading()
    return this.own(operation)
  }

  /**
   * 切换服务端筛选并作废旧查询结果。
   * @param filter - 要显示的历史范围。
   */
  setFilter = (filter: ImageFilter): void => {
    if (this.disposed || filter === this.store.getSnapshot().filter) return
    this.revision++
    clearTimeout(this.searchTimer)
    this.searchTimer = undefined
    this.store.update((state) => { state.filter = filter; state.jobs = []; state.nextCursor = undefined })
    if (this.active) void this.refresh()
    else this.publishLoading()
  }

  /**
   * 合并连续输入后查询完整历史，草稿文字立即反映到界面。
   * @param value - 用户输入的搜索文本。
   */
  setSearch = (value: string): void => {
    if (this.disposed || value === this.store.getSnapshot().search) return
    this.revision++
    clearTimeout(this.timer)
    clearTimeout(this.searchTimer)
    this.timer = undefined
    this.searchTimer = undefined
    this.store.update((state) => { state.search = value; state.jobs = []; state.nextCursor = undefined; state.error = undefined })
    if (this.active) this.searchTimer = setTimeout(() => {
      this.searchTimer = undefined
      void this.refresh()
    }, SEARCH_DEBOUNCE_MS)
    this.publishLoading()
  }

  /**
   * 加载当前历史范围的下一页。
   * @returns 当前共享追加操作的完成时点。
   */
  loadMore = (): Promise<void> => {
    const current = this.store.getSnapshot()
    if (this.morePromise !== undefined) return this.morePromise
    if (current.nextCursor === undefined || this.disposed || current.loading) return Promise.resolve()
    const revision = this.revision
    const cursor = current.nextCursor
    const operation = Promise.resolve().then(async () => {
      try {
        if (this.disposed) return
        const result = await this.remote.listJobs(this.query(current.filter, current.search, cursor))
        if (this.isDisposed() || revision !== this.revision) return
        if (!result.ok) { this.store.update((state) => { state.error = errorKey(result) }); return }
        this.store.update((state) => {
          state.error = undefined
          const ids = new Set(state.jobs.map(job => job.id))
          state.jobs.push(...result.value.jobs.filter(job => !ids.has(job.id)))
          state.nextCursor = result.value.nextCursor
        })
      } catch (_error) {
        if (!this.isDisposed() && revision === this.revision) this.store.update((state) => { state.error = 'error.connection' })
      } finally {
        this.morePromise = undefined
        this.publishLoading()
        this.schedule()
      }
    })
    this.morePromise = operation
    this.publishLoading()
    return this.own(operation)
  }

  private async operation<T>(call: () => Promise<RemoteResult<T>>): Promise<T | undefined> {
    if (this.disposed) return undefined
    this.mutations++
    this.store.update((state) => { state.busy = true })
    try {
      const result = await this.own(call())
      if (this.isDisposed()) return undefined
      if (!result.ok) { this.notify(errorKey(result)); return undefined }
      return result.value
    } catch (_error) { this.notify('error.connection'); return undefined }
    finally {
      this.mutations--
      if (!this.isDisposed()) this.store.update((state) => { state.busy = this.mutations > 0 })
    }
  }

  /**
   * 为同一次提交复用身份，只有确认受理后才开始下一次创作。
   * @param input - 已选模型、图片和参数。
   * @returns 任务是否已被持久受理。
   */
  submit = (input: DraftSubmission): Promise<boolean> => {
    if (this.disposed) return Promise.resolve(false)
    if (this.submitting !== undefined) return this.submitting
    const signature = JSON.stringify(input)
    if (this.submission?.signature !== signature) this.submission = { signature, id: randomUUID() as ImageSubmissionId }
    const submissionId = this.submission.id
    const pending = (async () => {
      const jobs = await this.operation(() => this.remote.submit({ ...input, submissionId }))
      if (jobs === undefined) return false
      this.submission = undefined
      this.setFilter('all')
      if (this.active) await this.refresh()
      this.notify('submitted')
      return true
    })().finally(() => { this.submitting = undefined })
    this.submitting = pending
    return this.own(pending)
  }

  /**
   * 导入参考图片的原始内容。
   * @param input - 原始图片字节。
   * @returns 已持久保存的原图元数据。
   */
  importImage = (input: ImageImportRequest): Promise<ImageAsset | undefined> => this.operation(() => this.remote.importImage(input))
  /**
   * 读取已保存原图的元数据。
   * @param id - 已有原图标识。
   * @returns 原图元数据。
   */
  describeImage = (id: ImageAssetId): Promise<ImageAsset | undefined> => this.operation(() => this.remote.describeImage(id))
  /**
   * 按需读取用于下载或继续创作的原图。
   * @param id - 已有原图标识。
   * @returns 未经缩放的原图内容。
   */
  readOriginal = (id: ImageAssetId): Promise<ImageReadResult | undefined> => this.operation(() => this.remote.readImage(id, 'original'))

  /**
   * 合并同一缩略图的并发读取，失败项仅在明确重试时重读。
   * @param id - 需要显示的图片。
   * @param retry - 是否重试一次已失败的缩略图读取。
   * @returns 当前读取的完成时点。
   */
  ensureThumbnail = (id: ImageAssetId, retry = false): Promise<void> => {
    if (this.disposed) return Promise.resolve()
    const existing = this.thumbnailReads.get(id)
    if (existing !== undefined) return existing
    if (!retry && this.store.getSnapshot().thumbnails[id] !== undefined) return Promise.resolve()
    this.store.update((state) => { state.thumbnails[id] = { status: 'loading' } })
    const operation = Promise.resolve().then(async () => {
      try {
        if (this.disposed) return
        const result = await this.remote.readImage(id, 'thumbnail')
        if (!this.isDisposed()) this.store.update((state) => {
          state.thumbnails[id] = result.ok ? { status: 'ready', url: imageDataUrl(result.value) } : { status: 'failed' }
        })
      } catch (_error) {
        if (!this.isDisposed()) this.store.update((state) => { state.thumbnails[id] = { status: 'failed' } })
      } finally { this.thumbnailReads.delete(id) }
    })
    this.thumbnailReads.set(id, operation)
    return this.own(operation)
  }

  /**
   * 切换收藏状态，并在成功后刷新历史。
   * @param job - 要切换收藏状态的任务。
   * @returns 操作完成时点。
   */
  favorite = async (job: ImageJob): Promise<void> => {
    if (await this.operation(() => this.remote.favorite(job.id, !job.favorite)) !== undefined && this.active) await this.refresh()
  }
  /**
   * 归档或恢复任务，失败时保留当前作品。
   * @param job - 要归档或恢复的任务。
   * @returns 操作完成时点。
   */
  archive = async (job: ImageJob): Promise<void> => {
    if (await this.operation(() => this.remote.archive(job.id, !job.archived)) !== undefined) {
      if (this.active) await this.refresh()
      this.notify('updated')
    }
  }
  /**
   * 请求取消尚未开始的任务。
   * @param id - 尚未开始的任务。
   * @returns 操作完成时点。
   */
  cancel = async (id: ImageJobId): Promise<void> => {
    if (await this.operation(() => this.remote.cancel(id)) !== undefined && this.active) await this.refresh()
  }
  /**
   * 将原图写入 Host 验证过的工作区目标。
   * @param id - 原图标识。
   * @param destination - 经 Host 验证的工作区和文件名。
   * @returns 是否保存成功。
   */
  exportImage = async (id: ImageAssetId, destination: ImageExportDestination): Promise<boolean> => {
    if (await this.operation(() => this.remote.exportImage(id, destination)) === undefined) return false
    this.notify('saved'); return true
  }

  /**
   * 停止查询并等待已经发出的读取完成，不取消 Host 持久任务。
   * @returns 所有已拥有请求完成后的清理结果。
   */
  async dispose(): Promise<void> {
    this.disposed = true
    this.active = false
    clearTimeout(this.timer)
    clearTimeout(this.searchTimer)
    await Promise.allSettled([...this.pending])
  }
}
