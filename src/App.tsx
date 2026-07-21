import {
  addEdge,
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type EdgeChange,
  type OnConnectEnd,
  type OnConnectStart,
  type Node,
  type NodeChange,
  type NodeProps,
  type ReactFlowInstance,
  type XYPosition,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  AlertTriangle,
  BookOpen,
  Brush,
  Check,
  CheckCircle2,
  Copy,
  Download,
  FilePlus2,
  FolderOpen,
  History,
  Image as ImageIcon,
  KeyRound,
  Loader2,
  Save,
  Settings,
  Sparkles,
  Trash2,
  Upload,
  UploadCloud,
  Wand2,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type CSSProperties } from 'react'
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react'
import brandLogo from './assets/brand-logo.png'
import promptLibraryMarkdown from '../提示词.md?raw'
import './App.css'

type NodeKind = 'prompt' | 'image' | 'reference' | 'repaint'
type NodeStatus = 'idle' | 'generating' | 'done' | 'error'
type RepaintBrushColor = 'red' | 'blue'
type PromptLibraryItem = {
  id: string
  title: string
  content: string
}

function parsePromptLibrary(markdown: string): PromptLibraryItem[] {
  const items: PromptLibraryItem[] = []
  let title = ''
  let content: string[] = []

  const pushItem = () => {
    const prompt = content.join('\n').trim().replace(/\\([\\`*{}[\]()#+\-.!_>])/g, '$1')
    if (title && prompt) {
      items.push({ id: `prompt-${items.length + 1}`, title, content: prompt })
    }
  }

  for (const line of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const heading = line.match(/^###\s+(.+?)\s*$/)
    if (heading) {
      pushItem()
      title = heading[1]
      content = []
      continue
    }
    if (title) content.push(line)
  }
  pushItem()

  return items
}

const promptLibrary = parsePromptLibrary(promptLibraryMarkdown)

const repaintBrushOptions: Record<
  RepaintBrushColor,
  { label: string; prefix: string; rgb: [number, number, number]; stroke: string }
> = {
  red: {
    label: '红色',
    prefix: '其他保持不变，红色区域重绘成：',
    rgb: [239, 68, 68],
    stroke: 'rgba(239, 68, 68, 0.78)',
  },
  blue: {
    label: '蓝色',
    prefix: '其他保持不变，蓝色区域重绘成：',
    rgb: [59, 130, 246],
    stroke: 'rgba(59, 130, 246, 0.78)',
  },
}

function repaintPromptBody(prompt: string) {
  let body = prompt.trimStart()
  for (const option of Object.values(repaintBrushOptions)) {
    if (body.startsWith(option.prefix)) {
      body = body.slice(option.prefix.length).trimStart()
      break
    }
  }
  return body
}

function repaintPromptWithColor(prompt: string, brushColor: RepaintBrushColor) {
  return `${repaintBrushOptions[brushColor].prefix}${repaintPromptBody(prompt)}`
}
type ApiMode = 'mock' | 'openai' | 'grsai' | 'custom'
type AspectRatioValue = '16:9' | '3:2' | '4:3' | '1:1' | '3:4' | '2:3' | '9:16'

type ApiConfig = {
  mode: ApiMode
  endpoint: string
  apiKey: string
  model: string
  size: string
  bodyTemplate: string
  responsePath: string
}

type GenerationRecord = {
  id: string
  prompt: string
  model: string
  size: string
  createdAt: string
  imageUrl?: string
  status: '成功' | '失败'
}

type WorkflowNodeData = {
  kind: NodeKind
  title: string
  prompt?: string
  imageUrl?: string
  sourceImageUrl?: string
  maskUrl?: string
  brushSize?: number
  brushColor?: RepaintBrushColor
  status: NodeStatus
  model?: string
  size?: string
  sourceName?: string
  error?: string
  createdAt: string
  onDelete?: (id: string) => void
  onDownload?: (id: string) => void
  onRevealImage?: (id: string) => void
  onGenerate?: (id: string) => void
  onChangeSize?: (id: string, size: string) => void
  onChangePrompt?: (id: string, prompt: string) => void
  onChangeMask?: (id: string, maskUrl: string) => void
  onChangeBrush?: (id: string, brushSize: number) => void
  onChangeBrushColor?: (id: string, brushColor: RepaintBrushColor) => void
  onClearMask?: (id: string) => void
  onUsePrompt?: (prompt: string) => void
}

type WorkflowNode = Node<WorkflowNodeData, 'workflow'>

type ProjectFile = {
  version: 1 | 2
  projectName: string
  nodes: WorkflowNode[]
  edges: Edge[]
  history: GenerationRecord[]
}

type CanvasContextMenu = {
  x: number
  y: number
  flowPosition: XYPosition
}

const PROJECT_STORAGE_KEY = 'node-banana-local-project'
const API_STORAGE_KEY = 'node-banana-api-config'

const defaultApiConfig: ApiConfig = {
  mode: 'mock',
  endpoint: 'https://api.openai.com/v1/images/generations',
  apiKey: '',
  model: 'gpt-image-1',
  size: '1024x1024',
  bodyTemplate: '{\n  "model": "{model}",\n  "prompt": "{prompt}",\n  "size": "{size}",\n  "n": 1\n}',
  responsePath: 'data.0.url',
}

const grsAiModelOptions = [
  { label: 'GPT-image-2', value: 'gpt-image-2' },
  { label: 'Nano-banana-2', value: 'nano-banana-2' },
]
const defaultGrsAiModel = grsAiModelOptions[0].value

function normalizeGrsAiModel(model: string) {
  const value = model.trim().toLowerCase()
  return grsAiModelOptions.find((item) => item.value === value || item.label.toLowerCase() === value)?.value ?? defaultGrsAiModel
}

const grsAiApiConfig: Partial<ApiConfig> = {
  mode: 'grsai',
  endpoint: 'https://grsai.dakka.com.cn/v1/draw/completions',
  model: defaultGrsAiModel,
  responsePath: 'data.0.url',
}

const aspectRatioOptions: Array<{
  value: AspectRatioValue
  label: string
  size: string
  cssRatio: string
}> = [
  { value: '16:9', label: '16:9', size: '1536x864', cssRatio: '16 / 9' },
  { value: '3:2', label: '3:2', size: '1536x1024', cssRatio: '3 / 2' },
  { value: '4:3', label: '4:3', size: '1344x1024', cssRatio: '4 / 3' },
  { value: '1:1', label: '1:1', size: '1024x1024', cssRatio: '1 / 1' },
  { value: '3:4', label: '3:4', size: '1024x1344', cssRatio: '3 / 4' },
  { value: '2:3', label: '2:3', size: '1024x1536', cssRatio: '2 / 3' },
  { value: '9:16', label: '9:16', size: '864x1536', cssRatio: '9 / 16' },
]

const defaultAspectRatioOption = aspectRatioOptions.find((option) => option.value === '1:1') ?? aspectRatioOptions[0]

const starterPrompt =
  '一张未来感产品海报，深色背景，蓝色霓虹边缘光，主体是一台半透明的智能设备，电影级布光，高细节'

function id(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function readStoredApiConfig() {
  try {
    const saved = window.localStorage.getItem(API_STORAGE_KEY)
    const config = saved ? { ...defaultApiConfig, ...JSON.parse(saved) } : defaultApiConfig
    if (config.mode === 'grsai') {
      return { ...config, model: normalizeGrsAiModel(config.model) }
    }
    return config.apiKey?.trim() && config.mode === 'mock' ? { ...config, mode: 'openai' as const } : config
  } catch {
    return defaultApiConfig
  }
}

function cleanNode(node: WorkflowNode): WorkflowNode {
  const {
    onDelete,
    onDownload,
    onRevealImage,
    onGenerate,
    onChangeSize,
    onChangePrompt,
    onChangeMask,
    onChangeBrush,
    onChangeBrushColor,
    onClearMask,
    onUsePrompt,
    ...data
  } = node.data
  void onDelete
  void onDownload
  void onRevealImage
  void onGenerate
  void onChangeSize
  void onChangePrompt
  void onChangeMask
  void onChangeBrush
  void onChangeBrushColor
  void onClearMask
  void onUsePrompt
  const transientNode = node as WorkflowNode & { resizing?: boolean }
  const { measured, selected, dragging, resizing, ...stableNode } = transientNode
  void measured
  void selected
  void dragging
  void resizing
  return { ...stableNode, data } as WorkflowNode
}

function cleanEdge(edge: Edge): Edge {
  const { selected, ...stableEdge } = edge
  void selected
  return stableEdge
}

function normalizeImportedProject(project: Partial<ProjectFile>): ProjectFile {
  if (!Array.isArray(project.nodes) || !Array.isArray(project.edges)) {
    throw new Error('INVALID_PROJECT')
  }

  return {
    version: project.version === 2 ? 2 : 1,
    projectName: project.projectName || '导入项目',
    nodes: (project.nodes as WorkflowNode[]).map(cleanNode),
    edges: (project.edges as Edge[]).map(cleanEdge),
    history: Array.isArray(project.history) ? project.history : [],
  }
}

type PackageResponse = {
  sessionId?: string
  relativePath?: string
  filePath?: string
  cancelled?: boolean
  error?: string
}

async function readPackageResponse(response: Response) {
  const payload = (await response.json().catch(() => null)) as PackageResponse | null
  if (!response.ok) throw new Error(payload?.error || '项目包处理失败')
  return payload
}

async function startProjectPackage() {
  const payload = await readPackageResponse(await fetch('/api/projects/package/start', { method: 'POST' }))
  if (!payload?.sessionId) throw new Error('无法创建项目包')
  return payload.sessionId
}

async function addImageToProjectPackage(sessionId: string, imageUrl: string, index: number) {
  const payload = await readPackageResponse(
    await fetch('/api/projects/package/add-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, imageUrl, index }),
    }),
  )
  if (!payload?.relativePath) throw new Error('图片写入项目包失败')
  return payload.relativePath
}

async function buildPackageProject(
  sessionId: string,
  projectName: string,
  nodes: WorkflowNode[],
  edges: Edge[],
  history: GenerationRecord[],
) {
  const imageCache = new Map<string, string>()
  let imageIndex = 0

  async function cacheImage(imageUrl?: string) {
    if (!imageUrl) return imageUrl
    if (imageCache.has(imageUrl)) return imageCache.get(imageUrl)
    imageIndex += 1
    const relativePath = await addImageToProjectPackage(sessionId, imageUrl, imageIndex)
    imageCache.set(imageUrl, relativePath)
    return relativePath
  }

  const cleanNodes: WorkflowNode[] = []
  for (const node of nodes) {
    const clean = cleanNode(node)
    cleanNodes.push({
      ...clean,
      data: {
        ...clean.data,
        imageUrl: await cacheImage(clean.data.imageUrl),
        sourceImageUrl: await cacheImage(clean.data.sourceImageUrl),
        maskUrl: await cacheImage(clean.data.maskUrl),
      },
    })
  }

  const historyWithImages: GenerationRecord[] = []
  for (const item of history) {
    const nodeImageUrl = nodes.find((node) => node.id === item.id)?.data.imageUrl
    historyWithImages.push({
      ...item,
      imageUrl: await cacheImage(item.imageUrl || nodeImageUrl),
    })
  }

  return {
    version: 2,
    projectName,
    nodes: cleanNodes,
    edges: edges.map(cleanEdge),
    history: historyWithImages,
  } satisfies ProjectFile
}

function projectPackageFileName(projectName: string) {
  const name = (projectName || 'ai-canvas')
    .split('')
    .map((char) => (char.charCodeAt(0) < 32 || /[<>:"/\\|?*]/.test(char) ? '-' : char))
    .join('')
    .replace(/\s+/g, '-')
    .slice(0, 90)
  return `${name || 'ai-canvas'}.aicanvas.zip`
}

function getClientPosition(event: MouseEvent | TouchEvent): XYPosition | null {
  if ('changedTouches' in event) {
    const touch = event.changedTouches[0]
    return touch ? { x: touch.clientX, y: touch.clientY } : null
  }

  return { x: event.clientX, y: event.clientY }
}

function isKeyboardControlTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  return Boolean(target.closest('input, textarea, select, button, a, [role="button"], [contenteditable="true"]'))
}

async function cancelProjectPackage(sessionId: string) {
  try {
    await fetch('/api/projects/package/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    })
  } catch {
    // The server also clears abandoned package sessions on restart.
  }
}

function downloadImage(url: string, filename: string) {
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.target = '_blank'
  link.click()
}

function imageBaseName(projectName: string, nodeId: string) {
  return `${projectName || 'AI画布'}-${nodeId}`
}

async function saveImageAndOpenFolder(imageUrl: string, filename: string) {
  if (!['localhost', '127.0.0.1', '::1'].includes(window.location.hostname)) {
    downloadImage(await imageAsDataUrl(imageUrl), `${filename}.png`)
    return { downloaded: true, folderPath: '浏览器下载目录' }
  }

  const response = await fetch('/api/images/save-and-open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename, imageUrl }),
  })

  const payload = (await response.json().catch(() => null)) as { error?: string; filePath?: string; folderPath?: string } | null
  if (!response.ok) {
    throw new Error(payload?.error || '本地保存服务不可用')
  }

  return { ...payload, downloaded: false }
}

function escapeSvg(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function getAspectRatioOption(size?: string) {
  return aspectRatioOptions.find((option) => option.size === size) ?? defaultAspectRatioOption
}

function parseImageSize(size?: string) {
  const [width, height] = (size || defaultApiConfig.size).split('x').map(Number)
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    return { width, height }
  }
  return { width: 1024, height: 1024 }
}

function createMockImage(prompt: string, size = defaultApiConfig.size) {
  const { width, height } = parseImageSize(size)
  const shortPrompt = prompt.length > 96 ? `${prompt.slice(0, 96)}...` : prompt
  const panelX = width * 0.11
  const panelY = height * 0.12
  const panelWidth = width * 0.78
  const panelHeight = height * 0.76
  const titleY = height * 0.2
  const captionY = height * 0.68
  const promptBoxY = height * 0.61
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#17212c"/>
          <stop offset="48%" stop-color="#101822"/>
          <stop offset="100%" stop-color="#0b0f17"/>
        </linearGradient>
        <radialGradient id="r" cx="32%" cy="28%" r="68%">
          <stop offset="0%" stop-color="#61c7e8" stop-opacity=".42"/>
          <stop offset="60%" stop-color="#6b7b8f" stop-opacity=".16"/>
          <stop offset="100%" stop-color="#000" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <rect width="${width}" height="${height}" fill="url(#g)"/>
      <rect width="${width}" height="${height}" fill="url(#r)"/>
      <g fill="none" stroke="#61c7e8" stroke-opacity=".2">
        <path d="M${width * 0.14} ${height * 0.66} C${width * 0.25} ${height * 0.5} ${width * 0.35} ${height * 0.8} ${width * 0.5} ${height * 0.58} S${width * 0.74} ${height * 0.47} ${width * 0.88} ${height * 0.29}" stroke-width="8"/>
        <path d="M${width * 0.12} ${height * 0.3} C${width * 0.25} ${height * 0.18} ${width * 0.42} ${height * 0.27} ${width * 0.51} ${height * 0.17} S${width * 0.72} ${height * 0.11} ${width * 0.87} ${height * 0.21}" stroke-width="5"/>
      </g>
      <rect x="${panelX}" y="${panelY}" width="${panelWidth}" height="${panelHeight}" rx="42" fill="#0b1016" fill-opacity=".7" stroke="#8fa1b3" stroke-opacity=".28"/>
      <circle cx="${width * 0.73}" cy="${height * 0.3}" r="${Math.min(width, height) * 0.11}" fill="#61c7e8" fill-opacity=".13" stroke="#b7c7d6" stroke-opacity=".28"/>
      <rect x="${width * 0.17}" y="${promptBoxY}" width="${width * 0.66}" height="${height * 0.15}" rx="24" fill="#121820" fill-opacity=".82"/>
      <text x="${width * 0.5}" y="${titleY}" text-anchor="middle" fill="#f8fafc" font-family="Arial, sans-serif" font-size="${Math.max(26, Math.min(width, height) * 0.04)}" font-weight="700">AI Canvas Preview</text>
      <text x="${width * 0.5}" y="${captionY}" text-anchor="middle" fill="#e0f2fe" font-family="Arial, sans-serif" font-size="${Math.max(20, Math.min(width, height) * 0.03)}" font-weight="700">模拟生成图</text>
      <foreignObject x="${width * 0.19}" y="${height * 0.7}" width="${width * 0.62}" height="${height * 0.1}">
        <div xmlns="http://www.w3.org/1999/xhtml" style="font: 22px Arial, sans-serif; color:#cbd5e1; text-align:center; line-height:1.35;">
          ${escapeSvg(shortPrompt)}
        </div>
      </foreignObject>
    </svg>`

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

function getValueByPath(source: unknown, path: string) {
  if (!path.trim()) return source
  return path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean)
    .reduce<unknown>((value, key) => {
      if (value && typeof value === 'object' && key in value) {
        return (value as Record<string, unknown>)[key]
      }
      return undefined
    }, source)
}

function imageFromResponse(source: unknown, responsePath: string) {
  const direct = getValueByPath(source, responsePath)
  const fallbackUrl = getValueByPath(source, 'data.0.url')
  const fallbackBase64 = getValueByPath(source, 'data.0.b64_json')
  const value = direct ?? fallbackUrl ?? fallbackBase64

  if (typeof value !== 'string' || !value) {
    throw new Error('接口响应中没有找到图片地址或 base64 图片。')
  }

  if (value.startsWith('http') || value.startsWith('data:image/')) return value
  return `data:image/png;base64,${value}`
}

async function requestGeneratedImage(prompt: string, config: ApiConfig, referenceImageUrls: string[] = []) {
  if (config.mode === 'mock') {
    await new Promise((resolve) => window.setTimeout(resolve, 650))
    return createMockImage(prompt, config.size)
  }

  const response = await fetch('/api/images/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, config, referenceImageUrls }),
  })

  const json = await response.json().catch(() => null)
  if (!response.ok) {
    const message = typeof json?.error === 'string' ? json.error : `请求失败：${response.status} ${response.statusText}`
    throw new Error(message)
  }

  return imageFromResponse(json, config.responsePath)
}

async function imageAsDataUrl(imageUrl: string) {
  if (imageUrl.startsWith('data:image/')) return imageUrl
  const response = await fetch('/api/images/to-data-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageUrl }),
  })
  const payload = (await response.json().catch(() => null)) as { dataUrl?: string; error?: string } | null
  if (!response.ok || !payload?.dataUrl) throw new Error(payload?.error || '无法读取重绘图像')
  return payload.dataUrl
}

function loadCanvasImage(imageUrl: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('重绘图像加载失败'))
    image.src = imageUrl
  })
}

