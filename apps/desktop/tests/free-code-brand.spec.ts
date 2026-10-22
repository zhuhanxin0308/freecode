import { describe, expect, it } from 'vitest'
import { resolveDesktopLocale } from '../src/locale.ts'

describe('free code 桌面品牌', () => {
  it.each(['zh-CN', 'en'])('在 %s 的入口、菜单和错误提示中保持产品名称一致', (language) => {
    const { messages } = resolveDesktopLocale(language)
    for (const field of ['aboutProduct', 'welcomeTitle', 'welcomeBrand', 'welcomeTaglineBrand'] as const) {
      expect(messages[field]).toBe('free code')
    }
    for (const field of ['aboutMenu', 'hideApplication', 'quitApplication', 'openApplication', 'quitTitle', 'startupFailed', 'updateTitle'] as const) {
      expect(messages[field]).toContain('free code')
      expect(messages[field]).not.toContain('DeepSeek Harness')
    }
  })

  it('提供中英文品牌口号，同时明确保留真实的模型提供方', () => {
    expect(resolveDesktopLocale('en').messages.welcomeDescription).toBe('Build on your terms.')
    expect(resolveDesktopLocale('zh-CN').messages.welcomeDescription).toBe('自由构建，由你掌控。')
    expect(resolveDesktopLocale('en').messages.welcomeSignIn).toContain('DeepSeek')
  })
})
