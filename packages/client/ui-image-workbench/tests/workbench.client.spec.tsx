// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ImageAsset, ImageAssetId, ImageCatalog, ImageJob, ImageJobId, ImageModelDescriptor } from '../src/types.ts'
import type { WorkbenchState } from '../src/client/controller.ts'
import { WorkbenchPage, type WorkbenchPageProps } from '../src/client/WorkbenchPage.tsx'
import { en } from '../src/client/locales.ts'
import { modelKey } from '../src/client/draft.ts'
import { ImageExportDialog } from '../src/client/ImageDialogs.tsx'
import { readImageFile, downloadImage } from '../src/client/image-files.ts'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ComponentProps } from 'react'
import { CreationForm } from '../src/client/CreationForm.tsx'
import { createDraft } from '../src/client/draft.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks() })
const model: ImageModelDescriptor = { ref: { source: 'platform', id: 'image-model' }, name: 'Platform image', providerName: 'free code',
  available: true, sizes: ['1024x1024', '1536x1024'], qualities: ['auto', 'high'], backgrounds: ['auto', 'transparent'], formats: ['png', 'webp'],
  optionalParameters: ['quality', 'background', 'output_format'], supportsEdit: true, supportsMask: true, maxReferenceImages: 2,
  price: { units: '10000000', unitsPerPoint: '1000000' } }
const custom: ImageModelDescriptor = { ...model, ref: { source: 'custom', provider: 'mine', id: 'image-model' }, name: 'My image', providerName: 'Mine' }
const asset: ImageAsset = { id: 'image-1' as ImageAssetId, mimeType: 'image/png', bytes: 8, width: 1024, height: 1024 }
const catalog: ImageCatalog = { models: [model, custom], platform: 'available', limits: { maxImageBytes: 1000, maxPromptLength: 100, maxBatch: 4, pollIntervalMs: 1000 } }
const t = makeTranslate(en)
function job(id: string, status: ImageJob['status'] = 'succeeded'): ImageJob {
  return { id: id as ImageJobId, createdAt: 1, updatedAt: 2, status, favorite: false, archived: false,
    request: { model: model.ref, prompt: `Prompt ${id}`, size: '1024x1024', quality: 'auto', format: 'png', background: 'auto', referenceImageIds: [] },
    images: status === 'succeeded' ? [{ ...asset, id: id as ImageAssetId }] : [] }
}
function props(changes: Partial<WorkbenchState> = {}) {
  const state: WorkbenchState = { catalog, jobs: [], workspaces: [], nextCursor: undefined, filter: 'all', search: '', loading: false, busy: false,
    error: undefined, thumbnails: {}, notice: undefined, ...changes }
  return {
    useWorkbench: (selector => selector(state)) as WorkbenchPageProps['useWorkbench'],
    activate: vi.fn(), refresh: vi.fn(async () => {}), setFilter: vi.fn(), setSearch: vi.fn(), loadMore: vi.fn(async () => {}),
    submit: vi.fn<WorkbenchPageProps['submit']>(async () => true),
    importImage: vi.fn<WorkbenchPageProps['importImage']>(async () => asset),
    describeImage: vi.fn<WorkbenchPageProps['describeImage']>(async () => asset),
    ensureThumbnail: vi.fn(async () => {}),
    readOriginal: vi.fn<WorkbenchPageProps['readOriginal']>(async () => ({ mimeType: 'image/png', dataBase64: 'AQID' })),
    favorite: vi.fn(async () => {}), archive: vi.fn(async () => {}), cancel: vi.fn(async () => {}), exportImage: vi.fn(async () => true),
    notify: vi.fn(), dismissNotice: vi.fn(), openModels: vi.fn(), openAccount: vi.fn(), t,
  } satisfies WorkbenchPageProps
}

