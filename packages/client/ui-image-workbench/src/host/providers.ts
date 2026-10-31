/** 现有凭据与图片供方之间的主机适配，不向 Remote 返回地址或令牌。 */
import type { Context } from '@deepseek-ai/cordis'
import { isCredentialKeySegment } from '@deepseek-ai/dsh-credentials'
import { recordKeyFor, resolveConfiguredImageProviders, type ResolvedImageProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-deepseek-account'
import { z } from 'zod'
import type { ImageCatalog, ImageGenerationRequest, ImageMimeType, ImageModelDescriptor } from '../types.ts'
import type { WorkbenchConfig } from './config.ts'
import { ImageFailure } from './errors.ts'
import { ImageNetwork, type ImageHttpResponse } from './network.ts'
import type { ImageStore } from './store.ts'
import type { StoredImageJob } from './schemas.ts'
import { composeMaskedImage } from './image-processing.ts'

const optionalParameter = z.enum(['quality', 'background', 'output_format', 'output_compression', 'moderation', 'input_fidelity'])
const platformCatalog = z.object({ data: z.array(z.object({
  id: z.string().min(1).max(256), name: z.string(), sizes: z.array(z.string()), qualities: z.array(z.string()),
  backgrounds: z.array(z.enum(['auto', 'opaque', 'transparent'])), formats: z.array(z.enum(['png', 'jpeg', 'webp'])),
  supports_edit: z.boolean(), supports_mask: z.boolean(), max_references: z.int().nonnegative(),
  optional_parameters: z.array(optionalParameter),
})), price_units: z.string().regex(/^\d+$/), units_per_point: z.string().regex(/^[1-9]\d*$/) })
const platformJob = z.object({ job: z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  state: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'uncertain']),
  error_code: z.string().optional(), charged_units: z.string().regex(/^\d+$/).optional(),
  image: z.object({ mime_type: z.enum(['image/png', 'image/jpeg', 'image/webp']), width: z.int().positive(),
    height: z.int().positive(), bytes: z.int().positive() }).optional(),
}) })
/** 平台任务的恢复所需状态。 */
export type PlatformImageJob = z.infer<typeof platformJob>['job']

/**
 * 根据文件签名识别允许的图片编码。
 * @param bytes - 待验证编码的原图。
 * @returns MIME 候选，实际解码仍由原图存储验证。
 */
export function imageMime(bytes: Uint8Array): ImageMimeType {
  const buffer = Buffer.from(bytes)
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return 'image/jpeg'
  if (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') return 'image/webp'
  throw new ImageFailure('invalid-input')
}
/**
 * 拒绝非标准编码与超过资源限制的图片正文。
 * @param encoded - 标准 base64。
 * @param limit - 解码后字节限制。
 * @returns 完整原始字节。
 */
export function imageBytes(encoded: string, limit: number): Buffer {
  if (encoded.length > Math.ceil(limit / 3) * 4) throw new ImageFailure('too-large')
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.toString('base64') !== encoded) throw new ImageFailure('invalid-input')
  if (bytes.length > limit) throw new ImageFailure('too-large')
  return bytes
}

