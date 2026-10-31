/** 局部修改选区编辑器；按原图尺寸输出透明区域掩码。 */
import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react'
import { Button, IconLoadingOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ImageAsset, ImageAssetId, ImageReadResult } from '../types.ts'
import type { ImageWorkbenchKey } from './locales.ts'
import { imageDataUrl } from './controller.ts'
import css from './Workbench.module.css'

interface Point { x: number; y: number }
interface Stroke { points: [Point, ...Point[]]; radius: number }
const INITIAL_BRUSH_RADIUS = 32
const MIN_BRUSH_RADIUS = 4
const MAX_BRUSH_RADIUS = 160
const MASK_VIEWPORT_HEIGHT = 60

function strokePath(context: CanvasRenderingContext2D, stroke: Stroke): void {
  const start = stroke.points[0]
  context.beginPath()
  if (stroke.points.length === 1) { context.arc(start.x, start.y, stroke.radius, 0, Math.PI * 2); context.fill(); return }
  context.lineWidth = stroke.radius * 2
  context.lineCap = 'round'
  context.lineJoin = 'round'
  context.moveTo(start.x, start.y)
  for (const point of stroke.points.slice(1)) context.lineTo(point.x, point.y)
  context.stroke()
}

function decode(data: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => { resolve(image) }
    image.onerror = () => { reject(new Error('image decode failed')) }
    image.src = data
  })
}

