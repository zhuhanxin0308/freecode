import { describe, expect, it } from 'vitest'
import { createElectronBuilderConfig } from '../scripts/electron-builder-config.mjs'

describe('free code 安装包身份与更新来源', () => {
  it('Windows 本地构建不依赖官方服务，也不会接管官方协议', () => {
    const config = createElectronBuilderConfig({ DSH_DESKTOP_UNSIGNED: '1' }, 'win32', 'x64')
    expect(config.appId).toBe('io.github.zhuhanxin0308.freecode')
    expect(config.productName).toBe('free code')
    expect(config.protocols).toEqual([{ name: 'free code', schemes: ['freecode'] }])
    expect(config.artifactName).toBe('freecode-${version}-${os}-${arch}-unsigned.${ext}')
    expect(config.publish).toBeNull()
    expect(config.extraMetadata).not.toHaveProperty('dshMandatoryUpdatePolicy')
  })

  it('签名发布仅使用指定的 GitHub 仓库，不继承环境中的官方更新地址', () => {
    const config = createElectronBuilderConfig({
      DSH_DESKTOP_MACOS_SKIP_NOTARIZATION: '1',
      DSH_DESKTOP_MACOS_SIGNING_IDENTITY: 'Example Company (TEAMID1234)',
      DSH_DESKTOP_MACOS_TEAM_ID: 'TEAMID1234',
      DSH_DESKTOP_AUTO_UPDATE_ENV: 'production',
      DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN: 'https://download.deepseek.com',
    }, 'darwin', 'arm64')
    expect(config.publish).toEqual([{ provider: 'github', owner: 'zhuhanxin0308', repo: 'freecode', releaseType: 'draft' }])
    expect(config.extraMetadata).not.toHaveProperty('dshMandatoryUpdatePolicy')
  })

  it('拒绝用官方应用标识生成 free code 安装包', () => {
    expect(() => createElectronBuilderConfig({ DSH_DESKTOP_APP_ID: 'com.deepseek.harness', DSH_DESKTOP_UNSIGNED: '1' }))
      .toThrow('upstream application identifier is reserved')
  })
})
