import {
  addEdge,
  applyEdgeChanges,
  Background,
  BaseEdge,
  Controls,
  getBezierPath,
  getViewportForBounds,
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
  AtSign,
  BookOpen,
  Box,
  Brush,
  Check,
  CheckCircle2,
  ChevronDown,
  Copy,
  Download,
  Eye,
  Expand,
  FolderOpen,
  Group as GroupIcon,
  History,
  Image as ImageIcon,
  KeyRound,
  Lightbulb,
  Loader2,
  Pencil,
  RefreshCw,
  Rotate3D,
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
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react'
import brandLogo from './assets/brand-logo.png'
import promptLibraryMarkdown from '../提示词.md?raw'
import SpecularButton from './SpecularButton'
import UnifiedRange from './UnifiedRange'
import './App.css'
import { generationPromptText, migrateLegacyPromptNodes } from './workflowPrompts'
import { canvasMediaClipboardType, createCanvasMediaClipboard, createDraggedMediaNodes, createPastedMediaNodes, mediaDataForCopy, parseCanvasMediaClipboard, serializeCanvasMediaClipboard, type CanvasMediaClipboard } from './canvasMediaClipboard'
import {
  defaultGrsAiModel,
  findGrsAiModel,
  grsAiDefaultEndpoint,
  grsAiModelGroups,
  grsAiModelSelectionValue,
  normalizeGrsAiEndpoint,
  normalizeGrsAiModel,
} from './grsaiModels'
import {
  deleteModel3DScene,
  readModel3DScene,
  readModel3DScenes,
  saveModel3DScene,
  saveModel3DScenes,
  type SavedModel3DScene,
} from './model3dSceneStore'
import { sketchGenerationInstruction, sketchSceneIds, type SketchDocument, type SketchModelOption } from './sketchDocument'
import type { ElementEditOperation, ElementEditResult } from './ElementEditStudio'
import type { MultiAngleResult } from './MultiAngleStudio'

const Model3DStudio = lazy(() => import('./Model3DStudio'))
const SketchStudio = lazy(() => import('./SketchStudio'))
const ElementEditStudio = lazy(() => import('./ElementEditStudio'))
const MultiAngleStudio = lazy(() => import('./MultiAngleStudio'))

type NodeKind = 'prompt' | 'image' | 'video' | 'reference' | 'video-reference' | 'repaint' | 'outpaint' | 'group'
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
type ApiMode = 'mock' | 'grsai' | 'change2pro' | 'apimart'

const apiModeOptions: Array<{ value: ApiMode; label: string }> = [
  { value: 'grsai', label: 'GA 全部生图模型' },
  { value: 'change2pro', label: 'Change2Pro 生图模型' },
  { value: 'apimart', label: 'API Mart 图像 / 视频' },
  { value: 'mock', label: '本地模拟' },
]
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
  maxReferenceImages: number
}

type ApiMartVideoModelOption = {
  id: string
  label: string
  resolutions: VideoResolutionTier[]
  defaultResolution: VideoResolutionTier
  minDuration: number
  maxDuration: number
  defaultDuration: number
  maxReferenceVideos: number
}

type GenerationRecord = {
  id: string
  prompt: string
  model: string
  size: string
  createdAt: string
  mediaType?: 'image' | 'video'
  imageUrl?: string
  videoUrl?: string
  status: '成功' | '失败'
}

type HistoryMediaPreview = Pick<GenerationRecord, 'prompt' | 'createdAt'> & {
  mediaType: 'image' | 'video'
  mediaUrl: string
}

type ImageInputSlot = {
  id: string
  index: number
  connected: boolean
}

type PromptMentionKind = 'image' | 'video'

type PromptMentionBinding = {
  token: string
  nodeId: string
  kind: PromptMentionKind
  label: string
}

type PromptMentionOption = PromptMentionBinding & {
  slotIndex: number
  previewUrl?: string
}

type LightDirection = {
  x: number
  y: number
  enabled: boolean
}

type WorkflowNodeData = {
  kind: NodeKind
  apiMode?: ApiMode
  generationPanelOpen?: boolean
  generationModelOptions?: Array<{ id: string; label: string }>
  imageResolutionOptions?: ImageResolutionTier[]
  onEnsureGenerationPanelVisible?: (id: string) => void
  title: string
  prompt?: string
  promptMentions?: PromptMentionBinding[]
  promptMentionOptions?: PromptMentionOption[]
  generationPrompt?: string
  imageUrl?: string
  videoUrl?: string
  videoDurationSeconds?: number
  sourceImageUrl?: string
  maskUrl?: string
  elementEditOperations?: ElementEditOperation[]
  elementEditRequestSize?: string
  multiAngleSettings?: MultiAngleResult
  brushSize?: number
  brushColor?: RepaintBrushColor
  sourceWidth?: number
  sourceHeight?: number
  outpaintInsets?: OutpaintInsets
  outpaintPreset?: OutpaintPreset
  status: NodeStatus
  model?: string
  imageSize?: ImageResolutionTier
  size?: string
  videoResolution?: VideoResolutionTier
  videoDuration?: number
  lightDirection?: LightDirection
  model3DSceneId?: string
  sketch?: SketchDocument
  sourceName?: string
  error?: string
  createdAt: string
  imageInputConnected?: boolean
  imageInputSlots?: ImageInputSlot[]
  videoInputConnected?: boolean
  videoInputSlots?: ImageInputSlot[]
  outputConnected?: boolean
  memberCount?: number
  onDelete?: (id: string) => void
  onDownload?: (id: string) => void
  onCopyResult?: (id: string) => void
  resultCopied?: boolean
  onRevealImage?: (id: string) => void
  onReplaceImage?: (id: string, file: File) => void
  onReplaceVideo?: (id: string, file: File) => void
  onGenerate?: (id: string) => void
  onChangeImageModel?: (id: string, model: string) => void
  onChangeImageSize?: (id: string, imageSize: ImageResolutionTier) => void
  onChangeVideoModel?: (id: string, model: string) => void
  onChangeSize?: (id: string, size: string) => void
  onChangeVideoResolution?: (id: string, resolution: VideoResolutionTier) => void
  onChangeVideoDuration?: (id: string, duration: number) => void
  onChangeLightDirection?: (id: string, direction: LightDirection) => void
  onOpenLightDirection?: (id: string) => void
  onEditModel3D?: (id: string) => void
  onEditSketch?: (id: string) => void
  onOpenElementEdit?: (id: string) => void
  onOpenMultiAngle?: (id: string) => void
  onChangePrompt?: (id: string, prompt: string, mentions?: PromptMentionBinding[]) => void
  onLocatePromptMention?: (nodeId: string) => void
  onChangeOutpaintInsets?: (id: string, insets: OutpaintInsets) => void
  onApplyOutpaintPreset?: (id: string, preset: OutpaintPreset) => void
  onResetOutpaintPrompt?: (id: string) => void
  onUsePrompt?: (prompt: string) => void
  onRenameGroup?: (id: string) => void
}

type WorkflowNode = Node<WorkflowNodeData, 'workflow'>
type AltMediaDragState = {
  anchorNodeId: string
  anchorStart: XYPosition
  clipboard: CanvasMediaClipboard
  sourcePositions: Map<string, XYPosition>
}

let activeAltMediaDrag: AltMediaDragState | null = null

type WorkflowEdgeData = Record<string, unknown> & {
  onDisconnect?: (edgeId: string) => void
}
type WorkflowEdge = Edge<WorkflowEdgeData, 'disconnectible'>

const imageInputHandlePrefix = 'image-'
const videoInputHandlePrefix = 'video-'

function imageInputHandleIndex(handleId?: string | null) {
  if (handleId === 'image') return 1
  if (!handleId?.startsWith(imageInputHandlePrefix)) return null
  const index = Number(handleId.slice(imageInputHandlePrefix.length))
  return Number.isInteger(index) && index > 0 ? index : null
}

function isImageInputHandle(handleId?: string | null) {
  return imageInputHandleIndex(handleId) !== null
}

function videoInputHandleIndex(handleId?: string | null) {
  if (!handleId?.startsWith(videoInputHandlePrefix)) return null
  const index = Number(handleId.slice(videoInputHandlePrefix.length))
  return Number.isInteger(index) && index > 0 ? index : null
}

function isVideoInputHandle(handleId?: string | null) {
  return videoInputHandleIndex(handleId) !== null
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

  const videoTargetIds = nodeValues.filter((node) => node.data.kind === 'video').map((node) => node.id)

  for (const targetId of videoTargetIds) {
    const videoEdges = normalizedEdges
      .map((edge, position) => ({ edge, position, handleIndex: videoInputHandleIndex(edge.targetHandle) }))
      .filter(
        ({ edge, handleIndex }) =>
          edge.target === targetId &&
          (handleIndex !== null || (!edge.targetHandle && sourceKindById.get(edge.source) === 'video-reference')),
      )
      .sort((left, right) => {
        if (left.handleIndex !== null && right.handleIndex !== null && left.handleIndex !== right.handleIndex) {
          return left.handleIndex - right.handleIndex
        }
        if (left.handleIndex !== null && right.handleIndex === null) return -1
        if (left.handleIndex === null && right.handleIndex !== null) return 1
        return left.position - right.position
      })

    videoEdges.forEach(({ edge, position }, index) => {
      const targetHandle = `${videoInputHandlePrefix}${index + 1}`
      if (edge.targetHandle === targetHandle) return
      normalizedEdges[position] = { ...edge, targetHandle }
      changed = true
    })
  }

  return changed ? normalizedEdges : edgeValues
}

function promptMentionOptionsForNode(generationNodeId: string, nodeValues: WorkflowNode[], edgeValues: Edge[]) {
  const nodeById = new Map(nodeValues.map((node) => [node.id, node]))
  const targetGenerationNodes = nodeValues.filter((node) =>
    node.id === generationNodeId && (node.data.kind === 'image' || node.data.kind === 'video'),
  )
  const options: PromptMentionOption[] = []
  const seenNodeIds = new Set<string>()

  for (const targetNode of targetGenerationNodes) {
    const incoming = edgeValues
      .map((edge, edgeOrder) => ({ edge, edgeOrder, sourceNode: nodeById.get(edge.source) }))
      .filter((item): item is { edge: Edge; edgeOrder: number; sourceNode: WorkflowNode } => (
        item.edge.target === targetNode.id && Boolean(item.sourceNode)
      ))
    const imageSources = incoming
      .filter(({ edge, sourceNode }) => (
        Boolean(sourceNode.data.imageUrl) &&
        (isImageInputHandle(edge.targetHandle) || (!edge.targetHandle && sourceNode.data.kind !== 'prompt'))
      ))
      .sort((left, right) => {
        const leftIndex = imageInputHandleIndex(left.edge.targetHandle)
        const rightIndex = imageInputHandleIndex(right.edge.targetHandle)
        if (leftIndex !== null && rightIndex !== null && leftIndex !== rightIndex) return leftIndex - rightIndex
        if (leftIndex !== null && rightIndex === null) return -1
        if (leftIndex === null && rightIndex !== null) return 1
        return left.edgeOrder - right.edgeOrder
      })
    const videoSources = incoming
      .filter(({ edge, sourceNode }) => (
        targetNode.data.kind === 'video' &&
        Boolean(sourceNode.data.videoUrl) &&
        (isVideoInputHandle(edge.targetHandle) || sourceNode.data.kind === 'video-reference')
      ))
      .sort((left, right) => {
        const leftIndex = videoInputHandleIndex(left.edge.targetHandle)
        const rightIndex = videoInputHandleIndex(right.edge.targetHandle)
        if (leftIndex !== null && rightIndex !== null && leftIndex !== rightIndex) return leftIndex - rightIndex
        if (leftIndex !== null && rightIndex === null) return -1
        if (leftIndex === null && rightIndex !== null) return 1
        return left.edgeOrder - right.edgeOrder
      })

    imageSources.forEach(({ sourceNode }, index) => {
      if (seenNodeIds.has(sourceNode.id)) return
      seenNodeIds.add(sourceNode.id)
      options.push({
        token: `@Image${index + 1}`,
        nodeId: sourceNode.id,
        kind: 'image',
        label: sourceNode.data.sourceName || sourceNode.data.title,
        slotIndex: index + 1,
        previewUrl: sourceNode.data.imageUrl,
      })
    })
    videoSources.forEach(({ sourceNode }, index) => {
      if (seenNodeIds.has(sourceNode.id)) return
      seenNodeIds.add(sourceNode.id)
      options.push({
        token: `@Video${index + 1}`,
        nodeId: sourceNode.id,
        kind: 'video',
        label: sourceNode.data.sourceName || sourceNode.data.title,
        slotIndex: index + 1,
        previewUrl: sourceNode.data.videoUrl,
      })
    })
  }

  return options
}

function promptWithReferenceImageOrder(prompt: string, referenceImageCount: number) {
  if (referenceImageCount <= 1) return prompt
  const labels = Array.from({ length: referenceImageCount }, (_, index) => `Image ${index + 1}`).join('、')
  return `${prompt}\n\n参考图顺序说明：参考图已按画布端口编号依次传入（${labels}）。请严格按该编号理解图片；提示词提到 Image N 时，对应同名编号的参考图。`
}

function promptWithReferenceVideoOrder(prompt: string, referenceVideoCount: number) {
  if (!referenceVideoCount) return prompt
  const labels = Array.from({ length: referenceVideoCount }, (_, index) => `Video ${index + 1}`).join('、')
  return `${prompt}\n\n参考视频顺序说明：参考视频已按画布端口编号依次传入（${labels}）。提示词提到 Video N 时，对应同名编号的参考视频。`
}

function promptContainsMentionToken(prompt: string, token: string) {
  let searchFrom = 0
  while (searchFrom < prompt.length) {
    const index = prompt.indexOf(token, searchFrom)
    if (index < 0) return false
    const nextCharacter = prompt[index + token.length]
    if (!nextCharacter || !/[A-Za-z0-9_]/.test(nextCharacter)) return true
    searchFrom = index + token.length
  }
  return false
}

function activePromptMentions(prompt: string, mentions: PromptMentionBinding[] = []) {
  return mentions.filter((mention) => promptContainsMentionToken(prompt, mention.token))
}

function compilePromptMentions(
  prompt: string,
  mentions: PromptMentionBinding[] = [],
  referenceImageNodeIds: string[],
  referenceVideoNodeIds: string[],
) {
  const imageIndexByNodeId = new Map(referenceImageNodeIds.map((nodeId, index) => [nodeId, index + 1]))
  const videoIndexByNodeId = new Map(referenceVideoNodeIds.map((nodeId, index) => [nodeId, index + 1]))
  const activeMentions = activePromptMentions(prompt, mentions)
  const missingMentions = activeMentions.filter((mention) => (
    mention.kind === 'image'
      ? !imageIndexByNodeId.has(mention.nodeId)
      : !videoIndexByNodeId.has(mention.nodeId)
  ))

  if (missingMentions.length) {
    throw new Error(`提示词中的 ${missingMentions.map((mention) => mention.token).join('、')} 对应素材未连接到当前生成框。`)
  }

  let compiled = prompt
  for (const mention of [...activeMentions].sort((left, right) => right.token.length - left.token.length)) {
    const index = mention.kind === 'image'
      ? imageIndexByNodeId.get(mention.nodeId)
      : videoIndexByNodeId.get(mention.nodeId)
    if (!index) continue
    compiled = compiled.split(mention.token).join(`${mention.kind === 'image' ? 'Image' : 'Video'} ${index}`)
  }

  compiled = compiled.replace(/@Image(\d+)\b/g, (token, rawIndex: string) => {
    const index = Number(rawIndex)
    if (!referenceImageNodeIds[index - 1]) throw new Error(`提示词中的 ${token} 没有对应的已连接参考图。`)
    return `Image ${index}`
  })
  compiled = compiled.replace(/@Video(\d+)\b/g, (token, rawIndex: string) => {
    const index = Number(rawIndex)
    if (!referenceVideoNodeIds[index - 1]) throw new Error(`提示词中的 ${token} 没有对应的已连接参考视频。`)
    return `Video ${index}`
  })

  return compiled
}

const defaultLightDirection: LightDirection = {
  x: -Math.SQRT1_2,
  y: -Math.SQRT1_2,
  enabled: false,
}

const lightDirectionLabels = ['正上方', '右上方', '右侧', '右下方', '正下方', '左下方', '左侧', '左上方'] as const

function normalizeLightDirection(value?: Partial<LightDirection>): LightDirection {
  const rawX = Number(value?.x)
  const rawY = Number(value?.y)
  let x = Number.isFinite(rawX) ? rawX : defaultLightDirection.x
  let y = Number.isFinite(rawY) ? rawY : defaultLightDirection.y
  const magnitude = Math.hypot(x, y)
  if (magnitude > 1) {
    x /= magnitude
    y /= magnitude
  }
  return {
    x: Math.round(x * 1000) / 1000,
    y: Math.round(y * 1000) / 1000,
    enabled: Boolean(value?.enabled),
  }
}

function lightDirectionMetadata(value?: Partial<LightDirection>) {
  const direction = normalizeLightDirection(value)
  const magnitude = Math.hypot(direction.x, direction.y)
  if (magnitude < 0.12) {
    return {
      direction,
      label: '正前方',
      oppositeLabel: '产品后方',
      angle: 0,
    }
  }
  const angle = (Math.atan2(direction.x, -direction.y) * 180 / Math.PI + 360) % 360
  const index = Math.round(angle / 45) % lightDirectionLabels.length
  return {
    direction,
    label: lightDirectionLabels[index],
    oppositeLabel: lightDirectionLabels[(index + 4) % lightDirectionLabels.length],
    angle: Math.round(angle),
  }
}

function promptWithLightDirection(prompt: string, value?: Partial<LightDirection>) {
  const metadata = lightDirectionMetadata(value)
  if (!metadata.direction.enabled) return prompt
  if (metadata.label === '正前方') {
    return `${prompt}\n\n灯光方向控制：主光源位于镜头正前方，正面照射产品。重新塑造正面高光与材质反射，暗部向产品后方自然过渡。保持产品外形、包装结构、品牌标识、文字内容、原始色彩、比例、摆放状态、角度与构图不变，仅调整光影。`
  }
  return `${prompt}\n\n灯光方向控制：主光源从画面${metadata.label}照向产品，高光重点落在产品${metadata.label}一侧，暗部和阴影向画面${metadata.oppositeLabel}自然过渡。重新塑造真实、干净、可控的材质高光与反射。保持产品外形、包装结构、品牌标识、文字内容、原始色彩、比例、摆放状态、角度与构图不变，仅调整光影。`
}

