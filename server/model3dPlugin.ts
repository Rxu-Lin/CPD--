import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin, ViteDevServer } from 'vite'

const sessionId = '00000000-0000-4000-8000-000000000000'
const require = createRequire(import.meta.url)
const maxBytes = 100 * 1024 * 1024
const pendingWrites = new Map<string, Promise<void>>()

async function readBinary(req: IncomingMessage) {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) throw new Error('单个模型不能超过 100 MB')
    chunks.push(Buffer.from(chunk))
  }
  if (!size) throw new Error('模型文件为空')
  return Buffer.concat(chunks)
}

export async function cacheModelAsset(buffer: Uint8Array, extension: string, root = path.resolve('.project-cache')) {
  if (!['obj', 'fbx', 'glb'].includes(extension)) throw new Error('仅支持 OBJ、FBX 或 GLB')
  if (!buffer.byteLength || buffer.byteLength > maxBytes) throw new Error('模型文件大小无效，最大 100 MB')
  const hash = createHash('sha256').update(buffer).digest('hex')
  const fileName = `${hash}.${extension}`
  const directory = path.join(root, sessionId, 'models')
  await mkdir(directory, { recursive: true })
  const destination = path.join(directory, fileName)
  let pending = pendingWrites.get(destination)
  if (!pending) {
    pending = (async () => {
      try {
        const existing = await readFile(destination)
        if (createHash('sha256').update(existing).digest('hex') === hash) return
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      const temporary = path.join(directory, `${hash}-${randomUUID()}.tmp`)
      try {
        await writeFile(temporary, buffer)
        await rename(temporary, destination)
      } finally { await unlink(temporary).catch(() => undefined) }
    })()
    pendingWrites.set(destination, pending)
  }
  try { await pending } finally { if (pendingWrites.get(destination) === pending) pendingWrites.delete(destination) }
  return { url: `/api/projects/assets/${sessionId}/models/${fileName}`, byteLength: buffer.byteLength }
}

function json(res: ServerResponse, status: number, value: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(value))
}

export function model3DAssetsPlugin(): Plugin {
  let optimizing = false
  const configure = (server: Pick<ViteDevServer, 'middlewares'>) => {
    server.middlewares.use('/api/model3d', async (req, res, next) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      if (req.method === 'GET' && url.pathname.startsWith('/draco/')) {
        const file = url.pathname.slice('/draco/'.length)
        if (!['draco_wasm_wrapper.js', 'draco_decoder.wasm', 'draco_decoder.js'].includes(file)) return json(res, 404, { error: '资源不存在' })
        try {
          const contents = await readFile(require.resolve(`three/examples/jsm/libs/draco/gltf/${file}`))
          res.setHeader('Content-Type', file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript')
          res.setHeader('Cache-Control', 'public, max-age=86400')
          res.end(contents)
        } catch { json(res, 500, { error: '模型解码器加载失败' }) }
        return
      }
      if (req.method !== 'POST' || !['/assets', '/optimize'].includes(url.pathname)) return next()
      // Same-origin local processing; no model is sent to a third-party service.
      let ownsOptimization = false
      try {
        if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return json(res, 403, { error: '请从本网站导入模型' })
        if (url.pathname === '/optimize') {
          if (optimizing) return json(res, 409, { error: '另一个模型正在优化，请稍后重试' })
          optimizing = ownsOptimization = true
        }
        const input = await readBinary(req)
        if (url.pathname === '/assets') {
          json(res, 200, await cacheModelAsset(input, url.searchParams.get('format') || ''))
        } else {
          const { optimizeModelGLB } = await import('./model3dOptimization.ts')
          const result = await optimizeModelGLB(input, Number(url.searchParams.get('ratio') ?? 1))
          const asset = await cacheModelAsset(result.output, 'glb')
          json(res, 200, { ...asset, beforeTriangles: result.beforeTriangles, afterTriangles: result.afterTriangles })
        }
      } catch (error) { json(res, 400, { error: error instanceof Error ? error.message : '模型处理失败' }) }
      finally { if (ownsOptimization) optimizing = false }
    })
  }
  return { name: 'local-model3d-assets', configureServer: configure, configurePreviewServer: configure }
}
