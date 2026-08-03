import { useEffect, useRef, useState, type CSSProperties, type ChangeEvent, type DragEvent } from 'react'
import { Box, Camera, Check, ImagePlus, Loader2, MoveUpRight, RefreshCw, Sun, Upload, X } from 'lucide-react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import './Model3DStudio.css'

type ViewportPreset = {
  id: string
  label: string
  width: number
  height: number
}

type ModelStats = {
  meshes: number
  vertices: number
  triangles: number
}

type Model3DStudioProps = {
  onClose: () => void
  onExport: (result: { dataUrl: string; fileName: string; width: number; height: number }) => void
}

type PreviewRuntime = {
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  controls: OrbitControls
  keyLight: THREE.DirectionalLight
  ground: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>
  resize: () => void
}

const viewportPresets: ViewportPreset[] = [
  { id: 'square', label: '1:1', width: 1024, height: 1024 },
  { id: 'landscape', label: '4:3', width: 1200, height: 900 },
  { id: 'wide', label: '16:9', width: 1280, height: 720 },
  { id: 'portrait', label: '3:4', width: 900, height: 1200 },
]

const defaultModelColor = '#b8c7d6'
const defaultBackgroundColor = '#111820'
const defaultLightAzimuth = -55
const defaultLightElevation = 38
const maximumModelFileSize = 100 * 1024 * 1024

function setDirectionalLightPosition(
  light: THREE.DirectionalLight,
  target: THREE.Vector3,
  azimuth: number,
  elevation: number,
) {
  const azimuthRadians = THREE.MathUtils.degToRad(azimuth)
  const elevationRadians = THREE.MathUtils.degToRad(elevation)
  const radius = 12
  const horizontalRadius = Math.cos(elevationRadians) * radius

  light.target.position.copy(target)
  light.position.set(
    target.x + Math.sin(azimuthRadians) * horizontalRadius,
    target.y + Math.sin(elevationRadians) * radius,
    target.z + Math.cos(azimuthRadians) * horizontalRadius,
  )
  light.target.updateMatrixWorld()
}

function formatCount(value: number) {
  return new Intl.NumberFormat('zh-CN').format(value)
}

function disposeMaterial(material: THREE.Material) {
  Object.values(material).forEach((value) => {
    if (value instanceof THREE.Texture) value.dispose()
  })
  material.dispose()
}

function disposeModel(object: THREE.Object3D | null, material: THREE.MeshStandardMaterial | null) {
  if (!object) return
  object.traverse((child) => {
    const mesh = child as THREE.Mesh
    if (!mesh.isMesh) return
    mesh.geometry?.dispose()
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    materials.forEach((item) => {
      if (item !== material) disposeMaterial(item)
    })
  })
  material?.dispose()
}

function modelFileExtension(fileName: string) {
  return fileName.split('.').pop()?.toLowerCase() || ''
}

function collectModelStats(object: THREE.Object3D): ModelStats {
  const stats = { meshes: 0, vertices: 0, triangles: 0 }
  object.traverse((child) => {
    const mesh = child as THREE.Mesh
    if (!mesh.isMesh || !mesh.geometry) return
    stats.meshes += 1
    const position = mesh.geometry.getAttribute('position')
    if (position) stats.vertices += position.count
    stats.triangles += mesh.geometry.index
      ? Math.floor(mesh.geometry.index.count / 3)
      : Math.floor((position?.count || 0) / 3)
  })
  return stats
}

