/** 共享协议声明按静态包构建，不注册运行时 Client 插件。 */
import { staticLinked } from '../tsdown.client.ts'

export default staticLinked(import.meta.dirname, ['lib/types/index.js'])
