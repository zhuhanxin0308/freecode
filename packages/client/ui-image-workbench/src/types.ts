/** 工作台公开数据沿用独立协议声明，避免 API 装配依赖界面实现。 */
import type { TypertResource } from '@deepseek-ai/dsh-typert-protocol'
import type { ImageWorkbenchId, ImageErrorCode } from '@deepseek-ai/dsh-image-workbench-types/types'
export type * from '@deepseek-ai/dsh-image-workbench-types/types'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertResourceMap {
    /** 本机图片历史、资源与生成任务。 */
    imageWorkbench: TypertResource<ImageWorkbenchId>
  }
  interface RemoteErrorDetailsMap {
    /** 图片操作被拒绝或失败；前端按 reason 提供本地化说明。 */
    'image-workbench/rejected': { reason: ImageErrorCode }
  }
}