it('选择平台或自定义图片模型并按能力提交，界面没有第二套密钥输入', async () => {
  const input = props()
  render(<WorkbenchPage {...input} />)
  expect(input.activate).toHaveBeenCalledWith(true)
  expect(screen.getByRole('button', { name: /Generate.*10 points/ })).not.toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /Generate.*10 points/ }))
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', en.promptRequired)
  expect(input.submit).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText(en.prompt), { target: { value: 'A blue sphere' } })
  fireEvent.change(screen.getByLabelText(en.model), { target: { value: modelKey(custom.ref) } })
  fireEvent.change(screen.getByLabelText(en.size), { target: { value: '1536x1024' } })
  fireEvent.change(screen.getByLabelText(en.quality), { target: { value: 'high' } })
  fireEvent.change(screen.getByLabelText(en.background), { target: { value: 'transparent' } })
  fireEvent.change(screen.getByLabelText(en.format), { target: { value: 'webp' } })
  fireEvent.change(screen.getByLabelText(en.count), { target: { value: '2' } })
  expect(screen.getByText(en.byokHint)).not.toBeNull()
  expect(document.querySelector('input[type="password"]')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: en.generate }))
  await waitFor(() => { expect(input.submit).toHaveBeenCalledExactlyOnceWith({ count: 2, request: {
    model: custom.ref, prompt: 'A blue sphere', size: '1536x1024', quality: 'high', format: 'webp', background: 'transparent', referenceImageIds: [],
  } }) })
  fireEvent.click(screen.getByRole('button', { name: en.settings }))
  expect(input.openModels).toHaveBeenCalledOnce()
})

it('首屏和缩略图等待具有可读状态，未取得模型目录时禁止提交', () => {
  const input = props({ catalog: undefined, loading: true })
  const mounted = render(<WorkbenchPage {...input} />)
  expect(screen.getByRole('status', { name: en.loading })).not.toBeNull()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.generate }).disabled).toBe(true)
  expect(screen.queryByText(en.byokHint)).toBeNull()
  const state = input.useWorkbench(value => value)
  state.catalog = catalog
  state.loading = false
  state.jobs = [job('loading-image')]
  mounted.rerender(<WorkbenchPage {...input} />)
  expect(screen.getByRole('status', { name: en.loading })).not.toBeNull()
  expect(input.ensureThumbnail).toHaveBeenCalledWith('loading-image')
})

it('新创作淘汰仍在上传的参考图，旧上传不会附加到新草稿', async () => {
  const input = props()
  const uploaded = Promise.withResolvers<ImageAsset | undefined>()
  input.importImage.mockReturnValue(uploaded.promise)
  render(<WorkbenchPage {...input} />)
  fireEvent.change(screen.getByLabelText(en.prompt), { target: { value: '旧创作' } })
  fireEvent.change(screen.getByLabelText(en.addReference), {
    target: { files: [new File(['image'], 'ref.png', { type: 'image/png' })] },
  })
  await waitFor(() => { expect(input.importImage).toHaveBeenCalledOnce() })
  fireEvent.click(screen.getByRole('button', { name: en.newCreation }))
  fireEvent.change(screen.getByLabelText(en.prompt), { target: { value: '新创作' } })
  await act(async () => { uploaded.resolve(asset) })
  expect(screen.getByLabelText<HTMLTextAreaElement>(en.prompt).value).toBe('新创作')
  expect(screen.queryByRole('button', { name: en.removeReference })).toBeNull()
})

it('复用历史参数读取期间启动新创作，迟到的历史草稿不会覆盖输入', async () => {
  const historical = job('old')
  historical.request.referenceImageIds = [asset.id]
  const input = props({ jobs: [historical] })
  const described = Promise.withResolvers<ImageAsset | undefined>()
  input.describeImage.mockReturnValue(described.promise)
  render(<WorkbenchPage {...input} />)
  fireEvent.click(screen.getByRole('button', { name: en.reuse }))
  expect(input.describeImage).toHaveBeenCalledWith(asset.id)
  fireEvent.click(screen.getByRole('button', { name: en.newCreation }))
  fireEvent.change(screen.getByLabelText(en.prompt), { target: { value: '保留正在编辑的新画面' } })
  await act(async () => { described.resolve(asset) })
  expect(screen.getByLabelText<HTMLTextAreaElement>(en.prompt).value).toBe('保留正在编辑的新画面')
  expect(screen.queryByRole('button', { name: en.removeReference })).toBeNull()
})

it('登录提示能打开账号设置，目录失败保留刷新入口', () => {
  const input = props({ catalog: { ...catalog, models: [custom], platform: 'signed-out' }, error: 'error.connection' })
  const mounted = render(<WorkbenchPage {...input} />)
  fireEvent.click(screen.getByRole('button', { name: en.accountSettings }))
  expect(input.openAccount).toHaveBeenCalledOnce()
  fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: en.refresh }))
  expect(input.refresh).toHaveBeenCalledOnce()
  mounted.unmount()
  expect(input.activate).toHaveBeenLastCalledWith(false)
})

