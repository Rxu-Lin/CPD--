import {
  addEdge,
  applyEdgeChanges,
  Background,
  BaseEdge,
  Controls,
  getBezierPath,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  SelectionMode,
  useEdgesState,
  useNodesState,
  useUpdateNodeInternals,
  type Connection,
  type Edge,
  type EdgeChange,
  type EdgeProps,
  type EdgeTypes,
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
  Box,
  Brush,
  Check,
  CheckCircle2,
  Copy,
  Download,
  Eye,
  Expand,
  FolderOpen,
  Group as GroupIcon,
  History,
  Image as ImageIcon,
  KeyRound,
  Loader2,
  Pencil,
  RefreshCw,
  Save,
  Settings,
  Trash2,
  Upload,
  UploadCloud,
  Video,
  Wand2,
  Workflow as WorkflowIcon,
  X,
} from 'lucide-react'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react'
import brandLogo from './assets/brand-logo.png'
import promptLibraryMarkdown from '../提示词.md?raw'
import SpecularButton from './SpecularButton'
import UnifiedRange from './UnifiedRange'
import './App.css'
import {
  defaultGrsAiModel,
  findGrsAiModel,
  grsAiDefaultEndpoint,
  grsAiModelGroups,
  grsAiModelSelectionValue,
  normalizeGrsAiEndpoint,
  normalizeGrsAiModel,
} from './grsaiModels'

const Model3DStudio = lazy(() => import('./Model3DStudio'))

type NodeKind = 'prompt' | 'image' | 'video' | 'reference' | 'repaint' | 'outpaint' | 'group'
type NodeStatus = 'idle' | 'generating' | 'done' | 'error'
type RepaintBrushColor = 'red' | 'blue'
type OutpaintInsets = { top: number; right: number; bottom: number; left: number }
type OutpaintPreset = AspectRatioValue | 'free'
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
type ApiMode = 'mock' | 'openai' | 'grsai' | 'change2pro' | 'agnes' | 'apimart' | 'custom'
type AspectRatioValue = '16:9' | '3:2' | '4:3' | '1:1' | '3:4' | '2:3' | '9:16'
type ImageResolutionTier = '1K' | '1.5K' | '2K' | '3K' | '4K'
type VideoResolutionTier = '480p' | '720p' | '768P' | '1080p' | '2K' | '4k'
type Change2ProApiFamily = 'image2' | 'nanoBanana'

type ApiConfig = {
  mode: ApiMode
  endpoint: string
  apiKey: string
  model: string
  imageSize: ImageResolutionTier
  videoModel: string
  videoResolution: VideoResolutionTier
  videoDuration: number
  size: string
  bodyTemplate: string
  responsePath: string
  change2ProFamily?: Change2ProApiFamily
}

type Change2ProModelOption = {
  id: string
  ownedBy?: string
}

type ApiMartModelOption = {
  id: string
  label: string
  resolutions: ImageResolutionTier[]
  defaultResolution: ImageResolutionTier
}