async function cacheCanvasImage(imageUrl: string) {
  const response = await fetch('/api/images/cache', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageUrl }),
  })
  const payload = (await response.json().catch(() => null)) as { imageUrl?: string; error?: string } | null
  if (!response.ok || !payload?.imageUrl) throw new Error(payload?.error || '重绘结果缓存失败')
  return payload.imageUrl
}

async function compositeRepaintResult(sourceImageUrl: string, generatedImageUrl: string, maskUrl: string) {
  const [sourceDataUrl, generatedDataUrl, maskDataUrl] = await Promise.all([
    imageAsDataUrl(sourceImageUrl),
    imageAsDataUrl(generatedImageUrl),
    imageAsDataUrl(maskUrl),
  ])
  const [sourceImage, generatedImage, maskImage] = await Promise.all([
    loadCanvasImage(sourceDataUrl),
    loadCanvasImage(generatedDataUrl),
    loadCanvasImage(maskDataUrl),
  ])
  const width = sourceImage.naturalWidth
  const height = sourceImage.naturalHeight
  if (!width || !height) throw new Error('原图尺寸无效')

  const resultCanvas = document.createElement('canvas')
  const patchCanvas = document.createElement('canvas')
  const maskCanvas = document.createElement('canvas')
  for (const canvas of [resultCanvas, patchCanvas, maskCanvas]) {
    canvas.width = width
    canvas.height = height
  }

  const resultContext = resultCanvas.getContext('2d')
  const patchContext = patchCanvas.getContext('2d')
  const maskContext = maskCanvas.getContext('2d', { willReadFrequently: true })
  if (!resultContext || !patchContext || !maskContext) throw new Error('浏览器无法合成重绘图像')

  resultContext.imageSmoothingQuality = 'high'
  patchContext.imageSmoothingQuality = 'high'
  maskContext.imageSmoothingQuality = 'high'
  resultContext.drawImage(sourceImage, 0, 0, width, height)
  maskContext.drawImage(maskImage, 0, 0, width, height)

  const maskPixels = maskContext.getImageData(0, 0, width, height)
  for (let index = 0; index < maskPixels.data.length; index += 4) {
    const alpha = maskPixels.data[index + 3]
    maskPixels.data[index] = 255
    maskPixels.data[index + 1] = 255
    maskPixels.data[index + 2] = 255
    maskPixels.data[index + 3] = alpha > 8 ? Math.min(255, (alpha - 8) * 1.5) : 0
  }
  maskContext.putImageData(maskPixels, 0, 0)

  patchContext.drawImage(generatedImage, 0, 0, width, height)
  patchContext.globalCompositeOperation = 'destination-in'
  patchContext.drawImage(maskCanvas, 0, 0)
  patchContext.globalCompositeOperation = 'source-over'
  resultContext.drawImage(patchCanvas, 0, 0)

  return cacheCanvasImage(resultCanvas.toDataURL('image/png'))
}

