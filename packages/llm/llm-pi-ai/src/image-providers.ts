/** 图片工作台读取现有提供商配置，不执行聊天模型解析或公开凭据值。 */
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { catalogProvider } from './catalog.ts'
import { providerDefaultsOf } from './provider-data.ts'
import { resolveImageModels } from './image-models.ts'
import type { ResolvedImageModelProfile } from './image-models.ts'

/** 图片执行使用的现有提供商端点与凭据地址。 */
export interface ResolvedImageProviderProfile {
  id: string
  displayName: string
  baseURL: string
  apiKeyEnv?: CredentialRef
  nativeApiKeyRefs: readonly CredentialRef[]
  headers: Readonly<Record<string, string>>
  imageModels: readonly ResolvedImageModelProfile[]
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('图片提供商设置必须是对象')
  return value as Record<string, unknown>
}

function endpoint(value: unknown, provider: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`图片提供商 ${provider} 尚未配置服务地址`)
  let url: URL
  try { url = new URL(value) } catch { throw new Error(`图片提供商 ${provider} 的服务地址无效`) }
  if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '' || url.hash !== '' || url.search !== '') {
    throw new Error(`图片提供商 ${provider} 的服务地址必须是没有账号、查询参数和片段的 HTTP(S) 地址`)
  }
  return value.replace(/\/+$/, '')
}

/**
 * 从合并后的设置描述读取图片提供商，复用现有目录的固定端点与凭据提示。
 * @param section - settings.describe() 返回的 llm-pi-ai 命名空间 value。
 * @returns 不含凭据值的提供商列表；只包含显式声明了图片模型的条目。
 */
export function resolveConfiguredImageProviders(section: unknown): readonly ResolvedImageProviderProfile[] {
  const providers = object(object(section)['providers'] ?? {})
  const result: ResolvedImageProviderProfile[] = []
  for (const [id, value] of Object.entries(providers)) {
    const profile = object(value)
    const imageModels = resolveImageModels(id, profile['imageModels'])
    if (imageModels.length === 0) continue
    const installed = catalogProvider(id)
    const defaults = installed === undefined ? undefined : providerDefaultsOf(installed)
    const baseURL = endpoint(profile['baseURL'] ?? defaults?.defaultBaseURL, id)
    const displayName = profile['displayName'] === undefined ? id : profile['displayName']
    if (typeof displayName !== 'string' || displayName.trim() === '') throw new Error(`图片提供商 ${id} 的显示名称无效`)
    const rawRef = profile['apiKeyEnv']
    if (rawRef !== undefined && typeof rawRef !== 'string') throw new Error(`图片提供商 ${id} 的凭据引用无效`)
    const apiKeyEnv = rawRef === undefined ? undefined : credentialRef(rawRef)
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(object(profile['headers'] ?? {}))) {
      if (typeof value !== 'string') throw new Error(`图片提供商 ${id} 的请求头无效`)
      new Headers([[key, value]])
      headers[key] = value
    }
    result.push({ id, displayName, baseURL, ...apiKeyEnv === undefined ? {} : { apiKeyEnv }, headers, imageModels,
      nativeApiKeyRefs: (defaults?.nativeAuth?.env ?? []).filter(ref => !defaults?.baseURLEnv?.includes(ref) && !ref.toLowerCase().includes('oauth')).map(credentialRef),
    })
  }
  return result
}