type ProjectFile = {
  version: 1 | 2 | 3
  projectName: string
  nodes: WorkflowNode[]
  edges: Edge[]
  history: GenerationRecord[]
  model3DScenes?: Record<string, SavedModel3DScene>
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
const removedApiModes = ['agnes', 'openai', 'custom', 'volcengine'] as const
const workflowEdgeColor = 'rgba(255, 255, 255, 0.88)'

const defaultApiConfig: ApiConfig = {
  mode: 'mock',
  endpoint: '',
  apiKey: '',
  model: 'local-simulated',
  imageSize: '1K',
  videoModel: 'seedance-2.5',
  videoResolution: '720p',
  videoDuration: 5,
  size: '1024x1024',
}

const grsAiApiConfig: Partial<ApiConfig> = {
  mode: 'grsai',
  endpoint: grsAiDefaultEndpoint,
  model: defaultGrsAiModel,
}

const change2ProApiConfig: Partial<ApiConfig> = {
  mode: 'change2pro',
  endpoint: 'https://api.change2pro.com/v1/images/generations',
  model: 'gpt-image-2',
  imageSize: '1K',
  change2ProFamily: 'image2',
}

const apiMartApiConfig: Partial<ApiConfig> = {
  mode: 'apimart',
  endpoint: 'https://api.apimart.ai/v1/images/generations',
  model: 'gemini-3-pro-image-preview',
  imageSize: '1K',
  videoModel: 'seedance-2.5',
  videoResolution: '720p',
  videoDuration: 5,
}

const apiMartModels: ApiMartModelOption[] = [
  {
    id: 'gemini-3-pro-image-preview',
    label: 'Nano Banana Pro',
    resolutions: ['1K', '2K', '4K'],
    defaultResolution: '1K',
    maxReferenceImages: 14,
  },
  {
    id: 'gemini-3.1-flash-image-preview',
    label: 'Nano Banana 2',
    resolutions: ['1K', '2K', '4K'],
    defaultResolution: '1K',
    maxReferenceImages: 14,
  },
  {
    id: 'gpt-image-2',
    label: 'GPT Image 2',
    resolutions: ['1K', '2K', '4K'],
    defaultResolution: '1K',
    maxReferenceImages: 16,
  },
  {
    id: 'gpt-image-2.5-flare',
    label: 'GPT Image 2.5 Flare',
    resolutions: ['1K', '2K', '4K'],
    defaultResolution: '1K',
    maxReferenceImages: 16,
  },
  {
    id: 'gpt-image-2.5-sunburst',
    label: 'GPT Image 2.5 Sunburst',
    resolutions: ['1K', '2K', '4K'],
    defaultResolution: '1K',
    maxReferenceImages: 16,
  },
  {
    id: 'seedream-5-0-pro',
    label: 'Seedream 5.0 Pro',
    resolutions: ['1K', '1.5K', '2K'],
    defaultResolution: '1K',
    maxReferenceImages: 10,
  },
  {
    id: 'seedream-5-0-lite',
    label: 'Seedream 5.0 Lite',
    resolutions: ['2K', '3K', '4K'],
    defaultResolution: '2K',
    maxReferenceImages: 14,
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
    maxReferenceVideos: 10,
  },
  {
    id: 'seedance-2.0',
    label: 'Seedance 2.0',
    resolutions: ['480p', '720p', '1080p', '4k'],
    defaultResolution: '720p',
    minDuration: 4,
    maxDuration: 15,
    defaultDuration: 5,
    maxReferenceVideos: 3,
  },
  {
    id: 'MiniMax-H3',
    label: 'MiniMax H3',
    resolutions: ['768P', '2K'],
    defaultResolution: '2K',
    minDuration: 4,
    maxDuration: 15,
    defaultDuration: 5,
    maxReferenceVideos: 0,
  },
]

function findApiMartModel(model: string) {
  return apiMartModels.find((option) => option.id === model) ?? apiMartModels[0]
}

function findApiMartVideoModel(model?: string) {
  return apiMartVideoModels.find((option) => option.id === model) ?? apiMartVideoModels[0]
}

function apiModelDisplayName(model: string) {
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

function sanitizeStoredApiValue(key: string) {
  const saved = window.localStorage.getItem(key)
  if (!saved) return
  try {
    const { bodyTemplate: _bodyTemplate, responsePath: _responsePath, ...config } = JSON.parse(saved) as Record<string, unknown>
    void _bodyTemplate
    void _responsePath
    window.localStorage.setItem(key, JSON.stringify(config))
  } catch {
    window.localStorage.removeItem(key)
  }
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
    if (mode === 'mock') {
      window.localStorage.removeItem(apiProfileStorageKey(mode))
      return null
    }
    const saved = window.localStorage.getItem(apiProfileStorageKey(mode))
    if (!saved) return null
    const { bodyTemplate: _bodyTemplate, responsePath: _responsePath, ...profile } = JSON.parse(saved) as Record<string, unknown>
    void _bodyTemplate
    void _responsePath
    return profile as Partial<ApiConfig>
  } catch {
    return null
  }
}

function apiModePreset(mode: ApiMode): Partial<ApiConfig> {
  if (mode === 'grsai') return grsAiApiConfig
  if (mode === 'change2pro') return change2ProApiConfig
  if (mode === 'apimart') return apiMartApiConfig
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

const productRetouchPrompt = `提取原图中的美妆产品，对产品进行商业广告级精修与重新打光。保持产品外形、包装结构、品牌标识、文字内容、原始色彩不变，不改变产品比例、摆放状态和角度。

清除灰尘、指纹、划痕、污渍、毛边、褶皱、包装瑕疵及不必要的杂物，使产品呈现如全新无瑕的状态。校正透视、边缘与轮廓，保证包装细节清晰、自然、精致。

重建专业建模级棚拍光影：重新塑造产品的高光、反射、过渡光与暗部层次，使打光干净、均匀、精确，提高设备的材质的质感和光泽。增强玻璃、金属、塑料、磨砂、陶瓷、纸盒或膏体等材质的真实质感、光泽与细节，高光细腻不过曝，反射真实可控，暗部干净有层次；避免过度锐化、塑料感、失真反光或不真实材质。

将背景更换为纯净高级的纯白色背景，画面简洁、明亮、无杂色、无多余环境元素。若原图产品为浮空展示、悬浮构图或白底电商主图，保持产品浮空或原有状态，不添加地面、台面、投影、倒影或接触阴影；若原图明确为产品放置于地面或台面上，则保留并优化自然、克制的接触阴影与投影，体现稳定落地感。`

const relightGenerationPrompt =
  '以参考图为唯一视觉基础，仅重新调整产品与场景的灯光、高光、反射和明暗层次。严格保持原图中的产品外形、包装结构、品牌标识、文字内容、真实颜色、比例、摆放角度、背景内容与画面构图不变，不添加或删除任何物体。光影自然、干净、可控，高光不过曝，暗部保留材质细节。'

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
  const fallbackHeight = node.data.kind === 'outpaint' ? 780 : node.data.kind === 'repaint' ? 620 : node.data.kind === 'image' || node.data.kind === 'video' ? 680 : node.data.kind === 'reference' ? 360 : 250
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

function findFreeWorkflowNodePosition(
  preferred: XYPosition,
  size: { width: number; height: number },
  nodeValues: WorkflowNode[],
) {
  const gap = 38
  const horizontalStep = size.width + 76
  const verticalStep = size.height + 76
  const verticalOffsets = [0, 1, -1, 2, -2]

  for (let column = 0; column < 6; column += 1) {
    for (const row of verticalOffsets) {
      const candidate = {
        x: preferred.x + column * horizontalStep,
        y: preferred.y + row * verticalStep,
      }
      const overlaps = nodeValues.some((node) => {
        const nodePosition = getAbsoluteNodePosition(node, nodeValues)
        const nodeSize = getWorkflowNodeSize(node)
        return (
          candidate.x < nodePosition.x + nodeSize.width + gap &&
          candidate.x + size.width + gap > nodePosition.x &&
          candidate.y < nodePosition.y + nodeSize.height + gap &&
          candidate.y + size.height + gap > nodePosition.y
        )
      })
      if (!overlaps) return candidate
    }
  }

  return { x: preferred.x + horizontalStep * 6, y: preferred.y }
}

function readStoredApiConfig() {
  try {
    removedApiModes.forEach((mode) => window.localStorage.removeItem(`${API_PROFILE_STORAGE_KEY_PREFIX}${mode}`))
    window.localStorage.removeItem(apiProfileStorageKey('mock'))
    ;(['grsai', 'change2pro', 'apimart'] satisfies ApiMode[]).forEach((mode) => {
      sanitizeStoredApiValue(apiProfileStorageKey(mode))
    })
    ;(['image2', 'nanoBanana'] satisfies Change2ProApiFamily[]).forEach((family) => {
      sanitizeStoredApiValue(change2ProFamilyProfileKey(family))
    })
    const saved = window.localStorage.getItem(API_STORAGE_KEY)
    if (!saved) return defaultApiConfig
    const parsed = JSON.parse(saved) as Record<string, unknown>
    if (removedApiModes.includes(String(parsed.mode) as (typeof removedApiModes)[number])) {
      window.localStorage.removeItem(API_STORAGE_KEY)
      return defaultApiConfig
    }
    const { bodyTemplate: _bodyTemplate, responsePath: _responsePath, ...storedConfig } = parsed
    void _bodyTemplate
    void _responsePath
    const config = { ...defaultApiConfig, ...storedConfig } as ApiConfig
    if (config.mode === 'mock') {
      window.localStorage.setItem(API_STORAGE_KEY, JSON.stringify(defaultApiConfig))
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
    window.localStorage.setItem(API_STORAGE_KEY, JSON.stringify(config))
    return config
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
    onReplaceVideo,
    onGenerate,
    onChangeSize,
    onChangeImageModel,
    onChangeImageSize,
    onChangeVideoModel,
    onChangeVideoResolution,
    onChangeVideoDuration,
    onChangeLightDirection,
    onOpenLightDirection,
    onEditModel3D,
    onEditSketch,
    onOpenElementEdit,
    onOpenMultiAngle,
    onChangePrompt,
    onLocatePromptMention,
    onChangeOutpaintInsets,
    onApplyOutpaintPreset,
    onResetOutpaintPrompt,
    onUsePrompt,
    onRenameGroup,
    apiMode,
    memberCount,
    promptMentionOptions,
    ...data
  } = node.data
  void onDelete
  void onDownload
  void onRevealImage
  void onReplaceImage
  void onReplaceVideo
  void onGenerate
  void onChangeSize
  void onChangeImageModel
  void onChangeImageSize
  void onChangeVideoModel
  void onChangeVideoResolution
  void onChangeVideoDuration
  void onChangeLightDirection
  void onOpenLightDirection
  void onEditModel3D
  void onEditSketch
  void onOpenElementEdit
  void onOpenMultiAngle
  void onChangePrompt
  void onLocatePromptMention
  void onChangeOutpaintInsets
  void onApplyOutpaintPreset
  void onResetOutpaintPrompt
  void onUsePrompt
  void onRenameGroup
  void apiMode
  void memberCount
  void promptMentionOptions
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

  const migrated = migrateLegacyPromptNodes((project.nodes as WorkflowNode[]).map(cleanNode), (project.edges as Edge[]).map(cleanEdge))

  return {
    version: project.version === 3 ? 3 : project.version === 2 ? 2 : 1,
    projectName: project.projectName || '导入项目',
    nodes: migrated.nodes,
    edges: normalizeImageInputEdges(migrated.edges, migrated.nodes),
    history: Array.isArray(project.history) ? project.history : [],
    model3DScenes: project.model3DScenes && typeof project.model3DScenes === 'object'
      ? project.model3DScenes
      : {},
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

async function addVideoToProjectPackage(sessionId: string, videoUrl: string, fileName: string | undefined, index: number) {
  const payload = await readPackageResponse(
    await fetch('/api/projects/package/add-video', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, videoUrl, fileName, index }),
    }),
  )
  if (!payload?.relativePath) throw new Error('视频写入项目包失败')
  return payload.relativePath
}

async function addModelToProjectPackage(
  sessionId: string,
  sourceUrl: string,
  fileName: string,
  index: number,
) {
  const payload = await readPackageResponse(
    await fetch('/api/projects/package/add-model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, sourceUrl, fileName, index }),
    }),
  )
  if (!payload?.relativePath) throw new Error('3D 模型写入项目包失败')
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
  const videoCache = new Map<string, string>()
  let imageIndex = 0
  let videoIndex = 0

  async function cacheImage(imageUrl?: string) {
    if (!imageUrl) return imageUrl
    if (imageCache.has(imageUrl)) return imageCache.get(imageUrl)
    imageIndex += 1
    const relativePath = await addImageToProjectPackage(sessionId, imageUrl, imageIndex)
    imageCache.set(imageUrl, relativePath)
    return relativePath
  }

  async function cacheVideo(videoUrl?: string, fileName?: string) {
    if (!videoUrl) return videoUrl
    if (videoCache.has(videoUrl)) return videoCache.get(videoUrl)
    videoIndex += 1
    const relativePath = await addVideoToProjectPackage(sessionId, videoUrl, fileName, videoIndex)
    videoCache.set(videoUrl, relativePath)
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
        videoUrl: await cacheVideo(clean.data.videoUrl, clean.data.sourceName),
        sourceImageUrl: await cacheImage(clean.data.sourceImageUrl),
        maskUrl: await cacheImage(clean.data.maskUrl),
        sketch: clean.data.sketch ? {
          ...clean.data.sketch,
          layers: await Promise.all(clean.data.sketch.layers.map(async (layer) => ({ ...layer, imageUrl: await cacheImage(layer.imageUrl) }))),
        } : undefined,
      },
    })
  }

  const historyWithMedia: GenerationRecord[] = []
  for (const item of history) {
    const sourceNode = nodes.find((node) => node.id === item.id)
    const nodeImageUrl = sourceNode?.data.imageUrl
    const nodeVideoUrl = sourceNode?.data.videoUrl
    const isVideoHistory = item.mediaType === 'video' || Boolean(item.videoUrl)
    historyWithMedia.push({
      ...item,
      imageUrl: await cacheImage(item.imageUrl || (!isVideoHistory && item.status === '成功' ? nodeImageUrl : undefined)),
      videoUrl: await cacheVideo(item.videoUrl || (isVideoHistory && item.status === '成功' ? nodeVideoUrl : undefined)),
    })
  }

  const sceneIds = cleanNodes
    .flatMap((node) => [node.data.model3DSceneId, ...sketchSceneIds(node.data.sketch)])
    .filter((sceneId): sceneId is string => Boolean(sceneId))
  const storedScenes = await readModel3DScenes(sceneIds)
  const missingSceneIds = [...new Set(sceneIds)].filter((sceneId) => !storedScenes[sceneId])
  if (missingSceneIds.length) {
    throw new Error('部分 3D 参考图缺少可编辑场景，请先点击参考图确认场景仍可打开。')
  }
  const modelAssetCache = new Map<string, string>()
  let modelIndex = 0
  const model3DScenes: Record<string, SavedModel3DScene> = {}

  for (const [sceneId, scene] of Object.entries(storedScenes)) {
    const items = [] as SavedModel3DScene['items']
    for (const item of scene.items) {
      if (item.kind !== 'imported-model' || !item.source?.url) {
        items.push(item)
        continue
      }
      const cacheKey = `${item.source.fileName}\n${item.source.url}`
      let packagedUrl = modelAssetCache.get(cacheKey)
      if (!packagedUrl) {
        modelIndex += 1
        packagedUrl = await addModelToProjectPackage(
          sessionId,
          item.source.url,
          item.source.fileName,
          modelIndex,
        )
        modelAssetCache.set(cacheKey, packagedUrl)
      }
      items.push({
        ...item,
        source: { ...item.source, url: packagedUrl },
      })
    }
    model3DScenes[sceneId] = { ...scene, items }
  }

  return {
    version: 3,
    projectName,
    nodes: cleanNodes,
    edges: edges.map(cleanEdge),
    history: historyWithMedia,
    model3DScenes,
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

async function downloadMediaFile(mediaUrl: string, filename: string) {
  const response = await fetch('/api/media/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mediaUrl }),
  })
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null
    throw new Error(payload?.error || '视频下载失败')
  }
  const downloadUrl = URL.createObjectURL(await response.blob())
  downloadImage(downloadUrl, filename)
  window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000)
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
  const exactOption = aspectRatioOptions.find((option) => option.size === size)
  if (exactOption) return exactOption
  const { width, height } = parseImageSize(size)
  return nearestAspectRatioOption(width, height)
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

function imageFromResponse(source: unknown) {
  const fallbackUrl = getValueByPath(source, 'data.0.url')
  const fallbackBase64 = getValueByPath(source, 'data.0.b64_json')
  const value = fallbackUrl ?? fallbackBase64

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

  return imageFromResponse(json)
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

async function requestGeneratedVideo(
  prompt: string,
  config: ApiConfig,
  referenceImageUrls: string[] = [],
  referenceVideoUrls: string[] = [],
) {
  const response = await fetch('/api/videos/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, config, referenceImageUrls, referenceVideoUrls }),
  })

  const json = await response.json().catch(() => null)
  if (!response.ok) {
    const message = typeof json?.error === 'string' ? json.error : `请求失败：${response.status} ${response.statusText}`
    throw new Error(message)
  }

  return videoFromResponse(json)
}

async function cacheReferenceVideoFile(file: File) {
  const response = await fetch('/api/videos/cache', {
    method: 'POST',
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      'X-File-Name': encodeURIComponent(file.name || 'reference-video.mp4'),
    },
    body: file,
  })
  const payload = (await response.json().catch(() => null)) as { videoUrl?: string; error?: string } | null
  if (!response.ok || !payload?.videoUrl) throw new Error(payload?.error || '参考视频上传失败')
  return payload.videoUrl
}

