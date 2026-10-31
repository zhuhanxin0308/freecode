// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { Config } from '@deepseek-ai/dsh-llm-pi-ai'
import { ImageModelEditor } from '../src/client/ImageModelEditor.tsx'
import { imageModelFailure, imageModelDrafts, imageModelValues, type ImageModelDraft } from '../src/client/image-model-drafts.ts'
import { CustomProviderCard } from '../src/client/CustomProviderCard.tsx'
import { ProviderEditor } from '../src/client/ProviderEditor.tsx'
import { en } from '../src/client/locales.ts'
import type { ModelsOperations } from '../src/client/operations.ts'
import { settingsSchema } from './settings-schema.client.ts'

afterEach(cleanup)
const t = (key: keyof typeof en): string => en[key]
const model: ImageModelDraft = {
  id: 'image-one', sizes: ['1024x1024'], qualities: ['auto'], backgrounds: ['auto'], formats: ['png'],
  supportsEdit: false, maxReferenceImages: 0, optionalParameters: [],
}

function namespace(): SettingsNamespaceView {
  const section = JSON.parse(JSON.stringify({ providers: { studio: { baseURL: 'https://images.example/v1', api: 'openai-completions',
    apiKeyEnv: 'SHARED_KEY', models: [{ id: 'chat-model' }], imageModels: [model] } } })) as JsonValue
  return { ns: 'llm-pi-ai', schema: JSON.parse(JSON.stringify(Config.toJSON())) as JsonValue,
    value: section, user: section, base: {}, revision: 7, autoGenerate: true, applies: 'live', secrets: [] }
}

function operations(view = namespace()) {
  return {
    writeSettings: vi.fn<ModelsOperations['writeSettings']>(async () => ({ kind: 'written', view })),
    storeCredential: vi.fn<ModelsOperations['storeCredential']>(async () => undefined),
    removeCredential: vi.fn<ModelsOperations['removeCredential']>(async () => undefined),
    discoverModels: vi.fn<ModelsOperations['discoverModels']>(async () => ({ kind: 'found', models: [] })),
  }
}

