import { useEffect, useRef, useState, type CSSProperties, type ChangeEvent, type DragEvent } from 'react'
import {
  Box,
  Camera,
  Check,
  Copy,
  Download,
  Focus,
  ImagePlus,
  Layers3,
  Loader2,
  Move3D,
  MoveUpRight,
  Plus,
  RefreshCw,
  RotateCw,
  Save,
  Sun,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { TransformControls } from 'three/addons/controls/TransformControls.js'
import UnifiedRange from './UnifiedRange'
import { cacheModelFile, createStaticModelSnapshot, disposeStaticSnapshot, formatModelBytes, optimizeModelSnapshot, parseModelBuffer, persistModelSource } from './model3dAssets'
import { deleteModel3DDraft, model3DStorageErrorMessage, readModel3DDraft, saveModel3DDraft } from './model3dSceneStore'
import type {
  ParametricBoxSettings,
  ParametricPrimitiveSettings,
  SavedModel3DItem,
  SavedModel3DScene,
  SavedModel3DSource,
  SavedTransform,
} from './model3dSceneStore'
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

type ParametricBoxData = {
  settings: ParametricBoxSettings
  baseMaterial: THREE.MeshStandardMaterial
  lidMaterial: THREE.MeshStandardMaterial
}

type ParametricBoxPartData = {
  part: 'base' | 'lid'
  settings: ParametricBoxSettings
}

type ParametricPrimitiveData = {
  settings: ParametricPrimitiveSettings
}

type SceneItem = {
  id: string
  name: string
  format: string
  object: THREE.Object3D
  material: THREE.MeshStandardMaterial
  stats: ModelStats
  parametricBox?: ParametricBoxData
  parametricBoxPart?: ParametricBoxPartData
  parametricPrimitive?: ParametricPrimitiveData
  source?: SavedModel3DSource
}

type SceneItemSnapshot = {
  item: SceneItem
  position: [number, number, number]
  quaternion: [number, number, number, number]
  scale: [number, number, number]
  color: string
  parametricBox?: ParametricBoxSettings
  parametricPrimitive?: ParametricPrimitiveSettings
}

type OptimizationPreview = {
  originalId: string
  object: THREE.Object3D
  source: SavedModel3DSource
  beforeImage: string
  afterImage: string
  applied: boolean
}

type SceneHistorySnapshot = {
  items: SceneItemSnapshot[]
  selectedItemId: string | null
}

type Model3DStudioProps = {
  onClose: () => void
  initialScene?: SavedModel3DScene | null
  sceneId?: string | null
  transparentExport?: boolean
  exportViewport?: { width: number; height: number }
  useSavedScene?: boolean
  onExport: (result: {
    dataUrl: string
    fileName: string
    width: number
    height: number
    sceneId: string
    scene: SavedModel3DScene
  }) => void | Promise<void>
}

type PreviewRuntime = {
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  controls: OrbitControls
  transformControls: TransformControls
  selectionBox: THREE.BoxHelper
  hemisphere: THREE.HemisphereLight
  keyLight: THREE.DirectionalLight
  rimLight: THREE.DirectionalLight
  ground: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>
  resize: () => void
}

type TransformMode = 'translate' | 'rotate'
type TransformSpace = 'world' | 'local'

const viewportPresets: ViewportPreset[] = [
  { id: 'square', label: '1:1', width: 1024, height: 1024 },
  { id: 'landscape', label: '4:3', width: 1200, height: 900 },
  { id: 'wide', label: '16:9', width: 1280, height: 720 },
  { id: 'portrait', label: '3:4', width: 900, height: 1200 },
  { id: 'vertical', label: '9:16', width: 720, height: 1280 },
  { id: 'portrait-tall', label: '2:3', width: 800, height: 1200 },
]

const defaultParametricBoxSettings: ParametricBoxSettings = {
  length: 320,
  width: 240,
  baseHeight: 120,
  lidHeight: 55,
  thickness: 12,
  gap: 6,
  pose: 'separated',
  baseColor: '#B8C7D6',
  lidColor: '#D6C2B8',
}

const defaultCylinderSettings: ParametricPrimitiveSettings = {
  kind: 'cylinder',
  radius: 100,
  height: 220,
  length: 200,
  width: 200,
  color: '#AFC9D8',
}

const defaultCuboidSettings: ParametricPrimitiveSettings = {
  kind: 'cuboid',
  radius: 100,
  height: 180,
  length: 260,
  width: 200,
  color: '#C9B9A9',
}

const defaultModelColor = '#b8c7d6'
const defaultBackgroundColor = '#111820'
const defaultLightAzimuth = -55
const defaultLightElevation = 38
const defaultLightIntensity = 100
const defaultHemisphereIntensity = 1.65
const unlitPreviewHemisphereIntensity = 1.3
const defaultKeyLightIntensity = 4.2
const defaultRimLightIntensity = 1.15
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

async function parseSavedModelSource(source: SavedModel3DSource) {
  const response = await fetch(source.url)
  if (!response.ok) throw new Error(`模型资源读取失败：${response.status}`)
  const buffer = await response.arrayBuffer()
  const startedAt = performance.now()
  const object = await parseModelBuffer(buffer, source.format)
  source.byteLength = buffer.byteLength
  source.loadMs = performance.now() - startedAt
  return object
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

function disposeObjectGeometries(object: THREE.Object3D) {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh
    if (mesh.isMesh) mesh.geometry?.dispose()
  })
}

function addBoxPanel(
  group: THREE.Group,
  size: [number, number, number],
  position: [number, number, number],
  material: THREE.MeshStandardMaterial,
) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material)
  mesh.position.set(...position)
  mesh.castShadow = true
  mesh.receiveShadow = true
  group.add(mesh)
}

function buildOpenBoxGeometry(
  group: THREE.Group,
  dimensions: { length: number; width: number; height: number; thickness: number; inverted?: boolean },
  material: THREE.MeshStandardMaterial,
) {
  const { length, width, height, thickness, inverted = false } = dimensions
  const wallHeight = Math.max(thickness, height - thickness)
  const wallCenterY = inverted ? wallHeight / 2 : thickness + wallHeight / 2
  const panelY = inverted ? height - thickness / 2 : thickness / 2
  addBoxPanel(group, [length, thickness, width], [0, panelY, 0], material)
  addBoxPanel(group, [length, wallHeight, thickness], [0, wallCenterY, (width - thickness) / 2], material)
  addBoxPanel(group, [length, wallHeight, thickness], [0, wallCenterY, -(width - thickness) / 2], material)
  addBoxPanel(group, [thickness, wallHeight, Math.max(thickness, width - thickness * 2)], [(length - thickness) / 2, wallCenterY, 0], material)
  addBoxPanel(group, [thickness, wallHeight, Math.max(thickness, width - thickness * 2)], [-(length - thickness) / 2, wallCenterY, 0], material)
}

function savedTransformFromObject(object: THREE.Object3D): SavedTransform {
  return {
    position: [object.position.x, object.position.y, object.position.z],
    quaternion: [object.quaternion.x, object.quaternion.y, object.quaternion.z, object.quaternion.w],
    scale: [object.scale.x, object.scale.y, object.scale.z],
  }
}

function applySavedTransform(object: THREE.Object3D, transform: SavedTransform) {
  object.position.fromArray(transform.position)
  object.quaternion.fromArray(transform.quaternion)
  object.scale.fromArray(transform.scale)
  object.updateMatrixWorld(true)
}

function sceneObjectIdFromIntersection(object: THREE.Object3D | null) {
  let current = object
  while (current) {
    if (typeof current.userData.sceneItemId === 'string') return current.userData.sceneItemId as string
    current = current.parent
  }
  return null
}

function transformValue(value: number) {
  return Number(value.toFixed(2))
}

function sceneSnapshotSignature(snapshot: SceneHistorySnapshot) {
  return JSON.stringify({
    selectedItemId: snapshot.selectedItemId,
    items: snapshot.items.map(({ item, position, quaternion, scale, color, parametricBox, parametricPrimitive }) => ({
      id: item.id,
      position,
      quaternion,
      scale,
      color,
      parametricBox,
      parametricPrimitive,
    })),
  })
}

