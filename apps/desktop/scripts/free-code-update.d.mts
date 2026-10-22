/** free code 指定的 GitHub 发布仓库。 */
export function freeCodeUpdateProvider(): { provider: 'github'; owner: string; repo: string; releaseType: 'draft' }
/** @param resourcesDir 资源目录。 @param updaterCacheDirName 缓存名称。 */
export function writeFreeCodeUpdateConfig(resourcesDir: string, updaterCacheDirName: string): Promise<void>
/** @param resourcesDir 待验证的资源目录。 */
export function verifyFreeCodeUpdateConfig(resourcesDir: string): Promise<void>
