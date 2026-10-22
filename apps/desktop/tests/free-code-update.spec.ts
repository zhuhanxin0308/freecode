import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, onTestFinished } from 'vitest'
import { dump, load } from 'js-yaml'
import { writeFreeCodeUpdateConfig, verifyFreeCodeUpdateConfig } from '../scripts/free-code-update.mjs'

async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'freecode-update-'))
  onTestFinished(() => rm(path, { recursive: true, force: true }))
  return path
}

describe('安装包的 GitHub 更新配置', () => {
  it('写入并验证独立仓库及下载缓存', async () => {
    const path = await directory()
    await writeFreeCodeUpdateConfig(path, 'freecode-desktop-updater')
    expect(load(await readFile(join(path, 'app-update.yml'), 'utf8'))).toMatchObject({
      provider: 'github', owner: 'zhuhanxin0308', repo: 'freecode', updaterCacheDirName: 'freecode-desktop-updater',
    })
    await expect(verifyFreeCodeUpdateConfig(path)).resolves.toBeUndefined()
  })

  it.each([null, [], { provider: 'generic', url: 'https://download.deepseek.com' },
    { provider: 'github', owner: 'another-owner', repo: 'freecode', updaterCacheDirName: 'cache' },
    { provider: 'github', owner: 'zhuhanxin0308', repo: 'other', updaterCacheDirName: 'cache' },
    { provider: 'github', owner: 'zhuhanxin0308', repo: 'freecode', url: 'https://example.com', updaterCacheDirName: 'cache' },
    { provider: 'github', owner: 'zhuhanxin0308', repo: 'freecode', host: 'example.com', updaterCacheDirName: 'cache' },
    { provider: 'github', owner: 'zhuhanxin0308', repo: 'freecode', protocol: 'http', updaterCacheDirName: 'cache' },
    { provider: 'github', owner: 'zhuhanxin0308', repo: 'freecode', updaterCacheDirName: ' ' },
  ])('拒绝被改写或不完整的更新配置 %#', async (config) => {
    const path = await directory()
    await writeFile(join(path, 'app-update.yml'), dump(config))
    await expect(verifyFreeCodeUpdateConfig(path)).rejects.toThrow('packaged updater must use')
  })

  it('在配置缺失或缓存名称为空时失败，不猜测其他更新源', async () => {
    const path = await directory()
    await expect(verifyFreeCodeUpdateConfig(path)).rejects.toThrow()
    await expect(writeFreeCodeUpdateConfig(path, '')).rejects.toThrow('cache directory is required')
  })
})
