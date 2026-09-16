import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Brush, Check, Eraser, Loader2, MapPin, Redo2, Square, Trash2, Undo2, Wand2, X, ZoomIn, ZoomOut } from 'lucide-react'
import UnifiedRange from './UnifiedRange'
import './ElementEditStudio.css'

export type ElementSelectionMode = 'mark' | 'box' | 'brush' | 'erase'

export type ElementEditOperation = {
  id: string
  label: string
  maskUrl: string
  prompt: string
}

export type ElementEditResult = {
  maskUrl: string
  prompt: string
  operations: ElementEditOperation[]
  feather: number
  markerCount: number
  sourceWidth: number
  sourceHeight: number
}

type Props = {
  sourceImageUrl: string
  sourceName?: string
  modelLabel: string
  busy?: boolean
  onClose: () => void
  onGenerate: (result: ElementEditResult) => Promise<void>
}

type Point = { x: number; y: number }
type BoxSelection = { start: Point; end: Point } | null
type ElementMarker = Point & { id: string; radius: number; prompt: string }

const editorMaxDimension = 2048
const selectionColor = '#22d3ee'

function maskHasPixels(canvas: HTMLCanvasElement) {
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return false
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
  for (let index = 3; index < pixels.length; index += 4) {
    if (pixels[index] > 8) return true
  }
  return false
}

function loadCanvasSnapshot(canvas: HTMLCanvasElement, snapshot: string) {
  return new Promise<void>((resolve, reject) => {
    const image = new Image()
    image.onload = () => {
      const context = canvas.getContext('2d')
      if (!context) {
        reject(new Error('浏览器无法恢复选区'))
        return
      }
      context.clearRect(0, 0, canvas.width, canvas.height)
      context.drawImage(image, 0, 0, canvas.width, canvas.height)
      resolve()
    }
    image.onerror = () => reject(new Error('选区历史记录读取失败'))
    image.src = snapshot
  })
}

function featherMask(source: HTMLCanvasElement, feather: number) {
  if (!feather) return source.toDataURL('image/png')
  const canvas = document.createElement('canvas')
  canvas.width = source.width
  canvas.height = source.height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('浏览器无法处理选区边缘')
  context.filter = `blur(${feather}px)`
  context.drawImage(source, 0, 0)
  context.filter = 'none'
  return canvas.toDataURL('image/png')
}

