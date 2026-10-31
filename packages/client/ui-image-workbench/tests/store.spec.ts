/** 原图字节、缩略图和跨实例持久写入的实际文件验证。 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, expect, it } from 'vitest'
import { ImageStore } from '../src/host/store.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function store(overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'freecode-image-store-'))
  roots.push(directory)
  const options = { directory, maxImageBytes: 1_000_000, maxImagePixels: 1_000_000, maxStorageBytes: 5_000_000,
    maxJournalBytes: 1_000_000, maxJobs: 20, thumbnailSize: 64, maxThumbnailBytes: 100_000, lockWaitMs: 5000, ...overrides }
  const instance = new ImageStore(options)
  await instance.initialize()
  return { instance, directory, options }
}
const source = () => sharp({ create: { width: 256, height: 128, channels: 4, background: '#3366ff80' } }).png().toBuffer()

it('keeps exact originals, deduplicates imports and reads smaller alpha thumbnails after restart', async () => {
  const { instance, options } = await store()
  const original = await source()
  const image = await instance.saveImage(original, 'image/png')
  expect(await instance.readImage(image.id, 'original')).toEqual({ bytes: original, mimeType: 'image/png' })
  expect(await instance.saveImage(original, 'image/png')).toEqual(image)
  const reopened = new ImageStore(options)
  await reopened.initialize()
  const thumbnail = await reopened.readImage(image.id, 'thumbnail')
  expect(await sharp(thumbnail.bytes).metadata()).toMatchObject({ width: 64, height: 32, hasAlpha: true })
  expect((await reopened.read()).assets).toHaveLength(1)
})

it('rejects wrong MIME, invalid bytes and pixel/byte limits before admitting an asset', async () => {
  const { instance } = await store({ maxImagePixels: 1000 })
  await expect(instance.saveImage(await source(), 'image/png')).rejects.toMatchObject({ code: 'too-large' })
  const other = await store()
  await expect(other.instance.saveImage(await source(), 'image/jpeg')).rejects.toMatchObject({ code: 'invalid-input' })
  await expect(other.instance.saveImage(Buffer.from('not an image'), 'image/png')).rejects.toMatchObject({ code: 'invalid-input' })
  await expect(other.instance.saveImage(Buffer.alloc(1_000_001), 'image/png')).rejects.toMatchObject({ code: 'too-large' })
  expect((await other.instance.read()).assets).toEqual([])
})

it('serializes independent writers and refuses a damaged journal without replacing it', async () => {
  const { instance, directory, options } = await store()
  const other = new ImageStore(options)
  await other.initialize()
  await Promise.all([instance.saveImage(await source(), 'image/png'), other.saveImage(await sharp({
    create: { width: 10, height: 10, channels: 3, background: '#ff6633' },
  }).jpeg().toBuffer(), 'image/jpeg')])
  expect((await instance.read()).assets).toHaveLength(2)
  const path = join(directory, 'journal.json')
  await writeFile(path, '{damaged')
  await expect(other.read()).rejects.toMatchObject({ code: 'storage' })
  expect(await readFile(path, 'utf8')).toBe('{damaged')
})