describe('图片模型编辑', () => {
  it('明确填写能力后才创建纯图片提供商，凭据仍使用已有提供商入口', async () => {
    const ops = operations()
    render(<CustomProviderCard taken={[]} protocols={['openai-completions']} reasoningLevels={[]} revision={7}
      operations={ops} t={t} readOnly={false} onClose={vi.fn()} />)
    fireEvent.change(screen.getByLabelText(en.providerPurpose), { target: { value: 'images' } })
    fireEvent.change(screen.getByLabelText(en.customRoute), { target: { value: 'studio' } })
    fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: 'https://images.example/v1' } })
    fireEvent.click(screen.getByRole('button', { name: en.addImageModel }))
    fireEvent.change(screen.getByLabelText(`${en.imageModelId} 1`), { target: { value: 'image-one' } })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.create }).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(`${en.imageSizes} 1`), { target: { value: '1024x1024, 1536x1024' } })
    expect(screen.getAllByLabelText(en.keyInput)).toHaveLength(1)
    fireEvent.change(screen.getByLabelText(en.keyInput), { target: { value: 'key-for-existing-provider-flow' } })
    fireEvent.click(screen.getByRole('button', { name: en.create }))
    await waitFor(() => { expect(ops.writeSettings).toHaveBeenCalledOnce() })
    expect(ops.writeSettings.mock.calls[0]?.[0]).toBe('llm-pi-ai')
    expect(ops.writeSettings.mock.calls[0]?.[2]).toBe(7)
    expect(ops.writeSettings.mock.calls[0]?.[1]).toMatchObject([{
      path: ['providers', 'studio'], value: { chatEnabled: false, apiKeyEnv: 'STUDIO_API_KEY', imageModels: [{ id: 'image-one', sizes: ['1024x1024', '1536x1024'] }] },
    }])
    expect(ops.storeCredential).toHaveBeenCalledExactlyOnceWith('STUDIO_API_KEY', 'key-for-existing-provider-flow')
  })

  it('编辑和移除图片模型仅写图片字段，保留聊天模型及现有凭据', async () => {
    const ops = operations()
    const props = { provider: 'studio', displayName: 'Studio', declared: true, namespace: namespace(), schema: settingsSchema,
      settingsPath: ['providers', 'studio'], operations: ops, t, readOnly: false, onClose: vi.fn() }
    const mounted = render(<ProviderEditor {...props} />)
    fireEvent.click(screen.getByText(en.customized))
    fireEvent.change(screen.getByLabelText(`${en.imageModelName} 1`), { target: { value: 'Art model' } })
    fireEvent.click(screen.getByRole('button', { name: en.apply }))
    await waitFor(() => { expect(ops.writeSettings).toHaveBeenCalledOnce() })
    expect(ops.writeSettings).toHaveBeenLastCalledWith('llm-pi-ai', [expect.objectContaining({ path: ['providers', 'studio', 'imageModels'] })], 7)
    expect(ops.storeCredential).not.toHaveBeenCalled()
    mounted.unmount()
    const remove = operations()
    render(<ProviderEditor {...props} operations={remove} />)
    fireEvent.click(screen.getByText(en.customized))
    fireEvent.click(screen.getByRole('button', { name: `${en.removeImageModel} 1` }))
    fireEvent.click(screen.getByRole('button', { name: en.apply }))
    await waitFor(() => { expect(remove.writeSettings).toHaveBeenCalledWith('llm-pi-ai', [{ op: 'set', path: ['providers', 'studio', 'imageModels'], value: [] }], 7) })
    expect(remove.removeCredential).not.toHaveBeenCalled()
  })

  it('陈旧修订拒绝保存时保留用户正在编辑的图片能力', async () => {
    const ops = operations()
    vi.mocked(ops.writeSettings).mockResolvedValue({ kind: 'conflict', message: 'stale' })
    const close = vi.fn()
    render(<ProviderEditor provider="studio" displayName="Studio" declared namespace={namespace()} schema={settingsSchema}
      settingsPath={['providers', 'studio']} operations={ops} t={t} readOnly={false} onClose={close} />)
    fireEvent.click(screen.getByText(en.customized))
    fireEvent.change(screen.getByLabelText(`${en.imageSizes} 1`), { target: { value: '1536x1024' } })
    fireEvent.click(screen.getByRole('button', { name: en.apply }))
    expect(await screen.findByText(en.conflict)).not.toBeNull()
    expect(screen.getByLabelText<HTMLInputElement>(`${en.imageSizes} 1`).value).toBe('1536x1024')
    expect(close).not.toHaveBeenCalled()
    expect(ops.storeCredential).not.toHaveBeenCalled()
  })

  it('切换参数能力同步可选值，参考图数量与编辑能力保持一致', () => {
    function Editor() {
      const [models, setModels] = useState<readonly ImageModelDraft[]>([model])
      return <ImageModelEditor models={models} onChange={setModels} t={t} disabled={false} />
    }
    render(<Editor />)
    fireEvent.click(screen.getByLabelText(`${en.imageQualityParameter} 1`))
    fireEvent.change(screen.getByLabelText(`${en.imageQualities} 1`), { target: { value: 'low, high' } })
    fireEvent.click(screen.getByLabelText(`${en.imageQualityParameter} 1`))
    expect(screen.getByLabelText<HTMLInputElement>(`${en.imageQualities} 1`).value).toBe('auto')
    expect(screen.getByLabelText<HTMLInputElement>(`${en.imageQualities} 1`).disabled).toBe(true)
    fireEvent.click(screen.getByLabelText(`${en.imageSupportsEdit} 1`))
    expect(screen.getByLabelText<HTMLInputElement>(`${en.imageReferenceLimit} 1`).value).toBe('1')
    fireEvent.click(screen.getByLabelText(`${en.imageSupportsMask} 1`))
    expect(screen.getByLabelText<HTMLInputElement>(`${en.imageSupportsMask} 1`).checked).toBe(true)
    fireEvent.change(screen.getByLabelText(`${en.imageReferenceLimit} 1`), { target: { value: '4' } })
    fireEvent.click(screen.getByLabelText(`${en.imageSupportsEdit} 1`))
    expect(screen.queryByLabelText(`${en.imageReferenceLimit} 1`)).toBeNull()
  })

  it('尺寸逐字输入不丢失分隔符，透明背景与格式组合有就地反馈', () => {
    function Editor() {
      const [models, setModels] = useState<readonly ImageModelDraft[]>([model])
      return <ImageModelEditor models={models} onChange={setModels} t={t} disabled={false} />
    }
    render(<Editor />)
    const sizes = screen.getByLabelText<HTMLInputElement>(`${en.imageSizes} 1`)
    fireEvent.change(sizes, { target: { value: '1024x1024,' } })
    expect(sizes.value).toBe('1024x1024,')
    fireEvent.change(sizes, { target: { value: '1024x1024,1536x1024' } })
    fireEvent.blur(sizes)
    expect(sizes.value).toBe('1024x1024, 1536x1024')
    fireEvent.click(screen.getByLabelText(`${en.imageBackgroundParameter} 1`))
    fireEvent.click(screen.getByLabelText(`${en.imageFormatParameter} 1`))
    fireEvent.click(screen.getByLabelText(`${en.imageBackgroundAuto} 1`))
    fireEvent.click(screen.getByLabelText(`${en.imageBackgroundTransparent} 1`))
    fireEvent.click(screen.getByLabelText('JPEG 1'))
    fireEvent.click(screen.getByLabelText('PNG 1'))
    expect(screen.getByRole('alert').textContent).toContain(en.imageTransparencyInvalid)
    fireEvent.click(screen.getByLabelText('WEBP 1'))
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(screen.getByLabelText(`${en.imageBackgroundParameter} 1`))
    fireEvent.click(screen.getByLabelText(`${en.imageFormatParameter} 1`))
    expect(screen.getByLabelText<HTMLInputElement>(`${en.imageBackgroundAuto} 1`).checked).toBe(true)
    expect(screen.getByLabelText<HTMLInputElement>('PNG 1').checked).toBe(true)
    fireEvent.click(screen.getByLabelText(`${en.imageSupportsEdit} 1`))
    fireEvent.change(screen.getByLabelText(`${en.imageReferenceLimit} 1`), { target: { value: '' } })
    expect(screen.getByRole('alert').textContent).toContain(en.imageReferenceInvalid)
  })

  it('本地表单拒绝重复标识和能力空集，保存值不携带聊天字段', () => {
    expect(imageModelDrafts(undefined)).toEqual([])
    expect(imageModelFailure([model, model])?.key).toBe('modelIdDuplicate')
    expect(imageModelFailure([{ ...model, sizes: ['1024x1024', '1024x1024'] }])?.key).toBe('imageCapabilitiesInvalid')
    expect(imageModelFailure([{ ...model, qualities: [] }])?.key).toBe('imageCapabilitiesInvalid')
    expect(imageModelFailure([{ ...model, supportsEdit: true, maxReferenceImages: 1.2 }])?.key).toBe('imageReferenceInvalid')
    expect(imageModelValues([{ ...model, name: '  ' }])[0]).not.toHaveProperty('name')
    const { optionalParameters: _optional, ...legacy } = model
    expect(imageModelValues([legacy])[0]).toHaveProperty('optionalParameters', [])
  })

  it('重置图片覆盖恢复部署提供的能力，不删除聊天配置', async () => {
    const view = namespace()
    view.base = { providers: { studio: { imageModels: [{ id: 'base-image', sizes: ['auto'], qualities: ['auto'], backgrounds: ['auto'], formats: ['png'], supportsEdit: false, maxReferenceImages: 0 }] } } }
    const ops = operations(view)
    render(<ProviderEditor provider="studio" displayName="Studio" declared namespace={view} schema={settingsSchema}
      settingsPath={['providers', 'studio']} operations={ops} t={t} readOnly={false} onClose={vi.fn()} />)
    fireEvent.click(screen.getByText(en.customized))
    fireEvent.click(screen.getByRole('button', { name: en.imageReset }))
    expect(screen.getByLabelText<HTMLInputElement>(`${en.imageModelId} 1`).value).toBe('base-image')
    fireEvent.click(screen.getByRole('button', { name: en.apply }))
    await waitFor(() => { expect(ops.writeSettings).toHaveBeenCalledWith('llm-pi-ai', [{ op: 'unset', path: ['providers', 'studio', 'imageModels'] }], 7) })
  })

  it('多行修改与删除保持其他模型，旧配置没有局部重绘声明时默认关闭', () => {
    function Editor() {
      const { optionalParameters: _optional, ...legacy } = model
      const [models, setModels] = useState<readonly ImageModelDraft[]>([{ ...legacy, name: '旧名称', supportsEdit: true, maxReferenceImages: 1 }, { ...model, id: 'second' }])
      return <ImageModelEditor models={models} onChange={setModels} t={t} disabled={false} />
    }
    render(<Editor />)
    expect(screen.getByLabelText<HTMLInputElement>(`${en.imageSupportsMask} 1`).checked).toBe(false)
    fireEvent.click(screen.getByLabelText(`${en.imageQualityParameter} 1`))
    expect(screen.getByLabelText<HTMLInputElement>(`${en.imageQualities} 1`).disabled).toBe(false)
    fireEvent.change(screen.getByLabelText(`${en.imageModelName} 1`), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText(`${en.imageModelId} 2`), { target: { value: 'second-renamed' } })
    expect(screen.getByLabelText<HTMLInputElement>(`${en.imageModelId} 1`).value).toBe('image-one')
    fireEvent.click(screen.getByRole('button', { name: `${en.removeImageModel} 1` }))
    expect(screen.getByLabelText<HTMLInputElement>(`${en.imageModelId} 1`).value).toBe('second-renamed')
  })

  it('纯图片提供商后续加入聊天模型时保留图片列表与已保存凭据', async () => {
    const view = namespace()
    const section: JsonValue = { providers: { studio: { chatEnabled: false, baseURL: 'https://images.example/v1',
      apiKeyEnv: 'SHARED_KEY', imageModels: imageModelValues([model]) } } }
    view.user = section
    view.value = section
    const ops = operations(view)
    render(<ProviderEditor provider="studio" displayName="Studio" declared namespace={view} schema={settingsSchema}
      settingsPath={['providers', 'studio']} operations={ops} t={t} readOnly={false} onClose={vi.fn()} />)
    fireEvent.click(screen.getByText(en.customized))
    expect(screen.queryByLabelText(`${en.modelId} 1`)).toBeNull()
    fireEvent.click(screen.getByLabelText(en.chatModelsEnabled))
    fireEvent.click(screen.getByRole('button', { name: en.addModel }))
    fireEvent.change(screen.getByLabelText(`${en.modelId} 1`), { target: { value: 'chat-added' } })
    fireEvent.click(screen.getByRole('button', { name: en.apply }))
    await waitFor(() => { expect(ops.writeSettings).toHaveBeenCalledOnce() })
    const changes = ops.writeSettings.mock.calls[0]?.[1] ?? []
    expect(changes).toHaveLength(3)
    expect(changes).toContainEqual({ op: 'set', path: ['providers', 'studio', 'chatEnabled'], value: true })
    expect(changes).toContainEqual({ op: 'set', path: ['providers', 'studio', 'api'], value: 'openai-completions' })
    expect(changes.some(change => change.path.includes('imageModels') || change.path.includes('apiKeyEnv'))).toBe(false)
    expect(ops.storeCredential).not.toHaveBeenCalled()
  })
})
