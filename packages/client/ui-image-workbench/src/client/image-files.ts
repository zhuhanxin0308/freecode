/** 浏览器原图的有界读取与下载，不改变图片编码。 */
import type { ImageImportRequest, ImageReadResult } from '../types.ts'
import { imageDataUrl } from './controller.ts'

/**
 * 有界读取用户选择的原图，不改变图片编码。
 * @param file - 用户明确选中的文件。
 * @param maxBytes - Host 发布的输入上限。
 * @returns 可提交给 Host 再校验的原始编码。
 */
export async function readImageFile(file: File, maxBytes: number): Promise<ImageImportRequest> {
  if (file.size === 0 || file.size > maxBytes || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('invalid image file')
  const mimeType = file.type as ImageImportRequest['mimeType']
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result)
      else reject(new Error('invalid file result'))
    }
    reader.onerror = () => { reject(new Error('file read failed')) }
    reader.onabort = () => { reject(new Error('file read cancelled')) }
    reader.readAsDataURL(file)
  })
  return { mimeType, dataBase64: data.slice(data.indexOf(',') + 1) }
}

/**
 * 通过浏览器下载已读取的原图。
 * @param image - 经Host校验的原图。
 * @param fileName - 下载文件名。
 */
export function downloadImage(image: ImageReadResult, fileName: string): void {
  const anchor = document.createElement('a')
  anchor.href = imageDataUrl(image)
  anchor.download = fileName
  anchor.click()
}
