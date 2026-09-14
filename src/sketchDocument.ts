export type SketchPoint = { x: number; y: number }
export type SketchResolution = '1K' | '1.5K' | '2K' | '3K' | '4K'
export type SketchTool = 'select' | 'pen' | 'eraser' | 'rect' | 'ellipse' | 'text' | 'pan'
export type SketchElement = {
  id: string
  kind: 'pen' | 'eraser' | 'rect' | 'ellipse' | 'text'
  x: number
  y: number
  width: number
  height: number
  points: SketchPoint[]
  color: string
  size: number
  opacity: number
  text?: string
}
export type SketchLayer = {
  id: string
  name: string
  kind: 'draw' | 'image' | 'model'
  visible: boolean
  locked: boolean
  opacity: number
  elements: SketchElement[]
  imageUrl?: string
  sceneId?: string
  x: number
  y: number
  width: number
  height: number
}
export type SketchDocument = {
  version: 1
  width: number
  height: number
  background: string
  layers: SketchLayer[] // Bottom to top; erasing is isolated to one layer.
  activeLayerId: string
  prompt: string
  model: string
  imageSize: SketchResolution
}
export type SketchModelOption = { id: string; label: string; resolutions: SketchResolution[] }
export const sketchSizes = [
  { label: '1:1', width: 1024, height: 1024 },
  { label: '16:9', width: 1536, height: 864 },
  { label: '9:16', width: 864, height: 1536 },
  { label: '4:3', width: 1344, height: 1024 },
  { label: '3:4', width: 1024, height: 1344 },
  { label: '3:2', width: 1536, height: 1024 },
  { label: '2:3', width: 1024, height: 1536 },
]
export const sketchGenerationInstruction = '请以参考图中手绘与模型合成的画面为构图依据，将草稿转化为完整、精致的成品图像。保持模型主体的结构、角度、比例及前后遮挡关系，按照用户描述表现手绘内容。说明性的辅助线、箭头和标注不应直接出现在成图中；用户明确要求保留的文字和设计元素除外。'

export function createSketchLayer(name: string, kind: SketchLayer['kind'] = 'draw'): SketchLayer {
  return { id: crypto.randomUUID(), name, kind, visible: true, locked: kind !== 'draw', opacity: 1, elements: [], x: 0, y: 0, width: 1024, height: 1024 }
}
export function createSketchDocument(model: string, imageSize: SketchResolution): SketchDocument {
  const layer = createSketchLayer('手绘图层 1')
  return { version: 1, width: 1024, height: 1024, background: '#ffffff', layers: [layer], activeLayerId: layer.id, prompt: '', model, imageSize }
}
export function sketchSceneIds(doc?: SketchDocument): string[] {
  return doc?.layers.flatMap(layer => layer.sceneId ? [layer.sceneId] : []) || []
}
export function moveSketchLayer(doc: SketchDocument, fromId: string, toIndex: number): SketchDocument {
  const layers = [...doc.layers]
  const index = layers.findIndex(layer => layer.id === fromId)
  if (index < 0) return doc
  const [layer] = layers.splice(index, 1)
  layers.splice(Math.max(0, Math.min(layers.length, toIndex)), 0, layer)
  return { ...doc, layers }
}
export function sketchElementBounds(item: SketchElement) {
  if (item.kind === 'pen' || item.kind === 'eraser') {
    const xs = item.points.map(point => point.x + item.x)
    const ys = item.points.map(point => point.y + item.y)
    const pad = item.size / 2
    return { x: Math.min(...xs) - pad, y: Math.min(...ys) - pad, width: Math.max(...xs) - Math.min(...xs) + pad * 2, height: Math.max(...ys) - Math.min(...ys) + pad * 2 }
  }
  return { x: Math.min(item.x, item.x + item.width), y: Math.min(item.y, item.y + item.height), width: Math.abs(item.width), height: Math.abs(item.height) }
}

export function paintSketchElement(context: CanvasRenderingContext2D, item: SketchElement) {
  context.save()
  context.globalAlpha = item.opacity
  context.globalCompositeOperation = item.kind === 'eraser' ? 'destination-out' : 'source-over'
  context.strokeStyle = item.color
  context.fillStyle = item.color
  context.lineWidth = item.size
  context.lineCap = 'round'
  context.lineJoin = 'round'
  if (item.kind === 'pen' || item.kind === 'eraser') {
    context.beginPath()
    item.points.forEach((point, index) => {
      if (index === 0) context.moveTo(point.x + item.x, point.y + item.y)
      else context.lineTo(point.x + item.x, point.y + item.y)
    })
    if (item.points.length === 1) {
      context.arc(item.points[0].x + item.x, item.points[0].y + item.y, item.size / 2, 0, Math.PI * 2)
      context.fill()
    } else context.stroke()
  } else if (item.kind === 'rect') {
    context.strokeRect(item.x, item.y, item.width, item.height)
  } else if (item.kind === 'ellipse') {
    context.beginPath()
    context.ellipse(item.x + item.width / 2, item.y + item.height / 2, Math.abs(item.width / 2), Math.abs(item.height / 2), 0, 0, Math.PI * 2)
    context.stroke()
  } else {
    context.font = `${item.size}px Inter, "Microsoft YaHei", sans-serif`
    context.textBaseline = 'top'
    ;(item.text || '').split('\n').forEach((line, index) => context.fillText(line, item.x, item.y + index * item.size * 1.3))
  }
  context.restore()
}

export function loadSketchImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('无法读取图层图片，请重新导入图片或模型。'))
    image.src = url
  })
}

export async function renderSketch(doc: SketchDocument, images = new Map<string, Promise<HTMLImageElement>>()) {
  const canvas = document.createElement('canvas')
  canvas.width = doc.width
  canvas.height = doc.height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('浏览器无法创建绘图画板')
  context.fillStyle = doc.background
  context.fillRect(0, 0, doc.width, doc.height)
  const layerCanvas = document.createElement('canvas')
  layerCanvas.width = doc.width
  layerCanvas.height = doc.height
  const layerContext = layerCanvas.getContext('2d')!
  for (const layer of doc.layers) {
    if (!layer.visible || layer.opacity <= 0) continue
    layerContext.clearRect(0, 0, doc.width, doc.height)
    if (layer.imageUrl) {
      if (!images.has(layer.imageUrl)) images.set(layer.imageUrl, loadSketchImage(layer.imageUrl))
      const image = await images.get(layer.imageUrl)!
      layerContext.drawImage(image, layer.x, layer.y, layer.width, layer.height)
    }
    layer.elements.forEach(item => paintSketchElement(layerContext, item))
    context.globalAlpha = layer.opacity
    context.drawImage(layerCanvas, 0, 0)
  }
  context.globalAlpha = 1
  return canvas
}
