/** 创作输入与能力驱动参数，不单独收集服务商密钥。 */
import { useRef } from 'react'
import { Button, IconCloseOutlineRegular, IconPlusOutlineRegular, IconSparkleRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ImageCatalog, ImageModelDescriptor, ImageAssetId } from '../types.ts'
import type { ImageThumbnail } from './controller.ts'
import type { ImageDraft } from './draft.ts'
import { estimatePoints, modelKey } from './draft.ts'
import { ImageTile } from './ImageTile.tsx'
import type { ImageWorkbenchKey } from './locales.ts'
import css from './Workbench.module.css'

/** @param props - 草稿、可用模型、上传和提交动作。 @returns 完整生成表单。 */
export function CreationForm({ draft, model, catalog, busy, error, images, change, chooseModel, files,
  ensureThumbnail, mask, generate, openModels, openAccount, t }: {
  draft: ImageDraft
  model: ImageModelDescriptor | undefined
  catalog: ImageCatalog | undefined
  busy: boolean
  error: ImageWorkbenchKey | undefined
  images: Record<string, ImageThumbnail>
  change: (next: ImageDraft) => void
  chooseModel: (key: string) => void
  files: ((files: File[]) => Promise<void>) | undefined
  ensureThumbnail: (id: ImageAssetId, retry?: boolean) => Promise<void>
  mask: () => void
  generate: (() => Promise<void>) | undefined
  openModels: () => void
  openAccount: () => void
  t: (key: ImageWorkbenchKey) => string
}) {
  const input = useRef<HTMLInputElement>(null)
  const total = estimatePoints(model, draft.count)
  const optionText = (value: string): string => ['auto', 'low', 'medium', 'high', 'opaque', 'transparent'].includes(value)
    ? t(value as 'auto' | 'low' | 'medium' | 'high' | 'opaque' | 'transparent') : value.toUpperCase()
  const remove = (id: ImageAssetId) => {
    const next = { ...draft, references: draft.references.filter(image => image.id !== id) }
    if (draft.references[0]?.id === id) delete next.mask
    change(next)
  }
  return <aside className={css.form} aria-label={t('settingsTitle')}>
    <div className={css.formHeading}><h2>{t('settingsTitle')}</h2><Button size="sm" onClick={openModels}>{t('settings')}</Button></div>
    <label className={css.field}>{t('model')}<select className={css.select} value={draft.modelKey}
      onChange={(event) => { chooseModel(event.target.value) }} disabled={busy}>
      <option value="">{t('chooseModel')}</option>
      {(['platform', 'custom'] as const).map(source => <optgroup key={source} label={t(source === 'platform' ? 'platformModels' : 'customModels')}>
        {catalog?.models.filter(item => item.ref.source === source).map(item => <option key={modelKey(item.ref)}
          value={modelKey(item.ref)} disabled={!item.available}>
          {item.name}{source === 'custom' ? ` · ${item.providerName}` : ''}
        </option>)}
      </optgroup>)}
    </select></label>
    {catalog?.platform === 'signed-out' && <div className={css.formNotice}><p>{t('signedOut')}</p><Button size="sm" onClick={openAccount}>{t('accountSettings')}</Button></div>}
    {catalog?.platform === 'unavailable' && <p className={css.hint}>{t('platformUnavailable')}</p>}
    {catalog !== undefined && catalog.models.length === 0 && <p role="status" className={css.hint}>{t('noModels')}</p>}
    <label className={css.field}>{t('prompt')}<textarea className={css.prompt} value={draft.prompt} placeholder={t('promptPlaceholder')}
      maxLength={catalog?.limits.maxPromptLength} onChange={(event) => { change({ ...draft, prompt: event.target.value }) }} /></label>
    <div className={css.field}>
      <span>{t('reference')}</span>
      <div className={css.references} role="group" aria-label={t('reference')} onDragOver={(event) => { event.preventDefault() }} onDrop={(event) => {
        event.preventDefault()
        if (!busy && files !== undefined) void files(Array.from(event.dataTransfer.files))
      }}>
        {draft.references.map(image => <div className={css.reference} key={image.id}>
          <ImageTile id={image.id} image={images[image.id]} ensure={ensureThumbnail} alt={t('reference')} t={t} />
          <button type="button" className={css.referenceRemove} aria-label={t('removeReference')} onClick={() => { remove(image.id) }}><IconCloseOutlineRegular size={12} /></button>
        </div>)}
        <button type="button" className={css.addReference} disabled={busy || model?.supportsEdit !== true || draft.references.length >= model.maxReferenceImages}
          onClick={() => { input.current?.click() }}><IconPlusOutlineRegular size={18} /><span>{t('addReference')}</span></button>
      </div>
      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" multiple className={css.hiddenFile} aria-label={t('addReference')}
        disabled={busy || files === undefined}
        onChange={files === undefined ? undefined : (event) => {
          const selected = Array.from(event.target.files ?? []); event.target.value = ''; void files(selected)
        }} />
      <span className={css.hint}>{t('referenceHint')}</span>
      {draft.references.length > 0 && <div className={css.maskActions}>
        {model?.supportsMask && <Button size="sm" onClick={mask}>{t('editMask')}</Button>}
        {draft.mask !== undefined && <Button size="sm" onClick={() => { const next = { ...draft }; delete next.mask; change(next) }}>{t('clearMask')}</Button>}
        {draft.mask !== undefined && <span className={css.hint}>{t('maskApplied')}</span>}
      </div>}
    </div>
    <div className={css.parameterGrid}>
      <label className={css.field}>{t('size')}<select className={css.select} value={draft.size} disabled={model === undefined}
        onChange={(event) => { change({ ...draft, size: event.target.value }) }}>
        {model?.sizes.map(value => <option key={value} value={value}>{value.replace('x', ' × ')}</option>)}</select></label>
      <label className={css.field}>{t('quality')}<select className={css.select} value={draft.quality} disabled={model === undefined || model.qualities.length < 2}
        onChange={(event) => { change({ ...draft, quality: event.target.value }) }}>
        {model?.qualities.map(value => <option key={value} value={value}>{optionText(value)}</option>)}</select></label>
      <label className={css.field}>{t('background')}<select className={css.select} value={draft.background} disabled={model === undefined || model.backgrounds.length < 2}
        onChange={(event) => {
          const value = model?.backgrounds.find(value => value === event.target.value)
          if (value !== undefined) change({ ...draft, background: value })
        }}>{model?.backgrounds.map(value => <option key={value} value={value}>{optionText(value)}</option>)}</select></label>
      <label className={css.field}>{t('format')}<select className={css.select} value={draft.format} disabled={model === undefined || model.formats.length < 2}
        onChange={(event) => {
          const value = model?.formats.find(value => value === event.target.value)
          if (value !== undefined) change({ ...draft, format: value })
        }}>{model?.formats.map(value => <option key={value} value={value}>{value.toUpperCase()}</option>)}</select></label>
      <label className={css.field}>{t('count')}<input className={css.input} type="number" min={1} max={catalog?.limits.maxBatch} step={1} value={draft.count}
        onChange={(event) => { change({ ...draft, count: Number(event.target.value) }) }} /></label>
    </div>
    <div className={css.submitArea}>
      <p className={css.validation} role={error === undefined ? undefined : 'alert'}>{error === undefined ? '' : t(error)}</p>
      <Button variant="primary" className={css.generate} disabled={busy || model === undefined || !model.available || generate === undefined}
        icon={<IconSparkleRegular size={18} />} onClick={generate === undefined ? undefined : () => { void generate() }}>
        {t(busy ? 'generating' : 'generate')}
        {total !== undefined && <span className={css.generatePrice}> · {total} {t('points')}</span>}
      </Button>
      {model !== undefined && <p className={css.priceHint}>{t(model.ref.source === 'platform' ? 'chargeHint' : 'byokHint')}</p>}
    </div>
  </aside>
}
