export const canvasMediaClipboardType = 'application/x-ai-canvas-media'
const clipboardPrefix = 'AI_CANVAS_MEDIA_V1\n'

type Point = { x: number; y: number }
type MediaNode = {
  id: string
  position: Point
  data: {
    kind: string
    title: string
    status: string
    imageUrl?: string
    videoUrl?: string
    sourceName?: string
    model?: string
    size?: string
    prompt?: string
    generationPrompt?: string
    videoDurationSeconds?: number
    videoDuration?: number
  }
}
type MediaData = {
  kind: 'reference' | 'video-reference'
  title: string
  imageUrl?: string
  videoUrl?: string
  sourceName: string
  model?: string
  size?: string
  prompt?: string
  generationPrompt?: string
  videoDurationSeconds?: number
}
export type CanvasMediaClipboard = {
  version: 1
  items: Array<{ sourceId: string; position: Point; data: MediaData }>
}

function usableMediaUrl(value: unknown): value is string {
  return typeof value === 'string' && /^(https?:\/\/|blob:|data:(image|video)\/|\/(?!\/))/i.test(value)
}

export function mediaDataForCopy(data: MediaNode['data']): MediaData | null {
  if (data.status === 'generating') return null
  const video = data.kind === 'video' || data.kind === 'video-reference'
  const image = ['image', 'reference', 'repaint', 'outpaint'].includes(data.kind)
  if (!video && !image) return null
  const url = video ? data.videoUrl : data.imageUrl
  if (!usableMediaUrl(url)) return null
  const duration = data.videoDurationSeconds ?? data.videoDuration
  const prompt = typeof data.prompt === 'string'
    ? data.prompt
    : typeof data.generationPrompt === 'string'
      ? data.generationPrompt
      : undefined
  return {
    kind: video ? 'video-reference' : 'reference',
    title: video ? '视频副本' : '图像副本',
    ...(video ? { videoUrl: url } : { imageUrl: url }),
    sourceName: data.sourceName || `${data.title || (video ? '视频' : '图像')}-副本`,
    model: data.model,
    size: data.size,
    ...(prompt !== undefined ? { prompt, generationPrompt: prompt } : {}),
    ...(video && typeof duration === 'number' && Number.isFinite(duration) && duration > 0 ? { videoDurationSeconds: duration } : {}),
  }
}

export function createCanvasMediaClipboard(nodes: MediaNode[]): CanvasMediaClipboard | null {
  const items = nodes.flatMap((node) => {
    const data = mediaDataForCopy(node.data)
    return data ? [{ sourceId: node.id, position: { ...node.position }, data }] : []
  })
  return items.length ? { version: 1, items } : null
}

export function serializeCanvasMediaClipboard(clipboard: CanvasMediaClipboard) {
  return clipboardPrefix + JSON.stringify(clipboard)
}

export function parseCanvasMediaClipboard(text: string): CanvasMediaClipboard | null {
  if (!text.startsWith(clipboardPrefix)) return null
  try {
    const value = JSON.parse(text.slice(clipboardPrefix.length)) as CanvasMediaClipboard
    if (value?.version !== 1 || !Array.isArray(value.items) || !value.items.length || value.items.length > 500) return null
    const items: CanvasMediaClipboard['items'] = []
    for (const item of value.items) {
      if (!item || !Number.isFinite(item.position?.x) || !Number.isFinite(item.position?.y)) return null
      if (!item.data || !['reference', 'video-reference'].includes(item.data.kind)) return null
      // Keep plain prompt text with the media while excluding callbacks, connections and API settings.
      const data = mediaDataForCopy({
        kind: item.data.kind, title: '', status: 'done',
        imageUrl: item.data.imageUrl, videoUrl: item.data.videoUrl,
        sourceName: typeof item.data.sourceName === 'string' ? item.data.sourceName : undefined,
        model: typeof item.data.model === 'string' ? item.data.model : undefined,
        size: typeof item.data.size === 'string' ? item.data.size : undefined,
        prompt: typeof item.data.prompt === 'string'
          ? item.data.prompt
          : typeof item.data.generationPrompt === 'string'
            ? item.data.generationPrompt
            : undefined,
        videoDurationSeconds: typeof item.data.videoDurationSeconds === 'number' ? item.data.videoDurationSeconds : undefined,
      })
      if (!data) return null
      items.push({ sourceId: typeof item.sourceId === 'string' ? item.sourceId : '', position: { x: item.position.x, y: item.position.y }, data })
    }
    return { version: 1, items }
  } catch {
    return null
  }
}

export function createPastedMediaNodes(clipboard: CanvasMediaClipboard, origin: Point, createId: () => string, createdAt: string) {
  const left = Math.min(...clipboard.items.map((item) => item.position.x))
  const top = Math.min(...clipboard.items.map((item) => item.position.y))
  return clipboard.items.map((item) => ({
    id: createId(), type: 'workflow' as const, selected: true,
    position: { x: origin.x + item.position.x - left, y: origin.y + item.position.y - top },
    data: { ...item.data, status: 'done' as const, createdAt },
  }))
}

export function createDraggedMediaNodes(clipboard: CanvasMediaClipboard, delta: Point, createId: () => string, createdAt: string) {
  const left = Math.min(...clipboard.items.map((item) => item.position.x))
  const top = Math.min(...clipboard.items.map((item) => item.position.y))
  return createPastedMediaNodes(clipboard, { x: left + delta.x, y: top + delta.y }, createId, createdAt)
}
