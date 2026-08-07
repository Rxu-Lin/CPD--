import { defineConfig, type Plugin, type ViteDevServer } from 'vite'
import react from '@vitejs/plugin-react'
import { ZipArchive, type ArchiverError } from 'archiver'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isIP } from 'node:net'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  defaultGrsAiModel,
  findGrsAiModel,
  normalizeGrsAiEndpoint,
  normalizeGrsAiModel,
} from './src/grsaiModels.js'

const generatedImagesDir = path.resolve(process.cwd(), 'generated-images')
const exportTempDir = path.resolve(process.cwd(), '.tmp-exports')
const projectPackagesTempDir = path.resolve(process.cwd(), '.tmp-project-packages')
const projectCacheDir = path.resolve(process.cwd(), '.project-cache')
const runtimeImageSessionId = '00000000-0000-4000-8000-000000000000'
const runtimeImagesDir = path.join(projectCacheDir, runtimeImageSessionId, 'images')
const generationRateLimits = new Map<string, { count: number; startedAt: number }>()

type ApiMode = 'mock' | 'openai' | 'grsai' | 'change2pro' | 'custom'
type ImageResolutionTier = '1K' | '2K' | '4K'

type ApiConfig = {
  mode: ApiMode
  endpoint: string
  apiKey: string
  model: string
  imageSize?: ImageResolutionTier
  size: string
  bodyTemplate: string
  responsePath: string
}

function readBody(req: IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 200 * 1024 * 1024) {
        reject(new Error('请求体过大'))
      }
    })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

async function writeRequestBodyToFile(req: IncomingMessage, filePath: string) {
  let receivedBytes = 0
  const maxBytes = 250 * 1024 * 1024
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      receivedBytes += chunk.length
      if (receivedBytes > maxBytes) {
        callback(new Error('项目包不能超过 250 MB'))
        return
      }
      callback(null, chunk)
    },
  })

  await pipeline(req, limiter, createWriteStream(filePath))
}

function isPrivateIpAddress(address: string) {
  const normalized = address.toLowerCase().replace(/^::ffff:/, '')
  const version = isIP(normalized)
  if (version === 4) {
    const [first, second] = normalized.split('.').map(Number)
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      first >= 224 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168)
    )
  }
  if (version === 6) {
    return normalized === '::' || normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')
  }
  return false
}

async function validateUpstreamEndpoint(endpoint: string) {
  const url = new URL(endpoint)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('API Endpoint 只支持 HTTP 或 HTTPS')
  if (process.env.NODE_ENV !== 'production') return url.toString()
  if (url.protocol !== 'https:') throw new Error('线上 API Endpoint 必须使用 HTTPS')
  if (url.username || url.password) throw new Error('API Endpoint 不能包含账号或密码')
  if (url.hostname === 'localhost' || url.hostname.endsWith('.localhost')) throw new Error('API Endpoint 不能指向本机')

  const addresses = await lookup(url.hostname, { all: true, verbatim: true })
  if (!addresses.length || addresses.some((item) => isPrivateIpAddress(item.address))) {
    throw new Error('API Endpoint 不能指向内网地址')
  }
  return url.toString()
}

function consumeGenerationQuota(req: IncomingMessage) {
  if (process.env.NODE_ENV !== 'production') return true
  const forwarded = req.headers['x-forwarded-for']
  const clientId = (Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0])?.trim() || req.socket.remoteAddress || 'unknown'
  const now = Date.now()
  const windowMs = 60_000
  const current = generationRateLimits.get(clientId)

  if (!current || now - current.startedAt >= windowMs) {
    generationRateLimits.set(clientId, { count: 1, startedAt: now })
    return true
  }
  if (current.count >= 20) return false
  current.count += 1
  return true
}

function safeFileName(value: string) {
  return value
    .split('')
    .map((char) => (char.charCodeAt(0) < 32 ? '-' : char))
    .join('')
    .replace(/[<>:"/\\|?*]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 120)
    .replace(/^-|-$/g, '') || `image-${Date.now()}`
}

function extensionFromMediaType(mediaType: string) {
  if (mediaType.includes('svg')) return '.svg'
  if (mediaType.includes('jpeg') || mediaType.includes('jpg')) return '.jpg'
  if (mediaType.includes('webp')) return '.webp'
  if (mediaType.includes('gif')) return '.gif'
  return '.png'
}

function parseDataUrl(dataUrl: string) {
  const match = dataUrl.match(/^data:([^,]*),(.*)$/s)
  if (!match) throw new Error('图像数据格式不正确')

  const mediaType = match[1].split(';')[0] || 'image/png'
  const payload = match[2]
  const isBase64 = match[1].includes(';base64')
  return {
    buffer: isBase64 ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf8'),
    extension: extensionFromMediaType(mediaType),
    mediaType,
  }
}

function mediaTypeFromFilePath(filePath: string) {
  const extension = path.extname(filePath).toLowerCase()
  if (extension === '.svg') return 'image/svg+xml'
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg'
  if (extension === '.webp') return 'image/webp'
  if (extension === '.gif') return 'image/gif'
  return 'image/png'
}

function validateSessionId(sessionId: string) {
  if (!/^[0-9a-f-]{20,}$/i.test(sessionId)) throw new Error('项目会话无效')
  return sessionId
}

function safeChildPath(root: string, relativePath: string) {
  const resolvedRoot = path.resolve(root)
  const resolvedPath = path.resolve(resolvedRoot, relativePath)
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error('项目资源路径无效')
  }
  return resolvedPath
}

function projectAssetPathFromUrl(imageUrl: string) {
  let pathname: string
  try {
    pathname = decodeURIComponent(new URL(imageUrl, 'http://127.0.0.1').pathname)
  } catch {
    return null
  }

  const marker = '/api/projects/assets/'
  if (!pathname.startsWith(marker)) return null
  const parts = pathname.slice(marker.length).split('/').filter(Boolean)
  const sessionId = validateSessionId(parts.shift() || '')
  return safeChildPath(path.join(projectCacheDir, sessionId), parts.join('/'))
}

async function loadImageBuffer(imageUrl: string) {
  if (imageUrl.startsWith('data:image/')) return parseDataUrl(imageUrl)

  const localAssetPath = projectAssetPathFromUrl(imageUrl)
  if (localAssetPath) {
    const mediaType = mediaTypeFromFilePath(localAssetPath)
    return {
      buffer: await readFile(localAssetPath),
      extension: extensionFromMediaType(mediaType),
      mediaType,
    }
  }

  const response = await fetch(imageUrl)
  if (!response.ok) throw new Error(`下载图像失败：${response.status} ${response.statusText}`)
  const mediaType = response.headers.get('content-type') || 'image/png'
  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    extension: extensionFromMediaType(mediaType),
    mediaType,
  }
}

function openFileInFolder(filePath: string) {
  if (process.platform === 'win32') {
    spawn('explorer.exe', [`/select,${filePath}`], { detached: true, stdio: 'ignore' }).unref()
    return
  }

  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open'
  spawn(opener, [path.dirname(filePath)], { detached: true, stdio: 'ignore' }).unref()
}

