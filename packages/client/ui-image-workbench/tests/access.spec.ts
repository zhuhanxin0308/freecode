/** 真实 Gateway 与权限服务验证原图、工作区和当前调用者的组合授权。 */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import RemoteAccess, { type RemoteAccessBinding } from '@deepseek-ai/dsh-api-remote-access'
import Registry from '@deepseek-ai/dsh-typert-registry'
import { Peer } from '@deepseek-ai/dsh-client-connection'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import sharp from 'sharp'
import { afterEach, expect, it, vi } from 'vitest'
import ImageWorkbench from '../src/index.ts'
import { Config } from '../src/host/config.ts'
import { ImageStore } from '../src/host/store.ts'
import type { ImageJobId, ImageWorkbenchId } from '../src/types.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    /** 仅测试使用的受限图片调用方。 */
    'image-fixture-guest': { kind: 'image-fixture-guest'; id: string }
  }
}
const owners: { ctx: Context; root: string }[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const owner of owners.splice(0)) { await owner.ctx.fiber.dispose(); await rm(owner.root, { recursive: true, force: true }) }
})
async function setup() {
  const ctx = new Context()
  const root = await mkdtemp(join(tmpdir(), 'freecode-image-access-'))
  owners.push({ ctx, root })
  await ctx.plugin(Registry)
  await ctx.plugin(RemoteAccess)
  await ctx.plugin(Gateway)
  ctx.provide('settings', { describe: () => [] } satisfies Pick<Context['settings'], 'describe'>)
  ctx.provide('credentials', {} as Context['credentials'])
  const workspace = { id: brandString<WorkspaceId>(randomUUID()), path: root, title: 'Authorized exports' }
  ctx.provide('workspaceRegistry', { list: () => [workspace], get: (id: WorkspaceId) => id === workspace.id ? workspace : undefined } as Context['workspaceRegistry'])
  await ctx.plugin(ImageWorkbench, { directory: root })
  const held: RemoteAccessBinding[] = []
  ctx.remoteAccess.registerPolicy('image-fixture-guest', { bindings: () => held })
  const call = (method: string, args: Record<string, unknown> = {}) => ctx.typertGateway.invoke({
    peer: new Peer(ctx, { principal: { kind: 'image-fixture-guest', id: 'limited' } }), namespace: 'imageWorkbench', method, args,
  })
  const workbench: RemoteAccessBinding = { role: { name: 'images', resource: 'imageWorkbench', actions: [
    'imageWorkbench/exportImage', 'imageWorkbench/listJobs', 'imageWorkbench/listWorkspaces',
  ] }, resource: { kind: 'imageWorkbench', id: brandString<ImageWorkbenchId>('local') } }
  const destination: RemoteAccessBinding = { role: { name: 'workspace', resource: 'workspace', actions: [
    'imageWorkbench/exportImage', 'imageWorkbench/listWorkspaces',
  ] }, resource: { kind: 'workspace', id: workspace.id } }
  return { ctx, root, workspace, held, call, workbench, destination }
}

it('requires both source-workbench and destination-workspace grants before writing an original', async () => {
  const f = await setup()
  const bytes = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#4488ff' } }).png().toBuffer()
  const asset = await f.ctx.imageWorkbench.importImage({ mimeType: 'image/png', dataBase64: bytes.toString('base64') })
  const args = { imageId: asset.id, destination: { workspaceId: f.workspace.id, fileName: 'allowed.png' } }
  f.held.push(f.destination)
  await expect(f.call('exportImage', args)).rejects.toMatchObject({ code: 'remote-access/denied' })
  await expect(stat(join(f.root, 'allowed.png'))).rejects.toMatchObject({ code: 'ENOENT' })
  f.held.splice(0, 1, f.workbench)
  await expect(f.call('exportImage', args)).rejects.toMatchObject({ code: 'remote-access/denied' })
  expect(await f.call('listWorkspaces')).toEqual([])
  f.held.push(f.destination)
  expect(await f.call('listWorkspaces')).toEqual([{ id: f.workspace.id, name: f.workspace.title }])
  expect(await f.call('exportImage', args)).toEqual({ path: join(f.root, 'allowed.png') })
})

it('rechecks the current Peer before exposing history when its grant is revoked during disk IO', async () => {
  const f = await setup()
  f.held.push(f.workbench)
  const store = new ImageStore({ ...Config({ directory: f.root }), directory: f.root })
  await store.transaction((journal) => { journal.jobs.push({ id: randomUUID() as ImageJobId, createdAt: 1, updatedAt: 1,
    status: 'failed', favorite: false, archived: false, images: [], request: { model: { source: 'custom', provider: 'fixture', id: 'image' },
      prompt: 'private history', size: 'auto', quality: 'auto', background: 'auto', format: 'png', referenceImageIds: [] } }) })
  // oxlint-disable-next-line typescript/unbound-method -- 下方用 call(this) 保留实际读取实例。
  const read = ImageStore.prototype.read
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  vi.spyOn(ImageStore.prototype, 'read').mockImplementation(async function (this: ImageStore) {
    const result = await read.call(this)
    entered.resolve(undefined)
    await release.promise
    return result
  })
  const pending = f.call('listJobs', { query: { limit: 20 } })
  await entered.promise
  f.held.length = 0
  release.resolve(undefined)
  expect(await pending).toEqual({ jobs: [] })
})
