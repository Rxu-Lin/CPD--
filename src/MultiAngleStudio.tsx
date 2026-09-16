import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Camera,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Loader2,
  Orbit,
  RotateCcw,
  X,
} from 'lucide-react'
import './MultiAngleStudio.css'

export type MultiAngleFraming = 'close' | 'medium' | 'wide'
export type MultiAngleLens = 'standard' | 'fisheye' | 'tilted'

export type MultiAngleModelOption = {
  id: string
  label: string
}

export type MultiAngleResult = {
  presetId: string
  presetLabel: string
  horizontal: number
  vertical: number
  framing: MultiAngleFraming
  lens: MultiAngleLens
  roll: number
  modelId: string
  modelLabel: string
  prompt: string
  sourceWidth: number
  sourceHeight: number
}

type Props = {
  sourceImageUrl: string
  sourceName?: string
  models: MultiAngleModelOption[]
  initialModelId: string
  modelsLoading?: boolean
  busy?: boolean
  onClose: () => void
  onGenerate: (result: MultiAngleResult) => Promise<void>
}

type Preset = {
  id: string
  label: string
  horizontal: number
  vertical: number
  framing: MultiAngleFraming
  lens: MultiAngleLens
  roll: number
}

const defaultView: Preset = {
  id: 'custom',
  label: '自定义',
  horizontal: 0,
  vertical: 0,
  framing: 'medium',
  lens: 'standard',
  roll: 0,
}

const presets: Preset[] = [
  defaultView,
  { id: 'fisheye', label: '鱼眼视角', horizontal: -20, vertical: 8, framing: 'wide', lens: 'fisheye', roll: 0 },
  { id: 'tilted', label: '倾斜视角', horizontal: 32, vertical: 16, framing: 'medium', lens: 'tilted', roll: -8 },
  { id: 'front-high', label: '正面俯拍', horizontal: 0, vertical: 36, framing: 'medium', lens: 'standard', roll: 0 },
  { id: 'front-low', label: '正面仰拍', horizontal: 0, vertical: -28, framing: 'medium', lens: 'standard', roll: 0 },
  { id: 'overhead', label: '全景俯拍', horizontal: 0, vertical: 72, framing: 'wide', lens: 'standard', roll: 0 },
  { id: 'rear', label: '背面视角', horizontal: 180, vertical: 0, framing: 'medium', lens: 'standard', roll: 0 },
]

const framingOptions: Array<{ value: MultiAngleFraming; label: string; prompt: string; scale: number }> = [
  { value: 'close', label: '近景', prompt: '近景特写，主体占据画面约 78%，保留少量环境', scale: 1.16 },
  { value: 'medium', label: '中景', prompt: '中景构图，完整呈现主体，主体占据画面约 58%', scale: 1 },
  { value: 'wide', label: '全景', prompt: '全景构图，主体完整且保留充足环境空间', scale: 0.82 },
]

const orbitCanvasSize = 320
const orbitRadius = 142

type SpherePoint = { x: number; y: number; z: number }

function rotateSpherePoint(point: SpherePoint, horizontal: number, vertical: number): SpherePoint {
  const yaw = -horizontal * Math.PI / 180
  const pitch = vertical * Math.PI / 180
  const yawX = point.x * Math.cos(yaw) + point.z * Math.sin(yaw)
  const yawZ = -point.x * Math.sin(yaw) + point.z * Math.cos(yaw)
  return {
    x: yawX,
    y: point.y * Math.cos(pitch) - yawZ * Math.sin(pitch),
    z: point.y * Math.sin(pitch) + yawZ * Math.cos(pitch),
  }
}

function spherePoint(latitude: number, longitude: number, horizontal: number, vertical: number) {
  const latitudeRadians = latitude * Math.PI / 180
  const longitudeRadians = longitude * Math.PI / 180
  return rotateSpherePoint({
    x: Math.cos(latitudeRadians) * Math.sin(longitudeRadians),
    y: Math.sin(latitudeRadians),
    z: Math.cos(latitudeRadians) * Math.cos(longitudeRadians),
  }, horizontal, vertical)
}

function getCameraPosition(horizontal: number, vertical: number) {
  const longitude = horizontal * Math.PI / 180
  const latitude = vertical * Math.PI / 180
  return {
    x: orbitCanvasSize / 2 + Math.sin(longitude) * Math.cos(latitude) * orbitRadius,
    y: orbitCanvasSize / 2 - Math.sin(latitude) * orbitRadius,
  }
}

