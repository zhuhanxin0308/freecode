/** 持久层的容量、文件完整性与操作系统失败边界。 */
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, expect, it, vi } from 'vitest'
import * as atomic from '@deepseek-ai/dsh-atomic-write'
import { ImageStore, type ImageStoreOptions } from '../src/host/store.ts'
import type { StoredImageJob } from '../src/host/schemas.ts'
import type { ImageAssetId, ImageJobId } from '../src/types.ts'

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, stat: vi.fn(actual.stat), readFile: vi.fn(actual.readFile) }
})
vi.mock('@deepseek-ai/dsh-atomic-write', async (original) => {
  const actual = await original<typeof import('@deepseek-ai/dsh-atomic-write')>()
  return { ...actual, writeFileAtomic: vi.fn(actual.writeFileAtomic) }
})

const roots: string[] = []
afterEach(async () => {
  vi.mocked(fs.stat).mockRestore()
  vi.mocked(fs.readFile).mockRestore()
  vi.mocked(atomic.writeFileAtomic).mockRestore()
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })))
})
async function setup(overrides: Partial<ImageStoreOptions> = {}) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'freecode-image-storage-failure-'))
  roots.push(directory)
  const options: ImageStoreOptions = { directory, maxImageBytes: 10_000, maxImagePixels: 10_000, maxStorageBytes: 100_000,
    maxJournalBytes: 10_000, maxJobs: 10, thumbnailSize: 32, maxThumbnailBytes: 10_000, lockWaitMs: 5000, ...overrides }
  const store = new ImageStore(options)
  await store.initialize()
  const image = await sharp({ create: { width: 32, height: 16, channels: 3, background: '#234567' } }).png().toBuffer()
  return { store, directory, options, image, journal: join(directory, 'journal.json') }
}
function job(): StoredImageJob {
  return { id: randomUUID() as ImageJobId, createdAt: 1, updatedAt: 1, status: 'queued', favorite: false, archived: false, images: [],
    request: { model: { source: 'custom', provider: 'fixture', id: 'image' }, prompt: 'blue sky', size: 'auto', quality: 'auto',
      format: 'png', background: 'auto', referenceImageIds: [] } }
}

it('超限索引与损坏结构拒绝读取，保留文件供恢复', async () => {
  const f = await setup({ maxJournalBytes: 1024, maxJobs: 1 })
  await fs.writeFile(f.journal, 'x'.repeat(1025))
  await expect(f.store.read()).rejects.toMatchObject({ code: 'storage' })
  const oversized = await fs.readFile(f.journal)
  expect(oversized.length).toBe(1025)
  await fs.writeFile(f.journal, JSON.stringify({ version: 1, jobs: [job(), job()], assets: [], submissions: [] }))
  await expect(f.store.read()).rejects.toMatchObject({ code: 'storage' })
  await fs.writeFile(f.journal, JSON.stringify({ version: 2, jobs: [], assets: [], submissions: [] }))
  await expect(f.store.read()).rejects.toMatchObject({ code: 'storage' })
})

it('索引在文件状态检查后变大仍然拒绝，读取权限错误不当作空库', async () => {
  const f = await setup({ maxJournalBytes: 1024 })
  await f.store.transaction(() => {})
  const actualStat = vi.mocked(fs.stat).getMockImplementation()
  if (actualStat === undefined) throw new Error('文件状态夹具未安装')
  vi.mocked(fs.stat).mockImplementationOnce(async (...args) => {
    const result = await actualStat(...args)
    await fs.writeFile(f.journal, 'x'.repeat(1025))
    return result
  })
  await expect(f.store.read()).rejects.toMatchObject({ code: 'storage' })
  vi.mocked(fs.stat).mockRejectedValueOnce(Object.assign(new Error('access refused'), { code: 'EACCES' }))
  await expect(f.store.read()).rejects.toMatchObject({ code: 'storage' })
})