function runSaveFileDialog(tempPath: string, suggestedName: string) {
  return new Promise<string | null>((resolve, reject) => {
    const script = `
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$dialog = New-Object System.Windows.Forms.SaveFileDialog
$dialog.Filter = 'JSON Project (*.json)|*.json|All files (*.*)|*.*'
$dialog.FileName = $env:AI_CANVAS_SUGGESTED_NAME
$dialog.OverwritePrompt = $true
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.StartPosition = 'CenterScreen'
$owner.Opacity = 0
$owner.Show()
$result = $dialog.ShowDialog($owner)
$owner.Close()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  Copy-Item -LiteralPath $env:AI_CANVAS_TEMP_PATH -Destination $dialog.FileName -Force
  Write-Output $dialog.FileName
  exit 0
}
exit 2
`
    const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      windowsHide: false,
      env: {
        ...process.env,
        AI_CANVAS_TEMP_PATH: tempPath,
        AI_CANVAS_SUGGESTED_NAME: suggestedName,
      },
    })
    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim())
        return
      }
      if (code === 2) {
        resolve(null)
        return
      }
      reject(new Error(stderr.trim() || '打开保存对话框失败'))
    })
  })
}

function runOpenProjectDialog() {
  return new Promise<string | null>((resolve, reject) => {
    const script = `
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Filter = 'AI Canvas Project (*.aicanvas.zip;*.zip;*.json)|*.aicanvas.zip;*.zip;*.json|All files (*.*)|*.*'
$dialog.Multiselect = $false
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.StartPosition = 'CenterScreen'
$owner.Opacity = 0
$owner.Show()
$result = $dialog.ShowDialog($owner)
$owner.Close()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  Write-Output $dialog.FileName
  exit 0
}
exit 2
`
    const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      windowsHide: false,
    })
    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim())
        return
      }
      if (code === 2) {
        resolve(null)
        return
      }
      reject(new Error(stderr.trim() || 'Could not open the project file picker.'))
    })
  })
}

function runPackageSaveFileDialog(tempPath: string, suggestedName: string) {
  return new Promise<string | null>((resolve, reject) => {
    const script = `
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$dialog = New-Object System.Windows.Forms.SaveFileDialog
$dialog.Filter = 'AI Canvas Project (*.aicanvas.zip)|*.aicanvas.zip|ZIP Archive (*.zip)|*.zip'
$dialog.FileName = $env:AI_CANVAS_SUGGESTED_NAME
$dialog.DefaultExt = 'aicanvas.zip'
$dialog.AddExtension = $true
$dialog.OverwritePrompt = $true
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.StartPosition = 'CenterScreen'
$owner.Opacity = 0
$owner.Show()
$result = $dialog.ShowDialog($owner)
$owner.Close()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  Copy-Item -LiteralPath $env:AI_CANVAS_TEMP_PATH -Destination $dialog.FileName -Force
  Write-Output $dialog.FileName
  exit 0
}
exit 2
`
    const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      windowsHide: false,
      env: {
        ...process.env,
        AI_CANVAS_TEMP_PATH: tempPath,
        AI_CANVAS_SUGGESTED_NAME: suggestedName,
      },
    })
    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim())
        return
      }
      if (code === 2) {
        resolve(null)
        return
      }
      reject(new Error(stderr.trim() || '无法打开项目包保存窗口'))
    })
  })
}

function runPowerShellArchive(script: string, sourcePath: string, destinationPath: string) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      windowsHide: true,
      env: {
        ...process.env,
        AI_CANVAS_SOURCE_PATH: sourcePath,
        AI_CANVAS_DESTINATION_PATH: destinationPath,
      },
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(stderr.trim() || '项目包压缩处理失败'))
    })
  })
}

async function compressProjectDirectory(sourceDir: string, destinationZip: string) {
  await unlink(destinationZip).catch(() => undefined)
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(destinationZip)
    const archive = new ZipArchive({ zlib: { level: 9 } })
    let settled = false

    const finish = () => {
      if (settled) return
      settled = true
      resolve()
    }
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      reject(error)
    }

    output.on('close', finish)
    output.on('error', fail)
    archive.on('warning', (error: ArchiverError) => {
      if (error.code !== 'ENOENT') fail(error)
    })
    archive.on('error', fail)
    archive.pipe(output)
    archive.directory(sourceDir, false)
    void archive.finalize().catch(fail)
  })
}

async function extractProjectArchive(sourceZip: string, destinationDir: string) {
  await mkdir(destinationDir, { recursive: true })
  await runPowerShellArchive(
    `Expand-Archive -LiteralPath $env:AI_CANVAS_SOURCE_PATH -DestinationPath $env:AI_CANVAS_DESTINATION_PATH -Force`,
    sourceZip,
    destinationDir,
  )
}

async function saveJsonWithDialog(filename: string, content: string) {
  await mkdir(exportTempDir, { recursive: true })
  const tempPath = path.join(exportTempDir, `${Date.now()}-${safeFileName(filename)}`)
  await writeFile(tempPath, content, 'utf8')

  try {
    return await runSaveFileDialog(tempPath, filename)
  } finally {
    await unlink(tempPath).catch(() => undefined)
  }
}

type ProjectJson = Record<string, unknown> & {
  nodes?: unknown[]
  edges?: unknown[]
  history?: unknown[]
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

async function transformProjectImageValues(
  project: ProjectJson,
  transform: (value: string) => Promise<string> | string,
) {
  for (const nodeValue of Array.isArray(project.nodes) ? project.nodes : []) {
    if (!isJsonRecord(nodeValue) || !isJsonRecord(nodeValue.data)) continue
    for (const key of ['imageUrl', 'sourceImageUrl', 'maskUrl']) {
      const value = nodeValue.data[key]
      if (typeof value === 'string' && value) nodeValue.data[key] = await transform(value)
    }
  }

  for (const historyValue of Array.isArray(project.history) ? project.history : []) {
    if (!isJsonRecord(historyValue)) continue
    const value = historyValue.imageUrl
    if (typeof value === 'string' && value) historyValue.imageUrl = await transform(value)
  }
}

async function materializeEmbeddedProjectImages(project: ProjectJson, cacheRoot: string) {
  const imageDirectory = path.join(cacheRoot, 'images')
  const extractedImages = new Map<string, string>()
  let imageIndex = 0

  await transformProjectImageValues(project, async (value) => {
    if (!value.startsWith('data:image/')) return value
    const cached = extractedImages.get(value)
    if (cached) return cached

    const image = parseDataUrl(value)
    imageIndex += 1
    const relativePath = `images/legacy-${String(imageIndex).padStart(4, '0')}${image.extension}`
    await mkdir(imageDirectory, { recursive: true })
    await writeFile(path.join(cacheRoot, ...relativePath.split('/')), image.buffer)
    extractedImages.set(value, relativePath)
    return relativePath
  })
}

async function rewriteProjectImagesToAssetUrls(
  project: ProjectJson,
  sessionId: string,
  projectBaseDir: string,
  cacheRoot: string,
) {
  await transformProjectImageValues(project, async (value) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('/')) return value
    const normalizedPath = value.replaceAll('\\', '/')
    const absolutePath = safeChildPath(projectBaseDir, normalizedPath)
    let relativeToCache = path.relative(cacheRoot, absolutePath)

    if (relativeToCache.startsWith('..') || path.isAbsolute(relativeToCache)) {
      const cachePath = safeChildPath(cacheRoot, normalizedPath)
      await mkdir(path.dirname(cachePath), { recursive: true })
      await copyFile(absolutePath, cachePath)
      relativeToCache = path.relative(cacheRoot, cachePath)
    }

    safeChildPath(cacheRoot, relativeToCache)
    const encodedPath = relativeToCache.split(path.sep).map(encodeURIComponent).join('/')
    return `/api/projects/assets/${sessionId}/${encodedPath}`
  })
}