it('上传、移除参考图和复用结果保留原图身份', async () => {
  const creation = job('previous')
  const input = props({ jobs: [creation], thumbnails: { previous: { status: 'ready', url: 'data:image/png;base64,AQID' } } })
  render(<WorkbenchPage {...input} />)
  fireEvent.change(screen.getByLabelText(en.addReference), { target: { files: [new File([new Uint8Array([1, 2, 3])], 'ref.png', { type: 'image/png' })] } })
  await waitFor(() => { expect(input.importImage).toHaveBeenCalledExactlyOnceWith({ mimeType: 'image/png', dataBase64: 'AQID' }) })
  fireEvent.click(await screen.findByRole('button', { name: en.removeReference }))
  expect(screen.queryByRole('button', { name: en.removeReference })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: en.branch }))
  expect(screen.getByRole('button', { name: en.removeReference })).not.toBeNull()
  fireEvent.change(screen.getByLabelText(en.prompt), { target: { value: 'Change to purple' } })
  fireEvent.click(screen.getByRole('button', { name: /Generate.*10 points/ }))
  await waitFor(() => { expect(input.submit).toHaveBeenCalledOnce() })
  expect(input.submit.mock.calls[0]?.[0]).toMatchObject({ request: { referenceImageIds: ['previous'], parentJobId: 'previous' } })
})

it('任务动作、分页和全历史搜索交给持久任务拥有者，原图预览与对比能关闭', async () => {
  const first = job('first'), second = job('second'), queued = job('queued', 'queued')
  const input = props({ jobs: [first, second, queued], nextCursor: 'next' as ImageJobId,
    thumbnails: { first: { status: 'ready', url: 'data:image/png;base64,AQID' }, second: { status: 'ready', url: 'data:image/png;base64,AQID' } } })
  render(<WorkbenchPage {...input} />)
  fireEvent.click(screen.getAllByRole('button', { name: en.favorite })[0]!)
  expect(input.favorite).toHaveBeenCalledWith(first)
  fireEvent.click(screen.getAllByRole('button', { name: en.archive })[0]!)
  expect(input.archive).toHaveBeenCalledWith(first)
  fireEvent.click(screen.getByRole('button', { name: en.cancel }))
  expect(input.cancel).toHaveBeenCalledWith(queued.id)
  fireEvent.click(screen.getByRole('button', { name: en.more }))
  expect(input.loadMore).toHaveBeenCalledOnce()
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'older work' } })
  expect(input.setSearch).toHaveBeenCalledWith('older work')
  fireEvent.click(screen.getByRole('button', { name: en.active }))
  expect(input.setFilter).toHaveBeenCalledWith('active')
  fireEvent.click(screen.getAllByRole('button', { name: en.selectCompare })[0]!)
  fireEvent.click(screen.getByRole('button', { name: en.selectCompare }))
  fireEvent.click(screen.getByRole('button', { name: /Compare images \(2\/2\)/ }))
  expect(await screen.findByRole('dialog', { name: en.compare })).not.toBeNull()
  await waitFor(() => { expect(input.readOriginal).toHaveBeenCalledTimes(2) })
  fireEvent.click(screen.getByRole('button', { name: en.close }))
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('缩略图失败可单独重试且没有嵌套按钮，失败结果不宣称继续生成', () => {
  const input = props({ jobs: [job('failed-thumb'), job('cancelled', 'cancelled')], thumbnails: { 'failed-thumb': { status: 'failed' } } })
  render(<WorkbenchPage {...input} />)
  const article = document.querySelector('[data-image-job="failed-thumb"]')!
  fireEvent.click(within(article as HTMLElement).getByRole('button', { name: en.refresh }))
  expect(input.ensureThumbnail).toHaveBeenCalledWith('failed-thumb', true)
  expect(document.querySelector('button button')).toBeNull()
  expect(screen.queryByText(en.pendingDescription)).toBeNull()
})

it('导出只提交所选工作区和文件名，失败保留输入供修复', async () => {
  const save = vi.fn(async () => false)
  const close = vi.fn()
  render(<ImageExportDialog asset={asset} workspaces={[{ id: 'work' as WorkspaceId, name: 'Project' }]} save={save} close={close} t={t} />)
  fireEvent.change(screen.getByLabelText(en.filename), { target: { value: '  final.png  ' } })
  fireEvent.click(screen.getByRole('button', { name: en.export }))
  await waitFor(() => { expect(save).toHaveBeenCalledExactlyOnceWith(asset.id, { workspaceId: 'work', fileName: 'final.png' }) })
  expect(close).not.toHaveBeenCalled()
  expect(screen.getByLabelText<HTMLInputElement>(en.filename).value).toBe('  final.png  ')
  save.mockResolvedValue(true)
  fireEvent.click(screen.getByRole('button', { name: en.export }))
  await waitFor(() => { expect(close).toHaveBeenCalledOnce() })
})