export default function Model3DStudio({ onClose, onExport }: Model3DStudioProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const viewportHostRef = useRef<HTMLDivElement>(null)
  const runtimeRef = useRef<PreviewRuntime | null>(null)
  const modelRef = useRef<THREE.Object3D | null>(null)
  const modelMaterialRef = useRef<THREE.MeshStandardMaterial | null>(null)
  const animationFrameRef = useRef(0)
  const loadSequenceRef = useRef(0)
  const [fileName, setFileName] = useState('')
  const [modelFormat, setModelFormat] = useState('')
  const [modelStats, setModelStats] = useState<ModelStats | null>(null)
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState('')
  const [modelColor, setModelColor] = useState(defaultModelColor)
  const [backgroundColor, setBackgroundColor] = useState(defaultBackgroundColor)
  const [focalLength, setFocalLength] = useState(50)
  const [cameraDistance, setCameraDistance] = useState(5)
  const [showProjection, setShowProjection] = useState(false)
  const [lightAzimuth, setLightAzimuth] = useState(defaultLightAzimuth)
  const [lightElevation, setLightElevation] = useState(defaultLightElevation)
  const [viewportId, setViewportId] = useState('square')
  const viewport = viewportPresets.find((item) => item.id === viewportId) || viewportPresets[0]
  const hasModel = Boolean(modelRef.current && fileName)

  useEffect(() => {
    const host = viewportHostRef.current
    if (!host) return

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    })
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.12
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    renderer.setClearColor(defaultBackgroundColor)
    renderer.domElement.className = 'model3d-canvas'
    renderer.domElement.setAttribute('aria-label', '3D 模型交互预览')
    host.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(42, 1, 0.01, 1000)
    camera.setFocalLength(50)
    camera.position.set(3.8, 2.4, 4.4)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.075
    controls.screenSpacePanning = true
    controls.zoomToCursor = true
    controls.minPolarAngle = 0.03
    controls.maxPolarAngle = Math.PI - 0.03
    controls.target.set(0, 0, 0)

    const hemisphere = new THREE.HemisphereLight(0xf4f8ff, 0x24303b, 1.65)
    scene.add(hemisphere)

    const keyLight = new THREE.DirectionalLight(0xffffff, 4.2)
    keyLight.castShadow = true
    keyLight.shadow.mapSize.set(2048, 2048)
    keyLight.shadow.camera.near = 0.1
    keyLight.shadow.camera.far = 40
    keyLight.shadow.camera.left = -5
    keyLight.shadow.camera.right = 5
    keyLight.shadow.camera.top = 5
    keyLight.shadow.camera.bottom = -5
    keyLight.shadow.bias = -0.00035
    keyLight.shadow.normalBias = 0.035
    keyLight.shadow.radius = 3
    scene.add(keyLight)
    scene.add(keyLight.target)
    setDirectionalLightPosition(keyLight, controls.target, defaultLightAzimuth, defaultLightElevation)

    const rimLight = new THREE.DirectionalLight(0x8fcde3, 1.15)
    rimLight.position.set(-5, 3, -4)
    scene.add(rimLight)

    const groundMaterial = new THREE.MeshStandardMaterial({
      color: 0x18212a,
      roughness: 1,
      metalness: 0,
    })
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), groundMaterial)
    ground.rotation.x = -Math.PI / 2
    ground.position.y = -1.61
    ground.receiveShadow = true
    ground.visible = false
    scene.add(ground)

    const resize = () => {
      const width = Math.max(1, host.clientWidth)
      const height = Math.max(1, host.clientHeight)
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
      renderer.setSize(width, height, false)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
    }

    const updateDistance = () => {
      setCameraDistance(Number(controls.getDistance().toFixed(2)))
    }
    controls.addEventListener('end', updateDistance)

    runtimeRef.current = { renderer, scene, camera, controls, keyLight, ground, resize }
    const resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(host)
    resize()
    controls.update()

    const renderFrame = () => {
      controls.update()
      renderer.render(scene, camera)
      animationFrameRef.current = window.requestAnimationFrame(renderFrame)
    }
    renderFrame()

    return () => {
      loadSequenceRef.current += 1
      window.cancelAnimationFrame(animationFrameRef.current)
      resizeObserver.disconnect()
      controls.removeEventListener('end', updateDistance)
      controls.dispose()
      disposeModel(modelRef.current, modelMaterialRef.current)
      modelRef.current = null
      modelMaterialRef.current = null
      ground.geometry.dispose()
      groundMaterial.dispose()
      renderer.dispose()
      renderer.domElement.remove()
      runtimeRef.current = null
    }
  }, [])

  useEffect(() => {
    const runtime = runtimeRef.current
    if (!runtime) return
    runtime.renderer.setClearColor(backgroundColor)
    const groundColor = new THREE.Color(backgroundColor)
    groundColor.multiplyScalar(0.55)
    groundColor.offsetHSL(0, -0.02, 0.012)
    runtime.ground.material.color.copy(groundColor)
    runtime.ground.material.needsUpdate = true
  }, [backgroundColor])

  useEffect(() => {
    const material = modelMaterialRef.current
    if (!material) return
    material.color.set(modelColor)
    material.needsUpdate = true
  }, [modelColor])

  useEffect(() => {
    const runtime = runtimeRef.current
    if (!runtime) return
    runtime.camera.setFocalLength(focalLength)
    runtime.camera.updateProjectionMatrix()
  }, [focalLength])

  useEffect(() => {
    const runtime = runtimeRef.current
    if (!runtime) return
    runtime.ground.visible = showProjection
    runtime.renderer.shadowMap.needsUpdate = true
  }, [showProjection])

  useEffect(() => {
    const runtime = runtimeRef.current
    if (!runtime) return
    setDirectionalLightPosition(runtime.keyLight, runtime.controls.target, lightAzimuth, lightElevation)
    runtime.renderer.shadowMap.needsUpdate = true
  }, [lightAzimuth, lightElevation])

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => runtimeRef.current?.resize())
    return () => window.cancelAnimationFrame(frame)
  }, [viewportId])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  function replaceSceneModel(object: THREE.Object3D, nextFileName: string, format: string) {
    const runtime = runtimeRef.current
    if (!runtime) throw new Error('3D 预览器尚未准备好')

    if (modelRef.current) {
      runtime.scene.remove(modelRef.current)
      disposeModel(modelRef.current, modelMaterialRef.current)
    }

    const material = new THREE.MeshStandardMaterial({
      color: modelColor,
      roughness: 0.58,
      metalness: 0.08,
    })

    object.traverse((child) => {
      const mesh = child as THREE.Mesh
      if (!mesh.isMesh) return
      const originalMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      originalMaterials.forEach(disposeMaterial)
      mesh.material = material
      mesh.castShadow = true
      mesh.receiveShadow = true
      if (!mesh.geometry.getAttribute('normal')) mesh.geometry.computeVertexNormals()
    })

    object.updateMatrixWorld(true)
    const sourceBox = new THREE.Box3().setFromObject(object)
    const sourceSize = sourceBox.getSize(new THREE.Vector3())
    const maximumDimension = Math.max(sourceSize.x, sourceSize.y, sourceSize.z)
    if (!Number.isFinite(maximumDimension) || maximumDimension <= 0) {
      disposeModel(object, material)
      throw new Error('模型中没有可显示的几何体')
    }

    object.scale.multiplyScalar(3.2 / maximumDimension)
    object.updateMatrixWorld(true)
    const scaledBox = new THREE.Box3().setFromObject(object)
    const center = scaledBox.getCenter(new THREE.Vector3())
    object.position.sub(center)
    object.updateMatrixWorld(true)

    const finalBox = new THREE.Box3().setFromObject(object)
    const sphere = finalBox.getBoundingSphere(new THREE.Sphere())
    const radius = Math.max(sphere.radius, 0.5)
    const halfFov = THREE.MathUtils.degToRad(runtime.camera.fov * 0.5)
    const distance = (radius / Math.sin(halfFov)) * 1.28
    const direction = new THREE.Vector3(1, 0.62, 1).normalize()

    runtime.scene.add(object)
    modelRef.current = object
    modelMaterialRef.current = material
    runtime.controls.target.copy(sphere.center)
    runtime.camera.position.copy(sphere.center).addScaledVector(direction, distance)
    runtime.camera.near = Math.max(0.01, distance / 1000)
    runtime.camera.far = Math.max(100, distance * 100)
    runtime.camera.updateProjectionMatrix()
    runtime.controls.minDistance = Math.max(0.15, radius * 0.22)
    runtime.controls.maxDistance = Math.max(30, radius * 24)
    runtime.controls.update()
    runtime.controls.saveState()
    runtime.ground.position.y = finalBox.min.y - 0.02
    const shadowExtent = Math.max(6, radius * 4.2)
    runtime.keyLight.shadow.camera.left = -shadowExtent
    runtime.keyLight.shadow.camera.right = shadowExtent
    runtime.keyLight.shadow.camera.top = shadowExtent
    runtime.keyLight.shadow.camera.bottom = -shadowExtent
    runtime.keyLight.shadow.camera.updateProjectionMatrix()
    setDirectionalLightPosition(runtime.keyLight, runtime.controls.target, lightAzimuth, lightElevation)
    runtime.renderer.shadowMap.needsUpdate = true

    setCameraDistance(Number(runtime.controls.getDistance().toFixed(2)))
    setFileName(nextFileName)
    setModelFormat(format.toUpperCase())
    setModelStats(collectModelStats(object))
  }

  async function loadModelFile(file: File) {
    const extension = modelFileExtension(file.name)
    if (extension !== 'obj' && extension !== 'fbx') {
      setError('仅支持 OBJ 或 FBX 格式文件')
      return
    }
    if (file.size > maximumModelFileSize) {
      setError('模型文件不能超过 100 MB')
      return
    }

    const sequence = loadSequenceRef.current + 1
    loadSequenceRef.current = sequence
    setLoading(true)
    setError('')

    try {
      let object: THREE.Object3D
      if (extension === 'obj') {
        const [{ OBJLoader }, content] = await Promise.all([
          import('three/addons/loaders/OBJLoader.js'),
          file.text(),
        ])
        object = new OBJLoader().parse(content)
      } else {
        const [{ FBXLoader }, buffer] = await Promise.all([
          import('three/addons/loaders/FBXLoader.js'),
          file.arrayBuffer(),
        ])
        object = new FBXLoader().parse(buffer, '')
      }

      if (sequence !== loadSequenceRef.current) {
        disposeModel(object, null)
        return
      }
      replaceSceneModel(object, file.name, extension)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '模型解析失败，请检查文件是否完整')
    } finally {
      if (sequence === loadSequenceRef.current) setLoading(false)
    }
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file) void loadModelFile(file)
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    const file = event.dataTransfer.files?.[0]
    if (file) void loadModelFile(file)
  }

  function changeCameraDistance(nextValue: number) {
    const runtime = runtimeRef.current
    if (!runtime || !Number.isFinite(nextValue)) return
    const clamped = Math.max(runtime.controls.minDistance, Math.min(runtime.controls.maxDistance, nextValue))
    const direction = runtime.camera.position.clone().sub(runtime.controls.target).normalize()
    runtime.camera.position.copy(runtime.controls.target).addScaledVector(direction, clamped)
    runtime.controls.update()
    setCameraDistance(Number(clamped.toFixed(2)))
  }

  function setCameraView(view: 'front' | 'side' | 'top') {
    const runtime = runtimeRef.current
    if (!runtime || !modelRef.current) return
    const distance = runtime.controls.getDistance()
    const direction =
      view === 'front'
        ? new THREE.Vector3(0, 0, 1)
        : view === 'side'
          ? new THREE.Vector3(1, 0, 0)
          : new THREE.Vector3(0, 1, 0.001).normalize()
    runtime.camera.position.copy(runtime.controls.target).addScaledVector(direction, distance)
    runtime.camera.up.set(0, view === 'top' ? 0 : 1, view === 'top' ? -1 : 0)
    runtime.controls.update()
    setCameraDistance(Number(runtime.controls.getDistance().toFixed(2)))
  }

  function resetCameraView() {
    const runtime = runtimeRef.current
    if (!runtime || !modelRef.current) return
    runtime.camera.up.set(0, 1, 0)
    runtime.controls.reset()
    runtime.camera.setFocalLength(focalLength)
    runtime.camera.updateProjectionMatrix()
    runtime.controls.update()
    setCameraDistance(Number(runtime.controls.getDistance().toFixed(2)))
  }

  function exportCurrentView() {
    const runtime = runtimeRef.current
    if (!runtime || !modelRef.current || exporting) {
      if (!modelRef.current) setError('请先导入一个 OBJ 或 FBX 模型')
      return
    }

    setExporting(true)
    setError('')
    try {
      const previousPixelRatio = runtime.renderer.getPixelRatio()
      const previousSize = runtime.renderer.getSize(new THREE.Vector2())
      runtime.renderer.setPixelRatio(1)
      runtime.renderer.setSize(viewport.width, viewport.height, false)
      runtime.camera.aspect = viewport.width / viewport.height
      runtime.camera.updateProjectionMatrix()
      runtime.controls.update()
      runtime.renderer.render(runtime.scene, runtime.camera)
      const dataUrl = runtime.renderer.domElement.toDataURL('image/png')

      runtime.renderer.setPixelRatio(previousPixelRatio)
      runtime.renderer.setSize(previousSize.x, previousSize.y, false)
      runtime.camera.aspect = previousSize.x / previousSize.y
      runtime.camera.updateProjectionMatrix()
      runtime.controls.update()

      const baseName = fileName.replace(/\.(obj|fbx)$/i, '') || '3d-model'
      setExporting(false)
      onExport({
        dataUrl,
        fileName: `${baseName}-3D视角-${viewport.width}x${viewport.height}.png`,
        width: viewport.width,
        height: viewport.height,
      })
    } catch (reason) {
      setExporting(false)
      setError(reason instanceof Error ? reason.message : '导出参考图失败')
    }
  }

  const viewportStyle = {
    '--model3d-aspect': String(viewport.width / viewport.height),
  } as CSSProperties
  const lightDirectionStyle = {
    '--model3d-light-angle': `${lightAzimuth - 90}deg`,
  } as CSSProperties

  return (
    <div
      className="model3d-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section className="model3d-studio" role="dialog" aria-modal="true" aria-label="3D 模型预览">
        <header className="model3d-head">
          <div className="model3d-title">
            <Box size={19} />
            <div>
              <h2>3D 模型预览</h2>
              <p>导入 OBJ 或 FBX，调整视角后输出为画板参考图</p>
            </div>
          </div>
          <button className="model3d-icon-button" type="button" onClick={onClose} title="关闭 3D 预览">
            <X size={18} />
          </button>
        </header>

        <div className="model3d-body">
          <div className="model3d-stage">
            <div className="model3d-filebar">
              <button type="button" className="model3d-file-button" onClick={() => fileInputRef.current?.click()}>
                <Upload size={15} />
                {fileName ? '更换模型' : '选择模型'}
              </button>
              <input ref={fileInputRef} type="file" accept=".obj,.fbx" hidden onChange={handleFileChange} />
              <div className="model3d-file-summary">
                {fileName ? (
                  <>
                    <strong title={fileName}>{fileName}</strong>
                    <span>{modelFormat} · {modelStats ? `${formatCount(modelStats.triangles)} 三角面` : '正在读取'}</span>
                  </>
                ) : (
                  <span>支持 OBJ、FBX，单个文件最大 100 MB</span>
                )}
              </div>
              {modelStats && (
                <div className="model3d-stats" aria-label="模型统计">
                  <span>{modelStats.meshes} 网格</span>
                  <span>{formatCount(modelStats.vertices)} 顶点</span>
                </div>
              )}
            </div>

            <div className="model3d-viewport-frame">
              <div
                className="model3d-viewport"
                style={viewportStyle}
                onDragOver={(event) => event.preventDefault()}
                onDrop={handleDrop}
              >
                <div ref={viewportHostRef} className="model3d-viewport-host" />
                {!fileName && !loading && (
                  <div className="model3d-empty-state">
                    <Box size={40} />
                    <strong>导入 3D 模型开始预览</strong>
                    <p>拖放 OBJ 或 FBX 到这里，也可以从本地选择文件</p>
                    <button type="button" onClick={() => fileInputRef.current?.click()}>
                      <Upload size={15} />
                      选择模型
                    </button>
                  </div>
                )}
                {loading && (
                  <div className="model3d-loading-state" role="status">
                    <Loader2 size={26} />
                    <strong>正在解析模型</strong>
                    <span>大文件可能需要一些时间</span>
                  </div>
                )}
                <div className="model3d-viewport-label">
                  {viewport.label} · {viewport.width} × {viewport.height}
                </div>
              </div>
            </div>
          </div>

          <aside className="model3d-inspector" aria-label="3D 预览参数">
            <section className="model3d-control-section">
              <div className="model3d-section-title">
                <Camera size={15} />
                <strong>相机</strong>
              </div>
              <label className="model3d-field">
                <span>焦距</span>
                <div className="model3d-range-row">
                  <input
                    type="range"
                    min="18"
                    max="120"
                    step="1"
                    value={focalLength}
                    onChange={(event) => setFocalLength(Number(event.target.value))}
                    disabled={!hasModel}
                  />
                  <div className="model3d-unit-input">
                    <input
                      type="number"
                      min="18"
                      max="120"
                      value={focalLength}
                      onChange={(event) => setFocalLength(Math.max(18, Math.min(120, Number(event.target.value) || 18)))}
                      disabled={!hasModel}
                    />
                    <span>mm</span>
                  </div>
                </div>
                <small>广角 18 mm，标准 50 mm，长焦 120 mm</small>
              </label>

              <label className="model3d-field">
                <span>相机距离</span>
                <div className="model3d-range-row">
                  <input
                    type="range"
                    min="0.2"
                    max="30"
                    step="0.1"
                    value={cameraDistance}
                    onChange={(event) => changeCameraDistance(Number(event.target.value))}
                    disabled={!hasModel}
                  />
                  <div className="model3d-unit-input compact">
                    <input
                      type="number"
                      min="0.2"
                      max="30"
                      step="0.1"
                      value={cameraDistance}
                      onChange={(event) => changeCameraDistance(Number(event.target.value))}
                      disabled={!hasModel}
                    />
                  </div>
                </div>
              </label>

              <div className="model3d-view-buttons" aria-label="相机预设视角">
                <button type="button" onClick={() => setCameraView('front')} disabled={!hasModel}>正视</button>
                <button type="button" onClick={() => setCameraView('side')} disabled={!hasModel}>侧视</button>
                <button type="button" onClick={() => setCameraView('top')} disabled={!hasModel}>俯视</button>
                <button type="button" onClick={resetCameraView} disabled={!hasModel} title="恢复初始视角">
                  <RefreshCw size={13} />
                  重置
                </button>
              </div>
            </section>

            <section className="model3d-control-section">
              <div className="model3d-section-title">
                <ImagePlus size={15} />
                <strong>外观</strong>
              </div>
              <label className="model3d-color-field">
                <span>模型颜色</span>
                <div>
                  <input type="color" value={modelColor} onChange={(event) => setModelColor(event.target.value)} />
                  <input type="text" value={modelColor.toUpperCase()} onChange={(event) => {
                    if (/^#[0-9a-f]{6}$/i.test(event.target.value)) setModelColor(event.target.value)
                  }} />
                </div>
              </label>
              <label className="model3d-color-field">
                <span>背景颜色</span>
                <div>
                  <input type="color" value={backgroundColor} onChange={(event) => setBackgroundColor(event.target.value)} />
                  <input type="text" value={backgroundColor.toUpperCase()} onChange={(event) => {
                    if (/^#[0-9a-f]{6}$/i.test(event.target.value)) setBackgroundColor(event.target.value)
                  }} />
                </div>
              </label>
            </section>

            <section className="model3d-control-section">
              <div className="model3d-section-title">
                <Sun size={15} />
                <strong>光照与投影</strong>
              </div>
              <label className="model3d-projection-toggle">
                <span>
                  <strong>显示投影</strong>
                  <small>开启后在模型底部显示实时投影</small>
                </span>
                <input
                  type="checkbox"
                  checked={showProjection}
                  onChange={(event) => setShowProjection(event.target.checked)}
                />
                <i aria-hidden="true" />
              </label>

              <div className="model3d-light-direction-summary">
                <div className="model3d-light-direction-dial" style={lightDirectionStyle} aria-hidden="true">
                  <span className="model3d-light-direction-arm">
                    <Sun size={13} />
                  </span>
                  <i />
                </div>
                <div>
                  <span><MoveUpRight size={13} /> 光照方向</span>
                  <strong>{lightAzimuth}° / {lightElevation}°</strong>
                  <small>水平角 / 高度</small>
                </div>
              </div>

              <label className="model3d-field">
                <span>水平角</span>
                <div className="model3d-range-row">
                  <input
                    aria-label="光照水平角"
                    type="range"
                    min="-180"
                    max="180"
                    step="1"
                    value={lightAzimuth}
                    onChange={(event) => setLightAzimuth(Number(event.target.value))}
                  />
                  <div className="model3d-unit-input compact">
                    <input
                      aria-label="光照水平角数值"
                      type="number"
                      min="-180"
                      max="180"
                      value={lightAzimuth}
                      onChange={(event) => setLightAzimuth(Math.max(-180, Math.min(180, Number(event.target.value) || 0)))}
                    />
                    <span>°</span>
                  </div>
                </div>
              </label>

              <label className="model3d-field">
                <span>光照高度</span>
                <div className="model3d-range-row">
                  <input
                    aria-label="光照高度"
                    type="range"
                    min="20"
                    max="85"
                    step="1"
                    value={lightElevation}
                    onChange={(event) => setLightElevation(Number(event.target.value))}
                  />
                  <div className="model3d-unit-input compact">
                    <input
                      aria-label="光照高度数值"
                      type="number"
                      min="20"
                      max="85"
                      value={lightElevation}
                      onChange={(event) => setLightElevation(Math.max(20, Math.min(85, Number(event.target.value) || 20)))}
                    />
                    <span>°</span>
                  </div>
                </div>
                <small>降低高度会拉长投影，提高高度会缩短投影。</small>
              </label>
            </section>

            <section className="model3d-control-section">
              <div className="model3d-section-title">
                <ImagePlus size={15} />
                <strong>视窗尺寸</strong>
              </div>
              <div className="model3d-size-options">
                {viewportPresets.map((preset) => (
                  <button
                    type="button"
                    className={preset.id === viewportId ? 'active' : ''}
                    onClick={() => setViewportId(preset.id)}
                    key={preset.id}
                  >
                    <span>{preset.label}</span>
                    <small>{preset.width} × {preset.height}</small>
                    {preset.id === viewportId && <Check size={14} />}
                  </button>
                ))}
              </div>
            </section>

            {error && <div className="model3d-error" role="alert">{error}</div>}
          </aside>
        </div>

        <footer className="model3d-foot">
          <p>左键旋转，滚轮缩放，右键平移。导出会使用所选视窗尺寸。</p>
          <div>
            <button className="model3d-secondary-button" type="button" onClick={onClose}>取消</button>
            <button
              className="model3d-export-button"
              type="button"
              onClick={exportCurrentView}
              disabled={!hasModel || loading || exporting}
            >
              {exporting ? <Loader2 className="model3d-spinner" size={15} /> : <ImagePlus size={15} />}
              {exporting ? '正在导出' : '导出到画板'}
            </button>
          </div>
        </footer>
      </section>
    </div>
  )
}
