/** 有界方向规范化与逐像素选区合成，不改变锁定区域。 */
import sharp from 'sharp'
import type { ImageMimeType } from '../types.ts'
import { ImageFailure } from './errors.ts'

interface Limits { maxImageBytes: number; maxImagePixels: number }
const CHANNELS = 4
const MAX_CHANNEL = 255
const MAX_WIDE_CHANNEL = 65535

function pixels(bytes: Buffer, wide: boolean): Uint8Array | Uint16Array {
  return wide ? new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / Uint16Array.BYTES_PER_ELEMENT)
    : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function checkBytes(bytes: Uint8Array, limits: Limits): void {
  if (bytes.byteLength > limits.maxImageBytes) throw new ImageFailure('too-large')
}

/**
 * 在调用付费上游前拒绝不含编辑区域的遮罩。
 * @param bytes - 已保存的遮罩 PNG。
 * @param limits - 解码资源上限。
 * @returns 遮罩可用于编辑时完成，否则抛出输入错误。
 */
export async function validateEditMask(bytes: Buffer, limits: Limits): Promise<void> {
  checkBytes(bytes, limits)
  try {
    const frame = sharp(bytes, { limitInputPixels: limits.maxImagePixels })
    if ((await frame.metadata()).format !== 'png') throw new ImageFailure('invalid-input')
    const alpha = await frame.ensureAlpha().extractChannel('alpha').raw().toBuffer()
    if (!alpha.some(value => value < MAX_CHANNEL)) throw new ImageFailure('invalid-input')
  } catch (error) { throw error instanceof ImageFailure ? error : new ImageFailure('invalid-input') }
}

/**
 * 按 EXIF 显示方向规范化导入图，避免参考图与遮罩的坐标不一致。
 * @param bytes - 用户上传的原始编码。
 * @param claimedMime - 上传时声明的编码。
 * @param limits - 解码和输出的资源上限。
 * @returns 无方向标记的图片，未旋转图片保留原始字节。
 */
export async function normalizeImageOrientation(bytes: Buffer, claimedMime: ImageMimeType, limits: Limits):
Promise<{ bytes: Buffer; mimeType: ImageMimeType }> {
  checkBytes(bytes, limits)
  try {
    const frame = sharp(bytes, { limitInputPixels: limits.maxImagePixels })
    const metadata = await frame.metadata()
    if (`image/${metadata.format}` !== claimedMime || (metadata.pages ?? 1) > 1) throw new ImageFailure('invalid-input')
    if (metadata.orientation === undefined || metadata.orientation === 1) return { bytes, mimeType: claimedMime }
    const result = await frame.autoOrient().toColourspace(metadata.depth === 'ushort' ? 'rgb16' : 'srgb').png().toBuffer()
    checkBytes(result, limits)
    return { bytes: result, mimeType: 'image/png' }
  } catch (error) { throw error instanceof ImageFailure ? error : new ImageFailure('invalid-input') }
}

/**
 * 以遮罩透明度合成编辑内容；不透明区域的 RGBA 字节原样保留。
 * @param original - 第一张参考图。
 * @param mask - 与参考图尺寸一致的 PNG，透明区域可编辑。
 * @param generated - 模型返回的完整图片，只缩放这张图。
 * @param limits - 解码和输出资源上限。
 * @returns 原图尺寸的无损 PNG。
 */
export async function composeMaskedImage(original: Buffer, mask: Buffer, generated: Buffer, limits: Limits): Promise<Buffer> {
  for (const bytes of [original, mask, generated]) checkBytes(bytes, limits)
  try {
    const options = { limitInputPixels: limits.maxImagePixels }
    const wide = (await sharp(original, options).metadata()).depth === 'ushort'
    const space = wide ? 'rgb16' : 'srgb'
    const depth = wide ? 'ushort' : 'uchar'
    const maximum = wide ? MAX_WIDE_CHANNEL : MAX_CHANNEL
    const base = await sharp(original, options).autoOrient().toColourspace(space).ensureAlpha()
      .raw({ depth }).toBuffer({ resolveWithObject: true })
    const selection = await sharp(mask, options).toColourspace(space).ensureAlpha().raw({ depth }).toBuffer({ resolveWithObject: true })
    const maskInfo = await sharp(mask, options).metadata()
    if (maskInfo.format !== 'png' || selection.info.width !== base.info.width || selection.info.height !== base.info.height
      || base.info.channels !== CHANNELS || selection.info.channels !== CHANNELS) throw new ImageFailure('invalid-input')
    const layerBytes = await sharp(generated, options).autoOrient().resize(base.info.width, base.info.height, { fit: 'fill' })
      .toColourspace(space).ensureAlpha().raw({ depth }).toBuffer()
    const basePixels = pixels(base.data, wide)
    const selectedPixels = pixels(selection.data, wide)
    const layer = pixels(layerBytes, wide)
    const result = basePixels.slice()
    let selected = false
    for (let offset = 0; offset < result.length; offset += CHANNELS) {
      const keep = selectedPixels[offset + 3] as number
      if (keep === maximum) continue
      selected = true
      const baseAlpha = (basePixels[offset + 3] as number) * keep
      const newAlpha = (layer[offset + 3] as number) * (maximum - keep)
      const total = baseAlpha + newAlpha
      for (let channel = 0; channel < 3; channel++) {
        const baseChannel = basePixels[offset + channel] as number
        const newChannel = layer[offset + channel] as number
        result[offset + channel] = total === 0 ? 0 : Math.round((baseChannel * baseAlpha + newChannel * newAlpha) / total)
      }
      result[offset + 3] = Math.round(total / maximum)
    }
    if (!selected) throw new ImageFailure('invalid-input')
    const encoded = await sharp(result, { raw: { width: base.info.width, height: base.info.height, channels: CHANNELS } })
      .toColourspace(space).png().toBuffer()
    checkBytes(encoded, limits)
    return encoded
  } catch (error) { throw error instanceof ImageFailure ? error : new ImageFailure('invalid-input') }
}
