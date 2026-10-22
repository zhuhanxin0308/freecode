import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { configureProductIdentity } from '../src/product-identity.ts'

function application() {
  return { setName: vi.fn(), setAppUserModelId: vi.fn(), getPath: vi.fn(() => resolve('isolated', 'app-data')), setPath: vi.fn() }
}

describe('独立产品的数据所有权', () => {
  it('默认使用独立的应用标识和数据目录', () => {
    const app = application()
    const environment: NodeJS.ProcessEnv = {}
    configureProductIdentity(app, environment, resolve('isolated', 'user'))
    expect(app.setName).toHaveBeenCalledWith('free code')
    expect(app.setAppUserModelId).toHaveBeenCalledWith('io.github.zhuhanxin0308.freecode')
    expect(environment.DSH_HOME).toBe(resolve('isolated', 'user', '.freecode'))
    expect(app.setPath.mock.calls).toEqual([
      ['userData', resolve('isolated', 'app-data', 'free code')],
      ['sessionData', resolve('isolated', 'app-data', 'free code')],
    ])
  })

  it('保留明确指定的开发目录，不迁移或覆盖已有会话', () => {
    const app = application()
    const environment = { DSH_HOME: resolve('isolated', 'home'), DSH_DESKTOP_USER_DATA_DIR: resolve('isolated', 'electron') }
    configureProductIdentity(app, environment)
    expect(environment.DSH_HOME).toBe(resolve('isolated', 'home'))
    expect(app.setPath).toHaveBeenCalledWith('userData', resolve('isolated', 'electron'))
  })

  it.each(['DSH_HOME', 'DSH_DESKTOP_USER_DATA_DIR'])('拒绝空 %s，防止误写工作目录', (name) => {
    const app = application()
    expect(() => configureProductIdentity(app, { [name]: ' ' })).toThrow('data directories must not be empty')
    expect(app.setPath).not.toHaveBeenCalled()
  })
})
