// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MaskEditor } from '../src/client/MaskEditor.tsx'
import type { ImageAsset, ImageAssetId, ImageReadResult } from '../src/types.ts'
import { en } from '../src/client/locales.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const reference: ImageAsset = { id: 'reference' as ImageAssetId, mimeType: 'image/png', width: 1024, height: 1024, bytes: 100 }
const t = (key: keyof typeof en): string => en[key]
const source: ImageReadResult = { mimeType: 'image/png', dataBase64: 'AQID' }

function setup() {
  const arc = vi.fn<CanvasRenderingContext2D['arc']>()
  const context: Pick<CanvasRenderingContext2D, 'clearRect' | 'beginPath' | 'arc' | 'fill' | 'moveTo' | 'lineTo' | 'stroke'
    | 'fillRect' | 'drawImage' | 'lineWidth' | 'lineCap' | 'lineJoin' | 'fillStyle' | 'strokeStyle' | 'globalCompositeOperation'> = {
    clearRect: vi.fn(), beginPath: vi.fn(), arc, fill: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
    fillRect: vi.fn(), drawImage: vi.fn(), lineWidth: 0, lineCap: 'butt', lineJoin: 'miter', fillStyle: '', strokeStyle: '',
    globalCompositeOperation: 'source-over',
  }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as CanvasRenderingContext2D)
  const dimensions: number[][] = []
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, callback) {
    dimensions.push([this.width, this.height])
    callback(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }))
  })
  const read = vi.fn(async (_id: ImageAssetId): Promise<ImageReadResult | undefined> => source)
  const apply = vi.fn(async (_file: File) => true)
  const close = vi.fn()
  return { context, arc, dimensions, read, apply, close }
}

async function canvas(): Promise<HTMLCanvasElement> {
  const element = await waitFor(() => {
    const result = document.querySelector('canvas')
    expect(result).not.toBeNull()
    if (result === null) throw new Error('canvas not mounted')
    return result
  })
  element.setPointerCapture = vi.fn()
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({ x: 10, y: 20, left: 10, top: 20, right: 522, bottom: 532,
    width: 512, height: 512, toJSON: () => ({}) })
  return element
}

it('画笔按显示比例映射原图坐标，撤销和清空不改动参考图片', async () => {
  const input = setup()
  render(<MaskEditor reference={reference} initialMask={undefined} {...input} t={t} />)
  const surface = await canvas()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.applyMask }).disabled).toBe(true)
  fireEvent(surface, new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 266, clientY: 276 }))
  expect(input.context.arc).toHaveBeenCalledWith(512, 512, 32, 0, Math.PI * 2)
  fireEvent(surface, new MouseEvent('pointermove', { bubbles: true, clientX: 300, clientY: 300 }))
  fireEvent.pointerUp(surface)
  expect(input.context.lineTo).toHaveBeenCalledWith(580, 560)
  fireEvent.click(screen.getByRole('button', { name: en.undo }))
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.applyMask }).disabled).toBe(true)
  fireEvent.change(screen.getByRole('slider'), { target: { value: '50' } })
  fireEvent(surface, new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 110, clientY: 120 }))
  fireEvent.pointerCancel(surface)
  fireEvent.click(screen.getByRole('button', { name: en.applyMask }))
  await waitFor(() => { expect(input.apply).toHaveBeenCalledOnce() })
  expect(input.dimensions).toEqual([[1024, 1024]])
  expect(input.context.globalCompositeOperation).toBe('destination-out')
  expect(input.apply.mock.calls[0]?.[0].type).toBe('image/png')
  expect(input.apply.mock.calls[0]?.[0].name).toBe('edit-mask.png')
  expect(input.close).toHaveBeenCalledOnce()
  expect(input.read).toHaveBeenCalledExactlyOnceWith(reference.id)
})

