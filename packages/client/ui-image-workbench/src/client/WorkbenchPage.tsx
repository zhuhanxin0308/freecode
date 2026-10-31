/** 全局图片工作台：能力驱动创作、持久历史和原图操作。 */
import { useEffect, useRef, useState } from 'react'
import { Button, IconCompareSplitOutlineRegular, IconLoadingOutlineRegular, IconPlusOutlineRegular, IconRefreshOutlineRegular, IconSparkleRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ImageAsset, ImageJob, ImageJobId } from '../types.ts'
import type { ImageFilter, ImageWorkbenchFace } from './controller.ts'
import type { ImageWorkbenchKey } from './locales.ts'
import { createDraft, modelKey, requestFromDraft, type ImageDraft } from './draft.ts'
import { readImageFile, downloadImage } from './image-files.ts'
import { CreationForm } from './CreationForm.tsx'
import { ImageCard } from './ImageCard.tsx'
import { ImageExportDialog, ImagePreviewDialog } from './ImageDialogs.tsx'
import { MaskEditor } from './MaskEditor.tsx'
import css from './Workbench.module.css'

/** 由工作台自己的注入面提供数据和动作。 */
export type WorkbenchPageProps = PropsLocale<'imageWorkbench'> & InjectFace<ImageWorkbenchFace>

