/** 图片表单反馈与 JSON 写入；Host 保持最终能力校验的唯一权威。 */
import type { ImageModelProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { en } from './locales.ts'

/** 图片表单保持与 Host 声明一致的字段，临时空值由表单反馈处理。 */
export type ImageModelDraft = ImageModelProfile

/**
 * 建立不预设尺寸的新行。
 * @returns 需要用户填写标识和尺寸的草稿。
 */
export function newImageModelDraft(): ImageModelDraft {
  return { id: '', sizes: [], qualities: ['auto'], backgrounds: ['auto'], formats: ['png'], supportsEdit: false, supportsMask: false, maxReferenceImages: 0, optionalParameters: [] }
}

/**
 * 从经过设置 schema 处理的列表复制可编辑行。
 * @param value - 设置描述中的图片模型列表。
 * @returns 与原始设置分离的草稿。
 */
export function imageModelDrafts(value: unknown): ImageModelDraft[] {
  if (!Array.isArray(value)) return []
  return value.map(item => ({ ...newImageModelDraft(), ...structuredClone(item as ImageModelProfile) }))
}

/**
 * 转换用户输入的选项，保留重复值供表单明确报错。
 * @param value - 逗号或换行分隔的选项。
 * @returns 配置选项列表。
 */
export function imageOptionValues(value: string): string[] {
  return value.split(/[,，\n]/).map(item => item.trim()).filter(item => item !== '')
}

/**
 * 返回首个可操作的表单错误，提交时由 Host 完整验证。
 * @param models - 图片模型草稿。
 * @returns 出错行与本地化键，或 undefined。
 */
export function imageModelFailure(models: readonly ImageModelDraft[]): { index: number; key: keyof typeof en } | undefined {
  const ids = new Set<string>()
  for (const [index, model] of models.entries()) {
    if (model.id.trim() === '') return { index, key: 'modelIdRequired' }
    if (ids.has(model.id.trim())) return { index, key: 'modelIdDuplicate' }
    ids.add(model.id.trim())
    if (model.sizes.length === 0 || model.sizes.some(size => size !== 'auto' && !/^[1-9]\d*x[1-9]\d*$/.test(size))) return { index, key: 'imageSizesInvalid' }
    const lists = [model.sizes, model.qualities, model.backgrounds, model.formats]
    if (lists.some(list => list.length === 0 || list.some(value => value.trim() === '') || new Set(list).size !== list.length)) return { index, key: 'imageCapabilitiesInvalid' }
    if (model.supportsEdit && (!Number.isSafeInteger(model.maxReferenceImages) || model.maxReferenceImages <= 0)) return { index, key: 'imageReferenceInvalid' }
    if (model.backgrounds.includes('transparent') && !model.formats.some(format => format !== 'jpeg')) return { index, key: 'imageTransparencyInvalid' }
  }
  return undefined
}

/**
 * 只生成图片模型设置，不携带凭据或聊天模型。
 * @param models - 通过表单检查的草稿。
 * @returns 可以由 settings.mutate 保存的 JSON 数组。
 */
export function imageModelValues(models: readonly ImageModelDraft[]): JsonValue[] {
  return models.map(model => ({
    id: model.id.trim(), ...model.name === undefined || model.name.trim() === '' ? {} : { name: model.name.trim() },
    sizes: [...model.sizes], qualities: [...model.qualities], backgrounds: [...model.backgrounds], formats: [...model.formats],
    supportsEdit: model.supportsEdit, supportsMask: model.supportsMask ?? false,
    maxReferenceImages: model.maxReferenceImages, optionalParameters: [...model.optionalParameters ?? []],
  }))
}
