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
const draftSceneId = 'cpd-model3d-scene-v1'
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
    let transaction: IDBTransaction | undefined
    try {
      transaction = database.transaction(storeName, mode)
      const activeTransaction = transaction
      let request: IDBRequest<T>
      let requestError: DOMException | null = null
      // A successful request can still be rolled back. Only report success after commit.
      transaction.oncomplete = () => {
        database.close()
        resolve(request.result)
      }
      transaction.onabort = () => {
        database.close()
        reject(requestError || activeTransaction.error || new Error('3D 场景保存事务已中止，请重试。'))
      }
      request = run(transaction.objectStore(storeName))
      request.onerror = () => { requestError = request.error }
    } catch (reason) {
      transaction?.abort()
      database.close()
      reject(reason)
    }
  })
}

export function model3DStorageErrorMessage(reason: unknown) {
  const name = reason && typeof reason === 'object' && 'name' in reason ? reason.name : ''
  if (name === 'QuotaExceededError') return '浏览器存储空间不足，3D 场景未保存。请释放磁盘空间后重试，或先导出到画板并保存项目包。'
  if (name === 'SecurityError' || name === 'NotAllowedError' || (reason instanceof Error && reason.message === 'INDEXED_DB_UNAVAILABLE')) {
    return '浏览器禁止本地存储，3D 场景未保存。请允许此网站存储数据后重试。'
  }
  return `3D 场景存储失败：${reason instanceof Error ? reason.message : '请重试。'}`
}

function readLegacyDraft(): SavedModel3DScene | null {
  try {
    const raw = window.localStorage.getItem(draftSceneId)
    if (!raw) return null
    const scene = JSON.parse(raw) as SavedModel3DScene
    return (scene?.version === 1 || scene?.version === 2) && Array.isArray(scene.items) ? scene : null
  } catch {
    return null
  }
}

export async function saveModel3DDraft(scene: SavedModel3DScene) {
  // Explicit saves must be durable; the regular scene store's memory fallback is insufficient.
  await withSceneStore('readwrite', (store) => store.put(scene, draftSceneId))
  try {
    window.localStorage.removeItem(draftSceneId)
  } catch {
    // The IndexedDB copy is already committed and takes precedence over the legacy copy.
  }
}

export async function readModel3DDraft(): Promise<SavedModel3DScene | null> {
  let storageError: unknown
  try {
    const scene = await withSceneStore<SavedModel3DScene | undefined>('readonly', (store) => store.get(draftSceneId))
    if (scene) return scene
  } catch (reason) {
    storageError = reason
  }
  const legacy = readLegacyDraft()
  if (legacy) {
    try {
      await saveModel3DDraft(legacy)
    } catch {
      // Keep the original copy and allow editing even when migration cannot be persisted.
    }
    return legacy
  }
  if (storageError) throw storageError
  return null
}

export async function deleteModel3DDraft() {
  await withSceneStore('readwrite', (store) => store.delete(draftSceneId))
  window.localStorage.removeItem(draftSceneId)
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
