/** 现有提供商内的图片能力编辑器，不另设地址或凭据输入。 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import type { ImageModelProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import type { ImageModelDraft } from './image-model-drafts.ts'
import { imageModelFailure, imageOptionValues, newImageModelDraft } from './image-model-drafts.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'
import imageStyles from './ImageModelEditor.module.css'

/** 图片模型列表的受控表单属性。 */
export interface ImageModelEditorProps {
  models: readonly ImageModelDraft[]
  onChange: (models: ImageModelDraft[]) => void
  onReset?: () => void
  disabled: boolean
  t: (key: keyof typeof en) => string
}

type Parameter = NonNullable<ImageModelProfile['optionalParameters']>[number]

/** 输入期间保留分隔符；只有外部值发生实质变化时才采用规范化的显示。 */
function OptionsInput(props: {
  value: readonly string[]
  onChange: (value: string[]) => void
  label: string
  disabled: boolean
  placeholder?: string
}): ReactNode {
  const [draft, setDraft] = useState(() => props.value.join(', '))
  const same = JSON.stringify(imageOptionValues(draft)) === JSON.stringify(props.value)
  return <input className={styles['input']} value={same ? draft : props.value.join(', ')} placeholder={props.placeholder}
    disabled={props.disabled} aria-label={props.label} onBlur={() => { setDraft(props.value.join(', ')) }}
    onChange={(event) => { setDraft(event.target.value); props.onChange(imageOptionValues(event.target.value)) }} />
}

/**
 * 显示显式图片能力及参考图编辑选项。
 * @param props - 图片列表、修改动作与本地化文案。
 * @returns 提供商卡片内的图片能力表单。
 */
