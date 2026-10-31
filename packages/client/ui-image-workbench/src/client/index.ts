/** 图片工作台的主面板、侧栏入口与全局操作反馈。 */
import type { Context } from '@deepseek-ai/cordis'
import { createElement } from 'react'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-account/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconSparkleRegular, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-image-workbench/remote'
import { ImageWorkbenchController, type ImageWorkbenchFace } from './controller.ts'
import { WorkbenchPage } from './WorkbenchPage.tsx'
import { en, zh, type ImageWorkbenchKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { imageWorkbench: ImageWorkbenchKey }
}

const PANEL_ID = 'image-workbench' as MainPanelId
const NS = 'imageWorkbench'

/** @param props - 侧栏入口要求的图标尺寸。 @returns 使用现有图标库的创作入口。 */
function WorkbenchIcon({ size }: PropsRuntime<'sidebar.panellist'>) { return createElement(IconSparkleRegular, { size }) }

/** @param props - 全局工作台通知和已本地化的文案。 @returns 跨页面保留的操作反馈。 */
function WorkbenchNotice({ useWorkbench, dismissNotice, t }:
  InjectFace<Pick<ImageWorkbenchFace, 'hooks' | 'dismissNotice'>> & PropsLocale<'imageWorkbench'>) {
  const notice = useWorkbench(value => value.notice)
  return notice === undefined ? null : createElement(Toast, {
    key: notice.seq, text: t(notice.key), onDone: () => { dismissNotice(notice.seq) },
  })
}

/** 工作台共享服务与自身 Remote 的显式依赖。 */
export const inject = ['slots', 'locale', 'layout', 'remote', 'remote.imageWorkbench', 'settingsNavigation', 'accountNavigation']

/**
 * 注册图片工作台入口并拥有客户端查询和事件订阅。
 * @param ctx - 本插件生命周期与注册拥有者。
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), '图片工作台：文案')
  const controller = new ImageWorkbenchController(ctx.remote.imageWorkbench)
  ctx.effect(() => () => controller.dispose(), '图片工作台：查询生命周期')
  const face: ImageWorkbenchFace = {
    hooks: { workbench: controller.store }, activate: controller.activate, refresh: controller.refresh,
    setFilter: controller.setFilter, setSearch: controller.setSearch,
    loadMore: controller.loadMore, submit: controller.submit, importImage: controller.importImage, describeImage: controller.describeImage,
    ensureThumbnail: controller.ensureThumbnail, readOriginal: controller.readOriginal,
    favorite: controller.favorite, archive: controller.archive,
    cancel: controller.cancel, exportImage: controller.exportImage, notify: controller.notify, dismissNotice: controller.dismissNotice,
    openModels: () => { ctx.settingsNavigation.openSection('models') }, openAccount: () => { ctx.accountNavigation.openSignIn() },
  }
  ctx.effect(() => {
    const refresh = () => { if (ctx.layout.panelInfo.getSnapshot().activePanelId === PANEL_ID) void controller.refresh() }
    const disposers = [ctx.remote.$on('settings/document-updated', refresh), ctx.remote.$on('credentials/record-updated', refresh),
      ctx.remote.$on('credentials/reference-updated', refresh), ctx.on('connection/reset', refresh)]
    return () => { for (const dispose of disposers) dispose() }
  }, '图片工作台：目录失效事件')
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS, inject: () => face }, WorkbenchPage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 5, label: () => ctx.locale.bind(NS)('panel'), locale: NS }, WorkbenchIcon))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'image-workbench.notice', locale: NS,
    inject: () => ({ hooks: face.hooks, dismissNotice: face.dismissNotice }) }, WorkbenchNotice))
}
