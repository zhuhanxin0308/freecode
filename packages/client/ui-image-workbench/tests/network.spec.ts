/** 真实 HTTP 夹具验证目标限制、响应上限和取消释放。 */
import { createServer, type RequestListener, type Server } from 'node:http'
import { afterEach, expect, it } from 'vitest'
import { ImageNetwork } from '../src/host/network.ts'

const servers: Server[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
  server.close((error) => { if (error === undefined) resolve(); else reject(error) }); server.closeAllConnections()
}))) })
async function listen(handler: RequestListener, host = '127.0.0.1') {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, host, resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('missing listener')
  return `http://${host === '::1' ? '[::1]' : host}:${address.port}`
}

it('keeps POST bytes and authorization on the chosen origin without following a redirect', async () => {
  let received = ''
  let credential: string | undefined
  const origin = await listen((req, res) => {
    credential = req.headers.authorization
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => { received += chunk })
    req.on('end', () => { res.writeHead(302, { location: 'http://127.0.0.1/secret' }).end('redirect') })
  })
  const network = new ImageNetwork({ allowLoopbackHttp: true, requestTimeoutMs: 5000 })
  const result = await network.request(new URL(origin), { method: 'POST', headers: { authorization: 'Bearer fixture' }, body: Buffer.from('原始正文') }, 100)
  expect(result.status).toBe(302)
  expect(received).toBe('原始正文')
  expect(credential).toBe('Bearer fixture')
  await expect(new ImageNetwork({ allowLoopbackHttp: false, requestTimeoutMs: 5000 })
    .request(new URL(origin), {}, 100)).rejects.toMatchObject({ code: 'unsafe-url' })
})

it('rejects oversized responses and cancels an unfinished response', async () => {
  const entered = Promise.withResolvers<undefined>()
  const origin = await listen((req, res) => {
    if (req.url === '/large') res.end('x'.repeat(200))
    else { res.writeHead(200); res.write('start'); entered.resolve(undefined) }
  })
  const network = new ImageNetwork({ allowLoopbackHttp: true, requestTimeoutMs: 5000 })
  await expect(network.request(new URL('/large', origin), {}, 100)).rejects.toMatchObject({ code: 'too-large' })
  const cancelled = new AbortController()
  const pending = network.request(new URL('/wait', origin), {}, 100, cancelled.signal)
  const rejected = expect(pending).rejects.toThrow()
  await entered.promise
  cancelled.abort()
  await rejected
})

it('IPv6 回环须显式启用，公网模式拒绝私网解析结果', async () => {
  const origin = await listen((_req, res) => { res.end('ipv6 image') }, '::1')
  const local = new ImageNetwork({ allowLoopbackHttp: true, requestTimeoutMs: 5000 })
  expect((await local.request(new URL(origin), {}, 100)).bytes.toString()).toBe('ipv6 image')
  const network = new ImageNetwork({ allowLoopbackHttp: false, requestTimeoutMs: 5000 })
  await expect(network.request(new URL('https://127.0.0.1/image'), {}, 100)).rejects.toMatchObject({ code: 'unsafe-url' })
  for (const url of ['http://example.com/image', 'https://user:secret@example.com/image', 'https://example.com/image#secret', 'file:///image']) {
    expect(() => local.validateUrl(new URL(url))).toThrow('unsafe-url')
  }
})

it('HTTPS 请求不会降级为明文，已经取消的请求不会到达服务端', async () => {
  let requests = 0
  const origin = await listen((_req, res) => { requests++; res.end('must not receive plaintext') })
  const network = new ImageNetwork({ allowLoopbackHttp: true, requestTimeoutMs: 5000 })
  await expect(network.request(new URL(origin.replace('http:', 'https:')), {}, 100)).rejects.toThrow()
  const cancelled = new AbortController()
  cancelled.abort()
  await expect(network.request(new URL(origin), {}, 100, cancelled.signal)).rejects.toThrow()
  expect(requests).toBe(0)
})
