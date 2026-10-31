/** 原图与任务索引分开持久化；发布任务结果前先写入完整原图。 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { ImageAsset, ImageAssetId, ImageMimeType } from '../types.ts'
import { ImageFailure } from './errors.ts'
import { assetIdSchema, journalSchema, type ImageJournal } from './schemas.ts'

/** 本机文件与解码资源上限。 */
export interface ImageStoreOptions {
  directory: string
  maxImageBytes: number
  maxImagePixels: number
  maxStorageBytes: number
  maxJournalBytes: number
  maxJobs: number
  thumbnailSize: number
  maxThumbnailBytes: number
  lockWaitMs: number
}

/** 由工作台实例持有的文件存储，跨进程写入通过现有原子写锁串行化。 */
export class ImageStore {
  private readonly journalPath: string
  private readonly imagesPath: string
  /** @param options - 独立存储目录和资源限制。 */
  constructor(private readonly options: ImageStoreOptions) {
    this.journalPath = join(options.directory, 'journal.json')
    this.imagesPath = join(options.directory, 'images')
  }
  /** 验证索引并建立私有目录；损坏文件不会被空索引替换。 */
  async initialize(): Promise<void> {
    await mkdir(this.imagesPath, { recursive: true, mode: 0o700 })
    await this.read()
  }
  /**
   * 读取并校验持久索引，损坏文件不会被当作空库。
   * @returns 完整、验证后的持久索引。
   */
  async read(): Promise<ImageJournal> {
    let bytes: Buffer
    try {
      if ((await stat(this.journalPath)).size > this.options.maxJournalBytes) throw new ImageFailure('storage')
      bytes = await readFile(this.journalPath)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { version: 1, jobs: [], assets: [], submissions: [] }
      throw new ImageFailure('storage')
    }
    try {
      if (bytes.length > this.options.maxJournalBytes) throw new ImageFailure('storage')
      const parsed = journalSchema.parse(JSON.parse(bytes.toString('utf8')))
      if (parsed.jobs.length > this.options.maxJobs) throw new ImageFailure('storage')
      return parsed
    } catch { throw new ImageFailure('storage') }
  }
  /**
   * 在跨进程文件锁内提交索引变更。
   * @param mutate - 锁内变更完整索引。
   * @returns 索引成功提交后的操作结果。
   */
  async transaction<T>(mutate: (journal: ImageJournal) => T | Promise<T>): Promise<T> {
    return withFileLock(this.journalPath, async () => {
      const journal = await this.read()
      const result = await mutate(journal)
      if (journal.jobs.length > this.options.maxJobs) throw new ImageFailure('too-large')
      const serialized = JSON.stringify(journalSchema.parse(journal))
      if (Buffer.byteLength(serialized) > this.options.maxJournalBytes) throw new ImageFailure('too-large')
      try { await writeFileAtomic(this.journalPath, serialized, { mode: 0o600, dirMode: 0o700 }) }
      catch { throw new ImageFailure('storage') }
      return result
    }, { waitMs: this.options.lockWaitMs })
  }
  /**
   * 持久保存原图与缩略图，同一内容复用已有资源。
   * @param bytes - 未经聊天压缩管线的原图。
   * @param claimedMime - 声明的编码。
   * @returns 已持久化的原图元数据。
   */
  async saveImage(bytes: Uint8Array, claimedMime: ImageMimeType): Promise<ImageAsset> {
    if (bytes.byteLength > this.options.maxImageBytes) throw new ImageFailure('too-large')
    let asset: ImageAsset
    let thumbnail: Buffer
    try {
      const image = sharp(bytes, { limitInputPixels: false })
      const info = await image.metadata()
      if (info.width * info.height > this.options.maxImagePixels) throw new ImageFailure('too-large')
      const mimeType = info.format === 'png' ? 'image/png' : info.format === 'jpeg' ? 'image/jpeg' : info.format === 'webp' ? 'image/webp' : undefined
      if (mimeType !== claimedMime || (info.pages ?? 1) > 1) throw new ImageFailure('invalid-input')
      thumbnail = await sharp(bytes, { limitInputPixels: this.options.maxImagePixels }).autoOrient()
        .resize({ width: this.options.thumbnailSize, height: this.options.thumbnailSize, fit: 'inside', withoutEnlargement: true }).webp().toBuffer()
      if (thumbnail.length > this.options.maxThumbnailBytes) throw new ImageFailure('too-large')
      asset = { id: createHash('sha256').update(bytes).digest('hex') as ImageAssetId,
        mimeType, width: info.width, height: info.height, bytes: bytes.byteLength }
    } catch (error) { throw error instanceof ImageFailure ? error : new ImageFailure('invalid-input') }
    return this.transaction(async (journal) => {
      const found = journal.assets.find(value => value.id === asset.id)
      if (found !== undefined) return found
      const entries = await readdir(this.imagesPath)
      const used = (await Promise.all(entries.map(async name => (await stat(join(this.imagesPath, name))).size))).reduce((a, b) => a + b, 0)
      if (used + bytes.byteLength + thumbnail.byteLength > this.options.maxStorageBytes) throw new ImageFailure('too-large')
      try {
        await writeFileAtomic(this.imagePath(asset.id, 'original'), bytes, { mode: 0o600 })
        await writeFileAtomic(this.imagePath(asset.id, 'thumbnail'), thumbnail, { mode: 0o600 })
      } catch { throw new ImageFailure('storage') }
      journal.assets.push(asset)
      return asset
    })
  }
  /**
   * 有界读取图片，并验证原图内容摘要。
   * @param id - 已登记资源标识。
   * @param variant - 原图或缩略图。
   * @returns 有界的完整文件字节。
   */
  async readImage(id: ImageAssetId, variant: 'original' | 'thumbnail'): Promise<{ bytes: Buffer; mimeType: ImageMimeType }> {
    if (!assetIdSchema.safeParse(id).success) throw new ImageFailure('not-found')
    const image = (await this.read()).assets.find(asset => asset.id === id)
    if (image === undefined) throw new ImageFailure('not-found')
    try {
      const path = this.imagePath(id, variant)
      const limit = variant === 'original' ? this.options.maxImageBytes : this.options.maxThumbnailBytes
      if ((await stat(path)).size > limit) throw new ImageFailure('too-large')
      const bytes = await readFile(path)
      if (bytes.length > limit) throw new ImageFailure('too-large')
      if (variant === 'original' && createHash('sha256').update(bytes).digest('hex') !== id) throw new ImageFailure('storage')
      return { bytes, mimeType: variant === 'original' ? image.mimeType : 'image/webp' }
    } catch (error) { throw error instanceof ImageFailure ? error : new ImageFailure('storage') }
  }
  private imagePath(id: ImageAssetId, variant: 'original' | 'thumbnail'): string {
    return join(this.imagesPath, `${id}.${variant}`)
  }
}