it('右键和没有按下的移动不产生选区；清空和上传失败保留可恢复界面', async () => {
  const input = setup()
  input.apply.mockResolvedValue(false)
  render(<MaskEditor reference={reference} initialMask={undefined} {...input} t={t} />)
  const surface = await canvas()
  fireEvent(surface, new MouseEvent('pointerdown', { bubbles: true, button: 2, clientX: 0, clientY: 0 }))
  fireEvent(surface, new MouseEvent('pointermove', { bubbles: true, clientX: 30, clientY: 30 }))
  fireEvent.pointerUp(surface)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.applyMask }).disabled).toBe(true)
  fireEvent(surface, new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: -50, clientY: 1000 }))
  fireEvent.pointerUp(surface)
  expect(input.context.arc).toHaveBeenCalledWith(0, 1024, 32, 0, Math.PI * 2)
  fireEvent.click(screen.getByRole('button', { name: en.reset }))
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.applyMask }).disabled).toBe(true)
  fireEvent(surface, new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 40, clientY: 60 }))
  fireEvent.pointerUp(surface)
  fireEvent.click(screen.getByRole('button', { name: en.applyMask }))
  await waitFor(() => { expect(input.apply).toHaveBeenCalledOnce() })
  expect(input.close).not.toHaveBeenCalled()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.applyMask }).disabled).toBe(false)
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => { callback(null) })
  fireEvent.click(screen.getByRole('button', { name: en.applyMask }))
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', en.uploadFailed)
  expect(input.apply).toHaveBeenCalledOnce()
})

it('原图不可读和页面离开时不会提交空掩码', async () => {
  const input = setup()
  input.read.mockResolvedValue(undefined)
  const mounted = render(<MaskEditor reference={reference} initialMask={undefined} {...input} t={t} />)
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', en['error.result-unavailable'])
  expect(document.querySelector('canvas')).toBeNull()
  mounted.unmount()
  let complete: (value: ImageReadResult) => void = () => { throw new Error('pending read not created') }
  input.read.mockImplementation(() => new Promise((resolve) => { complete = resolve }))
  const pending = render(<MaskEditor reference={reference} initialMask={undefined} {...input} t={t} />)
  pending.unmount()
  await act(async () => { complete(source) })
  expect(input.apply).not.toHaveBeenCalled()
})

it('复用选区后可直接提交，解码失败显示错误且不覆盖原选区', async () => {
  const NativeImage = Image
  const images: HTMLImageElement[] = []
  vi.stubGlobal('Image', class extends NativeImage {
    constructor() { super(); images.push(this) }
  })
  const input = setup()
  const initialMask = { ...reference, id: 'mask' as ImageAssetId }
  const mounted = render(<MaskEditor reference={reference} initialMask={initialMask} {...input} t={t} />)
  await waitFor(() => { expect(images).toHaveLength(1) })
  await act(async () => { images[0]?.dispatchEvent(new Event('load')) })
  await canvas()
  fireEvent.click(screen.getByRole('button', { name: en.applyMask }))
  await waitFor(() => { expect(input.apply).toHaveBeenCalledOnce() })
  expect(input.context.drawImage).toHaveBeenCalledWith(images[0], 0, 0)
  mounted.unmount()
  render(<MaskEditor reference={reference} initialMask={initialMask} {...input} t={t} />)
  await waitFor(() => { expect(images).toHaveLength(2) })
  await act(async () => { images[1]?.dispatchEvent(new Event('error')) })
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', en.uploadFailed)
})

it('已有掩码不可读取时，不把原图当作可编辑的空选区', async () => {
  const input = setup()
  const initialMask = { ...reference, id: 'missing-mask' as ImageAssetId }
  input.read.mockImplementation(async id => id === initialMask.id ? undefined : source)
  render(<MaskEditor reference={reference} initialMask={initialMask} {...input} t={t} />)
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', en['error.result-unavailable'])
  expect(document.querySelector('canvas')).toBeNull()
  expect(input.apply).not.toHaveBeenCalled()
})