async function findProjectManifest(directory: string): Promise<string | null> {
  const directPath = path.join(directory, 'project.json')
  try {
    await readFile(directPath, 'utf8')
    return directPath
  } catch {
    // Continue into nested directories for packages created by other tools.
  }

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const match = await findProjectManifest(path.join(directory, entry.name))
    if (match) return match
  }
  return null
}

export async function openProjectFile(filePath: string) {
  const sessionId = randomUUID()
  const cacheRoot = path.join(projectCacheDir, sessionId)
  await mkdir(cacheRoot, { recursive: true })

  try {
    let manifestPath = filePath
    let projectBaseDir = path.dirname(filePath)
    if (path.extname(filePath).toLowerCase() === '.zip') {
      await extractProjectArchive(filePath, cacheRoot)
      manifestPath = (await findProjectManifest(cacheRoot)) || ''
      if (!manifestPath) throw new Error('项目包中缺少 project.json')
      projectBaseDir = path.dirname(manifestPath)
    }

    const project = JSON.parse(await readFile(manifestPath, 'utf8')) as ProjectJson
    if (!Array.isArray(project.nodes) || !Array.isArray(project.edges)) throw new Error('不是有效的 AI 画布项目')

    await materializeEmbeddedProjectImages(project, cacheRoot)
    await rewriteProjectImagesToAssetUrls(project, sessionId, projectBaseDir, cacheRoot)
    return { sessionId, project }
  } catch (error) {
    await rm(cacheRoot, { recursive: true, force: true })
    throw error
  }
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown) {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(payload))
}

function dataUrlFromImage(image: { buffer: Buffer; mediaType: string }) {
  return `data:${image.mediaType};base64,${image.buffer.toString('base64')}`
}

function formatUpstreamFetchError(error: unknown, endpoint: string) {
  if (!(error instanceof Error)) return '连接图像 API 失败'

  const cause = (error as Error & { cause?: unknown }).cause as
    | {
        code?: string
        address?: string
        port?: number
        message?: string
      }
    | undefined

  if (cause?.code) {
    const target = (() => {
      try {
        const url = new URL(endpoint)
        return url.host
      } catch {
        return endpoint
      }
    })()
    return `连接图像 API 失败：${cause.code}（${target}）。请检查 Endpoint 是否可访问，或改用可访问的 API 代理地址。`
  }

  return `连接图像 API 失败：${error.message}`
}

function aspectRatioFromSize(size: string) {
  const map: Record<string, string> = {
    '1536x864': '16:9',
    '1536x1024': '3:2',
    '1344x1024': '4:3',
    '1024x1024': '1:1',
    '1024x1344': '3:4',
    '1024x1536': '2:3',
    '864x1536': '9:16',
  }

  return map[size] || size || '1:1'
}

const gptImageSizesByTier: Record<ImageResolutionTier, Record<string, string>> = {
  '1K': {
    '16:9': '1672x941',
    '3:2': '1536x1024',
    '4:3': '1448x1086',
    '1:1': '1024x1024',
    '3:4': '1086x1448',
    '2:3': '1024x1536',
    '9:16': '941x1672',
  },
  '2K': {
    '16:9': '2048x1152',
    '3:2': '2048x1360',
    '4:3': '2048x1536',
    '1:1': '2048x2048',
    '3:4': '1536x2048',
    '2:3': '1360x2048',
    '9:16': '1152x2048',
  },
  '4K': {
    '16:9': '3840x2160',
    '3:2': '3520x2336',
    '4:3': '3312x2480',
    '1:1': '2880x2880',
    '3:4': '2480x3312',
    '2:3': '2336x3520',
    '9:16': '2160x3840',
  },
}

function gptImageSizeFromSize(size: string, imageSize: ImageResolutionTier = '1K') {
  const ratio = aspectRatioFromSize(size)
  return gptImageSizesByTier[imageSize][ratio] || size || gptImageSizesByTier[imageSize]['1:1']
}

const supportedGptImageSizes = new Set(
  Object.values(gptImageSizesByTier).flatMap((sizes) => Object.values(sizes)),
)

const supportedNanoBananaRatios = new Set(['16:9', '3:2', '4:3', '1:1', '3:4', '2:3', '9:16'])

function validateGrsAiOutputSize(family: 'gpt-image' | 'nano-banana', size: string) {
  if (family === 'gpt-image' && !supportedGptImageSizes.has(size)) {
    throw new UpstreamHttpError(`GPT Image 2 暂不支持尺寸 ${size}，请改用画布中的标准比例。`, 400)
  }
  if (family === 'nano-banana' && !supportedNanoBananaRatios.has(size)) {
    throw new UpstreamHttpError(`Nano Banana 暂不支持比例 ${size}，请改用画布中的标准比例。`, 400)
  }
}

function grsAiResultEndpoint(generationEndpoint: string, taskId: string) {
  const url = new URL(generationEndpoint)
  url.pathname = '/v1/api/result'
  url.search = ''
  url.searchParams.set('id', taskId)
  return url.toString()
}

function grsAiDataCandidates(source: unknown) {
  if (!source || typeof source !== 'object') return null
  const root = source as Record<string, unknown>
  const data = root.data && typeof root.data === 'object' ? (root.data as Record<string, unknown>) : null
  return data ? [root, data] : [root]
}

function stringValue(source: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.trim()) return value
    if (typeof value === 'number') return String(value)
  }
  return undefined
}

function firstGrsAiImageUrl(source: unknown): string | undefined {
  const candidates = grsAiDataCandidates(source)
  if (!candidates) return undefined

  for (const data of candidates) {
    const direct = stringValue(data, ['url', 'imageUrl', 'image_url', 'originUrl', 'origin_url', 'output', 'outputUrl', 'output_url'])
    if (direct) return direct

    const arrays = ['results', 'images', 'urls', 'outputs']
    for (const key of arrays) {
      const items = Array.isArray(data[key]) ? data[key] : []
      const first = items[0]
      if (typeof first === 'string') return first
      if (first && typeof first === 'object') {
        const item = first as Record<string, unknown>
        const url = stringValue(item, ['url', 'imageUrl', 'image_url', 'originUrl', 'origin_url', 'outputUrl', 'output_url'])
        if (url) return url
      }
    }
  }

  return undefined
}

function grsAiTaskId(source: unknown) {
  const candidates = grsAiDataCandidates(source)
  if (!candidates) return undefined
  for (const data of candidates) {
    const id = stringValue(data, ['id', 'taskId', 'task_id', 'jobId', 'job_id', 'requestId', 'request_id', 'traceId', 'trace_id'])
    if (id) return id
  }
  return undefined
}

