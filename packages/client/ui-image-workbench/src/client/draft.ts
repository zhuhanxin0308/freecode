/** 图片草稿的能力约束与费用展示，不包含任何凭据。 */
import { Big } from 'big.js'
import type { ImageAsset, ImageBackground, ImageCatalog, ImageFormat, ImageJobId, ImageModelDescriptor, ImageModelRef, ImageSubmitRequest } from '../types.ts'
import type { ImageWorkbenchKey } from './locales.ts'
import { chooseImageSize, imageRatio, imageResolution, type ImageResolution } from './image-sizing.ts'

/** 工作台尚未提交的创作参数。 */
export interface ImageDraft {
  modelKey: string
  prompt: string
  size: string
  quality: string
  background: ImageBackground
  format: ImageFormat
  count: number
  references: ImageAsset[]
  mask?: ImageAsset
  parentJobId?: ImageJobId
  compression?: number
  moderation?: 'auto' | 'low'
  fidelity?: 'low' | 'high'
  resolution?: ImageResolution
  ratio?: string
}

/** UI 已校验的提交内容；控制器为同一次操作添加稳定幂等标识。 */
export type DraftSubmission = Omit<ImageSubmitRequest, 'submissionId'>

/**
 * 区分不同来源与提供商下的重名模型。
 * @param model - 完整来源身份。
 * @returns 无重名碰撞的选择器键。
 */
export function modelKey(model: ImageModelRef): string {
  return JSON.stringify(model.source === 'platform' ? ['platform', model.id] : ['custom', model.provider, model.id])
}

/**
 * 仅从模型已公开能力初始化生成选项。
 * @param model - 所选模型，可缺省。
 * @returns 空白提示词和初始生成选项。
 */
export function createDraft(model?: ImageModelDescriptor): ImageDraft {
  return { modelKey: model === undefined ? '' : modelKey(model.ref), prompt: '', size: model?.sizes[0] ?? '',
    quality: model?.qualities[0] ?? '', background: model?.backgrounds[0] ?? 'auto', format: model?.formats[0] ?? 'png', count: 1, references: [] }
}

/**
 * 更换模型时保留创作意图，并仅采用新模型支持的参数。
 * @param draft - 当前用户输入。
 * @param model - 新选择的模型。
 * @returns 保留提示词和参考图的兼容草稿，图片不会被静默删除。
 */
export function changeDraftModel(draft: ImageDraft, model?: ImageModelDescriptor): ImageDraft {
  const resolution = draft.resolution ?? imageResolution(draft.size)
  const ratio = draft.ratio ?? imageRatio(draft.size)
  const next = { ...draft, modelKey: model === undefined ? '' : modelKey(model.ref),
    size: chooseImageSize(model?.sizes ?? [], resolution, ratio).size, resolution, ratio,
    quality: model?.qualities.includes(draft.quality) ? draft.quality : model?.qualities[0] ?? '',
    background: model?.backgrounds.includes(draft.background) ? draft.background : model?.backgrounds[0] ?? 'auto',
    format: model?.formats.includes(draft.format) ? draft.format : model?.formats[0] ?? 'png' }
  if (!model?.optionalParameters.includes('output_compression')) delete next.compression
  if (!model?.optionalParameters.includes('moderation')) delete next.moderation
  if (!model?.optionalParameters.includes('input_fidelity')) delete next.fidelity
  if (next.mask !== undefined && model?.formats.includes('png')) next.format = 'png'
  return next
}

/**
 * 使用整数记账单位计算展示费用。
 * @param model - 已选模型。
 * @param count - 图片张数。
 * @returns 平台明确声明的总积分，自定义模型不返回平台费用。
 */
export function estimatePoints(model: ImageModelDescriptor | undefined, count: number): string | undefined {
  if (!Number.isSafeInteger(count) || count < 1) return undefined
  return model?.ref.source === 'platform' && model.price !== undefined
    ? new Big(model.price.units).times(count).div(model.price.unitsPerPoint).toFixed() : undefined
}

/**
 * 验证草稿与当前模型能力，保留无法提交时的用户输入。
 * @param draft - 尚未提交的输入。
 * @param model - 当前目录模型。
 * @param limits - Host 发布的资源限制。
 * @returns 可提交请求或本地化校验键。
 */
export function requestFromDraft(draft: ImageDraft, model: ImageModelDescriptor | undefined, limits: ImageCatalog['limits']):
  { ok: true; value: DraftSubmission } | { ok: false; error: ImageWorkbenchKey } {
  if (model === undefined) return { ok: false, error: 'modelRequired' }
  if (!model.available) return { ok: false, error: 'modelUnavailable' }
  const prompt = draft.prompt.trim()
  if (prompt.length === 0) return { ok: false, error: 'promptRequired' }
  if (prompt.length > limits.maxPromptLength) return { ok: false, error: 'promptLong' }
  if (!Number.isSafeInteger(draft.count) || draft.count < 1 || draft.count > limits.maxBatch) return { ok: false, error: 'countInvalid' }
  if (!model.sizes.includes(draft.size) || !model.qualities.includes(draft.quality)
    || !model.backgrounds.includes(draft.background) || !model.formats.includes(draft.format)) return { ok: false, error: 'unsupportedOptions' }
  if (draft.references.length > 0 && !model.supportsEdit) return { ok: false, error: 'referenceUnsupported' }
  if (draft.references.length > model.maxReferenceImages) return { ok: false, error: 'referencesTooMany' }
  if (draft.compression !== undefined && (!Number.isInteger(draft.compression) || draft.compression < 0 || draft.compression > 100)) return { ok: false, error: 'unsupportedOptions' }
  if (draft.mask !== undefined) {
    if (!model.supportsMask) return { ok: false, error: 'maskUnsupported' }
    const reference = draft.references[0]
    if (reference === undefined) return { ok: false, error: 'maskRequiresReference' }
    if (draft.mask.width !== reference.width || draft.mask.height !== reference.height) return { ok: false, error: 'maskDimensions' }
  }
  const format = draft.mask !== undefined || draft.background === 'transparent' && draft.format === 'jpeg' ? 'png' : draft.format
  if (!model.formats.includes(format)) return { ok: false, error: 'unsupportedOptions' }
  return { ok: true, value: { count: draft.count, request: { model: model.ref, prompt, size: draft.size, quality: draft.quality,
    background: draft.background, format, referenceImageIds: draft.references.map(image => image.id),
    ...model.optionalParameters.includes('output_compression') && format !== 'png' && draft.compression !== undefined ? { compression: draft.compression } : {},
    ...model.optionalParameters.includes('moderation') && draft.moderation !== undefined ? { moderation: draft.moderation } : {},
    ...model.optionalParameters.includes('input_fidelity') && draft.references.length > 0 && draft.fidelity !== undefined ? { fidelity: draft.fidelity } : {},
    ...draft.mask === undefined ? {} : { maskImageId: draft.mask.id },
    ...draft.parentJobId === undefined ? {} : { parentJobId: draft.parentJobId } } } }
}
