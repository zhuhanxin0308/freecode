/** 图片原图、并排对比和工作区导出对话框。 */
import { useEffect, useRef, useState } from 'react'
import { Button, IconLoadingOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ImageAsset, ImageAssetId, ImageExportDestination, ImageJob, ImageReadResult, ImageWorkspace } from '../types.ts'
import type { ImageWorkbenchKey } from './locales.ts'
import { imageDataUrl } from './controller.ts'
import css from './Workbench.module.css'

type Translate = (key: ImageWorkbenchKey) => string

/** @param props - 原图引用和当前读取动作。 @returns 支持透明背景的原图预览。 */
export function OriginalImage({ asset, read, t }: {
  asset: ImageAsset
  read: (id: ImageAssetId) => Promise<ImageReadResult | undefined>
  t: Translate
}) {
  const [image, setImage] = useState<string>()
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let current = true
    setImage(undefined); setFailed(false)
    void read(asset.id).then((result) => {
      if (current) { setFailed(result === undefined); setImage(result === undefined ? undefined : imageDataUrl(result)) }
    })
    return () => { current = false }
  }, [asset.id, read])
  return <div className={css.originalFrame}>
    {image !== undefined ? <img src={image} alt={t('original')} className={css.original} />
      : failed ? <p role="status">{t('error.result-unavailable')}</p> : <span role="status" aria-label={t('loading')}><IconLoadingOutlineRegular className={css.spinner} size={24} /></span>}
  </div>
}

/** @param props - 要预览的一张或两张完整图片及其生成参数。 @returns 图片检查对话框。 */
export function ImagePreviewDialog({ jobs, read, close, t }: {
  jobs: ImageJob[]
  read: (id: ImageAssetId) => Promise<ImageReadResult | undefined>
  close: () => void
  t: Translate
}) {
  return <Modal open title={t(jobs.length > 1 ? 'compare' : 'imagePreview')} closeLabel={t('close')}
    onClose={close} className={String(css.previewDialog)}>
    <div className={css.comparison} data-compare={jobs.length > 1}>
      {jobs.map(job => <div className={css.previewColumn} key={job.id}>
        {job.images[0] !== undefined && <OriginalImage asset={job.images[0]} read={read} t={t} />}
        <p className={css.detailPrompt}>{job.request.prompt}</p>
        <div className={css.details}>
          <span>{job.request.model.id}</span><span>{job.request.size}</span><span>{job.request.quality}</span></div>
      </div>)}
    </div>
  </Modal>
}

/** @param props - 原图、允许访问的工作区和保存动作。 @returns 不覆盖已有文件的导出表单。 */
export function ImageExportDialog({ asset, workspaces, save, close, t }: {
  asset: ImageAsset
  workspaces: ImageWorkspace[]
  save: (id: ImageAssetId, destination: ImageExportDestination) => Promise<boolean>
  close: () => void
  t: Translate
}) {
  const [workspace, setWorkspace] = useState(workspaces[0]?.id ?? '')
  const [name, setName] = useState(`free-code-image.${asset.mimeType.split('/')[1]}`)
  const [busy, setBusy] = useState(false)
  const isMounted = useRef(false)
  useEffect(() => { isMounted.current = true; return () => { isMounted.current = false } }, [])
  const selected = workspaces.find(item => item.id === workspace)
  const destination = selected === undefined || name.trim() === '' ? undefined : { workspaceId: selected.id, fileName: name.trim() }
  const submit = async (destination: ImageExportDestination) => {
    setBusy(true)
    try { if (await save(asset.id, destination) && isMounted.current) close() }
    finally { if (isMounted.current) setBusy(false) }
  }
  return <Modal open title={t('exported')} closeLabel={t('close')} onClose={close} className={String(css.exportDialog)}>
    <div className={css.dialogFields}>
      {workspaces.length === 0 ? <p role="status">{t('noWorkspaces')}</p> : <>
        <label className={css.field}>{t('workspace')}<select className={css.select} value={workspace}
          onChange={(event) => { setWorkspace(event.target.value) }}>
          {workspaces.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label>
        <label className={css.field}>{t('filename')}<input className={css.input} value={name}
          onChange={(event) => { setName(event.target.value) }} /></label>
        <Button variant="primary" disabled={busy || destination === undefined} onClick={destination === undefined ? undefined : () => { void submit(destination) }}>{t('export')}</Button>
      </>}
    </div>
  </Modal>
}
