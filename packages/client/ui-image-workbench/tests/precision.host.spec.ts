/** Host 精确编辑的像素锁定与有界图片解码。 */
import sharp from 'sharp'
import { expect, it } from 'vitest'
import { composeMaskedImage, normalizeImageOrientation, validateEditMask } from '../src/host/image-processing.ts'

const limits = { maxImageBytes: 1024 * 1024, maxImagePixels: 1000 }
it('16 位 PNG 的锁定区保留全部精度，输出不会降为 8 位', async () => {
  const values = new Uint16Array([12345, 23456, 34567, 50000, 45000, 35000, 25000, 65535])
  const original = await sharp(values, { raw: { width: 2, height: 1, channels: 4 } }).toColourspace('rgb16').png().toBuffer()
  const mask = await sharp(Buffer.from([0, 0, 0, 255, 0, 0, 0, 0]), { raw: { width: 2, height: 1, channels: 4 } }).png().toBuffer()
  const generated = await sharp({ create: { width: 2, height: 1, channels: 4, background: 'red' } }).png().toBuffer()
  const output = await composeMaskedImage(original, mask, generated, limits)
  expect((await sharp(output).metadata()).depth).toBe('ushort')
  const bytes = await sharp(output).toColourspace('rgb16').ensureAlpha().raw({ depth: 'ushort' }).toBuffer()
  expect([...new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2).subarray(0, 4)]).toEqual([...values.subarray(0, 4)])
  const rotated = await sharp(original).withMetadata({ orientation: 6 }).toColourspace('rgb16').png().toBuffer()
  const normalized = await normalizeImageOrientation(rotated, 'image/png', limits)
  expect(await sharp(normalized.bytes).metadata()).toMatchObject({ width: 1, height: 2, depth: 'ushort' })
})
it('生成内容可以调整尺寸，但锁定区 RGBA 逐字节保留', async () => {
  const originalPixels = Buffer.from([20, 30, 40, 0, 60, 70, 80, 120, 90, 100, 110, 255])
  const original = await sharp(originalPixels, { raw: { width: 3, height: 1, channels: 4 } }).png().toBuffer()
  const mask = await sharp(Buffer.from([0, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 128]),
    { raw: { width: 3, height: 1, channels: 4 } }).png().toBuffer()
  const generated = await sharp({ create: { width: 6, height: 2, channels: 4,
    background: { r: 240, g: 0, b: 0, alpha: 1 } } }).png().toBuffer()
  const result = await composeMaskedImage(original, mask, generated, limits)
  const { data, info } = await sharp(result).raw().toBuffer({ resolveWithObject: true })
  expect([info.width, info.height]).toEqual([3, 1])
  expect(data.subarray(0, 4)).toEqual(originalPixels.subarray(0, 4))
  expect([...data.subarray(4, 8)]).toEqual([240, 0, 0, 255])
  expect(data.subarray(8, 12)).not.toEqual(originalPixels.subarray(8, 12))
  await expect(composeMaskedImage(original, generated, generated, limits)).rejects.toMatchObject({ code: 'invalid-input' })
  await expect(composeMaskedImage(original, mask, generated, { ...limits, maxImagePixels: 1 })).rejects.toMatchObject({ code: 'invalid-input' })
  await expect(composeMaskedImage(original, mask, generated, { ...limits, maxImageBytes: 1 })).rejects.toMatchObject({ code: 'too-large' })
})

it('仅规范化有方向标记的导入图，普通原图不重新编码', async () => {
  const original = await sharp({ create: { width: 3, height: 2, channels: 3, background: 'red' } }).png().toBuffer()
  expect(await normalizeImageOrientation(original, 'image/png', limits)).toEqual({ bytes: original, mimeType: 'image/png' })
  const oriented = await sharp(original).withMetadata({ orientation: 6 }).jpeg().toBuffer()
  const normalized = await normalizeImageOrientation(oriented, 'image/jpeg', limits)
  expect(normalized.mimeType).toBe('image/png')
  expect(await sharp(normalized.bytes).metadata()).toMatchObject({ width: 2, height: 3 })
  await expect(normalizeImageOrientation(oriented, 'image/png', limits)).rejects.toMatchObject({ code: 'invalid-input' })
  await expect(normalizeImageOrientation(Buffer.from('broken'), 'image/png', limits)).rejects.toMatchObject({ code: 'invalid-input' })
  const identity = await sharp(original).withMetadata({ orientation: 1 }).jpeg().toBuffer()
  expect((await normalizeImageOrientation(identity, 'image/jpeg', limits)).bytes).toEqual(identity)
  const opaque = await sharp({ create: { width: 3, height: 2, channels: 4, background: 'white' } }).png().toBuffer()
  await expect(validateEditMask(opaque, limits)).rejects.toMatchObject({ code: 'invalid-input' })
  await expect(validateEditMask(identity, limits)).rejects.toMatchObject({ code: 'invalid-input' })
  await expect(validateEditMask(Buffer.from('broken'), limits)).rejects.toMatchObject({ code: 'invalid-input' })
  await expect(composeMaskedImage(original, opaque, original, limits)).rejects.toMatchObject({ code: 'invalid-input' })
  const transparent = await sharp({ create: { width: 3, height: 2, channels: 4, background: '#00000000' } }).png().toBuffer()
  await expect(validateEditMask(transparent, limits)).resolves.toBeUndefined()
  const transparentResult = await composeMaskedImage(transparent, transparent, transparent, limits)
  expect((await sharp(transparentResult).raw().toBuffer()).every(value => value === 0)).toBe(true)
})
