/** 一项持久创作的结果与后续操作。 */
import { Button, IconCompareSplitOutlineRegular, IconDownloadOutlineRegular, IconLikeFillRegular, IconLikeOutlineRegular, IconRefreshOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ImageAsset, ImageAssetId, ImageJob } from '../types.ts'
import type { ImageThumbnail } from './controller.ts'
import type { ImageWorkbenchKey } from './locales.ts'
import { ImageTile } from './ImageTile.tsx'
import css from './Workbench.module.css'

/** @param props - 安全任务数据及所属工作台动作。 @returns 可继续创作、收藏、归档的图片卡片。 */
export function ImageCard({ job, thumbnails, compare, busy, ensure, view, download, reuse, reference,
  toggleFavorite, toggleArchive, cancel, toggleCompare, exportImage, t }: {
  job: ImageJob
  thumbnails: Record<string, ImageThumbnail>
  compare: boolean
  busy: boolean
  ensure: (id: ImageAssetId, retry?: boolean) => Promise<void>
  view: () => void
  download: (image: ImageAsset) => void
  reuse: () => void
  reference: (image: ImageAsset) => void
  toggleFavorite: () => void
  toggleArchive: () => void
  cancel: () => void
  toggleCompare: () => void
  exportImage: (image: ImageAsset) => void
  t: (key: ImageWorkbenchKey) => string
}) {
  const asset = job.images[0]
  return <article className={css.card} data-image-job={job.id}>
    <div className={css.cardImage}>
      {asset !== undefined
        ? <>
          <div className={css.previewImage}>
            <ImageTile id={asset.id} image={thumbnails[asset.id]} ensure={ensure} alt={job.request.prompt} t={t} />
            {thumbnails[asset.id]?.status === 'ready' &&
              <button type="button" className={css.previewButton} aria-label={t('view')} onClick={view} />}
          </div>
          <div className={css.cardOverlay}>
            <Tooltip label={t(job.favorite ? 'unfavorite' : 'favorite')}><button type="button" className={css.overlayButton} aria-label={t(job.favorite ? 'unfavorite' : 'favorite')}
              aria-pressed={job.favorite} disabled={busy} onClick={toggleFavorite}>
              {job.favorite ? <IconLikeFillRegular size={16} /> : <IconLikeOutlineRegular size={16} />}</button></Tooltip>
            <Tooltip label={t(compare ? 'removeCompare' : 'selectCompare')}><button type="button" className={css.overlayButton} aria-label={t(compare ? 'removeCompare' : 'selectCompare')}
              aria-pressed={compare} onClick={toggleCompare}><IconCompareSplitOutlineRegular size={16} /></button></Tooltip>
          </div>
        </>
        : <div className={css.taskState} data-state={job.status}>
          <span className={css.taskIndicator} aria-hidden="true" />
          <strong>{t(job.status)}</strong>
          {(job.error !== undefined || job.status === 'queued' || job.status === 'running' || job.status === 'uncertain') &&
            <p>{job.status === 'uncertain' ? t('unknownDescription')
              : job.error !== undefined ? t(`error.${job.error.code}`) : t('pendingDescription')}</p>}
          {job.status === 'queued' && <Button size="sm" disabled={busy} onClick={cancel}>{t('cancel')}</Button>}
        </div>}
    </div>
    <div className={css.cardBody}>
      <div className={css.cardMeta}><span className={css.sourceBadge}>{t(job.request.model.source === 'platform' ? 'sourcePlatform' : 'sourceCustom')}</span>
        <span>{t(job.status)}</span><span>{job.request.size.replace('x', ' × ')}</span></div>
      <p className={css.cardPrompt}>{job.request.prompt}</p>
      <div className={css.cardActions}>
        {asset !== undefined && <Button size="sm" onClick={() => { reference(asset) }}>{t('branch')}</Button>}
        <Button size="sm" icon={<IconRefreshOutlineRegular size={13} />} onClick={reuse}>{t('reuse')}</Button>
        {asset !== undefined && <Button size="sm" icon={<IconDownloadOutlineRegular size={13} />} onClick={() => { download(asset) }}>{t('download')}</Button>}
      </div>
      <div className={css.secondaryActions}>
        {asset !== undefined && <button type="button" onClick={() => { exportImage(asset) }}>{t('exported')}</button>}
        <button type="button" disabled={busy || job.status === 'queued' || job.status === 'running'} onClick={toggleArchive}>{t(job.archived ? 'restore' : 'archive')}</button>
      </div>
    </div>
  </article>
}
