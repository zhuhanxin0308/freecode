/** 图片工作台在 Host、API 装配与 Client 之间共享的数据；原图只按需读取。 */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'

/** 本机持久任务标识。 */
export type ImageJobId = Branded<'ImageJobId'>
/** 一次用户提交在连接重试期间保持不变的身份。 */
export type ImageSubmissionId = Branded<'ImageSubmissionId'>
/** 按原图内容寻址的本机资源标识。 */
export type ImageAssetId = Branded<'ImageAssetId'>
/** 本机工作台的权限资源身份。 */
export type ImageWorkbenchId = Branded<'ImageWorkbenchId'>
/** 图片编码格式。 */
export type ImageFormat = 'png' | 'jpeg' | 'webp'
/** 图片的实际 MIME 类型。 */
export type ImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp'
/** 服务商明确支持的背景处理方式。 */
export type ImageBackground = 'auto' | 'opaque' | 'transparent'
/** 模型明确允许写入请求的可选参数。 */
export type ImageOptionalParameter = 'quality' | 'background' | 'output_format'
/** 平台目录与自定义提供方的独立模型地址。 */
export type ImageModelRef = { source: 'platform'; id: string } | { source: 'custom'; provider: string; id: string }
/** 可直接本地化的操作失败分类，不携带上游原始响应。 */
export type ImageErrorCode = 'invalid-input' | 'model-unavailable' | 'credential-required' | 'account-required'
  | 'account-changed' | 'insufficient-points' | 'upstream-rejected' | 'upstream-unavailable' | 'result-unavailable'
  | 'unsafe-url' | 'too-large' | 'storage' | 'cancel-unavailable' | 'not-found' | 'conflict'
/** 经配置或平台目录确认的图片能力。 */
export interface ImageModelDescriptor {
  ref: ImageModelRef
  name: string
  providerName: string
  sizes: string[]
  qualities: string[]
  backgrounds: ImageBackground[]
  formats: ImageFormat[]
  supportsEdit: boolean
  supportsMask: boolean
  maxReferenceImages: number
  optionalParameters: ImageOptionalParameter[]
  available: boolean
  unavailableReason?: ImageErrorCode
  price?: { units: string; unitsPerPoint: string }
}
/** 工作台可选模型与输入限制。 */
export interface ImageCatalog {
  models: ImageModelDescriptor[]
  platform: 'available' | 'signed-out' | 'unavailable'
  limits: { maxImageBytes: number; maxPromptLength: number; maxBatch: number; pollIntervalMs: number }
}
/** 原图元数据；缩略图使用同一标识按需读取。 */
export interface ImageAsset {
  id: ImageAssetId
  mimeType: ImageMimeType
  width: number
  height: number
  bytes: number
}
/** 可复用的生成参数；参考图与遮罩只引用本机已有资源。 */
export interface ImageGenerationRequest {
  model: ImageModelRef
  prompt: string
  size: string
  quality: string
  background: ImageBackground
  format: ImageFormat
  referenceImageIds: ImageAssetId[]
  maskImageId?: ImageAssetId
  parentJobId?: ImageJobId
}
/** 一次批量操作；每张图片均有独立任务与幂等标识。 */
export interface ImageSubmitRequest { submissionId: ImageSubmissionId; request: ImageGenerationRequest; count: number }
/** 任务状态；uncertain 表示请求可能已被服务商接受，禁止自动重新生成。 */
export type ImageJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'uncertain'
/** 持久历史中的一项任务。 */
export interface ImageJob {
  id: ImageJobId
  createdAt: number
  updatedAt: number
  status: ImageJobStatus
  request: ImageGenerationRequest
  favorite: boolean
  archived: boolean
  images: ImageAsset[]
  error?: { code: ImageErrorCode }
  chargedUnits?: string
}
/** 历史筛选；cursor 是上页最后一项的任务标识。 */
export interface ImageJobQuery {
  limit: number
  cursor?: ImageJobId
  archived?: boolean
  favoritesOnly?: boolean
  activeOnly?: boolean
  search?: string
}
/** 一页历史任务。 */
export interface ImageJobPage { jobs: ImageJob[]; nextCursor?: ImageJobId }
/** 浏览器上传的原始图片，Host 再检查实际编码和资源限制。 */
export interface ImageImportRequest { mimeType: ImageMimeType; dataBase64: string }
/** 有界、按需读取的图片内容。 */
export interface ImageReadResult { mimeType: ImageMimeType; dataBase64: string }
/** 工作区导出目标，仅接受文件名，不接受任意绝对路径。 */
export interface ImageExportDestination { workspaceId: WorkspaceId; fileName: string }
/** 已完成的工作区写入位置。 */
export interface ImageExportResult { path: string }
/** 工作台可导出的工作区，不包含其他工作区状态。 */
export interface ImageWorkspace { id: WorkspaceId; name: string }