async function readVideoMetadata(file: File) {
  const objectUrl = URL.createObjectURL(file)
  try {
    return await new Promise<{ duration: number; width: number; height: number }>((resolve, reject) => {
      const video = document.createElement('video')
      video.preload = 'metadata'
      video.onloadedmetadata = () => resolve({
        duration: Number.isFinite(video.duration) ? video.duration : 0,
        width: video.videoWidth,
        height: video.videoHeight,
      })
      video.onerror = () => reject(new Error('无法读取参考视频，请确认文件未损坏。'))
      video.src = objectUrl
    })
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

async function validateReferenceVideoFile(file: File) {
  const extension = file.name.split('.').pop()?.toLowerCase()
  const acceptedType = file.type === 'video/mp4' || file.type === 'video/quicktime'
  if (!acceptedType && extension !== 'mp4' && extension !== 'mov') {
    throw new Error('参考视频仅支持 MP4 或 MOV 格式。')
  }
  if (!file.size) throw new Error('参考视频内容为空，请重新选择。')
  if (file.size > 100 * 1024 * 1024) throw new Error('单个参考视频不能超过 100 MB。')
  const metadata = await readVideoMetadata(file)
  if (!metadata.duration) throw new Error('无法读取参考视频时长，请重新选择。')
  if (metadata.duration > 30.05) throw new Error('单个参考视频不能超过 30 秒。')
  return metadata
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

function imageFileAsDataUrl(file: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('无法读取剪贴板图片'))
    reader.readAsDataURL(file)
  })
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

async function fitImageToExactSize(imageUrl: string, width: number, height: number) {
  const safeWidth = Math.max(1, Math.round(width))
  const safeHeight = Math.max(1, Math.round(height))
  const image = await loadCanvasImage(await imageAsDataUrl(imageUrl))
  if (image.naturalWidth === safeWidth && image.naturalHeight === safeHeight) return imageUrl

  const canvas = document.createElement('canvas')
  canvas.width = safeWidth
  canvas.height = safeHeight
  const context = canvas.getContext('2d')
  if (!context) throw new Error('浏览器无法恢复原图尺寸。')
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(image, 0, 0, safeWidth, safeHeight)
  return cacheCanvasImage(canvas.toDataURL('image/png'))
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

function LightDirectionControl({
  value,
  disabled,
  onChange,
}: {
  value?: LightDirection
  disabled: boolean
  onChange: (direction: LightDirection) => void
}) {
  const orbitRef = useRef<HTMLDivElement>(null)
  const activePointerIdRef = useRef<number | null>(null)
  const metadata = lightDirectionMetadata(value)
  const direction = metadata.direction
  const magnitude = Math.hypot(direction.x, direction.y)
  const lampRadius = 40
  const rayAngle = Math.atan2(direction.y, direction.x) * 180 / Math.PI

  const updateFromPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const orbit = orbitRef.current
    if (!orbit || disabled) return
    const rect = orbit.getBoundingClientRect()
    const radius = Math.max(1, Math.min(rect.width, rect.height) / 2 - 17)
    let x = (event.clientX - (rect.left + rect.width / 2)) / radius
    let y = (event.clientY - (rect.top + rect.height / 2)) / radius
    const distance = Math.hypot(x, y)
    if (distance > 1) {
      x /= distance
      y /= distance
    }
    onChange(normalizeLightDirection({ x, y, enabled: true }))
  }

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled) return
    event.preventDefault()
    event.stopPropagation()
    activePointerIdRef.current = event.pointerId
    event.currentTarget.setPointerCapture(event.pointerId)
    updateFromPointer(event)
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (activePointerIdRef.current !== event.pointerId) return
    event.preventDefault()
    event.stopPropagation()
    updateFromPointer(event)
  }

  const stopDragging = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (activePointerIdRef.current !== event.pointerId) return
    activePointerIdRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const moveWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (disabled) return
    const step = event.shiftKey ? 0.2 : 0.08
    let nextX = direction.x
    let nextY = direction.y
    if (event.key === 'ArrowLeft') nextX -= step
    else if (event.key === 'ArrowRight') nextX += step
    else if (event.key === 'ArrowUp') nextY -= step
    else if (event.key === 'ArrowDown') nextY += step
    else if (event.key === 'Home') {
      nextX = defaultLightDirection.x
      nextY = defaultLightDirection.y
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onChange({ ...direction, enabled: !direction.enabled })
      return
    } else return
    event.preventDefault()
    event.stopPropagation()
    onChange(normalizeLightDirection({ x: nextX, y: nextY, enabled: true }))
  }

  return (
    <section className={`light-direction-control nodrag nopan nowheel ${direction.enabled ? 'enabled' : ''}`} aria-label="产品灯光方向">
      <div className="light-direction-head">
        <button
          className="light-direction-toggle"
          type="button"
          aria-pressed={direction.enabled}
          disabled={disabled}
          onClick={() => onChange({ ...direction, enabled: !direction.enabled })}
        >
          <Lightbulb size={14} />
          <span>{direction.enabled ? '灯光已开启' : '开启灯光'}</span>
        </button>
        <button
          className="light-direction-reset"
          type="button"
          title="恢复左上方默认灯光"
          aria-label="恢复左上方默认灯光"
          disabled={disabled}
          onClick={() => onChange({ ...defaultLightDirection, enabled: direction.enabled })}
        >
          <RefreshCw size={13} />
          重置
        </button>
      </div>
      <div className="light-direction-body">
        <div
          ref={orbitRef}
          className="light-direction-orbit"
          role="application"
          tabIndex={disabled ? -1 : 0}
          aria-disabled={disabled}
          aria-label={`拖动灯光方向，当前${metadata.label}${metadata.label === '正前方' ? '' : `，方位 ${metadata.angle} 度`}`}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={stopDragging}
          onPointerCancel={stopDragging}
          onKeyDown={moveWithKeyboard}
        >
          <span
            className="light-direction-ray"
            style={{
              width: `${magnitude * lampRadius}px`,
              transform: `translateY(-50%) rotate(${rayAngle}deg)`,
            }}
            aria-hidden="true"
          />
          <span className="light-direction-product" aria-hidden="true"><Box size={16} /></span>
          <span
            className="light-direction-lamp"
            style={{
              left: `calc(50% + ${direction.x * lampRadius}px)`,
              top: `calc(50% + ${direction.y * lampRadius}px)`,
            }}
            aria-hidden="true"
          >
            <Lightbulb size={15} />
          </span>
        </div>
        <div className="light-direction-copy">
          <strong>{metadata.label}</strong>
          <span>{metadata.label === '正前方' ? '正面主光' : `${metadata.angle}° 方位`}</span>
          <small>拖动灯光图标，高光同向，阴影反向</small>
        </div>
      </div>
    </section>
  )
}

