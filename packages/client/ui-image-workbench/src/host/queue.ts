/** 页面之外的持久任务执行器；派发前提交 running，恢复时不重发自定义请求。 */
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { ImageJobId } from '../types.ts'
import type { WorkbenchConfig } from './config.ts'
import { ImageFailure, imageFailureCode } from './errors.ts'
import { imageMime, type ImageProviders } from './providers.ts'
import type { StoredImageJob } from './schemas.ts'
import type { ImageStore } from './store.ts'

/** 执行器使用的外部图片服务操作。 */
export type ImageQueueProviders = Pick<ImageProviders, 'accountId' | 'generateCustom' | 'createPlatform' | 'platformStatus' | 'platformImage'>

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true }
  catch (error) { return !(error instanceof Error && 'code' in error && error.code === 'ESRCH') }
}

/** 每实例串行执行，文件锁中的任务领取防止其他主机进程重复派发。 */
export class ImageQueue {
  private readonly lifetime = new AbortController()
  private readonly instance = randomUUID()
  private pending: Promise<void> | undefined
  private wakeRequested = false
  private failed = false
  /** @param store - 原子任务索引。 @param providers - 供方请求。 @param config - 轮询与资源限制。 */
  constructor(private readonly store: ImageStore, private readonly providers: ImageQueueProviders,
    private readonly config: WorkbenchConfig) {}
  private isClosing(): boolean { return this.lifetime.signal.aborted }
  /** 新任务或账号变化后恢复后台处理，不借用页面生命周期。 */
  wake(): void {
    if (this.failed || this.lifetime.signal.aborted) return
    this.wakeRequested = true
    if (this.pending !== undefined) return
    this.wakeRequested = false
    this.pending = this.run().catch((_error: unknown) => { this.failed = true }).finally(() => {
      this.pending = undefined
      if (this.wakeRequested) this.wake()
    })
  }
  /** 持久化失效后拒绝继续受理；已有文件保留供重启恢复。 */
  assertHealthy(): void {
    if (this.failed) throw new ImageFailure('storage')
    if (this.lifetime.signal.aborted) throw new ImageFailure('cancel-unavailable')
  }
  /** 终止请求并等待所有任务状态与原图写入结束。 */
  async close(): Promise<void> {
    this.lifetime.abort()
    await this.pending
  }
  private async run(): Promise<void> {
    while (!this.isClosing()) {
      const accountId = await this.providers.accountId()
      const processed = new Set<ImageJobId>()
      let platformPending = false
      let claimed: StoredImageJob | undefined
      do {
        claimed = await this.claim(processed, accountId, platformPending)
        if (claimed === undefined) break
        if (this.isClosing()) {
          await this.update(claimed, (current) => { current.status = 'queued'; delete current.owner })
          return
        }
        processed.add(claimed.id)
        const pending = await this.execute(claimed)
        platformPending ||= pending
      } while (!this.isClosing())
      if (this.isClosing()) return
      const jobs = (await this.store.read()).jobs
      if (!jobs.some(job => this.runnable(job, accountId))) return
      try { await delay(this.config.pollIntervalMs, undefined, { signal: this.lifetime.signal, ref: false }) }
      catch (error) { if (!this.isClosing()) throw error }
    }
  }
  private runnable(job: StoredImageJob, accountId: string | undefined): boolean {
    if (job.request.model.source === 'platform' && (accountId === undefined || job.accountId !== accountId)) return false
    if (job.status === 'queued' || job.status === 'running') return true
    return job.status === 'uncertain' && job.request.model.source === 'platform'
  }
  private async claim(processed: Set<ImageJobId>, accountId: string | undefined,
    platformPending: boolean): Promise<StoredImageJob | undefined> {
    return this.store.transaction((journal) => {
      for (const job of journal.jobs) {
        if (job.owner !== undefined && !processExists(job.owner.pid)) delete job.owner
        if (job.owner === undefined && job.request.model.source === 'platform'
          && (accountId === undefined || job.accountId !== accountId) && ['queued', 'running', 'uncertain'].includes(job.status)) {
          if (job.status === 'running') job.status = 'uncertain'
          const code = accountId === undefined ? 'account-required' : 'account-changed'
          if (job.error?.code !== code) { job.error = { code }; job.updatedAt = Date.now() }
        }
        if (job.status === 'running' && job.owner === undefined && job.request.model.source === 'custom') {
          job.status = 'uncertain'; job.error = { code: 'upstream-unavailable' }; job.updatedAt = Date.now()
        }
      }
      if (journal.jobs.some(job => job.owner !== undefined)) return undefined
      const job = journal.jobs.find(value => !processed.has(value.id) && this.runnable(value, accountId)
        && !(platformPending && value.request.model.source === 'platform'))
      if (job === undefined) return undefined
      job.owner = { pid: process.pid, instance: this.instance }
      job.status = 'running'
      delete job.error
      job.updatedAt = Date.now()
      return structuredClone(job)
    })
  }
  private async update(job: StoredImageJob, mutate: (current: StoredImageJob) => void): Promise<void> {
    await this.store.transaction((journal) => {
      const current = journal.jobs.find(value => value.id === job.id)
      if (current?.owner?.instance !== this.instance) return
      mutate(current)
      current.updatedAt = Date.now()
    })
  }
  private async execute(job: StoredImageJob): Promise<boolean> {
    try {
      if (job.request.model.source === 'custom') {
        const bytes = await this.providers.generateCustom(job.request, this.lifetime.signal)
        const image = await this.store.saveImage(bytes, imageMime(bytes))
        await this.update(job, (current) => { current.images = [image]; current.status = 'succeeded'; delete current.owner })
        return false
      }
      const remote = job.remoteId === undefined ? await this.providers.createPlatform(job, this.lifetime.signal)
        : await this.providers.platformStatus(job, false, this.lifetime.signal)
      job.remoteId = remote.id
      await this.update(job, (current) => { current.remoteId = remote.id })
      if (remote.state === 'succeeded') {
        const bytes = await this.providers.platformImage(job, this.lifetime.signal)
        const image = await this.store.saveImage(bytes, imageMime(bytes))
        await this.update(job, (current) => {
          current.images = [image]; current.status = 'succeeded'; delete current.owner
          if (remote.charged_units !== undefined) current.chargedUnits = remote.charged_units
        })
        return false
      } else {
        await this.update(job, (current) => {
          current.status = remote.state
          if (remote.state === 'failed' || remote.state === 'uncertain') {
            current.error = { code: remote.error_code === 'insufficient_points' ? 'insufficient-points' : 'upstream-rejected' }
          }
          delete current.owner
        })
        return remote.state === 'queued' || remote.state === 'running' || remote.state === 'uncertain'
      }
    } catch (error) {
      const uncertain = this.lifetime.signal.aborted || !(error instanceof ImageFailure) || error.uncertain
        || job.request.model.source === 'platform' && job.remoteId !== undefined
      await this.update(job, (current) => {
        current.status = uncertain ? 'uncertain' : 'failed'
        current.error = { code: imageFailureCode(error) }
        delete current.owner
      })
      return job.request.model.source === 'platform' && uncertain
    }
  }
}