it('提交超出任务数或索引字节额度时原索引不变', async () => {
  const f = await setup({ maxJobs: 1, maxJournalBytes: 1024 })
  await f.store.transaction((state) => { state.jobs.push(job()) })
  const before = await fs.readFile(f.journal)
  await expect(f.store.transaction((state) => { state.jobs.push(job()) })).rejects.toMatchObject({ code: 'too-large' })
  await expect(f.store.transaction((state) => { state.jobs[0]!.request.prompt = 'x'.repeat(1024) }))
    .rejects.toMatchObject({ code: 'too-large' })
  expect(await fs.readFile(f.journal)).toEqual(before)
  vi.mocked(atomic.writeFileAtomic).mockRejectedValueOnce(Object.assign(new Error('write failed'), { code: 'EIO' }))
  await expect(f.store.transaction((state) => { state.jobs[0]!.favorite = true })).rejects.toMatchObject({ code: 'storage' })
  expect(await fs.readFile(f.journal)).toEqual(before)
})

it('缩略图与磁盘额度独立受限，失败时不会登记可见资产', async () => {
  const thumbnail = await setup({ maxThumbnailBytes: 1 })
  await expect(thumbnail.store.saveImage(thumbnail.image, 'image/png')).rejects.toMatchObject({ code: 'too-large' })
  const capacity = await setup({ maxStorageBytes: 1 })
  await expect(capacity.store.saveImage(capacity.image, 'image/png')).rejects.toMatchObject({ code: 'too-large' })
  const write = await setup()
  vi.mocked(atomic.writeFileAtomic).mockRejectedValueOnce(Object.assign(new Error('device full'), { code: 'ENOSPC' }))
  await expect(write.store.saveImage(write.image, 'image/png')).rejects.toMatchObject({ code: 'storage' })
  expect((await write.store.read()).assets).toEqual([])
})

it('支持 WebP 原图，但不接受 GIF 等未声明的编码', async () => {
  const f = await setup()
  const webp = await sharp(f.image).webp().toBuffer()
  const asset = await f.store.saveImage(webp, 'image/webp')
  expect((await f.store.readImage(asset.id, 'original')).bytes).toEqual(webp)
  await expect(f.store.saveImage(await sharp(f.image).gif().toBuffer(), 'image/png')).rejects.toMatchObject({ code: 'invalid-input' })
})

it('缺失、截断或外部篡改的原图不能作为成功结果返回', async () => {
  const f = await setup()
  await expect(f.store.readImage('../outside' as ImageAssetId, 'original')).rejects.toMatchObject({ code: 'not-found' })
  await expect(f.store.readImage('a'.repeat(64) as ImageAssetId, 'original')).rejects.toMatchObject({ code: 'not-found' })
  const asset = await f.store.saveImage(f.image, 'image/png')
  const original = join(f.directory, 'images', `${asset.id}.original`)
  await fs.writeFile(original, 'different content')
  await expect(f.store.readImage(asset.id, 'original')).rejects.toMatchObject({ code: 'storage' })
  await fs.writeFile(original, Buffer.alloc(f.options.maxImageBytes + 1))
  await expect(f.store.readImage(asset.id, 'original')).rejects.toMatchObject({ code: 'too-large' })
  await fs.writeFile(original, f.image)
  const actualRead = vi.mocked(fs.readFile).getMockImplementation()
  if (actualRead === undefined) throw new Error('文件读取夹具未安装')
  vi.mocked(fs.readFile).mockImplementation(async (...args) => args[0] === original
    ? Buffer.alloc(f.options.maxImageBytes + 1) : actualRead(...args))
  await expect(f.store.readImage(asset.id, 'original')).rejects.toMatchObject({ code: 'too-large' })
  vi.mocked(fs.readFile).mockRestore()
  await fs.rm(original)
  await expect(f.store.readImage(asset.id, 'original')).rejects.toMatchObject({ code: 'storage' })
})
