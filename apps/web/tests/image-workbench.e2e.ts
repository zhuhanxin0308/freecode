/** 发布的 Loader、凭据、Remote 与工作台界面联测；仅外部图片供应商由本地 HTTP 夹具替代。 */
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import sharp from 'sharp'
import { expect, it } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-client-ui-image-workbench'
import type { ImageSubmitRequest } from '@deepseek-ai/dsh-image-workbench-types/types'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { REPO_ROOT, saveFailureShot } from './support.ts'

// 真实图片解码和持久化允许与同机编译争用资源，仍以任务终态作为完成依据。
const IMAGE_JOB_TIMEOUT_MS = 30_000

it('keeps original image jobs across lost submit responses, background completion, editing and Host restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'freecode-workbench-browser-'))
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined
  let page: Page | undefined
  const firstEntered = Promise.withResolvers<undefined>()
  const releaseFirst = Promise.withResolvers<undefined>()
  const original = await sharp({ create: { width: 1024, height: 768, channels: 4, background: '#4868eeb3' } }).png().toBuffer()
  const edited = await sharp({ create: { width: 1024, height: 768, channels: 4, background: '#19bacc' } }).png().toBuffer()
  const requests: { path: string; authorization: string | undefined; body: Buffer; contentType: string }[] = []
  const server: Server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      await once(req, 'end')
      requests.push({ path: req.url ?? '', authorization: req.headers.authorization,
        body: Buffer.concat(chunks), contentType: String(req.headers['content-type']) })
      if (requests.length === 1) { firstEntered.resolve(undefined); await releaseFirst.promise }
      const output = req.url?.endsWith('/edits') ? edited : original
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ b64_json: output.toString('base64') }] }))
    })().catch((_error: unknown) => { res.destroy() })
  })
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('missing image listener')
    const origin = `http://127.0.0.1:${address.port}`
    const overlay = join(root, 'image-workbench.json')
    await writeFile(overlay, JSON.stringify([
      { id: 'ui-image-workbench', config: { directory: join(root, 'history'), platformOrigin: origin,
        allowLoopbackHttp: true, pollIntervalMs: 250 } },
      { id: 'llm-pi-ai', disabled: false, config: { providers: { 'image-fixture': {
        displayName: 'Fixture provider', api: 'openai-completions', baseURL: `${origin}/v1`, apiKeyEnv: 'WORKBENCH_IMAGE_TEST_KEY',
        chatEnabled: false, models: [], imageModels: [{ id: 'fixture-image', name: 'Fixture image', sizes: ['auto'], qualities: ['auto'],
          backgrounds: ['auto'], formats: ['png'], supportsEdit: true, supportsMask: true, maxReferenceImages: 2, optionalParameters: [] }],
      } } } },
    ]))
    const boot = async () => {
      const running = await launchWebScaffold({ extraOverlayPath: overlay })
      await running.ctx.credentials.set(credentialRef('WORKBENCH_IMAGE_TEST_KEY'), 'fixture-image-key')
      await running.ctx.workspaceRegistry.create(running.workspaceCwd, 'Image exports')
      return running
    }
    scaffold = await boot()
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce' })
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    const open = async () => { await page!.getByRole('button', { name: '图片工作台', exact: true }).click() }
    await open()
    await page.getByRole('heading', { name: '把想法，变成画面。', exact: true }).waitFor()
    await page.getByRole('combobox', { name: /^图片模型/ }).selectOption({ label: 'Fixture image · Fixture provider' })
    await page.getByLabel('画面描述', { exact: true }).fill('蓝色透明几何封面')
    const submissions: ImageSubmitRequest[] = []
    await page.route('**/api/imageWorkbench/submit', async (route) => {
      const wire = route.request().postDataJSON() as { payload: { args: { input: ImageSubmitRequest } } }
      submissions.push(wire.payload.args.input)
      const response = await route.fetch()
      if (submissions.length === 1) await route.abort('failed')
      else await route.fulfill({ response })
    })
    const generate = page.getByRole('button', { name: '生成', exact: true })
    await generate.click()
    await firstEntered.promise
    await page.getByText('连接暂时中断，请刷新重试', { exact: true }).waitFor()
    await expect.poll(() => generate.isEnabled()).toBe(true)
    await generate.click()
    await expect.poll(() => page!.locator('[data-image-job]').count()).toBe(1)
    expect(submissions).toHaveLength(2)
    expect(submissions[0]).toEqual(submissions[1])
    expect(requests).toHaveLength(1)
    const firstId = await page.locator('[data-image-job]').getAttribute('data-image-job')
    expect(firstId).not.toBeNull()
    await page.getByRole('button', { name: '插件', exact: true }).click()
    releaseFirst.resolve(undefined)
    await expect.poll(async () => (await scaffold!.ctx.imageWorkbench.listJobs({ limit: 20 })).jobs[0]?.status, { timeout: IMAGE_JOB_TIMEOUT_MS }).toBe('succeeded')
    await open()
    const first = page.locator(`[data-image-job="${firstId}"]`)
    await first.getByText('已完成', { exact: true }).waitFor()
    const [download] = await Promise.all([page.waitForEvent('download'), first.getByRole('button', { name: '下载原图', exact: true }).click()])
    const downloaded = await download.path()
    if (downloaded === null) throw new Error('missing downloaded image')
    expect(await readFile(downloaded)).toEqual(original)
    await first.getByRole('button', { name: '导出到工作区', exact: true }).click()
    const exporting = page.getByRole('dialog', { name: '导出到工作区', exact: true })
    await exporting.getByLabel('文件名', { exact: true }).fill('image-workbench-original.png')
    await exporting.getByRole('button', { name: '保存图片', exact: true }).click()
    await exporting.waitFor({ state: 'detached' })
    const workspace = scaffold.ctx.workspaceRegistry.list()[0]
    if (workspace === undefined) throw new Error('missing workspace')
    expect(await readFile(join(workspace.path, 'image-workbench-original.png'))).toEqual(original)
    await first.getByRole('button', { name: '收藏作品', exact: true }).click()
    await first.getByRole('button', { name: '取消收藏', exact: true }).waitFor()
    await page.getByRole('button', { name: '收藏', exact: true }).click()
    await expect.poll(() => page!.locator('[data-image-job]').count()).toBe(1)
    await page.getByRole('button', { name: '全部作品', exact: true }).click()
    await first.getByRole('button', { name: '继续创作', exact: true }).click()
    await page.getByRole('button', { name: '绘制修改区域', exact: true }).click()
    const maskDialog = page.getByRole('dialog', { name: '绘制修改区域', exact: true })
    const canvas = maskDialog.locator('canvas')
    await canvas.waitFor()
    const box = await canvas.boundingBox()
    if (box === null) throw new Error('mask canvas unavailable')
    await page.mouse.move(box.x + box.width / 3, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width * 2 / 3, box.y + box.height / 2, { steps: 4 })
    await page.mouse.up()
    await maskDialog.getByRole('button', { name: '使用选区', exact: true }).click()
    await maskDialog.waitFor({ state: 'detached' })
    await page.getByLabel('画面描述', { exact: true }).fill('将中间区域改成青色')
    await generate.click()
    await expect.poll(async () => (await scaffold!.ctx.imageWorkbench.listJobs({ limit: 20 }))
      .jobs.filter(job => job.status === 'succeeded').length, { timeout: IMAGE_JOB_TIMEOUT_MS }).toBe(2)
    await page.getByRole('button', { name: '刷新', exact: true }).first().click()
    await expect.poll(() => page!.locator('[data-image-job]').count()).toBe(2)
    const edit = requests.find(request => request.path === '/v1/images/edits')
    if (edit === undefined) throw new Error('missing image edit request')
    const form = await new Response(new Uint8Array(edit.body), { headers: { 'content-type': edit.contentType } }).formData()
    const reference = form.get('image'), mask = form.get('mask')
    if (!(reference instanceof File) || !(mask instanceof File)) throw new Error('missing image or mask')
    expect(Buffer.from(await reference.arrayBuffer())).toEqual(original)
    expect(await sharp(Buffer.from(await mask.arrayBuffer())).metadata()).toMatchObject({ width: 1024, height: 768, hasAlpha: true })
    expect(requests.every(request => request.authorization === 'Bearer fixture-image-key')).toBe(true)
    expect(JSON.stringify(await scaffold.ctx.imageWorkbench.listJobs({ limit: 20 }))).not.toContain('fixture-image-key')
    expect(await page.locator('body').innerText()).not.toContain('fixture-image-key')
    const jobs = (await scaffold.ctx.imageWorkbench.listJobs({ limit: 20 })).jobs
    expect(jobs.find(job => job.id !== firstId)?.request.parentJobId).toBe(firstId)
    const editedAsset = jobs.find(job => job.id !== firstId)?.images[0]
    if (editedAsset === undefined) throw new Error('missing edited asset')
    const editedImage = await scaffold.ctx.imageWorkbench.readImage(editedAsset.id, 'original')
    const editedPixels = await sharp(Buffer.from(editedImage.dataBase64, 'base64')).ensureAlpha().raw().toBuffer()
    const originalPixels = await sharp(original).ensureAlpha().raw().toBuffer()
    expect(editedPixels.subarray(0, 4)).toEqual(originalPixels.subarray(0, 4))
    const center = (384 * 1024 + 512) * 4
    expect([...editedPixels.subarray(center, center + 4)]).toEqual([25, 186, 204, 255])
    await mkdir(join(REPO_ROOT, '.artifacts'), { recursive: true })
    const shots = await mkdtemp(join(REPO_ROOT, '.artifacts', 'image-workbench-'))
    await page.screenshot({ path: join(shots, 'generated-and-edited.png') })
    await page.close()
    page = undefined
    await scaffold.close()
    scaffold = undefined
    scaffold = await boot()
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await open()
    await expect.poll(() => page!.locator('[data-image-job]').count()).toBe(2)
    expect((await scaffold.ctx.imageWorkbench.listJobs({ limit: 20 })).jobs.map(job => job.id)).toEqual(jobs.map(job => job.id))
    expect(requests).toHaveLength(2)
    await page.locator(`[data-image-job="${firstId}"]`).getByRole('button', { name: '归档', exact: true }).click()
    await expect.poll(() => page!.locator('[data-image-job]').count()).toBe(1)
    await page.getByRole('button', { name: '已归档', exact: true }).click()
    await page.getByRole('button', { name: '恢复作品', exact: true }).click()
    await expect.poll(() => page!.locator('[data-image-job]').count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  } catch (error) {
    if (page !== undefined && !page.isClosed()) await saveFailureShot(page, 'image-workbench')
    throw error
  } finally {
    releaseFirst.resolve(undefined)
    await browser?.close()
    await scaffold?.close()
    await new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error === undefined) resolve(); else reject(error) })
      server.closeAllConnections()
    })
    await rm(root, { recursive: true, force: true })
  }
})