export default function Model3DStudio({ onClose, onExport, initialScene = null, sceneId = null, transparentExport = false, exportViewport, useSavedScene = true }: Model3DStudioProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const viewportHostRef = useRef<HTMLDivElement>(null)
  const runtimeRef = useRef<PreviewRuntime | null>(null)
  const sceneItemsRef = useRef<SceneItem[]>([])
  const allSceneItemsRef = useRef(new Set<SceneItem>())
  const selectedItemIdRef = useRef<string | null>(null)
  const sceneHistoryRef = useRef<SceneHistorySnapshot[]>([])
  const transformStartSnapshotRef = useRef<SceneHistorySnapshot | null>(null)
  const parameterEditSnapshotRef = useRef<SceneHistorySnapshot | null>(null)
  const savedCameraRef = useRef<SavedModel3DScene['camera'] | null>(null)
  const animationFrameRef = useRef(0)
  const loadSequenceRef = useRef(0)
  const selectSceneItemRef = useRef<(id: string | null) => void>(() => undefined)
  const deleteSelectedItemRef = useRef<() => void>(() => undefined)
  const undoSceneRef = useRef<() => void>(() => undefined)
  const restoreSavedSceneRef = useRef<(saved: SavedModel3DScene) => Promise<void>>(async () => undefined)
  const updateSceneBoundsRef = useRef<(fitCamera?: boolean) => void>(() => undefined)
  const [sceneItems, setSceneItems] = useState<SceneItem[]>([])
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null)
  const [transformMode, setTransformMode] = useState<TransformMode>('translate')
  const [transformSpace, setTransformSpace] = useState<TransformSpace>('world')
  const [transformRevision, setTransformRevision] = useState(0)
  const [loading, setLoading] = useState(false)
  const [optimizing, setOptimizing] = useState(false)
  const [optimizationRatio, setOptimizationRatio] = useState(1)
  const [optimizationPreview, setOptimizationPreview] = useState<OptimizationPreview | null>(null)
  const [showOptimizedPreview, setShowOptimizedPreview] = useState(true)
  const optimizationDialogRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (optimizationPreview) optimizationDialogRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
  }, [optimizationPreview])
  useEffect(() => () => {
    if (optimizationPreview && !optimizationPreview.applied) disposeModel(optimizationPreview.object, null)
  }, [optimizationPreview])
  const [exporting, setExporting] = useState(false)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'resetting' | 'saved' | 'error'>('idle')
  const [draggingOverViewport, setDraggingOverViewport] = useState(false)
  const [error, setError] = useState('')
  const [modelColor, setModelColor] = useState(defaultModelColor)
  const [backgroundColor, setBackgroundColor] = useState(defaultBackgroundColor)
  const [focalLength, setFocalLength] = useState(50)
  const [cameraDistance, setCameraDistance] = useState(5)
  const [showProjection, setShowProjection] = useState(false)
  const [lightEnabled, setLightEnabled] = useState(true)
  const [lightIntensity, setLightIntensity] = useState(defaultLightIntensity)
  const [lightAzimuth, setLightAzimuth] = useState(defaultLightAzimuth)
  const [lightElevation, setLightElevation] = useState(defaultLightElevation)
  const [viewportId, setViewportId] = useState('square')
  const viewport = exportViewport ? { ...exportViewport, id: 'sketch', label: '手绘画板' } : viewportPresets.find((item) => item.id === viewportId) || viewportPresets[0]
  const selectedItem = sceneItems.find((item) => item.id === selectedItemId) || null
  const hasModel = sceneItems.length > 0
  const totalStats = sceneItems.reduce<ModelStats>((total, item) => ({
    meshes: total.meshes + item.stats.meshes,
    vertices: total.vertices + item.stats.vertices,
    triangles: total.triangles + item.stats.triangles,
  }), { meshes: 0, vertices: 0, triangles: 0 })

  function captureSavedScene() {
    const runtime = runtimeRef.current
    if (!runtime) return null
    const items = sceneItemsRef.current.flatMap<SavedModel3DItem>((item) => {
      if (item.parametricBox) {
        return [{
          kind: 'parametric-box',
          name: item.name,
          transform: savedTransformFromObject(item.object),
          settings: { ...item.parametricBox.settings },
        }]
      }
      if (item.parametricBoxPart) {
        return [{
          kind: 'parametric-part',
          name: item.name,
          transform: savedTransformFromObject(item.object),
          settings: { ...item.parametricBoxPart.settings },
          part: item.parametricBoxPart.part,
        }]
      }
      if (item.parametricPrimitive) {
        return [{
          kind: 'parametric-primitive',
          name: item.name,
          transform: savedTransformFromObject(item.object),
          primitiveSettings: { ...item.parametricPrimitive.settings },
        }]
      }
      if (item.source) {
        return [{
          kind: 'imported-model',
          name: item.name,
          transform: savedTransformFromObject(item.object),
          color: `#${item.material.color.getHexString()}`,
          source: { ...item.source },
        }]
      }
      return []
    })
    const selectedIndex = sceneItemsRef.current.findIndex((item) => item.id === selectedItemIdRef.current)
    const saved: SavedModel3DScene = {
      version: 2,
      savedAt: new Date().toISOString(),
      items,
      selectedIndex,
      viewportId,
      backgroundColor,
      focalLength,
      showProjection,
      lightEnabled,
      lightIntensity,
      lightAzimuth,
      lightElevation,
      camera: {
        position: [runtime.camera.position.x, runtime.camera.position.y, runtime.camera.position.z],
        up: [runtime.camera.up.x, runtime.camera.up.y, runtime.camera.up.z],
        target: [runtime.controls.target.x, runtime.controls.target.y, runtime.controls.target.z],
      },
    }
    return saved
  }

  async function saveSceneLocally() {
    if (loading || saveStatus === 'saving' || saveStatus === 'resetting') return
    const saved = captureSavedScene()
    if (!saved) return
    setSaveStatus('saving')
    setError('')
    try {
      await saveModel3DDraft(saved)
      setSaveStatus('saved')
      window.setTimeout(() => setSaveStatus((status) => status === 'saved' ? 'idle' : status), 1800)
    } catch (reason) {
      setSaveStatus('error')
      setError(model3DStorageErrorMessage(reason))
    }
  }

  async function resetSceneAndSavedData() {
    if (saveStatus === 'saving' || saveStatus === 'resetting') return
    const runtime = runtimeRef.current
    if (!runtime) return
    loadSequenceRef.current += 1
    setOptimizationPreview(null)
    setOptimizing(false)
    if (useSavedScene) {
      setSaveStatus('resetting')
      try {
        await deleteModel3DDraft()
      } catch (reason) {
        setSaveStatus('error')
        setLoading(false)
        setError(`无法清除已保存的场景。${model3DStorageErrorMessage(reason)}`)
        return
      }
      if (runtimeRef.current !== runtime) return
    }
    runtime.transformControls.detach()
    runtime.selectionBox.visible = false
    allSceneItemsRef.current.forEach((item) => {
      runtime.scene.remove(item.object)
      disposeModel(item.object, item.material)
    })
    allSceneItemsRef.current.clear()
    sceneItemsRef.current = []
    sceneHistoryRef.current = []
    transformStartSnapshotRef.current = null
    parameterEditSnapshotRef.current = null
    savedCameraRef.current = null
    selectedItemIdRef.current = null
    setSceneItems([])
    setSelectedItemId(null)
    setLoading(false)
    setModelColor(defaultModelColor)
    setBackgroundColor(defaultBackgroundColor)
    setFocalLength(50)
    setShowProjection(false)
    setLightEnabled(true)
    setLightIntensity(defaultLightIntensity)
    setLightAzimuth(defaultLightAzimuth)
    setLightElevation(defaultLightElevation)
    setViewportId('square')
    setTransformMode('translate')
    setTransformSpace('world')
    setError('')
    setSaveStatus('idle')
    runtime.camera.position.set(5.6, 3.5, 6.4)
    runtime.camera.up.set(0, 1, 0)
    runtime.camera.setFocalLength(50)
    runtime.camera.updateProjectionMatrix()
    runtime.controls.minDistance = 0
    runtime.controls.maxDistance = Infinity
    runtime.controls.target.set(0, 0, 0)
    runtime.controls.update()
    runtime.controls.saveState()
    runtime.ground.visible = false
    runtime.renderer.setClearColor(defaultBackgroundColor)
    runtime.hemisphere.intensity = defaultHemisphereIntensity
    runtime.keyLight.intensity = defaultKeyLightIntensity
    runtime.rimLight.intensity = defaultRimLightIntensity
    setDirectionalLightPosition(runtime.keyLight, runtime.controls.target, defaultLightAzimuth, defaultLightElevation)
    setCameraDistance(Number(runtime.controls.getDistance().toFixed(2)))
    runtime.renderer.shadowMap.needsUpdate = true
  }

  function syncSceneItems() {
    setSceneItems([...sceneItemsRef.current])
    setTransformRevision((revision) => revision + 1)
  }

  function selectSceneItem(id: string | null) {
    selectedItemIdRef.current = id
    setSelectedItemId(id)
    const item = sceneItemsRef.current.find((candidate) => candidate.id === id)
    if (item) setModelColor(`#${item.material.color.getHexString()}`)
  }
  selectSceneItemRef.current = selectSceneItem

  function captureSceneSnapshot(): SceneHistorySnapshot {
    return {
      selectedItemId: selectedItemIdRef.current,
      items: sceneItemsRef.current.map((item) => ({
        item,
        position: [item.object.position.x, item.object.position.y, item.object.position.z],
        quaternion: [item.object.quaternion.x, item.object.quaternion.y, item.object.quaternion.z, item.object.quaternion.w],
        scale: [item.object.scale.x, item.object.scale.y, item.object.scale.z],
        color: `#${item.material.color.getHexString()}`,
        parametricBox: item.parametricBox ? { ...item.parametricBox.settings } : undefined,
        parametricPrimitive: item.parametricPrimitive ? { ...item.parametricPrimitive.settings } : undefined,
      })),
    }
  }

  function pushSceneHistory(snapshot = captureSceneSnapshot()) {
    const history = sceneHistoryRef.current
    if (history.length && sceneSnapshotSignature(history.at(-1)!) === sceneSnapshotSignature(snapshot)) return
    sceneHistoryRef.current = [...history.slice(-49), snapshot]
  }

  function restoreSceneSnapshot(snapshot: SceneHistorySnapshot) {
    const runtime = runtimeRef.current
    if (!runtime) return
    const restoredItems = snapshot.items.map(({ item, position, quaternion, scale, color, parametricBox, parametricPrimitive }) => {
      if (item.object.parent !== runtime.scene) runtime.scene.add(item.object)
      item.object.position.fromArray(position)
      item.object.quaternion.fromArray(quaternion)
      item.object.scale.fromArray(scale)
      item.material.color.set(color)
      item.material.needsUpdate = true
      if (parametricBox && item.parametricBox) {
        item.parametricBox.settings = { ...parametricBox }
        rebuildParametricBox(item)
      }
      if (parametricPrimitive && item.parametricPrimitive) {
        item.parametricPrimitive.settings = { ...parametricPrimitive }
        rebuildParametricPrimitive(item)
      }
      item.object.updateMatrixWorld(true)
      return item
    })
    sceneItemsRef.current.forEach((item) => {
      if (!restoredItems.includes(item)) runtime.scene.remove(item.object)
    })
    sceneItemsRef.current = restoredItems
    syncSceneItems()
    const selection = restoredItems.some((item) => item.id === snapshot.selectedItemId)
      ? snapshot.selectedItemId
      : restoredItems.at(-1)?.id || null
    selectSceneItem(selection)
    if (restoredItems.length) updateSceneBounds(false)
    else {
      runtime.transformControls.detach()
      runtime.selectionBox.visible = false
    }
  }

  function undoScene() {
    const snapshot = sceneHistoryRef.current.at(-1)
    if (!snapshot) return
    sceneHistoryRef.current = sceneHistoryRef.current.slice(0, -1)
    restoreSceneSnapshot(snapshot)
  }
  undoSceneRef.current = undoScene

  function updateSceneBounds(fitCamera = false) {
    const runtime = runtimeRef.current
    if (!runtime || sceneItemsRef.current.length === 0) return
    const sceneBox = new THREE.Box3()
    sceneItemsRef.current.forEach((item) => {
      item.object.updateMatrixWorld(true)
      sceneBox.expandByObject(item.object)
    })
    if (sceneBox.isEmpty()) return

    const sphere = sceneBox.getBoundingSphere(new THREE.Sphere())
    const radius = Math.max(sphere.radius, 0.5)
    runtime.ground.position.y = sceneBox.min.y - 0.025
    const shadowExtent = Math.max(6, radius * 4.2)
    runtime.keyLight.shadow.camera.left = -shadowExtent
    runtime.keyLight.shadow.camera.right = shadowExtent
    runtime.keyLight.shadow.camera.top = shadowExtent
    runtime.keyLight.shadow.camera.bottom = -shadowExtent
    runtime.keyLight.shadow.camera.updateProjectionMatrix()

    if (fitCamera) {
      const halfFov = THREE.MathUtils.degToRad(runtime.camera.fov * 0.5)
      const distance = (radius / Math.sin(halfFov)) * 1.35
      const currentDirection = runtime.camera.position.clone().sub(runtime.controls.target)
      const direction = currentDirection.lengthSq() > 0
        ? currentDirection.normalize()
        : new THREE.Vector3(1, 0.62, 1).normalize()
      runtime.controls.target.copy(sphere.center)
      runtime.camera.position.copy(sphere.center).addScaledVector(direction, distance)
      runtime.camera.near = Math.max(0.01, distance / 1000)
      runtime.camera.far = Math.max(100, distance * 100)
      runtime.camera.updateProjectionMatrix()
      runtime.controls.minDistance = Math.max(0.15, radius * 0.22)
      runtime.controls.maxDistance = Math.max(30, radius * 24)
      runtime.controls.update()
      runtime.controls.saveState()
      setCameraDistance(Number(runtime.controls.getDistance().toFixed(2)))
    }

    setDirectionalLightPosition(runtime.keyLight, runtime.controls.target, lightAzimuth, lightElevation)
    runtime.renderer.shadowMap.needsUpdate = true
  }
  updateSceneBoundsRef.current = updateSceneBounds

  function deleteSceneItem(id: string, recordHistory = true) {
    const runtime = runtimeRef.current
    const item = sceneItemsRef.current.find((candidate) => candidate.id === id)
    if (!runtime || !item) return
    if (recordHistory) pushSceneHistory()
    if (selectedItemIdRef.current === id) {
      runtime.transformControls.detach()
      runtime.selectionBox.visible = false
    }
    runtime.scene.remove(item.object)
    sceneItemsRef.current = sceneItemsRef.current.filter((candidate) => candidate.id !== id)
    const nextSelection = sceneItemsRef.current.at(-1)?.id || null
    syncSceneItems()
    selectSceneItem(nextSelection)
    if (sceneItemsRef.current.length) updateSceneBounds(false)
  }

  function deleteSelectedItem() {
    if (selectedItemIdRef.current) deleteSceneItem(selectedItemIdRef.current)
  }
  deleteSelectedItemRef.current = deleteSelectedItem

  useEffect(() => {
    const host = viewportHostRef.current
    if (!host) return
    const allSceneItems = allSceneItemsRef.current

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: transparentExport,
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
    camera.position.set(5.6, 3.5, 6.4)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.075
    controls.screenSpacePanning = true
    controls.zoomToCursor = true
    controls.mouseButtons.MIDDLE = THREE.MOUSE.PAN
    controls.minPolarAngle = 0.03
    controls.maxPolarAngle = Math.PI - 0.03
    controls.target.set(0, 0, 0)

    const transformControls = new TransformControls(camera, renderer.domElement)
    transformControls.setMode('translate')
    transformControls.setSize(0.82)
    scene.add(transformControls.getHelper())

    const selectionBox = new THREE.BoxHelper(new THREE.Object3D(), 0x74d8f3)
    selectionBox.visible = false
    selectionBox.material.depthTest = false
    selectionBox.material.transparent = true
    selectionBox.material.opacity = 0.78
    scene.add(selectionBox)

    const hemisphere = new THREE.HemisphereLight(0xf4f8ff, 0x24303b, defaultHemisphereIntensity)
    scene.add(hemisphere)

    const keyLight = new THREE.DirectionalLight(0xffffff, defaultKeyLightIntensity)
    keyLight.castShadow = true
    keyLight.shadow.mapSize.set(2048, 2048)
    keyLight.shadow.camera.near = 0.1
    keyLight.shadow.camera.far = 40
    keyLight.shadow.camera.left = -8
    keyLight.shadow.camera.right = 8
    keyLight.shadow.camera.top = 8
    keyLight.shadow.camera.bottom = -8
    keyLight.shadow.bias = -0.00035
    keyLight.shadow.normalBias = 0.035
    keyLight.shadow.radius = 3
    scene.add(keyLight)
    scene.add(keyLight.target)
    setDirectionalLightPosition(keyLight, controls.target, defaultLightAzimuth, defaultLightElevation)

    const rimLight = new THREE.DirectionalLight(0x8fcde3, defaultRimLightIntensity)
    rimLight.position.set(-5, 3, -4)
    scene.add(rimLight)

    const groundMaterial = new THREE.MeshStandardMaterial({ color: 0x18212a, roughness: 1, metalness: 0 })
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), groundMaterial)
    ground.rotation.x = -Math.PI / 2
    ground.position.y = -0.02
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

    const updateDistance = () => setCameraDistance(Number(controls.getDistance().toFixed(2)))
    const handleDraggingChanged = (event: { value?: unknown }) => {
      controls.enabled = !event.value
    }
    const handleObjectChange = () => {
      selectionBox.update()
      setTransformRevision((revision) => revision + 1)
    }
    const handleTransformStart = () => {
      transformStartSnapshotRef.current = captureSceneSnapshot()
    }
    const handleTransformEnd = () => {
      const startSnapshot = transformStartSnapshotRef.current
      transformStartSnapshotRef.current = null
      if (startSnapshot && sceneSnapshotSignature(startSnapshot) !== sceneSnapshotSignature(captureSceneSnapshot())) {
        pushSceneHistory(startSnapshot)
      }
      updateSceneBoundsRef.current(false)
    }
    controls.addEventListener('end', updateDistance)
    transformControls.addEventListener('dragging-changed', handleDraggingChanged)
    transformControls.addEventListener('objectChange', handleObjectChange)
    transformControls.addEventListener('mouseDown', handleTransformStart)
    transformControls.addEventListener('mouseUp', handleTransformEnd)

    const raycaster = new THREE.Raycaster()
    const pointer = new THREE.Vector2()
    const handlePointerDown = (event: PointerEvent) => {
      if (event.button === 1) renderer.domElement.classList.add('is-panning')
      if (event.button !== 0 || transformControls.dragging) return
      const rect = renderer.domElement.getBoundingClientRect()
      pointer.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      )
      raycaster.setFromCamera(pointer, camera)
      const candidates = sceneItemsRef.current.map((item) => item.object)
      const hit = raycaster.intersectObjects(candidates, true)[0]
      selectSceneItemRef.current(sceneObjectIdFromIntersection(hit?.object || null))
    }
    const handlePointerRelease = () => renderer.domElement.classList.remove('is-panning')
    const preventMiddleClick = (event: MouseEvent) => {
      if (event.button === 1) event.preventDefault()
    }
    renderer.domElement.addEventListener('pointerdown', handlePointerDown)
    renderer.domElement.addEventListener('auxclick', preventMiddleClick)
    window.addEventListener('pointerup', handlePointerRelease)
    window.addEventListener('pointercancel', handlePointerRelease)
    window.addEventListener('blur', handlePointerRelease)

    runtimeRef.current = { renderer, scene, camera, controls, transformControls, selectionBox, hemisphere, keyLight, rimLight, ground, resize }
    const resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(host)
    resize()
    controls.update()
    const sequence = ++loadSequenceRef.current
    if (initialScene || useSavedScene) {
      setLoading(true)
      void (async () => {
        try {
          const savedScene = initialScene || await readModel3DDraft()
          if (sequence !== loadSequenceRef.current) return
          if (savedScene) await restoreSavedSceneRef.current(savedScene)
        } catch (reason) {
          if (sequence === loadSequenceRef.current) setError(`无法恢复已保存的场景。${model3DStorageErrorMessage(reason)}`)
        } finally {
          if (sequence === loadSequenceRef.current) setLoading(false)
        }
      })()
    }

    const renderFrame = () => {
      controls.update()
      if (selectionBox.visible) selectionBox.update()
      renderer.render(scene, camera)
      animationFrameRef.current = window.requestAnimationFrame(renderFrame)
    }
    renderFrame()

    return () => {
      loadSequenceRef.current += 1
      window.cancelAnimationFrame(animationFrameRef.current)
      resizeObserver.disconnect()
      renderer.domElement.removeEventListener('pointerdown', handlePointerDown)
      renderer.domElement.removeEventListener('auxclick', preventMiddleClick)
      window.removeEventListener('pointerup', handlePointerRelease)
      window.removeEventListener('pointercancel', handlePointerRelease)
      window.removeEventListener('blur', handlePointerRelease)
      controls.removeEventListener('end', updateDistance)
      transformControls.removeEventListener('dragging-changed', handleDraggingChanged)
      transformControls.removeEventListener('objectChange', handleObjectChange)
      transformControls.removeEventListener('mouseDown', handleTransformStart)
      transformControls.removeEventListener('mouseUp', handleTransformEnd)
      controls.dispose()
      transformControls.detach()
      transformControls.dispose()
      allSceneItems.forEach((item) => disposeModel(item.object, item.material))
      allSceneItems.clear()
      sceneItemsRef.current = []
      sceneHistoryRef.current = []
      selectionBox.geometry.dispose()
      disposeMaterial(selectionBox.material)
      ground.geometry.dispose()
      groundMaterial.dispose()
      renderer.dispose()
      renderer.domElement.remove()
      runtimeRef.current = null
    }
  }, [initialScene, transparentExport, useSavedScene])

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
    const runtime = runtimeRef.current
    if (!runtime) return
    const item = sceneItemsRef.current.find((candidate) => candidate.id === selectedItemId)
    if (item) {
      runtime.transformControls.attach(item.object)
      runtime.selectionBox.setFromObject(item.object)
      runtime.selectionBox.visible = true
      setModelColor(`#${item.material.color.getHexString()}`)
    } else {
      runtime.transformControls.detach()
      runtime.selectionBox.visible = false
    }
  }, [selectedItemId, sceneItems])

  useEffect(() => {
    runtimeRef.current?.transformControls.setMode(transformMode)
  }, [transformMode])

  useEffect(() => {
    runtimeRef.current?.transformControls.setSpace(transformSpace)
  }, [transformSpace])

  useEffect(() => {
    const runtime = runtimeRef.current
    if (!runtime) return
    runtime.camera.setFocalLength(focalLength)
    runtime.camera.updateProjectionMatrix()
  }, [focalLength])

  useEffect(() => {
    const runtime = runtimeRef.current
    if (!runtime) return
    runtime.ground.visible = showProjection && lightEnabled
    runtime.renderer.shadowMap.needsUpdate = true
  }, [lightEnabled, showProjection])

  useEffect(() => {
    const runtime = runtimeRef.current
    if (!runtime) return
    const intensityScale = lightIntensity / 100
    runtime.hemisphere.intensity = lightEnabled
      ? defaultHemisphereIntensity * intensityScale
      : unlitPreviewHemisphereIntensity
    runtime.keyLight.intensity = lightEnabled ? defaultKeyLightIntensity * intensityScale : 0
    runtime.rimLight.intensity = lightEnabled ? defaultRimLightIntensity * intensityScale : 0
    sceneItemsRef.current.forEach((item) => {
      const materials = item.parametricBox
        ? [item.parametricBox.baseMaterial, item.parametricBox.lidMaterial]
        : [item.material]
      materials.forEach((material) => {
        material.emissive.set(0x000000)
        material.emissiveIntensity = 0
        material.roughness = lightEnabled ? 0.58 : 0.86
        material.metalness = lightEnabled ? 0.08 : 0.02
        material.needsUpdate = true
      })
    })
    runtime.renderer.shadowMap.needsUpdate = true
  }, [lightEnabled, lightIntensity])

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
      const target = event.target as HTMLElement | null
      if (optimizationPreview) {
        if (event.key === 'Escape') { event.preventDefault(); setOptimizationPreview(null) }
        if (event.key === 'Tab') {
          const controls = optimizationDialogRef.current?.querySelectorAll<HTMLElement>('button, a[href]')
          if (controls?.length) {
            const first = controls[0], last = controls[controls.length - 1]
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
          }
        }
        return
      }
      if (optimizing && event.key !== 'Escape') return
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        undoSceneRef.current()
        return
      }
      if (target?.matches('input, textarea, select, [contenteditable="true"]')) return
      if (event.key === 'Escape') onClose()
      if (event.key.toLowerCase() === 'w') setTransformMode('translate')
      if (event.key.toLowerCase() === 'r') setTransformMode('rotate')
      if (event.key === 'Delete' || event.key === 'Backspace') deleteSelectedItemRef.current()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose, optimizing, optimizationPreview])

  function nextPlacement(index: number) {
    const column = index % 3
    const row = Math.floor(index / 3)
    return new THREE.Vector3((column - 1) * 2.55, 0, row * 2.65)
  }

  function createModelMaterial(color: string) {
    return new THREE.MeshStandardMaterial({
      color,
      emissive: 0x000000,
      emissiveIntensity: 0,
      roughness: lightEnabled ? 0.58 : 0.86,
      metalness: lightEnabled ? 0.08 : 0.02,
    })
  }

  function rebuildParametricPrimitive(item: SceneItem) {
    const data = item.parametricPrimitive
    if (!data) return
    const settings = data.settings
    const root = item.object as THREE.Group
    disposeObjectGeometries(root)
    root.clear()
    const unit = 0.01
    const geometry = settings.kind === 'cylinder'
      ? new THREE.CylinderGeometry(settings.radius * unit, settings.radius * unit, settings.height * unit, 64)
      : new THREE.BoxGeometry(settings.length * unit, settings.height * unit, settings.width * unit)
    const mesh = new THREE.Mesh(geometry, item.material)
    const height = settings.height * unit
    mesh.position.y = height / 2
    mesh.castShadow = true
    mesh.receiveShadow = true
    root.add(mesh)
    item.material.color.set(settings.color)
    item.material.needsUpdate = true
    root.updateMatrixWorld(true)
    item.stats = collectModelStats(root)
  }

  function createParametricPrimitive(
    sourceSettings: ParametricPrimitiveSettings,
    recordHistory = true,
  ) {
    const runtime = runtimeRef.current
    if (!runtime) return null
    if (recordHistory) pushSceneHistory()
    const settings = { ...sourceSettings }
    const root = new THREE.Group()
    const id = crypto.randomUUID()
    const name = settings.kind === 'cylinder' ? '参数化圆柱体' : '参数化方形体'
    root.name = name
    root.userData.sceneItemId = id
    root.position.copy(nextPlacement(sceneItemsRef.current.length))
    const material = createModelMaterial(settings.color)
    const item: SceneItem = {
      id,
      name,
      format: '参数模型',
      object: root,
      material,
      stats: { meshes: 0, vertices: 0, triangles: 0 },
      parametricPrimitive: { settings },
    }
    rebuildParametricPrimitive(item)
    runtime.scene.add(root)
    allSceneItemsRef.current.add(item)
    sceneItemsRef.current = [...sceneItemsRef.current, item]
    syncSceneItems()
    selectSceneItem(id)
    window.requestAnimationFrame(() => updateSceneBounds(true))
    return item
  }

  function changeParametricPrimitiveSettings(changes: Partial<ParametricPrimitiveSettings>, recordHistory = true) {
    if (!selectedItem?.parametricPrimitive) return
    if (recordHistory) pushSceneHistory()
    const next = { ...selectedItem.parametricPrimitive.settings, ...changes }
    next.radius = Math.max(10, Math.min(300, next.radius))
    next.height = Math.max(10, Math.min(600, next.height))
    next.length = Math.max(10, Math.min(600, next.length))
    next.width = Math.max(10, Math.min(600, next.width))
    selectedItem.parametricPrimitive.settings = next
    rebuildParametricPrimitive(selectedItem)
    syncSceneItems()
    updateSceneBounds(false)
  }

  function rebuildParametricBox(item: SceneItem) {
    const data = item.parametricBox
    if (!data) return
    const root = item.object as THREE.Group
    const baseGroup = root.getObjectByName('parametric-box-base') as THREE.Group | undefined
    const lidGroup = root.getObjectByName('parametric-box-lid') as THREE.Group | undefined
    if (!baseGroup || !lidGroup) return

    disposeObjectGeometries(baseGroup)
    disposeObjectGeometries(lidGroup)
    baseGroup.clear()
    lidGroup.clear()

    const settings = data.settings
    const unit = 0.01
    const length = settings.length * unit
    const width = settings.width * unit
    const baseHeight = settings.baseHeight * unit
    const lidHeight = settings.lidHeight * unit
    const thickness = Math.min(settings.thickness * unit, length * 0.2, width * 0.2, baseHeight * 0.45, lidHeight * 0.45)
    const gap = settings.gap * unit
    const lidLength = length + (gap + thickness) * 2
    const lidWidth = width + (gap + thickness) * 2

    data.baseMaterial.color.set(settings.baseColor)
    data.lidMaterial.color.set(settings.lidColor)
    buildOpenBoxGeometry(baseGroup, { length, width, height: baseHeight, thickness }, data.baseMaterial)
    buildOpenBoxGeometry(lidGroup, { length: lidLength, width: lidWidth, height: lidHeight, thickness, inverted: true }, data.lidMaterial)

    baseGroup.position.set(0, 0, 0)
    baseGroup.rotation.set(0, 0, 0)
    lidGroup.position.set(0, 0, 0)
    lidGroup.rotation.set(0, 0, 0)
    if (settings.pose === 'closed') {
      lidGroup.position.y = baseHeight - lidHeight * 0.68
    } else if (settings.pose === 'open') {
      lidGroup.position.set(0, baseHeight + 0.45, 0)
      lidGroup.rotation.z = THREE.MathUtils.degToRad(-8)
    } else {
      lidGroup.position.set((length + lidLength) / 2 + 0.45, 0, 0)
      lidGroup.rotation.set(0, 0, 0)
    }
    root.updateMatrixWorld(true)
    item.stats = collectModelStats(root)
  }

  function createParametricBox(
    sourceSettings: ParametricBoxSettings = defaultParametricBoxSettings,
    recordHistory = true,
  ) {
    const runtime = runtimeRef.current
    if (!runtime) return null
    if (recordHistory) pushSceneHistory()
    const settings = { ...sourceSettings }
    const root = new THREE.Group()
    const baseGroup = new THREE.Group()
    const lidGroup = new THREE.Group()
    baseGroup.name = 'parametric-box-base'
    lidGroup.name = 'parametric-box-lid'
    root.add(baseGroup, lidGroup)
    root.position.copy(nextPlacement(sceneItemsRef.current.length))
    const id = crypto.randomUUID()
    root.name = '参数化礼盒'
    root.userData.sceneItemId = id
    const baseMaterial = createModelMaterial(settings.baseColor)
    const lidMaterial = createModelMaterial(settings.lidColor)
    const item: SceneItem = {
      id,
      name: '参数化礼盒',
      format: '参数模型',
      object: root,
      material: baseMaterial,
      stats: { meshes: 0, vertices: 0, triangles: 0 },
      parametricBox: { settings, baseMaterial, lidMaterial },
    }
    rebuildParametricBox(item)
    runtime.scene.add(root)
    allSceneItemsRef.current.add(item)
    sceneItemsRef.current = [...sceneItemsRef.current, item]
    syncSceneItems()
    selectSceneItem(id)
    window.requestAnimationFrame(() => updateSceneBounds(true))
    return item
  }

  function createSavedParametricPart(saved: SavedModel3DItem) {
    const runtime = runtimeRef.current
    if (!runtime || !saved.part || !saved.settings) return null
    const settings = { ...saved.settings }
    const unit = 0.01
    const length = settings.length * unit
    const width = settings.width * unit
    const baseHeight = settings.baseHeight * unit
    const lidHeight = settings.lidHeight * unit
    const thickness = Math.min(settings.thickness * unit, length * 0.2, width * 0.2, baseHeight * 0.45, lidHeight * 0.45)
    const gap = settings.gap * unit
    const material = createModelMaterial(saved.part === 'base' ? settings.baseColor : settings.lidColor)
    const object = new THREE.Group()
    if (saved.part === 'base') {
      buildOpenBoxGeometry(object, { length, width, height: baseHeight, thickness }, material)
    } else {
      buildOpenBoxGeometry(object, {
        length: length + (gap + thickness) * 2,
        width: width + (gap + thickness) * 2,
        height: lidHeight,
        thickness,
        inverted: true,
      }, material)
    }
    const id = crypto.randomUUID()
    object.name = saved.name
    object.userData.sceneItemId = id
    applySavedTransform(object, saved.transform)
    const item: SceneItem = {
      id,
      name: saved.name,
      format: saved.part === 'base' ? '参数模型 · 盒底' : '参数模型 · 盒盖',
      object,
      material,
      stats: collectModelStats(object),
      parametricBoxPart: { part: saved.part, settings },
    }
    runtime.scene.add(object)
    allSceneItemsRef.current.add(item)
    sceneItemsRef.current = [...sceneItemsRef.current, item]
    return item
  }

  async function restoreSavedScene(saved: SavedModel3DScene) {
    const sequence = loadSequenceRef.current
    setViewportId(viewportPresets.some((preset) => preset.id === saved.viewportId) ? saved.viewportId : 'square')
    setBackgroundColor(saved.backgroundColor || defaultBackgroundColor)
    setFocalLength(saved.focalLength || 50)
    setShowProjection(Boolean(saved.showProjection))
    setLightEnabled(saved.lightEnabled !== false)
    setLightIntensity(saved.lightIntensity || defaultLightIntensity)
    setLightAzimuth(Number.isFinite(saved.lightAzimuth) ? saved.lightAzimuth : defaultLightAzimuth)
    setLightElevation(Number.isFinite(saved.lightElevation) ? saved.lightElevation : defaultLightElevation)
    const restored: SceneItem[] = []
    for (const savedItem of saved.items) {
      if (sequence !== loadSequenceRef.current) return
      if (savedItem.kind === 'parametric-box' && savedItem.settings) {
        const item = createParametricBox(savedItem.settings, false)
        if (item) {
          item.name = savedItem.name
          item.object.name = savedItem.name
          applySavedTransform(item.object, savedItem.transform)
          restored.push(item)
        }
      } else if (savedItem.kind === 'parametric-part') {
        const item = createSavedParametricPart(savedItem)
        if (item) restored.push(item)
      } else if (savedItem.kind === 'parametric-primitive' && savedItem.primitiveSettings) {
        const item = createParametricPrimitive(savedItem.primitiveSettings, false)
        if (item) {
          item.name = savedItem.name
          item.object.name = savedItem.name
          applySavedTransform(item.object, savedItem.transform)
          restored.push(item)
        }
      } else if (savedItem.kind === 'imported-model' && savedItem.source) {
        try {
          const object = await parseSavedModelSource(savedItem.source)
          if (sequence !== loadSequenceRef.current) {
            disposeModel(object, null)
            return
          }
          const source = await persistModelSource(savedItem.source).catch(() => savedItem.source!)
          if (sequence !== loadSequenceRef.current) { disposeModel(object, null); return }
          const item = addSceneObject(
            object,
            savedItem.name,
            savedItem.source.format,
            savedItem.color || defaultModelColor,
            false,
            { ...source },
          )
          item.name = savedItem.name
          item.object.name = savedItem.name
          applySavedTransform(item.object, savedItem.transform)
          restored.push(item)
        } catch (reason) {
          if (sequence === loadSequenceRef.current) setError(reason instanceof Error ? `部分模型恢复失败：${reason.message}` : '部分模型恢复失败')
        }
      }
    }
    if (sequence !== loadSequenceRef.current) return
    syncSceneItems()
    selectSceneItem(restored[saved.selectedIndex]?.id || restored.at(-1)?.id || null)
    savedCameraRef.current = saved.camera
    window.requestAnimationFrame(() => {
      const runtime = runtimeRef.current
      const camera = savedCameraRef.current
      if (!runtime || !camera || sequence !== loadSequenceRef.current) return
      runtime.camera.position.fromArray(camera.position)
      runtime.camera.up.fromArray(camera.up)
      runtime.controls.target.fromArray(camera.target)
      runtime.camera.setFocalLength(saved.focalLength || 50)
      runtime.camera.updateProjectionMatrix()
      runtime.controls.update()
      setCameraDistance(Number(runtime.controls.getDistance().toFixed(2)))
      savedCameraRef.current = null
    })
  }
  restoreSavedSceneRef.current = restoreSavedScene

  function changeParametricBoxSettings(changes: Partial<ParametricBoxSettings>, recordHistory = true) {
    if (!selectedItem?.parametricBox) return
    if (recordHistory) pushSceneHistory()
    const current = selectedItem.parametricBox.settings
    const next = { ...current, ...changes }
    next.length = Math.max(50, Math.min(600, next.length))
    next.width = Math.max(50, Math.min(600, next.width))
    next.baseHeight = Math.max(20, Math.min(300, next.baseHeight))
    next.lidHeight = Math.max(10, Math.min(150, next.lidHeight))
    next.thickness = Math.max(1, Math.min(20, next.thickness))
    next.gap = Math.max(1, Math.min(30, next.gap))
    selectedItem.parametricBox.settings = next
    rebuildParametricBox(selectedItem)
    syncSceneItems()
    updateSceneBounds(false)
  }

  function splitParametricBox() {
    const runtime = runtimeRef.current
    const item = selectedItem
    const data = item?.parametricBox
    if (!runtime || !item || !data) return
    const baseSource = item.object.getObjectByName('parametric-box-base') as THREE.Group | undefined
    const lidSource = item.object.getObjectByName('parametric-box-lid') as THREE.Group | undefined
    if (!baseSource || !lidSource) return

    pushSceneHistory()
    item.object.updateMatrixWorld(true)

    const createPart = (source: THREE.Group, name: string, color: string, format: string) => {
      source.updateWorldMatrix(true, true)
      const object = source.clone(true)
      const material = createModelMaterial(color)
      object.traverse((child) => {
        const mesh = child as THREE.Mesh
        if (!mesh.isMesh) return
        mesh.geometry = mesh.geometry.clone()
        mesh.material = material
        mesh.castShadow = true
        mesh.receiveShadow = true
      })
      object.matrix.copy(source.matrixWorld)
      object.matrix.decompose(object.position, object.quaternion, object.scale)
      object.matrixAutoUpdate = true
      const id = crypto.randomUUID()
      object.name = name
      object.userData.sceneItemId = id
      object.updateMatrixWorld(true)
      const part: SceneItem = {
        id,
        name,
        format,
        object,
        material,
        stats: collectModelStats(object),
        parametricBoxPart: {
          part: name.includes('盒盖') ? 'lid' : 'base',
          settings: { ...data.settings },
        },
      }
      allSceneItemsRef.current.add(part)
      return part
    }

    const basePart = createPart(baseSource, '参数礼盒 · 盒底', data.settings.baseColor, '参数模型 · 盒底')
    const lidPart = createPart(lidSource, '参数礼盒 · 盒盖', data.settings.lidColor, '参数模型 · 盒盖')
    const sourceIndex = sceneItemsRef.current.indexOf(item)
    const nextItems = sceneItemsRef.current.filter((candidate) => candidate !== item)
    nextItems.splice(Math.max(0, sourceIndex), 0, basePart, lidPart)

    runtime.transformControls.detach()
    runtime.selectionBox.visible = false
    runtime.scene.remove(item.object)
    runtime.scene.add(basePart.object, lidPart.object)
    sceneItemsRef.current = nextItems
    syncSceneItems()
    selectSceneItem(basePart.id)
    updateSceneBounds(false)
  }

  function beginParameterEdit() {
    if (!parameterEditSnapshotRef.current) parameterEditSnapshotRef.current = captureSceneSnapshot()
  }

  function endParameterEdit() {
    const snapshot = parameterEditSnapshotRef.current
    parameterEditSnapshotRef.current = null
    if (snapshot && sceneSnapshotSignature(snapshot) !== sceneSnapshotSignature(captureSceneSnapshot())) pushSceneHistory(snapshot)
  }

  function addSceneObject(
    object: THREE.Object3D,
    name: string,
    format: string,
    color = defaultModelColor,
    recordHistory = true,
    source?: SavedModel3DSource,
  ) {
    const runtime = runtimeRef.current
    if (!runtime) throw new Error('3D 预览器尚未准备好')

    const material = createModelMaterial(color)
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
    if (recordHistory) pushSceneHistory()

    if (!source?.localCoordinates) {
      object.scale.multiplyScalar(2.35 / maximumDimension)
      object.updateMatrixWorld(true)
      const scaledBox = new THREE.Box3().setFromObject(object)
      const center = scaledBox.getCenter(new THREE.Vector3())
      object.position.set(-center.x, -scaledBox.min.y, -center.z)
      object.position.add(nextPlacement(sceneItemsRef.current.length))
    }
    const id = crypto.randomUUID()
    object.userData.sceneItemId = id
    object.name = name
    object.updateMatrixWorld(true)

    const item: SceneItem = { id, name, format, object, material, stats: collectModelStats(object), source }
    allSceneItemsRef.current.add(item)
    runtime.scene.add(object)
    sceneItemsRef.current = [...sceneItemsRef.current, item]
    syncSceneItems()
    selectSceneItem(id)
    return item
  }

  async function loadModelFiles(files: File[]) {
    if (optimizing || optimizationPreview) return
    const supportedFiles = files.filter((file) => ['obj', 'fbx', 'glb'].includes(modelFileExtension(file.name)))
    if (!supportedFiles.length) {
      setError('仅支持 OBJ、FBX 或 GLB 格式文件')
      return
    }
    if (supportedFiles.some((file) => file.size > maximumModelFileSize)) {
      setError('单个模型文件不能超过 100 MB')
      return
    }

    const sequence = loadSequenceRef.current + 1
    loadSequenceRef.current = sequence
    setLoading(true)
    setError('')
    try {
      for (const file of supportedFiles) {
        const extension = modelFileExtension(file.name)
        const format = extension.toUpperCase() as SavedModel3DSource['format']
        const buffer = await file.arrayBuffer()
        const startedAt = performance.now()
        const object = await parseModelBuffer(buffer, format)
        const loadMs = performance.now() - startedAt
        let source: SavedModel3DSource
        try {
          source = { ...await cacheModelFile(file, file.name, format), loadMs }
        } catch (reason) { disposeModel(object, null); throw reason }
        if (sequence !== loadSequenceRef.current) {
          disposeModel(object, null)
          return
        }
        addSceneObject(object, file.name, extension.toUpperCase(), defaultModelColor, true, source)
      }
      window.requestAnimationFrame(() => updateSceneBounds(true))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '模型解析失败，请检查文件是否完整')
    } finally {
      if (sequence === loadSequenceRef.current) setLoading(false)
    }
  }

  async function optimizeSelectedModel() {
    const original = selectedItem
    const runtime = runtimeRef.current
    if (!original?.source || !runtime || loading || optimizing || optimizationPreview) return
    const sequence = loadSequenceRef.current
    setOptimizing(true)
    setError('')
    let snapshot: THREE.Object3D | null = null
    let candidate: THREE.Object3D | null = null
    try {
      snapshot = createStaticModelSnapshot(original.object)
      const source = await optimizeModelSnapshot(snapshot, original.source, optimizationRatio)
      candidate = await parseSavedModelSource(source)
      if (sequence !== loadSequenceRef.current || !sceneItemsRef.current.includes(original)) return
      candidate.traverse((child) => {
        const mesh = child as THREE.Mesh
        if (!mesh.isMesh) return
        for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) disposeMaterial(material)
        mesh.material = original.material.clone()
        mesh.castShadow = mesh.receiveShadow = true
      })
      candidate.position.copy(original.object.position)
      candidate.quaternion.copy(original.object.quaternion)
      candidate.scale.copy(original.object.scale)
      const selectionVisible = runtime.selectionBox.visible
      const gizmo = runtime.transformControls.getHelper()
      const gizmoVisible = gizmo.visible
      const originalVisible = original.object.visible
      let beforeImage: string
      let afterImage: string
      try {
        runtime.selectionBox.visible = gizmo.visible = false
        runtime.renderer.shadowMap.needsUpdate = true
        runtime.renderer.render(runtime.scene, runtime.camera)
        beforeImage = runtime.renderer.domElement.toDataURL('image/png')
        original.object.visible = false
        runtime.scene.add(candidate)
        runtime.renderer.shadowMap.needsUpdate = true
        runtime.renderer.render(runtime.scene, runtime.camera)
        afterImage = runtime.renderer.domElement.toDataURL('image/png')
      } finally {
        runtime.scene.remove(candidate)
        original.object.visible = originalVisible
        runtime.selectionBox.visible = selectionVisible
        gizmo.visible = gizmoVisible
        runtime.renderer.shadowMap.needsUpdate = true
        runtime.renderer.render(runtime.scene, runtime.camera)
      }
      setOptimizationPreview({ originalId: original.id, object: candidate, source, beforeImage, afterImage, applied: false })
      setShowOptimizedPreview(true)
      candidate = null
    } catch (reason) {
      if (sequence === loadSequenceRef.current) setError(reason instanceof Error ? reason.message : '模型优化失败')
    } finally {
      if (snapshot) disposeStaticSnapshot(snapshot)
      if (candidate) disposeModel(candidate, null)
      if (sequence === loadSequenceRef.current) setOptimizing(false)
    }
  }

  function applyOptimizedModel() {
    const preview = optimizationPreview
    const runtime = runtimeRef.current
    const original = sceneItemsRef.current.find((item) => item.id === preview?.originalId)
    if (!preview || !runtime || !original) { setOptimizationPreview(null); return }
    pushSceneHistory()
    const replacement = addSceneObject(preview.object, original.name, 'GLB', `#${original.material.color.getHexString()}`, false, preview.source)
    replacement.object.position.copy(original.object.position)
    replacement.object.quaternion.copy(original.object.quaternion)
    replacement.object.scale.copy(original.object.scale)
    runtime.transformControls.detach()
    runtime.scene.remove(original.object)
    sceneItemsRef.current = sceneItemsRef.current.filter((item) => item !== replacement).map((item) => item === original ? replacement : item)
    preview.applied = true
    setOptimizationPreview(null)
    syncSceneItems()
    selectSceneItem(replacement.id)
    runtime.transformControls.attach(replacement.object)
    updateSceneBounds(false)
    setSaveStatus('idle')
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files || [])
    event.target.value = ''
    if (files.length) void loadModelFiles(files)
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    setDraggingOverViewport(false)
    const files = Array.from(event.dataTransfer.files || [])
    if (files.length) {
      void loadModelFiles(files)
      return
    }
  }

  function duplicateSelectedItem() {
    if (!selectedItem) return
    pushSceneHistory()
    if (selectedItem.parametricBox) {
      const copy = createParametricBox(selectedItem.parametricBox.settings, false)
      if (!copy) return
      copy.object.position.copy(selectedItem.object.position).add(new THREE.Vector3(0.45, 0, 0.45))
      copy.object.quaternion.copy(selectedItem.object.quaternion)
      copy.object.scale.copy(selectedItem.object.scale)
      syncSceneItems()
      updateSceneBounds(false)
      return
    }
    if (selectedItem.parametricPrimitive) {
      const copy = createParametricPrimitive(selectedItem.parametricPrimitive.settings, false)
      if (!copy) return
      copy.object.position.copy(selectedItem.object.position).add(new THREE.Vector3(0.45, 0, 0.45))
      copy.object.quaternion.copy(selectedItem.object.quaternion)
      copy.object.scale.copy(selectedItem.object.scale)
      syncSceneItems()
      updateSceneBounds(false)
      return
    }
    const clone = selectedItem.object.clone(true)
    clone.traverse((child) => {
      const mesh = child as THREE.Mesh
      if (!mesh.isMesh) return
      mesh.geometry = mesh.geometry.clone()
      mesh.material = new THREE.MeshBasicMaterial()
    })
    const copy = addSceneObject(
      clone,
      `${selectedItem.name} 副本`,
      selectedItem.format,
      `#${selectedItem.material.color.getHexString()}`,
      false,
      selectedItem.source ? { ...selectedItem.source } : undefined,
    )
    copy.object.position.copy(selectedItem.object.position).add(new THREE.Vector3(0.45, 0, 0.45))
    copy.object.rotation.copy(selectedItem.object.rotation)
    syncSceneItems()
    updateSceneBounds(false)
  }

  function changeSelectedColor(color: string) {
    setModelColor(color)
    if (!selectedItem) return
    if (selectedItem.parametricBox) {
      changeParametricBoxSettings({ baseColor: color })
      return
    }
    if (selectedItem.parametricPrimitive) {
      changeParametricPrimitiveSettings({ color })
      return
    }
    if (`#${selectedItem.material.color.getHexString()}`.toLowerCase() !== color.toLowerCase()) pushSceneHistory()
    selectedItem.material.color.set(color)
    if (selectedItem.parametricBoxPart) {
      if (selectedItem.parametricBoxPart.part === 'base') selectedItem.parametricBoxPart.settings.baseColor = color
      else selectedItem.parametricBoxPart.settings.lidColor = color
    }
    selectedItem.material.needsUpdate = true
  }

  function changeSelectedTransform(kind: 'position' | 'rotation', axis: 'x' | 'y' | 'z', value: number) {
    if (!selectedItem || !Number.isFinite(value)) return
    const currentValue = kind === 'rotation'
      ? THREE.MathUtils.radToDeg(selectedItem.object.rotation[axis])
      : selectedItem.object.position[axis]
    if (Math.abs(currentValue - value) < 0.0001) return
    pushSceneHistory()
    if (kind === 'rotation') selectedItem.object.rotation[axis] = THREE.MathUtils.degToRad(value)
    else selectedItem.object.position[axis] = value
    selectedItem.object.updateMatrixWorld(true)
    runtimeRef.current?.selectionBox.update()
    syncSceneItems()
    updateSceneBounds(false)
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
    if (!runtime || !hasModel) return
    const distance = runtime.controls.getDistance()
    const direction = view === 'front'
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
    if (!runtime || !hasModel) return
    runtime.camera.up.set(0, 1, 0)
    updateSceneBounds(true)
    runtime.camera.setFocalLength(focalLength)
    runtime.camera.updateProjectionMatrix()
  }

  async function exportCurrentView() {
    const runtime = runtimeRef.current
    if (!runtime || !hasModel || exporting) {
      if (!hasModel) setError('请先加入至少一个 3D 模型')
      return
    }

    setExporting(true)
    setError('')
    try {
      const previousPixelRatio = runtime.renderer.getPixelRatio()
      const previousSize = runtime.renderer.getSize(new THREE.Vector2())
      const selectionWasVisible = runtime.selectionBox.visible
      const gizmoWasVisible = runtime.transformControls.getHelper().visible
      const groundWasVisible = runtime.ground.visible
      const clearAlpha = runtime.renderer.getClearAlpha()
      let dataUrl: string
      try {
        runtime.selectionBox.visible = false
        runtime.transformControls.getHelper().visible = false
        if (transparentExport) {
          runtime.renderer.setClearAlpha(0)
          runtime.ground.visible = false
        }
        runtime.renderer.setPixelRatio(1)
        runtime.renderer.setSize(viewport.width, viewport.height, false)
        runtime.camera.aspect = viewport.width / viewport.height
        runtime.camera.updateProjectionMatrix()
        runtime.controls.update()
        runtime.renderer.render(runtime.scene, runtime.camera)
        dataUrl = runtime.renderer.domElement.toDataURL('image/png')
      } finally {
        runtime.renderer.setClearAlpha(clearAlpha)
        runtime.ground.visible = groundWasVisible
        runtime.renderer.setPixelRatio(previousPixelRatio)
        runtime.renderer.setSize(previousSize.x, previousSize.y, false)
        runtime.camera.aspect = previousSize.x / previousSize.y
        runtime.camera.updateProjectionMatrix()
        runtime.selectionBox.visible = selectionWasVisible
        runtime.transformControls.getHelper().visible = gizmoWasVisible
        runtime.controls.update()
      }

      const savedScene = captureSavedScene()
      if (!savedScene) throw new Error('无法保存当前 3D 场景')
      await onExport({
        dataUrl,
        fileName: `礼盒3D构图-${viewport.width}x${viewport.height}.png`,
        width: viewport.width,
        height: viewport.height,
        sceneId: sceneId || crypto.randomUUID(),
        scene: savedScene,
      })
      setExporting(false)
      onClose()
    } catch (reason) {
      setExporting(false)
      setError(reason instanceof Error ? reason.message : '导出参考图失败')
    }
  }

  const viewportStyle = { '--model3d-aspect': String(viewport.width / viewport.height) } as CSSProperties
  const lightDirectionStyle = { '--model3d-light-angle': `${lightAzimuth - 90}deg` } as CSSProperties
  const selectedPosition = selectedItem?.object.position
  const selectedRotation = selectedItem?.object.rotation
  void transformRevision

  return (
    <div
      className="model3d-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section className="model3d-studio" role="dialog" aria-modal="true" aria-label="3D 模型预览">
        {optimizationPreview && (
          <div className="model3d-optimize-overlay">
            <section ref={optimizationDialogRef} className="model3d-optimize-dialog" role="dialog" aria-modal="true" aria-label="模型优化对比">
              <header><strong>模型优化对比</strong><button type="button" onClick={() => setOptimizationPreview(null)} aria-label="取消模型优化"><X size={18} /></button></header>
              <div className="model3d-optimize-tabs" role="group" aria-label="优化外观对比">
                <button type="button" aria-pressed={!showOptimizedPreview} onClick={() => setShowOptimizedPreview(false)}>原始画面</button>
                <button type="button" aria-pressed={showOptimizedPreview} onClick={() => setShowOptimizedPreview(true)}>优化后画面</button>
              </div>
              <img className="model3d-optimize-image" src={showOptimizedPreview ? optimizationPreview.afterImage : optimizationPreview.beforeImage} alt={showOptimizedPreview ? '优化后模型预览' : '原始模型预览'} />
              <table className="model3d-optimize-table"><thead><tr><th>对比项</th><th>原始模型</th><th>压缩 GLB</th></tr></thead><tbody>
                <tr><th>文件大小</th><td>{formatModelBytes(optimizationPreview.source.optimization?.originalBytes)}</td><td>{formatModelBytes(optimizationPreview.source.byteLength)}</td></tr>
                <tr><th>三角面</th><td>{formatCount(optimizationPreview.source.optimization?.originalTriangles ?? 0)}</td><td>{formatCount(optimizationPreview.source.optimization?.triangles ?? 0)}</td></tr>
                <tr><th>本次解析耗时</th><td>{optimizationPreview.source.optimization?.originalLoadMs === undefined ? '未统计' : `${Math.round(optimizationPreview.source.optimization.originalLoadMs)} ms`}</td><td>{Math.round(optimizationPreview.source.loadMs ?? 0)} ms</td></tr>
              </tbody></table>
              <p>{(optimizationPreview.source.byteLength ?? 0) < (optimizationPreview.source.optimization?.originalBytes ?? 0)
                ? `文件缩小 ${(100 * (1 - optimizationPreview.source.byteLength! / optimizationPreview.source.optimization!.originalBytes)).toFixed(1)}%。`
                : '这个模型已经很小，转换后文件没有变小，可以保留原模型。'} 解析耗时包含解码器初始化，会受缓存影响。</p>
              <p>优化副本为当前姿态的纯色静态模型；请检查轮廓和细节。应用后可用 Ctrl+Z 撤销。</p>
              <footer>
                <a href={optimizationPreview.source.url} download={optimizationPreview.source.fileName}><Download size={14} /> 下载 GLB</a>
                <button type="button" onClick={() => setOptimizationPreview(null)}>保留原模型</button>
                <button type="button" className="model3d-optimize-apply" onClick={applyOptimizedModel}>应用优化模型</button>
              </footer>
            </section>
          </div>
        )}
        <header className="model3d-head" inert={Boolean(optimizationPreview)}>
          <div className="model3d-title">
            <Box size={19} />
            <div>
              <h2>3D 模型预览</h2>
              <p>{transparentExport ? '调整模型的位置、角度与颜色，确认后应用到手绘画板' : '创建参数化礼盒或导入本地模型，调整位置与构图后输出为画板参考图'}</p>
            </div>
          </div>
          <div className="model3d-head-actions">
            <button className="model3d-reset-button" type="button" disabled={saveStatus === 'saving' || saveStatus === 'resetting'} onClick={resetSceneAndSavedData} title={useSavedScene ? '清空当前场景和本地保存' : '清空当前模型编辑场景'}>
              <RefreshCw size={14} />
              {saveStatus === 'resetting' ? '重置中…' : '重置'}
            </button>
            {useSavedScene && <button className={`model3d-save-button ${saveStatus}`} type="button" disabled={loading || saveStatus === 'saving' || saveStatus === 'resetting'} onClick={saveSceneLocally}>
              {saveStatus === 'saving' ? <Loader2 size={15} className="model3d-spinner" /> : <Save size={15} />}
              {saveStatus === 'saving' ? '保存中…' : saveStatus === 'saved' ? '已保存' : saveStatus === 'error' ? '保存失败' : '保存场景'}
            </button>}
            <button className="model3d-icon-button" type="button" onClick={onClose} title="关闭 3D 预览">
              <X size={18} />
            </button>
          </div>
        </header>

        <div className="model3d-body" inert={Boolean(optimizationPreview)}>
          <div className="model3d-stage">
            <div className="model3d-filebar">
              <button type="button" className="model3d-file-button" onClick={() => fileInputRef.current?.click()}>
                <Upload size={15} />
                导入本地模型
              </button>
              <input ref={fileInputRef} type="file" accept=".obj,.fbx,.glb" multiple hidden onChange={handleFileChange} />
              <div className="model3d-file-summary">
                {hasModel ? (
                  <>
                    <strong>{sceneItems.length} 个模型正在构图</strong>
                    <span>{formatCount(totalStats.triangles)} 三角面 · 可继续拖入或导入模型</span>
                  </>
                ) : (
                  <span>支持 OBJ、FBX、GLB（含 Draco 压缩），单文件最大 100 MB</span>
                )}
              </div>
              {hasModel && (
                <div className="model3d-stats" aria-label="模型统计">
                  <span>{totalStats.meshes} 网格</span>
                  <span>{formatCount(totalStats.vertices)} 顶点</span>
                </div>
              )}
            </div>

            <section className="model3d-library" aria-label="礼盒模型库">
              <div className="model3d-library-head">
                <div>
                  <strong>参数模型</strong>
                  <span>创建可继续调整尺寸、颜色和构图的基础模型</span>
                </div>
              </div>
              <div className="model3d-parametric-create-list">
                <button className="model3d-parametric-create" type="button" onClick={() => createParametricBox()}>
                  <span className="model3d-model-glyph parametric" style={{ '--model-card-color': '#8FD9EF' } as CSSProperties}>
                    <Box size={22} />
                  </span>
                  <span><strong>参数化礼盒</strong><small>调整尺寸、壁厚与盒盖状态</small></span>
                  <Plus size={14} />
                </button>
                <button className="model3d-parametric-create" type="button" onClick={() => createParametricPrimitive(defaultCylinderSettings)}>
                  <span className="model3d-model-glyph cylinder" style={{ '--model-card-color': '#AFC9D8' } as CSSProperties} aria-hidden="true" />
                  <span><strong>圆柱模型</strong><small>调整半径和高度</small></span>
                  <Plus size={14} />
                </button>
                <button className="model3d-parametric-create" type="button" onClick={() => createParametricPrimitive(defaultCuboidSettings)}>
                  <span className="model3d-model-glyph cuboid" style={{ '--model-card-color': '#C9B9A9' } as CSSProperties}>
                    <Box size={21} />
                  </span>
                  <span><strong>方形模型</strong><small>调整长度、宽度和高度</small></span>
                  <Plus size={14} />
                </button>
              </div>
            </section>

            <div className="model3d-viewport-frame">
              <div
                className={`model3d-viewport ${draggingOverViewport ? 'drag-active' : ''}`}
                style={viewportStyle}
                onDragEnter={() => setDraggingOverViewport(true)}
                onDragLeave={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDraggingOverViewport(false)
                }}
                onDragOver={(event) => {
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'copy'
                }}
                onDrop={handleDrop}
              >
                <div ref={viewportHostRef} className="model3d-viewport-host" />
                {!hasModel && !loading && (
                  <div className="model3d-empty-state">
                    <Layers3 size={40} />
                    <strong>创建或导入 3D 模型</strong>
                    <p>使用上方参数模型，也可以批量导入 OBJ、FBX 或 GLB</p>
                    <button type="button" onClick={() => fileInputRef.current?.click()}>
                      <Upload size={15} />
                      选择本地模型
                    </button>
                  </div>
                )}
                {(loading || optimizing) && (
                  <div className="model3d-loading-state" role="status">
                    <Loader2 size={26} />
                    <strong>{optimizing ? '正在优化模型' : '正在解析模型'}</strong>
                    <span>{optimizing ? '完成后可对比外观与文件大小' : '多个模型会依次加入当前构图'}</span>
                  </div>
                )}
                <div className="model3d-viewport-hint">
                  <span>{transformMode === 'translate' ? '移动模式 W' : '旋转模式 R'} · {transformSpace === 'world' ? '世界坐标' : '物体坐标'}</span>
                  <span>中键平移视角 · Ctrl+Z 撤销</span>
                </div>
                <div className="model3d-viewport-label">
                  {viewport.label} · {viewport.width} × {viewport.height}
                </div>
              </div>
            </div>
          </div>

          <aside className="model3d-inspector" aria-label="3D 预览参数">
            {selectedItem?.source && (
              <section className="model3d-control-section model3d-optimization">
                <div className="model3d-section-title"><Box size={15} /><strong>模型优化</strong></div>
                <p>{selectedItem.source.format} · {formatModelBytes(selectedItem.source.byteLength)} · {formatCount(selectedItem.stats.triangles)} 三角面</p>
                <div className="model3d-optimize-tabs" role="group" aria-label="模型优化质量">
                  {[{ ratio: 1, label: '仅压缩' }, { ratio: 0.75, label: '轻度减面' }, { ratio: 0.5, label: '中度减面' }].map((option) => (
                    <button type="button" key={option.ratio} aria-pressed={optimizationRatio === option.ratio} disabled={optimizing} onClick={() => setOptimizationRatio(option.ratio)}>{option.label}</button>
                  ))}
                </div>
                <small>{optimizationRatio === 1 ? '保留面数，压缩几何数据并清理当前预览未使用的材质和贴图。' : `目标保留 ${optimizationRatio * 100}% 三角面，实际数量以细节保护为准。应用前请对比外观。`}</small>
                <button type="button" className="model3d-optimize-start" disabled={loading || optimizing || Boolean(optimizationPreview)} onClick={() => void optimizeSelectedModel()}>
                  {optimizing && <Loader2 size={14} className="model3d-spinner" />}{optimizing ? '正在优化…' : '优化模型 · GLB'}
                </button>
                {selectedItem.source.format === 'GLB' && <a className="model3d-download-glb" href={selectedItem.source.url} download={selectedItem.source.fileName}><Download size={13} /> 下载 GLB</a>}
              </section>
            )}
            <section className="model3d-control-section">
              <div className="model3d-section-title model3d-section-title-spread">
                <span><Layers3 size={15} /><strong>场景对象</strong></span>
                <small>{sceneItems.length} 个</small>
              </div>
              {sceneItems.length ? (
                <div className="model3d-scene-list">
                  {sceneItems.map((item) => (
                    <div className={`model3d-scene-item ${item.id === selectedItemId ? 'selected' : ''}`} key={item.id}>
                      <button type="button" onClick={() => selectSceneItem(item.id)} title={`选择 ${item.name}`}>
                        <Box size={13} />
                        <span>{item.name}</span>
                      </button>
                      <button type="button" onClick={() => deleteSceneItem(item.id)} title={`删除 ${item.name}`}>
                        <Trash2 size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="model3d-scene-empty">从左侧模型库拖入组件开始构图</div>
              )}

              <div className="model3d-transform-toolbar" aria-label="模型变换工具">
                <button className={transformMode === 'translate' ? 'active' : ''} type="button" onClick={() => setTransformMode('translate')} disabled={!selectedItem}>
                  <Move3D size={13} /> 移动
                </button>
                <button className={transformMode === 'rotate' ? 'active' : ''} type="button" onClick={() => setTransformMode('rotate')} disabled={!selectedItem}>
                  <RotateCw size={13} /> 旋转
                </button>
                <button type="button" onClick={duplicateSelectedItem} disabled={!selectedItem} title="复制当前模型">
                  <Copy size={13} />
                </button>
                <button type="button" onClick={() => updateSceneBounds(true)} disabled={!hasModel} title="查看全部模型">
                  <Focus size={13} />
                </button>
              </div>

              <div className="model3d-coordinate-space">
                <span>坐标方向</span>
                <div role="group" aria-label="变换坐标方向">
                  <button
                    className={transformSpace === 'world' ? 'active' : ''}
                    type="button"
                    aria-pressed={transformSpace === 'world'}
                    onClick={() => setTransformSpace('world')}
                    disabled={!selectedItem}
                  >
                    世界坐标
                  </button>
                  <button
                    className={transformSpace === 'local' ? 'active' : ''}
                    type="button"
                    aria-pressed={transformSpace === 'local'}
                    onClick={() => setTransformSpace('local')}
                    disabled={!selectedItem}
                  >
                    物体坐标
                  </button>
                </div>
                <small>{transformSpace === 'world' ? '变换轴始终沿场景方向' : '变换轴会跟随模型旋转方向'}</small>
              </div>

              {selectedItem && selectedPosition && selectedRotation && (
                <div className="model3d-transform-panel">
                  <div className="model3d-transform-group">
                    <span>位置</span>
                    <div>
                      {(['x', 'y', 'z'] as const).map((axis) => (
                        <label key={`position-${axis}`}>
                          <i>{axis.toUpperCase()}</i>
                          <input
                            aria-label={`位置 ${axis.toUpperCase()}`}
                            type="number"
                            step="0.1"
                            value={transformValue(selectedPosition[axis])}
                            onChange={(event) => changeSelectedTransform('position', axis, Number(event.target.value))}
                          />
                        </label>
                      ))}
                    </div>
                  </div>
                  <div className="model3d-transform-group">
                    <span>旋转</span>
                    <div>
                      {(['x', 'y', 'z'] as const).map((axis) => (
                        <label key={`rotation-${axis}`}>
                          <i>{axis.toUpperCase()}</i>
                          <input
                            aria-label={`旋转 ${axis.toUpperCase()}`}
                            type="number"
                            step="1"
                            value={transformValue(THREE.MathUtils.radToDeg(selectedRotation[axis]))}
                            onChange={(event) => changeSelectedTransform('rotation', axis, Number(event.target.value))}
                          />
                        </label>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {selectedItem?.parametricBox && (
                <div className="model3d-parametric-panel">
                  <div className="model3d-parametric-head">
                    <span><Box size={13} /> 礼盒参数</span>
                    <small>单位 mm</small>
                  </div>
                  <div className="model3d-parametric-grid">
                    {([
                      ['length', '长度', 50, 600, 5],
                      ['width', '宽度', 50, 600, 5],
                      ['baseHeight', '盒底高度', 20, 300, 5],
                      ['lidHeight', '盒盖高度', 10, 150, 5],
                      ['thickness', '材料厚度', 1, 20, 1],
                      ['gap', '盒盖间隙', 1, 30, 1],
                    ] as const).map(([key, label, min, max, step]) => (
                      <label key={key}>
                        <span>{label}</span>
                        <input
                          type="number"
                          min={min}
                          max={max}
                          step={step}
                          value={selectedItem.parametricBox!.settings[key]}
                          onFocus={beginParameterEdit}
                          onBlur={endParameterEdit}
                          onChange={(event) => changeParametricBoxSettings({ [key]: Number(event.target.value) }, false)}
                        />
                      </label>
                    ))}
                  </div>
                  <div className="model3d-pose-options" role="group" aria-label="盒盖状态">
                    {([
                      ['closed', '盖合'],
                      ['open', '打开'],
                      ['separated', '分离'],
                    ] as const).map(([pose, label]) => (
                      <button
                        className={selectedItem.parametricBox!.settings.pose === pose ? 'active' : ''}
                        type="button"
                        onClick={() => changeParametricBoxSettings({ pose })}
                        key={pose}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <div className="model3d-parametric-colors">
                    <label>
                      <span>盒底颜色</span>
                      <input type="color" value={selectedItem.parametricBox.settings.baseColor} onChange={(event) => changeParametricBoxSettings({ baseColor: event.target.value })} />
                    </label>
                    <label>
                      <span>盒盖颜色</span>
                      <input type="color" value={selectedItem.parametricBox.settings.lidColor} onChange={(event) => changeParametricBoxSettings({ lidColor: event.target.value })} />
                    </label>
                  </div>
                  <button className="model3d-parametric-split" type="button" onClick={splitParametricBox}>
                    <Layers3 size={13} />
                    拆分盒底与盒盖
                  </button>
                  <small className="model3d-parametric-note">拆分后可分别移动、旋转和改色；Ctrl+Z 可恢复参数礼盒。</small>
                </div>
              )}

              {selectedItem?.parametricPrimitive && (
                <div className="model3d-parametric-panel">
                  <div className="model3d-parametric-head">
                    <span><Box size={13} /> {selectedItem.parametricPrimitive.settings.kind === 'cylinder' ? '圆柱参数' : '方形参数'}</span>
                    <small>单位 mm</small>
                  </div>
                  <div className="model3d-parametric-grid">
                    {(selectedItem.parametricPrimitive.settings.kind === 'cylinder'
                      ? ([['radius', '半径', 10, 300, 5], ['height', '高度', 10, 600, 5]] as const)
                      : ([['length', '长度', 10, 600, 5], ['width', '宽度', 10, 600, 5], ['height', '高度', 10, 600, 5]] as const)
                    ).map(([key, label, min, max, step]) => (
                      <label key={key}>
                        <span>{label}</span>
                        <input
                          type="number"
                          min={min}
                          max={max}
                          step={step}
                          value={selectedItem.parametricPrimitive!.settings[key]}
                          onFocus={beginParameterEdit}
                          onBlur={endParameterEdit}
                          onChange={(event) => changeParametricPrimitiveSettings({ [key]: Number(event.target.value) }, false)}
                        />
                      </label>
                    ))}
                  </div>
                  <div className="model3d-parametric-colors single">
                    <label>
                      <span>模型颜色</span>
                      <input type="color" value={selectedItem.parametricPrimitive.settings.color} onChange={(event) => changeParametricPrimitiveSettings({ color: event.target.value })} />
                    </label>
                  </div>
                </div>
              )}
            </section>

            <section className="model3d-control-section">
              <div className="model3d-section-title">
                <Camera size={15} />
                <strong>相机</strong>
              </div>
              <label className="model3d-field">
                <span>焦距</span>
                <div className="model3d-range-row">
                  <UnifiedRange min={18} max={120} step={1} value={focalLength} onValueChange={setFocalLength} disabled={!hasModel} />
                  <div className="model3d-unit-input">
                    <input type="number" min="18" max="120" value={focalLength} onChange={(event) => setFocalLength(Math.max(18, Math.min(120, Number(event.target.value) || 18)))} disabled={!hasModel} />
                    <span>mm</span>
                  </div>
                </div>
                <small>广角 18 mm，标准 50 mm，长焦 120 mm</small>
              </label>
              <label className="model3d-field">
                <span>相机距离</span>
                <div className="model3d-range-row">
                  <UnifiedRange min={0.2} max={30} step={0.1} value={cameraDistance} onValueChange={changeCameraDistance} disabled={!hasModel} />
                  <div className="model3d-unit-input compact">
                    <input type="number" min="0.2" max="30" step="0.1" value={cameraDistance} onChange={(event) => changeCameraDistance(Number(event.target.value))} disabled={!hasModel} />
                  </div>
                </div>
              </label>
              <div className="model3d-view-buttons" aria-label="相机预设视角">
                <button type="button" onClick={() => setCameraView('front')} disabled={!hasModel}>正视</button>
                <button type="button" onClick={() => setCameraView('side')} disabled={!hasModel}>侧视</button>
                <button type="button" onClick={() => setCameraView('top')} disabled={!hasModel}>俯视</button>
                <button type="button" onClick={resetCameraView} disabled={!hasModel} title="查看全部模型">
                  <RefreshCw size={13} /> 重置
                </button>
              </div>
            </section>

            <section className="model3d-control-section">
              <div className="model3d-section-title">
                <ImagePlus size={15} />
                <strong>外观</strong>
              </div>
              <label className="model3d-color-field">
                <span>选中模型颜色</span>
                <div>
                  <input type="color" value={modelColor} onChange={(event) => changeSelectedColor(event.target.value)} disabled={!selectedItem} />
                  <input type="text" value={modelColor.toUpperCase()} disabled={!selectedItem} onChange={(event) => {
                    if (/^#[0-9a-f]{6}$/i.test(event.target.value)) changeSelectedColor(event.target.value)
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
              {transparentExport && <p className="model3d-sketch-color-note">确认后，当前模型颜色会和角度一起更新到手绘画板的模型图层。</p>}
            </section>

            <section className="model3d-control-section">
              <div className="model3d-section-title">
                <Sun size={15} />
                <strong>光照与投影</strong>
              </div>
              <label className="model3d-projection-toggle">
                <span><strong>开启灯光</strong><small>{lightEnabled ? '场景灯光已开启' : '保留柔和明暗结构，不产生投影'}</small></span>
                <input type="checkbox" checked={lightEnabled} onChange={(event) => setLightEnabled(event.target.checked)} />
                <i aria-hidden="true" />
              </label>
              <label className="model3d-field">
                <span>灯光强度</span>
                <div className="model3d-range-row">
                  <UnifiedRange
                    aria-label="灯光强度"
                    min={10}
                    max={200}
                    step={5}
                    value={lightIntensity}
                    onValueChange={setLightIntensity}
                    disabled={!lightEnabled}
                  />
                  <div className="model3d-unit-input compact">
                    <input
                      aria-label="灯光强度数值"
                      type="number"
                      min="10"
                      max="200"
                      step="5"
                      value={lightIntensity}
                      onChange={(event) => setLightIntensity(Math.max(10, Math.min(200, Number(event.target.value) || 10)))}
                      disabled={!lightEnabled}
                    />
                    <span>%</span>
                  </div>
                </div>
                <small>100% 为默认亮度，可在 10%–200% 之间调整。</small>
              </label>
              <label className="model3d-projection-toggle">
                <span><strong>显示投影</strong><small>{lightEnabled ? '开启后在模型底部显示实时投影' : '纯色预览下不显示投影'}</small></span>
                <input type="checkbox" checked={showProjection} onChange={(event) => setShowProjection(event.target.checked)} disabled={!lightEnabled} />
                <i aria-hidden="true" />
              </label>
              <div className="model3d-light-direction-summary">
                <div className="model3d-light-direction-dial" style={lightDirectionStyle} aria-hidden="true">
                  <span className="model3d-light-direction-arm"><Sun size={13} /></span><i />
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
                  <UnifiedRange aria-label="光照水平角" min={-180} max={180} step={1} value={lightAzimuth} onValueChange={setLightAzimuth} disabled={!lightEnabled} />
                  <div className="model3d-unit-input compact">
                    <input aria-label="光照水平角数值" type="number" min="-180" max="180" value={lightAzimuth} onChange={(event) => setLightAzimuth(Math.max(-180, Math.min(180, Number(event.target.value) || 0)))} disabled={!lightEnabled} /><span>°</span>
                  </div>
                </div>
              </label>
              <label className="model3d-field">
                <span>光照高度</span>
                <div className="model3d-range-row">
                  <UnifiedRange aria-label="光照高度" min={20} max={85} step={1} value={lightElevation} onValueChange={setLightElevation} disabled={!lightEnabled} />
                  <div className="model3d-unit-input compact">
                    <input aria-label="光照高度数值" type="number" min="20" max="85" value={lightElevation} onChange={(event) => setLightElevation(Math.max(20, Math.min(85, Number(event.target.value) || 20)))} disabled={!lightEnabled} /><span>°</span>
                  </div>
                </div>
                <small>降低高度会拉长投影，提高高度会缩短投影。</small>
              </label>
            </section>

            <section className="model3d-control-section">
              <div className="model3d-section-title"><ImagePlus size={15} /><strong>视窗尺寸</strong></div>
              <div className="model3d-size-options">
                {viewportPresets.map((preset) => (
                  <button type="button" className={preset.id === viewportId ? 'active' : ''} disabled={Boolean(exportViewport)} onClick={() => setViewportId(preset.id)} key={preset.id}>
                    <span>{preset.label}</span><small>{preset.width} × {preset.height}</small>{preset.id === viewportId && <Check size={14} />}
                  </button>
                ))}
              </div>
              {exportViewport && <p className="model3d-control-hint">尺寸跟随手绘图层。透明输出不包含画板背景和地面投影。</p>}
            </section>
            {error && <div className="model3d-error" role="alert">{error}</div>}
          </aside>
        </div>

        <footer className="model3d-foot" inert={Boolean(optimizationPreview)}>
          <p>模型：单击选择，W 移动，R 旋转，Delete 删除，Ctrl+Z 撤销。视角：左键旋转，中键平移，滚轮缩放，右键也可平移。</p>
          <div>
            <button className="model3d-secondary-button" type="button" onClick={onClose}>取消</button>
            <button className="model3d-export-button" type="button" onClick={exportCurrentView} disabled={!hasModel || loading || exporting}>
              {exporting ? <Loader2 className="model3d-spinner" size={15} /> : <ImagePlus size={15} />}
              {exporting ? '正在应用' : transparentExport ? '应用角度与颜色到手绘画板' : sceneId ? '更新参考图' : '导出到画板'}
            </button>
          </div>
        </footer>
      </section>
    </div>
  )
}