function degreeLabel(value: number) {
  return `${Math.round(value)}°`
}

function horizontalDescription(value: number) {
  const absolute = Math.abs(value)
  if (absolute >= 165) return '从主体正后方观察的背面视角'
  if (absolute >= 110) return value > 0 ? '从主体右后侧观察' : '从主体左后侧观察'
  if (absolute >= 55) return value > 0 ? '从主体右侧观察' : '从主体左侧观察'
  if (absolute >= 12) return value > 0 ? '从主体右前方观察的三分之四视角' : '从主体左前方观察的三分之四视角'
  return '保持主体正面朝向镜头'
}

function verticalDescription(value: number) {
  if (value >= 62) return '接近垂直向下的全景俯拍视角'
  if (value >= 18) return '从主体上方向下俯拍'
  if (value <= -18) return '从主体下方向上仰拍'
  return '镜头与主体中心基本等高'
}

function lensDescription(lens: MultiAngleLens, roll: number) {
  if (lens === 'fisheye') return '使用明显但可控的鱼眼广角透视，中心主体清晰，边缘自然弯曲'
  if (lens === 'tilted') return `使用倾斜镜头构图，画面旋转约 ${Math.abs(roll)}°，保持主体结构真实`
  return '使用自然的标准镜头透视，不使用夸张畸变'
}

function buildPrompt(view: Preset, extraPrompt: string) {
  const framing = framingOptions.find((option) => option.value === view.framing) || framingOptions[1]
  const extra = extraPrompt.trim()
  return [
    '以输入图片中的主体为唯一设计参考，生成同一主体的全新相机视角画面。',
    `相机水平环绕 ${degreeLabel(view.horizontal)}：${horizontalDescription(view.horizontal)}。`,
    `相机垂直俯仰 ${degreeLabel(view.vertical)}：${verticalDescription(view.vertical)}。`,
    `景别：${framing.prompt}。`,
    `镜头：${lensDescription(view.lens, view.roll)}。`,
    '必须保持主体身份、外形比例、结构、材质、颜色、纹理、文字、Logo、装饰细节和产品设计一致；保持原图的光照氛围、背景风格和整体色调。',
    '这是相机在三维空间中的视角变化，不是把原图做二维旋转、翻转、拉伸或裁切。根据新视角自然补全被遮挡面，避免重复部件、结构变形和文字乱码。',
    extra ? `补充要求：${extra}` : '',
  ].filter(Boolean).join('\n')
}