export function ImageModelEditor(props: ImageModelEditorProps): ReactNode {
  const { models, onChange, disabled, t } = props
  const failure = imageModelFailure(models)
  const update = (index: number, patch: Partial<ImageModelDraft>): void => {
    onChange(models.map((model, at) => at === index ? { ...model, ...patch } : { ...model }))
  }
  const parameter = (index: number, model: ImageModelDraft, field: Parameter, enabled: boolean): void => {
    const current = model.optionalParameters ?? []
    const optionalParameters = enabled ? [...current, field] : current.filter(value => value !== field)
    const reset: Partial<ImageModelDraft> = enabled ? {} : field === 'quality' ? { qualities: ['auto'] }
      : field === 'background' ? { backgrounds: ['auto'] } : { formats: ['png'] }
    update(index, { ...reset, optionalParameters })
  }
  return <section className={imageStyles['editor']} aria-label={t('imageModels')}>
    <div className={imageStyles['heading']}>
      <span className={styles['modelCatalogTitle']}>{t('imageModels')}</span>
      {props.onReset === undefined ? null : <button type="button" className={styles['linkButton']} disabled={disabled} onClick={props.onReset}>{t('imageReset')}</button>}
    </div>
    <p className={styles['advancedHint']}>{t('imageModelsHint')}</p>
    {models.length === 0 ? <p className={styles['advancedHint']}>{t('imageModelsEmpty')}</p> : null}
    {models.map((model, index) => {
      const position = String(index + 1)
      const optional = model.optionalParameters ?? []
      const supports = (field: Parameter): boolean => optional.includes(field)
      return <fieldset className={imageStyles['model']} key={index}>
        <legend className={imageStyles['legend']}>{`${t('purposeImages')} ${position}`}</legend>
        <div className={imageStyles['grid']}>
          {(['id', 'name'] as const).map(field => <label className={styles['modelField']} key={field}>
            <span className={styles['modelFieldLabel']}>{t(field === 'id' ? 'imageModelId' : 'imageModelName')}</span>
            <input className={styles['input']} value={model[field] ?? ''} disabled={disabled}
              aria-label={`${t(field === 'id' ? 'imageModelId' : 'imageModelName')} ${position}`}
              onChange={(event) => {
                if (field === 'id') update(index, { id: event.target.value })
                else {
                  const { name: _name, ...rest } = model
                  onChange(models.map((row, at) => at !== index ? { ...row } : event.target.value === '' ? rest : { ...model, name: event.target.value }))
                }
              }} />
          </label>)}
          <label className={`${styles['modelField']} ${imageStyles['wide']}`}>
            <span className={styles['modelFieldLabel']}>{t('imageSizes')}</span>
            <OptionsInput value={model.sizes} placeholder={t('imageSizesPlaceholder')} disabled={disabled}
              label={`${t('imageSizes')} ${position}`} onChange={(sizes) => { update(index, { sizes }) }} />
            <span className={styles['advancedHint']}>{t('imageListHint')}</span>
          </label>
          <div className={`${imageStyles['options']} ${imageStyles['wide']}`}>
            {([['quality', 'imageQualityParameter'], ['background', 'imageBackgroundParameter'], ['output_format', 'imageFormatParameter']] as const).map(([field, key]) =>
              <label className={imageStyles['check']} key={field}><input type="checkbox" checked={supports(field)} disabled={disabled}
                aria-label={`${t(key)} ${position}`} onChange={(event) => { parameter(index, model, field, event.target.checked) }} />{t(key)}</label>)}
          </div>
          <label className={`${styles['modelField']} ${imageStyles['wide']}`}>
            <span className={styles['modelFieldLabel']}>{t('imageQualities')}</span>
            <OptionsInput value={model.qualities} disabled={disabled || !supports('quality')}
              label={`${t('imageQualities')} ${position}`} onChange={(qualities) => { update(index, { qualities }) }} />
          </label>
          <fieldset className={imageStyles['choices']} disabled={disabled || !supports('background')}>
            <legend className={styles['modelFieldLabel']}>{t('imageBackgrounds')}</legend>
            <div className={imageStyles['options']}>{(['auto', 'opaque', 'transparent'] as const).map((value) => {
              const key = value === 'auto' ? 'imageBackgroundAuto' : value === 'opaque' ? 'imageBackgroundOpaque' : 'imageBackgroundTransparent'
              return <label key={value} className={imageStyles['check']}><input type="checkbox" checked={model.backgrounds.includes(value)}
                aria-label={`${t(key)} ${position}`} onChange={(event) => {
                  const backgrounds = event.target.checked
                    ? [...model.backgrounds, value] : model.backgrounds.filter(item => item !== value)
                  update(index, { backgrounds })
                }} />{t(key)}</label>
            })}</div>
          </fieldset>
          <fieldset className={imageStyles['choices']} disabled={disabled || !supports('output_format')}>
            <legend className={styles['modelFieldLabel']}>{t('imageFormats')}</legend>
            <div className={imageStyles['options']}>{(['png', 'jpeg', 'webp'] as const).map(value => <label key={value} className={imageStyles['check']}>
              <input type="checkbox" checked={model.formats.includes(value)} aria-label={`${value.toUpperCase()} ${position}`}
                onChange={(event) => {
                  const formats = event.target.checked ? [...model.formats, value] : model.formats.filter(item => item !== value)
                  update(index, { formats })
                }} />{value.toUpperCase()}
            </label>)}</div>
          </fieldset>
          <label className={`${imageStyles['check']} ${imageStyles['wide']}`}><input type="checkbox" checked={model.supportsEdit} disabled={disabled}
            aria-label={`${t('imageSupportsEdit')} ${position}`} onChange={(event) => {
              update(index, { supportsEdit: event.target.checked, supportsMask: event.target.checked ? model.supportsMask ?? false : false,
                maxReferenceImages: event.target.checked ? Math.max(1, model.maxReferenceImages) : 0 })
            }} />{t('imageSupportsEdit')}</label>
          {model.supportsEdit ? <>
            <label className={styles['modelField']}>
              <span className={styles['modelFieldLabel']}>{t('imageReferenceLimit')}</span>
              <input type="number" min={1} step={1} className={styles['input']} disabled={disabled}
                value={Number.isFinite(model.maxReferenceImages) ? model.maxReferenceImages : ''} aria-label={`${t('imageReferenceLimit')} ${position}`}
                onChange={(event) => { update(index, { maxReferenceImages: event.target.value === '' ? Number.NaN : Number(event.target.value) }) }} />
            </label>
            <label className={imageStyles['check']}><input type="checkbox" checked={model.supportsMask ?? false} disabled={disabled}
              aria-label={`${t('imageSupportsMask')} ${position}`} onChange={(event) => { update(index, { supportsMask: event.target.checked }) }} />{t('imageSupportsMask')}</label>
          </> : null}
        </div>
        <button type="button" className={styles['linkButton']} disabled={disabled} aria-label={`${t('removeImageModel')} ${position}`}
          onClick={() => { onChange(models.filter((_row, at) => at !== index).map(row => ({ ...row }))) }}>{t('removeImageModel')}</button>
      </fieldset>
    })}
    {failure === undefined ? null : <p className={styles['error']} role="alert">{`${t('purposeImages')} ${failure.index + 1}: ${t(failure.key)}`}</p>}
    <button type="button" className={styles['secondaryButton']} disabled={disabled}
      onClick={() => { onChange([...models, newImageModelDraft()]) }}>{t('addImageModel')}</button>
  </section>
}
