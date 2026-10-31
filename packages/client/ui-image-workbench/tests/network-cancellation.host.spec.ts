/** DNS 等待结束后的取消边界，不发送任何真实外网请求。 */
import { afterEach, expect, it, vi } from 'vitest'
import * as publicHTTP from '@deepseek-ai/dsh-web-fetch-http'
import type { PublicAddress } from '@deepseek-ai/dsh-web-fetch-http'
import { ImageNetwork } from '../src/host/network.ts'

vi.mock('@deepseek-ai/dsh-web-fetch-http', async (original) => {
  const actual = await original<typeof import('@deepseek-ai/dsh-web-fetch-http')>()
  return { ...actual, resolvePublicAddresses: vi.fn(actual.resolvePublicAddresses) }
})
afterEach(() => { vi.restoreAllMocks() })

it('DNS 完成前卸载时不继续创建网络请求', async () => {
  const resolution = Promise.withResolvers<PublicAddress[]>()
  const resolve = vi.mocked(publicHTTP.resolvePublicAddresses).mockReturnValueOnce(resolution.promise)
  const abort = new AbortController()
  const network = new ImageNetwork({ allowLoopbackHttp: false, requestTimeoutMs: 5000 })
  const pending = network.request(new URL('https://images.example.invalid/generate'), {}, 100, abort.signal)
  const rejected = expect(pending).rejects.toThrow()
  expect(resolve).toHaveBeenCalledWith('images.example.invalid', expect.any(AbortSignal))
  abort.abort()
  resolution.resolve([{ address: '8.8.8.8', family: 4 }])
  await rejected
})