async function recolorRepaintMask(maskUrl: string, brushColor: RepaintBrushColor) {
  const maskImage = await loadCanvasImage(await imageAsDataUrl(maskUrl))
  const canvas = document.createElement('canvas')
  canvas.width = maskImage.naturalWidth
  canvas.height = maskImage.naturalHeight
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('浏览器无法处理重绘区域')
  context.drawImage(maskImage, 0, 0)
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
  const [red, green, blue] = repaintBrushOptions[brushColor].rgb
  for (let index = 0; index < pixels.data.length; index += 4) {
    if (pixels.data[index + 3] === 0) continue
    pixels.data[index] = red
    pixels.data[index + 1] = green
    pixels.data[index + 2] = blue
  }
  context.putImageData(pixels, 0, 0)
  return canvas.toDataURL('image/png')
}

type RepaintMaskEditorProps = {
  sourceImageUrl?: string
  maskUrl?: string
  brushSize: number
  brushColor: RepaintBrushColor
  size?: string
  aspectRatio: string
  disabled: boolean
  onChangeMask: (maskUrl: string) => void
}

function RepaintMaskEditor({
  sourceImageUrl,
  maskUrl,
  brushSize,
  brushColor,
  size,
  aspectRatio,
  disabled,
  onChangeMask,
}: RepaintMaskEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drawingRef = useRef(false)
  const lastPointRef = useRef<{ x: number; y: number } | null>(null)
  const canvasSize = parseImageSize(size)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const context = canvas.getContext('2d')
    if (!context) return
    context.clearRect(0, 0, canvas.width, canvas.height)
    if (!maskUrl) return

    const image = new Image()
    image.onload = () => {
      context.clearRect(0, 0, canvas.width, canvas.height)
      context.drawImage(image, 0, 0, canvas.width, canvas.height)
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
      const [red, green, blue] = repaintBrushOptions[brushColor].rgb
      for (let index = 0; index < pixels.data.length; index += 4) {
        if (pixels.data[index + 3] === 0) continue
        pixels.data[index] = red
        pixels.data[index + 1] = green
        pixels.data[index + 2] = blue
      }
      context.putImageData(pixels, 0, 0)
    }
    image.src = maskUrl
  }, [brushColor, maskUrl])

  function pointFromEvent(event: ReactPointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height,
    }
  }

  function drawTo(point: { x: number; y: number }) {
    const canvas = canvasRef.current
    const lastPoint = lastPointRef.current
    if (!canvas || !lastPoint) return
    const context = canvas.getContext('2d')
    if (!context) return
    context.lineCap = 'round'
    context.lineJoin = 'round'
    context.lineWidth = brushSize
    context.strokeStyle = repaintBrushOptions[brushColor].stroke
    context.beginPath()
    context.moveTo(lastPoint.x, lastPoint.y)
    context.lineTo(point.x, point.y)
    context.stroke()
    lastPointRef.current = point
  }

  function saveMask() {
    const canvas = canvasRef.current
    if (!canvas) return
    onChangeMask(canvas.toDataURL('image/png'))
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (disabled) return
    const point = pointFromEvent(event)
    if (!point) return
    event.currentTarget.setPointerCapture(event.pointerId)
    drawingRef.current = true
    lastPointRef.current = point
    drawTo({ x: point.x + 0.01, y: point.y + 0.01 })
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!drawingRef.current || disabled) return
    const point = pointFromEvent(event)
    if (point) drawTo(point)
  }

  function stopDrawing() {
    if (!drawingRef.current) return
    drawingRef.current = false
    lastPointRef.current = null
    saveMask()
  }

  return (
    <div className="repaint-editor nodrag nopan nowheel" style={{ aspectRatio }}>
      {sourceImageUrl ? <img src={sourceImageUrl} alt="重绘参考图" draggable={false} /> : <ImageIcon size={28} />}
      <canvas
        ref={canvasRef}
        width={canvasSize.width}
        height={canvasSize.height}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={stopDrawing}
        onPointerCancel={stopDrawing}
        onPointerLeave={stopDrawing}
      />
      <span className="repaint-hint">涂抹需要重绘的区域</span>
    </div>
  )
}

