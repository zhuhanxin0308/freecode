/** 原图的按需缩略图；加载失败可重试，不替换真实结果。 */
import { useEffect } from 'react'
import { Button, IconRefreshOutlineRegular, IconLoadingOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ImageAssetId } from '../types.ts'
import type { ImageThumbnail } from './controller.ts'
import type { ImageWorkbenchKey } from './locales.ts'
import css from './Workbench.module.css'

/** @param props - 图片、共享读取动作和当前缓存。 @returns 缩略图或明确加载状态。 */
export function ImageTile({ id, image, ensure, alt, t }: {
  id: ImageAssetId
  image: ImageThumbnail | undefined
  ensure: (id: ImageAssetId, retry?: boolean) => Promise<void>
  alt: string
  t: (key: ImageWorkbenchKey) => string
}) {
  useEffect(() => { void ensure(id) }, [id, ensure])
  if (image?.status === 'ready') return <img className={css.image} src={image.url} alt={alt} draggable={false} />
  return <div className={css.imageState}>
    {image?.status === 'failed'
      ? <Button size="sm" icon={<IconRefreshOutlineRegular />} onClick={(event) => { event.stopPropagation(); void ensure(id, true) }}>{t('refresh')}</Button>
      : <span role="status" aria-label={t('loading')}><IconLoadingOutlineRegular className={css.spinner} size={20} /></span>}
  </div>
}
