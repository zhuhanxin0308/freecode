import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dump, load } from 'js-yaml'
import { PRODUCT_BRAND } from '../src/product-brand.ts'

const UPDATE_CONFIG = 'app-update.yml'

/** 返回签名产物唯一允许使用的 GitHub 更新提供方。 */
export function freeCodeUpdateProvider() {
  return { provider: 'github', ...PRODUCT_BRAND.repository, releaseType: 'draft' }
}

/**
 * 在签名前写入更新来源，Windows 与 macOS 使用同一个配置。
 * @param {string} resourcesDir 安装包资源目录。
 * @param {string} updaterCacheDirName 独立产品的下载缓存名称。
 */
export async function writeFreeCodeUpdateConfig(resourcesDir, updaterCacheDirName) {
  if (!updaterCacheDirName?.trim()) throw new Error('free code: updater cache directory is required')
  await writeFile(join(resourcesDir, UPDATE_CONFIG), dump({ ...freeCodeUpdateProvider(), updaterCacheDirName }))
}

/**
 * 验证打包后的更新来源，拒绝官方地址、其他仓库与缺失的缓存目录。
 * @param {string} resourcesDir 安装包资源目录。
 */
export async function verifyFreeCodeUpdateConfig(resourcesDir) {
  const config = load(await readFile(join(resourcesDir, UPDATE_CONFIG), 'utf8'))
  if (config === null || typeof config !== 'object' || Array.isArray(config)
    || config.provider !== 'github' || config.owner !== PRODUCT_BRAND.repository.owner
    || config.repo !== PRODUCT_BRAND.repository.repo || config.url !== undefined || config.host !== undefined || config.protocol !== undefined
    || typeof config.updaterCacheDirName !== 'string' || !config.updaterCacheDirName.trim()) {
    throw new Error('free code: packaged updater must use zhuhanxin0308/freecode')
  }
}
