// @vitest-environment jsdom
import { useSyncExternalStore, type ComponentType } from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, vi } from 'vitest'
import { createClientTest, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { ok } from '@deepseek-ai/dsh-remote-mock'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ImageWorkbenchFace } from '../src/client/controller.ts'
import type {} from '../src/client/index.ts'
import { en } from '../src/client/locales.ts'
import { WorkbenchPage } from '../src/client/WorkbenchPage.tsx'

const it = createClientTest({ roster: webApp })
const SELF = '@deepseek-ai/dsh-client-ui-image-workbench'
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals() })

it('真实程序集连接工作台、模型设置和同一登录入口，并在卸载后撤销注册与读取', async ({ start, remote }) => {
  vi.stubGlobal('dshDesktop', {})
  remote.imageWorkbench.catalog.mockResolvedValue(ok({ models: [], platform: 'signed-out',
    limits: { maxBatch: 4, maxImageBytes: 1000, maxPromptLength: 100, pollIntervalMs: 1000 } }))
  remote.imageWorkbench.listJobs.mockResolvedValue(ok({ jobs: [] }))
  remote.imageWorkbench.listWorkspaces.mockResolvedValue(ok([]))
  const c = await start()
  const entry = c.ctx.slots.entries('main').find(value => value.component === WorkbenchPage)
  if (entry?.inject === undefined) throw new Error('工作台没有加入真实主面板')
  const injectedFace: object = entry.inject()
  const face = injectedFace as ImageWorkbenchFace
  const models = vi.spyOn(c.ctx.settingsNavigation, 'openSection')
  const login = vi.spyOn(c.ctx.accountNavigation, 'openSignIn')
  face.openModels()
  expect(models).toHaveBeenCalledWith('models')
  face.openAccount()
  expect(login).toHaveBeenCalledOnce()
  await c.flush()

  c.ctx.layout.selectPanel('image-workbench' as MainPanelId)
  c.ctx.emit('connection/reset')
  await vi.waitFor(() => { expect(face.hooks.workbench.getSnapshot().catalog?.platform).toBe('signed-out') })
  const count = remote.imageWorkbench.catalog.mock.calls.length
  c.ctx.layout.selectPanel(null)
  c.ctx.emit('connection/reset')
  await c.flush()
  expect(remote.imageWorkbench.catalog).toHaveBeenCalledTimes(count)

  const sidebar = c.ctx.slots.entries('sidebar.panellist').find(value => value.options.id === 'image-workbench')
  expect(sidebar).toBeDefined()
  const Icon = sidebar?.component as ComponentType<{ size: number }>
  const icon = render(<Icon size={20} />)
  expect(icon.container.querySelector('svg')).not.toBeNull()
  icon.unmount()

  const notice = c.ctx.slots.entries('shell.overlay').find(value => value.options.id === 'image-workbench.notice')
  if (notice?.inject === undefined) throw new Error('全局操作反馈没有注册')
  const injected = notice.inject() as Pick<ImageWorkbenchFace, 'hooks' | 'dismissNotice'>
  const Notice = notice.component as ComponentType<InjectFace<Pick<ImageWorkbenchFace, 'hooks' | 'dismissNotice'>> & PropsLocale<'imageWorkbench'>>
  const useWorkbench: InjectFace<ImageWorkbenchFace>['useWorkbench'] = selector => useSyncExternalStore(
    listener => injected.hooks.workbench.subscribe(listener), () => selector(injected.hooks.workbench.getSnapshot()),
  )
  vi.useFakeTimers()
  render(<Notice useWorkbench={useWorkbench} dismissNotice={injected.dismissNotice} t={makeTranslate(en)} />)
  expect(screen.queryByRole('alert')).toBeNull()
  act(() => { face.notify('submitted') })
  expect(screen.getByRole('alert').textContent).toBe(en.submitted)
  await act(async () => { await vi.advanceTimersByTimeAsync(4000) })
  expect(screen.queryByRole('alert')).toBeNull()
  vi.useRealTimers()

  await c.unload(SELF)
  await c.flush()
  expect(c.ctx.slots.entries('main').some(value => value.component === WorkbenchPage)).toBe(false)
  expect(c.ctx.slots.entries('sidebar.panellist').some(value => value.options.id === 'image-workbench')).toBe(false)
  expect(c.ctx.slots.entries('shell.overlay').some(value => value.options.id === 'image-workbench.notice')).toBe(false)
  await face.refresh()
  expect(remote.imageWorkbench.catalog).toHaveBeenCalledTimes(count)
}, 60_000)
