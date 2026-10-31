/** 图片生成能力的权威校验，不加载聊天 SDK 或读取凭据。 */
import z from '@deepseek-ai/schemastery'

const IMAGE_BACKGROUNDS = ['auto', 'opaque', 'transparent'] as const
const IMAGE_FORMATS = ['png', 'jpeg', 'webp'] as const
const IMAGE_OPTIONAL_PARAMETERS = ['quality', 'background', 'output_format'] as const

/** 一项显式声明的 OpenAI Images 模型能力。 */
export interface ImageModelProfile {
  id: string
  name?: string
  sizes: string[]
  qualities: string[]
  backgrounds: (typeof IMAGE_BACKGROUNDS[number])[]
  formats: (typeof IMAGE_FORMATS[number])[]
  supportsEdit: boolean
  supportsMask?: boolean
  maxReferenceImages: number
  optionalParameters?: (typeof IMAGE_OPTIONAL_PARAMETERS[number])[]
}

/** 完成名称与可选参数缺省处理后的独立图片模型。 */
export interface ResolvedImageModelProfile extends ImageModelProfile {
  name: string
  supportsMask: boolean
  optionalParameters: (typeof IMAGE_OPTIONAL_PARAMETERS[number])[]
}

/** 通过现有设置描述接口传输的图片模型字段约束。 */
export const ImageModelSchema: z<ImageModelProfile> = z.object({
  id: z.string().required(),
  name: z.string(),
  sizes: z.array(z.string()).required(),
  qualities: z.array(z.string()).required(),
  backgrounds: z.array(z.union(IMAGE_BACKGROUNDS)).required(),
  formats: z.array(z.union(IMAGE_FORMATS)).required(),
  supportsEdit: z.boolean().required(),
  supportsMask: z.boolean().default(false),
  maxReferenceImages: z.number().step(1).min(0).required(),
  optionalParameters: z.array(z.union(IMAGE_OPTIONAL_PARAMETERS)),
})

const fields = new Set(['id', 'name', 'sizes', 'qualities', 'backgrounds', 'formats', 'supportsEdit', 'supportsMask', 'maxReferenceImages', 'optionalParameters'])

function invalid(provider: string, index: number, field: string): never {
  throw new Error(`图片提供商 ${provider} 的第 ${index + 1} 个模型配置无效：${field}`)
}

function text(value: unknown, provider: string, index: number, field: string): string {
  if (typeof value !== 'string' || value.trim() === '' || /[\r\n\0]/.test(value)) invalid(provider, index, field)
  return value.trim()
}

function values(value: unknown, provider: string, index: number, field: string, allowEmpty = false): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) invalid(provider, index, field)
  const result = value.map(item => text(item, provider, index, field))
  if (new Set(result).size !== result.length) invalid(provider, index, `${field} 存在重复值`)
  return result
}

function choices<T extends string>(
  value: unknown, allowed: readonly T[], provider: string, index: number, field: string, allowEmpty = false,
): T[] {
  return values(value, provider, index, field, allowEmpty).map((item) => {
    const match = allowed.find(candidate => candidate === item)
    if (match === undefined) invalid(provider, index, field)
    return match
  })
}

/**
 * 校验并复制显式图片能力；目录中的模型名称不能代替能力声明。
 * @param provider - 用于定位配置错误的提供商标识。
 * @param source - 设置中的图片模型数组；省略时表示没有图片生成能力。
 * @returns 与原配置没有可变数组引用的图片模型列表。
 */
export function resolveImageModels(provider: string, source: unknown): readonly ResolvedImageModelProfile[] {
  if (source === undefined) return []
  if (!Array.isArray(source)) invalid(provider, 0, 'imageModels 必须是数组')
  const ids = new Set<string>()
  return source.map((raw: unknown, index) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) invalid(provider, index, '模型必须是对象')
    const item = raw as Record<string, unknown>
    for (const field of Object.keys(item)) if (!fields.has(field)) invalid(provider, index, `未知字段 ${field}`)
    const id = text(item['id'], provider, index, '模型标识')
    if (ids.has(id)) invalid(provider, index, '模型标识重复')
    ids.add(id)
    const name = item['name'] === undefined ? id : text(item['name'], provider, index, '显示名称')
    const sizes = values(item['sizes'], provider, index, '尺寸')
    for (const size of sizes) {
      if (size === 'auto') continue
      const match = /^(\d+)x(\d+)$/.exec(size)
      const width = Number(match?.[1])
      const height = Number(match?.[2])
      if (match === null || !Number.isSafeInteger(width) || !Number.isSafeInteger(height)
        || width <= 0 || height <= 0 || !Number.isSafeInteger(width * height)) invalid(provider, index, '尺寸')
    }
    const qualities = values(item['qualities'], provider, index, '画质')
    const backgrounds = choices(item['backgrounds'], IMAGE_BACKGROUNDS, provider, index, '背景')
    const formats = choices(item['formats'], IMAGE_FORMATS, provider, index, '输出格式')
    const optionalParameters = choices(item['optionalParameters'] ?? [], IMAGE_OPTIONAL_PARAMETERS, provider, index, '可选参数', true)
    if (!optionalParameters.includes('quality') && (qualities.length !== 1 || qualities[0] !== 'auto')) invalid(provider, index, '需要声明画质参数支持')
    if (!optionalParameters.includes('background') && (backgrounds.length !== 1 || backgrounds[0] !== 'auto')) invalid(provider, index, '需要声明背景参数支持')
    if (!optionalParameters.includes('output_format') && (formats.length !== 1 || formats[0] !== 'png')) invalid(provider, index, '需要声明输出格式参数支持')
    if (backgrounds.includes('transparent') && !formats.some(format => format !== 'jpeg')) invalid(provider, index, '透明背景需要 PNG 或 WebP 格式')
    const supportsEdit = item['supportsEdit']
    const supportsMask = item['supportsMask'] ?? false
    const maxReferenceImages = item['maxReferenceImages']
    if (typeof supportsEdit !== 'boolean' || typeof maxReferenceImages !== 'number' || !Number.isSafeInteger(maxReferenceImages)
      || maxReferenceImages < 0 || (supportsEdit ? maxReferenceImages === 0 : maxReferenceImages !== 0)) invalid(provider, index, '参考图编辑能力')
    if (typeof supportsMask !== 'boolean' || (supportsMask && !supportsEdit)) invalid(provider, index, '局部重绘需要参考图编辑能力')
    return { id, name, sizes, qualities, backgrounds, formats, supportsEdit, supportsMask, maxReferenceImages, optionalParameters }
  })
}