function grsAiStatus(source: unknown) {
  const candidates = grsAiDataCandidates(source)
  if (!candidates) return undefined
  for (const data of candidates) {
    const status = stringValue(data, ['status', 'state'])
    if (status) return status
  }
  return undefined
}

function grsAiErrorMessage(source: unknown) {
  const candidates = grsAiDataCandidates(source)
  if (!candidates) return undefined
  const status = grsAiStatus(source)?.toLowerCase()
  const hasResult = Boolean(grsAiTaskId(source) || firstGrsAiImageUrl(source))
  const successfulStatuses = new Set(['queued', 'pending', 'processing', 'running', 'succeeded', 'success', 'done'])
  const successfulMessages = new Set(['success', 'succeeded', 'ok', '成功'])
  const genericFailureReasons = new Set(['error', 'failed', 'failure', 'unknown error'])

  for (const data of candidates) {
    const error = data.error
    if (error && typeof error === 'object') {
      const nested = stringValue(error as Record<string, unknown>, ['message', 'msg', 'error', 'reason', 'detail'])
      if (nested) return nested
    }

    const explicitError = stringValue(data, ['error', 'detail', 'reason'])
    if (
      explicitError &&
      !successfulMessages.has(explicitError.trim().toLowerCase()) &&
      !genericFailureReasons.has(explicitError.trim().toLowerCase())
    ) {
      return explicitError
    }

    const message = stringValue(data, ['message', 'msg'])
    if (!message || successfulMessages.has(message.trim().toLowerCase())) continue

    const code = stringValue(data, ['code'])
    if (code && code !== '0' && code !== '200') return message
    if (status === 'failed' || status === 'error') return message
    if (!code && !hasResult && (!status || !successfulStatuses.has(status))) return message
  }
  return undefined
}

function grsAiFailureMessage(source: unknown) {
  const status = grsAiStatus(source)?.toLowerCase()
  if (status !== 'failed' && status !== 'error') return undefined

  const candidates = grsAiDataCandidates(source) || []
  const failureReason = candidates
    .map((data) => stringValue(data, ['failure_reason', 'failureReason']))
    .find(Boolean)
    ?.toLowerCase()
  const reason = grsAiErrorMessage(source)
  if (reason) return `GrsAI 生成失败：${reason}`
  if (failureReason === 'input_moderation') return 'GrsAI 生成失败：提示词或参考图未通过内容审核'
  if (failureReason === 'output_moderation') return 'GrsAI 生成失败：生成结果未通过内容审核'
  if (failureReason === 'error') return 'GrsAI 生成失败：上游服务临时错误，请重新生成'
  return `GrsAI 生成失败：${failureReason || '未知错误'}`
}

class UpstreamHttpError extends Error {
  statusCode: number

  constructor(message: string, statusCode: number) {
    super(message)
    this.name = 'UpstreamHttpError'
    this.statusCode = statusCode
  }
}

function knownErrorText(source: unknown) {
  if (!source || typeof source !== 'object') return undefined
  const root = source as Record<string, unknown>
  const direct = stringValue(root, ['message', 'msg', 'detail', 'reason'])
  if (direct) return direct
  if (typeof root.error === 'string' && root.error.trim()) return root.error.trim()
  if (root.error && typeof root.error === 'object') {
    const nested = stringValue(root.error as Record<string, unknown>, ['message', 'msg', 'detail', 'reason', 'error'])
    if (nested) return nested
  }
  const errors = Array.isArray(root.errors) ? root.errors : []
  for (const item of errors) {
    if (typeof item === 'string' && item.trim()) return item.trim()
    if (item && typeof item === 'object') {
      const nested = stringValue(item as Record<string, unknown>, ['message', 'msg', 'detail', 'reason', 'error'])
      if (nested) return nested
    }
  }
  return undefined
}

function httpFailureMessage(source: unknown, status: number, statusText: string) {
  const detail = knownErrorText(source)
  if (detail) return `图像接口拒绝请求（${status}）：${detail}`
  if (status === 400) return '图像接口拒绝请求（400）：当前模型不接受这组尺寸、参考图或提示词，请检查生成参数。'
  if (status === 401) return '图像接口鉴权失败（401）：请检查 API Key。'
  if (status === 402 || status === 403) return `图像接口拒绝访问（${status}）：请检查账户余额、模型权限或内容审核结果。`
  if (status === 429) return '图像接口请求过于频繁（429）：请稍后重试。'
  if (status >= 500) return `图像接口上游服务异常（${status}），请稍后重试。`
  return `图像接口请求失败（${status} ${statusText}）。`
}

function compactJson(source: unknown) {
  try {
    return JSON.stringify(source).slice(0, 360)
  } catch {
    return String(source).slice(0, 360)
  }
}

function parseJsonLikeResponse(text: string) {
  const trimmed = text.trim()
  if (!trimmed) return null

  try {
    return JSON.parse(trimmed)
  } catch {
    // Some GrsAI responses are returned as server-sent events:
    // data: {"status":"succeeded","results":[...]}
  }

  const eventPayloads = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter((line) => line && line !== '[DONE]')

  for (let index = eventPayloads.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(eventPayloads[index])
    } catch {
      // Keep looking for the last parseable event payload.
    }
  }

  throw new Error(`Image API returned unreadable response: ${text.slice(0, 240)}`)
}

async function postJson(endpoint: string, headers: Record<string, string>, payload: unknown) {
  let response: Response
  try {
    response = await fetch(await validateUpstreamEndpoint(endpoint), {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })
  } catch (error) {
    throw new Error(formatUpstreamFetchError(error, endpoint))
  }

  const text = await response.text()
  const json = parseJsonLikeResponse(text)

  if (!response.ok) {
    throw new UpstreamHttpError(httpFailureMessage(json, response.status, response.statusText), response.status)
  }

  return json
}

async function getJson(endpoint: string, headers: Record<string, string>) {
  let response: Response
  try {
    response = await fetch(await validateUpstreamEndpoint(endpoint), {
      method: 'GET',
      headers,
    })
  } catch (error) {
    throw new Error(formatUpstreamFetchError(error, endpoint))
  }

  const text = await response.text()
  const json = parseJsonLikeResponse(text)

  if (!response.ok) {
    throw new UpstreamHttpError(httpFailureMessage(json, response.status, response.statusText), response.status)
  }

  return json
}

function shouldInlineGrsAiReference(imageUrl: string) {
  if (imageUrl.startsWith('data:image/')) return false
  if (imageUrl.startsWith('/')) return true

  try {
    const hostname = new URL(imageUrl).hostname.toLowerCase()
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
  } catch {
    return true
  }
}

const supportedReferenceMediaTypes = new Set(['image/jpeg', 'image/png', 'image/webp'])
const maxReferenceImageBytes = 20 * 1024 * 1024
const maxTotalReferenceImageBytes = 48 * 1024 * 1024

