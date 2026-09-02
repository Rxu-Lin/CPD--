export type ParametricBoxPose = 'closed' | 'open' | 'separated'

export type ParametricBoxSettings = {
  length: number
  width: number
  baseHeight: number
  lidHeight: number
  thickness: number
  gap: number
  pose: ParametricBoxPose
  baseColor: string
  lidColor: string
}

export type ParametricPrimitiveKind = 'cylinder' | 'cuboid'

export type ParametricPrimitiveSettings = {
  kind: ParametricPrimitiveKind
  radius: number
  height: number
  length: number
  width: number
  color: string
}

export type SavedTransform = {
  position: [number, number, number]
  quaternion: [number, number, number, number]
  scale: [number, number, number]
}

export type SavedModel3DSource = {
  fileName: string
  format: 'OBJ' | 'FBX'
  url: string
}

export type SavedModel3DItem = {
  kind: 'parametric-box' | 'parametric-part' | 'parametric-primitive' | 'imported-model'
  name: string
  transform: SavedTransform
  settings?: ParametricBoxSettings
  primitiveSettings?: ParametricPrimitiveSettings
  part?: 'base' | 'lid'
  color?: string
  source?: SavedModel3DSource
}

export type SavedModel3DScene = {
  version: 1 | 2
  savedAt: string
  items: SavedModel3DItem[]
  selectedIndex: number
  viewportId: string
  backgroundColor: string
  focalLength: number
  showProjection: boolean
  lightEnabled: boolean
  lightIntensity: number
  lightAzimuth: number
  lightElevation: number
  camera: {
    position: [number, number, number]
    up: [number, number, number]
    target: [number, number, number]
  }
}

const databaseName = 'cpd-model3d-scenes'
const storeName = 'scenes'
const databaseVersion = 1
const memoryFallback = new Map<string, SavedModel3DScene>()

function openSceneDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('INDEXED_DB_UNAVAILABLE'))
      return
    }
    const request = window.indexedDB.open(databaseName, databaseVersion)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(storeName)) database.createObjectStore(storeName)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('无法打开 3D 场景数据库'))
  })
}

async function withSceneStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
) {
  const database = await openSceneDatabase()
  return new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(storeName, mode)
    const request = run(transaction.objectStore(storeName))
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('3D 场景数据库操作失败'))
    transaction.oncomplete = () => database.close()
    transaction.onerror = () => {
      database.close()
      reject(transaction.error || new Error('3D 场景数据库事务失败'))
    }
  })
}

export async function saveModel3DScene(sceneId: string, scene: SavedModel3DScene) {
  memoryFallback.set(sceneId, scene)
  try {
    await withSceneStore('readwrite', (store) => store.put(scene, sceneId))
  } catch {
    // The in-memory copy keeps the current editing session usable when storage is unavailable.
  }
}

export async function readModel3DScene(sceneId: string) {
  try {
    const scene = await withSceneStore<SavedModel3DScene | undefined>('readonly', (store) => store.get(sceneId))
    if (scene) memoryFallback.set(sceneId, scene)
    return scene || memoryFallback.get(sceneId) || null
  } catch {
    return memoryFallback.get(sceneId) || null
  }
}

export async function deleteModel3DScene(sceneId: string) {
  memoryFallback.delete(sceneId)
  try {
    await withSceneStore('readwrite', (store) => store.delete(sceneId))
  } catch {
    // Deleting stale scene data is best effort.
  }
}

export async function saveModel3DScenes(scenes: Record<string, SavedModel3DScene>) {
  await Promise.all(Object.entries(scenes).map(([sceneId, scene]) => saveModel3DScene(sceneId, scene)))
}

export async function readModel3DScenes(sceneIds: string[]) {
  const entries = await Promise.all(
    [...new Set(sceneIds)].map(async (sceneId) => [sceneId, await readModel3DScene(sceneId)] as const),
  )
  return Object.fromEntries(entries.filter((entry): entry is readonly [string, SavedModel3DScene] => Boolean(entry[1])))
}
