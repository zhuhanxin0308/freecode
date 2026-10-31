/** 图片网络请求保留域名 TLS 验证，并将连接固定到已验证的 DNS 地址。 */
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { resolvePublicAddresses, createPinnedLookup, type PublicAddress } from '@deepseek-ai/dsh-web-fetch-http'
import { ImageFailure } from './errors.ts'

/** 一次完整且有界的 HTTP 响应，不执行重定向。 */
export interface ImageHttpResponse { status: number; headers: IncomingHttpHeaders; bytes: Buffer }
/** 主机预先构造的请求，不接受浏览器传入地址或鉴权头。 */
export interface ImageHttpRequest { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: Uint8Array }
/** 网络请求的部署策略。 */
export interface ImageNetworkOptions { allowLoopbackHttp: boolean; requestTimeoutMs: number }

/** 有界的、每次请求独立的网络传输。 */
export class ImageNetwork {
  /** @param options - 回环开发开关与操作时限。 */
  constructor(private readonly options: ImageNetworkOptions) {}
  /**
   * 拒绝鉴权信息、片段和未启用的明文目标。
   * @param url - 预先选定的提供方地址。
   * @returns 通过协议检查的同一地址。
   */
  validateUrl(url: URL): URL {
    const loopback = url.hostname === '127.0.0.1' || url.hostname === '[::1]'
    if (url.username || url.password || url.hash || (url.protocol !== 'https:'
      && !(url.protocol === 'http:' && loopback && this.options.allowLoopbackHttp))) throw new ImageFailure('unsafe-url')
    return url
  }
  /**
   * 在固定 DNS 地址上读取有界响应，取消时关闭所属请求。
   * @param url - 固定目标。
   * @param input - 方法、主机请求头与正文。
   * @param maxBytes - 完整响应上限。
   * @param signal - 操作取消。
   * @returns 完整响应。
   */
  async request(url: URL, input: ImageHttpRequest, maxBytes: number, signal?: AbortSignal): Promise<ImageHttpResponse> {
    this.validateUrl(url)
    const timed = AbortSignal.any([AbortSignal.timeout(this.options.requestTimeoutMs), ...signal === undefined ? [] : [signal]])
    timed.throwIfAborted()
    let addresses: PublicAddress[]
    try {
      addresses = this.options.allowLoopbackHttp && (url.hostname === '127.0.0.1' || url.hostname === '[::1]')
        ? [{ address: url.hostname === '127.0.0.1' ? '127.0.0.1' : '::1', family: url.hostname === '127.0.0.1' ? 4 : 6 }]
        : await resolvePublicAddresses(url.hostname, timed)
    } catch (_error) { throw new ImageFailure('unsafe-url') }
    timed.throwIfAborted()
    return new Promise((resolve, reject) => {
      // proxy-exempt: 图片鉴权请求只连接本次校验后的公网地址，避免 DNS 二次解析改变目标。
      const outgoing = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
        method: input.method ?? 'GET', headers: input.headers, agent: false, signal: timed,
        lookup: createPinnedLookup(addresses),
      }, (response) => {
        const chunks: Buffer[] = []
        let received = 0
        response.on('data', (chunk: Buffer) => {
          received += chunk.length
          if (received > maxBytes) {
            const error = new ImageFailure('too-large', true)
            reject(error)
            response.destroy(error)
            outgoing.destroy(error)
            return
          }
          chunks.push(chunk)
        })
        response.once('error', reject)
        // Node 的 HTTP 响应回调始终包含状态码；可选类型同时用于传入请求。
        response.once('end', () => { resolve({ status: response.statusCode as number, headers: response.headers, bytes: Buffer.concat(chunks) }) })
      })
      outgoing.once('error', reject)
      outgoing.end(input.body)
    })
  }
}