export default function ElementEditStudio({ sourceImageUrl, sourceName, modelLabel, busy = false, onClose, onGenerate }: Props) {
  const maskCanvasRef = useRef<HTMLCanvasElement>(null)
  const drawingRef = useRef(false)
  const lastPointRef = useRef<Point | null>(null)
  const boxRef = useRef<BoxSelection>(null)
  const markerDragRef = useRef<{ id: string; pointerId: number } | null>(null)
  const markerSequenceRef = useRef(0)
  const undoRef = useRef<string[]>([])
  const redoRef = useRef<string[]>([])
  const [imageSize, setImageSize] = useState({ width: 1, height: 1 })
  const [naturalImageSize, setNaturalImageSize] = useState({ width: 1, height: 1 })
  const [mode, setMode] = useState<ElementSelectionMode>('mark')
  const [boxSelection, setBoxSelection] = useState<BoxSelection>(null)
  const [markers, setMarkers] = useState<ElementMarker[]>([])
  const [activeMarkerId, setActiveMarkerId] = useState<string | null>(null)
  const [brushSize, setBrushSize] = useState(54)
  const [feather, setFeather] = useState(8)
  const [zoom, setZoom] = useState(1)
  const [manualPrompt, setManualPrompt] = useState('')
  const [hasMask, setHasMask] = useState(false)
  const [historyRevision, setHistoryRevision] = useState(0)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const activeMarker = markers.find((marker) => marker.id === activeMarkerId) || markers[0] || null
  const hasSelection = markers.length > 0 || hasMask
  const markerRadiusMax = Math.max(48, Math.round(Math.min(imageSize.width, imageSize.height) * 0.45))

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submitting && !busy) onClose()
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) void redoMask()
        else void undoMask()
      }
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  })

  function pointFromClient(clientX: number, clientY: number): Point {
    const canvas = maskCanvasRef.current
    if (!canvas) return { x: 0, y: 0 }
    const rect = canvas.getBoundingClientRect()
    return {
      x: Math.max(0, Math.min(canvas.width - 1, ((clientX - rect.left) / rect.width) * canvas.width)),
      y: Math.max(0, Math.min(canvas.height - 1, ((clientY - rect.top) / rect.height) * canvas.height)),
    }
  }

  function canvasPoint(event: ReactPointerEvent<HTMLCanvasElement>) {
    return pointFromClient(event.clientX, event.clientY)
  }

  function rememberMask() {
    const canvas = maskCanvasRef.current
    if (!canvas) return
    undoRef.current = [...undoRef.current.slice(-29), canvas.toDataURL('image/png')]
    redoRef.current = []
    setHistoryRevision((value) => value + 1)
  }

  function refreshMaskState() {
    const canvas = maskCanvasRef.current
    if (canvas) setHasMask(maskHasPixels(canvas))
    setHistoryRevision((value) => value + 1)
  }

  async function undoMask() {
    const canvas = maskCanvasRef.current
    const snapshot = undoRef.current.pop()
    if (!canvas || !snapshot) return
    redoRef.current.push(canvas.toDataURL('image/png'))
    await loadCanvasSnapshot(canvas, snapshot)
    refreshMaskState()
  }

  async function redoMask() {
    const canvas = maskCanvasRef.current
    const snapshot = redoRef.current.pop()
    if (!canvas || !snapshot) return
    undoRef.current.push(canvas.toDataURL('image/png'))
    await loadCanvasSnapshot(canvas, snapshot)
    refreshMaskState()
  }

  function clearSelections() {
    const canvas = maskCanvasRef.current
    const context = canvas?.getContext('2d')
    if (canvas && context && hasMask) {
      rememberMask()
      context.clearRect(0, 0, canvas.width, canvas.height)
    }
    setMarkers([])
    setActiveMarkerId(null)
    setHasMask(false)
    setError('')
  }

  function updateMarker(markerId: string, patch: Partial<ElementMarker>) {
    setMarkers((current) => current.map((marker) => marker.id === markerId ? { ...marker, ...patch } : marker))
  }

  function addMarker(point: Point) {
    const markerId = `marker-${Date.now()}-${++markerSequenceRef.current}`
    const radius = Math.max(24, Math.round(Math.min(imageSize.width, imageSize.height) * 0.12))
    setMarkers((current) => [...current, { ...point, id: markerId, radius, prompt: '' }])
    setActiveMarkerId(markerId)
    setError('')
  }

  function removeMarker(markerId: string) {
    const next = markers.filter((marker) => marker.id !== markerId)
    setMarkers(next)
    if (activeMarkerId === markerId) setActiveMarkerId(next.at(-1)?.id || null)
    setError('')
  }

  function handleMarkerPointerDown(event: ReactPointerEvent<HTMLButtonElement>, markerId: string) {
    if (submitting || busy) return
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    markerDragRef.current = { id: markerId, pointerId: event.pointerId }
    setActiveMarkerId(markerId)
  }

  function handleMarkerPointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = markerDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    updateMarker(drag.id, pointFromClient(event.clientX, event.clientY))
  }

  function stopMarkerPointer(event: ReactPointerEvent<HTMLButtonElement>) {
    if (markerDragRef.current?.pointerId !== event.pointerId) return
    markerDragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  function drawStroke(from: Point, to: Point, erase: boolean) {
    const canvas = maskCanvasRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return
    context.save()
    context.globalCompositeOperation = erase ? 'destination-out' : 'source-over'
    context.strokeStyle = selectionColor
    context.fillStyle = selectionColor
    context.lineWidth = brushSize
    context.lineCap = 'round'
    context.lineJoin = 'round'
    context.beginPath()
    context.moveTo(from.x, from.y)
    context.lineTo(to.x, to.y)
    context.stroke()
    if (Math.hypot(to.x - from.x, to.y - from.y) < 0.5) {
      context.beginPath()
      context.arc(to.x, to.y, brushSize / 2, 0, Math.PI * 2)
      context.fill()
    }
    context.restore()
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (loading || busy || submitting) return
    event.preventDefault()
    const point = canvasPoint(event)

    if (mode === 'mark') {
      addMarker(point)
      return
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    rememberMask()
    if (mode === 'box') {
      const selection = { start: point, end: point }
      boxRef.current = selection
      setBoxSelection(selection)
      return
    }
    drawingRef.current = true
    lastPointRef.current = point
    drawStroke(point, point, mode === 'erase')
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (mode === 'box' && boxRef.current) {
      const selection = { ...boxRef.current, end: canvasPoint(event) }
      boxRef.current = selection
      setBoxSelection(selection)
      return
    }
    if (!drawingRef.current || !lastPointRef.current || (mode !== 'brush' && mode !== 'erase')) return
    const point = canvasPoint(event)
    drawStroke(lastPointRef.current, point, mode === 'erase')
    lastPointRef.current = point
  }

  function stopPointer(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (mode === 'box' && boxRef.current) {
      const canvas = maskCanvasRef.current
      const context = canvas?.getContext('2d')
      const { start, end } = boxRef.current
      if (canvas && context) {
        const x = Math.min(start.x, end.x)
        const y = Math.min(start.y, end.y)
        const width = Math.abs(end.x - start.x)
        const height = Math.abs(end.y - start.y)
        if (width > 2 && height > 2) {
          context.fillStyle = selectionColor
          context.fillRect(x, y, width, height)
          setHasMask(true)
        }
      }
      boxRef.current = null
      setBoxSelection(null)
      refreshMaskState()
    }
    if (drawingRef.current) {
      drawingRef.current = false
      lastPointRef.current = null
      refreshMaskState()
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  function createMarkerMask(marker: ElementMarker) {
    const canvas = document.createElement('canvas')
    canvas.width = imageSize.width
    canvas.height = imageSize.height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('浏览器无法创建标记范围')
    context.fillStyle = selectionColor
    context.beginPath()
    context.arc(marker.x, marker.y, marker.radius, 0, Math.PI * 2)
    context.fill()
    return featherMask(canvas, feather)
  }

  function createManualMask() {
    const canvas = maskCanvasRef.current
    if (!canvas) throw new Error('手绘选区尚未准备好')
    return featherMask(canvas, feather)
  }

  function createCombinedMask() {
    const canvas = document.createElement('canvas')
    canvas.width = imageSize.width
    canvas.height = imageSize.height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('浏览器无法合并局部选区')
    if (hasMask && maskCanvasRef.current) context.drawImage(maskCanvasRef.current, 0, 0)
    context.fillStyle = selectionColor
    for (const marker of markers) {
      context.beginPath()
      context.arc(marker.x, marker.y, marker.radius, 0, Math.PI * 2)
      context.fill()
    }
    return featherMask(canvas, feather)
  }

  async function submit() {
    if (!hasSelection) { setError('请先在画面上放置标记，或使用框选、手绘选择区域。'); return }
    const markerWithoutPrompt = markers.findIndex((marker) => !marker.prompt.trim())
    if (markerWithoutPrompt >= 0) {
      setActiveMarkerId(markers[markerWithoutPrompt].id)
      setMode('mark')
      setError(`请填写标记 ${markerWithoutPrompt + 1} 的局部修改描述。`)
      return
    }
    if (hasMask && !manualPrompt.trim()) {
      setError('请填写框选或手绘区域的局部修改描述。')
      return
    }

    const markerOperations: ElementEditOperation[] = markers.map((marker, index) => ({
      id: marker.id,
      label: `标记 ${index + 1}`,
      maskUrl: createMarkerMask(marker),
      prompt: marker.prompt.trim(),
    }))
    const operations = hasMask
      ? [...markerOperations, { id: 'manual-selection', label: '框选 / 手绘区域', maskUrl: createManualMask(), prompt: manualPrompt.trim() }]
      : markerOperations
    const prompt = operations.map((operation) => `${operation.label}：${operation.prompt}`).join('\n')

    setSubmitting(true)
    setError('')
    try {
      await onGenerate({
        maskUrl: createCombinedMask(),
        prompt,
        operations,
        feather,
        markerCount: markers.length,
        sourceWidth: naturalImageSize.width,
        sourceHeight: naturalImageSize.height,
      })
    } catch (reason) {
      setSubmitting(false)
      setError(reason instanceof Error ? reason.message : '元素编辑任务创建失败')
    }
  }

  const selectionRect = boxSelection ? {
    left: `${Math.min(boxSelection.start.x, boxSelection.end.x) / imageSize.width * 100}%`,
    top: `${Math.min(boxSelection.start.y, boxSelection.end.y) / imageSize.height * 100}%`,
    width: `${Math.abs(boxSelection.end.x - boxSelection.start.x) / imageSize.width * 100}%`,
    height: `${Math.abs(boxSelection.end.y - boxSelection.start.y) / imageSize.height * 100}%`,
  } : undefined
  void historyRevision

  return (
    <div className="element-edit-backdrop" role="presentation" onPointerDown={(event) => event.stopPropagation()}>
      <section className="element-edit-studio" role="dialog" aria-modal="true" aria-label="元素编辑">
        <header className="element-edit-head">
          <div>
            <Wand2 size={19} />
            <span><strong>元素编辑</strong><small>在画面中放置多个标记，为每一处填写独立修改描述</small></span>
          </div>
          <button type="button" onClick={onClose} disabled={submitting || busy} title="关闭元素编辑"><X size={18} /></button>
        </header>

        <div className="element-edit-body">
          <aside className="element-edit-tools" aria-label="元素选择工具">
            {([
              ['mark', '多点标记', MapPin],
              ['box', '框选', Square],
              ['brush', '手绘', Brush],
              ['erase', '擦除选区', Eraser],
            ] as const).map(([value, label, Icon]) => (
              <button key={value} type="button" className={mode === value ? 'active' : ''} aria-pressed={mode === value} onClick={() => setMode(value)} disabled={submitting || busy} title={label}>
                <Icon size={19} /><span>{label}</span>
              </button>
            ))}
            <i />
            <button type="button" onClick={() => void undoMask()} disabled={!undoRef.current.length || submitting || busy} title="撤销手绘选区"><Undo2 size={18} /><span>撤销</span></button>
            <button type="button" onClick={() => void redoMask()} disabled={!redoRef.current.length || submitting || busy} title="重做手绘选区"><Redo2 size={18} /><span>重做</span></button>
            <button type="button" onClick={clearSelections} disabled={!hasSelection || submitting || busy} title="清空所有标记和选区"><Trash2 size={18} /><span>清空</span></button>
          </aside>

          <main className="element-edit-workspace">
            <div className="element-edit-stage">
              <div className="element-edit-zoom-content" style={{ width: `${zoom * 100}%` }}>
                <div className="element-edit-image-wrap" style={{ aspectRatio: `${imageSize.width} / ${imageSize.height}` }}>
                  <img
                    src={sourceImageUrl}
                    alt="元素编辑原图"
                    draggable={false}
                    onLoad={(event) => {
                      const image = event.currentTarget
                      setNaturalImageSize({ width: image.naturalWidth, height: image.naturalHeight })
                      const scale = Math.min(1, editorMaxDimension / Math.max(image.naturalWidth, image.naturalHeight))
                      const width = Math.max(1, Math.round(image.naturalWidth * scale))
                      const height = Math.max(1, Math.round(image.naturalHeight * scale))
                      setImageSize({ width, height })
                      if (maskCanvasRef.current) {
                        maskCanvasRef.current.width = width
                        maskCanvasRef.current.height = height
                      }
                      undoRef.current = []
                      redoRef.current = []
                      setMarkers([])
                      setActiveMarkerId(null)
                      setHasMask(false)
                      setLoading(false)
                    }}
                    onError={() => { setLoading(false); setError('无法读取这张图片，请重新上传后再试。') }}
                  />
                  <canvas
                    ref={maskCanvasRef}
                    className={`element-edit-mask ${mode}`}
                    aria-label="元素选择画布"
                    onPointerDown={handlePointerDown}
                    onPointerMove={handlePointerMove}
                    onPointerUp={stopPointer}
                    onPointerCancel={stopPointer}
                  />
                  {markers.map((marker, index) => (
                    <div key={marker.id} className={`element-edit-marker-layer ${activeMarker?.id === marker.id ? 'active' : ''}`}>
                      <div className="element-edit-marker-radius" style={{ left: `${(marker.x - marker.radius) / imageSize.width * 100}%`, top: `${(marker.y - marker.radius) / imageSize.height * 100}%`, width: `${marker.radius * 2 / imageSize.width * 100}%`, height: `${marker.radius * 2 / imageSize.height * 100}%` }} />
                      <button
                        type="button"
                        className="element-edit-marker-pin"
                        style={{ left: `${marker.x / imageSize.width * 100}%`, top: `${marker.y / imageSize.height * 100}%` }}
                        aria-label={`标记 ${index + 1}`}
                        title={`标记 ${index + 1}：拖动可调整位置`}
                        onPointerDown={(event) => handleMarkerPointerDown(event, marker.id)}
                        onPointerMove={handleMarkerPointerMove}
                        onPointerUp={stopMarkerPointer}
                        onPointerCancel={stopMarkerPointer}
                      >{index + 1}</button>
                    </div>
                  ))}
                  {selectionRect && <div className="element-edit-box-preview" style={selectionRect} />}
                  {loading && <div className="element-edit-loading"><Loader2 size={22} />正在载入图片…</div>}
                </div>
              </div>
            </div>
            <div className="element-edit-zoom-bar">
              <span>{sourceName || '当前图片'} · {naturalImageSize.width} × {naturalImageSize.height}</span>
              <div>
                <button type="button" onClick={() => setZoom((value) => Math.max(0.5, Number((value - 0.25).toFixed(2))))} disabled={zoom <= 0.5} title="缩小"><ZoomOut size={15} /></button>
                <button type="button" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
                <button type="button" onClick={() => setZoom((value) => Math.min(3, Number((value + 0.25).toFixed(2))))} disabled={zoom >= 3} title="放大"><ZoomIn size={15} /></button>
              </div>
            </div>
          </main>

          <aside className="element-edit-inspector">
            <section>
              <div className="element-edit-section-title"><strong>多点标记</strong>{markers.length > 0 && <span><Check size={12} />{markers.length} 处</span>}</div>
              <p>{mode === 'mark' ? '点击画面添加编号标记；拖动编号可调整位置。每个标记都可以填写不同的局部修改描述。' : '切换到“多点标记”后，可继续在画面中添加修改位置。'}</p>
              {markers.length > 0 ? (
                <div className="element-edit-marker-list">
                  {markers.map((marker, index) => (
                    <div key={marker.id} className={activeMarker?.id === marker.id ? 'active' : ''}>
                      <button type="button" onClick={() => { setActiveMarkerId(marker.id); setMode('mark') }}><MapPin size={13} />标记 {index + 1}{marker.prompt.trim() && <Check size={12} />}</button>
                      <button type="button" onClick={() => removeMarker(marker.id)} title={`删除标记 ${index + 1}`}><Trash2 size={13} /></button>
                    </div>
                  ))}
                </div>
              ) : <div className="element-edit-empty-markers"><MapPin size={17} />还没有标记，直接点击画面即可添加</div>}
              {activeMarker && (
                <div className="element-edit-marker-editor">
                  <label className="element-edit-prompt">
                    <span>标记 {markers.findIndex((marker) => marker.id === activeMarker.id) + 1} 的局部描述</span>
                    <textarea value={activeMarker.prompt} onChange={(event) => updateMarker(activeMarker.id, { prompt: event.target.value })} rows={4} placeholder="例如：将这里的瓶盖改成金色，保持形状和光影" disabled={submitting || busy} />
                  </label>
                  <label>影响范围 <em>{activeMarker.radius}px</em><UnifiedRange min={12} max={markerRadiusMax} value={activeMarker.radius} onValueChange={(radius) => updateMarker(activeMarker.id, { radius })} /></label>
                </div>
              )}
            </section>
            {(mode !== 'mark' || hasMask) && (
              <section>
                <div className="element-edit-section-title"><strong>框选 / 手绘区域</strong>{hasMask && <span><Check size={12} />已有选区</span>}</div>
                {mode === 'box' && <p>按住鼠标拖出矩形区域，可连续添加多个范围。</p>}
                {(mode === 'brush' || mode === 'erase') && <label>画笔大小 <em>{brushSize}px</em><UnifiedRange min={8} max={220} value={brushSize} onValueChange={setBrushSize} /></label>}
                <label className="element-edit-prompt">
                  <span>框选或手绘区域要修改成什么</span>
                  <textarea value={manualPrompt} onChange={(event) => setManualPrompt(event.target.value)} rows={4} placeholder="例如：移除选中区域中的杂物，并自然补全背景" disabled={submitting || busy} />
                </label>
              </section>
            )}
            <section>
              <div className="element-edit-section-title"><strong>生成设置</strong></div>
              <label>边缘柔化 <em>{feather}px</em><UnifiedRange min={0} max={32} value={feather} onValueChange={setFeather} /></label>
              <div className="element-edit-output-info"><span>模型<strong>{modelLabel}</strong></span><span>原图尺寸<strong>{naturalImageSize.width} × {naturalImageSize.height}</strong></span></div>
              <p>不同描述会按标记顺序逐处生成；选区外使用上一阶段图像覆盖保护，最终只创建一张合成结果。</p>
            </section>
            {error && <div className="element-edit-error" role="alert">{error}</div>}
          </aside>
        </div>

        <footer className="element-edit-foot">
          <span>{submitting || busy ? '正在逐处生成局部修改…' : hasSelection ? `已选择 ${markers.length} 个标记${hasMask ? '及框选 / 手绘区域' : ''}，预计调用 ${markers.length + (hasMask ? 1 : 0)} 次生成` : '点击画面添加多个局部标记'}</span>
          <div>
            <button type="button" onClick={onClose} disabled={submitting || busy}>取消</button>
            <button
              className="primary element-edit-run"
              type="button"
              onClick={() => void submit()}
              disabled={loading || submitting || busy || !hasSelection}
              aria-label={submitting || busy ? '正在生成新版本' : '运行元素编辑生成'}
              title={submitting || busy ? '正在生成新版本' : '运行元素编辑生成'}
            >
              {submitting || busy ? <Loader2 size={15} /> : 'Run'}
            </button>
          </div>
        </footer>
      </section>
    </div>
  )
}