type ApiMartVideoModelOption = {
  id: string
  label: string
  resolutions: VideoResolutionTier[]
  defaultResolution: VideoResolutionTier
  minDuration: number
  maxDuration: number
  defaultDuration: number
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

type HistoryImagePreview = Pick<GenerationRecord, 'prompt' | 'createdAt'> & {
  imageUrl: string
}

type ImageInputSlot = {
  id: string
  index: number
  connected: boolean
}

type WorkflowNodeData = {
  kind: NodeKind
  title: string
  prompt?: string
  imageUrl?: string
  videoUrl?: string
  sourceImageUrl?: string
  maskUrl?: string
  brushSize?: number
  brushColor?: RepaintBrushColor
  sourceWidth?: number
  sourceHeight?: number
  outpaintInsets?: OutpaintInsets
  outpaintPreset?: OutpaintPreset
  status: NodeStatus
  model?: string
  size?: string
  sourceName?: string
  error?: string
  createdAt: string
  promptInputConnected?: boolean
  imageInputConnected?: boolean
  imageInputSlots?: ImageInputSlot[]
  outputConnected?: boolean
  memberCount?: number
  onDelete?: (id: string) => void
  onDownload?: (id: string) => void
  onRevealImage?: (id: string) => void
  onReplaceImage?: (id: string, file: File) => void
  onGenerate?: (id: string) => void
  onChangeSize?: (id: string, size: string) => void
  onChangePrompt?: (id: string, prompt: string) => void
  onChangeMask?: (id: string, maskUrl: string) => void
  onChangeBrush?: (id: string, brushSize: number) => void
  onChangeBrushColor?: (id: string, brushColor: RepaintBrushColor) => void
  onClearMask?: (id: string) => void
  onChangeOutpaintInsets?: (id: string, insets: OutpaintInsets) => void
  onApplyOutpaintPreset?: (id: string, preset: OutpaintPreset) => void
  onResetOutpaintPrompt?: (id: string) => void
  onUsePrompt?: (prompt: string) => void
  onRenameGroup?: (id: string) => void
}

type WorkflowNode = Node<WorkflowNodeData, 'workflow'>
type WorkflowEdgeData = Record<string, unknown> & {
  onDisconnect?: (edgeId: string) => void
}
type WorkflowEdge = Edge<WorkflowEdgeData, 'disconnectible'>

const imageInputHandlePrefix = 'image-'

function imageInputHandleIndex(handleId?: string | null) {
  if (handleId === 'image') return 1
  if (!handleId?.startsWith(imageInputHandlePrefix)) return null
  const index = Number(handleId.slice(imageInputHandlePrefix.length))
  return Number.isInteger(index) && index > 0 ? index : null
}

function isImageInputHandle(handleId?: string | null) {
  return imageInputHandleIndex(handleId) !== null
}

function normalizeImageInputEdges(edgeValues: Edge[], nodeValues: WorkflowNode[]) {
  const imageTargetIds = nodeValues
    .filter((node) => node.data.kind === 'image' || node.data.kind === 'video')
    .map((node) => node.id)
  const sourceKindById = new Map(nodeValues.map((node) => [node.id, node.data.kind]))
  const normalizedEdges = edgeValues.map((edge) => ({ ...edge }))
  let changed = false

  for (const targetId of imageTargetIds) {
    const imageEdges = normalizedEdges
      .map((edge, position) => ({ edge, position, handleIndex: imageInputHandleIndex(edge.targetHandle) }))
      .filter(
        ({ edge, handleIndex }) =>
          edge.target === targetId &&
          (handleIndex !== null || (!edge.targetHandle && sourceKindById.get(edge.source) !== 'prompt')),
      )
      .sort((left, right) => {
        if (left.handleIndex !== null && right.handleIndex !== null && left.handleIndex !== right.handleIndex) {
          return left.handleIndex - right.handleIndex
        }
        if (left.handleIndex !== null && right.handleIndex === null) return -1
        if (left.handleIndex === null && right.handleIndex !== null) return 1
        return left.position - right.position
      })

    imageEdges.forEach(({ edge, position }, index) => {
      const targetHandle = `${imageInputHandlePrefix}${index + 1}`
      if (edge.targetHandle === targetHandle) return
      normalizedEdges[position] = { ...edge, targetHandle }
      changed = true
    })
  }

  return changed ? normalizedEdges : edgeValues
}

function promptWithReferenceImageOrder(prompt: string, referenceImageCount: number) {
  if (referenceImageCount <= 1) return prompt
  const labels = Array.from({ length: referenceImageCount }, (_, index) => `Image ${index + 1}`).join('、')
  return `${prompt}\n\n参考图顺序说明：参考图已按画布端口编号依次传入（${labels}）。请严格按该编号理解图片；提示词提到 Image N 时，对应同名编号的参考图。`
}

type ProjectFile = {
  version: 1 | 2
  projectName: string
  nodes: WorkflowNode[]
  edges: Edge[]
  history: GenerationRecord[]
}

type ProjectArchiveWritable = {
  write: (data: Blob) => Promise<void>
  close: () => Promise<void>
  abort?: () => Promise<void>
}

type ProjectArchiveFileHandle = {
  kind: 'file'
  name: string
  getFile: () => Promise<File>
  createWritable: () => Promise<ProjectArchiveWritable>
  queryPermission?: (options: { mode: 'readwrite' }) => Promise<'granted' | 'denied' | 'prompt'>
  requestPermission?: (options: { mode: 'readwrite' }) => Promise<'granted' | 'denied' | 'prompt'>
}

type ProjectFilePickerWindow = Window & {
  showOpenFilePicker?: (options: {
    multiple?: boolean
    types?: Array<{ description: string; accept: Record<string, string[]> }>
  }) => Promise<ProjectArchiveFileHandle[]>
  showSaveFilePicker?: (options: {
    suggestedName?: string
    types?: Array<{ description: string; accept: Record<string, string[]> }>
  }) => Promise<ProjectArchiveFileHandle>
}

type CanvasContextMenu = {
  x: number
  y: number
  flowPosition: XYPosition
}

type GroupDialogState =
  | { mode: 'create'; nodeIds: string[] }
  | { mode: 'rename'; groupId: string }

const API_STORAGE_KEY = 'node-banana-api-config'
const API_PROFILE_STORAGE_KEY_PREFIX = 'node-banana-api-profile:'
const CHANGE2PRO_FAMILY_PROFILE_KEY_PREFIX = 'node-banana-change2pro-profile:'
const workflowEdgeColor = 'rgba(255, 255, 255, 0.88)'

const defaultApiConfig: ApiConfig = {
  mode: 'mock',
  endpoint: 'https://api.openai.com/v1/images/generations',
  apiKey: '',
  model: 'gpt-image-1',
  imageSize: '1K',
  videoModel: 'seedance-2.5',
  videoResolution: '720p',
  videoDuration: 5,
  size: '1024x1024',
  bodyTemplate: '{\n  "model": "{model}",\n  "prompt": "{prompt}",\n  "size": "{size}",\n  "n": 1\n}',
  responsePath: 'data.0.url',
}

const grsAiApiConfig: Partial<ApiConfig> = {
  mode: 'grsai',
  endpoint: grsAiDefaultEndpoint,
  model: defaultGrsAiModel,
  responsePath: 'data.0.url',
}

const change2ProApiConfig: Partial<ApiConfig> = {
  mode: 'change2pro',
  endpoint: 'https://api.change2pro.com/v1/images/generations',
  model: 'gpt-image-2',
  imageSize: '1K',
  responsePath: 'data.0.url',
  change2ProFamily: 'image2',
}

const agnesApiConfig: Partial<ApiConfig> = {
  mode: 'agnes',
  endpoint: 'https://api.agnes-ai.cn/v1/images/generations',
  model: 'agnes-image-2.1-flash',
  imageSize: '1K',
  responsePath: 'data.0.url',
}

const apiMartApiConfig: Partial<ApiConfig> = {
  mode: 'apimart',
  endpoint: 'https://api.apimart.ai/v1/images/generations',
  model: 'gemini-3-pro-image-preview',
  imageSize: '1K',
  videoModel: 'seedance-2.5',
  videoResolution: '720p',
  videoDuration: 5,
  responsePath: 'data.0.url',
}

const apiMartModels: ApiMartModelOption[] = [
  {
    id: 'gemini-3-pro-image-preview',
    label: 'Nano Banana Pro',
    resolutions: ['1K', '2K', '4K'],
    defaultResolution: '1K',
  },
  {
    id: 'gemini-3.1-flash-image-preview',
    label: 'Nano Banana 2',
    resolutions: ['1K', '2K', '4K'],
    defaultResolution: '1K',
  },
  {
    id: 'gpt-image-2',
    label: 'GPT Image 2',
    resolutions: ['1K', '2K', '4K'],
    defaultResolution: '1K',
  },
  {
    id: 'seedream-5-0-pro',
    label: 'Seedream 5.0 Pro',
    resolutions: ['1K', '1.5K', '2K'],
    defaultResolution: '1K',
  },
  {
    id: 'seedream-5-0-lite',
    label: 'Seedream 5.0 Lite',
    resolutions: ['2K', '3K', '4K'],
    defaultResolution: '2K',
  },
]

const apiMartVideoModels: ApiMartVideoModelOption[] = [
  {
    id: 'seedance-2.5',
    label: 'Seedance 2.5',
    resolutions: ['480p', '720p', '1080p'],
    defaultResolution: '720p',
    minDuration: 4,
    maxDuration: 30,
    defaultDuration: 5,
  },
  {
    id: 'seedance-2.0',
    label: 'Seedance 2.0',
    resolutions: ['480p', '720p', '1080p', '4k'],
    defaultResolution: '720p',
    minDuration: 4,
    maxDuration: 15,
    defaultDuration: 5,
  },
  {
    id: 'MiniMax-H3',
    label: 'MiniMax H3',
    resolutions: ['768P', '2K'],
    defaultResolution: '2K',
    minDuration: 4,
    maxDuration: 15,
    defaultDuration: 5,
  },
]

function findApiMartModel(model: string) {
  return apiMartModels.find((option) => option.id === model) ?? apiMartModels[0]
}

function findApiMartVideoModel(model?: string) {
  return apiMartVideoModels.find((option) => option.id === model) ?? apiMartVideoModels[0]
}

const agnesFallbackModels: Change2ProModelOption[] = [
  { id: 'agnes-image-2.1-flash', ownedBy: 'Agnes AI' },
  { id: 'agnes-image-2.0-flash', ownedBy: 'Agnes AI' },
]

function apiModelDisplayName(model: string) {
  if (model === 'agnes-image-2.1-flash') return 'Agnes Image 2.1 Flash'
  if (model === 'agnes-image-2.0-flash') return 'Agnes Image 2.0 Flash'
  const apiMartModel = apiMartModels.find((option) => option.id === model)
  if (apiMartModel) return apiMartModel.label
  const apiMartVideoModel = apiMartVideoModels.find((option) => option.id === model)
  if (apiMartVideoModel) return apiMartVideoModel.label
  return findGrsAiModel(model)?.label || model
}

function apiProfileStorageKey(mode: ApiMode) {
  return `${API_PROFILE_STORAGE_KEY_PREFIX}${mode}`
}

function change2ProFamilyProfileKey(family: Change2ProApiFamily) {
  return `${CHANGE2PRO_FAMILY_PROFILE_KEY_PREFIX}${family}`
}

function change2ProFamilyFromModel(model: string): Change2ProApiFamily {
  const value = model.trim().toLowerCase().replaceAll('_', '-').replaceAll('.', '-')
  return /nano-?banana|gemini.*image/.test(value) ? 'nanoBanana' : 'image2'
}

function change2ProModelMatchesFamily(model: string, family: Change2ProApiFamily) {
  const value = model.trim().toLowerCase().replaceAll('_', '-').replaceAll('.', '-')
  if (family === 'nanoBanana') return /nano-?banana|gemini.*image/.test(value)
  return /gpt-?image|(^|-)image2(?:-|$)/.test(value)
}

function change2ProDefaultModel(family: Change2ProApiFamily) {
  return family === 'nanoBanana' ? 'gemini-3.1-flash-image-preview' : 'gpt-image-2'
}

function readStoredChange2ProFamilyProfile(family: Change2ProApiFamily) {
  try {
    const saved = window.localStorage.getItem(change2ProFamilyProfileKey(family))
    return saved ? (JSON.parse(saved) as Partial<ApiConfig>) : null
  } catch {
    return null
  }
}

function writeStoredChange2ProFamilyProfile(family: Change2ProApiFamily, config: ApiConfig) {
  window.localStorage.setItem(
    change2ProFamilyProfileKey(family),
    JSON.stringify({ ...config, mode: 'change2pro', change2ProFamily: family }),
  )
}

function readStoredApiProfile(mode: ApiMode) {
  try {
    const saved = window.localStorage.getItem(apiProfileStorageKey(mode))
    return saved ? (JSON.parse(saved) as Partial<ApiConfig>) : null
  } catch {
    return null
  }
}

function apiModePreset(mode: ApiMode): Partial<ApiConfig> {
  if (mode === 'grsai') return grsAiApiConfig
  if (mode === 'change2pro') return change2ProApiConfig
  if (mode === 'agnes') return agnesApiConfig
  if (mode === 'apimart') return apiMartApiConfig
  if (mode === 'openai') return { mode, endpoint: defaultApiConfig.endpoint, model: defaultApiConfig.model }
  if (mode === 'custom') return { mode, endpoint: '', model: '', responsePath: 'data.0.url' }
  return { ...defaultApiConfig, mode: 'mock' }
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
const change2ProImageSizes: ImageResolutionTier[] = ['1K', '2K', '4K']

function change2ProSupportsImageSize(model: string) {
  const value = model.trim().toLowerCase().replaceAll('_', '-').replaceAll('.', '-')
  return /^(gpt-?image-?2(?:-vip)?|nano-?banana-?2|nano-?banana-?pro|gemini-3-1-flash-image-preview|gemini-3-pro-image-preview)$/.test(value)
}

function change2ProModelLabel(model: string) {
  const value = model.trim().toLowerCase()
  if (value === 'gemini-3.1-flash-image-preview') return 'Nano Banana 2 · gemini-3.1-flash-image-preview'
  if (value === 'gemini-3-pro-image-preview') return 'Nano Banana Pro · gemini-3-pro-image-preview'
  return model
}

const OUTPAINT_MAX_DIMENSION = 4096
const outpaintPresetOptions: OutpaintPreset[] = ['free', '1:1', '4:3', '3:4', '16:9', '9:16', '2:3']
const defaultOutpaintPrompt = `请在保持原图主体、核心构图、透视关系、镜头焦距、光照方向、色彩、材质和画面风格一致的前提下，智能补全画布新增区域。

自然延续原图边缘的背景、环境、纹理和空间结构，不要拉伸、复制或移动原图主体，不要改变人物面部、姿态、服装、产品形态、文字和标识，不要添加无关主体。

保持阴影、反射、景深、颗粒和清晰度一致，使新增区域与原图自然衔接、没有明显接缝。只生成扩展区域，原图保护区域保持不变。`

function outpaintTargetSize(sourceWidth: number, sourceHeight: number, insets: OutpaintInsets) {
  return {
    width: Math.round(sourceWidth + insets.left + insets.right),
    height: Math.round(sourceHeight + insets.top + insets.bottom),
  }
}

function nearestAspectRatioOption(width: number, height: number) {
  const ratio = width / height
  return aspectRatioOptions.reduce((closest, option) => {
    const [optionWidth, optionHeight] = option.size.split('x').map(Number)
    return Math.abs(optionWidth / optionHeight - ratio) < Math.abs(parseImageSize(closest.size).width / parseImageSize(closest.size).height - ratio)
      ? option
      : closest
  }, defaultAspectRatioOption)
}

function defaultOutpaintInsets(sourceWidth: number, sourceHeight: number): OutpaintInsets {
  const horizontal = Math.min(Math.round(sourceWidth * 0.18), Math.floor((OUTPAINT_MAX_DIMENSION - sourceWidth) / 2))
  const vertical = Math.min(Math.round(sourceHeight * 0.18), Math.floor((OUTPAINT_MAX_DIMENSION - sourceHeight) / 2))
  return { top: Math.max(0, vertical), right: Math.max(0, horizontal), bottom: Math.max(0, vertical), left: Math.max(0, horizontal) }
}

function outpaintInsetsForPreset(sourceWidth: number, sourceHeight: number, preset: OutpaintPreset): OutpaintInsets {
  if (preset === 'free') return defaultOutpaintInsets(sourceWidth, sourceHeight)
  const [ratioWidth, ratioHeight] = preset.split(':').map(Number)
  const ratio = ratioWidth / ratioHeight
  let targetWidth = Math.round(sourceWidth * 1.2)
  let targetHeight = Math.round(sourceHeight * 1.2)
  if (targetWidth / targetHeight > ratio) targetHeight = Math.ceil(targetWidth / ratio)
  else targetWidth = Math.ceil(targetHeight * ratio)
  const scale = Math.min(1, OUTPAINT_MAX_DIMENSION / Math.max(targetWidth, targetHeight))
  targetWidth = Math.max(sourceWidth, Math.round(targetWidth * scale))
  targetHeight = Math.max(sourceHeight, Math.round(targetHeight * scale))
  const horizontal = Math.max(0, targetWidth - sourceWidth)
  const vertical = Math.max(0, targetHeight - sourceHeight)
  return {
    top: Math.floor(vertical / 2),
    right: Math.ceil(horizontal / 2),
    bottom: Math.ceil(vertical / 2),
    left: Math.floor(horizontal / 2),
  }
}

function fitSourceForOutpaint(width: number, height: number) {
  const scale = Math.min(1, 3072 / Math.max(width, height))
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

function outpaintDirectionSummary(insets: OutpaintInsets) {
  const directions = [
    insets.top > 0 ? '上方' : '',
    insets.right > 0 ? '右侧' : '',
    insets.bottom > 0 ? '下方' : '',
    insets.left > 0 ? '左侧' : '',
  ].filter(Boolean)
  return directions.join('、') || '无'
}

function outpaintGenerationPrompt(prompt: string, sourceWidth: number, sourceHeight: number, insets: OutpaintInsets) {
  const target = outpaintTargetSize(sourceWidth, sourceHeight, insets)
  const ratio = nearestAspectRatioOption(target.width, target.height).label
  return `${prompt.trim() || defaultOutpaintPrompt}\n\n扩图参数：向${outpaintDirectionSummary(insets)}扩展；上 ${insets.top}px、右 ${insets.right}px、下 ${insets.bottom}px、左 ${insets.left}px；目标比例约 ${ratio}；原图 ${sourceWidth} × ${sourceHeight}px；最终画布 ${target.width} × ${target.height}px。`
}

const referenceImageRatios = [
  { label: '16:9', value: 16 / 9 },
  { label: '3:2', value: 3 / 2 },
  { label: '4:3', value: 4 / 3 },
  { label: '6:5', value: 6 / 5 },
  { label: '1:1', value: 1 },
  { label: '5:6', value: 5 / 6 },
  { label: '3:4', value: 3 / 4 },
  { label: '2:3', value: 2 / 3 },
  { label: '9:16', value: 9 / 16 },
]

function getReferenceImageRatio(width: number, height: number) {
  if (!width || !height) return '—'
  const ratio = width / height
  return referenceImageRatios.reduce((closest, option) =>
    Math.abs(option.value - ratio) < Math.abs(closest.value - ratio) ? option : closest,
  ).label
}

const starterPrompt =
  '一张未来感产品海报，深色背景，蓝色霓虹边缘光，主体是一台半透明的智能设备，电影级布光，高细节'

const productRetouchPrompt =
  '对原图中的美妆产品进行商业广告级精修，保持产品外形、包装结构、品牌标识、文字内容和真实颜色准确不变。清除灰尘、指纹、划痕、污渍、毛边及包装瑕疵，优化瓶身、管身或膏体表面的质感与细节；校正透视和边缘，使轮廓清晰自然。重塑专业棚拍光影，增强玻璃、金属、塑料、磨砂或膏体材质的真实表现，控制高光不过曝、阴影柔和有层次。提升画面通透度、色彩纯净度和局部对比度，避免过度锐化、塑料感及不真实反光。背景保持干净高级，并增加自然接触阴影与轻微环境反射，使产品稳定落地。整体呈现高端美妆品牌广告风格，精致、纯净、真实、具有购买吸引力，超高清细节，适用于电商主图、海报和社交媒体宣传。禁止改变产品比例、Logo、包装文字、色号、材质和核心设计，不添加不存在的装饰或配件。'

function id(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function collectNodeFamilyIds(nodeIds: string[], nodeValues: WorkflowNode[]) {
  const ids = new Set(nodeIds.filter(Boolean))
  let changed = true

  while (changed) {
    changed = false
    nodeValues.forEach((node) => {
      if (node.parentId && ids.has(node.parentId) && !ids.has(node.id)) {
        ids.add(node.id)
        changed = true
      }
    })
  }

  return ids
}

function numericNodeDimension(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

function getWorkflowNodeSize(node: WorkflowNode) {
  const fallbackWidth = node.data.kind === 'outpaint' ? 410 : node.data.kind === 'repaint' ? 360 : node.data.kind === 'image' || node.data.kind === 'video' || node.data.kind === 'prompt' ? 330 : 312
  const fallbackHeight = node.data.kind === 'outpaint' ? 780 : node.data.kind === 'repaint' ? 620 : node.data.kind === 'image' || node.data.kind === 'video' ? 480 : node.data.kind === 'reference' ? 360 : 250
  return {
    width: node.measured?.width || node.width || numericNodeDimension(node.style?.width) || fallbackWidth,
    height: node.measured?.height || node.height || numericNodeDimension(node.style?.height) || fallbackHeight,
  }
}

function getAbsoluteNodePosition(node: WorkflowNode, nodeValues: WorkflowNode[]) {
  const position = { ...node.position }
  let parentId = node.parentId
  const visited = new Set<string>()

  while (parentId && !visited.has(parentId)) {
    visited.add(parentId)
    const parent = nodeValues.find((item) => item.id === parentId)
    if (!parent) break
    position.x += parent.position.x
    position.y += parent.position.y
    parentId = parent.parentId
  }

  return position
}

function readStoredApiConfig() {
  try {
    window.localStorage.removeItem(`${API_PROFILE_STORAGE_KEY_PREFIX}volcengine`)
    const saved = window.localStorage.getItem(API_STORAGE_KEY)
    const config = saved ? { ...defaultApiConfig, ...JSON.parse(saved) } : defaultApiConfig
    if (config.mode === 'volcengine') {
      window.localStorage.removeItem(API_STORAGE_KEY)
      return defaultApiConfig
    }
    if (config.mode === 'grsai') {
      return {
        ...config,
        endpoint: normalizeGrsAiEndpoint(config.endpoint),
        model: normalizeGrsAiModel(config.model),
      }
    }
    if (config.mode === 'change2pro') {
      return {
        ...config,
        change2ProFamily: config.change2ProFamily || change2ProFamilyFromModel(config.model),
      }
    }
    if (config.mode === 'apimart') {
      const model = findApiMartModel(config.model)
      const videoModel = findApiMartVideoModel(config.videoModel)
      const requestedDuration = Number(config.videoDuration)
      return {
        ...config,
        endpoint: config.endpoint || apiMartApiConfig.endpoint || '',
        model: model.id,
        imageSize: model.resolutions.includes(config.imageSize) ? config.imageSize : model.defaultResolution,
        videoModel: videoModel.id,
        videoResolution: videoModel.resolutions.includes(config.videoResolution)
          ? config.videoResolution
          : videoModel.defaultResolution,
        videoDuration: Number.isFinite(requestedDuration)
          ? Math.min(videoModel.maxDuration, Math.max(videoModel.minDuration, Math.round(requestedDuration)))
          : videoModel.defaultDuration,
      }
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
    onReplaceImage,
    onGenerate,
    onChangeSize,
    onChangePrompt,
    onChangeMask,
    onChangeBrush,
    onChangeBrushColor,
    onClearMask,
    onChangeOutpaintInsets,
    onApplyOutpaintPreset,
    onResetOutpaintPrompt,
    onUsePrompt,
    onRenameGroup,
    memberCount,
    ...data
  } = node.data
  void onDelete
  void onDownload
  void onRevealImage
  void onReplaceImage
  void onGenerate
  void onChangeSize
  void onChangePrompt
  void onChangeMask
  void onChangeBrush
  void onChangeBrushColor
  void onClearMask
  void onChangeOutpaintInsets
  void onApplyOutpaintPreset
  void onResetOutpaintPrompt
  void onUsePrompt
  void onRenameGroup
  void memberCount
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

function isPickerCancelled(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError'
}

async function requestProjectFileWritePermission(handle: ProjectArchiveFileHandle) {
  const permissionOptions = { mode: 'readwrite' } as const
  if (handle.queryPermission && (await handle.queryPermission(permissionOptions)) === 'granted') return true
  if (handle.requestPermission) return (await handle.requestPermission(permissionOptions)) === 'granted'
  return true
}

async function writeProjectPackage(handle: ProjectArchiveFileHandle, packageBlob: Blob) {
  const writable = await handle.createWritable()
  try {
    await writable.write(packageBlob)
    await writable.close()
  } catch (error) {
    await writable.abort?.().catch(() => undefined)
    throw error
  }
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

async function requestGeneratedImage(prompt: string, config: ApiConfig, referenceImageUrls: string[] = [], maskUrl?: string) {
  if (config.mode === 'mock') {
    await new Promise((resolve) => window.setTimeout(resolve, 650))
    return createMockImage(prompt, config.size)
  }

  const response = await fetch('/api/images/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, config, referenceImageUrls, maskUrl }),
  })

  const json = await response.json().catch(() => null)
  if (!response.ok) {
    const message = typeof json?.error === 'string' ? json.error : `请求失败：${response.status} ${response.statusText}`
    throw new Error(message)
  }

  return imageFromResponse(json, config.responsePath)
}

function videoFromResponse(source: unknown) {
  const candidates = [
    getValueByPath(source, 'data.0.url'),
    getValueByPath(source, 'data.url'),
    getValueByPath(source, 'url'),
    getValueByPath(source, 'video_url'),
  ]
  const value = candidates.find((item): item is string => typeof item === 'string' && Boolean(item.trim()))
  if (!value) throw new Error('接口响应中没有找到视频地址。')
  return value
}

async function requestGeneratedVideo(prompt: string, config: ApiConfig, referenceImageUrls: string[] = []) {
  const response = await fetch('/api/videos/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, config, referenceImageUrls }),
  })

  const json = await response.json().catch(() => null)
  if (!response.ok) {
    const message = typeof json?.error === 'string' ? json.error : `请求失败：${response.status} ${response.statusText}`
    throw new Error(message)
  }

  return videoFromResponse(json)
}

async function requestChange2ProModels(apiKey: string) {
  const response = await fetch('/api/change2pro/models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey }),
  })
  const payload = (await response.json().catch(() => null)) as
    | { models?: Change2ProModelOption[]; error?: string }
    | null

  if (!response.ok) {
    throw new Error(payload?.error || `模型列表读取失败：${response.status} ${response.statusText}`)
  }
  if (!payload?.models?.length) throw new Error('当前 Key 没有返回可识别的生图模型。')
  return payload.models
}

async function requestAgnesModels(apiKey: string, endpoint: string) {
  const response = await fetch('/api/agnes/models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey, endpoint }),
  })
  const payload = (await response.json().catch(() => null)) as
    | { models?: Change2ProModelOption[]; error?: string }
    | null

  if (!response.ok) {
    throw new Error(payload?.error || `Agnes AI 模型列表读取失败：${response.status} ${response.statusText}`)
  }
  if (!payload?.models?.length) throw new Error('当前 Agnes AI Key 没有返回可用的生图模型。')
  return payload.models
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

async function prepareOutpaintInputs(
  sourceImageUrl: string,
  sourceWidth: number,
  sourceHeight: number,
  insets: OutpaintInsets,
) {
  const sourceImage = await loadCanvasImage(await imageAsDataUrl(sourceImageUrl))
  const target = outpaintTargetSize(sourceWidth, sourceHeight, insets)
  const referenceCanvas = document.createElement('canvas')
  const maskCanvas = document.createElement('canvas')
  referenceCanvas.width = maskCanvas.width = target.width
  referenceCanvas.height = maskCanvas.height = target.height
  const referenceContext = referenceCanvas.getContext('2d')
  const maskContext = maskCanvas.getContext('2d')
  if (!referenceContext || !maskContext) throw new Error('浏览器无法准备扩图画布。')

  referenceContext.imageSmoothingEnabled = true
  referenceContext.imageSmoothingQuality = 'high'
  referenceContext.drawImage(sourceImage, insets.left, insets.top, sourceWidth, sourceHeight)
  maskContext.clearRect(0, 0, target.width, target.height)
  maskContext.fillStyle = '#000000'
  maskContext.fillRect(insets.left, insets.top, sourceWidth, sourceHeight)

  return {
    referenceImageUrl: referenceCanvas.toDataURL('image/png'),
    maskUrl: maskCanvas.toDataURL('image/png'),
  }
}

async function compositeOutpaintResult(
  sourceImageUrl: string,
  generatedImageUrl: string,
  sourceWidth: number,
  sourceHeight: number,
  insets: OutpaintInsets,
) {
  const [sourceImage, generatedImage] = await Promise.all([
    loadCanvasImage(await imageAsDataUrl(sourceImageUrl)),
    loadCanvasImage(await imageAsDataUrl(generatedImageUrl)),
  ])
  const target = outpaintTargetSize(sourceWidth, sourceHeight, insets)
  const canvas = document.createElement('canvas')
  canvas.width = target.width
  canvas.height = target.height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('浏览器无法合成扩图结果。')
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(generatedImage, 0, 0, target.width, target.height)
  context.drawImage(sourceImage, insets.left, insets.top, sourceWidth, sourceHeight)
  return cacheCanvasImage(canvas.toDataURL('image/png'))
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

type OutpaintRangeEditorProps = {
  sourceImageUrl?: string
  resultImageUrl?: string
  sourceWidth: number
  sourceHeight: number
  insets: OutpaintInsets
  preset: OutpaintPreset
  disabled: boolean
  onChange: (insets: OutpaintInsets) => void
  onApplyPreset: (preset: OutpaintPreset) => void
}

type OutpaintHandle = 'top' | 'right' | 'bottom' | 'left' | 'top-left' | 'top-right' | 'bottom-right' | 'bottom-left'

function OutpaintRangeEditor({
  sourceImageUrl,
  resultImageUrl,
  sourceWidth,
  sourceHeight,
  insets,
  preset,
  disabled,
  onChange,
  onApplyPreset,
}: OutpaintRangeEditorProps) {
  const stageRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{
    handle: OutpaintHandle
    pointerId: number
    x: number
    y: number
    width: number
    height: number
    insets: OutpaintInsets
  } | null>(null)
  const target = outpaintTargetSize(sourceWidth, sourceHeight, insets)
  const sourceStyle = {
    left: `${(insets.left / target.width) * 100}%`,
    top: `${(insets.top / target.height) * 100}%`,
    width: `${(sourceWidth / target.width) * 100}%`,
    height: `${(sourceHeight / target.height) * 100}%`,
  }

  const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>, handle: OutpaintHandle) => {
    if (disabled || !stageRef.current) return
    event.preventDefault()
    event.stopPropagation()
    const rect = stageRef.current.getBoundingClientRect()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = {
      handle,
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      width: Math.max(1, rect.width),
      height: Math.max(1, rect.height),
      insets: { ...insets },
    }
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId || disabled) return
    event.preventDefault()
    const startTarget = outpaintTargetSize(sourceWidth, sourceHeight, drag.insets)
    const dx = Math.round(((event.clientX - drag.x) / drag.width) * startTarget.width)
    const dy = Math.round(((event.clientY - drag.y) / drag.height) * startTarget.height)
    const next = { ...drag.insets }
    const maxLeft = OUTPAINT_MAX_DIMENSION - sourceWidth - drag.insets.right
    const maxRight = OUTPAINT_MAX_DIMENSION - sourceWidth - drag.insets.left
    const maxTop = OUTPAINT_MAX_DIMENSION - sourceHeight - drag.insets.bottom
    const maxBottom = OUTPAINT_MAX_DIMENSION - sourceHeight - drag.insets.top

    if (drag.handle.includes('left')) next.left = Math.max(0, Math.min(maxLeft, drag.insets.left - dx))
    if (drag.handle.includes('right')) next.right = Math.max(0, Math.min(maxRight, drag.insets.right + dx))
    if (drag.handle.includes('top')) next.top = Math.max(0, Math.min(maxTop, drag.insets.top - dy))
    if (drag.handle.includes('bottom')) next.bottom = Math.max(0, Math.min(maxBottom, drag.insets.bottom + dy))
    onChange(next)
  }

  const stopDragging = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null
  }

  const handles: Array<{ value: OutpaintHandle; label: string }> = [
    { value: 'top', label: '拖动上边界' },
    { value: 'right', label: '拖动右边界' },
    { value: 'bottom', label: '拖动下边界' },
    { value: 'left', label: '拖动左边界' },
    { value: 'top-left', label: '拖动左上角' },
    { value: 'top-right', label: '拖动右上角' },
    { value: 'bottom-right', label: '拖动右下角' },
    { value: 'bottom-left', label: '拖动左下角' },
  ]

  return (
    <section className="outpaint-editor nodrag nopan nowheel" aria-label="扩图范围编辑器">
      <div className="outpaint-editor-heading">
        <span>扩展范围</span>
        <output>{target.width} × {target.height}px</output>
      </div>
      <div
        ref={stageRef}
        className="outpaint-stage"
        style={{ aspectRatio: `${target.width} / ${target.height}` }}
      >
        {resultImageUrl && <img className="outpaint-result" src={resultImageUrl} alt="扩图结果" draggable={false} />}
        {sourceImageUrl ? (
          <img className="outpaint-source" src={sourceImageUrl} alt="原图保护区域" draggable={false} style={sourceStyle} />
        ) : (
          <div className="outpaint-source outpaint-source-empty" style={sourceStyle}><ImageIcon size={24} /></div>
        )}
        <div className="outpaint-protected-outline" style={sourceStyle}>
          <span>原图保护区</span>
        </div>
        {handles.map((handle) => (
          <button
            key={handle.value}
            type="button"
            className={`outpaint-handle ${handle.value}`}
            aria-label={handle.label}
            title={handle.label}
            disabled={disabled}
            onPointerDown={(event) => handlePointerDown(event, handle.value)}
            onPointerMove={handlePointerMove}
            onPointerUp={stopDragging}
            onPointerCancel={stopDragging}
          />
        ))}
      </div>
      <div className="outpaint-inset-values" aria-label="四向扩展像素">
        <span>上 <strong>{insets.top}</strong></span>
        <span>右 <strong>{insets.right}</strong></span>
        <span>下 <strong>{insets.bottom}</strong></span>
        <span>左 <strong>{insets.left}</strong></span>
      </div>
      <div className="outpaint-presets" role="group" aria-label="扩图比例">
        {outpaintPresetOptions.map((option) => (
          <button
            key={option}
            type="button"
            className={preset === option ? 'active' : ''}
            aria-pressed={preset === option}
            disabled={disabled}
            onClick={() => onApplyPreset(option)}
          >
            {option === 'free' ? '自由' : option}
          </button>
        ))}
      </div>
      <p className="outpaint-editor-hint">拖动外框四边或四角，原图区域始终保持不变。</p>
    </section>
  )
}

function WorkflowCard({ data, id: nodeId, selected }: NodeProps<WorkflowNode>) {
  const updateNodeInternals = useUpdateNodeInternals()
  const replaceImageInputRef = useRef<HTMLInputElement>(null)
  const isPromptComposingRef = useRef(false)
  const lastCommittedPromptRef = useRef(data.prompt || '')
  const [promptDraft, setPromptDraft] = useState(data.prompt || '')
  const [referenceImageRatio, setReferenceImageRatio] = useState('—')
  const [referencePixelSize, setReferencePixelSize] = useState('')
  const isImage = data.kind === 'image'
  const isVideo = data.kind === 'video'
  const isPrompt = data.kind === 'prompt'
  const isReference = data.kind === 'reference'
  const isRepaint = data.kind === 'repaint'
  const isOutpaint = data.kind === 'outpaint'
  const isGroup = data.kind === 'group'
  const isGenerating = data.status === 'generating'
  const isDone = data.status === 'done'
  const isError = data.status === 'error'
  const selectedAspectRatio = getAspectRatioOption(data.size)
  const brushSize = data.brushSize || 36
  const brushColor = data.brushColor || 'red'
  const sourceWidth = data.sourceWidth || 1024
  const sourceHeight = data.sourceHeight || 1024
  const outpaintInsets = data.outpaintInsets || defaultOutpaintInsets(sourceWidth, sourceHeight)
  const outpaintPreset = data.outpaintPreset || 'free'
  const configuredModelName = data.model?.trim() || ''
  const nodeTitle = isReference
    ? (data.sourceName || data.title)
    : isImage || isVideo
      ? (apiModelDisplayName(configuredModelName) || data.title)
      : data.title
  const imageInputSlots = isImage || isVideo
    ? data.imageInputSlots?.length
      ? data.imageInputSlots
      : [{ id: `${imageInputHandlePrefix}1`, index: 1, connected: false }]
    : [{ id: 'image', index: 1, connected: Boolean(data.imageInputConnected) }]
  const totalInputSlots = 1 + imageInputSlots.length
  const inputPortSpan = Math.min(60, (totalInputSlots - 1) * 12)
  const inputPortStep = totalInputSlots > 1 ? inputPortSpan / (totalInputSlots - 1) : 0
  const inputPortTop = (rowIndex: number) => `${50 - inputPortSpan / 2 + inputPortStep * rowIndex}%`
  const imageSlotSignature = imageInputSlots.map((slot) => `${slot.id}:${slot.connected}`).join('|')

  useEffect(() => {
    updateNodeInternals(nodeId)
  }, [imageSlotSignature, nodeId, updateNodeInternals])

  useEffect(() => {
    if (!isReference) return
    setReferenceImageRatio('—')
    setReferencePixelSize('')
  }, [data.imageUrl, isReference])

  useEffect(() => {
    const nextPrompt = data.prompt || ''
    lastCommittedPromptRef.current = nextPrompt
    if (!isPromptComposingRef.current) setPromptDraft(nextPrompt)
  }, [data.prompt])

  const commitPromptDraft = (nextPrompt: string) => {
    if (lastCommittedPromptRef.current === nextPrompt) return
    lastCommittedPromptRef.current = nextPrompt
    data.onChangePrompt?.(nodeId, nextPrompt)
  }

  if (isGroup) {
    return (
      <div className={`workflow-group ${selected ? 'selected' : ''}`}>
        <div className="workflow-group-head">
          <GroupIcon size={15} />
          <span className="workflow-group-name" title={data.title}>{data.title}</span>
          <small>{data.memberCount ?? 0} 个节点</small>
          <div className="workflow-group-actions nodrag nopan">
            <button type="button" title="重命名分组" aria-label="重命名分组" onClick={() => data.onRenameGroup?.(nodeId)}>
              <Pencil size={13} />
            </button>
            <button type="button" title="删除整个分组" aria-label="删除整个分组" onClick={() => data.onDelete?.(nodeId)}>
              <Trash2 size={13} />
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={`workflow-node ${selected ? 'selected' : ''} ${data.kind}`}>
      {(isImage || isVideo || isRepaint || isOutpaint) && (
        <>
          {imageInputSlots.map((slot, index) => {
            const label = isImage || isVideo ? `Image ${slot.index}` : 'Image'
            const top = inputPortTop(index)
            return [
              <span key={`${slot.id}-label`} className="node-port-label image-input-label" style={{ top }} aria-hidden="true">
                <ImageIcon size={13} />
                {label}
              </span>,
              <Handle
                key={slot.id}
                id={slot.id}
                type="target"
                position={Position.Left}
                className={`node-handle image-input-handle ${slot.connected ? 'connected' : ''}`}
                style={{ top }}
                isConnectable={!slot.connected}
                aria-label={`${label} 输入`}
                title={`连接到 ${label}，或向左拖出参考图节点`}
              />,
            ]
          })}
          <span
            className="node-port-label prompt-input-label"
            style={{ top: inputPortTop(imageInputSlots.length) }}
            aria-hidden="true"
          >
            <Wand2 size={13} />
            Prompt
          </span>
          <Handle
            id="prompt"
            type="target"
            position={Position.Left}
            className={`node-handle prompt-input-handle ${data.promptInputConnected ? 'connected' : ''}`}
            style={{ top: inputPortTop(imageInputSlots.length) }}
            isConnectable={!data.promptInputConnected}
            aria-label="Prompt 输入"
            title="连接提示词节点，或向左拖出提示词节点"
          />
        </>
      )}
      <div className="node-head">
        <div className="node-title">
          {isRepaint ? (
            <Brush size={15} />
          ) : isOutpaint ? (
            <Expand size={15} />
          ) : isImage ? (
            <ImageIcon size={15} />
          ) : isVideo ? (
            <Video size={15} />
          ) : isReference ? (
            <UploadCloud size={15} />
          ) : (
            <Wand2 size={15} />
          )}
          <span
            className={isReference ? 'reference-file-title' : undefined}
            title={(isReference || isImage || isVideo) ? nodeTitle : undefined}
          >
            {nodeTitle}
          </span>
        </div>
        {isReference ? (
          <div
            className="reference-pixel-ratio"
            title={referencePixelSize ? `原始像素 ${referencePixelSize}` : '正在读取图片比例'}
            aria-label={`上传图片比例 ${referenceImageRatio}`}
          >
            {referenceImageRatio}
          </div>
        ) : (isImage || isVideo || isRepaint || isOutpaint) ? (
          <button
            className="node-delete-button nodrag nopan"
            type="button"
            title="删除节点"
            aria-label="删除节点"
            onClick={() => data.onDelete?.(nodeId)}
          >
            <Trash2 size={13} />
          </button>
        ) : (
          <div className={`node-status ${data.status}`}>
            {isGenerating && <Loader2 size={13} />}
            {isDone && <CheckCircle2 size={13} />}
            {isError && <AlertTriangle size={13} />}
            <span>{isGenerating ? '生成中' : isDone ? '完成' : isError ? '失败' : '就绪'}</span>
          </div>
        )}
      </div>

      {(isPrompt || isRepaint || isOutpaint) ? (
        <label className="image-prompt-control nodrag nopan nowheel">
          <span className="image-prompt-heading">
            <span>提示词</span>
            {isOutpaint && (
              <button type="button" onClick={() => data.onResetOutpaintPrompt?.(nodeId)} disabled={isGenerating}>
                恢复默认
              </button>
            )}
          </span>
          <textarea
            value={promptDraft}
            rows={isRepaint ? 4 : isOutpaint ? 6 : 5}
            placeholder={isRepaint ? '描述涂抹区域要重绘成什么' : isOutpaint ? '描述希望扩展出的画面内容' : '输入提示词'}
            onCompositionStart={() => {
              isPromptComposingRef.current = true
            }}
            onCompositionEnd={(event) => {
              isPromptComposingRef.current = false
              const nextPrompt = event.currentTarget.value
              setPromptDraft(nextPrompt)
              commitPromptDraft(nextPrompt)
            }}
            onKeyDown={(event) => event.stopPropagation()}
            onChange={(event) => {
              const nextPrompt = event.currentTarget.value
              setPromptDraft(nextPrompt)
              if (!isPromptComposingRef.current) commitPromptDraft(nextPrompt)
            }}
          />
        </label>
      ) : (
        data.prompt && <p className="node-prompt">{data.prompt}</p>
      )}

      {(isImage || isReference) && (
        data.imageUrl && !isGenerating ? (
          <img
            className="node-image"
            src={data.imageUrl}
            alt={isReference ? (data.sourceName || data.title) : data.title}
            draggable={false}
            style={isImage ? { aspectRatio: selectedAspectRatio.cssRatio } : undefined}
            onLoad={(event) => {
              if (!isReference) return
              const { naturalWidth, naturalHeight } = event.currentTarget
              setReferenceImageRatio(getReferenceImageRatio(naturalWidth, naturalHeight))
              setReferencePixelSize(`${naturalWidth} × ${naturalHeight}`)
            }}
          />
        ) : (
          <div
            className={`node-empty ${isGenerating ? 'generating' : ''}`}
            style={isImage ? { aspectRatio: selectedAspectRatio.cssRatio } : undefined}
            aria-live="polite"
          >
            {isGenerating ? (
              <div className="node-generation-field" role="status" aria-label="正在生成图像">
                <span className="node-generation-frame" aria-hidden="true" />
                <span className="node-generation-copy">正在生成...</span>
              </div>
            ) : (
              <>
                <ImageIcon size={28} />
                <span>等待图像</span>
              </>
            )}
          </div>
        )
      )}

      {isVideo && (
        data.videoUrl && !isGenerating ? (
          <video
            className="node-video nodrag nopan nowheel"
            src={data.videoUrl}
            controls
            playsInline
            preload="metadata"
            style={{ aspectRatio: selectedAspectRatio.cssRatio }}
          />
        ) : (
          <div
            className={`node-empty node-video-empty ${isGenerating ? 'generating' : ''}`}
            style={{ aspectRatio: selectedAspectRatio.cssRatio }}
            aria-live="polite"
          >
            {isGenerating ? (
              <div className="node-generation-field" role="status" aria-label="正在生成视频">
                <span className="node-generation-frame" aria-hidden="true" />
                <span className="node-generation-copy">正在生成视频...</span>
              </div>
            ) : (
              <>
                <Video size={30} />
                <span>等待视频</span>
                <small>连接提示词与参考图后运行</small>
              </>
            )}
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
              <UnifiedRange
                min={10}
                max={96}
                value={brushSize}
                onValueChange={(value) => data.onChangeBrush?.(nodeId, value)}
              />
              <em>{brushSize}</em>
            </label>
            <button type="button" onClick={() => data.onClearMask?.(nodeId)} disabled={isGenerating || !data.maskUrl}>
              清除区域
            </button>
          </div>
        </>
      )}

      {isOutpaint && (
        <OutpaintRangeEditor
          sourceImageUrl={data.sourceImageUrl}
          resultImageUrl={data.imageUrl}
          sourceWidth={sourceWidth}
          sourceHeight={sourceHeight}
          insets={outpaintInsets}
          preset={outpaintPreset}
          disabled={isGenerating}
          onChange={(insets) => data.onChangeOutpaintInsets?.(nodeId, insets)}
          onApplyPreset={(preset) => data.onApplyOutpaintPreset?.(nodeId, preset)}
        />
      )}

      {data.error && <div className="node-error">{data.error}</div>}

      {(isImage || isVideo || isRepaint) && (
        <div className="aspect-ratio-control nodrag nopan" aria-label="尺寸比例">
          <div className="aspect-ratio-heading">
            <span>尺寸比例</span>
            <output>
              <strong>{selectedAspectRatio.label}</strong>
              <small>{selectedAspectRatio.size.replace('x', ' × ')}</small>
            </output>
          </div>
          <div className="aspect-ratio-options">
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
          <div className="node-actions">
            {isReference && (
              <>
                <input
                  ref={replaceImageInputRef}
                  className="node-replace-input nodrag nopan"
                  type="file"
                  accept="image/*"
                  aria-label="替换参考图"
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    event.target.value = ''
                    if (file) data.onReplaceImage?.(nodeId, file)
                  }}
                />
                <button
                  className="node-replace-button nodrag nopan"
                  type="button"
                  title={data.imageUrl ? '替换参考图' : '上传参考图'}
                  onClick={() => replaceImageInputRef.current?.click()}
                >
                  {data.imageUrl ? <RefreshCw size={13} /> : <UploadCloud size={13} />}
                  <span>{data.imageUrl ? '替换' : '上传'}</span>
                </button>
              </>
            )}
            {data.imageUrl && (
              <button type="button" title="下载图像" onClick={() => data.onDownload?.(nodeId)}>
                <Download size={14} />
              </button>
            )}
            {(isImage || isRepaint || isOutpaint) && data.imageUrl && (
              <button type="button" title="保存并查看所在文件夹" onClick={() => data.onRevealImage?.(nodeId)}>
                <FolderOpen size={14} />
              </button>
            )}
            {(isImage || isVideo || isRepaint || isOutpaint) ? (
              <button
                className="node-run-button nodrag nopan"
                type="button"
                title={isGenerating ? '正在生成' : isVideo ? '运行视频生成' : isRepaint ? '运行重绘' : isOutpaint ? '运行扩图' : '运行生成'}
                aria-label={isGenerating ? '正在生成' : isVideo ? '运行视频生成' : isRepaint ? '运行重绘' : isOutpaint ? '运行扩图' : '运行生成'}
                onClick={() => data.onGenerate?.(nodeId)}
                disabled={isGenerating}
              >
                Run
              </button>
            ) : (
              <button type="button" title="删除节点" onClick={() => data.onDelete?.(nodeId)}>
                <Trash2 size={14} />
              </button>
            )}
          </div>
        </>
      )}
      <Handle
        id="output"
        type="source"
        position={Position.Right}
        className={`node-handle output-handle ${data.outputConnected ? 'connected' : ''}`}
        aria-label={isPrompt ? 'Prompt 输出' : isVideo ? 'Video 输出' : 'Image 输出'}
        title={
          isReference
            ? '向右拖出生成图像框'
            : isVideo
              ? '视频生成完成后可连接到后续视频节点'
              : isImage
              ? '向右拖出重绘生成节点'
              : isRepaint
                ? '重绘完成后向右拖出生成图像框'
                : isOutpaint
                  ? '扩图完成后向右拖出生成图像框'
                : undefined
        }
      />
    </div>
  )
}

const workflowNodeTypes = { workflow: WorkflowCard }

function DisconnectibleEdge({
  id: edgeId,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  markerStart,
  style,
  data,
}: EdgeProps<WorkflowEdge>) {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  })
  const disconnect = () => data?.onDisconnect?.(edgeId)

  return (
    <>
      <BaseEdge
        id={edgeId}
        path={edgePath}
        markerStart={markerStart}
        markerEnd={markerEnd}
        style={style}
        interactionWidth={22}
      />
      <g
        className="edge-disconnect-indicator nodrag nopan"
        transform={`translate(${labelX} ${labelY})`}
        role="button"
        tabIndex={0}
        aria-label="取消连接"
        onClick={(event) => {
          event.stopPropagation()
          disconnect()
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          disconnect()
        }}
      >
        <circle r="12" />
        <X className="edge-disconnect-x" x={-7} y={-7} width={14} height={14} strokeWidth={3.6} aria-hidden="true" />
      </g>
    </>
  )
}

const workflowEdgeTypes = { disconnectible: DisconnectibleEdge } satisfies EdgeTypes

export default function App() {
  const importInputRef = useRef<HTMLInputElement>(null)
  const referenceInputRef = useRef<HTMLInputElement>(null)
  const openedProjectHandleRef = useRef<ProjectArchiveFileHandle | null>(null)
  const pendingNodePositionRef = useRef<XYPosition | null>(null)
  const connectingFromNodeIdRef = useRef<string | null>(null)
  const [nodes, setNodes, onNodesChange] = useNodesState<WorkflowNode>([])
  const [edges, setEdges] = useEdgesState<Edge>([])
  const [, setPrompt] = useState(starterPrompt)
  const [projectName, setProjectName] = useState('未命名项目')
  const [dirty, setDirty] = useState(false)
  const [, setIsGenerating] = useState(false)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [showModelStudio, setShowModelStudio] = useState(false)
  const [showHistoryPanel, setShowHistoryPanel] = useState(false)
  const [historyImagePreview, setHistoryImagePreview] = useState<HistoryImagePreview | null>(null)
  const [historyImageNaturalSize, setHistoryImageNaturalSize] = useState<{ width: number; height: number } | null>(null)
  const [showQuickWorkflows, setShowQuickWorkflows] = useState(false)
  const [showPromptLibrary, setShowPromptLibrary] = useState(false)
  const [copiedPromptId, setCopiedPromptId] = useState<string | null>(null)
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance<WorkflowNode, Edge> | null>(null)
  const [contextMenu, setContextMenu] = useState<CanvasContextMenu | null>(null)
  const [groupDialog, setGroupDialog] = useState<GroupDialogState | null>(null)
  const [groupNameDraft, setGroupNameDraft] = useState('')
  const [apiConfig, setApiConfig] = useState<ApiConfig>(() => readStoredApiConfig())
  const [change2ProModels, setChange2ProModels] = useState<Change2ProModelOption[]>([])
  const [change2ProModelStatus, setChange2ProModelStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle')
  const [change2ProModelMessage, setChange2ProModelMessage] = useState('')
  const change2ProModelRequestIdRef = useRef(0)
  const [agnesModels, setAgnesModels] = useState<Change2ProModelOption[]>(agnesFallbackModels)
  const [agnesModelStatus, setAgnesModelStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle')
  const [agnesModelMessage, setAgnesModelMessage] = useState('')
  const agnesModelRequestIdRef = useRef(0)
  const [history, setHistory] = useState<GenerationRecord[]>([])
  const [isExporting, setIsExporting] = useState(false)
  const [isProjectSaving, setIsProjectSaving] = useState(false)
  const [openedProjectFileName, setOpenedProjectFileName] = useState('')
  const [, setToast] = useState('已准备好，默认使用本地模拟生成。')

  const markDirty = useCallback(() => setDirty(true), [])

  useEffect(() => {
    window.localStorage.removeItem(`${API_PROFILE_STORAGE_KEY_PREFIX}volcengine`)
    if (String(apiConfig.mode) !== 'volcengine') return
    window.localStorage.removeItem(API_STORAGE_KEY)
    setApiConfig(defaultApiConfig)
  }, [apiConfig.mode])

  const loadChange2ProModels = useCallback(async () => {
    const apiKey = apiConfig.apiKey.trim()
    const family = apiConfig.change2ProFamily || change2ProFamilyFromModel(apiConfig.model)
    if (!apiKey) {
      setChange2ProModels([])
      setChange2ProModelStatus('idle')
      setChange2ProModelMessage(`请先填写 ${family === 'image2' ? 'Image 2' : 'Nano Banana'} API Key。`)
      return
    }

    const requestId = change2ProModelRequestIdRef.current + 1
    change2ProModelRequestIdRef.current = requestId
    setChange2ProModelStatus('loading')
    setChange2ProModelMessage('正在读取当前 Key 可用的生图模型…')

    try {
      const availableModels = await requestChange2ProModels(apiKey)
      if (change2ProModelRequestIdRef.current !== requestId) return
      const models = availableModels.filter((model) => change2ProModelMatchesFamily(model.id, family))
      if (!models.length) {
        throw new Error(`当前 Key 没有返回可用的 ${family === 'image2' ? 'Image 2' : 'Nano Banana'} 模型。`)
      }
      setChange2ProModels(models)
      setChange2ProModelStatus('success')
      setChange2ProModelMessage(`已从对应 API 读取 ${models.length} 个${family === 'image2' ? ' Image 2' : ' Nano Banana'} 模型。`)
      setApiConfig((current) => {
        const currentFamily = current.change2ProFamily || change2ProFamilyFromModel(current.model)
        if (current.mode !== 'change2pro' || current.apiKey.trim() !== apiKey || currentFamily !== family) return current
        if (models.some((model) => model.id === current.model)) return current
        const next = { ...current, model: models[0].id, change2ProFamily: family }
        window.localStorage.setItem(API_STORAGE_KEY, JSON.stringify(next))
        window.localStorage.setItem(apiProfileStorageKey(next.mode), JSON.stringify(next))
        writeStoredChange2ProFamilyProfile(family, next)
        return next
      })
    } catch (error) {
      if (change2ProModelRequestIdRef.current !== requestId) return
      const message = error instanceof Error ? error.message : '模型列表读取失败。'
      setChange2ProModels([])
      setChange2ProModelStatus('error')
      setChange2ProModelMessage(message)
    }
  }, [apiConfig.apiKey, apiConfig.change2ProFamily, apiConfig.model])

  const loadAgnesModels = useCallback(async () => {
    const apiKey = apiConfig.apiKey.trim()
    const endpoint = apiConfig.endpoint.trim()
    if (!apiKey) {
      setAgnesModels(agnesFallbackModels)
      setAgnesModelStatus('idle')
      setAgnesModelMessage('填写 Agnes AI API Key 后可读取当前账号实际可用的生图模型。')
      return
    }

    const requestId = agnesModelRequestIdRef.current + 1
    agnesModelRequestIdRef.current = requestId
    setAgnesModelStatus('loading')
    setAgnesModelMessage('正在读取 Agnes AI 生图模型…')

    try {
      const models = await requestAgnesModels(apiKey, endpoint)
      if (agnesModelRequestIdRef.current !== requestId) return
      setAgnesModels(models)
      setAgnesModelStatus('success')
      setAgnesModelMessage(`已读取 ${models.length} 个 Agnes AI 生图模型。`)
      setApiConfig((current) => {
        if (current.mode !== 'agnes' || current.apiKey.trim() !== apiKey || current.endpoint.trim() !== endpoint) return current
        if (models.some((model) => model.id === current.model)) return current
        const next = { ...current, model: models[0].id }
        window.localStorage.setItem(API_STORAGE_KEY, JSON.stringify(next))
        window.localStorage.setItem(apiProfileStorageKey(next.mode), JSON.stringify(next))
        return next
      })
    } catch (error) {
      if (agnesModelRequestIdRef.current !== requestId) return
      setAgnesModels(agnesFallbackModels)
      setAgnesModelStatus('error')
      setAgnesModelMessage(error instanceof Error ? error.message : 'Agnes AI 模型列表读取失败。')
    }
  }, [apiConfig.apiKey, apiConfig.endpoint])

  useEffect(() => {
    setEdges((current) => normalizeImageInputEdges(current, nodes))
  }, [nodes, setEdges])

  useEffect(() => {
    if (!showSettings || apiConfig.mode !== 'change2pro') return
    if (apiConfig.apiKey.trim().length < 8) {
      setChange2ProModels([])
      setChange2ProModelStatus('idle')
      setChange2ProModelMessage('填写 Change2Pro API Key 后将自动读取生图模型。')
      return
    }

    const timer = window.setTimeout(() => {
      void loadChange2ProModels()
    }, 500)
    return () => window.clearTimeout(timer)
  }, [apiConfig.apiKey, apiConfig.change2ProFamily, apiConfig.mode, loadChange2ProModels, showSettings])

  useEffect(() => {
    if (!showSettings || apiConfig.mode !== 'agnes') return
    if (apiConfig.apiKey.trim().length < 8) {
      setAgnesModels(agnesFallbackModels)
      setAgnesModelStatus('idle')
      setAgnesModelMessage('填写 Agnes AI API Key 后将自动读取生图模型。')
      return
    }

    const timer = window.setTimeout(() => {
      void loadAgnesModels()
    }, 500)
    return () => window.clearTimeout(timer)
  }, [apiConfig.apiKey, apiConfig.endpoint, apiConfig.mode, loadAgnesModels, showSettings])

  const handleNodesChange = useCallback(
    (changes: NodeChange<WorkflowNode>[]) => {
      onNodesChange(changes)
      markDirty()
    },
    [markDirty, onNodesChange],
  )

  const handleEdgesChange = useCallback(
    (changes: EdgeChange<Edge>[]) => {
      setEdges((current) => normalizeImageInputEdges(applyEdgeChanges(changes, current), nodes))
      markDirty()
    },
    [markDirty, nodes, setEdges],
  )

  const handleConnect = useCallback(
    (connection: Connection) => {
      const sourceNode = nodes.find((node) => node.id === connection.source)
      const targetNode = nodes.find((node) => node.id === connection.target)
      const targetsImageInput = isImageInputHandle(connection.targetHandle)

      if (targetNode?.data.kind === 'image' || targetNode?.data.kind === 'video' || targetNode?.data.kind === 'repaint' || targetNode?.data.kind === 'outpaint') {
        if (targetsImageInput && sourceNode?.data.kind === 'prompt') {
          setToast('提示词节点请连接到 Prompt 输入。')
          return
        }
        if (connection.targetHandle === 'prompt' && sourceNode?.data.kind !== 'prompt') {
          setToast('参考图和生成图请连接到 Image 输入。')
          return
        }
      }

      setEdges((current) => {
        const connected = addEdge(
          {
            ...connection,
            animated: true,
            markerEnd: { type: MarkerType.ArrowClosed, color: workflowEdgeColor },
            style: { stroke: workflowEdgeColor },
          },
          current,
        )
        return normalizeImageInputEdges(connected, nodes)
      })
      if (targetNode?.data.kind === 'outpaint' && targetsImageInput && sourceNode?.data.imageUrl) {
        void (async () => {
          try {
            const sourceImage = await loadCanvasImage(await imageAsDataUrl(sourceNode.data.imageUrl as string))
            const sourceSize = fitSourceForOutpaint(sourceImage.naturalWidth, sourceImage.naturalHeight)
            const outpaintPreset = targetNode.data.outpaintPreset || 'free'
            const outpaintInsets = outpaintPreset === 'free'
              ? defaultOutpaintInsets(sourceSize.width, sourceSize.height)
              : outpaintInsetsForPreset(sourceSize.width, sourceSize.height, outpaintPreset)
            const target = outpaintTargetSize(sourceSize.width, sourceSize.height, outpaintInsets)
            setNodes((current) =>
              current.map((node) =>
                node.id === targetNode.id
                  ? {
                      ...node,
                      data: {
                        ...node.data,
                        sourceImageUrl: sourceNode.data.imageUrl,
                        sourceWidth: sourceSize.width,
                        sourceHeight: sourceSize.height,
                        outpaintInsets,
                        size: nearestAspectRatioOption(target.width, target.height).size,
                        imageUrl: undefined,
                        status: 'idle',
                        error: undefined,
                      },
                    }
                  : node,
              ),
            )
            setToast('图片已连接，扩图范围已按原图尺寸更新。')
          } catch {
            setToast('图片已连接，但暂时无法读取原图尺寸。')
          }
        })()
      }
      markDirty()
    },
    [markDirty, nodes, setEdges, setNodes],
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
      const idsToDelete = collectNodeFamilyIds(nodeIds, nodes)
      if (!idsToDelete.size) return

      setNodes((current) => current.filter((node) => !idsToDelete.has(node.id)))
      setEdges((current) => current.filter((edge) => !idsToDelete.has(edge.source) && !idsToDelete.has(edge.target)))
      setSelectedNodeId((current) => (current && idsToDelete.has(current) ? null : current))
      markDirty()
      setToast(idsToDelete.size > 1 ? `已删除 ${idsToDelete.size} 个画布节点。` : '已删除选中的画布节点。')
    },
    [markDirty, nodes, setEdges, setNodes],
  )

  const deleteNode = useCallback(
    (nodeId: string) => {
      deleteNodesByIds([nodeId])
    },
    [deleteNodesByIds],
  )

  const openCreateGroupDialog = useCallback(() => {
    const selectedNodes = nodes.filter((node) => node.selected)
    const groupableNodes = selectedNodes.filter((node) => !node.parentId && node.data.kind !== 'group')
    if (groupableNodes.length < 2 || groupableNodes.length !== selectedNodes.length) {
      setToast('请选择至少两个尚未分组的节点。')
      return
    }

    setGroupNameDraft(`分组 ${nodes.filter((node) => node.data.kind === 'group').length + 1}`)
    setGroupDialog({ mode: 'create', nodeIds: groupableNodes.map((node) => node.id) })
  }, [nodes])

  const openRenameGroupDialog = useCallback(
    (groupId: string) => {
      const groupNode = nodes.find((node) => node.id === groupId && node.data.kind === 'group')
      if (!groupNode) return
      setGroupNameDraft(groupNode.data.title)
      setGroupDialog({ mode: 'rename', groupId })
    },
    [nodes],
  )

  const closeGroupDialog = useCallback(() => {
    setGroupDialog(null)
    setGroupNameDraft('')
  }, [])

  const submitGroupDialog = useCallback(() => {
    if (!groupDialog) return
    const groupName = groupNameDraft.trim()
    if (!groupName) {
      setToast('请输入分组名称。')
      return
    }

    if (groupDialog.mode === 'rename') {
      setNodes((current) =>
        current.map((node) =>
          node.id === groupDialog.groupId ? { ...node, data: { ...node.data, title: groupName } } : node,
        ),
      )
      markDirty()
      setToast(`分组已重命名为“${groupName}”。`)
      closeGroupDialog()
      return
    }

    const candidateIds = new Set(groupDialog.nodeIds)
    const members = nodes.filter(
      (node) => candidateIds.has(node.id) && !node.parentId && node.data.kind !== 'group',
    )
    if (members.length < 2) {
      setToast('可分组的节点不足两个，请重新框选。')
      closeGroupDialog()
      return
    }

    const bounds = members.reduce(
      (result, node) => {
        const size = getWorkflowNodeSize(node)
        return {
          minX: Math.min(result.minX, node.position.x),
          minY: Math.min(result.minY, node.position.y),
          maxX: Math.max(result.maxX, node.position.x + size.width),
          maxY: Math.max(result.maxY, node.position.y + size.height),
        }
      },
      { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
    )
    const paddingX = 36
    const paddingTop = 58
    const paddingBottom = 34
    const groupId = id('group')
    const groupPosition = { x: bounds.minX - paddingX, y: bounds.minY - paddingTop }
    const groupNode: WorkflowNode = {
      id: groupId,
      type: 'workflow',
      position: groupPosition,
      selected: true,
      zIndex: 0,
      style: {
        width: Math.max(320, bounds.maxX - bounds.minX + paddingX * 2),
        height: Math.max(220, bounds.maxY - bounds.minY + paddingTop + paddingBottom),
      },
      data: {
        kind: 'group',
        title: groupName,
        status: 'idle',
        createdAt: new Date().toLocaleString('zh-CN'),
      },
    }

    setNodes((current) => [
      groupNode,
      ...current.map((node) => {
        if (!candidateIds.has(node.id)) return { ...node, selected: false }
        return {
          ...node,
          parentId: groupId,
          extent: 'parent' as const,
          position: {
            x: node.position.x - groupPosition.x,
            y: node.position.y - groupPosition.y,
          },
          selected: false,
          selectable: false,
          draggable: false,
          zIndex: 1,
        }
      }),
    ])
    setSelectedNodeId(groupId)
    markDirty()
    setToast(`已创建分组“${groupName}”，包含 ${members.length} 个节点。`)
    closeGroupDialog()
  }, [closeGroupDialog, groupDialog, groupNameDraft, markDirty, nodes, setNodes])

  const handleDeleteKey = useCallback(
    (event: KeyboardEvent) => {
      if (event.key !== 'Delete' || showSettings || showModelStudio || groupDialog || historyImagePreview || isKeyboardControlTarget(event.target)) return

      const selectedNodeIds = nodes.filter((node) => node.selected).map((node) => node.id)
      if (selectedNodeId && !selectedNodeIds.includes(selectedNodeId)) selectedNodeIds.push(selectedNodeId)
      if (!selectedNodeIds.length) return

      event.preventDefault()
      deleteNodesByIds(selectedNodeIds)
    },
    [deleteNodesByIds, groupDialog, historyImagePreview, nodes, selectedNodeId, showModelStudio, showSettings],
  )

  useEffect(() => {
    window.addEventListener('keydown', handleDeleteKey, true)
    return () => window.removeEventListener('keydown', handleDeleteKey, true)
  }, [handleDeleteKey])

  useEffect(() => {
    if (!historyImagePreview) return

    const handlePreviewEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setHistoryImagePreview(null)
    }

    window.addEventListener('keydown', handlePreviewEscape, true)
    return () => window.removeEventListener('keydown', handlePreviewEscape, true)
  }, [historyImagePreview])

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

  const changeNodeOutpaintInsets = useCallback(
    (nodeId: string, outpaintInsets: OutpaintInsets) => {
      const node = nodes.find((item) => item.id === nodeId)
      if (!node) return
      const target = outpaintTargetSize(node.data.sourceWidth || 1024, node.data.sourceHeight || 1024, outpaintInsets)
      updateNodeData(nodeId, {
        outpaintInsets,
        outpaintPreset: 'free',
        size: nearestAspectRatioOption(target.width, target.height).size,
        imageUrl: undefined,
        status: 'idle',
      })
    },
    [nodes, updateNodeData],
  )

  const applyNodeOutpaintPreset = useCallback(
    (nodeId: string, outpaintPreset: OutpaintPreset) => {
      const node = nodes.find((item) => item.id === nodeId)
      if (!node) return
      const sourceWidth = node.data.sourceWidth || 1024
      const sourceHeight = node.data.sourceHeight || 1024
      const outpaintInsets = outpaintPreset === 'free'
        ? (node.data.outpaintInsets || defaultOutpaintInsets(sourceWidth, sourceHeight))
        : outpaintInsetsForPreset(sourceWidth, sourceHeight, outpaintPreset)
      const target = outpaintTargetSize(sourceWidth, sourceHeight, outpaintInsets)
      updateNodeData(nodeId, {
        outpaintInsets,
        outpaintPreset,
        size: nearestAspectRatioOption(target.width, target.height).size,
        imageUrl: undefined,
        status: 'idle',
      })
    },
    [nodes, updateNodeData],
  )

  const resetOutpaintPrompt = useCallback(
    (nodeId: string) => {
      updateNodeData(nodeId, { prompt: defaultOutpaintPrompt })
      setToast('已恢复通用扩图提示词。')
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
      const sourcePosition = getAbsoluteNodePosition(sourceNode, nodes)
      const position = {
        x: sourcePosition.x + 380,
        y: Math.min(Math.max(releasedY, sourcePosition.y - 40), sourcePosition.y + 120),
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
          sourceHandle: 'output',
          target: imageNodeId,
          targetHandle: `${imageInputHandlePrefix}1`,
          animated: true,
          markerEnd: { type: MarkerType.ArrowClosed, color: workflowEdgeColor },
          style: { stroke: workflowEdgeColor, strokeWidth: 1.6 },
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
    [apiConfig, flowInstance, markDirty, nodes, setEdges, setNodes],
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
      const sourcePosition = getAbsoluteNodePosition(sourceNode, nodes)
      const position = {
        x: sourcePosition.x + 410,
        y: Math.min(Math.max(releasedY, sourcePosition.y - 72), sourcePosition.y + 120),
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
          sourceHandle: 'output',
          target: repaintNodeId,
          targetHandle: 'image',
          animated: true,
          markerEnd: { type: MarkerType.ArrowClosed, color: workflowEdgeColor },
          style: { stroke: workflowEdgeColor, strokeWidth: 1.6 },
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
    [apiConfig, flowInstance, markDirty, nodes, setEdges, setNodes],
  )

  const createInputNodeFromTarget = useCallback(
    (targetNode: WorkflowNode, targetHandleId: string | null, dropPosition: XYPosition) => {
      const createsPrompt = targetHandleId === 'prompt'
      const createsReference = isImageInputHandle(targetHandleId)
      if (!createsPrompt && !createsReference) return

      const createdAt = new Date().toLocaleString('zh-CN')
      const inputNodeId = id(createsPrompt ? 'prompt' : 'ref')
      const nodeWidth = createsPrompt ? 330 : 312
      const node: WorkflowNode = {
        id: inputNodeId,
        type: 'workflow',
        position: {
          x: dropPosition.x - nodeWidth,
          y: dropPosition.y - (createsPrompt ? 110 : 150),
        },
        selected: true,
        data: createsPrompt
          ? {
              kind: 'prompt',
              title: '提示词输入框',
              prompt: '',
              status: 'idle',
              model: apiConfig.model,
              size: targetNode.data.size || apiConfig.size,
              createdAt,
            }
          : {
              kind: 'reference',
              title: '参考图像',
              status: 'idle',
              model: '上传',
              size: targetNode.data.size || apiConfig.size,
              createdAt,
            },
      }
      const edge: Edge = {
        id: id('edge'),
        source: inputNodeId,
        sourceHandle: 'output',
        target: targetNode.id,
        targetHandle: targetHandleId,
        animated: true,
        markerEnd: { type: MarkerType.ArrowClosed, color: workflowEdgeColor },
        style: { stroke: workflowEdgeColor, strokeWidth: 1.6 },
      }

      setNodes((current) => [
        ...current.map((currentNode) => ({ ...currentNode, selected: false })),
        node,
      ])
      setEdges((current) => normalizeImageInputEdges([...current, edge], [...nodes, node]))
      setSelectedNodeId(inputNodeId)
      markDirty()
      setToast(createsPrompt ? '已拖出并连接空白提示词节点。' : '已拖出并连接空白参考图节点，请上传图片。')
    },
    [apiConfig.model, apiConfig.size, markDirty, nodes, setEdges, setNodes],
  )

  const handleConnectStart = useCallback<OnConnectStart>((_, params) => {
    connectingFromNodeIdRef.current = params.handleType === 'source' ? params.nodeId : null
  }, [])

  const handleConnectEnd = useCallback<OnConnectEnd>(
    (event, connectionState) => {
      const fromHandle = connectionState.fromHandle
      const fromNodeId = connectionState.fromNode?.id ?? fromHandle?.nodeId
      const sourceId = connectionState.fromNode?.id ?? connectionState.fromHandle?.nodeId ?? connectingFromNodeIdRef.current
      connectingFromNodeIdRef.current = null
      if (connectionState.toNode) return

      const clientPosition = getClientPosition(event)
      if (!clientPosition || !flowInstance) return

      const dropPosition = flowInstance.screenToFlowPosition(clientPosition, {
        snapToGrid: true,
        snapGrid: [24, 24],
      })

      if (fromHandle?.type === 'target') {
        const targetNode = nodes.find((node) => node.id === fromNodeId)
        if (targetNode) createInputNodeFromTarget(targetNode, fromHandle.id ?? null, dropPosition)
        return
      }

      const sourceNode = nodes.find((node) => node.id === sourceId)
      if (!sourceNode) return
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
      if (sourceNode.data.kind === 'outpaint') {
        if (!sourceNode.data.imageUrl) {
          setToast('请先完成扩图，再从右侧拖出生成图像框。')
          return
        }
        void createReferenceOutput(sourceNode, dropPosition)
      }
    },
    [createInputNodeFromTarget, createReferenceOutput, createRepaintOutput, flowInstance, nodes],
  )

  const closeContextMenu = useCallback(() => {
    setContextMenu(null)
  }, [])

  const handlePaneContextMenu = useCallback(
    (event: MouseEvent | ReactMouseEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null
      if (target?.closest('.canvas-context-menu')) return

      event.preventDefault()
      if (target?.closest('.workflow-node, .workflow-group, .react-flow__controls')) return

      const clientPosition = { x: event.clientX, y: event.clientY }
      const menuPosition = {
        x: Math.min(clientPosition.x, window.innerWidth - 210),
        y: Math.min(clientPosition.y, window.innerHeight - 216),
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

  const disconnectEdge = useCallback(
    (edgeId: string) => {
      setEdges((current) => normalizeImageInputEdges(current.filter((edge) => edge.id !== edgeId), nodes))
      markDirty()
      setToast('已取消连接。')
    },
    [markDirty, nodes, setEdges],
  )

  const nodeKindById = new Map(nodes.map((node) => [node.id, node.data.kind]))
  const nodesWithActions = nodes.map((node) => {
    const incomingEdges = edges.filter((edge) => edge.target === node.id)
    const promptInputConnected = incomingEdges.some(
      (edge) => edge.targetHandle === 'prompt' || (!edge.targetHandle && nodeKindById.get(edge.source) === 'prompt'),
    )
    const imageInputEdges = incomingEdges.filter(
      (edge) => isImageInputHandle(edge.targetHandle) || (!edge.targetHandle && nodeKindById.get(edge.source) !== 'prompt'),
    )
    const connectedImageIndexes = new Set(
      imageInputEdges.map((edge, index) => imageInputHandleIndex(edge.targetHandle) ?? index + 1),
    )
    const highestConnectedImageIndex = Math.max(0, ...connectedImageIndexes)
    const usesOrderedImageSlots = node.data.kind === 'image' || node.data.kind === 'video'
    const visibleImageSlotCount = usesOrderedImageSlots ? Math.max(1, highestConnectedImageIndex + 1) : 1
    const imageInputSlots = Array.from({ length: visibleImageSlotCount }, (_, index) => ({
      id: usesOrderedImageSlots ? `${imageInputHandlePrefix}${index + 1}` : 'image',
      index: index + 1,
      connected: connectedImageIndexes.has(index + 1),
    }))

    return {
      ...node,
      data: {
        ...node.data,
        model: node.data.kind === 'video'
          ? apiConfig.videoModel
          : (node.data.kind === 'image' || node.data.kind === 'repaint' || node.data.kind === 'outpaint')
            ? apiConfig.model
            : node.data.model,
        promptInputConnected,
        imageInputConnected: imageInputEdges.length > 0,
        imageInputSlots,
        outputConnected: edges.some((edge) => edge.source === node.id),
        memberCount: node.data.kind === 'group' ? nodes.filter((item) => item.parentId === node.id).length : undefined,
        onDelete: deleteNode,
        onDownload: downloadNodeImage,
        onRevealImage: (nodeId: string) => void revealNodeImage(nodeId),
        onReplaceImage: replaceReferenceImage,
        onGenerate: (nodeId: string) => void generateFromNode(nodeId),
        onChangeSize: changeNodeSize,
        onChangePrompt: changeNodePrompt,
        onChangeMask: changeNodeMask,
        onChangeBrush: changeNodeBrush,
        onChangeBrushColor: changeNodeBrushColor,
        onClearMask: clearNodeMask,
        onChangeOutpaintInsets: changeNodeOutpaintInsets,
        onApplyOutpaintPreset: applyNodeOutpaintPreset,
        onResetOutpaintPrompt: resetOutpaintPrompt,
        onUsePrompt: useNodePrompt,
        onRenameGroup: openRenameGroupDialog,
      },
    }
  })

  const renderedEdges = useMemo(
    () =>
      edges.map((edge) => ({
        ...edge,
        type: 'disconnectible',
        data: { ...edge.data, onDisconnect: disconnectEdge },
        markerEnd: { type: MarkerType.ArrowClosed, color: workflowEdgeColor },
        style: { ...edge.style, stroke: workflowEdgeColor },
      })),
    [disconnectEdge, edges],
  )

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
    const sourcePosition = sourceNode ? getAbsoluteNodePosition(sourceNode, nodes) : null
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
        x: sourcePosition ? sourcePosition.x + 380 : baseX + 410,
        y: sourcePosition ? sourcePosition.y : baseY,
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
        sourceHandle: 'output',
        target: imageNodeId,
        targetHandle: 'prompt',
        animated: true,
        markerEnd: { type: MarkerType.ArrowClosed, color: workflowEdgeColor },
        style: { stroke: workflowEdgeColor },
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

    const incomingInputs = edges
      .filter((edge) => edge.target === nodeId)
      .map((edge, edgeOrder) => ({
        edge,
        edgeOrder,
        sourceNode: nodes.find((item) => item.id === edge.source),
      }))
      .filter(
        (item): item is { edge: Edge; edgeOrder: number; sourceNode: WorkflowNode } => Boolean(item.sourceNode),
      )
    const promptSourceNode =
      incomingInputs.find(
        ({ edge, sourceNode }) => edge.targetHandle === 'prompt' && sourceNode.data.kind === 'prompt' && sourceNode.data.prompt?.trim(),
      )?.sourceNode ??
      incomingInputs.find(({ edge, sourceNode }) => !edge.targetHandle && sourceNode.data.kind === 'prompt' && sourceNode.data.prompt?.trim())
        ?.sourceNode
    const referenceImageUrls = incomingInputs
      .filter(
        ({ edge, sourceNode }) =>
          Boolean(sourceNode.data.imageUrl) &&
          (isImageInputHandle(edge.targetHandle) || (!edge.targetHandle && sourceNode.data.kind !== 'prompt')),
      )
      .sort((left, right) => {
        const leftIndex = imageInputHandleIndex(left.edge.targetHandle)
        const rightIndex = imageInputHandleIndex(right.edge.targetHandle)
        if (leftIndex !== null && rightIndex !== null && leftIndex !== rightIndex) return leftIndex - rightIndex
        if (leftIndex !== null && rightIndex === null) return -1
        if (leftIndex === null && rightIndex !== null) return 1
        return left.edgeOrder - right.edgeOrder
      })
      .map(({ sourceNode }) => sourceNode.data.imageUrl as string)
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
      const orderedPrompt = promptWithReferenceImageOrder(trimmed, referenceImageUrls.length)
      const imageUrl = await requestGeneratedImage(orderedPrompt, configForNode, referenceImageUrls)
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
      const referenceSummary = referenceImageUrls.length > 1 ? `，已按 Image 1–${referenceImageUrls.length} 顺序读取参考图` : ''
      setToast(
        apiConfig.mode === 'mock'
          ? `已在图像框内生成 ${outputSize} 模拟图${referenceSummary}。`
          : `已在图像框内生成 ${outputSize} 图像${referenceSummary}。`,
      )
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

  async function generateVideoInNode(nodeId: string) {
    const node = nodes.find((item) => item.id === nodeId)
    if (!node || node.data.kind !== 'video') return

    const incomingSources = edges
      .filter((edge) => edge.target === nodeId)
      .map((edge, edgeOrder) => ({
        edge,
        edgeOrder,
        sourceNode: nodes.find((item) => item.id === edge.source),
      }))
      .filter(
        (item): item is { edge: Edge; edgeOrder: number; sourceNode: WorkflowNode } => Boolean(item.sourceNode),
      )
    const promptSourceNode = incomingSources
      .find(
        ({ edge, sourceNode }) =>
          sourceNode.data.kind === 'prompt' &&
          sourceNode.data.prompt?.trim() &&
          (edge.targetHandle === 'prompt' || !edge.targetHandle),
      )?.sourceNode
    const referenceImageUrls = incomingSources
      .filter(
        ({ edge, sourceNode }) =>
          Boolean(sourceNode.data.imageUrl) &&
          (isImageInputHandle(edge.targetHandle) || (!edge.targetHandle && sourceNode.data.kind !== 'prompt')),
      )
      .sort((left, right) => {
        const leftIndex = imageInputHandleIndex(left.edge.targetHandle)
        const rightIndex = imageInputHandleIndex(right.edge.targetHandle)
        if (leftIndex !== null && rightIndex !== null && leftIndex !== rightIndex) return leftIndex - rightIndex
        if (leftIndex !== null && rightIndex === null) return -1
        if (leftIndex === null && rightIndex !== null) return 1
        return left.edgeOrder - right.edgeOrder
      })
      .map(({ sourceNode }) => sourceNode.data.imageUrl as string)
    const trimmed = promptSourceNode?.data.prompt?.trim() || node.data.prompt?.trim() || ''

    if (!trimmed) {
      updateNodeData(nodeId, { status: 'error', error: '请先连接提示词输入框并填写视频提示词。' })
      return
    }

    if (apiConfig.mode !== 'apimart') {
      updateNodeData(nodeId, { status: 'error', error: '请在 API 设置中选择“API Mart 图像 / 视频”并填写 API Key。' })
      return
    }

    const outputSize = node.data.size || apiConfig.size || defaultApiConfig.size
    const configForNode = { ...apiConfig, size: outputSize }
    const videoModel = findApiMartVideoModel(apiConfig.videoModel)

    setIsGenerating(true)
    updateNodeData(nodeId, {
      status: 'generating',
      error: undefined,
      model: videoModel.id,
      size: outputSize,
    })

    try {
      const orderedPrompt = promptWithReferenceImageOrder(trimmed, referenceImageUrls.length)
      const videoUrl = await requestGeneratedVideo(orderedPrompt, configForNode, referenceImageUrls)
      updateNodeData(nodeId, {
        videoUrl,
        status: 'done',
        error: undefined,
        model: videoModel.id,
        size: outputSize,
      })
      const referenceSummary = referenceImageUrls.length
        ? `，已读取 ${referenceImageUrls.length} 张参考图`
        : ''
      setToast(`已使用 ${videoModel.label} 生成 ${apiConfig.videoDuration} 秒视频${referenceSummary}。`)
    } catch (error) {
      const message = error instanceof Error ? error.message : '视频生成失败'
      updateNodeData(nodeId, { status: 'error', error: message })
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

  async function generateOutpaintInNode(nodeId: string) {
    const node = nodes.find((item) => item.id === nodeId)
    if (!node || node.data.kind !== 'outpaint') return

    const sourceNodes = edges
      .filter((edge) => edge.target === nodeId)
      .map((edge) => nodes.find((item) => item.id === edge.source))
      .filter((item): item is WorkflowNode => Boolean(item))
    const imageSourceNode = sourceNodes.find((item) => item.data.kind !== 'prompt' && item.data.imageUrl)
    const promptSourceNode = sourceNodes.find((item) => item.data.kind === 'prompt' && item.data.prompt?.trim())
    const sourceImageUrl = imageSourceNode?.data.imageUrl || node.data.sourceImageUrl
    let sourceWidth = node.data.sourceWidth || 1024
    let sourceHeight = node.data.sourceHeight || 1024
    let outpaintInsets = node.data.outpaintInsets || defaultOutpaintInsets(sourceWidth, sourceHeight)
    const trimmed = promptSourceNode?.data.prompt?.trim() || node.data.prompt?.trim() || defaultOutpaintPrompt

    if (!sourceImageUrl) {
      updateNodeData(nodeId, { status: 'error', error: '请先连接一张需要扩展的图像到 Image 输入。' })
      return
    }
    if (imageSourceNode?.data.imageUrl && imageSourceNode.data.imageUrl !== node.data.sourceImageUrl) {
      try {
        const sourceImage = await loadCanvasImage(await imageAsDataUrl(imageSourceNode.data.imageUrl))
        const sourceSize = fitSourceForOutpaint(sourceImage.naturalWidth, sourceImage.naturalHeight)
        sourceWidth = sourceSize.width
        sourceHeight = sourceSize.height
        const outpaintPreset = node.data.outpaintPreset || 'free'
        outpaintInsets = outpaintPreset === 'free'
          ? defaultOutpaintInsets(sourceWidth, sourceHeight)
          : outpaintInsetsForPreset(sourceWidth, sourceHeight, outpaintPreset)
        updateNodeData(nodeId, {
          sourceImageUrl,
          sourceWidth,
          sourceHeight,
          outpaintInsets,
          imageUrl: undefined,
          status: 'idle',
          error: undefined,
        })
      } catch {
        updateNodeData(nodeId, { status: 'error', error: '无法读取连接图片的尺寸，请重新连接图片。' })
        return
      }
    }
    const target = outpaintTargetSize(sourceWidth, sourceHeight, outpaintInsets)
    if (target.width > OUTPAINT_MAX_DIMENSION || target.height > OUTPAINT_MAX_DIMENSION) {
      updateNodeData(nodeId, { status: 'error', error: '扩图后的最长边不能超过 4096px。' })
      return
    }
    if (!outpaintInsets.top && !outpaintInsets.right && !outpaintInsets.bottom && !outpaintInsets.left) {
      updateNodeData(nodeId, { status: 'error', error: '请拖动外框，至少增加一个方向的扩展区域。' })
      return
    }

    const ratioOption = nearestAspectRatioOption(target.width, target.height)
    const outputSize = ratioOption.size
    const configForNode = { ...apiConfig, size: outputSize }
    const generationPrompt = outpaintGenerationPrompt(trimmed, sourceWidth, sourceHeight, outpaintInsets)
    const createdAt = new Date().toLocaleString('zh-CN')

    setIsGenerating(true)
    updateNodeData(nodeId, {
      status: 'generating',
      error: undefined,
      prompt: trimmed,
      sourceImageUrl,
      model: apiConfig.model,
      size: outputSize,
    })

    try {
      const prepared = await prepareOutpaintInputs(sourceImageUrl, sourceWidth, sourceHeight, outpaintInsets)
      const generatedImageUrl = await requestGeneratedImage(
        generationPrompt,
        configForNode,
        [prepared.referenceImageUrl],
        prepared.maskUrl,
      )
      const imageUrl = await compositeOutpaintResult(
        sourceImageUrl,
        generatedImageUrl,
        sourceWidth,
        sourceHeight,
        outpaintInsets,
      )
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
          prompt: trimmed,
          model: apiConfig.model,
          size: `${target.width}x${target.height}`,
          createdAt,
          imageUrl,
          status: '成功',
        },
        ...current,
      ])
      setToast(
        apiConfig.mode === 'mock'
          ? `已生成 ${target.width} × ${target.height}px 扩图模拟结果，原图区域已保护。`
          : `扩图完成：${target.width} × ${target.height}px，原图区域已保护。`,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : '扩图生成失败'
      updateNodeData(nodeId, { status: 'error', error: message })
      setHistory((current) => [
        {
          id: nodeId,
          prompt: trimmed,
          model: apiConfig.model,
          size: `${target.width}x${target.height}`,
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
    if (node?.data.kind === 'video') {
      void generateVideoInNode(node.id)
      return
    }
    if (node?.data.kind === 'repaint') {
      void generateRepaintInNode(node.id)
      return
    }
    if (node?.data.kind === 'outpaint') {
      void generateOutpaintInNode(node.id)
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

  function addImageGenerationNodeAt(position: XYPosition) {
    const node: WorkflowNode = {
      id: id('image'),
      type: 'workflow',
      position,
      data: {
        kind: 'image',
        title: 'AI 生成图像',
        prompt: '',
        status: 'idle',
        model: apiConfig.model,
        size: apiConfig.size || defaultApiConfig.size,
        createdAt: new Date().toLocaleString('zh-CN'),
      },
    }
    setNodes((current) => [...current, node])
    setSelectedNodeId(node.id)
    markDirty()
    setToast('已在画布中添加图像生成框。')
  }

  function addImageGenerationFromMenu() {
    if (!contextMenu) return
    addImageGenerationNodeAt(contextMenu.flowPosition)
    closeContextMenu()
  }

  function addVideoGenerationNodeAt(position: XYPosition) {
    const node: WorkflowNode = {
      id: id('video'),
      type: 'workflow',
      position,
      data: {
        kind: 'video',
        title: 'AI 视频生成',
        prompt: '',
        status: 'idle',
        model: apiConfig.videoModel,
        size: apiConfig.size || defaultApiConfig.size,
        createdAt: new Date().toLocaleString('zh-CN'),
      },
    }
    setNodes((current) => [...current, node])
    setSelectedNodeId(node.id)
    markDirty()
    setToast('已在画布中添加视频生成框。')
  }

  function addVideoGenerationFromMenu() {
    if (!contextMenu) return
    addVideoGenerationNodeAt(contextMenu.flowPosition)
    closeContextMenu()
  }

  function addQuickStartWorkflow(options: {
    outputKind: 'image' | 'video'
    initialPrompt?: string
    toastMessage: string
  }) {
    const canvasCenter = flowInstance?.screenToFlowPosition(
      { x: window.innerWidth / 2, y: window.innerHeight / 2 },
      { snapToGrid: true, snapGrid: [24, 24] },
    ) ?? { x: 720, y: 460 }
    const createdAt = new Date().toLocaleString('zh-CN')
    const referenceNodeId = id('ref')
    const promptNodeId = id('prompt')
    const outputNodeId = id(options.outputKind)
    const referenceNode: WorkflowNode = {
      id: referenceNodeId,
      type: 'workflow',
      position: { x: canvasCenter.x - 560, y: canvasCenter.y - 340 },
      data: {
        kind: 'reference',
        title: '参考图像',
        status: 'idle',
        model: '上传',
        size: apiConfig.size || defaultApiConfig.size,
        createdAt,
      },
    }
    const promptNode: WorkflowNode = {
      id: promptNodeId,
      type: 'workflow',
      position: { x: canvasCenter.x - 560, y: canvasCenter.y + 100 },
      data: {
        kind: 'prompt',
        title: '提示词输入框',
        prompt: options.initialPrompt || '',
        status: 'idle',
        model: apiConfig.model,
        size: apiConfig.size || defaultApiConfig.size,
        createdAt,
      },
    }
    const outputNode: WorkflowNode = {
      id: outputNodeId,
      type: 'workflow',
      position: { x: canvasCenter.x - 40, y: canvasCenter.y - 250 },
      selected: true,
      data: {
        kind: options.outputKind,
        title: options.outputKind === 'video' ? 'AI 视频生成' : 'AI 生成图像',
        prompt: '',
        status: 'idle',
        model: options.outputKind === 'video' ? apiConfig.videoModel : apiConfig.model,
        size: apiConfig.size || defaultApiConfig.size,
        createdAt,
      },
    }
    const workflowEdges: Edge[] = [
      {
        id: id('edge'),
        source: referenceNodeId,
        sourceHandle: 'output',
        target: outputNodeId,
        targetHandle: `${imageInputHandlePrefix}1`,
        animated: true,
        markerEnd: { type: MarkerType.ArrowClosed, color: workflowEdgeColor },
        style: { stroke: workflowEdgeColor, strokeWidth: 1.6 },
      },
      {
        id: id('edge'),
        source: promptNodeId,
        sourceHandle: 'output',
        target: outputNodeId,
        targetHandle: 'prompt',
        animated: true,
        markerEnd: { type: MarkerType.ArrowClosed, color: workflowEdgeColor },
        style: { stroke: workflowEdgeColor, strokeWidth: 1.6 },
      },
    ]

    setNodes((current) => [
      ...current.map((node) => ({ ...node, selected: false })),
      referenceNode,
      promptNode,
      outputNode,
    ])
    setEdges((current) => [...current, ...workflowEdges])
    setSelectedNodeId(outputNodeId)
    setShowQuickWorkflows(false)
    setShowPromptLibrary(false)
    markDirty()
    setToast(options.toastMessage)
    window.setTimeout(() => {
      void flowInstance?.fitView({
        nodes: [{ id: referenceNodeId }, { id: promptNodeId }, { id: outputNodeId }],
        padding: 0.18,
        maxZoom: 0.92,
        duration: 240,
      })
    }, 0)
  }

  function addImageToImageQuickWorkflow() {
    addQuickStartWorkflow({
      outputKind: 'image',
      toastMessage: '已创建参考图生成工作流，请上传参考图并填写提示词。',
    })
  }

  function addVideoQuickWorkflow() {
    addQuickStartWorkflow({
      outputKind: 'video',
      toastMessage: '已创建视频生成工作流，请上传参考图并填写提示词。',
    })
  }

  function addProductRetouchQuickWorkflow() {
    addQuickStartWorkflow({
      outputKind: 'image',
      initialPrompt: productRetouchPrompt,
      toastMessage: '已创建产品图精修工作流，请上传待精修的产品图。',
    })
  }

  function addOutpaintNodeAt(position: XYPosition) {
    const sourceWidth = 1024
    const sourceHeight = 1024
    const outpaintInsets = defaultOutpaintInsets(sourceWidth, sourceHeight)
    const target = outpaintTargetSize(sourceWidth, sourceHeight, outpaintInsets)
    const node: WorkflowNode = {
      id: id('outpaint'),
      type: 'workflow',
      position,
      data: {
        kind: 'outpaint',
        title: 'AI 扩图',
        prompt: defaultOutpaintPrompt,
        sourceWidth,
        sourceHeight,
        outpaintInsets,
        outpaintPreset: 'free',
        status: 'idle',
        model: apiConfig.model,
        size: nearestAspectRatioOption(target.width, target.height).size,
        createdAt: new Date().toLocaleString('zh-CN'),
      },
    }
    setNodes((current) => [...current, node])
    setSelectedNodeId(node.id)
    markDirty()
    setToast('已添加 AI 扩图节点，请把图片连接到 Image 输入。')
  }

  function addOutpaintFromMenu() {
    if (!contextMenu) return
    addOutpaintNodeAt(contextMenu.flowPosition)
    closeContextMenu()
  }

  function uploadReferenceFromMenu() {
    if (contextMenu) {
      pendingNodePositionRef.current = contextMenu.flowPosition
    }
    closeContextMenu()
    referenceInputRef.current?.click()
  }

  async function saveProject() {
    if (isProjectSaving || isExporting) return

    const pickerWindow = window as ProjectFilePickerWindow
    const replacingOpenedPackage = Boolean(openedProjectHandleRef.current)
    let targetHandle = openedProjectHandleRef.current

    try {
      if (!targetHandle && pickerWindow.showSaveFilePicker) {
        targetHandle = await pickerWindow.showSaveFilePicker({
          suggestedName: projectPackageFileName(projectName),
          types: [{ description: 'AI 画布项目包', accept: { 'application/zip': ['.zip'] } }],
        })
      }
      if (targetHandle && !(await requestProjectFileWritePermission(targetHandle))) {
        setToast('未获得项目文件的写入权限，保存已取消。')
        return
      }
    } catch (error) {
      if (!isPickerCancelled(error)) setToast(error instanceof Error ? error.message : '无法选择保存位置')
      return
    }

    let sessionId = ''
    let sessionClosed = false
    setIsProjectSaving(true)
    try {
      setToast(targetHandle ? '正在保存项目包...' : '正在整理项目，请选择保存文件夹...')
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
      const downloadQuery = targetHandle ? '&download=1' : ''
      const response = await fetch(
        `/api/projects/package/finish?sessionId=${encodeURIComponent(sessionId)}&filename=${encodeURIComponent(packageName)}${downloadQuery}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json;charset=utf-8' },
          body: JSON.stringify(project),
        },
      )
      sessionClosed = true

      if (targetHandle) {
        if (!response.ok || !response.headers.get('content-type')?.includes('application/zip')) {
          const payload = (await response.json().catch(() => null)) as PackageResponse | null
          throw new Error(payload?.error || '项目包生成失败')
        }
        await writeProjectPackage(targetHandle, await response.blob())
        openedProjectHandleRef.current = targetHandle
        setOpenedProjectFileName(targetHandle.name)
        setDirty(false)
        setToast(replacingOpenedPackage ? `已保存并替换 ${targetHandle.name}` : `项目已保存到 ${targetHandle.name}`)
        return
      }

      if (response.headers.get('content-type')?.includes('application/zip')) {
        if (!response.ok) throw new Error('项目包下载失败')
        const downloadUrl = URL.createObjectURL(await response.blob())
        downloadImage(downloadUrl, packageName)
        window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000)
        setDirty(false)
        setToast('项目包已下载；当前浏览器不支持直接覆盖原文件。')
        return
      }

      const payload = await readPackageResponse(response)
      if (payload?.cancelled) return
      setDirty(false)
      setToast('项目包已保存到选择的文件夹。')
    } catch (error) {
      const message = error instanceof Error ? error.message : '保存失败'
      setToast(message)
      window.alert(`保存失败：${message}`)
    } finally {
      if (sessionId && !sessionClosed) void cancelProjectPackage(sessionId)
      setIsProjectSaving(false)
    }
  }

  async function exportProject() {
    if (isExporting || isProjectSaving) return
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
    setDirty(false)
    setToast('项目已导入，图片将从项目缓存按需加载。')
  }

  async function importProjectText(text: string) {
    try {
      applyImportedProject(JSON.parse(text) as Partial<ProjectFile>)
      return true
    } catch (error) {
      setToast(error instanceof Error && error.message === 'INVALID_PROJECT' ? '导入失败：请选择 AI 画布项目文件。' : '导入失败：文件不是有效项目。')
      return false
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
        return true
      }
      return await importProjectText(await file.text())
    } catch (error) {
      setToast(error instanceof Error ? error.message : '导入项目失败')
      return false
    }
  }

  async function chooseProjectToImport() {
    const pickerWindow = window as ProjectFilePickerWindow
    if (!pickerWindow.showOpenFilePicker) {
      importInputRef.current?.click()
      return
    }

    try {
      const [handle] = await pickerWindow.showOpenFilePicker({
        multiple: false,
        types: [
          { description: 'AI 画布项目', accept: { 'application/zip': ['.zip'], 'application/json': ['.json'] } },
        ],
      })
      if (!handle) return
      const imported = await importProjectFile(await handle.getFile())
      if (!imported) return
      if (/\.zip$/i.test(handle.name)) {
        openedProjectHandleRef.current = handle
        setOpenedProjectFileName(handle.name)
      } else {
        openedProjectHandleRef.current = null
        setOpenedProjectFileName('')
      }
    } catch (error) {
      if (!isPickerCancelled(error)) setToast(error instanceof Error ? error.message : '打开项目失败')
    }
  }

  function importProject(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file) {
      void importProjectFile(file).then((imported) => {
        if (!imported) return
        openedProjectHandleRef.current = null
        setOpenedProjectFileName('')
      })
    }
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

  function addModelPreviewToCanvas(result: { dataUrl: string; fileName: string; width: number; height: number }) {
    const canvasCenter = flowInstance?.screenToFlowPosition(
      { x: window.innerWidth / 2, y: window.innerHeight / 2 },
      { snapToGrid: true, snapGrid: [24, 24] },
    ) ?? { x: 150 + nodes.length * 24, y: 180 + nodes.length * 24 }
    const node: WorkflowNode = {
      id: id('ref'),
      type: 'workflow',
      position: { x: canvasCenter.x - 156, y: canvasCenter.y - 180 },
      selected: true,
      data: {
        kind: 'reference',
        title: '3D 模型参考图',
        imageUrl: result.dataUrl,
        status: 'done',
        model: '3D 预览',
        size: `${result.width}x${result.height}`,
        sourceName: result.fileName,
        createdAt: new Date().toLocaleString('zh-CN'),
      },
    }

    setNodes((current) => [...current.map((item) => ({ ...item, selected: false })), node])
    setSelectedNodeId(node.id)
    setShowModelStudio(false)
    markDirty()
    setToast(`3D 视角已作为 ${result.width} × ${result.height} 参考图加入画板。`)
    window.setTimeout(() => {
      void flowInstance?.fitView({
        nodes: [{ id: node.id }],
        padding: 0.32,
        maxZoom: 1,
        duration: 220,
      })
    }, 0)
  }

  function replaceReferenceImage(nodeId: string, file: File) {
    if (!file.type.startsWith('image/')) {
      setToast('请选择有效的图片文件。')
      return
    }

    const reader = new FileReader()
    reader.onload = () => {
      updateNodeData(nodeId, {
        imageUrl: String(reader.result),
        sourceName: file.name,
        status: 'done',
        error: undefined,
        createdAt: new Date().toLocaleString('zh-CN'),
      })
      setToast(`已替换参考图：${file.name}`)
    }
    reader.onerror = () => setToast('替换失败，请重新选择图片。')
    reader.readAsDataURL(file)
  }

  function updateApiConfig(patch: Partial<ApiConfig>) {
    setApiConfig((current) => {
      const requestedMode = patch.mode
      let next: ApiConfig

      if (requestedMode && requestedMode !== current.mode) {
        window.localStorage.setItem(apiProfileStorageKey(current.mode), JSON.stringify(current))
        if (current.mode === 'change2pro') {
          writeStoredChange2ProFamilyProfile(
            current.change2ProFamily || change2ProFamilyFromModel(current.model),
            current,
          )
        }
        const storedProfile = readStoredApiProfile(requestedMode)
        next = {
          ...defaultApiConfig,
          ...apiModePreset(requestedMode),
          ...storedProfile,
          ...patch,
          mode: requestedMode,
        }
      } else {
        const mode = patch.apiKey?.trim() && current.mode === 'mock' && !requestedMode ? 'openai' : current.mode
        next = { ...current, ...patch, mode }
      }

      if (next.mode === 'change2pro') {
        next = {
          ...next,
          change2ProFamily: next.change2ProFamily || change2ProFamilyFromModel(next.model),
        }
      }
      if (next.mode === 'apimart') {
        const model = findApiMartModel(next.model)
        const videoModel = findApiMartVideoModel(next.videoModel)
        const requestedDuration = Number(next.videoDuration)
        next = {
          ...next,
          endpoint: next.endpoint || apiMartApiConfig.endpoint || '',
          model: model.id,
          imageSize: model.resolutions.includes(next.imageSize) ? next.imageSize : model.defaultResolution,
          videoModel: videoModel.id,
          videoResolution: videoModel.resolutions.includes(next.videoResolution)
            ? next.videoResolution
            : videoModel.defaultResolution,
          videoDuration: Number.isFinite(requestedDuration)
            ? Math.min(videoModel.maxDuration, Math.max(videoModel.minDuration, Math.round(requestedDuration)))
            : videoModel.defaultDuration,
        }
      }

      window.localStorage.setItem(API_STORAGE_KEY, JSON.stringify(next))
      window.localStorage.setItem(apiProfileStorageKey(next.mode), JSON.stringify(next))
      if (next.mode === 'change2pro') {
        writeStoredChange2ProFamilyProfile(next.change2ProFamily || change2ProFamilyFromModel(next.model), next)
      }
      return next
    })
  }

  function switchChange2ProFamily(family: Change2ProApiFamily) {
    setChange2ProModels([])
    setChange2ProModelStatus('idle')
    setChange2ProModelMessage(`已切换到 ${family === 'image2' ? 'Image 2' : 'Nano Banana'} API 配置。`)

    setApiConfig((current) => {
      const currentFamily = current.change2ProFamily || change2ProFamilyFromModel(current.model)
      if (currentFamily === family) return current

      writeStoredChange2ProFamilyProfile(currentFamily, current)
      const storedProfile = readStoredChange2ProFamilyProfile(family)
      const next: ApiConfig = {
        ...current,
        mode: 'change2pro',
        endpoint: 'https://api.change2pro.com/v1/images/generations',
        apiKey: '',
        model: change2ProDefaultModel(family),
        imageSize: '1K',
        responsePath: 'data.0.url',
        ...storedProfile,
        change2ProFamily: family,
      }

      window.localStorage.setItem(API_STORAGE_KEY, JSON.stringify(next))
      window.localStorage.setItem(apiProfileStorageKey('change2pro'), JSON.stringify(next))
      writeStoredChange2ProFamilyProfile(family, next)
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

  const selectedCanvasNodes = nodes.filter((node) => node.selected)
  const canGroupSelection =
    selectedCanvasNodes.length >= 2 &&
    selectedCanvasNodes.every((node) => !node.parentId && node.data.kind !== 'group')

  return (
    <main className="canvas-app">
      <header className="app-header">
        <div className="brand-zone">
          <div className="brand-mark">
            <img src={brandLogo} alt="JUC" />
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
          <button type="button" onClick={exportProject} title="导出 ZIP 项目包" disabled={isExporting || isProjectSaving}>
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
            type="button"
            onClick={() => void saveProject()}
            title={openedProjectFileName ? `保存并替换 ${openedProjectFileName}` : '保存项目包到自定义位置'}
            disabled={isProjectSaving || isExporting}
          >
            {isProjectSaving ? <Loader2 className="export-spinner" size={15} /> : <Save size={15} />}
            {isProjectSaving ? '保存中' : '保存'}
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
            edges={renderedEdges}
            nodeTypes={workflowNodeTypes}
            edgeTypes={workflowEdgeTypes}
            onNodesChange={handleNodesChange}
            onEdgesChange={handleEdgesChange}
            onConnect={handleConnect}
            onConnectStart={handleConnectStart}
            onConnectEnd={handleConnectEnd}
            onInit={setFlowInstance}
            onNodeClick={(_, node) => {
              const selectionId = node.parentId ?? node.id
              setSelectedNodeId(selectionId)
              if (node.parentId) {
                setNodes((current) =>
                  current.map((item) => ({ ...item, selected: item.id === node.parentId })),
                )
              }
            }}
            onEdgeClick={(event, edge) => {
              event.stopPropagation()
              disconnectEdge(edge.id)
            }}
            onPaneClick={handlePaneClick}
            onPaneContextMenu={handlePaneContextMenu}
            fitView
            fitViewOptions={{ padding: 0.2, maxZoom: 0.92 }}
            proOptions={{ hideAttribution: true }}
            selectionOnDrag
            selectionMode={SelectionMode.Partial}
            panOnDrag={[1]}
            deleteKeyCode={null}
            elevateNodesOnSelect={false}
            minZoom={0.12}
            maxZoom={2.4}
            defaultEdgeOptions={{
              animated: true,
              markerEnd: { type: MarkerType.ArrowClosed, color: workflowEdgeColor },
              style: { stroke: workflowEdgeColor, strokeWidth: 1.5 },
            }}
          >
            <Background color="rgba(255, 255, 255, 0.24)" gap={26} size={1.35} />
            <Controls showInteractive={false} />
          </ReactFlow>
          {selectedCanvasNodes.length > 0 && !groupDialog && (
            <div className="selection-toolbar" role="toolbar" aria-label="已选节点操作">
              <div className="selection-toolbar-summary">
                <strong>已选 {selectedCanvasNodes.length} 项</strong>
                <span>
                  {selectedCanvasNodes.some((node) => node.data.kind === 'group')
                    ? '拖动分组可整体移动'
                    : '拖动任一节点可同步移动'}
                </span>
              </div>
              <button
                type="button"
                onClick={openCreateGroupDialog}
                disabled={!canGroupSelection}
                title={canGroupSelection ? '把选中的节点打组' : '请选择至少两个未分组节点'}
              >
                <GroupIcon size={14} />
                打组
              </button>
              <button
                className="selection-toolbar-delete"
                type="button"
                onClick={() => deleteNodesByIds(selectedCanvasNodes.map((node) => node.id))}
              >
                <Trash2 size={14} />
                删除
              </button>
            </div>
          )}
          {nodes.length === 0 && (
            <div className="canvas-quick-start" role="group" aria-label="快速启动">
              <button className="canvas-quick-start-button" type="button" onClick={addImageToImageQuickWorkflow}>
                <ImageIcon size={18} aria-hidden="true" />
                <span>参考图生成</span>
              </button>
              <button className="canvas-quick-start-button" type="button" onClick={addVideoQuickWorkflow}>
                <Video size={18} aria-hidden="true" />
                <span>视频生成</span>
              </button>
              <button className="canvas-quick-start-button" type="button" onClick={addProductRetouchQuickWorkflow}>
                <Wand2 size={18} aria-hidden="true" />
                <span>产品图精修</span>
              </button>
            </div>
          )}
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
              <button type="button" onClick={addImageGenerationFromMenu}>
                <ImageIcon size={15} />
                图像生成
              </button>
              <button type="button" onClick={addVideoGenerationFromMenu}>
                <Video size={15} />
                视频生成
              </button>
              <button type="button" onClick={addOutpaintFromMenu}>
                <Expand size={15} />
                AI扩图
              </button>
            </div>
          )}
          <div className="quick-workflow-popover">
            <SpecularButton
              className={`prompt-library-toggle ${showQuickWorkflows ? 'active' : ''}`}
              size="md"
              radius={8}
              tint="#ffffff"
              tintOpacity={0}
              blur={0}
              textColor="#f5f5f5"
              lineColor="#ffffff"
              baseColor="#525252"
              intensity={0.8}
              shineSize={11}
              shineFade={31}
              thickness={1.3}
              speed={0.3}
              proximity={50}
              followMouse
              autoAnimate={false}
              onClick={() => {
                setShowQuickWorkflows((current) => !current)
                setShowPromptLibrary(false)
              }}
              title="快捷工作流"
              aria-expanded={showQuickWorkflows}
              aria-controls="quick-workflow-panel"
            >
              <WorkflowIcon size={15} />
              快捷工作流
            </SpecularButton>
            {showQuickWorkflows && (
              <section id="quick-workflow-panel" className="quick-workflow-panel" aria-label="快捷工作流">
                <div className="prompt-library-head">
                  <div>
                    <strong>快捷工作流</strong>
                    <small>一键布置并连接常用节点</small>
                  </div>
                  <button type="button" onClick={() => setShowQuickWorkflows(false)} title="关闭快捷工作流">
                    <X size={15} />
                  </button>
                </div>
                <div className="quick-workflow-list">
                  <button className="quick-workflow-card" type="button" onClick={addImageToImageQuickWorkflow}>
                    <span className="quick-workflow-icon" aria-hidden="true">
                      <WorkflowIcon size={18} />
                    </span>
                    <span className="quick-workflow-copy">
                      <strong>图生图</strong>
                      <small>空白参考图 + 空白提示词 + 图像生成</small>
                    </span>
                    <span className="quick-workflow-action">创建</span>
                  </button>
                </div>
              </section>
            )}
          </div>
          <div className="prompt-library-popover">
            <SpecularButton
              className={`prompt-library-toggle ${showPromptLibrary ? 'active' : ''}`}
              size="md"
              radius={8}
              tint="#ffffff"
              tintOpacity={0}
              blur={0}
              textColor="#f5f5f5"
              lineColor="#ffffff"
              baseColor="#525252"
              intensity={0.8}
              shineSize={11}
              shineFade={31}
              thickness={1.3}
              speed={0.3}
              proximity={50}
              followMouse
              autoAnimate={false}
              onClick={() => {
                setShowPromptLibrary((current) => !current)
                setShowQuickWorkflows(false)
              }}
              title="常用提示词"
              aria-expanded={showPromptLibrary}
              aria-controls="prompt-library-panel"
            >
              <BookOpen size={15} />
              提示词
            </SpecularButton>
            {showPromptLibrary && (
              <section id="prompt-library-panel" className="prompt-library-panel" aria-label="提示词库">
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
          <div className="model3d-left-popover">
            <SpecularButton
              className={`prompt-library-toggle ${showModelStudio ? 'active' : ''}`}
              size="md"
              radius={8}
              tint="#ffffff"
              tintOpacity={0}
              blur={0}
              textColor="#f5f5f5"
              lineColor="#ffffff"
              baseColor="#525252"
              intensity={0.8}
              shineSize={11}
              shineFade={31}
              thickness={1.3}
              speed={0.3}
              proximity={50}
              followMouse
              autoAnimate={false}
              onClick={() => {
                setShowQuickWorkflows(false)
                setShowPromptLibrary(false)
                setShowModelStudio(true)
              }}
              title="打开 3D 模型预览"
              aria-label="打开 3D 模型预览"
            >
              <Box size={15} />
              3D 模型
            </SpecularButton>
          </div>
          <div className={`history-popover ${showHistoryPanel ? 'expanded' : ''}`}>
            <button
              className={`history-toggle ${showHistoryPanel ? 'active' : ''}`}
              type="button"
              onClick={() => setShowHistoryPanel((current) => !current)}
              title={showHistoryPanel ? '收起生成历史' : '生成历史'}
              aria-label={showHistoryPanel ? '收起生成历史' : '展开生成历史'}
              aria-expanded={showHistoryPanel}
              aria-controls="generation-history-panel"
            >
              <History size={15} />
              <span className="history-toggle-label">生成历史</span>
              {showHistoryPanel && <X className="history-toggle-close" size={15} />}
            </button>
            {showHistoryPanel && (
              <div className="history-menu" id="generation-history-panel">
                {history.length ? (
                  <div className="history-grid">
                    {history.slice(0, 12).map((item, index) => {
                      const imageUrl = item.imageUrl || nodes.find((node) => node.id === item.id)?.data.imageUrl
                      return (
                        <div className="history-card" key={`${item.id}-${item.createdAt}-${index}`}>
                          <div className="history-thumb-wrap">
                            <button className="history-thumb" type="button" onClick={() => setPrompt(item.prompt)} title="使用这条提示词">
                              {imageUrl ? <img src={imageUrl} alt="生成历史缩略图" /> : <ImageIcon size={22} />}
                            </button>
                            {imageUrl && (
                              <button
                                className="history-preview-button"
                                type="button"
                                onClick={() => {
                                  setHistoryImageNaturalSize(null)
                                  setHistoryImagePreview({ imageUrl, prompt: item.prompt, createdAt: item.createdAt })
                                }}
                                title="查看大图"
                                aria-label="查看生成历史大图"
                              >
                                <Eye size={17} />
                              </button>
                            )}
                          </div>
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
          {historyImagePreview && (
            <div
              className="history-image-backdrop"
              role="presentation"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) setHistoryImagePreview(null)
              }}
              onContextMenu={(event) => event.stopPropagation()}
            >
              <section
                className={`history-image-modal ${
                  historyImageNaturalSize
                    ? historyImageNaturalSize.width > historyImageNaturalSize.height
                      ? 'is-landscape'
                      : historyImageNaturalSize.width < historyImageNaturalSize.height
                        ? 'is-portrait'
                        : 'is-square'
                    : ''
                }`}
                role="dialog"
                aria-modal="true"
                aria-label="生成历史大图预览"
                onMouseDown={(event) => event.stopPropagation()}
              >
                <div className="history-image-head">
                  <div>
                    <strong>生成历史</strong>
                    <small>{historyImagePreview.createdAt}</small>
                  </div>
                  <button type="button" onClick={() => setHistoryImagePreview(null)} title="关闭" aria-label="关闭大图预览">
                    <X size={18} />
                  </button>
                </div>
                <div className="history-image-stage">
                  <img
                    src={historyImagePreview.imageUrl}
                    alt="生成历史大图"
                    onLoad={(event) => {
                      const { naturalWidth, naturalHeight } = event.currentTarget
                      if (naturalWidth > 0 && naturalHeight > 0) {
                        setHistoryImageNaturalSize({ width: naturalWidth, height: naturalHeight })
                      }
                    }}
                  />
                </div>
                <div className="history-image-caption" title={historyImagePreview.prompt}>
                  {historyImagePreview.prompt}
                </div>
              </section>
            </div>
          )}
        </div>
      </section>

      {groupDialog && (
        <div className="modal-backdrop" role="presentation">
          <section className="group-name-modal" role="dialog" aria-modal="true" aria-label={groupDialog.mode === 'create' ? '创建分组' : '重命名分组'}>
            <div className="modal-head">
              <div>
                <h2>{groupDialog.mode === 'create' ? '创建分组' : '重命名分组'}</h2>
                <p>
                  {groupDialog.mode === 'create'
                    ? `将 ${groupDialog.nodeIds.length} 个节点作为一个整体移动和删除。`
                    : '修改分组在画布上显示的名称。'}
                </p>
              </div>
              <button type="button" onClick={closeGroupDialog} title="关闭">
                <X size={18} />
              </button>
            </div>
            <form
              onSubmit={(event) => {
                event.preventDefault()
                submitGroupDialog()
              }}
            >
              <label className="group-name-field">
                <span>分组名称</span>
                <input
                  autoFocus
                  value={groupNameDraft}
                  maxLength={40}
                  onChange={(event) => setGroupNameDraft(event.target.value)}
                  placeholder="例如：产品主视觉"
                />
              </label>
              <div className="group-name-actions">
                <button type="button" onClick={closeGroupDialog}>取消</button>
                <button className="primary" type="submit" disabled={!groupNameDraft.trim()}>
                  {groupDialog.mode === 'create' ? '创建分组' : '保存名称'}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}

      {showModelStudio && (
        <Suspense
          fallback={(
            <div className="modal-backdrop" role="presentation">
              <section className="settings-modal" role="status" aria-label="正在加载 3D 预览器">
                <div className="modal-head">
                  <div>
                    <h2>正在加载 3D 预览器</h2>
                    <p>首次打开需要载入三维引擎。</p>
                  </div>
                  <Loader2 className="export-spinner" size={18} />
                </div>
              </section>
            </div>
          )}
        >
          <Model3DStudio
            onClose={() => setShowModelStudio(false)}
            onExport={addModelPreviewToCanvas}
          />
        </Suspense>
      )}

      {showSettings && (
        <div className="modal-backdrop" role="presentation">
          <section className="settings-modal" role="dialog" aria-modal="true" aria-label="API 设置">
            <div className="modal-head">
              <div>
                <h2>API 设置</h2>
                <p>支持 API Mart 图像与视频、Agnes AI、OpenAI 兼容图像接口，也可以接自己的 JSON API。</p>
              </div>
              <button type="button" onClick={() => setShowSettings(false)} title="关闭">
                <X size={18} />
              </button>
            </div>

            <div className="settings-grid">
              <label className="field">
                <span>模式</span>
                <select value={apiConfig.mode} onChange={(event) => updateApiConfig({ mode: event.target.value as ApiMode })}>
                  <option value="grsai">GA 全部生图模型</option>
                  <option value="change2pro">Change2Pro 生图模型</option>
                  <option value="agnes">Agnes AI 生图模型</option>
                  <option value="apimart">API Mart 图像 / 视频</option>
                  <option value="mock">本地模拟</option>
                  <option value="openai">OpenAI 兼容</option>
                  <option value="custom">自定义 JSON API</option>
                </select>
              </label>
              <div className="field">
                <span>模型</span>
                {apiConfig.mode === 'grsai' ? (
                  <select aria-label="模型" value={apiConfig.model} onChange={(event) => updateApiConfig({ model: event.target.value })}>
                    {grsAiModelGroups.map((group) => (
                      <optgroup key={group.label} label={group.label}>
                        {group.models.map((model) => (
                          <option key={grsAiModelSelectionValue(model)} value={grsAiModelSelectionValue(model)}>
                            {model.label}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                ) : apiConfig.mode === 'change2pro' ? (
                  <>
                    <div className="change2pro-family-picker" role="group" aria-label="选择模型 API">
                      <button
                        className={(apiConfig.change2ProFamily || change2ProFamilyFromModel(apiConfig.model)) === 'image2' ? 'active' : ''}
                        type="button"
                        aria-pressed={(apiConfig.change2ProFamily || change2ProFamilyFromModel(apiConfig.model)) === 'image2'}
                        onClick={() => switchChange2ProFamily('image2')}
                      >
                        <strong>Image 2</strong>
                        <small>独立 API</small>
                      </button>
                      <button
                        className={(apiConfig.change2ProFamily || change2ProFamilyFromModel(apiConfig.model)) === 'nanoBanana' ? 'active' : ''}
                        type="button"
                        aria-pressed={(apiConfig.change2ProFamily || change2ProFamilyFromModel(apiConfig.model)) === 'nanoBanana'}
                        onClick={() => switchChange2ProFamily('nanoBanana')}
                      >
                        <strong>Nano Banana</strong>
                        <small>独立 API</small>
                      </button>
                    </div>
                    <small className="change2pro-family-help">
                      切换模型系列时会自动载入对应的 Endpoint、API Key、模型与清晰度。
                    </small>
                    <div className="change2pro-model-picker">
                      <select
                        aria-label="Change2Pro 生图模型"
                        value={apiConfig.model}
                        onChange={(event) => updateApiConfig({ model: event.target.value })}
                        disabled={change2ProModelStatus === 'loading'}
                      >
                        {change2ProModels.length > 0 ? (
                          change2ProModels.map((model) => (
                            <option key={model.id} value={model.id}>{change2ProModelLabel(model.id)}</option>
                          ))
                        ) : (
                          <option value={apiConfig.model}>
                            {apiConfig.model ? change2ProModelLabel(apiConfig.model) : '填写 Key 后读取模型'}
                          </option>
                        )}
                      </select>
                      <button
                        type="button"
                        onClick={() => void loadChange2ProModels()}
                        disabled={!apiConfig.apiKey.trim() || change2ProModelStatus === 'loading'}
                      >
                        {change2ProModelStatus === 'loading' && <Loader2 size={13} />}
                        {change2ProModelStatus === 'loading' ? '读取中' : '读取模型'}
                      </button>
                    </div>
                    <small className={`change2pro-model-message ${change2ProModelStatus}`}>
                      {change2ProModelMessage || '填写该站 API Key 后自动读取当前分组的生图模型。'}
                    </small>
                    {change2ProSupportsImageSize(apiConfig.model) && (
                      <div className="change2pro-resolution-section">
                        <div className="change2pro-resolution-head">
                          <span>输出清晰度</span>
                          <small>与画布比例组合为实际像素</small>
                        </div>
                        <div className="change2pro-resolution-picker" role="group" aria-label="Change2Pro 输出清晰度">
                          {change2ProImageSizes.map((imageSize) => (
                            <button
                              className={apiConfig.imageSize === imageSize ? 'active' : ''}
                              type="button"
                              aria-pressed={apiConfig.imageSize === imageSize}
                              onClick={() => updateApiConfig({ imageSize })}
                              key={imageSize}
                            >
                              {imageSize}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </>
                ) : apiConfig.mode === 'agnes' ? (
                  <>
                    <div className="change2pro-model-picker">
                      <select
                        aria-label="Agnes AI 生图模型"
                        value={apiConfig.model}
                        onChange={(event) => updateApiConfig({ model: event.target.value })}
                        disabled={agnesModelStatus === 'loading'}
                      >
                        {agnesModels.map((model) => (
                          <option key={model.id} value={model.id}>{apiModelDisplayName(model.id)}</option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() => void loadAgnesModels()}
                        disabled={!apiConfig.apiKey.trim() || agnesModelStatus === 'loading'}
                      >
                        {agnesModelStatus === 'loading' && <Loader2 size={13} />}
                        {agnesModelStatus === 'loading' ? '读取中' : '读取模型'}
                      </button>
                    </div>
                    <small className={`change2pro-model-message ${agnesModelStatus}`}>
                      {agnesModelMessage || '官方生图模型：Agnes Image 2.1 Flash、Agnes Image 2.0 Flash。'}
                    </small>
                  </>
                ) : apiConfig.mode === 'apimart' ? (
                  <div className="apimart-model-stack">
                    <section className="apimart-model-section">
                      <strong>图像模型</strong>
                      <select
                        aria-label="API Mart 生图模型"
                        value={apiConfig.model}
                        onChange={(event) => {
                          const model = findApiMartModel(event.target.value)
                          updateApiConfig({ model: model.id, imageSize: model.defaultResolution })
                        }}
                      >
                        {apiMartModels.map((model) => (
                          <option key={model.id} value={model.id}>{model.label}</option>
                        ))}
                      </select>
                      <div className="change2pro-resolution-section">
                        <div className="change2pro-resolution-head">
                          <span>图像清晰度</span>
                          <small>按模型过滤</small>
                        </div>
                        <div className="change2pro-resolution-picker" role="group" aria-label="API Mart 图像输出清晰度">
                          {findApiMartModel(apiConfig.model).resolutions.map((imageSize) => (
                            <button
                              className={apiConfig.imageSize === imageSize ? 'active' : ''}
                              type="button"
                              aria-pressed={apiConfig.imageSize === imageSize}
                              onClick={() => updateApiConfig({ imageSize })}
                              key={imageSize}
                            >
                              {imageSize}
                            </button>
                          ))}
                        </div>
                      </div>
                    </section>
                    <section className="apimart-model-section">
                      <strong>视频模型</strong>
                      <select
                        aria-label="API Mart 视频模型"
                        value={apiConfig.videoModel}
                        onChange={(event) => {
                          const model = findApiMartVideoModel(event.target.value)
                          updateApiConfig({
                            videoModel: model.id,
                            videoResolution: model.defaultResolution,
                            videoDuration: model.defaultDuration,
                          })
                        }}
                      >
                        {apiMartVideoModels.map((model) => (
                          <option key={model.id} value={model.id}>{model.label}</option>
                        ))}
                      </select>
                      <div className="change2pro-resolution-section">
                        <div className="change2pro-resolution-head">
                          <span>视频清晰度</span>
                          <small>按模型过滤</small>
                        </div>
                        <div className="change2pro-resolution-picker" role="group" aria-label="API Mart 视频输出清晰度">
                          {findApiMartVideoModel(apiConfig.videoModel).resolutions.map((videoResolution) => (
                            <button
                              className={apiConfig.videoResolution === videoResolution ? 'active' : ''}
                              type="button"
                              aria-pressed={apiConfig.videoResolution === videoResolution}
                              onClick={() => updateApiConfig({ videoResolution })}
                              key={videoResolution}
                            >
                              {videoResolution}
                            </button>
                          ))}
                        </div>
                      </div>
                      <label className="apimart-duration-field">
                        <span>视频时长</span>
                        <input
                          type="number"
                          min={findApiMartVideoModel(apiConfig.videoModel).minDuration}
                          max={findApiMartVideoModel(apiConfig.videoModel).maxDuration}
                          step={1}
                          value={apiConfig.videoDuration}
                          onChange={(event) => updateApiConfig({ videoDuration: Number(event.target.value) })}
                        />
                        <small>秒 · {findApiMartVideoModel(apiConfig.videoModel).minDuration}–{findApiMartVideoModel(apiConfig.videoModel).maxDuration}</small>
                      </label>
                    </section>
                    <small className="change2pro-model-message success">
                      已接入 5 个图像模型和 3 个视频模型，任务会自动等待并读取最终结果。
                    </small>
                  </div>
                ) : (
                  <input aria-label="模型" value={apiConfig.model} onChange={(event) => updateApiConfig({ model: event.target.value })} />
                )}
              </div>
              <label className="field wide">
                <span>
                  Endpoint
                  {apiConfig.mode === 'change2pro' && ` · ${(apiConfig.change2ProFamily || change2ProFamilyFromModel(apiConfig.model)) === 'image2' ? 'Image 2' : 'Nano Banana'}`}
                </span>
                <input
                  value={apiConfig.endpoint}
                  onChange={(event) => updateApiConfig({ endpoint: event.target.value })}
                  placeholder="https://api.example.com/v1/images/generations"
                />
              </label>
              <label className="field wide">
                <span>
                  API Key
                  {apiConfig.mode === 'change2pro' && ` · ${(apiConfig.change2ProFamily || change2ProFamilyFromModel(apiConfig.model)) === 'image2' ? 'Image 2' : 'Nano Banana'}`}
                </span>
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
                模板支持 {'{prompt}'}、{'{model}'}、{'{size}'}、{'{referenceImageUrl}'}、{'{referenceImageBase64}'}、{'{maskImageUrl}'}、{'{maskImageBase64}'} 占位符。
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
