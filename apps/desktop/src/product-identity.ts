import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { PRODUCT_BRAND } from './product-brand.ts'

/** 启动早期设置产品身份所需的 Electron 能力。 */
export interface ProductIdentityApplication {
  setName(name: string): void
  getPath(name: 'appData'): string
  setPath(name: 'userData' | 'sessionData', path: string): void
  setAppUserModelId(id: string): void
}

/**
 * 在单实例锁与 Host 启动前隔离数据，显式开发目录仍由调用方控制。
 * @param app - Electron 应用对象。
 * @param environment - 传递给后续 Host 进程的环境。
 * @param userHome - 当前用户主目录，测试可传入隔离目录。
 */
export function configureProductIdentity(
  app: ProductIdentityApplication,
  environment: NodeJS.ProcessEnv = process.env,
  userHome = homedir(),
): void {
  const data = environment.DSH_DESKTOP_USER_DATA_DIR ?? join(app.getPath('appData'), PRODUCT_BRAND.name)
  const home = environment.DSH_HOME ?? join(userHome, PRODUCT_BRAND.homeDirectory)
  if (data.trim() === '' || home.trim() === '') throw new Error('free code: data directories must not be empty')
  app.setName(PRODUCT_BRAND.name)
  app.setAppUserModelId(PRODUCT_BRAND.appId)
  app.setPath('userData', resolve(data))
  app.setPath('sessionData', resolve(data))
  environment.DSH_HOME = resolve(home)
}