it('本机文件大小和类型受限，下载保留原编码', async () => {
  await expect(readImageFile(new File([], 'empty.png', { type: 'image/png' }), 10)).rejects.toThrow()
  await expect(readImageFile(new File(['x'], 'wrong.svg', { type: 'image/svg+xml' }), 10)).rejects.toThrow()
  await expect(readImageFile(new File(['xx'], 'large.png', { type: 'image/png' }), 1)).rejects.toThrow()
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    expect(this.download).toBe('original.png'); expect(this.href).toBe('data:image/png;base64,AQID')
  })
  downloadImage({ mimeType: 'image/png', dataBase64: 'AQID' }, 'original.png')
  expect(click).toHaveBeenCalledOnce()
})

it('目录刷新保留已选择的模型和提示词，失效模型不会被悄悄替换成平台模型', () => {
  const input = props()
  const mounted = render(<WorkbenchPage {...input} />)
  fireEvent.change(screen.getByLabelText(en.model), { target: { value: modelKey(custom.ref) } })
  fireEvent.change(screen.getByLabelText(en.prompt), { target: { value: '保留自定义创作' } })
  const state = input.useWorkbench(value => value)
  state.catalog = { ...catalog, models: [model] }
  mounted.rerender(<WorkbenchPage {...input} />)
  expect(screen.getByLabelText<HTMLTextAreaElement>(en.prompt).value).toBe('保留自定义创作')
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.generate }).disabled).toBe(true)
  state.catalog = { ...catalog, platform: 'unavailable', models: [] }
  mounted.rerender(<WorkbenchPage {...input} />)
  expect(screen.getByText(en.platformUnavailable)).not.toBeNull()
  expect(screen.getByText(en.noModels)).not.toBeNull()
  fireEvent.change(screen.getByLabelText(en.model), { target: { value: '' } })
  state.catalog = catalog
  mounted.rerender(<WorkbenchPage {...input} />)
  expect(screen.getByLabelText<HTMLSelectElement>(en.model).value).toBe(modelKey(model.ref))
  expect(screen.getByLabelText<HTMLTextAreaElement>(en.prompt).value).toBe('保留自定义创作')
  fireEvent.click(screen.getByRole('button', { name: en.refresh }))
  expect(input.refresh).toHaveBeenCalledOnce()
})

it('上传批量先检查数量，去重同一原图并保留文件失败后的草稿', async () => {
  const input = props()
  render(<WorkbenchPage {...input} />)
  const file = new File(['image'], 'ref.png', { type: 'image/png' })
  const field = screen.getByLabelText(en.addReference)
  fireEvent.change(field, { target: { files: [file, file, file] } })
  expect(screen.getByRole('alert').textContent).toBe(en.referencesTooMany)
  expect(input.importImage).not.toHaveBeenCalled()
  fireEvent.change(field, { target: { files: [file, file] } })
  await waitFor(() => { expect(input.importImage).toHaveBeenCalledTimes(2) })
  expect(screen.getAllByRole('button', { name: en.removeReference })).toHaveLength(1)
  fireEvent.change(screen.getByLabelText(en.prompt), { target: { value: '保留输入' } })
  input.importImage.mockResolvedValueOnce(undefined)
  fireEvent.change(field, { target: { files: [file] } })
  await waitFor(() => { expect(input.importImage).toHaveBeenCalledTimes(3) })
  expect(screen.getAllByRole('button', { name: en.removeReference })).toHaveLength(1)
  fireEvent.change(field, { target: { files: [new File(['svg'], 'bad.svg', { type: 'image/svg+xml' })] } })
  await waitFor(() => { expect(input.notify).toHaveBeenCalledWith('uploadFailed') })
  expect(screen.getByLabelText<HTMLTextAreaElement>(en.prompt).value).toBe('保留输入')
})