function validateReferenceImage(image: { buffer: Buffer; mediaType: string }, index: number) {
  const normalizedMediaType = image.mediaType.split(';')[0].trim().toLowerCase()
  if (!supportedReferenceMediaTypes.has(normalizedMediaType)) {
    throw new UpstreamHttpError(`参考图 ${index + 1} 的格式为 ${normalizedMediaType || '未知'}，仅支持 JPG、PNG、WEBP。`, 400)
  }
  if (!image.buffer.length) throw new UpstreamHttpError(`参考图 ${index + 1} 内容为空，请重新上传。`, 400)
  if (image.buffer.length > maxReferenceImageBytes) {
    throw new UpstreamHttpError(`参考图 ${index + 1} 超过 20 MB，请压缩后重新上传。`, 400)
  }
}

async function prepareGrsAiReferenceImages(imageUrls: string[], maxImages: number) {
  if (imageUrls.length > maxImages) {
    throw new UpstreamHttpError(`当前模型最多支持 ${maxImages} 张参考图，现已连接 ${imageUrls.length} 张。`, 400)
  }
  let totalBytes = 0
  return Promise.all(
    imageUrls.map(async (imageUrl, index) => {
      if (imageUrl.startsWith('data:image/')) {
        const image = parseDataUrl(imageUrl)
        validateReferenceImage(image, index)
        totalBytes += image.buffer.length
        if (totalBytes > maxTotalReferenceImageBytes) throw new UpstreamHttpError('参考图总大小超过 48 MB，请减少图片或先压缩。', 400)
        return imageUrl
      }
      if (!shouldInlineGrsAiReference(imageUrl)) return imageUrl
      const image = await loadImageBuffer(imageUrl)
      validateReferenceImage(image, index)
      totalBytes += image.buffer.length
      if (totalBytes > maxTotalReferenceImageBytes) throw new UpstreamHttpError('参考图总大小超过 48 MB，请减少图片或先压缩。', 400)
      return dataUrlFromImage(image)
    }),
  )
}

async function requestGrsAiImage(config: ApiConfig, prompt: string, referenceImageUrls: string[] = []) {
  const modelSelection = normalizeGrsAiModel(config.model)
  const modelConfig = findGrsAiModel(modelSelection) ?? findGrsAiModel(defaultGrsAiModel)
  const model = modelConfig?.value ?? 'gpt-image-2'
  const family = modelConfig?.family ?? 'gpt-image'
  const endpoint = normalizeGrsAiEndpoint(config.endpoint)
  const headers: Record<string, string> = config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}
  const outputSize = family === 'gpt-image'
    ? gptImageSizeFromSize(config.size, modelConfig?.imageSize)
    : aspectRatioFromSize(config.size)
  validateGrsAiOutputSize(family, outputSize)
  const maxReferenceImages = family === 'gpt-image' ? 16 : 14
  const preparedImages = await prepareGrsAiReferenceImages(referenceImageUrls, maxReferenceImages)
  const payload: Record<string, unknown> = {
    model,
    prompt,
    images: preparedImages,
    aspectRatio: outputSize,
    replyType: 'json',
  }

  if (modelConfig?.family === 'nano-banana') {
    payload.imageSize = modelConfig.imageSize
  }

  let created: unknown
  try {
    created = await postJson(endpoint, headers, payload)
  } catch (error) {
    const message = error instanceof Error ? error.message : '图像接口请求失败'
    const detailedMessage = `${message}（模型 ${model}，输出 ${outputSize}，参考图 ${preparedImages.length} 张）`
    if (error instanceof UpstreamHttpError) throw new UpstreamHttpError(detailedMessage, error.statusCode)
    throw new Error(detailedMessage)
  }
  const createdFailure = grsAiFailureMessage(created)
  if (createdFailure) throw new Error(createdFailure)

  const createdError = grsAiErrorMessage(created)
  if (createdError) throw new Error(createdError)

  const directUrl = firstGrsAiImageUrl(created)
  if (directUrl) return { data: [{ url: directUrl }], grsai: created }

  const taskId = grsAiTaskId(created)
  if (!taskId) throw new Error(`GrsAI returned no image URL. Response: ${compactJson(created)}`)

  for (let index = 0; index < 30; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 3000))
    const result = await getJson(grsAiResultEndpoint(endpoint, taskId), headers)
    const resultFailure = grsAiFailureMessage(result)
    if (resultFailure) throw new Error(resultFailure)

    const resultError = grsAiErrorMessage(result)
    if (resultError) throw new Error(resultError)

    const url = firstGrsAiImageUrl(result)
    if (url) return { data: [{ url }], grsai: result }

    const status = grsAiStatus(result)
    if (status === 'failed' || status === 'error') throw new Error('GrsAI generation failed.')
  }

  throw new Error('GrsAI generation timed out. Please try again later.')
}

function imagePayloadFromDataUrl(imageUrl?: string) {
  if (!imageUrl?.startsWith('data:image/')) return ''
  return imageUrl.slice(imageUrl.indexOf(',') + 1)
}

function referenceImageUrlsFromBody(body: { referenceImageUrl?: string; referenceImageUrls?: string[] }) {
  if (Array.isArray(body.referenceImageUrls)) return body.referenceImageUrls.filter((url): url is string => typeof url === 'string' && Boolean(url))
  return body.referenceImageUrl ? [body.referenceImageUrl] : []
}

function buildCustomBody(config: ApiConfig, prompt: string, referenceImageUrl?: string, maskUrl?: string) {
  const filled = (config.bodyTemplate || '')
    .replaceAll('{prompt}', prompt.replaceAll('"', '\\"'))
    .replaceAll('{model}', config.model)
    .replaceAll('{size}', config.size)
    .replaceAll('{referenceImageUrl}', referenceImageUrl?.replaceAll('"', '\\"') || '')
    .replaceAll('{referenceImageBase64}', imagePayloadFromDataUrl(referenceImageUrl))
    .replaceAll('{maskImageUrl}', maskUrl?.replaceAll('"', '\\"') || '')
    .replaceAll('{maskImageBase64}', imagePayloadFromDataUrl(maskUrl))

  return JSON.parse(filled)
}

function openAiEditEndpoint(endpoint: string) {
  if (endpoint.includes('/images/generations')) return endpoint.replace('/images/generations', '/images/edits')
  return endpoint
}

const change2ProModelsEndpoint = 'https://api.change2pro.com/v1/models'

function isImageGenerationModel(modelId: string) {
  const id = modelId.trim().toLowerCase().replaceAll('_', '-').replaceAll('.', '-')
  return [
    /gpt-?image/,
    /nano-?banana/,
    /grok.*(?:image|imagine)/,
    /gemini.*image/,
    /(^|-)imagen(?:-|$)/,
    /(^|-)image2(?:-|$)/,
    /(^|-)dall-?e(?:-|$)/,
    /(^|-)flux(?:-|$)/,
    /(^|-)seedream(?:-|$)/,
    /qwen-?image/,
    /(^|-)recraft(?:-|$)/,
    /(^|-)ideogram(?:-|$)/,
  ].some((pattern) => pattern.test(id))
}

function change2ProSupportsImageSize(model: string) {
  const value = model.trim().toLowerCase().replaceAll('_', '-').replaceAll('.', '-')
  return /^(gpt-?image-?2(?:-vip)?|nano-?banana-?2|nano-?banana-?pro|gemini-3-1-flash-image-preview|gemini-3-pro-image-preview)$/.test(value)
}

