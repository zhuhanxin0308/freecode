/** 常用参数始终可见，模型专属选项放入原生可折叠高级设置。 */
import type { ImageModelDescriptor } from '../types.ts'
import type { ImageDraft } from './draft.ts'
import { chooseImageSize, imageRatio, imageResolution, IMAGE_RATIOS, type ImageResolution } from './image-sizing.ts'
import type { ImageWorkbenchKey } from './locales.ts'
import css from './Workbench.module.css'

interface Props {
  draft: ImageDraft
  model: ImageModelDescriptor | undefined
  maxBatch: number | undefined
  change: (next: ImageDraft) => void
  t: (key: ImageWorkbenchKey) => string
}

/**
 * 展示无需展开的常用创作参数。
 * @param props - 模型能力、草稿及更新动作。
 * @returns 张数、分辨率、比例与实际输出尺寸。
 */
export function ImageSizeParameters({ draft, model, maxBatch, change, t }: Props) {
  const resolution = draft.resolution ?? imageResolution(draft.size)
  const ratio = draft.ratio ?? imageRatio(draft.size)
  const precise = draft.mask !== undefined
  const sizes = model?.sizes ?? []
  const size = (resolution: ImageResolution, ratio: string) => {
    change({ ...draft, resolution, ratio, size: chooseImageSize(sizes, resolution, ratio).size })
  }
  const actual = precise && draft.references[0] !== undefined ? `${draft.references[0].width} × ${draft.references[0].height}` : draft.size.replace('x', ' × ')
  const adjusted = !precise && draft.resolution !== undefined && chooseImageSize(model?.sizes ?? [], resolution, ratio).adjusted
  return <>
    <div className={css.primaryParameters}>
      <label className={css.field}>{t('count')}<input className={css.input} type="number" min={1} max={maxBatch} step={1} value={draft.count}
        onChange={(event) => { change({ ...draft, count: Number(event.target.value) }) }} /></label>
      <label className={css.field}>{t('resolution')}<select className={css.select} value={resolution} disabled={model === undefined || precise}
        onChange={(event) => { size(event.target.value as ImageResolution, ratio) }}>
        <option value="1k">{t('resolution1k')}</option><option value="2k">{t('resolution2k')}</option><option value="4k">{t('resolution4k')}</option>
      </select></label>
      <label className={css.field}>{t('aspectRatio')}<select className={css.select} value={ratio} disabled={model === undefined || precise}
        onChange={(event) => { size(resolution, event.target.value) }}>
        {IMAGE_RATIOS.map(value => <option key={value} value={value}>{value}</option>)}
      </select></label>
    </div>
    <div className={css.outputSummary} role="status"><span>{t('actualOutput')}</span><strong>{actual}</strong>
      {precise ? <p>{t('preciseOutput')}</p> : adjusted ? <p>{t('sizeAdjusted')}</p> : null}
    </div>
  </>
}

/**
 * 按模型能力提供默认收起的高级选项。
 * @param props - 模型能力、草稿及更新动作。
 * @returns 仅包含可用选项的高级设置。
 */
export function ImageAdvancedParameters({ draft, model, change, t }: Omit<Props, 'maxBatch'>) {
  const precise = draft.mask !== undefined
  const transparentFormat = model?.formats.find(value => value !== 'jpeg') ?? 'png'
  const supports = (parameter: ImageModelDescriptor['optionalParameters'][number]) => model?.optionalParameters.includes(parameter) === true
  const optionText = (value: string): string => ['auto', 'low', 'medium', 'high', 'xhigh', 'max', 'opaque', 'transparent'].includes(value)
    ? t(value as 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'opaque' | 'transparent') : value.toUpperCase()
  return <details className={css.advanced}>
    <summary>{t('advancedSettings')}<span className={css.hint}>{t('advancedHint')}</span></summary>
    <div className={css.parameterGrid}>
      {supports('quality') && <label className={css.field}>{t('quality')}<select className={css.select} value={draft.quality} disabled={model?.qualities.length === 1}
        onChange={(event) => { change({ ...draft, quality: event.target.value }) }}>
        {model?.qualities.map(value => <option key={value} value={value}>{optionText(value)}</option>)}
      </select></label>}
      {supports('background') && <label className={css.field}>{t('background')}<select className={css.select} value={draft.background} disabled={model?.backgrounds.length === 1}
        onChange={(event) => {
          const value = model?.backgrounds.find(value => value === event.target.value)
          if (value !== undefined) change({ ...draft, background: value, format: value === 'transparent' && draft.format === 'jpeg' ? transparentFormat : draft.format })
        }}>{model?.backgrounds.map(value => <option key={value} value={value}>{optionText(value)}</option>)}</select></label>}
      {supports('output_format') && <label className={css.field}>{t('format')}<select className={css.select} value={precise ? 'png' : draft.format} disabled={precise || model?.formats.length === 1}
        onChange={(event) => {
          const value = model?.formats.find(value => value === event.target.value)
          if (value !== undefined) change({ ...draft, format: value })
        }}>{model?.formats.filter(value => value !== 'jpeg' || draft.background !== 'transparent').map(value => <option key={value} value={value}>{value.toUpperCase()}</option>)}</select></label>}
      {supports('output_compression') && !precise && draft.format !== 'png' && <label className={css.field}>{t('compression')}
        <input className={css.input} type="number" min={0} max={100} step={1} placeholder={t('auto')} value={draft.compression ?? ''}
          onChange={(event) => {
            const next = { ...draft }
            if (event.target.value === '') delete next.compression
            else next.compression = Number(event.target.value)
            change(next)
          }} /><span className={css.hint}>{t('compressionHint')}</span></label>}
      {supports('moderation') && <label className={css.field}>{t('moderation')}<select className={css.select} value={draft.moderation ?? 'auto'}
        onChange={(event) => { change({ ...draft, moderation: event.target.value === 'low' ? 'low' : 'auto' }) }}>
        <option value="auto">{t('auto')}</option><option value="low">{t('moderationLow')}</option>
      </select></label>}
      {supports('input_fidelity') && draft.references.length > 0 && <label className={css.field}>{t('fidelity')}<select className={css.select} value={draft.fidelity ?? ''}
        onChange={(event) => {
          const next = { ...draft }
          if (event.target.value === '') delete next.fidelity
          else next.fidelity = event.target.value === 'high' ? 'high' : 'low'
          change(next)
        }}><option value="">{t('auto')}</option><option value="low">{t('low')}</option><option value="high">{t('high')}</option>
      </select></label>}
      <label className={css.field}>{t('nativeSize')}<select className={css.select} value={draft.size} disabled={model === undefined || precise}
        onChange={(event) => {
          const size = event.target.value
          change({ ...draft, size, resolution: imageResolution(size), ratio: imageRatio(size) })
        }}>
        {model?.sizes.map(value => <option key={value} value={value}>{value.replace('x', ' × ')}</option>)}</select></label>
    </div>
  </details>
}
