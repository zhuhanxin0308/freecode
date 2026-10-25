import type { Context } from '@deepseek-ai/cordis'
import base from '../styles/base.css?inline'
import cornerShape from '../styles/corner-shape.css?inline'
import designPlatform from '../styles/design-platform.css?inline'
import focus from '../styles/focus.css?inline'
import onboarding from '../styles/onboarding.css?inline'
import scrollbar from '../styles/scrollbar.css?inline'
import gradientShadowText from '../styles/gradient-shadow-text.css?inline'
import shiki from '../styles/shiki.css?inline'
import ambient from '../styles/ambient.css?inline'

const PLUGIN_ID = '@deepseek-ai/dsh-client-ui-theme'

const STYLES = [
  ['base.css', base],
  ['corner-shape.css', cornerShape],
  ['design-platform.css', designPlatform],
  ['focus.css', focus],
  ['onboarding.css', onboarding],
  ['scrollbar.css', scrollbar],
  ['gradient-shadow-text.css', gradientShadowText],
  ['shiki.css', shiki],
  ['ambient.css', ambient],
] as const

/**
 * 在插件生命周期内安装主题，并在文档隐藏时暂停装饰动画。
 * @param ctx - 拥有样式与可见性监听的插件上下文。
 */
export function installThemeStyles(ctx: Context): void {
  if (typeof document === 'undefined') return
  ctx.effect(() => {
    const root = document.documentElement
    const attribute = 'data-freecode-ambient-paused'
    const previous = root.getAttribute(attribute)
    // 隐藏窗口停止装饰动画；卸载时恢复标记并释放监听，避免后台持续绘制。
    const syncVisibility = () => { root.toggleAttribute(attribute, document.hidden) }
    document.addEventListener('visibilitychange', syncVisibility)
    syncVisibility()
    return () => {
      document.removeEventListener('visibilitychange', syncVisibility)
      if (previous === null) root.removeAttribute(attribute)
      else root.setAttribute(attribute, previous)
    }
  }, 'ui-theme: 弥散背景可见性')
  for (const [name, css] of STYLES) {
    ctx.effect(() => {
      const tag = document.createElement('style')
      tag.dataset.plugin = PLUGIN_ID
      tag.dataset.pluginCss = `${PLUGIN_ID}/${name}`
      tag.textContent = css
      document.head.appendChild(tag)
      return () => { tag.remove() }
    }, `ui-theme: ${name} stylesheet`)
  }
}
