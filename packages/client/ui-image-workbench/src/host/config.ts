/** 工作台的部署限制与持久目录配置。 */
import Schema from '@deepseek-ai/schemastery'

/** 已应用默认值的部署配置。 */
export interface WorkbenchConfig {
  directory?: string
  platformOrigin: string
  allowLoopbackHttp: boolean
  downloadOrigins: string[]
  maxImageBytes: number
  maxInputImageBytes: number
  maxImagePixels: number
  maxReferenceBytes: number
  maxStorageBytes: number
  maxJournalBytes: number
  maxJobs: number
  maxPromptLength: number
  maxBatch: number
  maxHistoryPageSize: number
  thumbnailSize: number
  maxThumbnailBytes: number
  requestTimeoutMs: number
  pollIntervalMs: number
  lockWaitMs: number
}

/** 启动时解析的资源与网络限制。 */
export const Config: Schema<Partial<WorkbenchConfig>, WorkbenchConfig> = Schema.object({
  directory: Schema.string(),
  platformOrigin: Schema.string().default('https://freecode.mymyjd.cn'),
  allowLoopbackHttp: Schema.boolean().default(false),
  downloadOrigins: Schema.array(Schema.string()).default([]),
  maxImageBytes: Schema.natural().min(1024).max(64 * 1024 * 1024).default(32 * 1024 * 1024),
  maxInputImageBytes: Schema.natural().min(1024).max(64 * 1024 * 1024).default(10 * 1024 * 1024),
  maxImagePixels: Schema.natural().min(1).default(64_000_000),
  maxReferenceBytes: Schema.natural().min(1024).default(40 * 1024 * 1024),
  maxStorageBytes: Schema.natural().min(1024).default(4 * 1024 * 1024 * 1024),
  maxJournalBytes: Schema.natural().min(1024).default(64 * 1024 * 1024),
  maxJobs: Schema.natural().min(1).default(10000),
  maxPromptLength: Schema.natural().min(1).default(12000),
  maxBatch: Schema.natural().min(1).max(20).default(8),
  maxHistoryPageSize: Schema.natural().min(1).max(1000).default(100),
  thumbnailSize: Schema.natural().min(32).max(1024).default(384),
  maxThumbnailBytes: Schema.natural().min(1024).default(512 * 1024),
  requestTimeoutMs: Schema.natural().min(100).max(2_147_483_647).default(300000),
  pollIntervalMs: Schema.natural().min(250).max(60000).default(2000),
  lockWaitMs: Schema.natural().min(100).max(120000).default(30000),
})
