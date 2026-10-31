/** 分辨率与构图比例映射到模型明确公布的原生尺寸。 */

/** 长边分辨率档位；实际像素尺寸单独展示。 */
export type ImageResolution = '1k' | '2k' | '4k'
/** 常用构图比例，任意自定义尺寸仍可在原生尺寸列表中选择。 */
export const IMAGE_RATIOS = ['1:1', '4:3', '3:4', '3:2', '2:3', '16:9', '9:16', '3:1', '1:3'] as const
const RESOLUTION_EDGES: Record<ImageResolution, number> = { '1k': 1024, '2k': 2048, '4k': 3840 }

function dimensions(size: string): { width: number; height: number } | undefined {
  const match = /^(\d+)x(\d+)$/.exec(size)
  if (match === null) return undefined
  const width = Number(match[1]), height = Number(match[2])
  return width > 0 && height > 0 ? { width, height } : undefined
}
function ratioNumber(ratio: string): number {
  const [width, height] = ratio.split(':')
  return Number(width) / Number(height)
}

/**
 * 识别原生尺寸对应的构图比例。
 * @param size - 模型原生尺寸。
 * @returns 最接近的常用构图比例。
 */
export function imageRatio(size: string): typeof IMAGE_RATIOS[number] {
  const frame = dimensions(size)
  if (frame === undefined) return '1:1'
  const distance = (ratio: string) => Math.abs(Math.log(frame.width / frame.height / ratioNumber(ratio)))
  return IMAGE_RATIOS.reduce<typeof IMAGE_RATIOS[number]>((best, candidate) => distance(candidate) < distance(best) ? candidate : best, '1:1')
}

/**
 * 识别原生尺寸对应的分辨率档位。
 * @param size - 实际原生尺寸。
 * @returns 最接近的长边分辨率档位。
 */
export function imageResolution(size: string): ImageResolution {
  const frame = dimensions(size)
  if (frame === undefined) return '1k'
  const edge = Math.max(frame.width, frame.height)
  const distance = (level: ImageResolution) => Math.abs(edge - RESOLUTION_EDGES[level])
  return (Object.keys(RESOLUTION_EDGES) as ImageResolution[])
    .reduce<ImageResolution>((best, candidate) => distance(candidate) < distance(best) ? candidate : best, '1k')
}

/**
 * 优先匹配构图比例，再选取最接近目标长边的已声明尺寸。
 * @param sizes - 模型允许的原生尺寸。
 * @param resolution - 用户希望的分辨率档位。
 * @param ratio - 用户希望的构图比例。
 * @returns 实际尺寸与是否降级或调整的标记，不生成虚构支持的尺寸。
 */
export function chooseImageSize(sizes: readonly string[], resolution: ImageResolution, ratio: string): { size: string; adjusted: boolean } {
  const candidates = sizes.flatMap((size) => {
    const frame = dimensions(size)
    return frame === undefined ? [] : [{ size, frame, ratio: imageRatio(size) }]
  })
  const target = RESOLUTION_EDGES[resolution]
  const ratioDistance = (value: string) => Math.abs(Math.log(ratioNumber(value) / ratioNumber(ratio)))
  candidates.sort((a, b) => ratioDistance(a.ratio) - ratioDistance(b.ratio)
    || Math.abs(Math.max(a.frame.width, a.frame.height) - target) - Math.abs(Math.max(b.frame.width, b.frame.height) - target))
  const selected = candidates[0]
  if (selected === undefined) return { size: sizes[0] ?? '', adjusted: true }
  return { size: selected.size, adjusted: selected.ratio !== ratio || Math.max(selected.frame.width, selected.frame.height) < target }
}