it('文件选择取消和拖入都复用同一上传入口，忙碌或不支持编辑时不接收拖入文件', async () => {
  const input = props()
  const mounted = render(<WorkbenchPage {...input} />)
  const file = new File(['image'], 'ref.png', { type: 'image/png' })
  const field = screen.getByLabelText<HTMLInputElement>(en.addReference)
  const open = vi.spyOn(field, 'click').mockImplementation(() => {})
  fireEvent.click(screen.getByRole('button', { name: en.addReference }))
  expect(open).toHaveBeenCalledOnce()
  fireEvent.change(field, { target: { files: null } })
  expect(input.importImage).not.toHaveBeenCalled()
  const region = screen.getByRole('group', { name: en.reference })
  fireEvent.dragOver(region)
  fireEvent.drop(region, { dataTransfer: { files: [file] } })
  await waitFor(() => { expect(input.importImage).toHaveBeenCalledOnce() })
  const state = input.useWorkbench(value => value)
  state.busy = true
  mounted.rerender(<WorkbenchPage {...input} />)
  fireEvent.drop(region, { dataTransfer: { files: [file] } })
  state.busy = false
  state.catalog = { ...catalog, models: [{ ...model, supportsEdit: false, supportsMask: false, maxReferenceImages: 0 }] }
  mounted.rerender(<WorkbenchPage {...input} />)
  fireEvent.drop(region, { dataTransfer: { files: [file] } })
  expect(input.importImage).toHaveBeenCalledOnce()
  fireEvent.change(screen.getByLabelText(en.prompt), { target: { value: '仍有参考图' } })
  fireEvent.click(screen.getByRole('button', { name: /Generate.*10 points/ }))
  expect(screen.getByRole('alert').textContent).toBe(en.referenceUnsupported)
})

it('复用历史参考图与选区后可切换提供商，移除次要参考图仍保留第一张的选区', async () => {
  const first = { ...asset, id: 'ref-first' as ImageAssetId }
  const second = { ...asset, id: 'ref-second' as ImageAssetId }
  const mask = { ...asset, id: 'mask' as ImageAssetId }
  const previous = job('with-mask')
  previous.request.referenceImageIds = [first.id, second.id]
  previous.request.maskImageId = mask.id
  const input = props({ jobs: [previous] })
  input.describeImage.mockImplementation(async id => [first, second, mask].find(image => image.id === id))
  render(<WorkbenchPage {...input} />)
  fireEvent.click(screen.getByRole('button', { name: en.reuse }))
  expect(await screen.findByText(en.maskApplied)).not.toBeNull()
  expect(screen.getByLabelText<HTMLTextAreaElement>(en.prompt).value).toBe(previous.request.prompt)
  fireEvent.click(screen.getAllByRole('button', { name: en.removeReference })[1]!)
  expect(screen.getByText(en.maskApplied)).not.toBeNull()
  fireEvent.change(screen.getByLabelText(en.model), { target: { value: modelKey(custom.ref) } })
  fireEvent.click(screen.getByRole('button', { name: en.generate }))
  await waitFor(() => { expect(input.submit).toHaveBeenCalledOnce() })
  expect(input.submit.mock.calls[0]?.[0]).toMatchObject({ request: {
    model: custom.ref, referenceImageIds: [first.id], maskImageId: mask.id, parentJobId: previous.id,
  } })
  fireEvent.click(screen.getByRole('button', { name: en.clearMask }))
  expect(screen.queryByText(en.maskApplied)).toBeNull()
})

it('复用缺失的参考图或选区时不覆盖草稿，移除第一参考图同步移除选区', async () => {
  const previous = job('missing-input')
  previous.request.referenceImageIds = [asset.id]
  previous.request.maskImageId = 'mask' as ImageAssetId
  const input = props({ jobs: [previous] })
  input.describeImage.mockResolvedValueOnce(undefined)
  render(<WorkbenchPage {...input} />)
  fireEvent.change(screen.getByLabelText(en.prompt), { target: { value: '不能丢失的草稿' } })
  fireEvent.click(screen.getByRole('button', { name: en.reuse }))
  await act(async () => {})
  expect(screen.getByLabelText<HTMLTextAreaElement>(en.prompt).value).toBe('不能丢失的草稿')
  input.describeImage.mockResolvedValueOnce(asset).mockResolvedValueOnce(undefined)
  fireEvent.click(screen.getByRole('button', { name: en.reuse }))
  await waitFor(() => { expect(input.describeImage).toHaveBeenCalledTimes(3) })
  expect(screen.getByLabelText<HTMLTextAreaElement>(en.prompt).value).toBe('不能丢失的草稿')
  input.describeImage.mockResolvedValueOnce(asset).mockResolvedValueOnce({ ...asset, id: 'mask' as ImageAssetId })
  fireEvent.click(screen.getByRole('button', { name: en.reuse }))
  await screen.findByText(en.maskApplied)
  fireEvent.click(screen.getByRole('button', { name: en.removeReference }))
  expect(screen.queryByText(en.maskApplied)).toBeNull()
  expect(screen.queryByRole('button', { name: en.editMask })).toBeNull()
})

