// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { ImageAsset, ImageAssetId, ImageJob, ImageJobId, ImageReadResult } from '../src/types.ts'
import { ImageExportDialog, ImagePreviewDialog, OriginalImage } from '../src/client/ImageDialogs.tsx'
import { en } from '../src/client/locales.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const t = (key: keyof typeof en): string => en[key]
const first: ImageAsset = { id: 'first' as ImageAssetId, mimeType: 'image/png', width: 1536, height: 1024, bytes: 10 }
const second: ImageAsset = { ...first, id: 'second' as ImageAssetId, mimeType: 'image/jpeg' }
const source: ImageReadResult = { mimeType: 'image/png', dataBase64: 'AQID' }
const workspaceA = { id: 'a' as WorkspaceId, name: 'Project A' }
const workspaceB = { id: 'b' as WorkspaceId, name: 'Project B' }

it('原图读取失败可在下一次图片选择恢复，旧读取不会覆盖新结果', async () => {
  const previous = Promise.withResolvers<ImageReadResult | undefined>()
  const current = Promise.withResolvers<ImageReadResult | undefined>()
  const read = vi.fn((id: ImageAssetId) => id === first.id ? previous.promise : current.promise)
  const mounted = render(<OriginalImage asset={first} read={read} t={t} />)
  expect(screen.getByLabelText(en.loading)).not.toBeNull()
  mounted.rerender(<OriginalImage asset={second} read={read} t={t} />)
  await act(async () => { current.resolve(undefined) })
  expect(screen.getByRole('status')).toHaveProperty('textContent', en['error.result-unavailable'])
  await act(async () => { previous.resolve(source) })
  expect(screen.queryByRole('img')).toBeNull()
  read.mockResolvedValue({ mimeType: 'image/webp', dataBase64: 'BAUG' })
  mounted.rerender(<OriginalImage asset={first} read={read} t={t} />)
  expect(await screen.findByRole('img', { name: en.original })).toHaveProperty('src', 'data:image/webp;base64,BAUG')
  expect(screen.queryByRole('status')).toBeNull()
})

it('预览离开后完成读取，不会重新挂载已关闭图片', async () => {
  const pending = Promise.withResolvers<ImageReadResult | undefined>()
  const read = vi.fn(() => pending.promise)
  const mounted = render(<OriginalImage asset={first} read={read} t={t} />)
  mounted.unmount()
  await act(async () => { pending.resolve(source) })
  expect(screen.queryByRole('img')).toBeNull()
  expect(read).toHaveBeenCalledExactlyOnceWith(first.id)
})

it('单项预览保留提示词和生成参数，无原图的记录不尝试读取空资源', () => {
  const job: ImageJob = { id: 'failed' as ImageJobId, status: 'failed', createdAt: 1, updatedAt: 2, favorite: false, archived: false, images: [],
    request: { model: { source: 'platform', id: 'image-model' }, prompt: 'Original prompt', size: '1536x1024', quality: 'high', background: 'auto', format: 'png', referenceImageIds: [] } }
  const read = vi.fn(async () => source)
  const close = vi.fn()
  render(<ImagePreviewDialog jobs={[job]} read={read} close={close} t={t} />)
  expect(screen.getByRole('dialog', { name: en.imagePreview })).not.toBeNull()
  for (const text of ['Original prompt', 'image-model', '1536x1024', 'high']) expect(screen.getByText(text)).not.toBeNull()
  expect(read).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: en.close }))
  expect(close).toHaveBeenCalledOnce()
})

it('没有工作区时说明下一步且不提供无效导出操作', () => {
  const save = vi.fn(async () => true), close = vi.fn()
  render(<ImageExportDialog asset={first} workspaces={[]} save={save} close={close} t={t} />)
  expect(screen.getByRole('status')).toHaveProperty('textContent', en.noWorkspaces)
  expect(screen.queryByRole('button', { name: en.export })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: en.close }))
  expect(close).toHaveBeenCalledOnce()
  expect(save).not.toHaveBeenCalled()
})

it('工作区选择和文件名校验产生明确目标，保存期间只提交一次', async () => {
  const pending = Promise.withResolvers<boolean>()
  const save = vi.fn(() => pending.promise), close = vi.fn()
  render(<ImageExportDialog asset={second} workspaces={[workspaceA, workspaceB]} save={save} close={close} t={t} />)
  expect(screen.getByLabelText<HTMLInputElement>(en.filename).value).toBe('free-code-image.jpeg')
  fireEvent.change(screen.getByLabelText(en.filename), { target: { value: '  ' } })
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.export }).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: en.export }))
  expect(save).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText(en.workspace), { target: { value: workspaceB.id } })
  fireEvent.change(screen.getByLabelText(en.filename), { target: { value: ' final.jpeg ' } })
  fireEvent.click(screen.getByRole('button', { name: en.export }))
  expect(save).toHaveBeenCalledExactlyOnceWith(second.id, { workspaceId: workspaceB.id, fileName: 'final.jpeg' })
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.export }).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: en.export }))
  expect(save).toHaveBeenCalledOnce()
  await act(async () => { pending.resolve(false) })
  await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>('button', { name: en.export }).disabled).toBe(false) })
  expect(close).not.toHaveBeenCalled()
  expect(screen.getByLabelText<HTMLInputElement>(en.filename).value).toBe(' final.jpeg ')
})

it('已选择的工作区被移除时，不会把原图写到其它目录', () => {
  const save = vi.fn(async () => true), close = vi.fn()
  const mounted = render(<ImageExportDialog asset={first} workspaces={[workspaceA, workspaceB]} save={save} close={close} t={t} />)
  mounted.rerender(<ImageExportDialog asset={first} workspaces={[workspaceB]} save={save} close={close} t={t} />)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.export }).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: en.export }))
  expect(save).not.toHaveBeenCalled()
})

it('离开的导出操作完成后，不会关闭随后打开的对话框', async () => {
  const pending = Promise.withResolvers<boolean>()
  const save = vi.fn(() => pending.promise), close = vi.fn()
  const previous = render(<ImageExportDialog asset={first} workspaces={[workspaceA]} save={save} close={close} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: en.export }))
  expect(save).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: en.close }))
  previous.unmount()
  render(<ImageExportDialog asset={second} workspaces={[workspaceB]} save={vi.fn(async () => true)} close={close} t={t} />)
  await act(async () => { pending.resolve(true) })
  expect(close).toHaveBeenCalledOnce()
  expect(screen.getByLabelText<HTMLInputElement>(en.filename).value).toBe('free-code-image.jpeg')
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.export }).disabled).toBe(false)
})