function ApiModeSelect({ value, onChange }: { value: ApiMode; onChange: (mode: ApiMode) => void }) {
  const pickerRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const selectedOption = apiModeOptions.find((option) => option.value === value) ?? apiModeOptions[0]

  useEffect(() => {
    if (!open) return

    const closeWhenClickingOutside = (event: PointerEvent) => {
      if (event.target instanceof Element && !pickerRef.current?.contains(event.target)) setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }

    window.addEventListener('pointerdown', closeWhenClickingOutside)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('pointerdown', closeWhenClickingOutside)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  return (
    <div ref={pickerRef} className={`api-mode-picker ${open ? 'open' : ''}`}>
      <button
        className="api-mode-select"
        type="button"
        aria-label="API 模式"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span>{selectedOption.label}</span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {open && (
        <div className="api-mode-menu" role="listbox" aria-label="API 模式选项">
          {apiModeOptions.map((option) => {
            const selected = option.value === value
            return (
              <button
                className={`api-mode-option ${selected ? 'selected' : ''}`}
                type="button"
                role="option"
                aria-selected={selected}
                key={option.value}
                onClick={() => {
                  onChange(option.value)
                  setOpen(false)
                }}
              >
                <span>{option.label}</span>
                {selected && <Check size={14} aria-hidden="true" />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function WorkflowCard({ data, id: nodeId, selected }: NodeProps<WorkflowNode>) {
  const updateNodeInternals = useUpdateNodeInternals()
  const replaceImageInputRef = useRef<HTMLInputElement>(null)
  const replaceVideoInputRef = useRef<HTMLInputElement>(null)
  const promptTextareaRef = useRef<HTMLTextAreaElement>(null)
  const modelPickerRef = useRef<HTMLDivElement>(null)
  const ensurePanelVisibleRef = useRef(data.onEnsureGenerationPanelVisible)
  ensurePanelVisibleRef.current = data.onEnsureGenerationPanelVisible
  const isPromptComposingRef = useRef(false)
  const lastCommittedPromptRef = useRef(data.prompt || '')
  const [promptDraft, setPromptDraft] = useState(data.prompt || '')
  const [promptMentionBindings, setPromptMentionBindings] = useState<PromptMentionBinding[]>(data.promptMentions || [])
  const [mentionMenuOpen, setMentionMenuOpen] = useState(false)
  const [mentionQuery, setMentionQuery] = useState('')
  const [mentionStart, setMentionStart] = useState(0)
  const [mentionSelection, setMentionSelection] = useState(0)
  const [referenceImageRatio, setReferenceImageRatio] = useState('—')
  const [referencePixelSize, setReferencePixelSize] = useState('')
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false)
  const isImage = data.kind === 'image'
  const isVideo = data.kind === 'video'
  const isElementEditResult = isImage && Boolean(data.elementEditOperations?.length)
  const isMultiAngleResult = isImage && Boolean(data.multiAngleSettings)
  const isDirectEditResult = isElementEditResult || isMultiAngleResult
  const supportsPromptMentions = (isImage || isVideo) && !isDirectEditResult
  const isReference = data.kind === 'reference'
  const isVideoReference = data.kind === 'video-reference'
  const isRepaint = data.kind === 'repaint'
  const isOutpaint = data.kind === 'outpaint'
  const isGroup = data.kind === 'group'
  const isGenerating = data.status === 'generating'
  const isDone = data.status === 'done'
  const isError = data.status === 'error'
  const promptMentionOptions = supportsPromptMentions ? (data.promptMentionOptions || []) : []
  const filteredPromptMentionOptions = promptMentionOptions.filter((option) => {
    const query = mentionQuery.trim().toLocaleLowerCase()
    if (!query) return true
    return option.token.toLocaleLowerCase().includes(query) || option.label.toLocaleLowerCase().includes(query)
  })
  const visiblePromptMentions = activePromptMentions(promptDraft, promptMentionBindings)
  const selectedAspectRatio = getAspectRatioOption(data.size)
  const nodePixelSize = parseImageSize(data.size)
  const nodeFrameAspectRatio = `${nodePixelSize.width} / ${nodePixelSize.height}`
  const sourceWidth = data.sourceWidth || 1024
  const sourceHeight = data.sourceHeight || 1024
  const outpaintInsets = data.outpaintInsets || defaultOutpaintInsets(sourceWidth, sourceHeight)
  const outpaintPreset = data.outpaintPreset || 'free'
  const configuredModelName = data.model?.trim() || ''
  const usesApiMartNodeSettings = data.apiMode === 'apimart'
  const imageModelConfig = findApiMartModel(configuredModelName)
  const selectedImageSize = data.imageSize && imageModelConfig.resolutions.includes(data.imageSize)
    ? data.imageSize
    : data.imageSize || imageModelConfig.defaultResolution
  const videoModelConfig = findApiMartVideoModel(configuredModelName)
  const selectedVideoResolution = data.videoResolution && videoModelConfig.resolutions.includes(data.videoResolution)
    ? data.videoResolution
    : videoModelConfig.defaultResolution
  const requestedVideoDuration = Number(data.videoDuration)
  const selectedVideoDuration = Number.isFinite(requestedVideoDuration)
    ? Math.min(videoModelConfig.maxDuration, Math.max(videoModelConfig.minDuration, Math.round(requestedVideoDuration)))
    : videoModelConfig.defaultDuration
  const panelOpen = supportsPromptMentions && (data.generationPanelOpen ?? selected)
  const imageResolutionOptions = data.imageResolutionOptions ?? (usesApiMartNodeSettings ? imageModelConfig.resolutions : [])
  const supportsReferenceVideo = isVideo && videoModelConfig.maxReferenceVideos > 0
  const modelOptions = data.generationModelOptions ?? (isVideo ? apiMartVideoModels : usesApiMartNodeSettings ? apiMartModels : [{ id: configuredModelName, label: apiModelDisplayName(configuredModelName) || '当前模型' }])
  const selectedModelId = isVideo ? videoModelConfig.id : usesApiMartNodeSettings ? imageModelConfig.id : configuredModelName
  const selectedModelLabel = modelOptions.find((model) => model.id === selectedModelId)?.label || apiModelDisplayName(configuredModelName) || '当前模型'
  const nodeTitle = isElementEditResult
    ? `元素编辑结果 · ${sourceWidth} × ${sourceHeight}`
    : isMultiAngleResult
      ? `多角度结果 · ${sourceWidth} × ${sourceHeight}`
    : isReference || isVideoReference
      ? (data.sourceName || data.title)
      : isImage || isVideo
        ? (apiModelDisplayName(configuredModelName) || data.title)
        : data.title
  const imageInputSlots = isImage || isVideo
    ? data.imageInputSlots?.length
      ? data.imageInputSlots
      : [{ id: `${imageInputHandlePrefix}1`, index: 1, connected: false }]
    : [{ id: 'image', index: 1, connected: Boolean(data.imageInputConnected) }]
  const videoInputSlots = supportsReferenceVideo
    ? data.videoInputSlots?.length
      ? data.videoInputSlots
      : [{ id: `${videoInputHandlePrefix}1`, index: 1, connected: false }]
    : []
  const totalInputSlots = imageInputSlots.length + videoInputSlots.length
  const inputPortSpan = Math.min(60, (totalInputSlots - 1) * 12)
  const inputPortStep = totalInputSlots > 1 ? inputPortSpan / (totalInputSlots - 1) : 0
  const inputPortTop = (rowIndex: number) => `${50 - inputPortSpan / 2 + inputPortStep * rowIndex}%`
  const imageSlotSignature = [
    ...imageInputSlots.map((slot) => `${slot.id}:${slot.connected}`),
    ...videoInputSlots.map((slot) => `${slot.id}:${slot.connected}`),
  ].join('|')

  useEffect(() => {
    updateNodeInternals(nodeId)
    if (!panelOpen) return
    let timer: number | undefined
    const ensureVisible = () => {
      window.clearTimeout(timer)
      // Allow the existing quick-workflow viewport animation to finish first.
      timer = window.setTimeout(() => ensurePanelVisibleRef.current?.(nodeId), 300)
    }
    const panel = modelPickerRef.current?.closest('.generation-panel')
    const observer = new ResizeObserver(ensureVisible)
    if (panel) observer.observe(panel)
    window.addEventListener('resize', ensureVisible)
    ensureVisible()
    return () => {
      window.clearTimeout(timer)
      observer.disconnect()
      window.removeEventListener('resize', ensureVisible)
    }
  }, [imageSlotSignature, nodeId, updateNodeInternals, panelOpen, data.size])

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

  useEffect(() => {
    setPromptMentionBindings(data.promptMentions || [])
  }, [data.promptMentions])

  useEffect(() => {
    if (!isModelMenuOpen) return

    const handleOutsidePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Element && !modelPickerRef.current?.contains(event.target)) {
        setIsModelMenuOpen(false)
      }
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsModelMenuOpen(false)
    }

    document.addEventListener('pointerdown', handleOutsidePointerDown, true)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handleOutsidePointerDown, true)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isModelMenuOpen])

  useEffect(() => {
    if (isGenerating || !panelOpen) {
      setIsModelMenuOpen(false)
      setMentionMenuOpen(false)
    }
  }, [isGenerating, panelOpen])

  const selectNodeModel = (modelId: string) => {
    if (isImage) data.onChangeImageModel?.(nodeId, modelId)
    if (isVideo) data.onChangeVideoModel?.(nodeId, modelId)
    setIsModelMenuOpen(false)
  }

  const commitPromptDraft = (nextPrompt: string, nextMentions?: PromptMentionBinding[]) => {
    const retainedMentions = (nextMentions || promptMentionBindings).filter((mention) => promptContainsMentionToken(nextPrompt, mention.token))
    setPromptMentionBindings(retainedMentions)
    if (lastCommittedPromptRef.current === nextPrompt && nextMentions === undefined) return
    lastCommittedPromptRef.current = nextPrompt
    data.onChangePrompt?.(nodeId, nextPrompt, retainedMentions)
  }

  const updatePromptMentionMenu = (value: string, caret: number | null) => {
    if (!supportsPromptMentions || caret === null) {
      setMentionMenuOpen(false)
      return
    }
    const beforeCaret = value.slice(0, caret)
    const match = beforeCaret.match(/@([^\s@，。！？；：]*)$/)
    if (!match) {
      setMentionMenuOpen(false)
      return
    }
    setMentionStart(caret - match[0].length)
    setMentionQuery(match[1])
    setMentionSelection(0)
    setMentionMenuOpen(true)
  }

  const insertPromptMention = (option: PromptMentionOption) => {
    const textarea = promptTextareaRef.current
    const caret = textarea?.selectionStart ?? promptDraft.length
    const existingBinding = promptMentionBindings.find((mention) => mention.nodeId === option.nodeId)
    let token = existingBinding?.token || option.token
    if (promptMentionBindings.some((mention) => mention.token === token && mention.nodeId !== option.nodeId)) {
      const prefix = option.kind === 'image' ? '@Image' : '@Video'
      let suffix = 1
      while (promptMentionBindings.some((mention) => mention.token === `${prefix}${suffix}`)) suffix += 1
      token = `${prefix}${suffix}`
    }
    const nextPrompt = `${promptDraft.slice(0, mentionStart)}${token} ${promptDraft.slice(caret)}`
    const nextBinding: PromptMentionBinding = {
      token,
      nodeId: option.nodeId,
      kind: option.kind,
      label: option.label,
    }
    const nextMentions = [
      ...promptMentionBindings.filter((mention) => mention.nodeId !== option.nodeId && mention.token !== token),
      nextBinding,
    ]
    setPromptDraft(nextPrompt)
    commitPromptDraft(nextPrompt, nextMentions)
    setMentionMenuOpen(false)
    window.setTimeout(() => {
      const nextCaret = mentionStart + token.length + 1
      promptTextareaRef.current?.focus()
      promptTextareaRef.current?.setSelectionRange(nextCaret, nextCaret)
    }, 0)
  }

  const promptEditor = (
    <div className="image-prompt-control nodrag nopan nowheel">
      <span className="image-prompt-heading">
        <span>提示词</span>
        {isOutpaint && (
          <button type="button" onClick={() => data.onResetOutpaintPrompt?.(nodeId)} disabled={isGenerating}>
            恢复默认
          </button>
        )}
      </span>
      <div className="prompt-editor-shell">
        <textarea
          ref={promptTextareaRef}
          aria-label={isVideo ? '视频生成提示词' : isImage ? '图像生成提示词' : '提示词'}
          value={promptDraft}
          rows={isOutpaint ? 6 : 4}
          placeholder={isOutpaint ? '描述希望扩展出的画面内容' : supportsPromptMentions ? '输入提示词，键入 @ 引用已连接素材' : '输入提示词'}
          onCompositionStart={() => {
            isPromptComposingRef.current = true
          }}
          onCompositionEnd={(event) => {
            isPromptComposingRef.current = false
            const nextPrompt = event.currentTarget.value
            setPromptDraft(nextPrompt)
            commitPromptDraft(nextPrompt)
            updatePromptMentionMenu(nextPrompt, event.currentTarget.selectionStart)
          }}
          onKeyDown={(event) => {
            if (mentionMenuOpen && !isPromptComposingRef.current) {
              if (event.key === 'ArrowDown' && filteredPromptMentionOptions.length) {
                event.preventDefault()
                setMentionSelection((current) => (current + 1) % filteredPromptMentionOptions.length)
              } else if (event.key === 'ArrowUp' && filteredPromptMentionOptions.length) {
                event.preventDefault()
                setMentionSelection((current) => (current - 1 + filteredPromptMentionOptions.length) % filteredPromptMentionOptions.length)
              } else if ((event.key === 'Enter' || event.key === 'Tab') && filteredPromptMentionOptions[mentionSelection]) {
                event.preventDefault()
                insertPromptMention(filteredPromptMentionOptions[mentionSelection])
              } else if (event.key === 'Escape') {
                event.preventDefault()
                setMentionMenuOpen(false)
              }
            }
            event.stopPropagation()
          }}
          onClick={(event) => updatePromptMentionMenu(event.currentTarget.value, event.currentTarget.selectionStart)}
          onBlur={() => window.setTimeout(() => setMentionMenuOpen(false), 80)}
          onChange={(event) => {
            const nextPrompt = event.currentTarget.value
            setPromptDraft(nextPrompt)
            if (!isPromptComposingRef.current) {
              commitPromptDraft(nextPrompt)
              updatePromptMentionMenu(nextPrompt, event.currentTarget.selectionStart)
            }
          }}
        />
        {supportsPromptMentions && mentionMenuOpen && (
          <div className="prompt-mention-menu nodrag nopan nowheel" role="listbox" aria-label="可引用素材">
            <div className="prompt-mention-menu-title"><AtSign size={13} /> 引用已连接素材</div>
            {filteredPromptMentionOptions.length ? filteredPromptMentionOptions.map((option, index) => (
              <button
                key={`${option.nodeId}-${option.kind}`}
                className={`prompt-mention-option ${index === mentionSelection ? 'selected' : ''}`}
                type="button"
                role="option"
                aria-selected={index === mentionSelection}
                onPointerDown={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  insertPromptMention(option)
                }}
              >
                <span className="prompt-mention-preview" aria-hidden="true">
                  {option.kind === 'image' && option.previewUrl
                    ? <img src={option.previewUrl} alt="" draggable={false} />
                    : <Video size={15} />}
                </span>
                <span className="prompt-mention-option-copy">
                  <strong>{option.token}</strong>
                  <small>{option.label}</small>
                </span>
                <em>{option.kind === 'image' ? `Image ${option.slotIndex}` : `Video ${option.slotIndex}`}</em>
              </button>
            )) : (
              <div className="prompt-mention-empty">
                {promptMentionOptions.length ? '没有匹配的素材' : '请先把参考图或参考视频连接到当前生成框'}
              </div>
            )}
          </div>
        )}
        {supportsPromptMentions && visiblePromptMentions.length > 0 && (
          <div className="prompt-mention-chips" aria-label="提示词已引用素材">
            {visiblePromptMentions.map((mention) => {
              const available = promptMentionOptions.some((option) => option.nodeId === mention.nodeId)
              return (
                <button
                  key={`${mention.token}-${mention.nodeId}`}
                  className={available ? '' : 'missing'}
                  type="button"
                  title={available ? `定位 ${mention.label}` : `${mention.label} 未连接到当前生成框`}
                  onClick={() => data.onLocatePromptMention?.(mention.nodeId)}
                >
                  {mention.kind === 'image' ? <ImageIcon size={11} /> : <Video size={11} />}
                  {mention.token}
                  {!available && <AlertTriangle size={11} />}
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )

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
    <div className={`workflow-node-shell ${selected ? 'selected' : ''}`}>
    <div
      className={`workflow-node ${selected ? 'selected' : ''} ${data.kind}`}
      title={mediaDataForCopy(data) ? '按住 Alt 并用鼠标左键拖动，可创建保留提示词的独立副本' : undefined}
    >
      {selected && (isReference || isImage) && (
        <div
          className="image-context-actions nodrag nopan nowheel"
          role="toolbar"
          aria-label="图片操作"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            disabled={isGenerating}
            onClick={() => data.onOpenLightDirection?.(nodeId)}
          >
            <Lightbulb size={14} />
            调整灯光
          </button>
          <button
            type="button"
            disabled={!data.imageUrl || isGenerating}
            title={data.imageUrl ? '打开多角度编辑器' : '请先上传或生成图片'}
            onClick={() => data.onOpenMultiAngle?.(nodeId)}
          >
            <Rotate3D size={14} />
            多角度编辑
          </button>
          <button
            type="button"
            disabled={!data.imageUrl || isGenerating}
            title={data.imageUrl ? '打开元素编辑工作台' : '请先上传或生成图片'}
            onClick={() => data.onOpenElementEdit?.(nodeId)}
          >
            <Wand2 size={14} />
            元素编辑
          </button>
        </div>
      )}
      {(isImage || isVideo || isOutpaint) && (
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
          {videoInputSlots.map((slot, index) => {
            const label = `Video ${slot.index}`
            const top = inputPortTop(imageInputSlots.length + index)
            return [
              <span key={`${slot.id}-label`} className="node-port-label video-input-label" style={{ top }} aria-hidden="true">
                <Video size={13} />
                {label}
              </span>,
              <Handle
                key={slot.id}
                id={slot.id}
                type="target"
                position={Position.Left}
                className={`node-handle video-input-handle ${slot.connected ? 'connected' : ''}`}
                style={{ top }}
                isConnectable={!slot.connected}
                aria-label={`${label} 输入`}
                title={`连接到 ${label}，或向左拖出参考视频节点`}
              />,
            ]
          })}
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
          ) : isVideoReference ? (
            <Video size={15} />
          ) : isReference ? (
            <UploadCloud size={15} />
          ) : (
            <Wand2 size={15} />
          )}
          <span className={(isReference || isVideoReference) ? 'reference-file-title' : undefined} title={nodeTitle}>
            {nodeTitle}
          </span>
        </div>
        {isReference || isVideoReference ? (
          <div
            className="reference-pixel-ratio"
            title={isVideoReference
              ? (data.videoDurationSeconds ? `参考视频 ${data.videoDurationSeconds.toFixed(1)} 秒` : '参考视频')
              : referencePixelSize ? `原始像素 ${referencePixelSize}` : '正在读取图片比例'}
            aria-label={isVideoReference ? '参考视频' : `上传图片比例 ${referenceImageRatio}`}
          >
            {isVideoReference ? 'VIDEO' : referenceImageRatio}
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

      {isOutpaint && promptEditor}

      {(isImage || isReference) && (
        data.imageUrl && !isGenerating ? (
          isReference && (data.model3DSceneId || data.sketch) ? (
            <button
              className="model3d-reference-preview nodrag nopan nowheel"
              type="button"
              title={data.sketch ? '继续编辑分层手绘' : '继续编辑这个 3D 场景'}
              aria-label={data.sketch ? '继续编辑分层手绘' : '继续编辑这个 3D 场景'}
              onClick={() => data.sketch ? data.onEditSketch?.(nodeId) : data.onEditModel3D?.(nodeId)}
            >
              <img
                className="node-image"
                src={data.imageUrl}
                alt={data.sourceName || data.title}
                draggable={false}
                onLoad={(event) => {
                  const { naturalWidth, naturalHeight } = event.currentTarget
                  setReferenceImageRatio(getReferenceImageRatio(naturalWidth, naturalHeight))
                  setReferencePixelSize(`${naturalWidth} × ${naturalHeight}`)
                }}
              />
              <span className="model3d-reference-badge">{data.sketch ? <><Pencil size={13} /> 继续编辑手绘</> : <><Box size={13} /> 继续编辑 3D</>}</span>
            </button>
          ) : (
            <img
              className="node-image"
              src={data.imageUrl}
              alt={isReference ? (data.sourceName || data.title) : data.title}
              draggable={false}
              style={isImage ? { aspectRatio: nodeFrameAspectRatio } : undefined}
              onLoad={(event) => {
                if (!isReference) return
                const { naturalWidth, naturalHeight } = event.currentTarget
                setReferenceImageRatio(getReferenceImageRatio(naturalWidth, naturalHeight))
                setReferencePixelSize(`${naturalWidth} × ${naturalHeight}`)
              }}
            />
          )
        ) : (
          <div
            className={`node-empty ${isGenerating ? 'generating' : ''}`}
            style={isImage ? { aspectRatio: nodeFrameAspectRatio } : undefined}
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

      {isVideoReference && (
        data.videoUrl ? (
          <video
            className="node-video reference-video-preview nodrag nopan nowheel"
            src={data.videoUrl}
            controls
            playsInline
            preload="metadata"
          />
        ) : (
          <div className="node-empty reference-video-empty" aria-live="polite">
            <Video size={30} />
            <span>等待参考视频</span>
            <small>支持 MP4、MOV，最大 100 MB</small>
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
            style={{ aspectRatio: nodeFrameAspectRatio }}
          />
        ) : (
          <div
            className={`node-empty node-video-empty ${isGenerating ? 'generating' : ''}`}
            style={{ aspectRatio: nodeFrameAspectRatio }}
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
                <small>在下方填写提示词，可连接参考素材</small>
              </>
            )}
          </div>
        )
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

      {(
        <>
          <div className="node-actions">
            {mediaDataForCopy(data) && (
              <button
                className="nodrag nopan"
                type="button"
                title={data.resultCopied ? '已复制，可按 Ctrl+V 粘贴；副本保留提示词' : '复制结果（Ctrl+C），副本会保留提示词'}
                aria-label={isVideo || isVideoReference ? '复制视频结果' : '复制图像结果'}
                onClick={() => data.onCopyResult?.(nodeId)}
              >
                {data.resultCopied ? <Check size={14} /> : <Copy size={14} />}
              </button>
            )}
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
            {isVideoReference && (
              <>
                <input
                  ref={replaceVideoInputRef}
                  className="node-replace-input nodrag nopan"
                  type="file"
                  accept="video/mp4,video/quicktime,.mp4,.mov"
                  aria-label="替换参考视频"
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    event.target.value = ''
                    if (file) data.onReplaceVideo?.(nodeId, file)
                  }}
                />
                <button
                  className="node-replace-button nodrag nopan"
                  type="button"
                  title={data.videoUrl ? '替换参考视频' : '上传参考视频'}
                  onClick={() => replaceVideoInputRef.current?.click()}
                >
                  {data.videoUrl ? <RefreshCw size={13} /> : <UploadCloud size={13} />}
                  <span>{data.videoUrl ? '替换' : '上传'}</span>
                </button>
                {data.videoDurationSeconds ? (
                  <span className="reference-video-duration" title="参考视频时长">
                    {data.videoDurationSeconds.toFixed(1)}s
                  </span>
                ) : null}
              </>
            )}
            {data.imageUrl && (
              <button type="button" title="下载图像" onClick={() => data.onDownload?.(nodeId)}>
                <Download size={14} />
              </button>
            )}
            {(isImage || isOutpaint) && data.imageUrl && (
              <button type="button" title="保存并查看所在文件夹" onClick={() => data.onRevealImage?.(nodeId)}>
                <FolderOpen size={14} />
              </button>
            )}
            {isOutpaint ? (
              <button
                className="node-run-button nodrag nopan"
                type="button"
                title={isGenerating ? '正在生成' : '运行扩图'}
                aria-label={isGenerating ? '正在生成' : '运行扩图'}
                onClick={() => data.onGenerate?.(nodeId)}
                disabled={isGenerating}
              >
                Run
              </button>
            ) : !isImage && !isVideo && !isRepaint ? (
              <button type="button" title="删除节点" onClick={() => data.onDelete?.(nodeId)}>
                <Trash2 size={14} />
              </button>
            ) : null}
          </div>
        </>
      )}
      <Handle
        id="output"
        type="source"
        position={Position.Right}
        className={`node-handle output-handle ${data.outputConnected ? 'connected' : ''}`}
        aria-label={isVideo || isVideoReference ? 'Video 输出' : 'Image 输出'}
        title={
          isReference
            ? '向右拖出生成图像框'
            : isVideo || isVideoReference
              ? '连接到视频生成框的 Video 输入'
              : isImage
              ? '向右拖出并连接新的图像生成框'
              : isOutpaint
                  ? '扩图完成后向右拖出生成图像框'
                : undefined
        }
      />
    </div>
    {panelOpen && (
      <section
        className="generation-panel floating-prompt-control nodrag nopan nowheel"
        aria-label={isVideo ? '视频生成面板' : '图像生成面板'}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        {promptEditor}
        <div className={`generation-panel-settings ${isVideo ? 'video-generation-settings' : 'image-generation-toolbar'}`}>
          <div className="generation-setting generation-model-setting">
            <span>模型</span>
            <div
              ref={modelPickerRef}
              className={`node-model-picker nodrag nopan nowheel ${isModelMenuOpen ? 'open' : ''}`}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <button
                className="node-model-select"
                type="button"
                aria-label={isVideo ? '视频生成模型' : '图像生成模型'}
                aria-haspopup="listbox"
                aria-expanded={isModelMenuOpen}
                title={isModelMenuOpen ? '收起模型列表' : '展开模型列表'}
                disabled={isGenerating}
                onClick={() => setIsModelMenuOpen((open) => !open)}
              >
                <span>{selectedModelLabel}</span>
                <ChevronDown size={14} aria-hidden="true" />
              </button>
              {isModelMenuOpen && (
                <div
                  className="node-model-menu"
                  role="listbox"
                  aria-label={isVideo ? '可选视频模型' : '可选图像模型'}
                >
                  {modelOptions.map((model) => {
                    const isSelectedModel = model.id === selectedModelId
                    return (
                      <button
                        key={model.id}
                        className={`node-model-option ${isSelectedModel ? 'selected' : ''}`}
                        type="button"
                        role="option"
                        aria-selected={isSelectedModel}
                        onClick={() => selectNodeModel(model.id)}
                      >
                        {model.label}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
          <label className="generation-setting">
            <span>画面比例</span>
            <select aria-label={isVideo ? '视频画面比例' : '图像画面比例'} value={selectedAspectRatio.size} disabled={isGenerating} onChange={(event) => data.onChangeSize?.(nodeId, event.target.value)}>
              {aspectRatioOptions.map((option) => <option key={option.size} value={option.size}>{option.label}</option>)}
            </select>
          </label>
          <label className="generation-setting">
            <span>清晰度</span>
            <select
              aria-label={isVideo ? '视频像素大小' : '图像输出清晰度'}
              value={isVideo ? selectedVideoResolution : selectedImageSize}
              disabled={isGenerating || (!isVideo && imageResolutionOptions.length < 2)}
              onChange={(event) => isVideo ? data.onChangeVideoResolution?.(nodeId, event.target.value as VideoResolutionTier) : data.onChangeImageSize?.(nodeId, event.target.value as ImageResolutionTier)}
            >
              {(isVideo ? videoModelConfig.resolutions : imageResolutionOptions.length ? imageResolutionOptions : [selectedImageSize]).map((resolution) => <option key={resolution} value={resolution}>{resolution}</option>)}
            </select>
          </label>
          {!isVideo && (
            <button
              className="generation-submit generation-submit-run"
              type="button"
              onClick={() => data.onGenerate?.(nodeId)}
              disabled={isGenerating}
              aria-label={isGenerating ? '正在生成' : '运行生成'}
              title={isGenerating ? '正在生成' : '运行生成'}
            >
              {isGenerating ? <Loader2 size={15} className="export-spinner" /> : 'Run'}
            </button>
          )}
        </div>
        {isVideo && (
          <div className="generation-panel-footer">
            <label className="generation-duration-setting">
              <span>时长 <strong>{selectedVideoDuration} 秒</strong></span>
              <UnifiedRange min={videoModelConfig.minDuration} max={videoModelConfig.maxDuration} step={1} value={selectedVideoDuration} onValueChange={(duration) => data.onChangeVideoDuration?.(nodeId, duration)} disabled={isGenerating} aria-label={'视频生成时长 ' + selectedVideoDuration + ' 秒'} />
            </label>
            <button className="generation-submit" type="button" onClick={() => data.onGenerate?.(nodeId)} disabled={isGenerating} aria-label={isGenerating ? '正在生成' : '运行视频生成'}>
              {isGenerating ? <Loader2 size={15} className="export-spinner" /> : <Wand2 size={15} />}
              {isGenerating ? '生成中…' : '生成视频'}
            </button>
          </div>
        )}
      </section>
    )}
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
  const referenceVideoInputRef = useRef<HTMLInputElement>(null)
  const openedProjectHandleRef = useRef<ProjectArchiveFileHandle | null>(null)
  const pendingNodePositionRef = useRef<XYPosition | null>(null)
  const connectingFromNodeIdRef = useRef<string | null>(null)
  const [nodes, setNodes, onNodesChange] = useNodesState<WorkflowNode>([])
  const [edges, setEdges] = useEdgesState<Edge>([])
  const [, setPrompt] = useState(starterPrompt)
  const [projectName, setProjectName] = useState('未命名项目')
  const [dirty, setDirty] = useState(false)
  const [isGenerating, setIsGenerating] = useState(false)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [showModelStudio, setShowModelStudio] = useState(false)
  const [sketchSession, setSketchSession] = useState<{ nodeId: string | null; document?: SketchDocument } | null>(null)
  const [elementEditSession, setElementEditSession] = useState<{
    nodeId: string
    sourceImageUrl: string
  } | null>(null)
  const [multiAngleSession, setMultiAngleSession] = useState<{
    nodeId: string
    sourceImageUrl: string
  } | null>(null)
  const [model3DEditSession, setModel3DEditSession] = useState<{
    nodeId: string | null
    sceneId: string | null
    scene: SavedModel3DScene | null
  }>({ nodeId: null, sceneId: null, scene: null })
  const [showHistoryPanel, setShowHistoryPanel] = useState(false)
  const [historyMediaPreview, setHistoryMediaPreview] = useState<HistoryMediaPreview | null>(null)
  const [historyImageNaturalSize, setHistoryImageNaturalSize] = useState<{ width: number; height: number } | null>(null)
  const [lightDirectionNodeId, setLightDirectionNodeId] = useState<string | null>(null)
  const [showQuickWorkflows, setShowQuickWorkflows] = useState(false)
  const [showPromptLibrary, setShowPromptLibrary] = useState(false)
  const [copiedPromptId, setCopiedPromptId] = useState<string | null>(null)
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance<WorkflowNode, Edge> | null>(null)
  const [contextMenu, setContextMenu] = useState<CanvasContextMenu | null>(null)
  const [mediaClipboard, setMediaClipboard] = useState<CanvasMediaClipboard | null>(null)
  const [groupDialog, setGroupDialog] = useState<GroupDialogState | null>(null)
  const [groupNameDraft, setGroupNameDraft] = useState('')
  const [apiConfig, setApiConfig] = useState<ApiConfig>(() => readStoredApiConfig())
  const [change2ProModels, setChange2ProModels] = useState<Change2ProModelOption[]>([])
  const [change2ProModelStatus, setChange2ProModelStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle')
  const [change2ProModelMessage, setChange2ProModelMessage] = useState('')
  const change2ProModelRequestIdRef = useRef(0)
  const [history, setHistory] = useState<GenerationRecord[]>([])
  const [isExporting, setIsExporting] = useState(false)
  const [isProjectSaving, setIsProjectSaving] = useState(false)
  const [openedProjectFileName, setOpenedProjectFileName] = useState('')
  const [, setToast] = useState('已准备好，默认使用本地模拟生成。')

  const markDirty = useCallback(() => setDirty(true), [])

  useEffect(() => {
    removedApiModes.forEach((mode) => window.localStorage.removeItem(`${API_PROFILE_STORAGE_KEY_PREFIX}${mode}`))
    if (!removedApiModes.includes(String(apiConfig.mode) as (typeof removedApiModes)[number])) return
    window.localStorage.removeItem(API_STORAGE_KEY)
    setApiConfig(defaultApiConfig)
  }, [apiConfig.mode])

  const loadChange2ProModels = useCallback(async () => {
    const apiKey = apiConfig.apiKey.trim()
    const family = apiConfig.change2ProFamily || change2ProFamilyFromModel(apiConfig.model)
    if (!apiKey) {
      setChange2ProModels([])
      setChange2ProModelStatus('idle')
      setChange2ProModelMessage(`请先填写 ${family === 'image2' ? 'Image 2.5' : 'Nano Banana'} API Key。`)
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
        throw new Error(`当前 Key 没有返回可用的 ${family === 'image2' ? 'Image 2.5' : 'Nano Banana'} 模型。`)
      }
      setChange2ProModels(models)
      setChange2ProModelStatus('success')
      setChange2ProModelMessage(`已从对应 API 读取 ${models.length} 个${family === 'image2' ? ' Image 2.5' : ' Nano Banana'} 模型。`)
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

  useEffect(() => {
    const migrated = migrateLegacyPromptNodes(nodes, edges)
    if (migrated.nodes !== nodes) {
      setNodes(migrated.nodes)
      markDirty()
    }
    setEdges(normalizeImageInputEdges(migrated.edges, migrated.nodes))
  }, [nodes, edges, setNodes, setEdges, markDirty])

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
      const targetsVideoInput = isVideoInputHandle(connection.targetHandle)

      if (sourceNode?.data.kind === 'prompt' || connection.targetHandle === 'prompt') {
        setToast('提示词请直接填写在生成框下方。')
        return
      }
      if (targetNode?.data.kind === 'image' || targetNode?.data.kind === 'video' || targetNode?.data.kind === 'repaint' || targetNode?.data.kind === 'outpaint') {
        if (targetsImageInput && sourceNode?.data.kind === 'video-reference') {
          setToast('参考视频请连接到 Video 输入。')
          return
        }
        if (targetsVideoInput && sourceNode?.data.kind !== 'video-reference' && sourceNode?.data.kind !== 'video') {
          setToast('Video 输入仅支持参考视频节点或已生成的视频。')
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

      const remainingSceneIds = new Set(
        nodes
          .filter((node) => !idsToDelete.has(node.id))
          .flatMap((node) => [node.data.model3DSceneId, ...sketchSceneIds(node.data.sketch)])
          .filter((sceneId): sceneId is string => Boolean(sceneId)),
      )
      const sceneIdsToDelete = new Set(
        nodes
          .filter((node) => idsToDelete.has(node.id))
          .flatMap((node) => [node.data.model3DSceneId, ...sketchSceneIds(node.data.sketch)])
          .filter((sceneId): sceneId is string => Boolean(sceneId))
          .filter((sceneId) => !remainingSceneIds.has(sceneId)),
      )

      setNodes((current) => current.filter((node) => !idsToDelete.has(node.id)))
      setEdges((current) => current.filter((edge) => !idsToDelete.has(edge.source) && !idsToDelete.has(edge.target)))
      setSelectedNodeId((current) => (current && idsToDelete.has(current) ? null : current))
      setLightDirectionNodeId((current) => (current && idsToDelete.has(current) ? null : current))
      setElementEditSession((current) => (current && idsToDelete.has(current.nodeId) ? null : current))
      setMultiAngleSession((current) => (current && idsToDelete.has(current.nodeId) ? null : current))
      sceneIdsToDelete.forEach((sceneId) => void deleteModel3DScene(sceneId))
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
      if (event.key !== 'Delete' || showSettings || showModelStudio || sketchSession || elementEditSession || multiAngleSession || groupDialog || historyMediaPreview || lightDirectionNodeId || isKeyboardControlTarget(event.target)) return

      const selectedNodeIds = nodes.filter((node) => node.selected).map((node) => node.id)
      if (selectedNodeId && !selectedNodeIds.includes(selectedNodeId)) selectedNodeIds.push(selectedNodeId)
      if (!selectedNodeIds.length) return

      event.preventDefault()
      deleteNodesByIds(selectedNodeIds)
    },
    [deleteNodesByIds, elementEditSession, groupDialog, historyMediaPreview, lightDirectionNodeId, multiAngleSession, nodes, selectedNodeId, showModelStudio, sketchSession, showSettings],
  )

  useEffect(() => {
    window.addEventListener('keydown', handleDeleteKey, true)
    return () => window.removeEventListener('keydown', handleDeleteKey, true)
  }, [handleDeleteKey])

  useEffect(() => {
    if (!historyMediaPreview) return

    const handlePreviewEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setHistoryMediaPreview(null)
    }

    window.addEventListener('keydown', handlePreviewEscape, true)
    return () => window.removeEventListener('keydown', handlePreviewEscape, true)
  }, [historyMediaPreview])

  useEffect(() => {
    if (!lightDirectionNodeId) return

    const handleLightDirectionEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setLightDirectionNodeId(null)
    }

    window.addEventListener('keydown', handleLightDirectionEscape, true)
    return () => window.removeEventListener('keydown', handleLightDirectionEscape, true)
  }, [lightDirectionNodeId])

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

  const downloadHistoryMedia = useCallback(
    async (item: GenerationRecord) => {
      const sourceNode = nodes.find((node) => node.id === item.id)
      const videoUrl = item.videoUrl || (item.status === '成功' ? sourceNode?.data.videoUrl : undefined)
      const isVideoHistory = item.mediaType === 'video' || Boolean(item.videoUrl)
      if (!isVideoHistory) {
        await revealHistoryImage(item)
        return
      }
      if (!videoUrl) {
        setToast('这条历史记录没有可下载的视频。')
        return
      }

      try {
        await downloadMediaFile(videoUrl, `${imageBaseName(projectName, item.id)}.mp4`)
        setToast('视频已下载到浏览器下载目录。')
      } catch (error) {
        const message = error instanceof Error ? error.message : '视频下载失败'
        setToast(message)
      }
    },
    [nodes, projectName, revealHistoryImage],
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

  const changeNodeImageModel = useCallback(
    (nodeId: string, modelId: string) => {
      const model = findApiMartModel(modelId)
      updateNodeData(nodeId, {
        model: model.id,
        imageSize: model.defaultResolution,
        error: undefined,
      })
      setToast(`图像模型已切换为 ${model.label}。`)
    },
    [updateNodeData],
  )

  const changeNodeImageSize = useCallback(
    (nodeId: string, imageSize: ImageResolutionTier) => {
      const node = nodes.find((item) => item.id === nodeId)
      const model = findApiMartModel(node?.data.model || apiConfig.model)
      const nextImageSize = model.resolutions.includes(imageSize) ? imageSize : model.defaultResolution
      updateNodeData(nodeId, { imageSize: nextImageSize, error: undefined })
      setToast(`图像清晰度已设为 ${nextImageSize}。`)
    },
    [apiConfig.model, nodes, updateNodeData],
  )

  const changeNodeVideoModel = useCallback(
    (nodeId: string, modelId: string) => {
      const model = findApiMartVideoModel(modelId)
      setEdges((current) => normalizeImageInputEdges(
        current.filter((edge) => {
          if (edge.target !== nodeId || !isVideoInputHandle(edge.targetHandle)) return true
          const index = videoInputHandleIndex(edge.targetHandle) || 1
          return index <= model.maxReferenceVideos
        }),
        nodes,
      ))
      updateNodeData(nodeId, {
        model: model.id,
        videoResolution: model.defaultResolution,
        videoDuration: model.defaultDuration,
        error: undefined,
      })
      setToast(
        model.maxReferenceVideos
          ? `视频模型已切换为 ${model.label}，可连接参考视频。`
          : `视频模型已切换为 ${model.label}；该模型不显示参考视频接口。`,
      )
    },
    [nodes, setEdges, updateNodeData],
  )

  const changeNodeVideoResolution = useCallback(
    (nodeId: string, videoResolution: VideoResolutionTier) => {
      updateNodeData(nodeId, { videoResolution, error: undefined })
      setToast(`视频像素大小已设为 ${videoResolution}。`)
    },
    [updateNodeData],
  )

  const changeNodeVideoDuration = useCallback(
    (nodeId: string, videoDuration: number) => {
      const node = nodes.find((item) => item.id === nodeId)
      const videoModel = findApiMartVideoModel(node?.data.model || apiConfig.videoModel)
      const duration = Math.min(videoModel.maxDuration, Math.max(videoModel.minDuration, Math.round(videoDuration)))
      updateNodeData(nodeId, { videoDuration: duration, error: undefined })
    },
    [apiConfig.videoModel, nodes, updateNodeData],
  )

  const changeNodeLightDirection = useCallback(
    (nodeId: string, lightDirection: LightDirection) => {
      updateNodeData(nodeId, {
        lightDirection: normalizeLightDirection(lightDirection),
        error: undefined,
      })
    },
    [updateNodeData],
  )

  const changeNodePrompt = useCallback(
    (nodeId: string, value: string, mentions?: PromptMentionBinding[]) => {
      updateNodeData(nodeId, {
        prompt: value,
        generationPrompt: value,
        ...(mentions !== undefined ? { promptMentions: mentions } : {}),
      })
    },
    [updateNodeData],
  )

  const locatePromptMention = useCallback(
    (referenceNodeId: string) => {
      const referenceNode = nodes.find((node) => node.id === referenceNodeId)
      if (!referenceNode) {
        setToast('这个引用素材已经不在画布中。')
        return
      }
      setNodes((current) => current.map((node) => ({ ...node, selected: node.id === referenceNodeId })))
      setSelectedNodeId(referenceNodeId)
      window.setTimeout(() => {
        void flowInstance?.fitView({ nodes: [{ id: referenceNodeId }], padding: 0.42, maxZoom: 1, duration: 220 })
      }, 0)
    },
    [flowInstance, nodes, setNodes],
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
          imageSize: apiConfig.imageSize,
          lightDirection: { ...defaultLightDirection },
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
      setToast(`已创建 ${outputSize} 生成框，请填写提示词后点击生成。`)
    },
    [apiConfig, flowInstance, markDirty, nodes, setEdges, setNodes],
  )

  const openLightDirectionEditor = useCallback(
    (nodeId: string) => {
      const node = nodes.find((item) => item.id === nodeId)
      if (!node || (node.data.kind !== 'reference' && node.data.kind !== 'image')) return
      setLightDirectionNodeId(nodeId)
    },
    [nodes],
  )

  const openElementEditFromNode = useCallback(
    async (nodeId: string) => {
      const sourceNode = nodes.find((item) => item.id === nodeId)
      if (!sourceNode?.data.imageUrl) {
        setToast('请先上传或生成图片，再进行元素编辑。')
        return
      }
      try {
        setToast('正在准备元素编辑画布…')
        const sourceImageUrl = await imageAsDataUrl(sourceNode.data.imageUrl)
        setElementEditSession({ nodeId, sourceImageUrl })
        setToast('可使用智能标记、框选或手绘选择需要修改的元素。')
      } catch (reason) {
        setToast(reason instanceof Error ? reason.message : '元素编辑画布打开失败')
      }
    },
    [nodes],
  )

  const openMultiAngleFromNode = useCallback(
    async (nodeId: string) => {
      const sourceNode = nodes.find((item) => item.id === nodeId)
      if (!sourceNode?.data.imageUrl) {
        setToast('请先上传或生成图片，再进行多角度编辑。')
        return
      }
      try {
        setToast('正在准备多角度编辑器…')
        const sourceImageUrl = await imageAsDataUrl(sourceNode.data.imageUrl)
        setMultiAngleSession({ nodeId, sourceImageUrl })
        setToast('请选择预设，或调整水平环绕、垂直俯仰和景别。')
      } catch (reason) {
        setToast(reason instanceof Error ? reason.message : '多角度编辑器打开失败')
      }
    },
    [nodes],
  )

  const generateRelitImageFromNode = useCallback(
    async (sourceNodeId: string) => {
      const sourceNode = nodes.find((item) => item.id === sourceNodeId)
      if (!sourceNode?.data.imageUrl) {
        setToast('请先上传或生成图片，再调整灯光并生成。')
        return
      }

      const lightDirection = normalizeLightDirection(sourceNode.data.lightDirection)
      if (!lightDirection.enabled) {
        setToast('请先开启灯光或拖动灯光图标设置方向。')
        return
      }

      const sourcePosition = getAbsoluteNodePosition(sourceNode, nodes)
      const outputNodeId = id('image')
      const createdAt = new Date().toLocaleString('zh-CN')
      const outputSize = sourceNode.data.size || apiConfig.size || defaultApiConfig.size
      const imageModel = apiConfig.mode === 'apimart'
        ? findApiMartModel(sourceNode.data.kind === 'image' ? sourceNode.data.model || apiConfig.model : apiConfig.model)
        : null
      const selectedModel = imageModel?.id || apiConfig.model
      const imageSize = imageModel
        ? (sourceNode.data.imageSize && imageModel.resolutions.includes(sourceNode.data.imageSize)
            ? sourceNode.data.imageSize
            : imageModel.defaultResolution)
        : apiConfig.imageSize
      const configForNode = { ...apiConfig, model: selectedModel, imageSize, size: outputSize }
      const adjustedPrompt = promptWithLightDirection(relightGenerationPrompt, lightDirection)
      const outputPosition = findFreeWorkflowNodePosition(
        { x: sourcePosition.x + 430, y: sourcePosition.y },
        { width: 330, height: 480 },
        nodes,
      )
      const outputNode: WorkflowNode = {
        id: outputNodeId,
        type: 'workflow',
        position: outputPosition,
        selected: true,
        data: {
          kind: 'image',
          title: '灯光调整图像',
          prompt: relightGenerationPrompt,
          generationPrompt: relightGenerationPrompt,
          status: 'generating',
          model: selectedModel,
          imageSize,
          lightDirection,
          size: outputSize,
          createdAt,
        },
      }

      setNodes((current) => [
        ...current.map((node) => ({ ...node, selected: false })),
        outputNode,
      ])
      setEdges((current) => [
        ...current,
        {
          id: id('edge'),
          source: sourceNode.id,
          sourceHandle: 'output',
          target: outputNodeId,
          targetHandle: `${imageInputHandlePrefix}1`,
          animated: true,
          markerEnd: { type: MarkerType.ArrowClosed, color: workflowEdgeColor },
          style: { stroke: workflowEdgeColor, strokeWidth: 1.6 },
        },
      ])
      setSelectedNodeId(outputNodeId)
      setLightDirectionNodeId(null)
      setIsGenerating(true)
      markDirty()
      setToast('已创建灯光调整图像框，正在按设置的方向生成。')
      window.setTimeout(() => {
        void flowInstance?.fitView({
          nodes: [{ id: sourceNode.id }, { id: outputNodeId }],
          padding: 0.22,
          maxZoom: 0.95,
          duration: 180,
        })
      }, 0)

      try {
        const imageUrl = await requestGeneratedImage(adjustedPrompt, configForNode, [sourceNode.data.imageUrl])
        updateNodeData(outputNodeId, {
          imageUrl,
          status: 'done',
          error: undefined,
          model: selectedModel,
          imageSize,
          size: outputSize,
        })
        setHistory((current) => [
          {
            id: outputNodeId,
            prompt: adjustedPrompt,
            model: selectedModel,
            size: outputSize,
            createdAt,
            imageUrl,
            status: '成功',
          },
          ...current,
        ])
        setToast(`灯光方向图像已生成：${lightDirectionMetadata(lightDirection).label}。`)
      } catch (error) {
        const message = error instanceof Error ? error.message : '灯光方向图像生成失败'
        updateNodeData(outputNodeId, { status: 'error', error: message })
        setHistory((current) => [
          {
            id: outputNodeId,
            prompt: adjustedPrompt,
            model: selectedModel,
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
    },
    [apiConfig, flowInstance, markDirty, nodes, setEdges, setNodes, updateNodeData],
  )

  const createInputNodeFromTarget = useCallback(
    (targetNode: WorkflowNode, targetHandleId: string | null, dropPosition: XYPosition) => {
      const createsReference = isImageInputHandle(targetHandleId)
      const createsReferenceVideo = isVideoInputHandle(targetHandleId)
      if (!createsReference && !createsReferenceVideo) return

      const createdAt = new Date().toLocaleString('zh-CN')
      const inputNodeId = id(createsReferenceVideo ? 'video-ref' : 'ref')
      const nodeWidth = 312
      const node: WorkflowNode = {
        id: inputNodeId,
        type: 'workflow',
        position: {
          x: dropPosition.x - nodeWidth,
          y: dropPosition.y - 150,
        },
        selected: true,
        data: createsReferenceVideo
          ? {
              kind: 'video-reference',
              title: '参考视频',
              status: 'idle',
              model: '上传',
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
      setToast(
        createsReferenceVideo
          ? '已拖出并连接空白参考视频节点，请上传视频。'
          : '已拖出并连接空白参考图节点，请上传图片。',
      )
    },
    [apiConfig.size, markDirty, nodes, setEdges, setNodes],
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
    [createInputNodeFromTarget, createReferenceOutput, flowInstance, nodes],
  )

  const closeContextMenu = useCallback(() => {
    setContextMenu(null)
  }, [])

  const handlePaneContextMenu = useCallback(
    (event: MouseEvent | ReactMouseEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null
      if (target?.closest('.canvas-context-menu')) return

      event.preventDefault()
      if (target?.closest('.workflow-node-shell, .workflow-node, .workflow-group, .react-flow__controls')) return

      const clientPosition = { x: event.clientX, y: event.clientY }
      const menuPosition = {
        x: Math.min(clientPosition.x, window.innerWidth - 210),
        y: Math.min(clientPosition.y, window.innerHeight - 256),
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
  function ensureGenerationPanelVisible(nodeId: string) {
    if (!flowInstance) return
    const element = document.querySelector(`.react-flow__node[data-id="${CSS.escape(nodeId)}"]`)
    const panel = element?.querySelector('.generation-panel')?.getBoundingClientRect()
    const card = element?.querySelector('.workflow-node')?.getBoundingClientRect()
    const canvas = element?.closest('.react-flow')?.getBoundingClientRect()
    if (!panel || !card || !canvas) return
    const left = Math.min(card.left, panel.left) - 16
    const right = Math.max(card.right, panel.right) + 16
    const top = card.top - 52
    const bottom = panel.bottom + 84
    if (left >= canvas.left && right <= canvas.right && top >= canvas.top && bottom <= canvas.bottom) return
    const zoom = flowInstance.getViewport().zoom
    const position = flowInstance.screenToFlowPosition({ x: left, y: top })
    const next = getViewportForBounds({ ...position, width: (right - left) / zoom, height: (bottom - top) / zoom }, canvas.width, canvas.height, 0.12, zoom, 0.04)
    void flowInstance.setViewport(next, { duration: 180 })
  }

  const captureSelectedMedia = useCallback((nodeIds?: string[]) => {
    const selectedIds = collectNodeFamilyIds(nodeIds ?? nodes.filter((node) => node.selected).map((node) => node.id), nodes)
    return createCanvasMediaClipboard(nodes.filter((node) => selectedIds.has(node.id)).map((node) => ({
      ...node, position: getAbsoluteNodePosition(node, nodes),
    })))
  }, [nodes])

  const copyNodeResults = useCallback(async (nodeIds?: string[]) => {
    const clipboard = captureSelectedMedia(nodeIds)
    if (!clipboard) return
    setMediaClipboard(clipboard)
    try {
      await navigator.clipboard.writeText(serializeCanvasMediaClipboard(clipboard))
    } catch {
      // The explicit canvas paste command remains available when system clipboard access is blocked.
    }
  }, [captureSelectedMedia])

  const pasteNodeResults = useCallback((clipboard: CanvasMediaClipboard, position?: XYPosition) => {
    const center = flowInstance?.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
    const origin = position || (center ? { x: center.x - 156, y: center.y - 180 } : { x: 120, y: 140 })
    const copies: WorkflowNode[] = createPastedMediaNodes(clipboard, origin, () => id('media-copy'), new Date().toLocaleString('zh-CN'))
    setNodes((current) => {
      const next: WorkflowNode[] = current.map((node) => ({ ...node, selected: false }))
      for (const copy of copies) {
        const freePosition = findFreeWorkflowNodePosition(copy.position, getWorkflowNodeSize(copy), next)
        next.push({ ...copy, position: freePosition })
      }
      return next
    })
    setSelectedNodeId(copies.at(-1)?.id || null)
    setContextMenu(null)
    markDirty()
    window.requestAnimationFrame(() => void flowInstance?.fitView({ nodes: copies, padding: 0.3, maxZoom: 1, duration: 240 }))
  }, [flowInstance, markDirty, setNodes])

  function handleAltMediaDragStart(event: MouseEvent | TouchEvent, node: WorkflowNode, draggedNodes: WorkflowNode[]) {
    activeAltMediaDrag = null
    if (!(event instanceof MouseEvent) || !event.altKey || event.button !== 0 || !mediaDataForCopy(node.data)) return

    const clipboard = createCanvasMediaClipboard(draggedNodes.map((item) => ({
      ...item,
      position: getAbsoluteNodePosition(item, nodes),
    })))
    if (!clipboard?.items.some((item) => item.sourceId === node.id)) return

    activeAltMediaDrag = {
      anchorNodeId: node.id,
      anchorStart: getAbsoluteNodePosition(node, nodes),
      clipboard,
      sourcePositions: new Map(draggedNodes.map((item) => [item.id, { ...item.position }])),
    }
  }

  function handleAltMediaDragStop(_event: MouseEvent | TouchEvent, node: WorkflowNode, draggedNodes: WorkflowNode[]) {
    const drag = activeAltMediaDrag
    activeAltMediaDrag = null
    if (!drag || drag.anchorNodeId !== node.id) return

    const movedById = new Map(draggedNodes.map((item) => [item.id, item]))
    const movedNodeValues = nodes.map((item) => {
      const moved = movedById.get(item.id)
      return moved ? { ...item, position: { ...moved.position } } : item
    })
    const movedAnchor = movedNodeValues.find((item) => item.id === drag.anchorNodeId)
    if (!movedAnchor) return

    const anchorEnd = getAbsoluteNodePosition(movedAnchor, movedNodeValues)
    const copies: WorkflowNode[] = createDraggedMediaNodes(
      drag.clipboard,
      { x: anchorEnd.x - drag.anchorStart.x, y: anchorEnd.y - drag.anchorStart.y },
      () => id('media-copy'),
      new Date().toLocaleString('zh-CN'),
    )
    if (!copies.length) return

    setNodes((current) => [
      ...current.map((item) => {
        const sourcePosition = drag.sourcePositions.get(item.id)
        return {
          ...item,
          ...(sourcePosition ? { position: { ...sourcePosition } } : {}),
          selected: false,
        }
      }),
      ...copies,
    ])
    setSelectedNodeId(copies.at(-1)?.id || null)
    markDirty()
    const mediaLabel = copies.every((copy) => copy.data.kind === 'video-reference')
      ? '视频'
      : copies.every((copy) => copy.data.kind === 'reference')
        ? '图像'
        : '媒体'
    setToast(`已拖出${copies.length > 1 ? ` ${copies.length} 个` : ''}${mediaLabel}副本，提示词已保留。`)
  }

  const nodesWithActions = nodes.map((node) => {
    const incomingEdges = edges.filter((edge) => edge.target === node.id)
    const imageInputEdges = incomingEdges.filter(
      (edge) => isImageInputHandle(edge.targetHandle) || (
        !edge.targetHandle &&
        nodeKindById.get(edge.source) !== 'prompt' &&
        nodeKindById.get(edge.source) !== 'video-reference'
      ),
    )
    const videoInputEdges = incomingEdges.filter(
      (edge) => isVideoInputHandle(edge.targetHandle) || (!edge.targetHandle && nodeKindById.get(edge.source) === 'video-reference'),
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
    const connectedVideoIndexes = new Set(
      videoInputEdges.map((edge, index) => videoInputHandleIndex(edge.targetHandle) ?? index + 1),
    )
    const highestConnectedVideoIndex = Math.max(0, ...connectedVideoIndexes)
    const videoModel = node.data.kind === 'video'
      ? findApiMartVideoModel(node.data.model || apiConfig.videoModel)
      : null
    const visibleVideoSlotCount = videoModel?.maxReferenceVideos
      ? Math.min(videoModel.maxReferenceVideos, Math.max(1, highestConnectedVideoIndex + 1))
      : 0
    const videoInputSlots = Array.from({ length: visibleVideoSlotCount }, (_, index) => ({
      id: `${videoInputHandlePrefix}${index + 1}`,
      index: index + 1,
      connected: connectedVideoIndexes.has(index + 1),
    }))
    const promptMentionOptions = node.data.kind === 'image' || node.data.kind === 'video'
      ? promptMentionOptionsForNode(node.id, nodes, edges)
      : undefined

    return {
      ...node,
      data: {
        ...node.data,
        apiMode: apiConfig.mode,
        generationPanelOpen: selectedNodeId === node.id,
        onEnsureGenerationPanelVisible: ensureGenerationPanelVisible,
        generationModelOptions: node.data.kind === 'video' ? apiMartVideoModels : apiConfig.mode === 'apimart' ? apiMartModels : apiConfig.mode === 'grsai'
          ? grsAiModelGroups.flatMap((group) => group.models.map((model) => ({ id: grsAiModelSelectionValue(model), label: model.label })))
          : apiConfig.mode === 'change2pro' && change2ProModels.length
            ? change2ProModels.map((model) => ({ id: model.id, label: change2ProModelLabel(model.id) }))
            : [{ id: apiConfig.model, label: apiModelDisplayName(apiConfig.model) || '本地模拟' }],
        imageResolutionOptions: apiConfig.mode === 'apimart' ? findApiMartModel(node.data.model || apiConfig.model).resolutions : apiConfig.mode === 'change2pro' && change2ProSupportsImageSize(apiConfig.model) ? change2ProImageSizes : [],
        model: node.data.kind === 'video'
          ? (node.data.model || apiConfig.videoModel)
          : node.data.kind === 'image'
            ? (apiConfig.mode === 'apimart' ? node.data.model || apiConfig.model : apiConfig.model)
            : (node.data.kind === 'repaint' || node.data.kind === 'outpaint')
            ? apiConfig.model
            : node.data.model,
        imageSize: node.data.kind === 'image' ? (apiConfig.mode === 'apimart' ? node.data.imageSize || apiConfig.imageSize : apiConfig.imageSize) : node.data.imageSize,
        imageInputConnected: imageInputEdges.length > 0,
        imageInputSlots,
        videoInputConnected: videoInputEdges.length > 0,
        videoInputSlots,
        promptMentionOptions,
        outputConnected: edges.some((edge) => edge.source === node.id),
        memberCount: node.data.kind === 'group' ? nodes.filter((item) => item.parentId === node.id).length : undefined,
        onDelete: deleteNode,
        onDownload: downloadNodeImage,
        onCopyResult: (nodeId: string) => void copyNodeResults([nodeId]),
        resultCopied: mediaClipboard?.items.some((item) => item.sourceId === node.id),
        onRevealImage: (nodeId: string) => void revealNodeImage(nodeId),
        onReplaceImage: replaceReferenceImage,
        onReplaceVideo: (nodeId: string, file: File) => void replaceReferenceVideo(nodeId, file),
        onGenerate: (nodeId: string) => void generateFromNode(nodeId),
        onChangeImageModel: apiConfig.mode === 'apimart' ? changeNodeImageModel : (_nodeId: string, model: string) => updateApiConfig({ model }),
        onChangeImageSize: apiConfig.mode === 'apimart' ? changeNodeImageSize : (_nodeId: string, imageSize: ImageResolutionTier) => updateApiConfig({ imageSize }),
        onChangeVideoModel: changeNodeVideoModel,
        onChangeSize: changeNodeSize,
        onChangeVideoResolution: changeNodeVideoResolution,
        onChangeVideoDuration: changeNodeVideoDuration,
        onOpenLightDirection: openLightDirectionEditor,
        onEditModel3D: (nodeId: string) => void openModel3DFromNode(nodeId),
        onEditSketch: (nodeId: string) => {
          const source = nodes.find(node => node.id === nodeId)
          if (source?.data.sketch) setSketchSession({ nodeId, document: source.data.sketch })
        },
        onOpenElementEdit: (nodeId: string) => void openElementEditFromNode(nodeId),
        onOpenMultiAngle: (nodeId: string) => void openMultiAngleFromNode(nodeId),
        onChangePrompt: changeNodePrompt,
        onLocatePromptMention: locatePromptMention,
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
    const referenceImageSources = incomingInputs
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
    const referenceImageUrls = referenceImageSources.map(({ sourceNode }) => sourceNode.data.imageUrl as string)
    const trimmed = generationPromptText(node.data)

    if (!trimmed) {
      setToast('请在图像生成框下方填写提示词。')
      return
    }

    const outputSize = node.data.size || apiConfig.size || defaultApiConfig.size
    const imageModel = apiConfig.mode === 'apimart'
      ? findApiMartModel(node.data.model || apiConfig.model)
      : null
    const selectedModel = imageModel?.id || apiConfig.model
    const imageSize = imageModel
      ? (node.data.imageSize && imageModel.resolutions.includes(node.data.imageSize)
          ? node.data.imageSize
          : imageModel.defaultResolution)
      : apiConfig.imageSize
    if (imageModel && referenceImageUrls.length > imageModel.maxReferenceImages) {
      const message = `${imageModel.label} 最多支持 ${imageModel.maxReferenceImages} 张参考图。`
      updateNodeData(nodeId, { status: 'error', error: message })
      setToast(message)
      return
    }
    let compiledPrompt = trimmed
    try {
      compiledPrompt = compilePromptMentions(
        trimmed,
        node.data.promptMentions || [],
        referenceImageSources.map(({ sourceNode }) => sourceNode.id),
        [],
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : '提示词引用校验失败'
      updateNodeData(nodeId, { status: 'error', error: message })
      setToast(message)
      return
    }
    const configForNode = { ...apiConfig, model: selectedModel, imageSize, size: outputSize }
    const createdAt = new Date().toLocaleString('zh-CN')

    setIsGenerating(true)
    updateNodeData(nodeId, {
      status: 'generating',
      error: undefined,
      model: selectedModel,
      imageSize,
      size: outputSize,
    })

    try {
      const orderedPrompt = promptWithReferenceImageOrder(compiledPrompt, referenceImageUrls.length)
      const connectedLightDirection = incomingInputs
        .filter(
          ({ edge, sourceNode }) =>
            isImageInputHandle(edge.targetHandle) || (!edge.targetHandle && sourceNode.data.kind !== 'prompt'),
        )
        .map(({ sourceNode }) => sourceNode.data.lightDirection)
        .find((direction) => normalizeLightDirection(direction).enabled)
      const ownLightDirection = normalizeLightDirection(node.data.lightDirection)
      const lightAdjustedPrompt = promptWithLightDirection(
        orderedPrompt,
        ownLightDirection.enabled ? ownLightDirection : connectedLightDirection,
      )
      const imageUrl = await requestGeneratedImage(lightAdjustedPrompt, configForNode, referenceImageUrls)
      updateNodeData(nodeId, {
        imageUrl,
        status: 'done',
        error: undefined,
        model: selectedModel,
        imageSize,
        size: outputSize,
      })
      setHistory((current) => [
        {
          id: nodeId,
          prompt: trimmed,
          model: selectedModel,
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
          model: selectedModel,
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
    const referenceImageSources = incomingSources
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
    const referenceImageUrls = referenceImageSources.map(({ sourceNode }) => sourceNode.data.imageUrl as string)
    const referenceVideoSources = incomingSources
      .filter(
        ({ edge, sourceNode }) =>
          Boolean(sourceNode.data.videoUrl) &&
          (isVideoInputHandle(edge.targetHandle) || sourceNode.data.kind === 'video-reference'),
      )
      .sort((left, right) => {
        const leftIndex = videoInputHandleIndex(left.edge.targetHandle)
        const rightIndex = videoInputHandleIndex(right.edge.targetHandle)
        if (leftIndex !== null && rightIndex !== null && leftIndex !== rightIndex) return leftIndex - rightIndex
        if (leftIndex !== null && rightIndex === null) return -1
        if (leftIndex === null && rightIndex !== null) return 1
        return left.edgeOrder - right.edgeOrder
      })
    const referenceVideoUrls = referenceVideoSources.map(({ sourceNode }) => sourceNode.data.videoUrl as string)
    const trimmed = generationPromptText(node.data)

    if (!trimmed) {
      updateNodeData(nodeId, { status: 'error', error: '请在视频生成框下方填写提示词。' })
      return
    }

    if (apiConfig.mode !== 'apimart') {
      updateNodeData(nodeId, { status: 'error', error: '请在 API 设置中选择“API Mart 图像 / 视频”并填写 API Key。' })
      return
    }

    const outputSize = node.data.size || apiConfig.size || defaultApiConfig.size
    const videoModel = findApiMartVideoModel(node.data.model || apiConfig.videoModel)
    const videoResolution = node.data.videoResolution && videoModel.resolutions.includes(node.data.videoResolution)
      ? node.data.videoResolution
      : videoModel.defaultResolution
    const requestedVideoDuration = Number(node.data.videoDuration)
    const videoDuration = Number.isFinite(requestedVideoDuration)
      ? Math.min(videoModel.maxDuration, Math.max(videoModel.minDuration, Math.round(requestedVideoDuration)))
      : videoModel.defaultDuration
    if (referenceVideoUrls.length > videoModel.maxReferenceVideos) {
      updateNodeData(nodeId, {
        status: 'error',
        error: `${videoModel.label} 最多支持 ${videoModel.maxReferenceVideos} 个参考视频。`,
      })
      return
    }
    const referenceVideoDuration = referenceVideoSources.reduce(
      (total, { sourceNode }) => total + (sourceNode.data.videoDurationSeconds || 0),
      0,
    )
    const maxReferenceDuration = videoModel.id === 'seedance-2.0' ? 15 : 30
    if (referenceVideoDuration > maxReferenceDuration + 0.05) {
      updateNodeData(nodeId, {
        status: 'error',
        error: `${videoModel.label} 的参考视频总时长不能超过 ${maxReferenceDuration} 秒。`,
      })
      return
    }
    let compiledPrompt = trimmed
    try {
      compiledPrompt = compilePromptMentions(
        trimmed,
        node.data.promptMentions || [],
        referenceImageSources.map(({ sourceNode }) => sourceNode.id),
        referenceVideoSources.map(({ sourceNode }) => sourceNode.id),
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : '提示词引用校验失败'
      updateNodeData(nodeId, { status: 'error', error: message })
      setToast(message)
      return
    }
    const configForNode = {
      ...apiConfig,
      videoModel: videoModel.id,
      size: outputSize,
      videoResolution,
      videoDuration,
    }
    const createdAt = new Date().toLocaleString('zh-CN')

    setIsGenerating(true)
    updateNodeData(nodeId, {
      status: 'generating',
      error: undefined,
      model: videoModel.id,
      size: outputSize,
      videoResolution,
      videoDuration,
    })

    try {
      const orderedPrompt = promptWithReferenceVideoOrder(
        promptWithReferenceImageOrder(compiledPrompt, referenceImageUrls.length),
        referenceVideoUrls.length,
      )
      const videoUrl = await requestGeneratedVideo(orderedPrompt, configForNode, referenceImageUrls, referenceVideoUrls)
      updateNodeData(nodeId, {
        videoUrl,
        status: 'done',
        error: undefined,
        model: videoModel.id,
        size: outputSize,
        videoResolution,
        videoDuration,
      })
      setHistory((current) => [
        {
          id: nodeId,
          prompt: trimmed,
          model: videoModel.id,
          size: outputSize,
          createdAt,
          mediaType: 'video',
          videoUrl,
          status: '成功',
        },
        ...current,
      ])
      const referenceSummary = referenceImageUrls.length
        ? `，已读取 ${referenceImageUrls.length} 张参考图`
        : ''
      const referenceVideoSummary = referenceVideoUrls.length
        ? `，已读取 ${referenceVideoUrls.length} 个参考视频`
        : ''
      setToast(`已使用 ${videoModel.label} 生成 ${videoDuration} 秒·${videoResolution} 视频${referenceSummary}${referenceVideoSummary}。`)
    } catch (error) {
      const message = error instanceof Error ? error.message : '视频生成失败'
      updateNodeData(nodeId, { status: 'error', error: message })
      setHistory((current) => [
        {
          id: nodeId,
          prompt: trimmed,
          model: videoModel.id,
          size: outputSize,
          createdAt,
          mediaType: 'video',
          status: '失败',
        },
        ...current,
      ])
      setToast(message)
    } finally {
      setIsGenerating(false)
    }
  }

  async function executeElementEditGeneration(
    node: WorkflowNode,
    sourceImageUrl: string,
    operations: ElementEditOperation[],
    sourceSize?: string,
  ) {
    const nodeId = node.id
    const validOperations = operations.filter((operation) => operation.maskUrl && operation.prompt.trim())
    if (!validOperations.length) {
      updateNodeData(nodeId, { status: 'error', error: '没有可执行的局部标记，请重新打开元素编辑。' })
      return
    }

    const requestSize = node.data.elementEditRequestSize || sourceSize || node.data.size || apiConfig.size || defaultApiConfig.size
    const outputSize = node.data.sourceWidth && node.data.sourceHeight
      ? `${node.data.sourceWidth}x${node.data.sourceHeight}`
      : node.data.size || sourceSize || apiConfig.size || defaultApiConfig.size
    const configForNode = { ...apiConfig, size: requestSize }
    const createdAt = new Date().toLocaleString('zh-CN')
    const summaryPrompt = validOperations.map((operation) => `${operation.label}：${operation.prompt.trim()}`).join('\n')

    setIsGenerating(true)
    updateNodeData(nodeId, {
      status: 'generating',
      error: undefined,
      prompt: summaryPrompt,
      elementEditOperations: validOperations,
      elementEditRequestSize: requestSize,
      model: apiConfig.model,
      size: outputSize,
    })

    try {
      let workingImageUrl = sourceImageUrl
      for (let index = 0; index < validOperations.length; index += 1) {
        const operation = validOperations[index]
        setToast(`正在处理 ${operation.label}（${index + 1}/${validOperations.length}）…`)
        const coloredMaskUrl = await recolorRepaintMask(operation.maskUrl, 'blue')
        const stepPrompt = repaintPromptWithColor(
          `${operation.label}附近的局部修改：${operation.prompt.trim()}。只处理蓝色蒙版覆盖范围，保持其它区域的内容、构图、光影和细节不变。`,
          'blue',
        )
        const referenceImageUrl = await imageAsDataUrl(workingImageUrl)
        const generatedImageUrl = await requestGeneratedImage(stepPrompt, configForNode, [referenceImageUrl, coloredMaskUrl])
        workingImageUrl = await compositeRepaintResult(workingImageUrl, generatedImageUrl, coloredMaskUrl)
      }

      updateNodeData(nodeId, {
        imageUrl: workingImageUrl,
        sourceImageUrl,
        status: 'done',
        error: undefined,
        prompt: summaryPrompt,
        elementEditOperations: validOperations,
        elementEditRequestSize: requestSize,
        model: apiConfig.model,
        size: outputSize,
      })
      setHistory((current) => [
        {
          id: nodeId,
          prompt: summaryPrompt,
          model: apiConfig.model,
          size: outputSize,
          createdAt,
          imageUrl: workingImageUrl,
          status: '成功',
        },
        ...current,
      ])
      setToast(
        apiConfig.mode === 'mock'
          ? `已按 ${validOperations.length} 处局部描述生成模拟结果，结果已写入新图片节点。`
          : `已按 ${validOperations.length} 处局部描述完成元素编辑，结果已写入新图片节点。`,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : '元素编辑生成失败'
      updateNodeData(nodeId, { status: 'error', error: message })
      setHistory((current) => [
        {
          id: nodeId,
          prompt: summaryPrompt,
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

  async function submitElementEdit(result: ElementEditResult) {
    const session = elementEditSession
    if (!session) return
    const sourceNode = nodes.find((item) => item.id === session.nodeId)
    if (!sourceNode?.data.imageUrl) throw new Error('原图已不在画布中，请重新打开元素编辑。')

    const sourceWidth = Math.max(1, Math.round(result.sourceWidth))
    const sourceHeight = Math.max(1, Math.round(result.sourceHeight))
    const outputSize = `${sourceWidth}x${sourceHeight}`
    const requestSize = nearestAspectRatioOption(sourceWidth, sourceHeight).size
    const resultNodeId = id('element-edit-result')
    const createdAt = new Date().toLocaleString('zh-CN')
    const sourcePosition = getAbsoluteNodePosition(sourceNode, nodes)
    const position = {
      x: sourcePosition.x + 410,
      y: sourcePosition.y + 36,
    }
    const resultNode: WorkflowNode = {
      id: resultNodeId,
      type: 'workflow',
      position,
      data: {
        kind: 'image',
        title: '元素编辑结果',
        prompt: result.prompt,
        sourceImageUrl: sourceNode.data.imageUrl,
        maskUrl: result.maskUrl,
        elementEditOperations: result.operations,
        elementEditRequestSize: requestSize,
        sourceWidth,
        sourceHeight,
        status: 'generating',
        model: apiConfig.model,
        imageSize: apiConfig.imageSize,
        lightDirection: { ...defaultLightDirection },
        size: outputSize,
        createdAt,
      },
    }

    setNodes((current) => [...current.map((item) => ({ ...item, selected: false })), { ...resultNode, selected: true }])
    setEdges((current) => normalizeImageInputEdges([
      ...current,
      {
        id: id('edge'),
        source: sourceNode.id,
        sourceHandle: 'output',
        target: resultNodeId,
        targetHandle: `${imageInputHandlePrefix}1`,
        animated: true,
        markerEnd: { type: MarkerType.ArrowClosed, color: workflowEdgeColor },
        style: { stroke: workflowEdgeColor, strokeWidth: 1.6 },
      },
    ], [...nodes, resultNode]))
    setSelectedNodeId(resultNodeId)
    setElementEditSession(null)
    markDirty()
    setToast(`已创建并连接结果图片节点，正在处理 ${result.operations.length} 处局部描述…`)
    window.setTimeout(() => {
      void flowInstance?.fitView({
        nodes: [{ id: sourceNode.id }, { id: resultNodeId }],
        padding: 0.2,
        maxZoom: 0.92,
        duration: 180,
      })
    }, 0)
    void executeElementEditGeneration(resultNode, sourceNode.data.imageUrl, result.operations, requestSize)
  }

  async function executeMultiAngleGeneration(
    node: WorkflowNode,
    sourceImageUrl: string,
    result: MultiAngleResult,
  ) {
    const nodeId = node.id
    const outputSize = `${result.sourceWidth}x${result.sourceHeight}`
    const requestSize = nearestAspectRatioOption(result.sourceWidth, result.sourceHeight).size
    const configForNode = {
      ...apiConfig,
      model: node.data.model || apiConfig.model,
      imageSize: node.data.imageSize || apiConfig.imageSize,
      size: requestSize,
    }
    const createdAt = new Date().toLocaleString('zh-CN')

    setIsGenerating(true)
    updateNodeData(nodeId, {
      status: 'generating',
      error: undefined,
      prompt: result.prompt,
      generationPrompt: result.prompt,
      multiAngleSettings: result,
      sourceWidth: result.sourceWidth,
      sourceHeight: result.sourceHeight,
      size: outputSize,
    })

    try {
      const generatedImageUrl = await requestGeneratedImage(result.prompt, configForNode, [sourceImageUrl])
      const imageUrl = await fitImageToExactSize(generatedImageUrl, result.sourceWidth, result.sourceHeight)
      updateNodeData(nodeId, {
        imageUrl,
        sourceImageUrl,
        status: 'done',
        error: undefined,
        prompt: result.prompt,
        generationPrompt: result.prompt,
        multiAngleSettings: result,
        model: configForNode.model,
        imageSize: configForNode.imageSize,
        sourceWidth: result.sourceWidth,
        sourceHeight: result.sourceHeight,
        size: outputSize,
      })
      setHistory((current) => [
        {
          id: nodeId,
          prompt: result.prompt,
          model: configForNode.model,
          size: outputSize,
          createdAt,
          imageUrl,
          status: '成功',
        },
        ...current,
      ])
      setToast(
        apiConfig.mode === 'mock'
          ? `已生成“${result.presetLabel}”模拟结果，并保持 ${result.sourceWidth} × ${result.sourceHeight}px。`
          : `“${result.presetLabel}”生成完成，并保持 ${result.sourceWidth} × ${result.sourceHeight}px。`,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : '多角度画面生成失败'
      updateNodeData(nodeId, { status: 'error', error: message })
      setHistory((current) => [
        {
          id: nodeId,
          prompt: result.prompt,
          model: configForNode.model,
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

  async function submitMultiAngle(result: MultiAngleResult) {
    const session = multiAngleSession
    if (!session) return
    const sourceNode = nodes.find((item) => item.id === session.nodeId)
    if (!sourceNode?.data.imageUrl) throw new Error('原图已不在画布中，请重新打开多角度编辑器。')

    const sourcePosition = getAbsoluteNodePosition(sourceNode, nodes)
    const outputSize = `${result.sourceWidth}x${result.sourceHeight}`
    const imageModel = apiConfig.mode === 'apimart'
      ? findApiMartModel(sourceNode.data.kind === 'image' ? sourceNode.data.model || apiConfig.model : apiConfig.model)
      : null
    const selectedModel = imageModel?.id || apiConfig.model
    const imageSize = imageModel
      ? (sourceNode.data.imageSize && imageModel.resolutions.includes(sourceNode.data.imageSize)
          ? sourceNode.data.imageSize
          : imageModel.defaultResolution)
      : apiConfig.imageSize
    const resultNodeId = id('multi-angle-result')
    const resultNode: WorkflowNode = {
      id: resultNodeId,
      type: 'workflow',
      position: findFreeWorkflowNodePosition(
        { x: sourcePosition.x + 430, y: sourcePosition.y + 20 },
        { width: 330, height: 500 },
        nodes,
      ),
      selected: true,
      data: {
        kind: 'image',
        title: '多角度结果',
        prompt: result.prompt,
        generationPrompt: result.prompt,
        sourceImageUrl: sourceNode.data.imageUrl,
        multiAngleSettings: result,
        sourceWidth: result.sourceWidth,
        sourceHeight: result.sourceHeight,
        status: 'generating',
        model: selectedModel,
        imageSize,
        lightDirection: { ...defaultLightDirection },
        size: outputSize,
        createdAt: new Date().toLocaleString('zh-CN'),
      },
    }

    setNodes((current) => [
      ...current.map((item) => ({ ...item, selected: false })),
      resultNode,
    ])
    setEdges((current) => normalizeImageInputEdges([
      ...current,
      {
        id: id('edge'),
        source: sourceNode.id,
        sourceHandle: 'output',
        target: resultNodeId,
        targetHandle: `${imageInputHandlePrefix}1`,
        animated: true,
        markerEnd: { type: MarkerType.ArrowClosed, color: workflowEdgeColor },
        style: { stroke: workflowEdgeColor, strokeWidth: 1.6 },
      },
    ], [...nodes, resultNode]))
    setSelectedNodeId(resultNodeId)
    setMultiAngleSession(null)
    markDirty()
    setToast(`已创建并连接“${result.presetLabel}”结果节点，正在生成…`)
    window.setTimeout(() => {
      void flowInstance?.fitView({
        nodes: [{ id: sourceNode.id }, { id: resultNodeId }],
        padding: 0.2,
        maxZoom: 0.92,
        duration: 180,
      })
    }, 0)
    void executeMultiAngleGeneration(resultNode, session.sourceImageUrl, result)
  }

  async function generateOutpaintInNode(nodeId: string) {
    const node = nodes.find((item) => item.id === nodeId)
    if (!node || node.data.kind !== 'outpaint') return

    const sourceNodes = edges
      .filter((edge) => edge.target === nodeId)
      .map((edge) => nodes.find((item) => item.id === edge.source))
      .filter((item): item is WorkflowNode => Boolean(item))
    const imageSourceNode = sourceNodes.find((item) => item.data.kind !== 'prompt' && item.data.imageUrl)
    const sourceImageUrl = imageSourceNode?.data.imageUrl || node.data.sourceImageUrl
    let sourceWidth = node.data.sourceWidth || 1024
    let sourceHeight = node.data.sourceHeight || 1024
    let outpaintInsets = node.data.outpaintInsets || defaultOutpaintInsets(sourceWidth, sourceHeight)
    const trimmed = node.data.prompt?.trim() || defaultOutpaintPrompt

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
    if (node?.data.kind === 'outpaint') {
      void generateOutpaintInNode(node.id)
      return
    }
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
        imageSize: apiConfig.imageSize,
        lightDirection: { ...defaultLightDirection },
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
        videoResolution: findApiMartVideoModel(apiConfig.videoModel).defaultResolution,
        videoDuration: findApiMartVideoModel(apiConfig.videoModel).defaultDuration,
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
    lightDirectionEnabled?: boolean
    toastMessage: string
  }) {
    const canvasCenter = flowInstance?.screenToFlowPosition(
      { x: window.innerWidth / 2, y: window.innerHeight / 2 },
      { snapToGrid: true, snapGrid: [24, 24] },
    ) ?? { x: 720, y: 460 }
    const createdAt = new Date().toLocaleString('zh-CN')
    const referenceNodeId = id('ref')
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
        lightDirection: options.outputKind === 'image'
          ? { ...defaultLightDirection, enabled: Boolean(options.lightDirectionEnabled) }
          : undefined,
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
        prompt: options.initialPrompt || '',
        status: 'idle',
        model: options.outputKind === 'video' ? apiConfig.videoModel : apiConfig.model,
        imageSize: options.outputKind === 'image' ? apiConfig.imageSize : undefined,
        lightDirection: options.outputKind === 'image' ? { ...defaultLightDirection } : undefined,
        size: apiConfig.size || defaultApiConfig.size,
        ...(options.outputKind === 'video'
          ? {
              videoResolution: findApiMartVideoModel(apiConfig.videoModel).defaultResolution,
              videoDuration: findApiMartVideoModel(apiConfig.videoModel).defaultDuration,
            }
          : {}),
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
    ]

    setNodes((current) => [
      ...current.map((node) => ({ ...node, selected: false })),
      referenceNode,
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
        nodes: [{ id: referenceNodeId }, { id: outputNodeId }],
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
      lightDirectionEnabled: true,
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

  function uploadReferenceVideoFromMenu() {
    if (contextMenu) pendingNodePositionRef.current = contextMenu.flowPosition
    closeContextMenu()
    referenceVideoInputRef.current?.click()
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

  async function applyImportedProject(projectValue: Partial<ProjectFile>) {
    const project = normalizeImportedProject(projectValue)
    if (project.model3DScenes && Object.keys(project.model3DScenes).length) {
      await saveModel3DScenes(project.model3DScenes)
    }
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
      await applyImportedProject(JSON.parse(text) as Partial<ProjectFile>)
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
        await applyImportedProject(payload.project)
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

  async function addReferenceVideo(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) {
      pendingNodePositionRef.current = null
      return
    }

    const nodePosition = pendingNodePositionRef.current ?? { x: 120 + nodes.length * 24, y: 140 + nodes.length * 24 }
    pendingNodePositionRef.current = null
    try {
      setToast('正在读取并缓存参考视频…')
      const metadata = await validateReferenceVideoFile(file)
      const videoUrl = await cacheReferenceVideoFile(file)
      const node: WorkflowNode = {
        id: id('video-ref'),
        type: 'workflow',
        position: nodePosition,
        selected: true,
        data: {
          kind: 'video-reference',
          title: '参考视频',
          videoUrl,
          videoDurationSeconds: metadata.duration,
          status: 'done',
          model: '上传',
          size: apiConfig.size,
          sourceName: file.name,
          createdAt: new Date().toLocaleString('zh-CN'),
        },
      }
      setNodes((current) => [...current.map((item) => ({ ...item, selected: false })), node])
      setSelectedNodeId(node.id)
      markDirty()
      setToast(`参考视频已加入画布：${file.name}`)
    } catch (error) {
      setToast(error instanceof Error ? error.message : '参考视频上传失败')
    }
  }

  useEffect(() => {
    const ignoreClipboardEvent = (event: ClipboardEvent) => {
      const target = event.target instanceof Element ? event.target : null
      return event.defaultPrevented || Boolean(target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) ||
        Boolean(showSettings || showModelStudio || sketchSession || elementEditSession || multiAngleSession || showHistoryPanel || historyMediaPreview || groupDialog || lightDirectionNodeId)
    }
    const handleCopyMedia = (event: ClipboardEvent) => {
      if (ignoreClipboardEvent(event) || window.getSelection()?.toString()) return
      const clipboard = captureSelectedMedia()
      if (!clipboard || !event.clipboardData) return
      const serialized = serializeCanvasMediaClipboard(clipboard)
      event.clipboardData.setData(canvasMediaClipboardType, serialized)
      event.clipboardData.setData('text/plain', serialized)
      event.preventDefault()
      setMediaClipboard(clipboard)
    }
    const handlePasteImage = (event: ClipboardEvent) => {
      if (ignoreClipboardEvent(event)) return

      const clipboardData = event.clipboardData
      const copiedMedia = parseCanvasMediaClipboard(clipboardData?.getData(canvasMediaClipboardType) || clipboardData?.getData('text/plain') || '')
      if (copiedMedia) {
        event.preventDefault()
        pasteNodeResults(copiedMedia, contextMenu?.flowPosition)
        return
      }
      const itemFile = Array.from(clipboardData?.items || [])
        .find((item) => item.kind === 'file' && item.type.startsWith('image/'))
        ?.getAsFile()
      const file = itemFile || Array.from(clipboardData?.files || []).find((candidate) => candidate.type.startsWith('image/'))
      if (!file) return

      event.preventDefault()
      const canvasCenter = flowInstance?.screenToFlowPosition(
        { x: window.innerWidth / 2, y: window.innerHeight / 2 },
        { snapToGrid: true, snapGrid: [24, 24] },
      )
      const offset = (nodes.length % 6) * 20
      const nodePosition = canvasCenter
        ? { x: canvasCenter.x - 165 + offset, y: canvasCenter.y - 190 + offset }
        : { x: 120 + nodes.length * 24, y: 140 + nodes.length * 24 }

      void imageFileAsDataUrl(file)
        .then((imageUrl) => {
          const extension = file.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png'
          const sourceName = file.name || `剪贴板图片-${Date.now()}.${extension}`
          const node: WorkflowNode = {
            id: id('ref'),
            type: 'workflow',
            position: nodePosition,
            selected: true,
            data: {
              kind: 'reference',
              title: '参考图像',
              imageUrl,
              status: 'done',
              model: '剪贴板',
              size: apiConfig.size,
              sourceName,
              createdAt: new Date().toLocaleString('zh-CN'),
            },
          }

          setNodes((current) => [...current.map((item) => ({ ...item, selected: false })), node])
          setSelectedNodeId(node.id)
          markDirty()
          setToast('剪贴板图片已粘贴为参考图。')
        })
        .catch((error) => setToast(error instanceof Error ? error.message : '粘贴图片失败，请重新复制。'))
    }

    window.addEventListener('copy', handleCopyMedia)
    window.addEventListener('paste', handlePasteImage)
    return () => {
      window.removeEventListener('copy', handleCopyMedia)
      window.removeEventListener('paste', handlePasteImage)
    }
  }, [
    apiConfig.size,
    captureSelectedMedia,
    contextMenu,
    elementEditSession,
    flowInstance,
    groupDialog,
    historyMediaPreview,
    lightDirectionNodeId,
    markDirty,
    multiAngleSession,
    nodes.length,
    setNodes,
    pasteNodeResults,
    showHistoryPanel,
    showModelStudio,
    sketchSession,
    showSettings,
  ])

  function openNewModel3DStudio() {
    setModel3DEditSession({ nodeId: null, sceneId: null, scene: null })
    setShowModelStudio(true)
  }

  const sketchModels: SketchModelOption[] = apiConfig.mode === 'apimart'
    ? apiMartModels
    : [{ id: apiConfig.model, label: apiConfig.mode === 'mock' ? '本地模拟（不调用 API）' : apiModelDisplayName(apiConfig.model), resolutions: [apiConfig.mode === 'mock' ? '1K' : apiConfig.imageSize] }]

  async function saveSketchToCanvas(result: { document: SketchDocument; imageUrl: string }, generate: boolean) {
    if (generate && apiConfig.mode !== 'mock' && !apiConfig.apiKey.trim()) throw new Error('请先在 API 设置中填写密钥。')
    // Persist image assets locally; the editable elements remain structured project data.
    const imageUrl = await cacheCanvasImage(result.imageUrl)
    const sketch: SketchDocument = {
      ...result.document,
      layers: await Promise.all(result.document.layers.map(async layer => ({
        ...layer,
        imageUrl: layer.imageUrl?.startsWith('data:') ? await cacheCanvasImage(layer.imageUrl) : layer.imageUrl,
      }))),
    }
    const source = nodes.find(node => node.id === sketchSession?.nodeId)
    const sourceId = source?.id || id('ref')
    const createdAt = new Date().toLocaleString('zh-CN')
    const size = `${sketch.width}x${sketch.height}`
    const referenceSize = { width: 312, height: Math.ceil(288 * sketch.height / sketch.width + 120) }
    const outputNodeSize = { width: 330, height: Math.ceil(306 * sketch.height / sketch.width + 450) }
    const center = flowInstance?.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 }) || { x: 200, y: 180 }
    const position = source ? getAbsoluteNodePosition(source, nodes) : findFreeWorkflowNodePosition({ x: center.x - 156, y: center.y - 180 }, referenceSize, nodes)
    const sourceData: WorkflowNodeData = { ...(source?.data || {}), kind: 'reference', title: '分层手绘参考图', sourceName: '分层手绘参考图.png', status: 'done', model: '手绘画板', size, sketch, imageUrl, createdAt }
    const reference: WorkflowNode = source ? { ...source, selected: !generate, data: sourceData } : { id: sourceId, type: 'workflow', position, selected: !generate, data: sourceData }
    const referenceFootprint = { ...reference, measured: referenceSize }
    const outputId = id('image')
    const generationPrompt = `${sketchGenerationInstruction}\n\n用户要求：\n${sketch.prompt.trim()}`
    const config: ApiConfig = { ...apiConfig, model: sketch.model, imageSize: sketch.imageSize, size }
    const baseNodes = nodes.filter(node => node.id !== sourceId)
    const extras: WorkflowNode[] = []
    if (generate) {
      const outputPosition = findFreeWorkflowNodePosition({ x: position.x + 500, y: position.y + 50 }, outputNodeSize, [...baseNodes, referenceFootprint])
      extras.push({ id: outputId, type: 'workflow', position: outputPosition, selected: true, data: { kind: 'image', title: '手绘生成图像', model: sketch.model, imageSize: sketch.imageSize, size, prompt: generationPrompt, generationPrompt, status: 'generating', createdAt } })
    }
    setNodes(current => [...current.filter(node => node.id !== sourceId).map(node => ({ ...node, selected: false })), reference, ...extras])
    if (generate) setEdges(current => [...current, ...[
      { source: sourceId, targetHandle: `${imageInputHandlePrefix}1` },
    ].map(input => ({ id: id('edge'), ...input, sourceHandle: 'output', target: outputId, animated: true, markerEnd: { type: MarkerType.ArrowClosed, color: workflowEdgeColor }, style: { stroke: workflowEdgeColor } }))])
    setSketchSession(null)
    setSelectedNodeId(generate ? outputId : sourceId)
    markDirty()
    setToast(generate ? '已保存分层手绘，正在按草稿生成图像。' : '手绘已保存，点击参考图可继续编辑；保存项目 ZIP 可保留全部图层和模型。')
    // Wait for newly mounted nodes (including portrait previews) to be measured.
    // Fitting the old, empty graph can otherwise leave the new workflow off-screen.
    const focusNodes = [{ id: sourceId }, ...extras.map(node => ({ id: node.id }))]
    let previousMeasurements = ''
    function focusSketchWorkflow(attempt = 0) {
      if (!flowInstance) return
      const measured = focusNodes.map(node => flowInstance.getNode(node.id)?.measured)
      const ready = measured.every(size => size?.width && size.height)
      const signature = JSON.stringify(measured)
      if (ready && signature === previousMeasurements) {
        void flowInstance.fitView({ nodes: focusNodes, padding: 0.22, maxZoom: 0.9, duration: 200 })
      } else if (attempt < 30) {
        previousMeasurements = signature
        window.setTimeout(() => focusSketchWorkflow(attempt + 1), 50)
      }
    }
    window.setTimeout(() => focusSketchWorkflow(), 50)
    if (!generate) return
    setIsGenerating(true)
    void (async () => {
      try {
        const generatedImage = await requestGeneratedImage(generationPrompt, config, [imageUrl])
        updateNodeData(outputId, { imageUrl: generatedImage, status: 'done', error: undefined })
        setHistory(current => [{ id: outputId, prompt: generationPrompt, model: sketch.model, size, createdAt, imageUrl: generatedImage, status: '成功' }, ...current])
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : '手绘图像生成失败'
        updateNodeData(outputId, { status: 'error', error: message })
        setHistory(current => [{ id: outputId, prompt: generationPrompt, model: sketch.model, size, createdAt, status: '失败' }, ...current])
        setToast(message)
      } finally { setIsGenerating(false) }
    })()
  }

  async function openModel3DFromNode(nodeId: string) {
    const node = nodes.find((item) => item.id === nodeId)
    const sceneId = node?.data.model3DSceneId
    if (!node || !sceneId) return
    setToast('正在打开这个参考图的 3D 场景…')
    const scene = await readModel3DScene(sceneId)
    if (!scene) {
      setToast('没有找到这张参考图关联的 3D 场景，可能已清理浏览器数据。')
      return
    }
    setModel3DEditSession({ nodeId, sceneId, scene })
    setShowModelStudio(true)
    setToast('已恢复上次编辑的模型、相机和灯光。')
  }

  function closeModel3DStudio() {
    setShowModelStudio(false)
    setModel3DEditSession({ nodeId: null, sceneId: null, scene: null })
  }

  async function addModelPreviewToCanvas(result: {
    dataUrl: string
    fileName: string
    width: number
    height: number
    sceneId: string
    scene: SavedModel3DScene
  }) {
    await saveModel3DScene(result.sceneId, result.scene)
    const editedNodeId = model3DEditSession.nodeId
    if (editedNodeId) {
      setNodes((current) => current.map((item) => (
        item.id === editedNodeId
          ? {
              ...item,
              selected: true,
              data: {
                ...item.data,
                imageUrl: result.dataUrl,
                model3DSceneId: result.sceneId,
                size: `${result.width}x${result.height}`,
                sourceName: result.fileName,
                status: 'done',
                error: undefined,
                createdAt: new Date().toLocaleString('zh-CN'),
              },
            }
          : { ...item, selected: false }
      )))
      setSelectedNodeId(editedNodeId)
      markDirty()
      setToast(`已保存 3D 场景并更新 ${result.width} × ${result.height} 参考图。`)
      window.setTimeout(() => {
        void flowInstance?.fitView({ nodes: [{ id: editedNodeId }], padding: 0.32, maxZoom: 1, duration: 220 })
      }, 0)
      return
    }

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
        model3DSceneId: result.sceneId,
        size: `${result.width}x${result.height}`,
        sourceName: result.fileName,
        createdAt: new Date().toLocaleString('zh-CN'),
      },
    }

    setNodes((current) => [...current.map((item) => ({ ...item, selected: false })), node])
    setSelectedNodeId(node.id)
    markDirty()
    setToast(`3D 场景已自动保存，并作为 ${result.width} × ${result.height} 参考图加入画板。`)
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
      const previous = nodes.find((node) => node.id === nodeId)
      const previousSceneIds = [previous?.data.model3DSceneId, ...sketchSceneIds(previous?.data.sketch)]
      const remainingSceneIds = new Set(nodes.filter(node => node.id !== nodeId).flatMap(node => [node.data.model3DSceneId, ...sketchSceneIds(node.data.sketch)]))
      updateNodeData(nodeId, {
        imageUrl: String(reader.result),
        model3DSceneId: undefined,
        sketch: undefined,
        sourceName: file.name,
        status: 'done',
        error: undefined,
        createdAt: new Date().toLocaleString('zh-CN'),
      })
      for (const sceneId of previousSceneIds) {
        if (sceneId && !remainingSceneIds.has(sceneId)) void deleteModel3DScene(sceneId)
      }
      setToast(`已替换参考图：${file.name}`)
    }
    reader.onerror = () => setToast('替换失败，请重新选择图片。')
    reader.readAsDataURL(file)
  }

  async function replaceReferenceVideo(nodeId: string, file: File) {
    try {
      updateNodeData(nodeId, { status: 'generating', error: undefined })
      setToast('正在读取并缓存参考视频…')
      const metadata = await validateReferenceVideoFile(file)
      const videoUrl = await cacheReferenceVideoFile(file)
      updateNodeData(nodeId, {
        videoUrl,
        videoDurationSeconds: metadata.duration,
        sourceName: file.name,
        status: 'done',
        error: undefined,
        createdAt: new Date().toLocaleString('zh-CN'),
      })
      setToast(`已上传参考视频：${file.name}`)
    } catch (error) {
      updateNodeData(nodeId, {
        status: 'error',
        error: error instanceof Error ? error.message : '参考视频上传失败',
      })
      setToast(error instanceof Error ? error.message : '参考视频上传失败')
    }
  }

  function updateApiConfig(patch: Partial<ApiConfig>) {
    setApiConfig((current) => {
      const requestedMode = patch.mode
      let next: ApiConfig

      if (requestedMode && requestedMode !== current.mode) {
        if (current.mode !== 'mock') {
          window.localStorage.setItem(apiProfileStorageKey(current.mode), JSON.stringify(current))
        }
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
        next = { ...current, ...patch }
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
      if (next.mode !== 'mock') {
        window.localStorage.setItem(apiProfileStorageKey(next.mode), JSON.stringify(next))
      }
      if (next.mode === 'change2pro') {
        writeStoredChange2ProFamilyProfile(next.change2ProFamily || change2ProFamilyFromModel(next.model), next)
      }
      return next
    })
  }

  function switchChange2ProFamily(family: Change2ProApiFamily) {
    setChange2ProModels([])
    setChange2ProModelStatus('idle')
    setChange2ProModelMessage(`已切换到 ${family === 'image2' ? 'Image 2.5' : 'Nano Banana'} API 配置。`)

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
  const lightDirectionNode = lightDirectionNodeId
    ? nodes.find((node) => node.id === lightDirectionNodeId) ?? null
    : null
  const elementEditNode = elementEditSession
    ? nodes.find((node) => node.id === elementEditSession.nodeId) ?? null
    : null
  const multiAngleNode = multiAngleSession
    ? nodes.find((node) => node.id === multiAngleSession.nodeId) ?? null
    : null

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
          <input
            ref={referenceVideoInputRef}
            type="file"
            accept="video/mp4,video/quicktime,.mp4,.mov"
            hidden
            onChange={(event) => void addReferenceVideo(event)}
          />
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
            onNodeDragStart={handleAltMediaDragStart}
            onNodeDragStop={handleAltMediaDragStop}
            onNodeClick={(_, node) => {
              setSelectedNodeId(node.id)
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
                  {selectedCanvasNodes.some((node) => mediaDataForCopy(node.data))
                    ? '按 Alt + 鼠标左键拖动可创建副本'
                    : selectedCanvasNodes.some((node) => node.data.kind === 'group')
                    ? '拖动分组可整体移动'
                    : '拖动任一节点可同步移动'}
                </span>
              </div>
              <button
                type="button"
                onClick={() => void copyNodeResults()}
                disabled={!captureSelectedMedia()}
                title="复制选中的图片或视频结果（Ctrl+C）"
              >
                <Copy size={14} />
                复制结果
              </button>
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
              <button type="button" onClick={uploadReferenceVideoFromMenu}>
                <Video size={15} />
                上传参考视频
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
                openNewModel3DStudio()
              }}
              title="打开 3D 模型预览"
              aria-label="打开 3D 模型预览"
            >
              <Box size={15} />
              3D 模型
            </SpecularButton>
          </div>
          <div className="sketch-left-popover">
            <SpecularButton className={`prompt-library-toggle ${sketchSession ? 'active' : ''}`} size="md" radius={8} tint="#ffffff" tintOpacity={0} blur={0} textColor="#f5f5f5" lineColor="#ffffff" baseColor="#525252" intensity={0.8} shineSize={11} shineFade={31} thickness={1.3} speed={0.3} proximity={50} followMouse autoAnimate={false}
              onClick={() => { setShowQuickWorkflows(false); setShowPromptLibrary(false); setSketchSession({ nodeId: null }) }} title="打开分层手绘画板" aria-label="打开分层手绘画板">
              <Pencil size={15} />手绘画板
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
                      const sourceNode = nodes.find((node) => node.id === item.id)
                      const isVideoHistory = item.mediaType === 'video' || Boolean(item.videoUrl)
                      const imageUrl = item.imageUrl || (!isVideoHistory && item.status === '成功' ? sourceNode?.data.imageUrl : undefined)
                      const videoUrl = item.videoUrl || (isVideoHistory && item.status === '成功' ? sourceNode?.data.videoUrl : undefined)
                      const mediaUrl = isVideoHistory ? videoUrl : imageUrl
                      const openMediaPreview = () => {
                        if (!mediaUrl) return
                        setHistoryImageNaturalSize(null)
                        setHistoryMediaPreview({
                          mediaType: isVideoHistory ? 'video' : 'image',
                          mediaUrl,
                          prompt: item.prompt,
                          createdAt: item.createdAt,
                        })
                      }
                      return (
                        <div className="history-card" key={`${item.id}-${item.createdAt}-${index}`}>
                          <div className="history-thumb-wrap">
                            <button
                              className="history-thumb"
                              type="button"
                              onClick={() => isVideoHistory && mediaUrl ? openMediaPreview() : setPrompt(item.prompt)}
                              title={isVideoHistory && mediaUrl ? '播放视频' : '使用这条提示词'}
                            >
                              {videoUrl ? (
                                <video src={videoUrl} aria-label="生成历史视频缩略图" muted playsInline preload="metadata" />
                              ) : imageUrl ? (
                                <img src={imageUrl} alt="生成历史缩略图" />
                              ) : isVideoHistory ? (
                                <Video size={22} />
                              ) : (
                                <ImageIcon size={22} />
                              )}
                            </button>
                            {mediaUrl && (
                              <button
                                className="history-preview-button"
                                type="button"
                                onClick={openMediaPreview}
                                title={isVideoHistory ? '播放视频' : '查看大图'}
                                aria-label={isVideoHistory ? '播放生成历史视频' : '查看生成历史大图'}
                              >
                                <Eye size={17} />
                              </button>
                            )}
                          </div>
                          <div className="history-meta">
                            <span className={item.status === '成功' ? 'success' : 'failed'}>
                              {isVideoHistory ? '视频' : '图像'} · {item.status}
                            </span>
                            <strong>{item.prompt}</strong>
                            <small>{item.createdAt}</small>
                          </div>
                          <button
                            className="history-folder"
                            type="button"
                            onClick={() => void downloadHistoryMedia(item)}
                            title={isVideoHistory ? '下载视频' : '下载图像'}
                            aria-label={isVideoHistory ? '下载生成历史视频' : '下载生成历史图像'}
                            disabled={!mediaUrl}
                          >
                            <Download size={15} />
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
          {historyMediaPreview && (
            <div
              className="history-image-backdrop"
              role="presentation"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) setHistoryMediaPreview(null)
              }}
              onContextMenu={(event) => event.stopPropagation()}
            >
              <section
                className={`history-image-modal ${
                  historyMediaPreview.mediaType === 'video'
                    ? 'is-video'
                    : historyImageNaturalSize
                    ? historyImageNaturalSize.width > historyImageNaturalSize.height
                      ? 'is-landscape'
                      : historyImageNaturalSize.width < historyImageNaturalSize.height
                        ? 'is-portrait'
                        : 'is-square'
                    : ''
                }`}
                role="dialog"
                aria-modal="true"
                aria-label={historyMediaPreview.mediaType === 'video' ? '生成历史视频预览' : '生成历史大图预览'}
                onMouseDown={(event) => event.stopPropagation()}
              >
                <div className="history-image-head">
                  <div>
                    <strong>{historyMediaPreview.mediaType === 'video' ? '视频生成历史' : '图像生成历史'}</strong>
                    <small>{historyMediaPreview.createdAt}</small>
                  </div>
                  <button type="button" onClick={() => setHistoryMediaPreview(null)} title="关闭" aria-label="关闭历史预览">
                    <X size={18} />
                  </button>
                </div>
                <div className="history-image-stage">
                  {historyMediaPreview.mediaType === 'video' ? (
                    <video src={historyMediaPreview.mediaUrl} controls playsInline preload="metadata" />
                  ) : (
                    <img
                      src={historyMediaPreview.mediaUrl}
                      alt="生成历史大图"
                      onLoad={(event) => {
                        const { naturalWidth, naturalHeight } = event.currentTarget
                        if (naturalWidth > 0 && naturalHeight > 0) {
                          setHistoryImageNaturalSize({ width: naturalWidth, height: naturalHeight })
                        }
                      }}
                    />
                  )}
                </div>
                <div className="history-image-caption" title={historyMediaPreview.prompt}>
                  {historyMediaPreview.prompt}
                </div>
              </section>
            </div>
          )}
        </div>
      </section>

      {lightDirectionNode && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setLightDirectionNodeId(null)
          }}
        >
          <section
            className="light-direction-modal"
            role="dialog"
            aria-modal="true"
            aria-label="调整灯光方向"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-head">
              <div>
                <h2>调整灯光</h2>
                <p>拖动灯光图标设置产品高光方向，下一次生成时自动应用。</p>
              </div>
              <button type="button" onClick={() => setLightDirectionNodeId(null)} title="关闭" aria-label="关闭灯光调整">
                <X size={18} />
              </button>
            </div>
            <div className="light-direction-modal-body">
              <LightDirectionControl
                value={lightDirectionNode.data.lightDirection}
                disabled={lightDirectionNode.data.status === 'generating'}
                onChange={(direction) => changeNodeLightDirection(lightDirectionNode.id, direction)}
              />
              <p>
                {lightDirectionNode.data.kind === 'reference'
                  ? '该方向将传递给已连接的图像生成框。'
                  : '该方向将应用于此图像框下一次生成。'}
              </p>
            </div>
            <div className="light-direction-modal-actions">
              <button type="button" onClick={() => setLightDirectionNodeId(null)}>关闭</button>
              <button
                className="primary"
                type="button"
                disabled={
                  !lightDirectionNode.data.imageUrl ||
                  !normalizeLightDirection(lightDirectionNode.data.lightDirection).enabled ||
                  lightDirectionNode.data.status === 'generating'
                }
                title={
                  !lightDirectionNode.data.imageUrl
                    ? '请先上传或生成图片'
                    : !normalizeLightDirection(lightDirectionNode.data.lightDirection).enabled
                      ? '请先开启灯光或拖动灯光图标'
                      : '按当前灯光方向生成新图像'
                }
                onClick={() => void generateRelitImageFromNode(lightDirectionNode.id)}
              >
                <Wand2 size={14} />
                生成
              </button>
            </div>
          </section>
        </div>
      )}

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

      {elementEditSession && elementEditNode && (
        <Suspense fallback={<div className="modal-backdrop" role="status">正在加载元素编辑器…</div>}>
          <ElementEditStudio
            sourceImageUrl={elementEditSession.sourceImageUrl}
            sourceName={elementEditNode.data.sourceName || elementEditNode.data.title}
            modelLabel={apiModelDisplayName(apiConfig.model) || '当前图像模型'}
            busy={isGenerating}
            onClose={() => setElementEditSession(null)}
            onGenerate={submitElementEdit}
          />
        </Suspense>
      )}

      {multiAngleSession && multiAngleNode && (
        <Suspense fallback={<div className="modal-backdrop" role="status">正在加载多角度编辑器…</div>}>
          <MultiAngleStudio
            sourceImageUrl={multiAngleSession.sourceImageUrl}
            sourceName={multiAngleNode.data.sourceName || multiAngleNode.data.title}
            busy={isGenerating}
            onClose={() => setMultiAngleSession(null)}
            onGenerate={submitMultiAngle}
          />
        </Suspense>
      )}

      {sketchSession && (
        <Suspense fallback={<div className="modal-backdrop" role="status">正在加载手绘画板…</div>}>
          <SketchStudio initialDocument={sketchSession.document} defaultModel={apiConfig.model} defaultResolution={apiConfig.imageSize} models={sketchModels} apiReady={apiConfig.mode === 'mock' || Boolean(apiConfig.apiKey.trim())} onComplete={saveSketchToCanvas} onCancel={() => setSketchSession(null)} />
        </Suspense>
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
            onClose={closeModel3DStudio}
            initialScene={model3DEditSession.scene}
            sceneId={model3DEditSession.sceneId}
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
                <p>支持 GA、Change2Pro 与 API Mart 图像 / 视频接口。</p>
              </div>
              <button type="button" onClick={() => setShowSettings(false)} title="关闭">
                <X size={18} />
              </button>
            </div>

            <div className="settings-grid">
              <div className="field">
                <span>模式</span>
                <ApiModeSelect value={apiConfig.mode} onChange={(mode) => updateApiConfig({ mode })} />
              </div>
              {(apiConfig.mode === 'grsai' || apiConfig.mode === 'change2pro') && (
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
                        <strong>Image 2.5</strong>
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
                      切换模型系列时会自动载入对应的 API 配置、API Key、模型与清晰度。
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
                ) : null}
                </div>
              )}
              {apiConfig.mode !== 'mock' && (
                <label className="field wide">
                  <span>
                    API Key
                    {apiConfig.mode === 'change2pro' && ` · ${(apiConfig.change2ProFamily || change2ProFamilyFromModel(apiConfig.model)) === 'image2' ? 'Image 2.5' : 'Nano Banana'}`}
                  </span>
                  <input
                    type="password"
                    value={apiConfig.apiKey}
                    onChange={(event) => updateApiConfig({ apiKey: event.target.value })}
                    placeholder="仅保存在当前浏览器 localStorage"
                  />
                </label>
              )}
              <label className="field">
                <span>尺寸</span>
                <input value={apiConfig.size} onChange={(event) => updateApiConfig({ size: event.target.value })} />
              </label>
            </div>

            <div className="modal-foot">
              <p>
                API Key 仅保存在当前浏览器，请求会通过本地代理发送以避免浏览器 CORS 限制。
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
