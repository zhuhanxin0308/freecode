// @vitest-environment jsdom
/** 模型能力变化、高级参数及精确编辑的表单交互。 */
import { useState, type ComponentProps } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ImageAdvancedParameters, ImageSizeParameters } from '../src/client/ImageParameters.tsx'
import { createDraft, type ImageDraft } from '../src/client/draft.ts'
import { en } from '../src/client/locales.ts'
import type { ImageAssetId, ImageModelDescriptor } from '../src/types.ts'

afterEach(cleanup)
const model: ImageModelDescriptor = { ref: { source: 'custom', provider: 'mine', id: 'image' }, name: 'Image', providerName: 'Mine', available: true,
  sizes: ['1024x1024', '3840x2160'], qualities: ['auto', 'high', 'xhigh', 'max'], backgrounds: ['auto', 'transparent'], formats: ['png', 'jpeg', 'webp'],
  supportsEdit: true, supportsMask: true, maxReferenceImages: 4, optionalParameters: ['quality', 'background', 'output_format', 'output_compression', 'moderation', 'input_fidelity'] }
const t = (key: keyof typeof en) => en[key]
const image = { id: 'image' as ImageAssetId, mimeType: 'image/png' as const, width: 1024, height: 1024, bytes: 100 }
function ImageParameters(props: ComponentProps<typeof ImageSizeParameters>) {
  return <><ImageSizeParameters {...props} /><ImageAdvancedParameters {...props} /></>
}
function Form({ initial, changed }: { initial: ImageDraft; changed: (draft: ImageDraft) => void }) {
  const [draft, setDraft] = useState(initial)
  return <ImageParameters draft={draft} model={model} maxBatch={4} change={(value) => { setDraft(value); changed(value) }} t={t} />
}

it('高级设置默认折叠，按格式和参考图显示可用选项', () => {
  const changed = vi.fn<(draft: ImageDraft) => void>()
  render(<Form initial={{ ...createDraft(model), references: [image] }} changed={changed} />)
  expect(document.querySelector('details')?.open).toBe(false)
  expect(screen.queryByLabelText(en.compression)).toBeNull()
  fireEvent.click(screen.getByText(en.advancedSettings))
  fireEvent.change(screen.getByLabelText(en.format), { target: { value: 'jpeg' } })
  const compression = screen.getByLabelText(new RegExp(en.compression))
  fireEvent.change(compression, { target: { value: '85' } })
  expect(changed.mock.lastCall?.[0].compression).toBe(85)
  fireEvent.change(compression, { target: { value: '' } })
  expect(changed.mock.lastCall?.[0]).not.toHaveProperty('compression')
  fireEvent.change(screen.getByLabelText(en.moderation), { target: { value: 'low' } })
  expect(changed.mock.lastCall?.[0].moderation).toBe('low')
  fireEvent.change(screen.getByLabelText(en.moderation), { target: { value: 'auto' } })
  fireEvent.change(screen.getByLabelText(en.fidelity), { target: { value: 'high' } })
  expect(changed.mock.lastCall?.[0].fidelity).toBe('high')
  fireEvent.change(screen.getByLabelText(en.fidelity), { target: { value: 'low' } })
  fireEvent.change(screen.getByLabelText(en.fidelity), { target: { value: '' } })
  expect(changed.mock.lastCall?.[0]).not.toHaveProperty('fidelity')
  fireEvent.change(screen.getByLabelText(en.background), { target: { value: 'transparent' } })
  expect(changed.mock.lastCall?.[0].format).toBe('png')
  expect(screen.queryByLabelText(en.compression)).toBeNull()
  fireEvent.change(screen.getByLabelText(en.nativeSize), { target: { value: '3840x2160' } })
  expect(changed.mock.lastCall?.[0]).toMatchObject({ resolution: '4k', ratio: '16:9', size: '3840x2160' })
})

it('精确编辑显示原图尺寸并锁定 PNG；无模型时不显示无效高级选项', () => {
  const changed = vi.fn()
  const draft = { ...createDraft(model), references: [image], mask: image }
  const mounted = render(<ImageParameters draft={draft} model={model} maxBatch={4} change={changed} t={t} />)
  expect(screen.getByText(en.preciseOutput)).not.toBeNull()
  expect(screen.getByLabelText<HTMLSelectElement>(en.resolution).disabled).toBe(true)
  expect(screen.getByLabelText<HTMLSelectElement>(en.format).value).toBe('png')
  expect(screen.getByLabelText<HTMLSelectElement>(en.format).disabled).toBe(true)
  mounted.rerender(<ImageParameters draft={createDraft()} model={undefined} maxBatch={undefined} change={changed} t={t} />)
  expect(screen.queryByLabelText(en.quality)).toBeNull()
  expect(screen.queryByLabelText(en.moderation)).toBeNull()
})