function isChange2ProGeminiImageModel(model: string) {
  const value = model.trim().toLowerCase()
  return value === 'gemini-3.1-flash-image-preview' || value === 'gemini-3-pro-image-preview'
}

function change2ProOutputSize(config: ApiConfig) {
  if (!change2ProSupportsImageSize(config.model)) return config.size
  return gptImageSizeFromSize(config.size, config.imageSize ?? '1K')
}

function change2ProGeminiEndpoint(endpoint: string, model: string) {
  const url = new URL(endpoint)
  const basePath = url.pathname
    .replace(/\/v1beta(?:\/.*)?$/, '')
    .replace(/\/v1(?:\/.*)?$/, '')
    .replace(/\/$/, '')

  url.pathname = `${basePath}/v1beta/models/${encodeURIComponent(model)}:generateContent`
  url.search = ''
  return url.toString()
}

function change2ProGeminiImageFromResponse(source: unknown) {
  if (!source || typeof source !== 'object') throw new Error('Gemini 接口没有返回可识别的内容。')
  const root = source as Record<string, unknown>
  const candidates = Array.isArray(root.candidates) ? root.candidates : []

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue
    const content = (candidate as Record<string, unknown>).content
    if (!content || typeof content !== 'object') continue
    const parts = Array.isArray((content as Record<string, unknown>).parts)
      ? ((content as Record<string, unknown>).parts as unknown[])
      : []

    for (const part of parts) {
      if (!part || typeof part !== 'object') continue
      const item = part as Record<string, unknown>
      const inlineData = (item.inlineData ?? item.inline_data) as Record<string, unknown> | undefined
      const data = typeof inlineData?.data === 'string' ? inlineData.data : ''
      if (data) {
        const mimeType = typeof inlineData?.mimeType === 'string'
          ? inlineData.mimeType
          : typeof inlineData?.mime_type === 'string'
            ? inlineData.mime_type
            : 'image/png'
        return { data: [{ b64_json: data.startsWith('data:image/') ? data : `data:${mimeType};base64,${data}` }] }
      }

      const fileData = (item.fileData ?? item.file_data) as Record<string, unknown> | undefined
      const fileUri = typeof fileData?.fileUri === 'string'
        ? fileData.fileUri
        : typeof fileData?.file_uri === 'string'
          ? fileData.file_uri
          : ''
      if (fileUri) return { data: [{ url: fileUri }] }
    }
  }

  const promptFeedback = root.promptFeedback && typeof root.promptFeedback === 'object'
    ? knownErrorText(root.promptFeedback)
    : undefined
  throw new Error(promptFeedback || 'Gemini 接口已响应，但没有返回图片；请检查内容审核结果或模型权限。')
}

async function requestChange2ProGeminiImage(
  config: ApiConfig,
  prompt: string,
  referenceImageUrls: string[],
  maskUrl?: string,
) {
  const imageUrls = maskUrl ? [...referenceImageUrls, maskUrl] : referenceImageUrls
  if (imageUrls.length > 14) throw new UpstreamHttpError('当前模型最多支持 14 张输入图片。', 400)

  const imageParts = await Promise.all(
    imageUrls.map(async (imageUrl, index) => {
      const image = await loadImageBuffer(imageUrl)
      validateReferenceImage(image, index)
      return {
        inlineData: {
          mimeType: image.mediaType,
          data: image.buffer.toString('base64'),
        },
      }
    }),
  )
  const endpoint = change2ProGeminiEndpoint(config.endpoint, config.model)
  const payload = {
    contents: [
      {
        role: 'user',
        parts: [{ text: prompt }, ...imageParts],
      },
    ],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: {
        aspectRatio: aspectRatioFromSize(config.size),
        imageSize: config.imageSize ?? '1K',
      },
    },
  }
  const result = await postJson(endpoint, { 'x-goog-api-key': config.apiKey.trim() }, payload)
  return change2ProGeminiImageFromResponse(result)
}

function change2ProModelsFromResponse(source: unknown) {
  if (!source || typeof source !== 'object') return []
  const root = source as Record<string, unknown>
  const entries = Array.isArray(root.data)
    ? root.data
    : Array.isArray(root.models)
      ? root.models
      : []

  return entries
    .map((entry) => {
      if (typeof entry === 'string') return { id: entry }
      if (!entry || typeof entry !== 'object') return null
      const item = entry as Record<string, unknown>
      const id = typeof item.id === 'string' ? item.id.trim() : ''
      const ownedBy = typeof item.owned_by === 'string' ? item.owned_by : undefined
      return id ? { id, ownedBy } : null
    })
    .filter((entry): entry is { id: string; ownedBy: string | undefined } => Boolean(entry?.id))
    .filter((entry) => isImageGenerationModel(entry.id))
    .sort((left, right) => left.id.localeCompare(right.id, 'en'))
}