it.each(['load', 'error'])('选区身份改变后忽略旧掩码的 %s 结果', async (event) => {
  const NativeImage = Image
  const images: HTMLImageElement[] = []
  vi.stubGlobal('Image', class extends NativeImage {
    constructor() { super(); images.push(this) }
  })
  const input = setup()
  const initialMask = { ...reference, id: 'pending-mask' as ImageAssetId }
  const mounted = render(<MaskEditor reference={reference} initialMask={initialMask} {...input} t={t} />)
  await waitFor(() => { expect(images).toHaveLength(1) })
  mounted.rerender(<MaskEditor reference={reference} initialMask={undefined} {...input} t={t} />)
  await canvas()
  await act(async () => { images[0]?.dispatchEvent(new Event(event)) })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.applyMask }).disabled).toBe(true)
  expect(input.context.drawImage).not.toHaveBeenCalled()
})

it('不能创建画布上下文时保留原图并拒绝上传空白掩码', async () => {
  const input = setup()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  render(<MaskEditor reference={reference} initialMask={undefined} {...input} t={t} />)
  const surface = await canvas()
  fireEvent(surface, new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 40, clientY: 60 }))
  fireEvent.pointerUp(surface)
  fireEvent.click(screen.getByRole('button', { name: en.applyMask }))
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', en.uploadFailed)
  expect(screen.getByRole('img', { name: en.reference })).not.toBeNull()
  expect(input.apply).not.toHaveBeenCalled()
  expect(input.close).not.toHaveBeenCalled()
})

it('浏览器编码异常保留选区，用户可以再次提交', async () => {
  const input = setup()
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(() => { throw new DOMException('encode failed', 'InvalidStateError') })
  render(<MaskEditor reference={reference} initialMask={undefined} {...input} t={t} />)
  const surface = await canvas()
  fireEvent(surface, new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 40, clientY: 60 }))
  fireEvent.pointerUp(surface)
  fireEvent.click(screen.getByRole('button', { name: en.applyMask }))
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', en.uploadFailed)
  expect(input.apply).not.toHaveBeenCalled()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.applyMask }).disabled).toBe(false)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.undo }).disabled).toBe(false)
})

it('对话框离开时尚未完成编码，不再发起掩码上传', async () => {
  const input = setup()
  const encoding = Promise.withResolvers<BlobCallback>()
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => { encoding.resolve(callback) })
  const previous = render(<MaskEditor reference={reference} initialMask={undefined} {...input} t={t} />)
  const surface = await canvas()
  fireEvent(surface, new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 40, clientY: 60 }))
  fireEvent.pointerUp(surface)
  fireEvent.click(screen.getByRole('button', { name: en.applyMask }))
  const finish = await encoding.promise
  fireEvent.click(screen.getByRole('button', { name: en.close }))
  previous.unmount()
  await act(async () => { finish(new Blob(['mask'], { type: 'image/png' })) })
  expect(input.apply).not.toHaveBeenCalled()
  expect(input.close).toHaveBeenCalledOnce()
})

it.each(['accepted', 'rejected'])('旧选区上传 %s 后不关闭新的编辑器，也不写入错误状态', async (outcome) => {
  const input = setup()
  const completion = Promise.withResolvers<boolean>()
  input.apply.mockImplementation(() => completion.promise)
  const previous = render(<MaskEditor reference={reference} initialMask={undefined} {...input} t={t} />)
  const surface = await canvas()
  fireEvent(surface, new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 40, clientY: 60 }))
  fireEvent.pointerUp(surface)
  fireEvent.click(screen.getByRole('button', { name: en.applyMask }))
  await waitFor(() => { expect(input.apply).toHaveBeenCalledOnce() })
  const painted = input.arc.mock.calls.length
  fireEvent(surface, new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 80, clientY: 80 }))
  expect(input.context.arc).toHaveBeenCalledTimes(painted)
  fireEvent.click(screen.getByRole('button', { name: en.close }))
  previous.unmount()
  render(<MaskEditor reference={{ ...reference, id: 'next-reference' as ImageAssetId }} initialMask={undefined} {...input} t={t} />)
  await canvas()
  await act(async () => {
    if (outcome === 'accepted') completion.resolve(true)
    else completion.reject(new Error('upload stopped'))
  })
  expect(input.close).toHaveBeenCalledOnce()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.applyMask }).disabled).toBe(true)
})