it('旧选区信息迟到时不能覆盖后来输入，页面离开后也不能替换草稿', async () => {
  const previous = job('slow-mask')
  previous.request.maskImageId = 'mask' as ImageAssetId
  const input = props({ jobs: [previous] })
  const late = Promise.withResolvers<ImageAsset | undefined>()
  input.describeImage.mockReturnValue(late.promise)
  const mounted = render(<WorkbenchPage {...input} />)
  fireEvent.click(screen.getByRole('button', { name: en.reuse }))
  await waitFor(() => { expect(input.describeImage).toHaveBeenCalledOnce() })
  fireEvent.change(screen.getByLabelText(en.prompt), { target: { value: '新的提示词' } })
  await act(async () => { late.resolve({ ...asset, id: 'mask' as ImageAssetId }) })
  expect(screen.getByLabelText<HTMLTextAreaElement>(en.prompt).value).toBe('新的提示词')
  fireEvent.click(screen.getByRole('button', { name: en.reuse }))
  mounted.unmount()
  await act(async () => {})
  expect(input.activate).toHaveBeenLastCalledWith(false)
})

it('作品预览、原图下载和导出使用原始资源，下载失败不会宣称成功', async () => {
  const created = job('download')
  const input = props({ jobs: [created], thumbnails: { download: { status: 'ready', url: 'data:image/png;base64,AQID' } },
    workspaces: [{ id: 'work' as WorkspaceId, name: 'Project' }] })
  render(<WorkbenchPage {...input} />)
  fireEvent.click(screen.getByRole('button', { name: en.view }))
  expect(await screen.findByRole('dialog', { name: en.imagePreview })).not.toBeNull()
  fireEvent.click(screen.getByRole('button', { name: en.close }))
  const download = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    expect(this.download).toBe('free-code-download.png')
    expect(this.href).toBe('data:image/png;base64,AQID')
  })
  fireEvent.click(screen.getByRole('button', { name: en.download }))
  await waitFor(() => { expect(input.notify).toHaveBeenCalledWith('downloaded') })
  expect(download).toHaveBeenCalledOnce()
  input.readOriginal.mockResolvedValueOnce(undefined)
  input.notify.mockClear()
  fireEvent.click(screen.getByRole('button', { name: en.download }))
  await act(async () => {})
  expect(download).toHaveBeenCalledOnce()
  expect(input.notify).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: en.exported }))
  expect(await screen.findByRole('dialog', { name: en.exported })).not.toBeNull()
  fireEvent.click(screen.getByRole('button', { name: en.close }))
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('收藏和归档状态清晰区分，等待核实不能提示重新生成，比较最多保留两张', () => {
  const saved = { ...job('saved'), favorite: true, archived: true, request: { ...job('saved').request, model: custom.ref } }
  const pending = { ...job('uncertain', 'uncertain'), error: { code: 'upstream-unavailable' as const } }
  const failed = { ...job('rejected', 'failed'), error: { code: 'upstream-rejected' as const } }
  const running = job('running', 'running')
  const input = props({ jobs: [saved, job('second'), job('third'), pending, failed, running] })
  render(<WorkbenchPage {...input} />)
  expect(screen.getByText(en.sourceCustom)).not.toBeNull()
  expect(screen.getByText(en.unknownDescription)).not.toBeNull()
  expect(screen.getByText(en['error.upstream-rejected'])).not.toBeNull()
  expect(screen.queryByText(en['error.upstream-unavailable'])).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: en.unfavorite }))
  expect(input.favorite).toHaveBeenCalledWith(saved)
  fireEvent.click(screen.getByRole('button', { name: en.restore }))
  expect(input.archive).toHaveBeenCalledWith(saved)
  fireEvent.click(screen.getAllByRole('button', { name: en.selectCompare })[0]!)
  fireEvent.click(screen.getAllByRole('button', { name: en.selectCompare })[0]!)
  fireEvent.click(screen.getByRole('button', { name: en.selectCompare }))
  expect(screen.getAllByRole('button', { name: en.removeCompare })).toHaveLength(2)
  fireEvent.click(screen.getAllByRole('button', { name: en.removeCompare })[0]!)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: /Compare images \(1\/2\)/ }).disabled).toBe(true)
})

