// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { downloadImage, readImageFile } from '../src/client/image-files.ts'

afterEach(() => { vi.restoreAllMocks() })

it.each(['image/png', 'image/jpeg', 'image/webp'] as const)('读取 %s 的原始字节，不因文件扩展名改变编码', async (mimeType) => {
  const file = new File([new Uint8Array([1, 2, 3])], 'selected-image.bin', { type: mimeType })
  await expect(readImageFile(file, file.size)).resolves.toEqual({ mimeType, dataBase64: 'AQID' })
  await expect(readImageFile(file, file.size - 1)).rejects.toThrow('invalid image file')
})

it.each([
  ['error', 'file read failed'],
  ['abort', 'file read cancelled'],
] as const)('文件读取发生 %s 时向调用方报告失败，不返回残缺图片', async (event, message) => {
  vi.spyOn(FileReader.prototype, 'readAsDataURL').mockImplementation(function (this: FileReader) {
    this.dispatchEvent(new ProgressEvent(event))
  })
  await expect(readImageFile(new File(['image'], 'input.png', { type: 'image/png' }), 5)).rejects.toThrow(message)
})

it('浏览器读取结果不是数据地址时拒绝继续导入', async () => {
  vi.spyOn(FileReader.prototype, 'readAsDataURL').mockImplementation(function (this: FileReader) {
    Object.defineProperty(this, 'result', { configurable: true, value: new ArrayBuffer(3) })
    this.dispatchEvent(new ProgressEvent('load'))
  })
  await expect(readImageFile(new File(['png'], 'input.png', { type: 'image/png' }), 3)).rejects.toThrow('invalid file result')
})

it('下载使用指定文件名和完整原图数据，不留下页面节点', () => {
  const parentCount = document.body.childElementCount
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    expect(this.href).toBe('data:image/webp;base64,AQID')
    expect(this.download).toBe('我的原图.webp')
  })
  downloadImage({ mimeType: 'image/webp', dataBase64: 'AQID' }, '我的原图.webp')
  expect(click).toHaveBeenCalledOnce()
  expect(document.body.childElementCount).toBe(parentCount)
})
