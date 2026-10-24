import { createServer } from 'node:http'
import { randomInt } from 'node:crypto'
import { zstdDecompressSync } from 'node:zlib'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'

export interface MockServer {
  url: string
  paths: string[]
  requests: unknown[]
  headers: IncomingMessage['headers'][]
  readonly closedResponses: number
  requestReceived: Promise<void>
  responseClosed: Promise<void>
}

const servers: Server[] = []
const EPHEMERAL_PORT_START = 49152
const PORT_EXCLUSIVE_END = 65536
const MAX_PORT_BIND_ATTEMPTS = 64

/** Close every listener and connection opened since the last call; run from each spec's afterEach. */
export async function closeMockServers(): Promise<void> {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
    server.close(() => { resolve() })
    server.closeAllConnections()
  })))
}

/** A minimal complete text generation in pi-ai's chat-completions shape. */
export const textEvents = [
  '{"choices":[{"delta":{"role":"assistant","content":""},"index":0,"finish_reason":null}]}',
  '{"choices":[{"delta":{"content":"hello"},"index":0,"finish_reason":null}]}',
  '{"choices":[{"delta":{},"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}',
  '[DONE]',
]

/**
 * One Anthropic Messages SSE frame, named by its own `type`.
 * @param data - the frame payload.
 * @returns the frame as a named SSE event.
 */
export function anthropicFrame(data: Record<string, unknown>): { event: string; data: string } {
  return { event: String(data['type']), data: JSON.stringify(data) }
}

/** The opening frame of every scripted Anthropic Messages response. */
export const anthropicMessageStart = anthropicFrame({
  type: 'message_start',
  message: {
    id: 'msg_1', type: 'message', role: 'assistant', model: 'm', content: [],
    stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 1 },
  },
})

/** The same minimal text generation in Anthropic Messages frames. */
export const anthropicTextEvents = [
  anthropicMessageStart,
  anthropicFrame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
  anthropicFrame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } }),
  anthropicFrame({ type: 'content_block_stop', index: 0 }),
  anthropicFrame({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }),
  anthropicFrame({ type: 'message_stop' }),
]

/** Local provider stand-in: replays scripted behaviors per request. */
export async function mockServer(script: {
  status?: number
  /** SSE frames: a string is sent as `data:` alone; a pair also names the frame's `event:`. */
  events?: (string | { event: string; data: string })[]
  body?: string
  delayMs?: number
  /** Keep the SSE response open after its scripted events until the client disconnects. */
  holdOpen?: boolean
  headers?: Record<string, string>
}[]): Promise<MockServer> {
  const paths: string[] = []
  const requests: unknown[] = []
  const headers: IncomingMessage['headers'][] = []
  let closedResponses = 0
  const requestReceived = Promise.withResolvers<undefined>()
  const responseClosed = Promise.withResolvers<undefined>()
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    response.on('close', () => {
      clearTimeout(timer)
      closedResponses += 1
      responseClosed.resolve(undefined)
    })
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    request.on('end', () => {
      const bytes = Buffer.concat(chunks)
      // Codex SSE requests use zstd compression when the host supports it.
      const body = (request.headers['content-encoding'] === 'zstd' ? zstdDecompressSync(bytes) : bytes).toString('utf8')
      paths.push(request.url ?? '')
      requests.push(body.length === 0 ? undefined : JSON.parse(body))
      headers.push(request.headers)
      requestReceived.resolve(undefined)
      const behavior = script.shift() ?? { status: 500, body: 'script exhausted' }
      if (behavior.status !== undefined && behavior.status !== 200) {
        response.writeHead(behavior.status, { 'content-type': 'application/json', ...behavior.headers })
        response.end(behavior.body ?? '{}')
        return
      }
      if (behavior.body !== undefined) {
        response.writeHead(200, { 'content-type': 'application/json', ...behavior.headers })
        response.end(behavior.body)
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.flushHeaders()
      let index = 0
      const writeNext = (): void => {
        const event = behavior.events?.[index++]
        if (event === undefined) {
          if (!behavior.holdOpen) response.end()
          return
        }
        response.write(typeof event === 'string' ? `data: ${event}\n\n` : `event: ${event.event}\ndata: ${event.data}\n\n`)
        if (behavior.delayMs === undefined) writeNext()
        else timer = setTimeout(writeNext, behavior.delayMs)
      }
      writeNext()
    })
  })
  servers.push(server)
  // 直接取得端口；Windows 的系统保留/独占端口可能返回 EACCES，重选次数有限。
  for (let attempt = 0; attempt < MAX_PORT_BIND_ATTEMPTS; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(randomInt(EPHEMERAL_PORT_START, PORT_EXCLUSIVE_END), '127.0.0.1', () => {
          server.removeListener('error', reject)
          resolve()
        })
      })
      break
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error)
        || !(error.code === 'EADDRINUSE' || process.platform === 'win32' && error.code === 'EACCES')
        || attempt === MAX_PORT_BIND_ATTEMPTS - 1) throw error
    }
  }
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    paths,
    requests,
    headers,
    requestReceived: requestReceived.promise,
    responseClosed: responseClosed.promise,
    get closedResponses() { return closedResponses },
  }
}
