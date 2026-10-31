import { describe, expect, it } from 'vitest'
import { Config, resolveProfiles, type Options } from '../src/config.ts'
import { resolveImageModels } from '../src/image-models.ts'
import type { ImageModelProfile } from '../src/image-models.ts'
import { resolveConfiguredImageProviders } from '../src/image-providers.ts'

const image: ImageModelProfile = {
  id: 'image-model', sizes: ['1024x1024'], qualities: ['auto'], backgrounds: ['auto'],
  formats: ['png'], supportsEdit: false, maxReferenceImages: 0,
}

describe('图片模型配置与聊天目录分离', () => {
  it('未配置图片时不猜测能力，也不要求额外端点', () => {
    expect(resolveConfiguredImageProviders({ providers: { openai: {} } })).toEqual([])
    expect(resolveImageModels('openai', undefined)).toEqual([])
  })

  it('纯图片提供商不需要聊天协议或聊天模型', () => {
    const section = Config({ providers: { studio: { chatEnabled: false, baseURL: 'https://images.example/v1', imageModels: [image] } } })
    const profile = resolveProfiles(structuredClone(section.providers.get()) as Options['providers']).get('studio')
    expect(profile?.chatEnabled).toBe(false)
    expect(profile?.piProvider).toBeUndefined()
    expect(profile?.catalogError).toBeUndefined()
    expect(resolveConfiguredImageProviders({ providers: section.providers.get() })[0]).toMatchObject({
      id: 'studio', baseURL: 'https://images.example/v1', imageModels: [{ id: 'image-model', name: 'image-model', optionalParameters: [] }],
    })
  })

  it('混合提供商保持聊天模型集合与同一个凭据引用', () => {
    const providers = { studio: {
      api: 'openai-completions', baseURL: 'https://images.example/v1', apiKeyEnv: 'SHARED_KEY',
      models: [{ id: 'chat-model' }], imageModels: [image],
    } }
    const profile = resolveProfiles(providers).get('studio')
    expect(profile?.piProvider?.getModels().map(model => model.id)).toEqual(['chat-model'])
    const images = resolveConfiguredImageProviders({ providers })
    expect(images[0]?.apiKeyEnv).toBe('SHARED_KEY')
    expect(images[0]?.imageModels.map(model => model.id)).toEqual(['image-model'])
    expect(resolveProfiles({ studio: { ...providers.studio, imageModels: [] } }).get('studio')?.piProvider?.getModels().map(model => model.id)).toEqual(['chat-model'])
  })

  it('内置目录端点与凭据提示被复用，纯图片模式不会恢复聊天目录', () => {
    const providers = { openai: { chatEnabled: false, imageModels: [image] } }
    const result = resolveConfiguredImageProviders({ providers })
    expect(result[0]).toMatchObject({ baseURL: 'https://api.openai.com/v1', nativeApiKeyRefs: ['OPENAI_API_KEY'] })
    expect(resolveProfiles(providers).get('openai')?.piProvider).toBeUndefined()
  })

  it('能力声明被复制，缺省可选参数不被误认为支持', () => {
    const source = [{ ...image, sizes: ['1024x1024'] }]
    const resolved = resolveImageModels('studio', source)
    source[0]!.sizes.push('1536x1024')
    expect(resolved[0]?.sizes).toEqual(['1024x1024'])
    expect(resolved[0]?.optionalParameters).toEqual([])
  })

  it('明确支持的编辑、局部重绘与透明输出选项被完整保留', () => {
    const resolved = resolveImageModels('studio', [{ ...image, id: ' image-edit ', name: ' 图片编辑 ',
      sizes: ['auto', '1536x1024'], qualities: ['auto', 'high'], backgrounds: ['auto', 'transparent'], formats: ['png', 'webp'],
      optionalParameters: ['quality', 'background', 'output_format'], supportsEdit: true, supportsMask: true, maxReferenceImages: 4,
    }])
    expect(resolved[0]).toMatchObject({ id: 'image-edit', name: '图片编辑', supportsEdit: true, supportsMask: true,
      maxReferenceImages: 4, sizes: ['auto', '1536x1024'], qualities: ['auto', 'high'], backgrounds: ['auto', 'transparent'], formats: ['png', 'webp'] })
  })

  it.each([
    { sizes: [] }, { sizes: ['0x1024'] }, { sizes: ['1024X1024'] }, { sizes: ['auto', 'auto'] },
    { qualities: [] }, { qualities: ['high'] }, { backgrounds: ['transparent'] }, { formats: ['webp'] },
    { formats: ['gif'] }, { supportsEdit: false, maxReferenceImages: 1 }, { supportsEdit: true, maxReferenceImages: 0 },
    { supportsMask: true }, { supportsMask: 'yes' },
    { maxReferenceImages: 1.5 }, { optionalParameters: ['n'] }, { optionalParameters: ['quality', 'quality'] },
    { id: '' }, { id: 1 }, { name: '' }, { name: 'bad\nname' }, { sizes: 'auto' }, { qualities: [false] },
    { supportsEdit: 'yes' }, { maxReferenceImages: -1 }, { maxReferenceImages: Number.NaN }, { maxReferenceImages: Number.MAX_SAFE_INTEGER + 1 },
    { optionalParameters: ['background', 'output_format'], backgrounds: ['transparent'], formats: ['jpeg'] },
    { unknownCapability: true },
  ])('拒绝不完整或互相矛盾的图片能力 %#', (patch) => {
    expect(() => resolveImageModels('studio', [{ ...image, ...patch }])).toThrow()
  })

  it('拒绝重复图片标识，但同名聊天与图片模型属于不同目录', () => {
    expect(() => resolveImageModels('studio', [image, image])).toThrow(/重复/)
    expect(() => resolveProfiles({ studio: {
      api: 'openai-completions', baseURL: 'https://images.example/v1', models: [{ id: 'image-model' }], imageModels: [image],
    } })).not.toThrow()
  })

  it('配置读取拒绝无端点、非法凭据引用和未知截断输入', () => {
    for (const section of [null, [], { providers: [] }, { providers: { studio: { imageModels: [image] } } },
      { providers: { studio: { baseURL: 'file:///secret', imageModels: [image] } } },
      { providers: { studio: { baseURL: 'https://example.test', apiKeyEnv: 'bad key', imageModels: [image] } } }]) {
      expect(() => resolveConfiguredImageProviders(section)).toThrow()
    }
  })

  it('图片配置入口拒绝无效行，并校验现有地址与请求头', () => {
    for (const value of [null, {}, [null], [false], [[]]]) expect(() => resolveImageModels('studio', value)).toThrow()
    for (const patch of [
      { baseURL: '' }, { baseURL: 'invalid-url' }, { baseURL: 'https://user:password@example.test' },
      { baseURL: 'https://example.test?q=1' }, { baseURL: 'https://example.test#part' },
      { displayName: 1 }, { displayName: '' }, { apiKeyEnv: 1 }, { headers: [] },
      { headers: { 'X-Test': false } }, { headers: { 'X-Test': 'bad\nvalue' } },
    ]) expect(() => resolveConfiguredImageProviders({ providers: { studio: { baseURL: 'https://images.example/v1', imageModels: [image], ...patch } } })).toThrow()
    expect(resolveConfiguredImageProviders({})).toEqual([])
    expect(resolveConfiguredImageProviders({ providers: { studio: { displayName: 'Studio', baseURL: 'https://images.example/v1/', imageModels: [image], headers: { 'X-Project': 'project' } } } })[0])
      .toMatchObject({ displayName: 'Studio', baseURL: 'https://images.example/v1', headers: { 'X-Project': 'project' } })
  })
})