/** @param props - 第一张参考图、已有选区及原图读取和提交动作。 @returns 保留原图分辨率的画笔选区对话框。 */
export function MaskEditor({ reference, initialMask, read, apply, close, t }: {
  reference: ImageAsset
  initialMask: ImageAsset | undefined
  read: (id: ImageAssetId) => Promise<ImageReadResult | undefined>
  apply: (file: File) => Promise<boolean>
  close: () => void
  t: (key: ImageWorkbenchKey) => string
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const activeStroke = useRef<Stroke>()
  const [source, setSource] = useState<string>()
  const [savedMask, setSavedMask] = useState<HTMLImageElement>()
  const [clearSaved, setClearSaved] = useState(false)
  const [strokes, setStrokes] = useState<Stroke[]>([])
  const [radius, setRadius] = useState(INITIAL_BRUSH_RADIUS)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const isMounted = useRef(false)
  useEffect(() => { isMounted.current = true; return () => { isMounted.current = false } }, [])
  const present = () => isMounted.current
  useEffect(() => {
    const lifetime = new AbortController()
    const mounted = () => !lifetime.signal.aborted
    void (async () => {
      const image = await read(reference.id)
      const mask = initialMask === undefined ? undefined : await read(initialMask.id)
      if (!mounted()) return
      if (image === undefined || initialMask !== undefined && mask === undefined) { setFailed(true); return }
      setSource(imageDataUrl(image))
      if (mask !== undefined) {
        try { const decoded = await decode(imageDataUrl(mask)); if (mounted()) setSavedMask(decoded) }
        catch (_error) { if (mounted()) setFailed(true) }
      }
    })()
    return () => { lifetime.abort() }
  }, [reference.id, initialMask, read])

  const paint = useCallback((pending?: Stroke): void => {
    const surface = canvas.current
    const context = surface?.getContext('2d')
    if (surface === null || context == null) return
    context.clearRect(0, 0, reference.width, reference.height)
    const color = getComputedStyle(surface).getPropertyValue('--dsw-alias-brand-primary')
    context.fillStyle = color
    context.strokeStyle = color
    if (savedMask !== undefined && !clearSaved) {
      context.fillRect(0, 0, reference.width, reference.height)
      context.globalCompositeOperation = 'destination-out'
      context.drawImage(savedMask, 0, 0)
      context.globalCompositeOperation = 'source-over'
    }
    for (const stroke of strokes) strokePath(context, stroke)
    if (pending !== undefined) strokePath(context, pending)
  }, [reference.width, reference.height, savedMask, clearSaved, strokes])
  useEffect(() => { paint() }, [paint, source])

  const pointOf = (event: PointerEvent<HTMLCanvasElement>): Point => {
    const rect = event.currentTarget.getBoundingClientRect()
    return { x: Math.max(0, Math.min(reference.width, (event.clientX - rect.left) * reference.width / rect.width)),
      y: Math.max(0, Math.min(reference.height, (event.clientY - rect.top) * reference.height / rect.height)) }
  }
  const finish = (): void => {
    const stroke = activeStroke.current
    activeStroke.current = undefined
    if (stroke !== undefined) setStrokes(current => [...current, stroke])
  }
  const save = async () => {
    setBusy(true)
    try {
      const output = document.createElement('canvas')
      output.width = reference.width; output.height = reference.height
      const context = output.getContext('2d')
      if (context === null) { setFailed(true); return }
      context.fillStyle = '#ffffff'; context.fillRect(0, 0, output.width, output.height)
      if (savedMask !== undefined && !clearSaved) {
        context.clearRect(0, 0, output.width, output.height); context.drawImage(savedMask, 0, 0)
      }
      context.globalCompositeOperation = 'destination-out'
      for (const stroke of strokes) strokePath(context, stroke)
      const blob = await new Promise<Blob | null>((resolve) => { output.toBlob(resolve, 'image/png') })
      if (!present()) return
      if (blob === null) { setFailed(true); return }
      if (await apply(new File([blob], 'edit-mask.png', { type: 'image/png' })) && present()) close()
    } catch (_error) { if (present()) setFailed(true) }
    finally { if (present()) setBusy(false) }
  }
  return <Modal open title={t('editMask')} closeLabel={t('close')} onClose={close} className={String(css.maskDialog)}>
    <div className={css.maskContent}>
      <p className={css.hint}>{t('maskHelp')}</p>
      {failed && source !== undefined && <p role="alert">{t('uploadFailed')}</p>}
      {source === undefined ? failed ? <p role="alert">{t('error.result-unavailable')}</p> : <span role="status" aria-label={t('loading')}><IconLoadingOutlineRegular className={css.spinner} /></span>
        : <div className={css.maskStage} style={{ aspectRatio: `${reference.width}/${reference.height}`,
          maxWidth: `${MASK_VIEWPORT_HEIGHT * reference.width / reference.height}vh` }}>
          <img src={source} alt={t('reference')} />
          <canvas ref={canvas} width={reference.width} height={reference.height} className={css.maskCanvas}
            aria-label={t('editMask')} onPointerDown={(event) => {
              if (busy || event.button !== 0) return
              event.currentTarget.setPointerCapture(event.pointerId)
              activeStroke.current = { points: [pointOf(event)], radius }
              paint(activeStroke.current)
            }} onPointerMove={(event) => {
              if (activeStroke.current === undefined) return
              activeStroke.current.points.push(pointOf(event)); paint(activeStroke.current)
            }} onPointerUp={finish} onPointerCancel={finish} />
        </div>}
      <div className={css.maskActions}>
        <label className={css.brush}>{t('brush')}<input type="range" min={MIN_BRUSH_RADIUS} max={MAX_BRUSH_RADIUS} value={radius}
          onChange={(event) => { setRadius(Number(event.target.value)) }} /><span>{radius}</span></label>
        <Button disabled={strokes.length === 0 || busy} onClick={() => { setStrokes(current => current.slice(0, -1)) }}>{t('undo')}</Button>
        <Button disabled={busy} onClick={() => { setStrokes([]); setClearSaved(true) }}>{t('reset')}</Button>
        <Button variant="primary" disabled={busy || source === undefined || strokes.length === 0 && (savedMask === undefined || clearSaved)}
          onClick={() => { void save() }}>{t('applyMask')}</Button>
      </div>
    </div>
  </Modal>
}