it('空筛选和搜索给出空结果，单选能力与已失效模型不能提交', () => {
  const unavailable: ImageModelDescriptor = { ...model, available: false, qualities: ['standard'], backgrounds: ['auto'], formats: ['png'] }
  const formProps: ComponentProps<typeof CreationForm> = {
    draft: createDraft(unavailable), model: unavailable, catalog: { ...catalog, models: [unavailable] }, busy: false,
    error: undefined, images: {}, change: vi.fn(), chooseModel: vi.fn(), files: vi.fn(async () => {}),
    ensureThumbnail: vi.fn(async () => {}), mask: vi.fn(), generate: vi.fn(async () => {}), openModels: vi.fn(), openAccount: vi.fn(), t,
  }
  const mounted = render(<CreationForm {...formProps} />)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: /Generate.*10 points/ }).disabled).toBe(true)
  expect(screen.getByLabelText<HTMLSelectElement>(en.quality).disabled).toBe(true)
  expect(screen.getByLabelText<HTMLSelectElement>(en.background).disabled).toBe(true)
  expect(screen.getByLabelText<HTMLSelectElement>(en.format).disabled).toBe(true)
  expect(screen.getByRole('option', { name: 'STANDARD' })).not.toBeNull()
  mounted.unmount()
  const input = props({ filter: 'favorites', jobs: [] })
  const page = render(<WorkbenchPage {...input} />)
  expect(screen.getByRole('heading', { name: en.emptyFiltered })).not.toBeNull()
  const state = input.useWorkbench(value => value)
  state.filter = 'all'; state.search = 'missing'
  page.rerender(<WorkbenchPage {...input} />)
  expect(screen.getByRole('heading', { name: en.emptyFiltered })).not.toBeNull()
})

function maskCanvas() {
  const context: Pick<CanvasRenderingContext2D, 'clearRect' | 'beginPath' | 'arc' | 'fill' | 'moveTo' | 'lineTo' | 'stroke'
    | 'fillRect' | 'drawImage' | 'lineWidth' | 'lineCap' | 'lineJoin' | 'fillStyle' | 'strokeStyle' | 'globalCompositeOperation'> = {
    clearRect: vi.fn(), beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
    fillRect: vi.fn(), drawImage: vi.fn(), lineWidth: 0, lineCap: 'round', lineJoin: 'round', fillStyle: '', strokeStyle: '',
    globalCompositeOperation: 'source-over',
  }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as CanvasRenderingContext2D)
  return vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => {
    callback(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }))
  })
}

async function paintMask() {
  fireEvent.click(screen.getByRole('button', { name: en.editMask }))
  const surface = await waitFor(() => {
    const canvas = document.querySelector('canvas')
    if (canvas === null) throw new Error('等待参考图加载')
    return canvas
  })
  surface.setPointerCapture = vi.fn()
  vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 512, bottom: 512,
    width: 512, height: 512, toJSON: () => ({}) })
  fireEvent(surface, new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 100, clientY: 100 }))
  fireEvent.pointerUp(surface)
}

it('工作台局部修改保存原图尺寸选区，切换模型保留参数且可主动移除选区', async () => {
  maskCanvas()
  const input = props({ jobs: [job('original')] })
  const mask = { ...asset, id: 'mask' as ImageAssetId }
  input.importImage.mockResolvedValue(mask)
  render(<WorkbenchPage {...input} />)
  fireEvent.click(screen.getByRole('button', { name: en.branch }))
  await paintMask()
  fireEvent.click(screen.getByRole('button', { name: en.applyMask }))
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  expect(screen.getByText(en.maskApplied)).not.toBeNull()
  fireEvent.change(screen.getByLabelText(en.model), { target: { value: modelKey(custom.ref) } })
  fireEvent.change(screen.getByLabelText(en.prompt), { target: { value: '修改局部区域' } })
  fireEvent.click(screen.getByRole('button', { name: en.generate }))
  await waitFor(() => { expect(input.submit).toHaveBeenCalledOnce() })
  expect(input.submit.mock.calls[0]?.[0]).toMatchObject({ request: { maskImageId: mask.id,
    parentJobId: 'original', referenceImageIds: ['original'], model: custom.ref } })
  fireEvent.click(screen.getByRole('button', { name: en.clearMask }))
  expect(screen.queryByText(en.maskApplied)).toBeNull()
})

