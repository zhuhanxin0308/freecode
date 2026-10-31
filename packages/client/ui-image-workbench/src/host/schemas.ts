/** 持久文件和供应商响应进入工作台前的验证。 */
import { z } from 'zod'
import type { ImageAssetId, ImageGenerationRequest, ImageJobId } from '../types.ts'

/** 内容摘要只允许用于工作台自有文件名。 */
export const assetIdSchema = z.string().regex(/^[a-f0-9]{64}$/).transform(value => value as ImageAssetId)
/** 本机生成的任务标识。 */
export const jobIdSchema = z.uuid().transform(value => value as ImageJobId)
/** 客户端安全错误分类。 */
export const failureSchema = z.enum(['invalid-input', 'model-unavailable', 'credential-required', 'account-required',
  'account-changed', 'insufficient-points', 'upstream-rejected', 'upstream-unavailable', 'result-unavailable',
  'unsafe-url', 'too-large', 'storage', 'cancel-unavailable', 'not-found', 'conflict'])
/** 来源明确的模型地址。 */
export const modelRefSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('platform'), id: z.string().min(1).max(256) }).strict(),
  z.object({ source: z.literal('custom'), provider: z.string().min(1).max(256), id: z.string().min(1).max(256) }).strict(),
])
/** 可复用且无凭据的生成输入。 */
export const generationSchema = z.object({
  model: modelRefSchema, prompt: z.string().min(1), size: z.string().min(1), quality: z.string().min(1),
  background: z.enum(['auto', 'opaque', 'transparent']), format: z.enum(['png', 'jpeg', 'webp']),
  referenceImageIds: z.array(assetIdSchema), maskImageId: assetIdSchema.optional(), parentJobId: jobIdSchema.optional(),
}).strict().transform(({ maskImageId, parentJobId, ...value }): ImageGenerationRequest => ({
  ...value, ...maskImageId === undefined ? {} : { maskImageId }, ...parentJobId === undefined ? {} : { parentJobId },
}))
/** 原图元数据。 */
export const assetSchema = z.object({ id: assetIdSchema, mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  width: z.int().positive(), height: z.int().positive(), bytes: z.int().positive() }).strict()
/** 持久任务包含的主机私有恢复信息不会进入 Remote 投影。 */
export const storedJobSchema = z.object({
  id: jobIdSchema, createdAt: z.int().positive(), updatedAt: z.int().positive(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'uncertain']),
  request: generationSchema, favorite: z.boolean(), archived: z.boolean(), images: z.array(assetSchema),
  error: z.object({ code: failureSchema }).optional(), chargedUnits: z.string().regex(/^\d+$/).optional(),
  accountId: z.string().optional(), remoteId: z.string().optional(),
  owner: z.object({ pid: z.int().positive(), instance: z.string() }).optional(),
}).strict()
/** 一份原子替换的工作台索引。 */
export const journalSchema = z.object({ version: z.literal(1), jobs: z.array(storedJobSchema), assets: z.array(assetSchema),
  submissions: z.array(z.object({ id: z.uuid(), hash: z.string().regex(/^[a-f0-9]{64}$/), jobIds: z.array(jobIdSchema) }).strict()),
}).strict()
/** 任务存储记录。 */
export type StoredImageJob = z.infer<typeof storedJobSchema>
/** 工作台索引。 */
export type ImageJournal = z.infer<typeof journalSchema>