/** @param props - 工作台的安全状态、动作和文案。 @returns 桌面与Web共用图片创作页面。 */
export function WorkbenchPage({ useWorkbench, activate, refresh, setFilter, setSearch, loadMore, submit, importImage,
  describeImage, ensureThumbnail,
  readOriginal, favorite, archive, cancel, exportImage, notify, openModels, openAccount, t }: WorkbenchPageProps) {
  const state = useWorkbench(value => value)
  const [draft, setDraft] = useState<ImageDraft>(() => createDraft())
  const [formError, setFormError] = useState<ImageWorkbenchKey>()
  const [preview, setPreview] = useState<ImageJob[]>([])
  const [comparison, setComparison] = useState<ImageJobId[]>([])
  const [exporting, setExporting] = useState<ImageAsset>()
  const [maskOpen, setMaskOpen] = useState(false)
  const maskRevision = useRef(0)
  const draftRevision = useRef(0)
  const creationRevision = useRef(0)
  const [uploading, setUploading] = useState(false)
  useEffect(() => {
    activate(true)
    return () => { maskRevision.current++; draftRevision.current++; creationRevision.current++; activate(false) }
  }, [activate])
  const catalog = state.catalog
  const model = catalog?.models.find(model => modelKey(model.ref) === draft.modelKey)
  useEffect(() => {
    const first = state.catalog?.models.find(model => model.available)
    if (first !== undefined) setDraft(current => current.modelKey === '' ? { ...createDraft(first), prompt: current.prompt } : current)
  }, [state.catalog])
  const visible = state.jobs
  const selected = state.jobs.filter(job => comparison.includes(job.id))
  const change = (next: ImageDraft): void => {
    draftRevision.current++
    if (draft.references[0]?.id !== next.references[0]?.id) { maskRevision.current++; setMaskOpen(false) }
    setDraft(next); setFormError(undefined)
  }
  const replaceDraft = (next: ImageDraft): void => {
    creationRevision.current++; maskRevision.current++
    setUploading(false); setMaskOpen(false); change(next)
  }
  const chooseModel = (key: string): void => {
    const next = catalog?.models.find(model => modelKey(model.ref) === key)
    replaceDraft({ ...draft, ...createDraft(next), prompt: draft.prompt, count: draft.count, references: draft.references,
      ...draft.mask === undefined ? {} : { mask: draft.mask },
      ...draft.parentJobId === undefined ? {} : { parentJobId: draft.parentJobId } })
  }
  const files = catalog === undefined || model === undefined || !model.supportsEdit ? undefined : async (files: File[]): Promise<void> => {
    if (draft.references.length + files.length > model.maxReferenceImages) { setFormError('referencesTooMany'); return }
    const revision = creationRevision.current
    setUploading(true)
    try {
      for (const file of files) {
        const input = await readImageFile(file, catalog.limits.maxImageBytes)
        if (revision !== creationRevision.current) return
        const image = await importImage(input)
        if (revision !== creationRevision.current) return
        if (image !== undefined) setDraft(current => current.references.some(item => item.id === image.id)
          ? current : { ...current, references: [...current.references, image] })
      }
    } catch (_error) { notify('uploadFailed') }
    finally { if (revision === creationRevision.current) setUploading(false) }
  }
  const generate = catalog === undefined ? undefined : async (): Promise<void> => {
    const input = requestFromDraft(draft, model, catalog.limits)
    if (!input.ok) { setFormError(input.error); return }
    setFormError(undefined)
    await submit(input.value)
  }
  const reuse = async (job: ImageJob): Promise<void> => {
    const revision = ++draftRevision.current
    const references = await Promise.all(job.request.referenceImageIds.map(id => describeImage(id)))
    if (revision !== draftRevision.current) return
    if (references.some(image => image === undefined)) return
    const mask = job.request.maskImageId === undefined ? undefined : await describeImage(job.request.maskImageId)
    if (revision !== draftRevision.current) return
    if (job.request.maskImageId !== undefined && mask === undefined) return
    replaceDraft({ modelKey: modelKey(job.request.model), prompt: job.request.prompt, size: job.request.size, quality: job.request.quality,
      background: job.request.background, format: job.request.format, count: 1,
      references: references.filter((image): image is ImageAsset => image !== undefined), parentJobId: job.id,
      ...mask === undefined ? {} : { mask } })
  }
  const reference = (job: ImageJob, image: ImageAsset): void => {
    replaceDraft({ modelKey: modelKey(job.request.model), prompt: '', size: job.request.size, quality: job.request.quality,
      background: job.request.background, format: job.request.format, count: 1, references: [image], parentJobId: job.id })
  }
  const download = async (job: ImageJob, asset: ImageAsset): Promise<void> => {
    const image = await readOriginal(asset.id)
    if (image !== undefined) { downloadImage(image, `free-code-${job.id}.${image.mimeType.split('/')[1]}`); notify('downloaded') }
  }
  const toggleCompare = (job: ImageJob): void => {
    setComparison(current => current.includes(job.id) ? current.filter(id => id !== job.id) : [...current.slice(-1), job.id])
  }
  const maskReference = draft.references[0]
  const applyMask = catalog === undefined || maskReference === undefined ? undefined : async (file: File): Promise<boolean> => {
    const revision = maskRevision.current
    try {
      const input = await readImageFile(file, catalog.limits.maxImageBytes)
      const mask = await importImage(input)
      if (mask === undefined || revision !== maskRevision.current) return false
      setDraft(current => ({ ...current, mask }))
      setFormError(undefined)
      return true
    } catch (_error) { notify('uploadFailed'); return false }
  }
  return <section className={css.page} aria-label={t('panel')}>
    <header className={css.header}>
      <div><p className={css.eyebrow}><IconSparkleRegular size={15} />{t('panel')}</p><h1>{t('title')}</h1><p className={css.subtitle}>{t('subtitle')}</p></div>
      <div className={css.headerActions}>
        <Button size="sm" icon={<IconRefreshOutlineRegular size={14} />} onClick={() => { void refresh() }} disabled={state.loading}>{t('refresh')}</Button>
        <Button size="sm" variant="outline" icon={<IconPlusOutlineRegular size={14} />} onClick={() => { replaceDraft(createDraft(model)) }}>{t('newCreation')}</Button>
      </div>
    </header>
    {state.error !== undefined && <div className={css.errorBanner} role="alert"><span>{t(state.error)}</span><Button size="sm" onClick={() => { void refresh() }}>{t('refresh')}</Button></div>}
    <div className={css.workspace}>
      <div className={css.results}>
        <div className={css.galleryToolbar}>
          <div className={css.filters} role="group" aria-label={t('results')}>
            {(['all', 'active', 'favorites', 'archived'] as ImageFilter[]).map(filter => <button type="button" key={filter} className={css.filter}
              aria-pressed={state.filter === filter} onClick={() => { setFilter(filter) }}>{t(filter)}</button>)}
          </div>
          <input type="search" className={css.search} aria-label={t('search')} placeholder={t('search')} value={state.search}
            onChange={(event) => { setSearch(event.target.value) }} />
        </div>
        {selected.length > 0 && <div className={css.compareBar}><span>{t('compareHint')}</span><Button size="sm" variant="outline" disabled={selected.length !== 2}
          icon={<IconCompareSplitOutlineRegular size={14} />} onClick={() => { setPreview(selected) }}>{t('compare')} ({selected.length}/2)</Button></div>}
        {visible.length === 0 ? <div className={css.empty}>
          {state.loading ? <span role="status" aria-label={t('loading')}><IconLoadingOutlineRegular className={css.spinner} size={28} /></span>
            : <><div className={css.emptyArtwork} aria-hidden="true"><IconSparkleRegular size={40} /></div>
              <h2>{t(state.filter === 'all' && state.search === '' ? 'emptyTitle' : 'emptyFiltered')}</h2><p>{t('emptyDescription')}</p></>}
        </div> : <div className={css.gallery}>{visible.map(job => <ImageCard key={job.id} job={job} thumbnails={state.thumbnails}
          compare={comparison.includes(job.id)} busy={state.busy} ensure={ensureThumbnail} view={() => { setPreview([job]) }}
          download={(image) => { void download(job, image) }} reuse={() => { void reuse(job) }}
          reference={(image) => { reference(job, image) }}
          toggleFavorite={() => { void favorite(job) }} toggleArchive={() => { void archive(job) }}
          cancel={() => { void cancel(job.id) }} toggleCompare={() => { toggleCompare(job) }}
          exportImage={setExporting} t={t} />)}</div>}
        {state.nextCursor !== undefined && <div className={css.loadMore}><Button variant="outline" disabled={state.loading} onClick={() => { void loadMore() }}>{t('more')}</Button></div>}
      </div>
      <CreationForm draft={draft} model={model} catalog={state.catalog} busy={state.busy || uploading} error={formError}
        images={state.thumbnails} change={change} chooseModel={chooseModel} files={files} ensureThumbnail={ensureThumbnail}
        mask={() => { maskRevision.current++; setMaskOpen(true) }} generate={generate}
        openModels={openModels} openAccount={openAccount} t={t} />
    </div>
    {preview.length > 0 && <ImagePreviewDialog jobs={preview} read={readOriginal} close={() => { setPreview([]) }} t={t} />}
    {exporting !== undefined && <ImageExportDialog asset={exporting} workspaces={state.workspaces} save={exportImage}
      close={() => { setExporting(undefined) }} t={t} />}
    {maskOpen && maskReference !== undefined && applyMask !== undefined && <MaskEditor reference={maskReference}
      initialMask={draft.mask} read={readOriginal}
      apply={applyMask} close={() => { maskRevision.current++; setMaskOpen(false) }} t={t} />}
  </section>
}
