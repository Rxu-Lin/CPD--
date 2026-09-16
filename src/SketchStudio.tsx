import { lazy, Suspense, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { ArrowDown, ArrowUp, Box, Check, Circle, Copy, Eraser, Eye, EyeOff, Hand, ImagePlus, Layers, Loader2, Lock, MousePointer2, Pencil, Plus, Redo2, Save, Square, Trash2, Type, Undo2, Unlock, Wand2, X, ZoomIn, ZoomOut } from 'lucide-react'
import UnifiedRange from './UnifiedRange'
import { readModel3DScene, saveModel3DScene, type SavedModel3DScene } from './model3dSceneStore'
import { createSketchDocument, createSketchLayer, loadSketchImage, moveSketchLayer, renderSketch, sketchElementBounds, sketchSizes, type SketchDocument, type SketchElement, type SketchLayer, type SketchModelOption, type SketchPoint, type SketchResolution, type SketchTool } from './sketchDocument'
import './SketchStudio.css'

const Model3DStudio = lazy(() => import('./Model3DStudio'))
const colors = ['#171717', '#ffffff', '#6b7280', '#92400e', '#dc2626', '#f97316', '#f59e0b', '#16a34a', '#0d9488', '#06b6d4', '#2563eb', '#4f46e5', '#9333ea', '#db2777']
const tools = [{ id: 'select', label: '选择 / 移动', icon: MousePointer2 }, { id: 'pen', label: '画笔', icon: Pencil }, { id: 'text', label: '文字', icon: Type }, { id: 'rect', label: '矩形', icon: Square }, { id: 'ellipse', label: '圆形', icon: Circle }, { id: 'eraser', label: '橡皮', icon: Eraser }, { id: 'pan', label: '平移画板', icon: Hand }] as const
type Props = {
  initialDocument?: SketchDocument
  defaultModel: string
  defaultResolution: SketchResolution
  models: SketchModelOption[]
  apiReady: boolean
  onComplete: (result: { document: SketchDocument; imageUrl: string }, generate: boolean) => Promise<void>
  onCancel: () => void
}
type Gesture = { kind: 'pan' | 'draw' | 'element' | 'layer'; start: SketchPoint; original: SketchDocument; itemId?: string; layerId?: string; pan?: SketchPoint }

export default function SketchStudio({ initialDocument, defaultModel, defaultResolution, models, apiReady, onComplete, onCancel }: Props) {
  const [doc, setDoc] = useState(() => structuredClone(initialDocument || createSketchDocument(defaultModel, defaultResolution)))
  const docRef = useRef(doc)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const imageCacheRef = useRef(new Map<string, Promise<HTMLImageElement>>())
  const undoRef = useRef<SketchDocument[]>([])
  const redoRef = useRef<SketchDocument[]>([])
  const gestureRef = useRef<Gesture | null>(null)
  const [revision, setRevision] = useState(0)
  const [tool, setTool] = useState<SketchTool>('pen')
  const [color, setColor] = useState('#171717')
  const [brushSize, setBrushSize] = useState(8)
  const [opacity, setOpacity] = useState(1)
  const [textDraft, setTextDraft] = useState('在此输入文字')
  const [textSize, setTextSize] = useState(40)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [zoom, setZoom] = useState(1)
  const [fit, setFit] = useState(0.5)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [dragLayerId, setDragLayerId] = useState<string | null>(null)
  const [modelEditor, setModelEditor] = useState<{ layerId: string | null; scene: SavedModel3DScene | null } | null>(null)
  const active = doc.layers.find(layer => layer.id === doc.activeLayerId)
  const selected = active?.elements.find(item => item.id === selectedId)
  const selectedModel = models.find(model => model.id === doc.model) || models.find(model => model.id === defaultModel) || models[0]
  const selectedResolution = selectedModel?.resolutions.includes(doc.imageSize) ? doc.imageSize : selectedModel?.resolutions[0] || defaultResolution

  function replace(next: SketchDocument) { docRef.current = next; setDoc(next); setDirty(true) }
  function remember(previous: SketchDocument) {
    undoRef.current = [...undoRef.current.slice(-49), previous]
    redoRef.current = []
    setRevision(value => value + 1)
  }
  function commit(next: SketchDocument) { remember(docRef.current); replace(next); setError('') }
  function patchLayer(layerId: string, patch: Partial<SketchLayer>) {
    const current = docRef.current
    commit({ ...current, layers: current.layers.map(layer => layer.id === layerId ? { ...layer, ...patch } : layer) })
  }
  function undo(redo = false) {
    const from = redo ? redoRef : undoRef
    const to = redo ? undoRef : redoRef
    const previous = from.current.pop()
    if (!previous) return
    to.current.push(docRef.current)
    replace(previous)
    setSelectedId(null)
    setRevision(value => value + 1)
  }

  useEffect(() => {
    const host = stageRef.current
    if (!host) return
    const observer = new ResizeObserver(() => setFit(Math.min((host.clientWidth - 64) / doc.width, (host.clientHeight - 48) / doc.height)))
    observer.observe(host)
    return () => observer.disconnect()
  }, [doc.width, doc.height])

  useEffect(() => {
    let cancelled = false
    const frame = requestAnimationFrame(() => {
      void renderSketch(doc, imageCacheRef.current).then(result => {
        if (cancelled || !canvasRef.current) return
        const canvas = canvasRef.current
        const context = canvas.getContext('2d')!
        context.clearRect(0, 0, canvas.width, canvas.height)
        context.drawImage(result, 0, 0)
        const layer = doc.layers.find(item => item.id === doc.activeLayerId)
        if (tool === 'select' && layer?.visible) {
          const item = layer.elements.find(element => element.id === selectedId)
          const bounds = item ? sketchElementBounds(item) : layer.kind !== 'draw' ? layer : null
          if (bounds) {
            context.strokeStyle = '#0891b2'
            context.lineWidth = 2 / Math.max(0.15, fit * zoom)
            context.setLineDash([6 / Math.max(0.15, fit * zoom), 4 / Math.max(0.15, fit * zoom)])
            context.strokeRect(bounds.x - 3, bounds.y - 3, bounds.width + 6, bounds.height + 6)
            context.setLineDash([])
          }
        }
      }).catch(reason => { if (!cancelled) setError(reason instanceof Error ? reason.message : '图层渲染失败') })
    })
    return () => { cancelled = true; cancelAnimationFrame(frame) }
  }, [doc, selectedId, tool, fit, zoom])

  useEffect(() => {
    if (modelEditor || busy) return
    const handler = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement)?.closest('input,textarea,select,[contenteditable="true"]')) return
      if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) {
        event.preventDefault(); event.stopPropagation(); undo(event.shiftKey || event.key.toLowerCase() === 'y')
      } else if ((event.key === 'Delete' || event.key === 'Backspace') && selectedId && active?.kind === 'draw' && !active.locked) {
        event.preventDefault(); event.stopPropagation()
        patchLayer(active.id, { elements: active.elements.filter(item => item.id !== selectedId) }); setSelectedId(null)
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  })

  function point(event: ReactPointerEvent<HTMLCanvasElement>): SketchPoint {
    const rect = event.currentTarget.getBoundingClientRect()
    return { x: (event.clientX - rect.left) * doc.width / rect.width, y: (event.clientY - rect.top) * doc.height / rect.height }
  }
  function pointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (busy || modelEditor || (event.button !== 0 && event.button !== 1)) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const start = point(event)
    const current = docRef.current
    if (tool === 'pan' || event.button === 1) {
      gestureRef.current = { kind: 'pan', start: { x: event.clientX, y: event.clientY }, original: current, pan }; return
    }
    if (!active || !active.visible || active.locked) { setError('请先选择一个可见且未锁定的图层。'); return }
    setError('')
    if (tool === 'select') {
      if (active.kind !== 'draw') {
        gestureRef.current = { kind: 'layer', start, original: current, layerId: active.id }; return
      }
      const hit = [...active.elements].reverse().find(item => {
        if (item.kind === 'eraser') return false
        const bounds = sketchElementBounds(item)
        return start.x >= bounds.x - 6 && start.x <= bounds.x + bounds.width + 6 && start.y >= bounds.y - 6 && start.y <= bounds.y + bounds.height + 6
      })
      setSelectedId(hit?.id || null)
      if (hit) { if (hit.kind === 'text') setTextDraft(hit.text || ''); gestureRef.current = { kind: 'element', start, original: current, layerId: active.id, itemId: hit.id } }
      return
    }
    if (active.kind !== 'draw') { setError('模型和图片层不能直接涂画，请新建一个手绘图层。'); return }
    const item: SketchElement = { id: crypto.randomUUID(), kind: tool, x: start.x, y: start.y, width: 0, height: 0, points: [{ x: 0, y: 0 }], color, size: tool === 'text' ? textSize : brushSize, opacity }
    if (tool === 'text') {
      if (!textDraft.trim()) { setError('请先在右侧输入文字。'); return }
      const measure = document.createElement('canvas').getContext('2d')!
      measure.font = `${textSize}px Inter, "Microsoft YaHei", sans-serif`
      item.text = textDraft
      item.width = Math.max(...textDraft.split('\n').map(line => measure.measureText(line).width))
      item.height = textDraft.split('\n').length * textSize * 1.3
      patchLayer(active.id, { elements: [...active.elements, item] }); setSelectedId(item.id); return
    }
    gestureRef.current = { kind: 'draw', start, original: current, layerId: active.id, itemId: item.id }
    replace({ ...current, layers: current.layers.map(layer => layer.id === active.id ? { ...layer, elements: [...layer.elements, item] } : layer) })
    setSelectedId(null)
  }
  function pointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    const gesture = gestureRef.current
    if (!gesture) return
    if (gesture.kind === 'pan') {
      setPan({ x: gesture.pan!.x + event.clientX - gesture.start.x, y: gesture.pan!.y + event.clientY - gesture.start.y }); return
    }
    const nextPoint = point(event)
    const dx = nextPoint.x - gesture.start.x, dy = nextPoint.y - gesture.start.y
    const sourceLayer = gesture.original.layers.find(layer => layer.id === gesture.layerId)!
    const current = docRef.current
    replace({ ...current, layers: current.layers.map(layer => {
      if (layer.id !== gesture.layerId) return layer
      if (gesture.kind === 'layer') return { ...layer, x: sourceLayer.x + dx, y: sourceLayer.y + dy }
      return { ...layer, elements: layer.elements.map(item => {
        if (item.id !== gesture.itemId) return item
        if (gesture.kind === 'element') {
          const original = sourceLayer.elements.find(element => element.id === gesture.itemId)!
          return { ...item, x: original.x + dx, y: original.y + dy }
        }
        if (item.kind === 'pen' || item.kind === 'eraser') {
          const last = item.points[item.points.length - 1]
          if (Math.hypot(last.x - dx, last.y - dy) < 1 || item.points.length >= 12000) return item
          return { ...item, points: [...item.points, { x: dx, y: dy }] }
        }
        return { ...item, width: dx, height: dy }
      }) }
    }) })
  }
  function pointerUp(event: ReactPointerEvent<HTMLCanvasElement>) {
    const gesture = gestureRef.current
    if (!gesture) return
    if (gesture.kind !== 'pan' && gesture.original !== docRef.current) remember(gesture.original)
    gestureRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }
  function addLayer() {
    const layer = createSketchLayer(`手绘图层 ${doc.layers.filter(item => item.kind === 'draw').length + 1}`)
    const layers = [...doc.layers]
    const activeIndex = layers.findIndex(item => item.id === doc.activeLayerId)
    layers.splice(activeIndex + 1, 0, layer)
    commit({ ...doc, layers, activeLayerId: layer.id }); setTool('pen'); setSelectedId(null)
  }
  async function importImage(file?: File) {
    if (!file) return
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 20 * 1024 * 1024) { setError('请选择 20 MB 以内的 PNG、JPG 或 WebP 图片。'); return }
    setBusy(true)
    try {
      const imageUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('图片读取失败')); reader.readAsDataURL(file) })
      const image = await loadSketchImage(imageUrl)
      const current = docRef.current
      const scale = Math.min(current.width / image.naturalWidth, current.height / image.naturalHeight)
      const width = image.naturalWidth * scale, height = image.naturalHeight * scale
      const layer = { ...createSketchLayer(file.name, 'image'), imageUrl, width, height, x: (current.width - width) / 2, y: (current.height - height) / 2 }
      commit({ ...current, layers: [layer, ...current.layers] })
    } catch (reason) { setError(reason instanceof Error ? reason.message : '图片导入失败') } finally { setBusy(false) }
  }
  async function openModel(layer?: SketchLayer) {
    setBusy(true)
    try {
      const scene = layer?.sceneId ? await readModel3DScene(layer.sceneId) : null
      if (layer?.sceneId && !scene) throw new Error('找不到模型的可编辑场景，请重新导入模型。')
      setModelEditor({ layerId: layer?.id || null, scene })
    } catch (reason) { setError(reason instanceof Error ? reason.message : '模型打开失败') } finally { setBusy(false) }
  }
  function resize(width: number, height: number) {
    const current = docRef.current
    const scale = Math.min(width / current.width, height / current.height)
    const dx = (width - current.width * scale) / 2, dy = (height - current.height * scale) / 2
    commit({ ...current, width, height, layers: current.layers.map(layer => ({ ...layer, x: layer.x * scale + dx, y: layer.y * scale + dy, width: layer.width * scale, height: layer.height * scale, elements: layer.elements.map(item => ({ ...item, x: item.x * scale + dx, y: item.y * scale + dy, width: item.width * scale, height: item.height * scale, size: item.size * scale, points: item.points.map(p => ({ x: p.x * scale, y: p.y * scale })) })) })) })
    setPan({ x: 0, y: 0 }); setZoom(1)
  }
  async function finish(generate: boolean) {
    if (busy) return
    if (generate && !apiReady) { setError('请先在网站 API 设置中填写密钥。你可以先保存手绘，配置后再打开生成。'); return }
    if (generate && !doc.prompt.trim()) { setError('请填写生成提示词，描述草稿应生成的效果。'); return }
    if (generate && !doc.layers.some(layer => layer.visible && layer.opacity > 0 && (layer.imageUrl || layer.elements.some(item => item.kind !== 'eraser')))) { setError('请先绘制草稿或导入图片、模型。'); return }
    setBusy(true); setError('')
    try {
      const current = { ...doc, model: selectedModel?.id || defaultModel, imageSize: selectedResolution }
      const canvas = await renderSketch(current, imageCacheRef.current)
      await onComplete({ document: current, imageUrl: canvas.toDataURL('image/png') }, generate)
    } catch (reason) { setError(reason instanceof Error ? reason.message : '保存手绘失败'); setBusy(false) }
  }
  void revision
  const editedModelLayer = doc.layers.find(layer => layer.id === modelEditor?.layerId)

  return (
    <div className="sketch-backdrop" onPointerDown={event => event.stopPropagation()}>
      <section className="sketch-studio" role="dialog" aria-modal="true" aria-label="分层手绘画板">
        <header className="sketch-head">
          <div><Pencil size={19} /><strong>手绘画板</strong><span>草稿、模型与灵感，在这里叠加</span></div>
          <button type="button" aria-label="关闭手绘画板并保存" title="保存并返回画布" onClick={() => dirty ? void finish(false) : onCancel()} disabled={busy}><X size={19} /></button>
        </header>
        <div className="sketch-body">
          <main className="sketch-workspace">
            <div className="sketch-toolbar" role="toolbar" aria-label="绘画工具">
              {tools.map(item => <button type="button" key={item.id} title={item.label} aria-label={item.label} aria-pressed={tool === item.id} className={tool === item.id ? 'active' : ''} disabled={busy} onClick={() => { setTool(item.id); setError('') }}><item.icon size={21} /></button>)}
              <span className="sketch-divider" />
              <button type="button" title="撤销 Ctrl+Z" aria-label="撤销手绘" disabled={busy || !undoRef.current.length} onClick={() => undo()}><Undo2 size={19} /></button>
              <button type="button" title="重做 Ctrl+Shift+Z" aria-label="重做手绘" disabled={busy || !redoRef.current.length} onClick={() => undo(true)}><Redo2 size={19} /></button>
            </div>
            <div className="sketch-stage" ref={stageRef} onWheel={event => { if (!busy) setZoom(current => Math.max(0.25, Math.min(4, current * (event.deltaY > 0 ? 0.9 : 1.1)))) }}>
              <div className="sketch-paper" style={{ width: doc.width, height: doc.height, transform: `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px) scale(${Math.max(0.05, fit * zoom)})` }}>
                <canvas ref={canvasRef} width={doc.width} height={doc.height} aria-label="手绘绘制区域" style={{ cursor: tool === 'pan' ? 'grab' : tool === 'select' ? 'default' : 'crosshair' }} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp} onContextMenu={event => event.preventDefault()} />
              </div>
              <span className="sketch-stage-label">{doc.width} × {doc.height} · {active?.name || '请选择图层'}</span>
              <div className="sketch-zoom"><button type="button" aria-label="缩小手绘画板" onClick={() => setZoom(value => Math.max(0.25, value / 1.2))}><ZoomOut size={16} /></button><button type="button" title="适应窗口" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }) }}>{Math.round(zoom * 100)}%</button><button type="button" aria-label="放大手绘画板" onClick={() => setZoom(value => Math.min(4, value * 1.2))}><ZoomIn size={16} /></button></div>
            </div>
            <div className="sketch-palette" aria-label="绘画颜色">
              <input type="color" aria-label="自定义画笔颜色" value={color} onChange={event => setColor(event.target.value)} />
              {colors.map(value => <button key={value} type="button" aria-label={`画笔颜色 ${value}`} aria-pressed={color === value} className={color === value ? 'active' : ''} style={{ backgroundColor: value }} onClick={() => setColor(value)}>{color === value && <Check size={15} color={value === '#ffffff' ? '#171717' : '#ffffff'} />}</button>)}
            </div>
          </main>
          <aside className="sketch-inspector" inert={busy || Boolean(modelEditor)}>
            <section>
              <div className="sketch-section-title"><Layers size={16} /><strong>图层</strong><small>上层遮挡下层</small></div>
              <div className="sketch-layer-actions">
                <button type="button" disabled={busy} onClick={addLayer}><Plus size={14} />手绘</button>
                <button type="button" disabled={busy} onClick={() => fileRef.current?.click()}><ImagePlus size={14} />图片</button>
                <button type="button" disabled={busy} onClick={() => void openModel()}><Box size={14} />模型</button>
                <input ref={fileRef} hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={event => { void importImage(event.target.files?.[0]); event.target.value = '' }} />
              </div>
              <div className="sketch-layers" aria-label="图层列表">
                {[...doc.layers].reverse().map(layer => <div key={layer.id} className={`sketch-layer ${layer.id === doc.activeLayerId ? 'active' : ''}`} draggable={!busy} onDragStart={() => setDragLayerId(layer.id)} onDragOver={event => event.preventDefault()} onDragEnd={() => setDragLayerId(null)} onDrop={event => { event.preventDefault(); if (dragLayerId && dragLayerId !== layer.id) commit(moveSketchLayer(doc, dragLayerId, doc.layers.findIndex(item => item.id === layer.id))); setDragLayerId(null) }}>
                  <button
                    type="button"
                    className="sketch-layer-name"
                    aria-label={layer.kind === 'model' ? `编辑模型图层 ${layer.name}` : `选择图层 ${layer.name}`}
                    title={layer.kind === 'model' ? '返回 3D 窗口调整模型角度与颜色；确认后替换当前图层' : undefined}
                    disabled={busy}
                    onClick={() => {
                      replace({ ...docRef.current, activeLayerId: layer.id })
                      setSelectedId(null)
                      if (layer.kind === 'model') void openModel(layer)
                    }}
                  >
                    {layer.kind === 'model' ? <Box size={16} /> : layer.kind === 'image' ? <ImagePlus size={16} /> : <Pencil size={16} />}
                    <span>{layer.name}</span>
                  </button>
                  <button type="button" aria-label={`${layer.visible ? '隐藏' : '显示'}图层 ${layer.name}`} onClick={() => patchLayer(layer.id, { visible: !layer.visible })}>{layer.visible ? <Eye size={14} /> : <EyeOff size={14} />}</button>
                  <button type="button" aria-label={`${layer.locked ? '解锁' : '锁定'}图层 ${layer.name}`} onClick={() => patchLayer(layer.id, { locked: !layer.locked })}>{layer.locked ? <Lock size={14} /> : <Unlock size={14} />}</button>
                </div>)}
                <div className="sketch-background-row"><input type="color" aria-label="画板背景颜色" value={doc.background} onChange={event => commit({ ...doc, background: event.target.value })} /><span>画板背景</span><Lock size={13} /></div>
              </div>
              {active && <div className="sketch-layer-properties">
                <input key={active.id + active.name} aria-label="图层名称" defaultValue={active.name} onBlur={event => { const name = event.target.value.trim(); if (name && name !== active.name) patchLayer(active.id, { name }) }} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }} />
                <div className="sketch-row-buttons">
                  <button type="button" title="图层上移" aria-label="图层上移" disabled={doc.layers[doc.layers.length - 1].id === active.id} onClick={() => commit(moveSketchLayer(doc, active.id, doc.layers.findIndex(layer => layer.id === active.id) + 1))}><ArrowUp size={15} /></button>
                  <button type="button" title="图层下移" aria-label="图层下移" disabled={doc.layers[0].id === active.id} onClick={() => commit(moveSketchLayer(doc, active.id, doc.layers.findIndex(layer => layer.id === active.id) - 1))}><ArrowDown size={15} /></button>
                  <button type="button" title="复制图层" aria-label="复制图层" onClick={() => { const copy = { ...structuredClone(active), id: crypto.randomUUID(), name: `${active.name} 副本` }; const layers = [...doc.layers]; layers.splice(layers.findIndex(layer => layer.id === active.id) + 1, 0, copy); commit({ ...doc, layers, activeLayerId: copy.id }) }}><Copy size={15} /></button>
                  <button type="button" title="删除图层（可撤销）" aria-label="删除当前图层" disabled={active.locked} onClick={() => { let layers = doc.layers.filter(layer => layer.id !== active.id); if (!layers.length) layers = [createSketchLayer('手绘图层 1')]; commit({ ...doc, layers, activeLayerId: layers[layers.length - 1].id }); setSelectedId(null) }}><Trash2 size={15} /></button>
                </div>
                <label>图层透明度 <span>{Math.round(active.opacity * 100)}%</span><UnifiedRange min={0} max={100} value={active.opacity * 100} disabled={active.locked} aria-label="图层透明度" onValueChange={value => patchLayer(active.id, { opacity: value / 100 })} /></label>
                {active.kind === 'draw' ? <button type="button" disabled={active.locked || !active.elements.length} onClick={() => { patchLayer(active.id, { elements: [] }); setSelectedId(null) }}>清空本层手绘</button> : <>
                  <label>图层宽度 <span>{Math.round(active.width)} px</span><UnifiedRange min={32} max={doc.width * 2} value={active.width} disabled={active.locked} aria-label="图片或模型图层宽度" onValueChange={width => { const height = active.height * width / active.width; patchLayer(active.id, { width, height, x: active.x + (active.width - width) / 2, y: active.y + (active.height - height) / 2 }) }} /></label>
                  {active.kind === 'model' && <button type="button" disabled={busy} onClick={() => void openModel(active)}><Box size={14} />调整模型角度与颜色</button>}
                </>}
              </div>}
              <p className="sketch-help">将手绘层移到模型上方可遮挡模型，移到下方则画在模型背后。橡皮仅擦除当前手绘层。</p>
            </section>
            <section>
              <div className="sketch-section-title"><Pencil size={16} /><strong>绘制设置</strong></div>
              <label>笔刷粗细 <span>{brushSize} px</span><UnifiedRange aria-label="手绘笔刷粗细" min={1} max={100} value={brushSize} onValueChange={setBrushSize} /></label>
              <label>笔刷透明度 <span>{Math.round(opacity * 100)}%</span><UnifiedRange aria-label="笔刷透明度" min={5} max={100} value={opacity * 100} onValueChange={value => setOpacity(value / 100)} /></label>
              {(tool === 'text' || selected?.kind === 'text') && <>
                <textarea aria-label="手绘文字内容" value={textDraft} onChange={event => setTextDraft(event.target.value)} placeholder="输入文字，再点击画板放置" rows={2} />
                <label>字号 <input type="number" aria-label="手绘文字字号" min={12} max={200} value={textSize} onChange={event => setTextSize(Math.max(12, Math.min(200, Number(event.target.value) || 12)))} /></label>
                {selected?.kind === 'text' && <button type="button" disabled={active?.locked} onClick={() => { if (active) patchLayer(active.id, { elements: active.elements.map(item => item.id === selected.id ? { ...item, text: textDraft, size: textSize, color, width: Math.max(1, ...textDraft.split('\n').map(line => line.length)) * textSize, height: textDraft.split('\n').length * textSize * 1.3 } : item) }) }}>更新选中文字</button>}
              </>}
              <label>画板比例<select aria-label="手绘画板比例" value={`${doc.width}x${doc.height}`} onChange={event => { const [width, height] = event.target.value.split('x').map(Number); resize(width, height) }}>{sketchSizes.map(size => <option key={size.label} value={`${size.width}x${size.height}`}>{size.label}</option>)}</select></label>
              <p className="sketch-help">滚轮缩放，中键平移。选择工具可移动当前层内容。模型角度变化后，已有手绘不会自动贴合新视角。</p>
            </section>
            <section>
              <div className="sketch-section-title"><Wand2 size={16} /><strong>草稿生成图像</strong></div>
              <label>图像模型<select aria-label="手绘生成模型" value={selectedModel?.id || defaultModel} onChange={event => { const model = models.find(item => item.id === event.target.value)!; commit({ ...doc, model: model.id, imageSize: model.resolutions.includes(doc.imageSize) ? doc.imageSize : model.resolutions[0] }) }}>{models.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}</select></label>
              <div className="sketch-resolution" aria-label="手绘输出清晰度">{selectedModel?.resolutions.map(size => <button type="button" key={size} aria-pressed={selectedResolution === size} className={selectedResolution === size ? 'active' : ''} onClick={() => commit({ ...doc, imageSize: size })}>{size}</button>)}</div>
              <textarea aria-label="手绘生成提示词" placeholder="描述草稿应生成的效果，例如：保留瓶身角度，将前景线稿变成白色花朵，背景为浅蓝色摄影棚…" value={doc.prompt} onChange={event => replace({ ...doc, prompt: event.target.value })} rows={5} />
              <p className="sketch-help">按可见图层合成参考图。保存后可在画布中再次打开编辑，也可以连接其他图像生成框。</p>
            </section>
          </aside>
        </div>
        <footer className="sketch-footer"><div role={error ? 'alert' : 'status'} className={error ? 'sketch-error' : 'sketch-help'}>{error || (busy ? '正在处理，请稍候…' : '图层独立保存 · 关闭窗口会保存编辑 · 项目请通过顶部保存按钮保存为 ZIP')}</div><div><button type="button" disabled={busy} onClick={() => void finish(false)}><Save size={15} />保存到画布</button><button type="button" className="sketch-generate" aria-label={busy ? '正在处理' : 'Run 生成图像'} title="Run 生成图像" disabled={busy} onClick={() => void finish(true)}>{busy ? <Loader2 size={15} className="export-spinner" /> : 'Run'}</button></div></footer>
      </section>
      {modelEditor && <div className="sketch-model-overlay"><Suspense fallback={<div className="sketch-loading" role="status"><Loader2 size={22} />正在载入 3D 编辑器…</div>}><Model3DStudio
        initialScene={modelEditor.scene}
        useSavedScene={false}
        transparentExport
        exportViewport={{ width: Math.round(editedModelLayer?.width || doc.width), height: Math.round(editedModelLayer?.height || doc.height) }}
        onClose={() => setModelEditor(null)}
        onExport={async result => {
          // New immutable scene version keeps layer duplicates and undo independent.
          const sceneId = crypto.randomUUID()
          await saveModel3DScene(sceneId, result.scene)
          const current = docRef.current
          const previous = current.layers.find(layer => layer.id === modelEditor.layerId)
          const modelLayer: SketchLayer = { ...(previous || createSketchLayer('3D 模型', 'model')), imageUrl: result.dataUrl, sceneId, width: previous?.width || current.width, height: previous?.height || current.height }
          if (previous) commit({ ...current, layers: current.layers.map(layer => layer.id === previous.id ? modelLayer : layer) })
          else {
            const back = createSketchLayer('背景手绘')
            commit({ ...current, layers: [back, modelLayer, ...current.layers] })
          }
          setModelEditor(null)
        }}
      /></Suspense></div>}
    </div>
  )
}