it('掩码过大或导入失败保留编辑器，关闭后的迟到保存不能污染新创作', async () => {
  const encoding = maskCanvas()
  const input = props({ jobs: [job('original')] })
  render(<WorkbenchPage {...input} />)
  fireEvent.click(screen.getByRole('button', { name: en.branch }))
  await paintMask()
  encoding.mockImplementationOnce((callback) => { callback(new Blob([new Uint8Array(1001)], { type: 'image/png' })) })
  fireEvent.click(screen.getByRole('button', { name: en.applyMask }))
  await waitFor(() => { expect(input.notify).toHaveBeenCalledWith('uploadFailed') })
  expect(input.importImage).not.toHaveBeenCalled()
  input.importImage.mockResolvedValueOnce(undefined)
  fireEvent.click(screen.getByRole('button', { name: en.applyMask }))
  await waitFor(() => { expect(input.importImage).toHaveBeenCalledOnce() })
  await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>('button', { name: en.applyMask }).disabled).toBe(false) })
  const pending = Promise.withResolvers<ImageAsset>()
  input.importImage.mockReturnValueOnce(pending.promise)
  fireEvent.click(screen.getByRole('button', { name: en.applyMask }))
  await waitFor(() => { expect(input.importImage).toHaveBeenCalledTimes(2) })
  fireEvent.click(screen.getByRole('button', { name: en.close }))
  fireEvent.click(screen.getByRole('button', { name: en.newCreation }))
  fireEvent.change(screen.getByLabelText(en.prompt), { target: { value: '新的创作' } })
  await act(async () => { pending.resolve({ ...asset, id: 'late-mask' as ImageAssetId }) })
  expect(screen.queryByText(en.maskApplied)).toBeNull()
  expect(screen.getByLabelText<HTMLTextAreaElement>(en.prompt).value).toBe('新的创作')
})

it('模型能力变化后下拉框的空选项不会写入无效背景或格式', () => {
  const change = vi.fn()
  render(<CreationForm draft={createDraft(model)} model={model} catalog={catalog} busy={false} error={undefined} images={{}}
    change={change} chooseModel={vi.fn()} files={undefined} ensureThumbnail={vi.fn(async () => {})} mask={vi.fn()}
    generate={vi.fn(async () => {})} openModels={vi.fn()} openAccount={vi.fn()} t={t} />)
  fireEvent.change(screen.getByLabelText(en.background), { target: { value: '' } })
  fireEvent.change(screen.getByLabelText(en.format), { target: { value: '' } })
  expect(change).not.toHaveBeenCalled()
})

it('文件尚在浏览器读取时新建创作，不再把旧文件送往Host', async () => {
  // oxlint-disable-next-line typescript/unbound-method -- 下方用 original.call(this, file) 恢复同一个读取器。
  const original = FileReader.prototype.readAsDataURL
  let resume: (() => void) | undefined
  vi.spyOn(FileReader.prototype, 'readAsDataURL').mockImplementationOnce(function (this: FileReader, file) {
    resume = () => { original.call(this, file) }
  })
  const input = props()
  render(<WorkbenchPage {...input} />)
  fireEvent.change(screen.getByLabelText(en.addReference), {
    target: { files: [new File(['old-image'], 'old.png', { type: 'image/png' })] },
  })
  fireEvent.click(screen.getByRole('button', { name: en.newCreation }))
  if (resume === undefined) throw new Error('文件读取尚未开始')
  const finishRead = resume
  await act(async () => { finishRead() })
  await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>('button', { name: en.addReference }).disabled).toBe(false) })
  expect(input.importImage).not.toHaveBeenCalled()
})

it('复用无参考图的任务只带回参数与父任务，不引入选区或原图', async () => {
  const previous = job('plain')
  const input = props({ jobs: [previous] })
  render(<WorkbenchPage {...input} />)
  fireEvent.click(screen.getByRole('button', { name: en.reuse }))
  await waitFor(() => { expect(screen.getByLabelText<HTMLTextAreaElement>(en.prompt).value).toBe(previous.request.prompt) })
  expect(input.describeImage).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: /Generate.*10 points/ }))
  await waitFor(() => { expect(input.submit).toHaveBeenCalledOnce() })
  expect(input.submit.mock.calls[0]?.[0].request.referenceImageIds).toEqual([])
  expect(input.submit.mock.calls[0]?.[0].request).not.toHaveProperty('maskImageId')
})