function WorkflowCard({ data, id: nodeId, selected }: NodeProps<WorkflowNode>) {
  const isImage = data.kind === 'image'
  const isPrompt = data.kind === 'prompt'
  const isReference = data.kind === 'reference'
  const isRepaint = data.kind === 'repaint'
  const isGenerating = data.status === 'generating'
  const isDone = data.status === 'done'
  const isError = data.status === 'error'
  const selectedAspectRatio = getAspectRatioOption(data.size)
  const selectedAspectRatioIndex = Math.max(
    0,
    aspectRatioOptions.findIndex((option) => option.size === selectedAspectRatio.size),
  )
  const aspectRatioProgress = (selectedAspectRatioIndex / (aspectRatioOptions.length - 1)) * 100
  const brushSize = data.brushSize || 36
  const brushColor = data.brushColor || 'red'

  return (
    <div className={`workflow-node ${selected ? 'selected' : ''} ${data.kind}`}>
      <Handle type="target" position={Position.Left} className="node-handle" />
      <div className="node-head">
        <div className="node-title">
          {isRepaint ? (
            <Brush size={15} />
          ) : isImage ? (
            <ImageIcon size={15} />
          ) : isReference ? (
            <UploadCloud size={15} />
          ) : (
            <Wand2 size={15} />
          )}
          <span>{data.title}</span>
        </div>
        <div className={`node-status ${data.status}`}>
          {isGenerating && <Loader2 size={13} />}
          {isDone && <CheckCircle2 size={13} />}
          {isError && <AlertTriangle size={13} />}
          <span>{isGenerating ? '生成中' : isDone ? '完成' : isError ? '失败' : '就绪'}</span>
        </div>
      </div>

      {(isPrompt || isRepaint) ? (
        <label className="image-prompt-control nodrag nopan nowheel">
          <span>提示词</span>
          <textarea
            value={data.prompt || ''}
            rows={isRepaint ? 4 : 5}
            placeholder={isRepaint ? '描述涂抹区域要重绘成什么' : '输入提示词'}
            onChange={(event) => data.onChangePrompt?.(nodeId, event.target.value)}
          />
        </label>
      ) : (
        data.prompt && <p className="node-prompt">{data.prompt}</p>
      )}

      {(isImage || isReference) && (
        data.imageUrl ? (
          <img
            className="node-image"
            src={data.imageUrl}
            alt={data.title}
            draggable={false}
            style={isImage ? { aspectRatio: selectedAspectRatio.cssRatio } : undefined}
          />
        ) : (
          <div className="node-empty" style={isImage ? { aspectRatio: selectedAspectRatio.cssRatio } : undefined}>
            <ImageIcon size={28} />
            <span>{isGenerating ? '正在调用图像接口...' : '等待图像'}</span>
          </div>
        )
      )}

      {isRepaint && (
        <>
          <RepaintMaskEditor
            sourceImageUrl={data.sourceImageUrl}
            maskUrl={data.maskUrl}
            brushSize={brushSize}
            brushColor={brushColor}
            size={data.size}
            aspectRatio={selectedAspectRatio.cssRatio}
            disabled={isGenerating}
            onChangeMask={(maskUrl) => data.onChangeMask?.(nodeId, maskUrl)}
          />
          <div className="repaint-controls nodrag nopan nowheel">
            <div className="repaint-color-picker" role="group" aria-label="重绘画笔颜色">
              <span>颜色</span>
              <div className="repaint-color-options">
                {(Object.keys(repaintBrushOptions) as RepaintBrushColor[]).map((color) => (
                  <button
                    key={color}
                    type="button"
                    className={`repaint-color-swatch ${color} ${brushColor === color ? 'active' : ''}`}
                    aria-label={`${repaintBrushOptions[color].label}画笔`}
                    aria-pressed={brushColor === color}
                    title={`${repaintBrushOptions[color].label}画笔`}
                    onClick={() => data.onChangeBrushColor?.(nodeId, color)}
                    disabled={isGenerating}
                  >
                    <span />
                  </button>
                ))}
              </div>
            </div>
            <label className="repaint-size-control">
              <span>画笔</span>
              <input
                type="range"
                min="10"
                max="96"
                value={brushSize}
                onChange={(event) => data.onChangeBrush?.(nodeId, Number(event.target.value))}
              />
              <em>{brushSize}</em>
            </label>
            <button type="button" onClick={() => data.onClearMask?.(nodeId)} disabled={isGenerating || !data.maskUrl}>
              清除区域
            </button>
          </div>
        </>
      )}

      {data.error && <div className="node-error">{data.error}</div>}

      {(isImage || isRepaint) && (
        <button
          className="node-generate-button nodrag nopan"
          type="button"
          onClick={() => data.onGenerate?.(nodeId)}
          disabled={isGenerating}
        >
          {isGenerating ? <Loader2 size={15} /> : <Sparkles size={15} />}
          {isGenerating ? '生成中...' : isRepaint ? (isDone ? '重新重绘' : '重绘生成') : isDone ? '重新生成' : '生成'}
        </button>
      )}

      {isReference && (
        <label className="reference-size-control nodrag nopan">
          <span>生成比例</span>
          <select value={data.size || defaultApiConfig.size} onChange={(event) => data.onChangeSize?.(nodeId, event.target.value)}>
            {aspectRatioOptions.map((option) => (
              <option key={option.value} value={option.size}>
                {option.label} · {option.size}
              </option>
            ))}
          </select>
        </label>
      )}

      {(isImage || isRepaint) && (
        <div className="aspect-ratio-control nodrag nopan" aria-label="尺寸比例">
          <div className="aspect-ratio-heading">
            <span>尺寸比例</span>
            <output>
              <strong>{selectedAspectRatio.label}</strong>
              <small>{selectedAspectRatio.size.replace('x', ' × ')}</small>
            </output>
          </div>
          <div
            className="aspect-ratio-slider"
            style={{ '--ratio-progress': `${aspectRatioProgress}%` } as CSSProperties}
          >
            <input
              type="range"
              min="0"
              max={aspectRatioOptions.length - 1}
              step="1"
              value={selectedAspectRatioIndex}
              aria-label="选择尺寸比例"
              aria-valuetext={`${selectedAspectRatio.label}，${selectedAspectRatio.size}`}
              onPointerDown={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
              onChange={(event) => {
                const option = aspectRatioOptions[Number(event.target.value)]
                if (option) data.onChangeSize?.(nodeId, option.size)
              }}
            />
            <div className="aspect-ratio-marks">
              {aspectRatioOptions.map((option) => (
                <button
                  key={option.value}
                  className={option.size === selectedAspectRatio.size ? 'active' : ''}
                  type="button"
                  title={`${option.label} · ${option.size}`}
                  aria-label={`选择 ${option.label} 比例`}
                  aria-pressed={option.size === selectedAspectRatio.size}
                  onClick={() => data.onChangeSize?.(nodeId, option.size)}
                >
                  <i className="ratio-icon" style={{ aspectRatio: option.cssRatio }} />
                  <span>{option.label}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {!isPrompt && (
        <>
          {isReference && (
            <div className="node-meta">
              <span>{data.sourceName || '参考图'}</span>
            </div>
          )}

          <div className="node-actions">
            {data.imageUrl && (
              <button type="button" title="下载图像" onClick={() => data.onDownload?.(nodeId)}>
                <Download size={14} />
              </button>
            )}
            {(isImage || isRepaint) && data.imageUrl && (
              <button type="button" title="保存并查看所在文件夹" onClick={() => data.onRevealImage?.(nodeId)}>
                <FolderOpen size={14} />
              </button>
            )}
            <button type="button" title="删除节点" onClick={() => data.onDelete?.(nodeId)}>
              <Trash2 size={14} />
            </button>
          </div>
        </>
      )}
      <Handle
        type="source"
        position={Position.Right}
        className={`node-handle ${isReference ? 'reference-output-handle' : isImage || isRepaint ? 'repaint-output-handle' : ''}`}
        title={
          isReference
            ? '向右拖出生成图像框'
            : isImage
              ? '向右拖出重绘生成节点'
              : isRepaint
                ? '重绘完成后向右拖出生成图像框'
                : undefined
        }
      />
    </div>
  )
}

const workflowNodeTypes = { workflow: WorkflowCard }

export default function App() {
  const importInputRef = useRef<HTMLInputElement>(null)
  const referenceInputRef = useRef<HTMLInputElement>(null)
  const pendingNodePositionRef = useRef<XYPosition | null>(null)
  const connectingFromNodeIdRef = useRef<string | null>(null)
  const [nodes, setNodes, onNodesChange] = useNodesState<WorkflowNode>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const [, setPrompt] = useState(starterPrompt)
  const [projectName, setProjectName] = useState('未命名项目')
  const [dirty, setDirty] = useState(false)
  const [, setIsGenerating] = useState(false)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [showHistoryPanel, setShowHistoryPanel] = useState(false)
  const [showPromptLibrary, setShowPromptLibrary] = useState(false)
  const [copiedPromptId, setCopiedPromptId] = useState<string | null>(null)
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance<WorkflowNode, Edge> | null>(null)
  const [contextMenu, setContextMenu] = useState<CanvasContextMenu | null>(null)
  const [apiConfig, setApiConfig] = useState<ApiConfig>(() => readStoredApiConfig())
  const [history, setHistory] = useState<GenerationRecord[]>([])
  const [isExporting, setIsExporting] = useState(false)
  const [, setToast] = useState('已准备好，默认使用本地模拟生成。')

  const markDirty = useCallback(() => setDirty(true), [])

  const handleNodesChange = useCallback(
    (changes: NodeChange<WorkflowNode>[]) => {
      onNodesChange(changes)
      markDirty()
    },
    [markDirty, onNodesChange],
  )

  const handleEdgesChange = useCallback(
    (changes: EdgeChange<Edge>[]) => {
      onEdgesChange(changes)
      markDirty()
    },
    [markDirty, onEdgesChange],
  )

  const handleConnect = useCallback(
    (connection: Connection) => {
      setEdges((current) =>
        addEdge(
          {
            ...connection,
            animated: true,
          markerEnd: { type: MarkerType.ArrowClosed, color: '#61c7e8' },
          style: { stroke: '#61c7e8' },
          },
          current,
        ),
      )
      markDirty()
    },
    [markDirty, setEdges],
  )

  const updateNodeData = useCallback(
    (nodeId: string, patch: Partial<WorkflowNodeData>) => {
      setNodes((current) =>
        current.map((node) =>
          node.id === nodeId ? { ...node, data: { ...node.data, ...patch } } : node,
        ),
      )
      markDirty()
    },
    [markDirty, setNodes],
  )

  const deleteNodesByIds = useCallback(
    (nodeIds: string[]) => {
      const idsToDelete = new Set(nodeIds.filter(Boolean))
      if (!idsToDelete.size) return

      setNodes((current) => current.filter((node) => !idsToDelete.has(node.id)))
      setEdges((current) => current.filter((edge) => !idsToDelete.has(edge.source) && !idsToDelete.has(edge.target)))
      setSelectedNodeId((current) => (current && idsToDelete.has(current) ? null : current))
      markDirty()
      setToast(idsToDelete.size > 1 ? `已删除 ${idsToDelete.size} 个画布节点。` : '已删除选中的画布节点。')
    },
    [markDirty, setEdges, setNodes],
  )

  const deleteNode = useCallback(
    (nodeId: string) => {
      deleteNodesByIds([nodeId])
    },
    [deleteNodesByIds],
  )

  const handleDeleteKey = useCallback(
    (event: KeyboardEvent) => {
      if (event.key !== 'Delete' || showSettings || isKeyboardControlTarget(event.target)) return

      const selectedNodeIds = nodes.filter((node) => node.selected).map((node) => node.id)
      if (selectedNodeId && !selectedNodeIds.includes(selectedNodeId)) selectedNodeIds.push(selectedNodeId)
      if (!selectedNodeIds.length) return

      event.preventDefault()
      deleteNodesByIds(selectedNodeIds)
    },
    [deleteNodesByIds, nodes, selectedNodeId, showSettings],
  )

  useEffect(() => {
    window.addEventListener('keydown', handleDeleteKey, true)
    return () => window.removeEventListener('keydown', handleDeleteKey, true)
  }, [handleDeleteKey])

  const downloadNodeImage = useCallback(
    (nodeId: string) => {
      const node = nodes.find((item) => item.id === nodeId)
      if (node?.data.imageUrl) {
        downloadImage(node.data.imageUrl, `${imageBaseName(projectName, nodeId)}.png`)
      }
    },
    [nodes, projectName],
  )

  const revealNodeImage = useCallback(
    async (nodeId: string) => {
      const node = nodes.find((item) => item.id === nodeId)
      if (!node?.data.imageUrl) {
        setToast('这个节点还没有可查看的图像。')
        return
      }

      const fileBaseName = imageBaseName(projectName, nodeId)

      try {
        const result = await saveImageAndOpenFolder(node.data.imageUrl, fileBaseName)
        setToast(result?.downloaded ? '图像已下载到浏览器下载目录。' : `已保存并打开所在文件夹：${result?.folderPath || 'generated-images'}`)
      } catch (error) {
        downloadImage(node.data.imageUrl, `${fileBaseName}.png`)
        const message = error instanceof Error ? error.message : '无法打开本地文件夹'
        setToast(`${message}，已改为浏览器下载。可在浏览器下载列表中打开所在文件夹。`)
      }
    },
    [nodes, projectName],
  )

  const revealHistoryImage = useCallback(
    async (item: GenerationRecord) => {
      const imageUrl = item.imageUrl || nodes.find((node) => node.id === item.id)?.data.imageUrl
      if (!imageUrl) {
        setToast('这条历史记录没有可打开的图像。')
        return
      }

      try {
        const result = await saveImageAndOpenFolder(imageUrl, imageBaseName(projectName, item.id))
        setToast(result?.downloaded ? '图像已下载到浏览器下载目录。' : `已保存并打开所在文件夹：${result?.folderPath || 'generated-images'}`)
      } catch (error) {
        const message = error instanceof Error ? error.message : '无法打开本地文件夹'
        setToast(message)
      }
    },
    [nodes, projectName],
  )

  const useNodePrompt = useCallback((value: string) => {
    setPrompt(value)
    setToast('已复制节点提示词到生成面板。')
  }, [])

  const changeNodeSize = useCallback(
    (nodeId: string, size: string) => {
      const ratio = getAspectRatioOption(size)
      updateNodeData(nodeId, { size })
      setToast(`尺寸比例已设为 ${ratio.label}（${size}）。`)
    },
    [updateNodeData],
  )

  const changeNodePrompt = useCallback(
    (nodeId: string, value: string) => {
      updateNodeData(nodeId, { prompt: value })
    },
    [updateNodeData],
  )

  const changeNodeMask = useCallback(
    (nodeId: string, maskUrl: string) => {
      updateNodeData(nodeId, { maskUrl })
    },
    [updateNodeData],
  )

  const changeNodeBrush = useCallback(
    (nodeId: string, brushSize: number) => {
      updateNodeData(nodeId, { brushSize })
    },
    [updateNodeData],
  )

  const changeNodeBrushColor = useCallback(
    (nodeId: string, brushColor: RepaintBrushColor) => {
      setNodes((current) =>
        current.map((node) =>
          node.id === nodeId
            ? {
                ...node,
                data: {
                  ...node.data,
                  brushColor,
                  prompt: repaintPromptWithColor(node.data.prompt || '', brushColor),
                },
              }
            : node,
        ),
      )
      markDirty()
    },
    [markDirty, setNodes],
  )

  const clearNodeMask = useCallback(
    (nodeId: string) => {
      updateNodeData(nodeId, { maskUrl: undefined })
    },
    [updateNodeData],
  )

  const createReferenceOutput = useCallback(
    async (
      sourceNode: WorkflowNode,
      dropPosition: XYPosition,
      initialData: Partial<WorkflowNodeData> = {},
    ) => {
      const outputSize = sourceNode.data.size || apiConfig.size || defaultApiConfig.size
      const imageNodeId = id('image')
      const createdAt = new Date().toLocaleString('zh-CN')
      const releasedY = dropPosition.y - 180
      const position = {
        x: sourceNode.position.x + 380,
        y: Math.min(Math.max(releasedY, sourceNode.position.y - 40), sourceNode.position.y + 120),
      }
      const imageNode: WorkflowNode = {
        id: imageNodeId,
        type: 'workflow',
        position,
        data: {
          kind: 'image',
          title: 'AI 生成图像',
          status: 'idle',
          model: apiConfig.model,
          size: outputSize,
          createdAt,
          ...initialData,
        },
      }

      setNodes((current) => [...current, imageNode])
      setEdges((current) => [
        ...current,
        {
          id: id('edge'),
          source: sourceNode.id,
          target: imageNodeId,
          animated: true,
          markerEnd: { type: MarkerType.ArrowClosed, color: '#61c7e8' },
          style: { stroke: '#61c7e8', strokeWidth: 1.6 },
        },
      ])
      setSelectedNodeId(imageNodeId)
      markDirty()
      window.setTimeout(() => {
        void flowInstance?.fitView({
          nodes: [{ id: sourceNode.id }, { id: imageNodeId }],
          padding: 0.22,
          maxZoom: 0.95,
          duration: 180,
        })
      }, 0)
      setToast(
        sourceNode.data.kind === 'repaint'
          ? `已创建 ${outputSize} 生成框，重绘结果和提示词已连接。`
          : `已创建 ${outputSize} 生成框，请连接提示词和参考图后点击生成。`,
      )
    },
    [apiConfig, flowInstance, markDirty, setEdges, setNodes],
  )

  const createRepaintOutput = useCallback(
    async (sourceNode: WorkflowNode, dropPosition: XYPosition) => {
      if (!sourceNode.data.imageUrl) {
        setToast('请先生成图像，再从右侧拖出重绘节点。')
        return
      }

      const outputSize = sourceNode.data.size || apiConfig.size || defaultApiConfig.size
      const repaintNodeId = id('repaint')
      const createdAt = new Date().toLocaleString('zh-CN')
      const releasedY = dropPosition.y - 210
      const position = {
        x: sourceNode.position.x + 410,
        y: Math.min(Math.max(releasedY, sourceNode.position.y - 72), sourceNode.position.y + 120),
      }
      const repaintNode: WorkflowNode = {
        id: repaintNodeId,
        type: 'workflow',
        position,
        data: {
          kind: 'repaint',
          title: '重绘生成',
          prompt: repaintPromptWithColor('', 'red'),
          sourceImageUrl: sourceNode.data.imageUrl,
          brushSize: 36,
          brushColor: 'red',
          status: 'idle',
          model: apiConfig.model,
          size: outputSize,
          createdAt,
        },
      }

      setNodes((current) => [...current, repaintNode])
      setEdges((current) => [
        ...current,
        {
          id: id('edge'),
          source: sourceNode.id,
          target: repaintNodeId,
          animated: true,
          markerEnd: { type: MarkerType.ArrowClosed, color: '#61c7e8' },
          style: { stroke: '#61c7e8', strokeWidth: 1.6 },
        },
      ])
      setSelectedNodeId(repaintNodeId)
      markDirty()
      window.setTimeout(() => {
        void flowInstance?.fitView({
          nodes: [{ id: sourceNode.id }, { id: repaintNodeId }],
          padding: 0.22,
          maxZoom: 0.95,
          duration: 180,
        })
      }, 0)
      setToast('已创建重绘节点，涂抹区域并输入提示词后点击重绘生成。')
    },
    [apiConfig, flowInstance, markDirty, setEdges, setNodes],
  )

  const handleConnectStart = useCallback<OnConnectStart>((_, params) => {
    connectingFromNodeIdRef.current = params.handleType === 'source' ? params.nodeId : null
  }, [])

  const handleConnectEnd = useCallback<OnConnectEnd>(
    (event, connectionState) => {
      const sourceId = connectionState.fromNode?.id ?? connectionState.fromHandle?.nodeId ?? connectingFromNodeIdRef.current
      connectingFromNodeIdRef.current = null
      if (connectionState.toNode || connectionState.fromHandle?.type === 'target') return

      const sourceNode = nodes.find((node) => node.id === sourceId)
      if (!sourceNode || !flowInstance) return

      const clientPosition = getClientPosition(event)
      if (!clientPosition) return

      const dropPosition = flowInstance.screenToFlowPosition(clientPosition, {
        snapToGrid: true,
        snapGrid: [24, 24],
      })
      if (sourceNode.data.kind === 'reference') {
        void createReferenceOutput(sourceNode, dropPosition)
      }
      if (sourceNode.data.kind === 'image') {
        void createRepaintOutput(sourceNode, dropPosition)
      }
      if (sourceNode.data.kind === 'repaint') {
        if (!sourceNode.data.imageUrl) {
          setToast('请先完成重绘，再从右侧拖出生成图像框。')
          return
        }
        void createReferenceOutput(sourceNode, dropPosition)
      }
    },
    [createReferenceOutput, createRepaintOutput, flowInstance, nodes],
  )

  const closeContextMenu = useCallback(() => {
    setContextMenu(null)
  }, [])

  const handlePaneContextMenu = useCallback(
    (event: MouseEvent | ReactMouseEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null
      if (target?.closest('.canvas-context-menu')) return

      event.preventDefault()
      if (target?.closest('.workflow-node, .react-flow__controls')) return

      const clientPosition = { x: event.clientX, y: event.clientY }
      const menuPosition = {
        x: Math.min(clientPosition.x, window.innerWidth - 210),
        y: Math.min(clientPosition.y, window.innerHeight - 92),
      }
      const flowPosition =
        flowInstance?.screenToFlowPosition(clientPosition, {
          snapToGrid: true,
          snapGrid: [24, 24],
        }) ?? clientPosition

      setSelectedNodeId(null)
      setContextMenu({
        x: Math.max(8, menuPosition.x),
        y: Math.max(8, menuPosition.y),
        flowPosition,
      })
    },
    [flowInstance],
  )

  const handlePaneClick = useCallback(() => {
    setSelectedNodeId(null)
    closeContextMenu()
  }, [closeContextMenu])

  const nodesWithActions = nodes.map((node) => ({
    ...node,
    data: {
      ...node.data,
      onDelete: deleteNode,
      onDownload: downloadNodeImage,
      onRevealImage: (nodeId: string) => void revealNodeImage(nodeId),
      onGenerate: (nodeId: string) => void generateFromNode(nodeId),
      onChangeSize: changeNodeSize,
      onChangePrompt: changeNodePrompt,
      onChangeMask: changeNodeMask,
      onChangeBrush: changeNodeBrush,
      onChangeBrushColor: changeNodeBrushColor,
      onClearMask: clearNodeMask,
      onUsePrompt: useNodePrompt,
    },
  }))

  async function runGeneration(sourcePrompt: string, sourceNodeId?: string) {
    const trimmed = sourcePrompt.trim()
    if (!trimmed) {
      setToast('请先输入提示词。')
      return
    }

    setIsGenerating(true)
    const baseIndex = nodes.length
    const baseX = 80 + (baseIndex % 2) * 520
    const baseY = 80 + Math.floor(baseIndex / 2) * 390
    const sourceNode = sourceNodeId ? nodes.find((item) => item.id === sourceNodeId) : null
    const outputSize = sourceNode?.data.size || apiConfig.size || defaultApiConfig.size
    const configForNode = { ...apiConfig, size: outputSize }
    const promptNodeId = sourceNodeId ?? id('prompt')
    const imageNodeId = id('image')
    const createdAt = new Date().toLocaleString('zh-CN')

    const promptNode: WorkflowNode | null = sourceNodeId
      ? null
      : {
          id: promptNodeId,
          type: 'workflow',
          position: { x: baseX, y: baseY },
          data: {
            kind: 'prompt',
            title: '提示词节点',
            prompt: trimmed,
            status: 'idle',
            model: apiConfig.model,
            size: outputSize,
            createdAt,
          },
        }

    const imageNode: WorkflowNode = {
      id: imageNodeId,
      type: 'workflow',
      position: {
        x: sourceNode ? sourceNode.position.x + 380 : baseX + 410,
        y: sourceNode ? sourceNode.position.y : baseY,
      },
      data: {
        kind: 'image',
        title: 'AI 生成图像',
        status: 'generating',
        model: apiConfig.model,
        size: outputSize,
        createdAt,
      },
    }

    setNodes((current) => [...current, ...(promptNode ? [promptNode] : []), imageNode])
    setEdges((current) => [
      ...current,
      {
        id: id('edge'),
        source: promptNodeId,
        target: imageNodeId,
        animated: true,
        markerEnd: { type: MarkerType.ArrowClosed, color: '#61c7e8' },
        style: { stroke: '#61c7e8' },
      },
    ])
    setSelectedNodeId(imageNodeId)
    markDirty()

    try {
      const referenceSourceNode = sourceNodeId
        ? edges
            .filter((edge) => edge.target === sourceNodeId)
            .map((edge) => nodes.find((item) => item.id === edge.source))
            .find((item): item is WorkflowNode => item?.data.kind === 'reference' && Boolean(item.data.imageUrl))
        : null
      const imageUrl = await requestGeneratedImage(
        trimmed,
        configForNode,
        referenceSourceNode?.data.imageUrl ? [referenceSourceNode.data.imageUrl] : [],
      )
      updateNodeData(imageNodeId, { imageUrl, status: 'done', error: undefined })
      setHistory((current) => [
        {
          id: imageNodeId,
          prompt: trimmed,
          model: apiConfig.model,
          size: outputSize,
          createdAt,
          imageUrl,
          status: '成功',
        },
        ...current,
      ])
      setToast(apiConfig.mode === 'mock' ? '已生成模拟图像。配置 API 后可生成真实图像。' : '图像已生成并加入画布。')
    } catch (error) {
      const message = error instanceof Error ? error.message : '生成失败'
      updateNodeData(imageNodeId, { status: 'error', error: message })
      setHistory((current) => [
        {
          id: imageNodeId,
          prompt: trimmed,
          model: apiConfig.model,
          size: outputSize,
          createdAt,
          status: '失败',
        },
        ...current,
      ])
      setToast(message)
    } finally {
      setIsGenerating(false)
    }
  }

  async function generateImageInNode(nodeId: string) {
    const node = nodes.find((item) => item.id === nodeId)
    if (!node || node.data.kind !== 'image') return

    const sourceNodes = edges
      .filter((edge) => edge.target === nodeId)
      .map((edge) => nodes.find((item) => item.id === edge.source))
      .filter((item): item is WorkflowNode => Boolean(item))
    const promptSourceNode =
      sourceNodes.find((item) => item.data.kind === 'prompt' && item.data.prompt?.trim()) ??
      sourceNodes.find((item) => item.data.kind === 'repaint' && item.data.prompt?.trim())
    const referenceImageUrls = sourceNodes
      .filter((item) => item.data.imageUrl)
      .map((item) => item.data.imageUrl as string)
    const trimmed = promptSourceNode?.data.prompt?.trim() || node.data.prompt?.trim() || ''

    if (!trimmed) {
      setToast('请先在连接的提示词输入框里输入提示词。')
      return
    }

    const outputSize = node.data.size || apiConfig.size || defaultApiConfig.size
    const configForNode = { ...apiConfig, size: outputSize }
    const createdAt = new Date().toLocaleString('zh-CN')

    setIsGenerating(true)
    updateNodeData(nodeId, {
      status: 'generating',
      error: undefined,
      model: apiConfig.model,
      size: outputSize,
    })

    try {
      const imageUrl = await requestGeneratedImage(trimmed, configForNode, referenceImageUrls)
      updateNodeData(nodeId, {
        imageUrl,
        status: 'done',
        error: undefined,
        model: apiConfig.model,
        size: outputSize,
      })
      setHistory((current) => [
        {
          id: nodeId,
          prompt: trimmed,
          model: apiConfig.model,
          size: outputSize,
          createdAt,
          imageUrl,
          status: '成功',
        },
        ...current,
      ])
      setToast(apiConfig.mode === 'mock' ? `已在图像框内生成 ${outputSize} 模拟图。` : `已在图像框内生成 ${outputSize} 图像。`)
    } catch (error) {
      const message = error instanceof Error ? error.message : '生成失败'
      updateNodeData(nodeId, { status: 'error', error: message })
      setHistory((current) => [
        {
          id: nodeId,
          prompt: trimmed,
          model: apiConfig.model,
          size: outputSize,
          createdAt,
          status: '失败',
        },
        ...current,
      ])
      setToast(message)
    } finally {
      setIsGenerating(false)
    }
  }

  async function generateRepaintInNode(nodeId: string) {
    const node = nodes.find((item) => item.id === nodeId)
    if (!node || node.data.kind !== 'repaint') return

    const sourceNodes = edges
      .filter((edge) => edge.target === nodeId)
      .map((edge) => nodes.find((item) => item.id === edge.source))
      .filter((item): item is WorkflowNode => Boolean(item))
    const imageSourceNode = sourceNodes.find((item) => item.data.kind === 'image' && item.data.imageUrl)
    const promptSourceNode = sourceNodes.find((item) => item.data.kind === 'prompt' && item.data.prompt?.trim())
    const sourceImageUrl = imageSourceNode?.data.imageUrl || node.data.sourceImageUrl
    const maskUrl = node.data.maskUrl
    const trimmed = promptSourceNode?.data.prompt?.trim() || node.data.prompt?.trim() || ''
    const brushColor = node.data.brushColor || 'red'
    const repaintBody = repaintPromptBody(trimmed)

    if (!sourceImageUrl) {
      updateNodeData(nodeId, { status: 'error', error: '请先从已生成的图像右侧拖出重绘节点。' })
      return
    }

    if (!maskUrl) {
      updateNodeData(nodeId, { status: 'error', error: '请先用画笔涂抹需要重绘的区域。' })
      return
    }

    if (!repaintBody) {
      updateNodeData(nodeId, { status: 'error', error: '请输入重绘提示词。' })
      return
    }

    const outputSize = node.data.size || imageSourceNode?.data.size || apiConfig.size || defaultApiConfig.size
    const configForNode = { ...apiConfig, size: outputSize }
    const createdAt = new Date().toLocaleString('zh-CN')
    const repaintPrompt = repaintPromptWithColor(repaintBody, brushColor)

    setIsGenerating(true)
    updateNodeData(nodeId, {
      status: 'generating',
      error: undefined,
      prompt: repaintPrompt,
      brushColor,
      model: apiConfig.model,
      size: outputSize,
    })

    try {
      const coloredMaskUrl = await recolorRepaintMask(maskUrl, brushColor)
      const generatedImageUrl = await requestGeneratedImage(repaintPrompt, configForNode, [sourceImageUrl, coloredMaskUrl])
      const imageUrl = await compositeRepaintResult(sourceImageUrl, generatedImageUrl, coloredMaskUrl)
      updateNodeData(nodeId, {
        imageUrl,
        sourceImageUrl,
        status: 'done',
        error: undefined,
        model: apiConfig.model,
        size: outputSize,
      })
      setHistory((current) => [
        {
          id: nodeId,
          prompt: repaintPrompt,
          model: apiConfig.model,
          size: outputSize,
          createdAt,
          imageUrl,
          status: '成功',
        },
        ...current,
      ])
      const completedRepaintNode: WorkflowNode = {
        ...node,
        data: {
          ...node.data,
          prompt: repaintPrompt,
          imageUrl,
          sourceImageUrl,
          brushColor,
          status: 'done',
          error: undefined,
          model: apiConfig.model,
          size: outputSize,
        },
      }
      await createReferenceOutput(
        completedRepaintNode,
        { x: node.position.x + 380, y: node.position.y + 180 },
        {
          prompt: repaintPrompt,
          imageUrl,
          status: 'done',
          error: undefined,
          model: apiConfig.model,
          size: outputSize,
        },
      )
      setToast(
        apiConfig.mode === 'mock'
          ? `已生成 ${outputSize} 重绘模拟图，并自动连接到右侧图像框。`
          : `已生成 ${outputSize} 重绘图像，并自动连接到右侧图像框。`,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : '重绘生成失败'
      updateNodeData(nodeId, { status: 'error', error: message })
      setHistory((current) => [
        {
          id: nodeId,
          prompt: trimmed,
          model: apiConfig.model,
          size: outputSize,
          createdAt,
          status: '失败',
        },
        ...current,
      ])
      setToast(message)
    } finally {
      setIsGenerating(false)
    }
  }

  function generateFromNode(nodeId: string) {
    const node = nodes.find((item) => item.id === nodeId)
    if (node?.data.kind === 'image') {
      void generateImageInNode(node.id)
      return
    }
    if (node?.data.kind === 'repaint') {
      void generateRepaintInNode(node.id)
      return
    }
    if (node?.data.prompt) {
      void runGeneration(node.data.prompt, node.id)
    }
  }

  function addPromptInputNodeAt(position: XYPosition) {
    const node: WorkflowNode = {
      id: id('prompt'),
      type: 'workflow',
      position,
      data: {
        kind: 'prompt',
        title: '提示词输入框',
        prompt: '',
        status: 'idle',
        model: apiConfig.model,
        size: apiConfig.size,
        createdAt: new Date().toLocaleString('zh-CN'),
      },
    }
    setNodes((current) => [...current, node])
    setSelectedNodeId(node.id)
    markDirty()
    setToast('已在画布中添加提示词输入框。')
  }

  function addPromptInputFromMenu() {
    if (!contextMenu) return
    addPromptInputNodeAt(contextMenu.flowPosition)
    closeContextMenu()
  }

  function uploadReferenceFromMenu() {
    if (contextMenu) {
      pendingNodePositionRef.current = contextMenu.flowPosition
    }
    closeContextMenu()
    referenceInputRef.current?.click()
  }

  function saveProject() {
    const project: ProjectFile = {
      version: 1,
      projectName,
      nodes: nodes.map(cleanNode),
      edges: edges.map(cleanEdge),
      history,
    }
    window.localStorage.setItem(PROJECT_STORAGE_KEY, JSON.stringify(project))
    window.localStorage.setItem(API_STORAGE_KEY, JSON.stringify(apiConfig))
    setDirty(false)
    setToast('项目已保存到当前浏览器。')
  }

  function openProject() {
    const saved = window.localStorage.getItem(PROJECT_STORAGE_KEY)
    if (!saved) {
      setToast('当前浏览器没有已保存项目。')
      return
    }
    const project = normalizeImportedProject(JSON.parse(saved) as Partial<ProjectFile>)
    setProjectName(project.projectName || '未命名项目')
    setNodes(project.nodes || [])
    setEdges(project.edges || [])
    setHistory(project.history || [])
    setDirty(false)
    setToast('已打开本地保存项目。')
  }

  function newProject() {
    setProjectName('未命名项目')
    setNodes([])
    setEdges([])
    setHistory([])
    setSelectedNodeId(null)
    setDirty(false)
    setToast('已新建空白项目。')
  }

  async function exportProject() {
    if (isExporting) return
    let sessionId = ''
    let sessionClosed = false
    setIsExporting(true)
    try {
      setToast('正在整理项目图片...')
      sessionId = await startProjectPackage()
      const canvasSnapshot = flowInstance?.toObject()
      const project = await buildPackageProject(
        sessionId,
        projectName,
        (canvasSnapshot?.nodes as WorkflowNode[] | undefined) ?? nodes,
        canvasSnapshot?.edges ?? edges,
        history,
      )
      const packageName = projectPackageFileName(projectName)
      const response = await fetch(
        `/api/projects/package/finish?sessionId=${encodeURIComponent(sessionId)}&filename=${encodeURIComponent(packageName)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json;charset=utf-8' },
          body: JSON.stringify(project),
        },
      )
      sessionClosed = true
      if (response.headers.get('content-type')?.includes('application/zip')) {
        if (!response.ok) throw new Error('项目包下载失败')
        const downloadUrl = URL.createObjectURL(await response.blob())
        downloadImage(downloadUrl, packageName)
        window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000)
        setToast('项目包已下载，图片存放在包内的 images 文件夹。')
        return
      }
      const payload = await readPackageResponse(response)
      if (payload?.cancelled) return
      setToast('项目包已保存，图片存放在包内的 images 文件夹。')
    } catch (error) {
      const message = error instanceof Error ? error.message : '导出失败'
      setToast(message)
      window.alert(`导出失败：${message}`)
    } finally {
      if (sessionId && !sessionClosed) void cancelProjectPackage(sessionId)
      setIsExporting(false)
    }
  }

  function applyImportedProject(projectValue: Partial<ProjectFile>) {
    const project = normalizeImportedProject(projectValue)
    setProjectName(project.projectName)
    setNodes(project.nodes)
    setEdges(project.edges)
    setHistory(project.history)
    setSelectedNodeId(null)
    setDirty(true)
    setToast('项目已导入，图片将从项目缓存按需加载。')
  }

  async function importProjectText(text: string) {
    try {
      applyImportedProject(JSON.parse(text) as Partial<ProjectFile>)
    } catch (error) {
      setToast(error instanceof Error && error.message === 'INVALID_PROJECT' ? '导入失败：请选择 AI 画布项目文件。' : '导入失败：文件不是有效项目。')
    }
  }

  async function importProjectFile(file: File) {
    try {
      if (/\.zip$/i.test(file.name)) {
        const response = await fetch('/api/projects/import-package', {
          method: 'POST',
          headers: { 'Content-Type': 'application/zip' },
          body: file,
        })
        const payload = (await response.json().catch(() => null)) as { project?: Partial<ProjectFile>; error?: string } | null
        if (!response.ok || !payload?.project) throw new Error(payload?.error || '项目包导入失败')
        applyImportedProject(payload.project)
        return
      }
      await importProjectText(await file.text())
    } catch (error) {
      setToast(error instanceof Error ? error.message : '导入项目失败')
    }
  }

  function chooseProjectToImport() {
    importInputRef.current?.click()
  }

  function importProject(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file) void importProjectFile(file)
  }

  function addReferenceImage(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) {
      pendingNodePositionRef.current = null
      return
    }
    const nodePosition = pendingNodePositionRef.current ?? { x: 120 + nodes.length * 24, y: 140 + nodes.length * 24 }
    pendingNodePositionRef.current = null
    const reader = new FileReader()
    reader.onload = () => {
      const imageUrl = String(reader.result)
      const node: WorkflowNode = {
        id: id('ref'),
        type: 'workflow',
        position: nodePosition,
        data: {
          kind: 'reference',
          title: '参考图像',
          imageUrl,
          status: 'done',
          model: '上传',
          size: apiConfig.size,
          sourceName: file.name,
          createdAt: new Date().toLocaleString('zh-CN'),
        },
      }
      setNodes((current) => [...current, node])
      setSelectedNodeId(node.id)
      markDirty()
      setToast('参考图像已加入画布。')
    }
    reader.readAsDataURL(file)
    event.target.value = ''
  }

  function updateApiConfig(patch: Partial<ApiConfig>) {
    setApiConfig((current) => {
      const preset = patch.mode === 'grsai' ? grsAiApiConfig : {}
      const mode = patch.apiKey?.trim() && current.mode === 'mock' && !patch.mode ? 'openai' : (patch.mode ?? current.mode)
      const next = {
        ...current,
        ...preset,
        ...patch,
        mode,
      }
      window.localStorage.setItem(API_STORAGE_KEY, JSON.stringify(next))
      return next
    })
  }

  async function copyLibraryPrompt(item: PromptLibraryItem) {
    try {
      await navigator.clipboard.writeText(item.content)
      setCopiedPromptId(item.id)
      window.setTimeout(() => {
        setCopiedPromptId((current) => (current === item.id ? null : current))
      }, 1600)
    } catch {
      window.alert('复制失败，请检查浏览器的剪贴板权限。')
    }
  }

  return (
    <main className="canvas-app">
      <header className="app-header">
        <div className="brand-zone">
          <div className="brand-mark">
            <img src={brandLogo} alt="JUC" />
          </div>
          <div>
            <h1>AI 画布工作台</h1>
            <span>无限画布图像生成工作流</span>
          </div>
          <input
            className="project-name"
            value={projectName}
            onChange={(event) => {
              setProjectName(event.target.value)
              markDirty()
            }}
            aria-label="项目名称"
          />
        </div>

        <div className="header-actions">
          <button type="button" onClick={newProject} title="新建项目">
            <FilePlus2 size={15} />
            新建
          </button>
          <button type="button" onClick={openProject} title="打开本地项目">
            <FolderOpen size={15} />
            打开
          </button>
          <button type="button" onClick={saveProject} title="保存到浏览器">
            <Save size={15} />
            保存
          </button>
          <button type="button" onClick={exportProject} title="导出 ZIP 项目包" disabled={isExporting}>
            {isExporting ? <Loader2 className="export-spinner" size={15} /> : <Download size={15} />}
            {isExporting ? '导出中' : '导出'}
          </button>
          <button type="button" onClick={() => void chooseProjectToImport()} title="导入 ZIP 项目包或旧版 JSON">
            <Upload size={15} />
            导入
          </button>
          <button type="button" onClick={() => setShowSettings(true)} title="API 设置">
            <Settings size={15} />
            设置
          </button>
          <button
            className={`api-status-button ${apiConfig.mode} ${apiConfig.apiKey ? 'configured' : ''}`}
            type="button"
            onClick={() => setShowSettings(true)}
            title="API 状态，点击填写 API Key"
          >
            <span className="api-status-dot" />
            <KeyRound size={15} />
            {apiConfig.mode === 'mock' ? '本地模拟' : apiConfig.apiKey ? 'API 已配置' : '填写 API Key'}
          </button>
          <input
            ref={importInputRef}
            type="file"
            accept=".aicanvas.zip,.zip,.json,application/zip,application/json"
            hidden
            onChange={importProject}
          />
          <input ref={referenceInputRef} type="file" accept="image/*" hidden onChange={addReferenceImage} />
        </div>

        <div className="save-state">{dirty ? '未保存' : '已保存'}</div>
      </header>

      <section className="workspace">
        <div className="flow-shell" onContextMenu={handlePaneContextMenu}>
          <ReactFlow
            nodes={nodesWithActions}
            edges={edges}
            nodeTypes={workflowNodeTypes}
            onNodesChange={handleNodesChange}
            onEdgesChange={handleEdgesChange}
            onConnect={handleConnect}
            onConnectStart={handleConnectStart}
            onConnectEnd={handleConnectEnd}
            onInit={setFlowInstance}
            onNodeClick={(_, node) => setSelectedNodeId(node.id)}
            onPaneClick={handlePaneClick}
            onPaneContextMenu={handlePaneContextMenu}
            fitView
            fitViewOptions={{ padding: 0.2, maxZoom: 0.92 }}
            minZoom={0.12}
            maxZoom={2.4}
            defaultEdgeOptions={{
              animated: true,
              markerEnd: { type: MarkerType.ArrowClosed, color: '#61c7e8' },
              style: { stroke: '#61c7e8', strokeWidth: 1.5 },
            }}
          >
            <Background color="#2c3845" gap={26} size={1} />
            <Controls showInteractive={false} />
          </ReactFlow>
          {contextMenu && (
            <div
              className="canvas-context-menu"
              style={{ left: contextMenu.x, top: contextMenu.y }}
              onContextMenu={(event) => event.preventDefault()}
            >
              <button type="button" onClick={uploadReferenceFromMenu}>
                <UploadCloud size={15} />
                上传图像
              </button>
              <button type="button" onClick={addPromptInputFromMenu}>
                <Wand2 size={15} />
                添加提示词输入框
              </button>
            </div>
          )}
          <div className="prompt-library-popover">
            <button
              className={`prompt-library-toggle ${showPromptLibrary ? 'active' : ''}`}
              type="button"
              onClick={() => setShowPromptLibrary((current) => !current)}
              title="常用提示词"
            >
              <BookOpen size={15} />
              提示词
            </button>
            {showPromptLibrary && (
              <section className="prompt-library-panel" aria-label="提示词库">
                <div className="prompt-library-head">
                  <div>
                    <strong>提示词库</strong>
                    <small>点击复制即可使用</small>
                  </div>
                  <button type="button" onClick={() => setShowPromptLibrary(false)} title="关闭提示词库">
                    <X size={15} />
                  </button>
                </div>
                <div className="prompt-library-grid">
                  {promptLibrary.map((item) => {
                    const copied = copiedPromptId === item.id
                    return (
                      <article className="prompt-library-card" key={item.id}>
                        <h3>{item.title}</h3>
                        <div className="prompt-library-content" tabIndex={0}>
                          {item.content}
                        </div>
                        <button
                          className={`prompt-copy-button ${copied ? 'copied' : ''}`}
                          type="button"
                          aria-label={`复制${item.title}提示词`}
                          onClick={() => void copyLibraryPrompt(item)}
                        >
                          {copied ? <Check size={14} /> : <Copy size={14} />}
                          {copied ? '已复制' : '复制提示词'}
                        </button>
                      </article>
                    )
                  })}
                </div>
              </section>
            )}
          </div>
          <div className="history-popover">
            <button
              className={`history-toggle ${showHistoryPanel ? 'active' : ''}`}
              type="button"
              onClick={() => setShowHistoryPanel((current) => !current)}
              title="生成历史"
            >
              <History size={15} />
              生成历史
              <span>{history.length}</span>
            </button>
            {showHistoryPanel && (
              <div className="history-menu">
                <div className="history-menu-head">
                  <strong>生成历史</strong>
                  <button type="button" onClick={() => setShowHistoryPanel(false)} title="关闭历史">
                    <X size={15} />
                  </button>
                </div>
                {history.length ? (
                  <div className="history-grid">
                    {history.slice(0, 12).map((item, index) => {
                      const imageUrl = item.imageUrl || nodes.find((node) => node.id === item.id)?.data.imageUrl
                      return (
                        <div className="history-card" key={`${item.id}-${item.createdAt}-${index}`}>
                          <button className="history-thumb" type="button" onClick={() => setPrompt(item.prompt)} title="使用这条提示词">
                            {imageUrl ? <img src={imageUrl} alt="生成历史缩略图" /> : <ImageIcon size={22} />}
                          </button>
                          <div className="history-meta">
                            <span>{item.status}</span>
                            <strong>{item.prompt}</strong>
                            <small>{item.createdAt}</small>
                          </div>
                          <button
                            className="history-folder"
                            type="button"
                            onClick={() => void revealHistoryImage(item)}
                            title="打开图片所在文件夹"
                            disabled={!imageUrl}
                          >
                            <FolderOpen size={15} />
                          </button>
                        </div>
                      )
                    })}
                  </div>
                ) : (
                  <div className="history-empty">生成后会在这里显示缩略图。</div>
                )}
              </div>
            )}
          </div>
        </div>
      </section>

      {showSettings && (
        <div className="modal-backdrop" role="presentation">
          <section className="settings-modal" role="dialog" aria-modal="true" aria-label="API 设置">
            <div className="modal-head">
              <div>
                <h2>API 设置</h2>
                <p>支持 OpenAI 兼容图像接口，也可以接自己的 JSON API。</p>
              </div>
              <button type="button" onClick={() => setShowSettings(false)} title="关闭">
                <X size={18} />
              </button>
            </div>

            <div className="settings-grid">
              <label className="field">
                <span>模式</span>
                <select value={apiConfig.mode} onChange={(event) => updateApiConfig({ mode: event.target.value as ApiMode })}>
                  <option value="grsai">GrsAI GPT Image</option>
                  <option value="mock">本地模拟</option>
                  <option value="openai">OpenAI 兼容</option>
                  <option value="custom">自定义 JSON API</option>
                </select>
              </label>
              <label className="field">
                <span>模型</span>
                {apiConfig.mode === 'grsai' ? (
                  <select value={apiConfig.model} onChange={(event) => updateApiConfig({ model: event.target.value })}>
                    {grsAiModelOptions.map((model) => (
                      <option key={model.value} value={model.value}>
                        {model.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input value={apiConfig.model} onChange={(event) => updateApiConfig({ model: event.target.value })} />
                )}
              </label>
              <label className="field wide">
                <span>Endpoint</span>
                <input
                  value={apiConfig.endpoint}
                  onChange={(event) => updateApiConfig({ endpoint: event.target.value })}
                  placeholder="https://api.example.com/v1/images/generations"
                />
              </label>
              <label className="field wide">
                <span>API Key</span>
                <input
                  type="password"
                  value={apiConfig.apiKey}
                  onChange={(event) => updateApiConfig({ apiKey: event.target.value })}
                  placeholder="仅保存在当前浏览器 localStorage"
                />
              </label>
              <label className="field">
                <span>尺寸</span>
                <input value={apiConfig.size} onChange={(event) => updateApiConfig({ size: event.target.value })} />
              </label>
              <label className="field">
                <span>图片路径</span>
                <input
                  value={apiConfig.responsePath}
                  onChange={(event) => updateApiConfig({ responsePath: event.target.value })}
                  placeholder="data.0.url"
                />
              </label>
              <label className="field wide">
                <span>自定义请求体模板</span>
                <textarea
                  value={apiConfig.bodyTemplate}
                  rows={7}
                  onChange={(event) => updateApiConfig({ bodyTemplate: event.target.value })}
                />
              </label>
            </div>

            <div className="modal-foot">
              <p>
                模板支持 {'{prompt}'}、{'{model}'}、{'{size}'}、{'{referenceImageUrl}'}、{'{referenceImageBase64}'} 占位符。
                请求会通过本地代理发送，避免浏览器 CORS 限制。
              </p>
              <button type="button" onClick={() => setShowSettings(false)}>
                完成
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  )
}