export default function MultiAngleStudio({ sourceImageUrl, sourceName, models, initialModelId, modelsLoading = false, busy = false, onClose, onGenerate }: Props) {
  const orbitCanvasRef = useRef<HTMLCanvasElement>(null)
  const modelPickerRef = useRef<HTMLDivElement>(null)
  const initialModel = models.find((model) => model.id === initialModelId) || models[0] || { id: initialModelId, label: initialModelId || '当前图像模型' }
  const [view, setView] = useState<Preset>(defaultView)
  const [selectedModelId, setSelectedModelId] = useState(initialModel.id)
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [showPrompt, setShowPrompt] = useState(false)
  const [extraPrompt, setExtraPrompt] = useState('')
  const [sourceSize, setSourceSize] = useState({ width: 0, height: 0 })
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const prompt = useMemo(() => buildPrompt(view, extraPrompt), [extraPrompt, view])
  const framing = framingOptions.find((option) => option.value === view.framing) || framingOptions[1]
  const selectedModel = models.find((model) => model.id === selectedModelId) || initialModel

  useEffect(() => {
    if (models.some((model) => model.id === selectedModelId)) return
    setSelectedModelId(models.find((model) => model.id === initialModelId)?.id || models[0]?.id || initialModelId)
  }, [initialModelId, models, selectedModelId])

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (modelMenuOpen) {
        setModelMenuOpen(false)
        return
      }
      if (!submitting && !busy) onClose()
    }
    window.addEventListener('keydown', handleEscape, true)
    return () => window.removeEventListener('keydown', handleEscape, true)
  }, [busy, modelMenuOpen, onClose, submitting])

  useEffect(() => {
    if (!modelMenuOpen) return
    const closeOutside = (event: PointerEvent) => {
      if (!modelPickerRef.current?.contains(event.target as Node)) setModelMenuOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside, true)
    return () => document.removeEventListener('pointerdown', closeOutside, true)
  }, [modelMenuOpen])

  useEffect(() => {
    if (submitting || busy || modelsLoading) setModelMenuOpen(false)
  }, [busy, modelsLoading, submitting])

  useEffect(() => {
    const canvas = orbitCanvasRef.current
    if (!canvas) return
    const size = orbitCanvasSize
    const pixelRatio = Math.max(1, Math.min(2, window.devicePixelRatio || 1))
    canvas.width = size * pixelRatio
    canvas.height = size * pixelRatio
    const context = canvas.getContext('2d')
    if (!context) return
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
    context.clearRect(0, 0, size, size)

    const centerX = size / 2
    const centerY = size / 2
    const radius = orbitRadius
    context.lineWidth = 1
    context.strokeStyle = 'rgba(181, 197, 211, 0.52)'
    context.beginPath()
    context.arc(centerX, centerY, radius, 0, Math.PI * 2)
    context.stroke()

    function drawGridCurve(curveContext: CanvasRenderingContext2D, points: SpherePoint[], emphasized = false) {
      for (const front of [false, true]) {
        curveContext.beginPath()
        let started = false
        for (const point of points) {
          const isFront = point.z >= 0
          if (isFront !== front) {
            started = false
            continue
          }
          const x = centerX + point.x * radius
          const y = centerY - point.y * radius
          if (started) curveContext.lineTo(x, y)
          else curveContext.moveTo(x, y)
          started = true
        }
        curveContext.strokeStyle = emphasized
          ? (front ? 'rgba(97, 199, 232, 0.5)' : 'rgba(97, 199, 232, 0.12)')
          : (front ? 'rgba(181, 197, 211, 0.42)' : 'rgba(139, 154, 167, 0.14)')
        curveContext.lineWidth = emphasized && front ? 1.25 : 1
        curveContext.setLineDash(front ? [] : [3, 4])
        curveContext.stroke()
      }
    }

    for (const latitude of [-60, -30, 0, 30, 60]) {
      const points: SpherePoint[] = []
      for (let longitude = -180; longitude <= 180; longitude += 3) {
        points.push(spherePoint(latitude, longitude, view.horizontal, view.vertical))
      }
      drawGridCurve(context, points, latitude === 0)
    }

    for (const longitude of [-150, -120, -90, -60, -30, 0, 30, 60, 90, 120, 150, 180]) {
      const points: SpherePoint[] = []
      for (let latitude = -90; latitude <= 90; latitude += 3) {
        points.push(spherePoint(latitude, longitude, view.horizontal, view.vertical))
      }
      drawGridCurve(context, points, longitude === 0)
    }

    context.setLineDash([])
    const camera = getCameraPosition(view.horizontal, view.vertical)
    context.lineWidth = 1.2
    context.strokeStyle = 'rgba(97, 199, 232, 0.48)'
    context.beginPath()
    context.moveTo(centerX, centerY)
    context.lineTo(camera.x, camera.y)
    context.stroke()
  }, [view.horizontal, view.vertical])

  function choosePreset(preset: Preset) {
    if (submitting || busy) return
    setView({ ...preset })
    setError('')
  }

  function updateCustom(patch: Partial<Preset>) {
    setView((current) => ({ ...current, ...patch, id: 'custom', label: '自定义' }))
    setError('')
  }

  function nudge(axis: 'horizontal' | 'vertical', amount: number) {
    const min = axis === 'horizontal' ? -180 : -80
    const max = axis === 'horizontal' ? 180 : 80
    updateCustom({ [axis]: Math.max(min, Math.min(max, view[axis] + amount)) })
  }

  function reset() {
    setView({ ...defaultView })
    setSelectedModelId(initialModel.id)
    setModelMenuOpen(false)
    setExtraPrompt('')
    setShowPrompt(false)
    setError('')
  }

  async function submit() {
    if (!sourceSize.width || !sourceSize.height) {
      setError('原图尺寸尚未读取完成，请稍后再试。')
      return
    }
    setSubmitting(true)
    setError('')
    try {
      await onGenerate({
        presetId: view.id,
        presetLabel: view.label,
        horizontal: view.horizontal,
        vertical: view.vertical,
        framing: view.framing,
        lens: view.lens,
        roll: view.roll,
        modelId: selectedModel.id,
        modelLabel: selectedModel.label,
        prompt,
        sourceWidth: sourceSize.width,
        sourceHeight: sourceSize.height,
      })
    } catch (reason) {
      setSubmitting(false)
      setError(reason instanceof Error ? reason.message : '多角度生成任务创建失败')
    }
  }

  const cameraPosition = getCameraPosition(view.horizontal, view.vertical)

  return (
    <div className="multi-angle-backdrop" role="presentation" onPointerDown={(event) => event.stopPropagation()}>
      <section className="multi-angle-studio" role="dialog" aria-modal="true" aria-label="多角度编辑器">
        <header className="multi-angle-head">
          <div><Orbit size={21} /><strong>多角度编辑器</strong></div>
          <button type="button" onClick={onClose} disabled={submitting || busy} title="关闭多角度编辑器" aria-label="关闭多角度编辑器"><X size={21} /></button>
        </header>

        <nav className="multi-angle-presets" aria-label="相机角度预设">
          {presets.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={view.id === preset.id ? 'active' : ''}
              aria-pressed={view.id === preset.id}
              disabled={submitting || busy}
              onClick={() => choosePreset(preset)}
            >
              {preset.label}
            </button>
          ))}
        </nav>

        <div className="multi-angle-body">
          <div className="multi-angle-orbit-panel">
            <div className="multi-angle-orbit-stage">
              <div className="multi-angle-orbit-visual">
                <canvas ref={orbitCanvasRef} aria-hidden="true" />
                <div className="multi-angle-source-preview">
                  <img
                    src={sourceImageUrl}
                    alt={sourceName || '多角度参考图'}
                    draggable={false}
                    onLoad={(event) => {
                      setSourceSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })
                      setLoading(false)
                      setError('')
                    }}
                    onError={() => {
                      setLoading(false)
                      setError('无法读取这张图片，请重新上传后再试。')
                    }}
                  />
                </div>
                <div
                  className="multi-angle-camera-marker"
                  role="img"
                  aria-label={`摄像机位置：水平 ${degreeLabel(view.horizontal)}，垂直 ${degreeLabel(view.vertical)}`}
                  title={`摄像机位置 · ${degreeLabel(view.horizontal)} / ${degreeLabel(view.vertical)}`}
                  style={{
                    left: `${cameraPosition.x / orbitCanvasSize * 100}%`,
                    top: `${cameraPosition.y / orbitCanvasSize * 100}%`,
                  }}
                >
                  <Camera size={15} strokeWidth={2.2} />
                </div>
              </div>
              {loading && <span className="multi-angle-loading"><Loader2 size={18} /> 正在读取原图</span>}
              <button className="orbit-nudge top" type="button" title="增加俯拍角度" onClick={() => nudge('vertical', 10)} disabled={submitting || busy}><ChevronUp size={19} /></button>
              <button className="orbit-nudge right" type="button" title="向右环绕" onClick={() => nudge('horizontal', 15)} disabled={submitting || busy}><ChevronRight size={19} /></button>
              <button className="orbit-nudge bottom" type="button" title="增加仰拍角度" onClick={() => nudge('vertical', -10)} disabled={submitting || busy}><ChevronDown size={19} /></button>
              <button className="orbit-nudge left" type="button" title="向左环绕" onClick={() => nudge('horizontal', -15)} disabled={submitting || busy}><ChevronLeft size={19} /></button>
            </div>
            <div className="multi-angle-view-summary">
              <span>{horizontalDescription(view.horizontal)}</span>
              <small>{sourceSize.width ? `${sourceSize.width} × ${sourceSize.height}px` : '读取原图尺寸中'}</small>
            </div>
          </div>

          <div className="multi-angle-controls">
            <label>
              <span>水平环绕</span>
              <input type="range" min={-180} max={180} step={1} value={view.horizontal} disabled={submitting || busy} onChange={(event) => updateCustom({ horizontal: Number(event.target.value), lens: 'standard', roll: 0 })} />
              <output>{degreeLabel(view.horizontal)}</output>
            </label>
            <label>
              <span>垂直俯仰</span>
              <input type="range" min={-80} max={80} step={1} value={view.vertical} disabled={submitting || busy} onChange={(event) => updateCustom({ vertical: Number(event.target.value), lens: 'standard', roll: 0 })} />
              <output>{degreeLabel(view.vertical)}</output>
            </label>
            <label>
              <span>景别缩放</span>
              <input
                type="range"
                min={0}
                max={2}
                step={1}
                value={framingOptions.findIndex((option) => option.value === view.framing)}
                disabled={submitting || busy}
                onChange={(event) => updateCustom({ framing: framingOptions[Number(event.target.value)]?.value || 'medium' })}
              />
              <output>{framing.label}</output>
            </label>

            <div className="multi-angle-model-control">
              <span>生成模型</span>
              <div ref={modelPickerRef} className={`multi-angle-model-picker ${modelMenuOpen ? 'open' : ''}`}>
                <button
                  className="multi-angle-model-trigger"
                  type="button"
                  disabled={submitting || busy || modelsLoading || models.length <= 1}
                  aria-label={`多角度生成模型：${selectedModel.label}`}
                  aria-haspopup="listbox"
                  aria-expanded={modelMenuOpen}
                  title={modelsLoading ? '正在读取可用模型' : modelMenuOpen ? '收起模型列表' : '展开模型列表'}
                  onClick={() => setModelMenuOpen((open) => !open)}
                  onKeyDown={(event) => {
                    if (event.key !== 'ArrowDown') return
                    event.preventDefault()
                    setModelMenuOpen(true)
                  }}
                >
                  <span>{selectedModel.label}</span>
                  {modelsLoading ? <Loader2 className="multi-angle-model-spinner" size={16} aria-hidden="true" /> : <ChevronDown size={16} aria-hidden="true" />}
                </button>
                {modelMenuOpen && (
                  <div className="multi-angle-model-menu" role="listbox" aria-label="可选多角度生成模型">
                    {models.map((model) => {
                      const selected = model.id === selectedModel.id
                      return (
                        <button
                          key={model.id}
                          className={`multi-angle-model-option ${selected ? 'selected' : ''}`}
                          type="button"
                          role="option"
                          aria-selected={selected}
                          onClick={() => {
                            setSelectedModelId(model.id)
                            setModelMenuOpen(false)
                            setError('')
                          }}
                        >
                          {model.label}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>

            <div className="multi-angle-prompt-toggle-row">
              <span>提示词</span>
              <button
                className={`multi-angle-switch ${showPrompt ? 'active' : ''}`}
                type="button"
                role="switch"
                aria-checked={showPrompt}
                onClick={() => setShowPrompt((current) => !current)}
                disabled={submitting || busy}
              ><i /></button>
              <small>展开后可添加额外要求</small>
            </div>

            {showPrompt && (
              <div className="multi-angle-prompt-editor">
                <label>
                  <span>补充要求</span>
                  <textarea value={extraPrompt} maxLength={800} onChange={(event) => setExtraPrompt(event.target.value)} placeholder="例如：保持纯白背景，产品阴影方向不变" disabled={submitting || busy} />
                </label>
                <details>
                  <summary>查看完整生成提示词</summary>
                  <p>{prompt}</p>
                </details>
              </div>
            )}

            <div className="multi-angle-angle-card">
              <span>当前视角</span>
              <strong>{view.label}</strong>
              <small>{degreeLabel(view.horizontal)} 水平 · {degreeLabel(view.vertical)} 垂直 · {framing.label} · {selectedModel.label}</small>
            </div>
          </div>
        </div>

        {error && <div className="multi-angle-error">{error}</div>}

        <footer className="multi-angle-foot">
          <button className="multi-angle-reset" type="button" onClick={reset} disabled={submitting || busy}><RotateCcw size={17} /> 重置参数</button>
          <div>
            <span>结果保持原图尺寸并自动连接到画布</span>
            <button className="multi-angle-generate" type="button" onClick={() => void submit()} disabled={loading || submitting || busy || Boolean(error)} title={`使用 ${selectedModel.label} 按当前角度生成`} aria-label={`使用 ${selectedModel.label} 按当前角度生成`}>
              {submitting || busy ? <Loader2 className="multi-angle-spinner" size={15} /> : 'Run'}
            </button>
          </div>
        </footer>
      </section>
    </div>
  )
}