/** 图片模型目录与两种供方的实际请求。 */
export class ImageProviders {
  private readonly network: ImageNetwork
  private readonly platformOrigin: string
  private readonly downloadOrigins: Set<string>
  /**
   * 绑定当前配置与已有凭据服务。
   * @param ctx - 现有设置和凭据服务。
   * @param config - 网络与资源限制。
   * @param store - 原图存储。
   */
  constructor(private readonly ctx: Context, private readonly config: WorkbenchConfig, private readonly store: ImageStore) {
    this.network = new ImageNetwork(config)
    const origin = this.network.validateUrl(new URL(config.platformOrigin))
    if (origin.href !== `${origin.origin}/`) throw new ImageFailure('unsafe-url')
    this.platformOrigin = origin.origin
    this.downloadOrigins = new Set(config.downloadOrigins.map((value) => {
      const url = this.network.validateUrl(new URL(value))
      if (url.href !== `${url.origin}/`) throw new ImageFailure('unsafe-url')
      return url.origin
    }))
    this.profiles()
  }
  private profiles(): readonly ResolvedImageProviderProfile[] {
    const section = this.ctx.get('settings')?.describe().find(row => row.ns === 'llm-pi-ai')?.value
    return resolveConfiguredImageProviders(section ?? { providers: {} })
  }
  private async key(profile: ResolvedImageProviderProfile): Promise<string | undefined> {
    const credentials = this.ctx.get('credentials')
    if (credentials === undefined) return undefined
    if (profile.apiKeyEnv !== undefined) return (await credentials.resolve(profile.apiKeyEnv))?.value
    const record = isCredentialKeySegment(profile.id) ? await credentials.readRecord(recordKeyFor(profile.id)) : undefined
    if (record?.kind === 'grant') return undefined
    if (record?.key) return record.key
    for (const ref of profile.nativeApiKeyRefs) {
      const value = record?.env?.[ref] ?? (await credentials.resolve(ref))?.value
      if (value) return value
    }
    return undefined
  }
  /**
   * 读取发起图片请求的账号身份。
   * @returns 当前平台账号的稳定标识，不返回令牌。
   */
  async accountId(): Promise<string | undefined> {
    return (await this.ctx.get('deepseekAccount')?.getDeviceIdentity())?.userId
  }
  /**
   * 合并自定义图片能力与当前账号的平台目录。
   * @param signal - 服务卸载时取消网络读取。
   * @returns 客户端安全目录与部署限制。
   */
  async catalog(signal?: AbortSignal): Promise<ImageCatalog> {
    const models: ImageModelDescriptor[] = []
    for (const profile of this.profiles()) {
      const available = (await this.key(profile)) !== undefined
      for (const model of profile.imageModels) models.push({
        name: model.name, supportsEdit: model.supportsEdit, supportsMask: model.supportsMask,
        maxReferenceImages: model.maxReferenceImages, sizes: [...model.sizes], qualities: [...model.qualities],
        backgrounds: [...model.backgrounds], formats: [...model.formats], optionalParameters: [...model.optionalParameters],
        ref: { source: 'custom', provider: profile.id, id: model.id }, providerName: profile.displayName,
        available, ...available ? {} : { unavailableReason: 'credential-required' } })
    }
    let platform: ImageCatalog['platform'] = 'signed-out'
    const accountId = await this.accountId()
    if (accountId !== undefined) {
      try {
        const reply = await this.platformRequest('/v1/image-models', accountId, undefined, undefined, signal)
        const data = platformCatalog.parse(this.json(reply))
        models.push(...data.data.map((model): ImageModelDescriptor => ({ ref: { source: 'platform', id: model.id },
          providerName: 'free code', name: model.name, sizes: model.sizes, qualities: model.qualities,
          backgrounds: model.backgrounds, formats: model.formats, optionalParameters: model.optional_parameters,
          supportsEdit: model.supports_edit, supportsMask: model.supports_mask, maxReferenceImages: model.max_references, available: true,
          price: { units: data.price_units, unitsPerPoint: data.units_per_point } })))
        platform = 'available'
      } catch (error) { platform = error instanceof ImageFailure && error.code === 'account-required' ? 'signed-out' : 'unavailable' }
    }
    return { models, platform, limits: { maxImageBytes: this.config.maxInputImageBytes, maxPromptLength: this.config.maxPromptLength,
      maxBatch: this.config.maxBatch, pollIntervalMs: this.config.pollIntervalMs } }
  }
  /**
   * 使用已有提供商凭据提交单张生成或参考图编辑。
   * @param request - 已验证的单图输入。
   * @param signal - 任务取消。
   * @returns 供应商返回的原图。
   */
  async generateCustom(request: ImageGenerationRequest, signal: AbortSignal): Promise<Buffer> {
    if (request.model.source !== 'custom') throw new ImageFailure('model-unavailable')
    const ref = request.model
    const profile = this.profiles().find(value => value.id === ref.provider)
    const model = profile?.imageModels.find(value => value.id === ref.id)
    if (profile === undefined || model === undefined) throw new ImageFailure('model-unavailable')
    const key = await this.key(profile)
    if (key === undefined) throw new ImageFailure('credential-required')
    const base = this.network.validateUrl(new URL(`${profile.baseURL}/`))
    const fields: Record<string, string | number> = { model: ref.id, prompt: request.prompt, size: request.size, n: 1 }
    if (model.optionalParameters.includes('quality')) fields.quality = request.quality
    if (model.optionalParameters.includes('background')) fields.background = request.background
    if (model.optionalParameters.includes('output_format')) fields.output_format = request.format
    if (model.optionalParameters.includes('output_compression') && request.format !== 'png' && request.compression !== undefined) fields.output_compression = request.compression
    if (model.optionalParameters.includes('moderation') && request.moderation !== undefined) fields.moderation = request.moderation
    if (model.optionalParameters.includes('input_fidelity') && request.referenceImageIds.length > 0 && request.fidelity !== undefined) fields.input_fidelity = request.fidelity
    const headers = new Headers(profile.headers)
    for (const name of ['host', 'content-length', 'connection', 'content-type']) headers.delete(name)
    headers.set('authorization', `Bearer ${key}`)
    const editing = request.referenceImageIds.length > 0
    let body: string | FormData
    if (editing) {
      const form = new FormData()
      for (const [name, value] of Object.entries(fields)) form.append(name, String(value))
      for (const [index, id] of request.referenceImageIds.entries()) {
        const image = await this.store.readImage(id, 'original')
        form.append(request.referenceImageIds.length === 1 ? 'image' : 'image[]',
          new Blob([new Uint8Array(image.bytes)], { type: image.mimeType }), `reference-${index}.${image.mimeType.split('/')[1]}`)
      }
      if (request.maskImageId !== undefined) {
        const mask = await this.store.readImage(request.maskImageId, 'original')
        form.append('mask', new Blob([new Uint8Array(mask.bytes)], { type: mask.mimeType }), 'mask.png')
      }
      body = form
    } else { headers.set('content-type', 'application/json'); body = JSON.stringify(fields) }
    const url = new URL(`images/${editing ? 'edits' : 'generations'}`, base)
    const encoded = new Request(url, { method: 'POST', headers, body })
    const reply = await this.network.request(url, { method: 'POST', headers: Object.fromEntries(encoded.headers),
      body: new Uint8Array(await encoded.arrayBuffer()) }, this.config.maxImageBytes * 2, signal)
    const value = z.object({ data: z.tuple([z.object({ b64_json: z.string().optional(), url: z.url().optional() })]) })
      .safeParse(this.json(reply))
    if (!value.success) throw new ImageFailure('upstream-rejected', true)
    const image = value.data.data[0]
    if (image.b64_json !== undefined) return this.finishCustom(request, imageBytes(image.b64_json, this.config.maxImageBytes))
    if (image.url === undefined) throw new ImageFailure('result-unavailable', true)
    const download = this.network.validateUrl(new URL(image.url))
    if (download.origin !== base.origin && !this.downloadOrigins.has(download.origin)) throw new ImageFailure('unsafe-url', true)
    const result = await this.network.request(download, {}, this.config.maxImageBytes, signal)
    this.checkStatus(result)
    return this.finishCustom(request, result.bytes)
  }
  private async finishCustom(request: ImageGenerationRequest, bytes: Buffer): Promise<Buffer> {
    if (request.maskImageId === undefined) return bytes
    const reference = request.referenceImageIds[0]
    if (reference === undefined) throw new ImageFailure('invalid-input', true)
    const original = await this.store.readImage(reference, 'original')
    const mask = await this.store.readImage(request.maskImageId, 'original')
    try { return await composeMaskedImage(original.bytes, mask.bytes, bytes, this.config) }
    catch (_error) { throw new ImageFailure('result-unavailable', true) }
  }
  /**
   * 幂等创建或恢复账号所属的平台任务。
   * @param job - 持久任务与固定幂等键。
   * @param signal - 操作取消。
   * @returns 平台任务，重复创建只恢复同一任务。
   */
  async createPlatform(job: StoredImageJob, signal: AbortSignal): Promise<PlatformImageJob> {
    if (job.accountId === undefined) throw new ImageFailure('account-required')
    const request = job.request
    const references = await Promise.all(request.referenceImageIds.map(async (id) => {
      const image = await this.store.readImage(id, 'original')
      return { mime_type: image.mimeType, data_base64: image.bytes.toString('base64') }
    }))
    const mask = request.maskImageId === undefined ? undefined : await this.store.readImage(request.maskImageId, 'original')
    const body = { model: request.model.id, prompt: request.prompt, size: request.size, quality: request.quality,
      background: request.background, output_format: request.format, ...references.length ? { references } : {},
      ...request.compression === undefined ? {} : { output_compression: request.compression },
      ...request.moderation === undefined ? {} : { moderation: request.moderation },
      ...request.fidelity === undefined ? {} : { input_fidelity: request.fidelity },
      ...mask === undefined ? {} : { mask: { mime_type: mask.mimeType, data_base64: mask.bytes.toString('base64') } } }
    return platformJob.parse(this.json(await this.platformRequest('/v1/image-jobs', job.accountId, body, job.id, signal))).job
  }
  /**
   * 查询任务或请求取消尚未派发的平台任务。
   * @param job - 已取得平台标识的任务。
   * @param cancel - 是否尝试取消排队任务。
   * @param signal - 操作取消。
   * @returns 平台当前状态。
   */
  async platformStatus(job: StoredImageJob, cancel: boolean, signal: AbortSignal): Promise<PlatformImageJob> {
    if (job.accountId === undefined || job.remoteId === undefined) throw new ImageFailure('not-found')
    return platformJob.parse(this.json(await this.platformRequest(`/v1/image-jobs/${encodeURIComponent(job.remoteId)}${cancel ? '/cancel' : ''}`,
      job.accountId, cancel ? {} : undefined, undefined, signal))).job
  }
  /**
   * 在创建任务的账号下读取平台原图。
   * @param job - 已完成的远端任务。
   * @param signal - 操作取消。
   * @returns 平台保存的原始图片。
   */
  async platformImage(job: StoredImageJob, signal: AbortSignal): Promise<Buffer> {
    if (job.accountId === undefined || job.remoteId === undefined) throw new ImageFailure('not-found')
    const result = await this.platformRequest(`/v1/image-jobs/${encodeURIComponent(job.remoteId)}/image`, job.accountId,
      undefined, undefined, signal, this.config.maxImageBytes)
    this.checkStatus(result)
    return result.bytes
  }
  private async platformRequest(path: string, accountId: string, body?: object, idempotency?: string,
    signal?: AbortSignal, limit = this.config.maxImageBytes * 2): Promise<ImageHttpResponse> {
    if (await this.accountId() !== accountId) throw new ImageFailure('account-changed')
    const account = this.ctx.get('deepseekAccount')
    const url = new URL(path, this.platformOrigin)
    const token = await account?.resolveToken(url.href)
    if (token === undefined) throw new ImageFailure('account-required')
    if (await this.accountId() !== accountId) throw new ImageFailure('account-changed')
    const response = await this.network.request(url, { method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${token}`, ...body === undefined ? {} : { 'content-type': 'application/json' },
        ...idempotency === undefined ? {} : { 'idempotency-key': idempotency } },
      ...body === undefined ? {} : { body: Buffer.from(JSON.stringify(body)) } }, limit, signal)
    if (response.status === 401) { await account?.rejectToken(token); throw new ImageFailure('account-required') }
    if (await this.accountId() !== accountId) throw new ImageFailure('account-changed', true)
    return response
  }
  private json(response: ImageHttpResponse): unknown {
    this.checkStatus(response)
    try { return JSON.parse(response.bytes.toString('utf8')) }
    catch (_error) { throw new ImageFailure('upstream-rejected', true) }
  }
  private checkStatus(response: ImageHttpResponse): void {
    if (response.status >= 200 && response.status < 300) return
    if (response.status >= 300 && response.status < 400) throw new ImageFailure('unsafe-url', true)
    if (response.status === 401 || response.status === 403) throw new ImageFailure('credential-required')
    if (response.status === 402) throw new ImageFailure('insufficient-points')
    if (response.status === 409) throw new ImageFailure('conflict')
    throw new ImageFailure(response.status >= 500 ? 'upstream-unavailable' : 'upstream-rejected', response.status >= 500)
  }
}
