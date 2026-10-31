import { expect, it } from 'vitest'
import type { ImageAsset, ImageAssetId, ImageCatalog, ImageJobId, ImageModelDescriptor } from '../src/types.ts'
import { createDraft, estimatePoints, modelKey, requestFromDraft } from '../src/client/draft.ts'

const model: ImageModelDescriptor = { ref: { source: 'platform', id: 'image-model' }, name: 'Image Model', providerName: 'free code',
  available: true, sizes: ['1024x1024'], qualities: ['auto', 'high'], backgrounds: ['auto', 'transparent'], formats: ['png'],
  optionalParameters: ['quality', 'background'], supportsEdit: true, supportsMask: true, maxReferenceImages: 2,
  price: { units: '10000000', unitsPerPoint: '1000000' } }
const limits: ImageCatalog['limits'] = { maxImageBytes: 1024, maxPromptLength: 40, maxBatch: 4, pollIntervalMs: 1000 }

it('按来源和提供商区分重名模型，费用保持整数积分精度', () => {
  expect(modelKey(model.ref)).not.toBe(modelKey({ source: 'custom', provider: 'mine', id: 'image-model' }))
  expect(modelKey({ source: 'custom', provider: 'a', id: 'same' })).not.toBe(modelKey({ source: 'custom', provider: 'b', id: 'same' }))
  expect(estimatePoints(model, 3)).toBe('30')
  expect(estimatePoints({ ...model, ref: { source: 'custom', provider: 'mine', id: 'image-model' } }, 3)).toBeUndefined()
})

it('按模型能力构造请求，不把其他模型的选项带过去', () => {
  const draft = createDraft(model)
  draft.prompt = '  蓝色玻璃球  '
  expect(requestFromDraft(draft, model, limits)).toMatchObject({ ok: true, value: { count: 1, request: {
    prompt: '蓝色玻璃球', size: '1024x1024', quality: 'auto', format: 'png', referenceImageIds: [],
  } } })
  draft.size = '4096x4096'
  expect(requestFromDraft(draft, model, limits)).toEqual({ ok: false, error: 'unsupportedOptions' })
})

it.each([
  { prompt: '', count: 1, error: 'promptRequired' },
  { prompt: '字'.repeat(41), count: 1, error: 'promptLong' },
  { prompt: '生成', count: 0, error: 'countInvalid' },
  { prompt: '生成', count: 5, error: 'countInvalid' },
])('提交前拦截无效草稿 $error', ({ prompt, count, error }) => {
  expect(requestFromDraft({ ...createDraft(model), prompt, count }, model, limits)).toEqual({ ok: false, error })
})

it('不存在或不可用的模型不能提交，草稿原文不被清除', () => {
  const draft = { ...createDraft(model), prompt: '保留我的提示词' }
  expect(requestFromDraft(draft, undefined, limits)).toEqual({ ok: false, error: 'modelRequired' })
  expect(requestFromDraft(draft, { ...model, available: false }, limits)).toEqual({ ok: false, error: 'modelUnavailable' })
  expect(draft.prompt).toBe('保留我的提示词')
})

it('参考图、选区及父任务保持独立身份，并验证模型限制', () => {
  const reference: ImageAsset = { id: 'reference' as ImageAssetId, mimeType: 'image/png', bytes: 20, width: 1024, height: 1024 }
  const mask = { ...reference, id: 'mask' as ImageAssetId }
  const draft = { ...createDraft(model), prompt: '修改颜色', references: [reference], mask, parentJobId: 'parent' as ImageJobId }
  expect(requestFromDraft(draft, model, limits)).toMatchObject({ ok: true, value: { request: {
    referenceImageIds: ['reference'], maskImageId: 'mask', parentJobId: 'parent',
  } } })
  expect(requestFromDraft(draft, { ...model, supportsEdit: false }, limits)).toEqual({ ok: false, error: 'referenceUnsupported' })
  expect(requestFromDraft(draft, { ...model, maxReferenceImages: 0 }, limits)).toEqual({ ok: false, error: 'referencesTooMany' })
  expect(requestFromDraft(draft, { ...model, supportsMask: false }, limits)).toEqual({ ok: false, error: 'maskUnsupported' })
  expect(requestFromDraft({ ...draft, references: [] }, model, limits)).toEqual({ ok: false, error: 'maskRequiresReference' })
  expect(requestFromDraft({ ...draft, mask: { ...mask, width: 512 } }, model, limits)).toEqual({ ok: false, error: 'maskDimensions' })
  expect(requestFromDraft({ ...draft, mask: { ...mask, height: 512 } }, model, limits)).toEqual({ ok: false, error: 'maskDimensions' })
})

it('缺省草稿和无平台价目不显示虚构费用，不可用选项均被阻止', () => {
  expect(createDraft()).toMatchObject({ modelKey: '', size: '', quality: '', background: 'auto', format: 'png' })
  expect(estimatePoints(undefined, 1)).toBeUndefined()
  expect(estimatePoints(model, Number.NaN)).toBeUndefined()
  expect(estimatePoints(model, 0)).toBeUndefined()
  const { price: _price, ...unpriced } = model
  expect(estimatePoints(unpriced, 1)).toBeUndefined()
  for (const change of [{ quality: 'invalid' }, { background: 'opaque' as const }, { format: 'jpeg' as const }]) {
    expect(requestFromDraft({ ...createDraft(model), prompt: '生成', ...change }, model, limits)).toEqual({ ok: false, error: 'unsupportedOptions' })
  }
  expect(requestFromDraft({ ...createDraft(model), prompt: '生成', count: 1.5 }, model, limits)).toEqual({ ok: false, error: 'countInvalid' })
})
