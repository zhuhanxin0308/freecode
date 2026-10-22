import { FreeCodeLogo } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import css from './Brand.module.css'

const BRAND_NAME = 'free code'

/**
 * 按宿主请求的尺寸展示 free code 标志。
 * @param props - 宿主指定的尺寸和样式。
 * @returns 与当前界面主题适配的品牌图形。
 */
export function OfficialBrandMark({ size }: SidebarBrandMarkOwnerProps) {
  return <FreeCodeLogo size={size} className={css.mark} />
}

/**
 * 绘制与独立图标插槽配合的小写品牌字标。
 * @returns 保持自然宽度的品牌名称。
 */
export function OfficialBrandName() {
  return <span className={css.wordmark}>{BRAND_NAME}</span>
}