async function requestChange2ProModelList(apiKey: string) {
  if (!apiKey.trim()) throw new UpstreamHttpError('请先填写 Change2Pro API Key。', 400)

  let response: Response
  try {
    response = await fetch(await validateUpstreamEndpoint(change2ProModelsEndpoint), {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey.trim()}` },
    })
  } catch (error) {
    throw new Error(formatUpstreamFetchError(error, change2ProModelsEndpoint))
  }

  const text = await response.text()
  const json = parseJsonLikeResponse(text)
  if (!response.ok) {
    const detail = knownErrorText(json)
    throw new UpstreamHttpError(
      detail
        ? `Change2Pro 模型列表读取失败（${response.status}）：${detail}`
        : `Change2Pro 模型列表读取失败（${response.status} ${response.statusText}）。`,
      response.status,
    )
  }

  const models = change2ProModelsFromResponse(json)
  if (!models.length) {
    throw new UpstreamHttpError('当前 Key 没有返回可识别的生图模型，请确认该 Key 所属分组包含图像能力。', 400)
  }
  return { models }
}

async function proxyImageGeneration(body: { config?: ApiConfig; prompt?: string; referenceImageUrl?: string; referenceImageUrls?: string[]; maskUrl?: string }) {
  const config = body.config
  const prompt = body.prompt?.trim()
  const referenceImageUrls = referenceImageUrlsFromBody(body)
  const firstReferenceImageUrl = referenceImageUrls[0]
  if (config?.mode === 'grsai' && prompt) return requestGrsAiImage(config, prompt, referenceImageUrls)

  if (!config) throw new Error('缺少 API 配置')
  if (!prompt) throw new Error('缺少提示词')
  if (config.mode === 'mock') throw new Error('当前仍是本地模拟模式，请切换到 OpenAI 或自定义 API')
  if (!config.endpoint?.trim()) throw new Error('请先填写 API Endpoint')
  if (config.mode === 'change2pro' && isChange2ProGeminiImageModel(config.model)) {
    return requestChange2ProGeminiImage(config, prompt, referenceImageUrls, body.maskUrl)
  }

  const isOpenAiCompatible = config.mode === 'openai' || config.mode === 'change2pro'
  const endpoint = isOpenAiCompatible && firstReferenceImageUrl ? openAiEditEndpoint(config.endpoint.trim()) : config.endpoint.trim()
  const headers: Record<string, string> = config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}
  const outputSize = config.mode === 'change2pro' ? change2ProOutputSize(config) : config.size
  let requestBody: string | FormData

  if (isOpenAiCompatible && firstReferenceImageUrl) {
    const image = await loadImageBuffer(firstReferenceImageUrl)
    validateReferenceImage(image, 0)
    const form = new FormData()
    form.append('model', config.model)
    form.append('prompt', prompt)
    form.append('size', outputSize)
    form.append('n', '1')
    form.append('image', new Blob([image.buffer], { type: image.mediaType }), `reference${image.extension}`)
    if (body.maskUrl) {
      const mask = await loadImageBuffer(body.maskUrl)
      validateReferenceImage(mask, 0)
      form.append('mask', new Blob([mask.buffer], { type: mask.mediaType }), `mask${mask.extension}`)
    }
    requestBody = form
  } else {
    headers['Content-Type'] = 'application/json'
    const upstreamBody =
      isOpenAiCompatible
        ? { model: config.model, prompt, size: outputSize, n: 1 }
        : buildCustomBody(config, prompt, firstReferenceImageUrl, body.maskUrl)
    requestBody = JSON.stringify(upstreamBody)
  }

  let response: Response
  try {
    response = await fetch(await validateUpstreamEndpoint(endpoint), {
      method: 'POST',
      headers,
      body: requestBody,
    })
  } catch (error) {
    throw new Error(formatUpstreamFetchError(error, endpoint))
  }

  const text = await response.text()
  const json = parseJsonLikeResponse(text)

  if (!response.ok) {
    throw new UpstreamHttpError(httpFailureMessage(json, response.status, response.statusText), response.status)
  }

  return json
}

function localImageLibraryPlugin(): Plugin {
  const configureApiServer = (server: Pick<ViteDevServer, 'middlewares'>) => {
      server.middlewares.use('/api/change2pro/models', async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        if (req.method !== 'POST') {
          next()
          return
        }

        try {
          const body = JSON.parse(await readBody(req)) as { apiKey?: string }
          const result = await requestChange2ProModelList(body.apiKey || '')
          sendJson(res, 200, result)
        } catch (error) {
          const statusCode = error instanceof UpstreamHttpError ? error.statusCode : 500
          sendJson(res, statusCode, {
            error: error instanceof Error ? error.message : 'Change2Pro 模型列表读取失败',
          })
        }
      })

      server.middlewares.use('/api/images/generate', async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        if (req.method !== 'POST') {
          next()
          return
        }

        if (!consumeGenerationQuota(req)) {
          res.setHeader('Retry-After', '60')
          sendJson(res, 429, { error: '请求过于频繁，请稍后再试。' })
          return
        }

        try {
          const body = JSON.parse(await readBody(req)) as {
            config?: ApiConfig
            prompt?: string
            referenceImageUrl?: string
            referenceImageUrls?: string[]
            maskUrl?: string
          }
          const result = await proxyImageGeneration(body)
          sendJson(res, 200, result)
        } catch (error) {
          const statusCode = error instanceof UpstreamHttpError ? error.statusCode : 500
          sendJson(res, statusCode, {
            error: error instanceof Error ? error.message : '生成图像失败',
          })
        }
      })

      server.middlewares.use('/api/images/save-and-open', async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        if (req.method !== 'POST') {
          next()
          return
        }

        try {
          const body = JSON.parse(await readBody(req)) as { filename?: string; imageUrl?: string }
          if (!body.imageUrl) throw new Error('缺少图像地址')

          const image = await loadImageBuffer(body.imageUrl)
          const fileName = `${safeFileName(body.filename || 'generated-image')}${image.extension}`
          const filePath = path.join(generatedImagesDir, fileName)

          await mkdir(generatedImagesDir, { recursive: true })
          await writeFile(filePath, image.buffer)
          openFileInFolder(filePath)

          sendJson(res, 200, {
            fileName,
            filePath,
            folderPath: generatedImagesDir,
          })
        } catch (error) {
          sendJson(res, 500, {
            error: error instanceof Error ? error.message : '保存图像失败',
          })
        }
      })

      server.middlewares.use('/api/images/to-data-url', async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        if (req.method !== 'POST') {
          next()
          return
        }

        try {
          const body = JSON.parse(await readBody(req)) as { imageUrl?: string }
          if (!body.imageUrl) throw new Error('缺少图像地址')

          const image = await loadImageBuffer(body.imageUrl)
          sendJson(res, 200, {
            dataUrl: dataUrlFromImage(image),
          })
        } catch (error) {
          sendJson(res, 500, {
            error: error instanceof Error ? error.message : '缓存图像失败',
          })
        }
      })

      server.middlewares.use('/api/images/cache', async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        if (req.method !== 'POST') {
          next()
          return
        }

        try {
          const body = JSON.parse(await readBody(req)) as { imageUrl?: string }
          if (!body.imageUrl) throw new Error('缺少要缓存的图像')

          const image = await loadImageBuffer(body.imageUrl)
          const fileName = `repaint-${Date.now()}-${randomUUID().slice(0, 8)}${image.extension}`
          await mkdir(runtimeImagesDir, { recursive: true })
          await writeFile(path.join(runtimeImagesDir, fileName), image.buffer)
          sendJson(res, 200, {
            imageUrl: `/api/projects/assets/${runtimeImageSessionId}/images/${encodeURIComponent(fileName)}`,
          })
        } catch (error) {
          sendJson(res, 500, {
            error: error instanceof Error ? error.message : '重绘结果缓存失败',
          })
        }
      })

      server.middlewares.use('/api/projects/assets', async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        if (req.method !== 'GET') {
          next()
          return
        }

        try {
          const pathname = decodeURIComponent(new URL(req.url || '', 'http://127.0.0.1').pathname)
          const marker = '/api/projects/assets/'
          const relativeUrl = pathname.includes(marker) ? pathname.slice(pathname.indexOf(marker) + marker.length) : pathname.replace(/^\/+/, '')
          const parts = relativeUrl.split('/').filter(Boolean)
          const sessionId = validateSessionId(parts.shift() || '')
          const filePath = safeChildPath(path.join(projectCacheDir, sessionId), parts.join('/'))
          const content = await readFile(filePath)

          res.statusCode = 200
          res.setHeader('Content-Type', mediaTypeFromFilePath(filePath))
          res.setHeader('Cache-Control', 'private, max-age=3600')
          res.end(content)
        } catch (error) {
          sendJson(res, 404, { error: error instanceof Error ? error.message : '项目图片不存在' })
        }
      })

      server.middlewares.use('/api/projects/package/start', async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        if (req.method !== 'POST') {
          next()
          return
        }

        try {
          const sessionId = randomUUID()
          const sessionRoot = path.join(projectPackagesTempDir, sessionId)
          await mkdir(path.join(sessionRoot, 'images'), { recursive: true })
          await writeFile(path.join(sessionRoot, '.active'), sessionId, 'utf8')
          sendJson(res, 200, { sessionId })
        } catch (error) {
          sendJson(res, 500, { error: error instanceof Error ? error.message : '无法创建项目包' })
        }
      })

      server.middlewares.use('/api/projects/package/add-image', async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        if (req.method !== 'POST') {
          next()
          return
        }

        try {
          const body = JSON.parse(await readBody(req)) as { sessionId?: string; imageUrl?: string; index?: number }
          const sessionId = validateSessionId(body.sessionId || '')
          if (!body.imageUrl) throw new Error('缺少项目图片')
          const sessionRoot = path.join(projectPackagesTempDir, sessionId)
          await readFile(path.join(sessionRoot, '.active'), 'utf8')

          const image = await loadImageBuffer(body.imageUrl)
          const index = Number.isSafeInteger(body.index) && Number(body.index) > 0 ? Number(body.index) : Date.now()
          const fileName = `asset-${String(index).padStart(4, '0')}${image.extension}`
          const relativePath = `images/${fileName}`
          await writeFile(path.join(sessionRoot, 'images', fileName), image.buffer)
          sendJson(res, 200, { relativePath })
        } catch (error) {
          sendJson(res, 500, { error: error instanceof Error ? error.message : '项目图片写入失败' })
        }
      })

      server.middlewares.use('/api/projects/package/finish', async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        if (req.method !== 'POST') {
          next()
          return
        }

        let sessionRoot = ''
        let tempZipPath = ''
        try {
          const requestUrl = new URL(req.url || '', 'http://127.0.0.1')
          const sessionId = validateSessionId(requestUrl.searchParams.get('sessionId') || '')
          sessionRoot = path.join(projectPackagesTempDir, sessionId)
          await readFile(path.join(sessionRoot, '.active'), 'utf8')

          const content = await readBody(req)
          if (!content.trim()) throw new Error('项目内容为空')
          if (content.includes('data:image/')) throw new Error('项目清单不能包含 Base64 图片')
          const project = JSON.parse(content) as ProjectJson
          if (!Array.isArray(project.nodes) || !Array.isArray(project.edges)) throw new Error('项目清单无效')

          await unlink(path.join(sessionRoot, '.active')).catch(() => undefined)
          await writeFile(path.join(sessionRoot, 'project.json'), JSON.stringify(project, null, 2), 'utf8')
          await mkdir(exportTempDir, { recursive: true })
          tempZipPath = path.join(exportTempDir, `${sessionId}.aicanvas.zip`)
          await compressProjectDirectory(sessionRoot, tempZipPath)

          const requestedName = safeFileName(requestUrl.searchParams.get('filename') || 'ai-canvas.aicanvas.zip')
          const suggestedName = requestedName.toLowerCase().endsWith('.zip') ? requestedName : `${requestedName}.aicanvas.zip`
          if (process.env.NODE_ENV === 'production') {
            res.statusCode = 200
            res.setHeader('Content-Type', 'application/zip')
            res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(suggestedName)}`)
            await new Promise<void>((resolve, reject) => {
              const stream = createReadStream(tempZipPath)
              stream.on('error', reject)
              res.on('finish', resolve)
              res.on('close', resolve)
              stream.pipe(res)
            })
            return
          }
          const filePath = await runPackageSaveFileDialog(tempZipPath, suggestedName)
          if (!filePath) {
            sendJson(res, 200, { cancelled: true })
            return
          }
          sendJson(res, 200, { filePath })
        } catch (error) {
          sendJson(res, 500, { error: error instanceof Error ? error.message : '保存项目包失败' })
        } finally {
          if (sessionRoot) await rm(sessionRoot, { recursive: true, force: true }).catch(() => undefined)
          if (tempZipPath) await unlink(tempZipPath).catch(() => undefined)
        }
      })

      server.middlewares.use('/api/projects/package/cancel', async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        if (req.method !== 'POST') {
          next()
          return
        }

        try {
          const body = JSON.parse(await readBody(req)) as { sessionId?: string }
          const sessionId = validateSessionId(body.sessionId || '')
          await rm(path.join(projectPackagesTempDir, sessionId), { recursive: true, force: true })
          sendJson(res, 200, { cancelled: true })
        } catch (error) {
          sendJson(res, 500, { error: error instanceof Error ? error.message : '清理项目包失败' })
        }
      })

      server.middlewares.use('/api/projects/import-package', async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        if (req.method !== 'POST') {
          next()
          return
        }

        const importRoot = path.join(projectPackagesTempDir, 'imports')
        const tempFilePath = path.join(importRoot, `${randomUUID()}.zip`)
        try {
          await mkdir(importRoot, { recursive: true })
          await writeRequestBodyToFile(req, tempFilePath)
          const { project } = await openProjectFile(tempFilePath)
          sendJson(res, 200, { project })
        } catch (error) {
          sendJson(res, 500, { error: error instanceof Error ? error.message : '导入项目包失败' })
        } finally {
          await unlink(tempFilePath).catch(() => undefined)
        }
      })

      server.middlewares.use('/api/projects/open-package', async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        if (req.method !== 'POST') {
          next()
          return
        }

        try {
          const filePath = await runOpenProjectDialog()
          if (!filePath) {
            sendJson(res, 200, { cancelled: true })
            return
          }

          const { project } = await openProjectFile(filePath)
          sendJson(res, 200, { fileName: path.basename(filePath), project })
        } catch (error) {
          sendJson(res, 500, { error: error instanceof Error ? error.message : '打开项目包失败' })
        }
      })

      server.middlewares.use('/api/projects/save-json', async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        if (req.method !== 'POST') {
          next()
          return
        }

        try {
          const requestUrl = new URL(req.url || '', 'http://127.0.0.1')
          const filename = safeFileName(requestUrl.searchParams.get('filename') || 'ai-canvas.json') || 'ai-canvas.json'
          const content = await readBody(req)
          if (!content.trim()) throw new Error('项目内容为空')

          const filePath = await saveJsonWithDialog(filename.endsWith('.json') ? filename : `${filename}.json`, content)
          if (!filePath) {
            sendJson(res, 200, { cancelled: true })
            return
          }

          sendJson(res, 200, { filePath })
        } catch (error) {
          sendJson(res, 500, {
            error: error instanceof Error ? error.message : '保存项目失败',
          })
        }
      })

      server.middlewares.use('/api/projects/open-json', async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        if (req.method !== 'POST') {
          next()
          return
        }

        try {
          const filePath = await runOpenProjectDialog()
          if (!filePath) {
            sendJson(res, 200, { cancelled: true })
            return
          }

          const content = await readFile(filePath, 'utf8')
          sendJson(res, 200, {
            filePath,
            fileName: path.basename(filePath),
            content,
          })
        } catch (error) {
          sendJson(res, 500, {
            error: error instanceof Error ? error.message : '打开项目文件失败',
          })
        }
      })
  }

  return {
    name: 'local-image-library',
    configureServer: configureApiServer,
    configurePreviewServer: configureApiServer,
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), localImageLibraryPlugin()],
  server: {
    watch: {
      ignored: [
        '**/.project-cache/**',
        '**/.tmp-project-packages/**',
        '**/.tmp-exports/**',
        '**/generated-images/**',
      ],
    },
  },
})
