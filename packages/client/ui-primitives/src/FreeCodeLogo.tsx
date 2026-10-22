import type { IconProps } from './icons/props.ts'

/** free code 标志的正方形设计网格。 */
export const FREE_CODE_LOGO_VIEWBOX = '0 0 320 320'

/** 经确认的 FC 轮廓；内部留白与外侧开口共同组成品牌字母。 */
export const FREE_CODE_LOGO_PATH = 'M146 28H302Q308 28 305 34L281 75Q279 79 274 79H154Q143 79 136 87L91 132Q84 139 84 150V192Q84 199 89 204L102 217L121 185Q124 180 130 180H181Q187 180 184 185L155 233H254Q260 233 263 238L286 278Q289 284 283 284H136Q116 284 102 270L43 211Q28 197 28 179V143Q28 124 40 112L104 48Q124 28 146 28ZM159 114H273Q279 114 276 119L252 159Q250 163 245 163H128Q122 163 125 158L149 119Q152 114 159 114Z'

/**
 * 绘制可随主题继承颜色的 free code 标志。
 * @param props - 图标大小与布局样式。
 * @returns 与相邻品牌名称共同使用的装饰性 SVG。
 */
export function FreeCodeLogo({ size = 24, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox={FREE_CODE_LOGO_VIEWBOX} className={className} aria-hidden="true" fill="currentColor">
      <path d={FREE_CODE_LOGO_PATH} />
    </svg>
  )
}
