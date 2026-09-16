import * as THREE from 'three'
import type { SavedModel3DSource } from './model3dSceneStore'

export function formatModelBytes(bytes?: number) {
  if (bytes === undefined) return '未统计'
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

async function modelResponse(response: Response) {
  const result = await response.json()
  if (!response.ok || !result.url) throw new Error(result.error || '模型资源保存失败')
  return result as { url: string; byteLength: number; beforeTriangles?: number; afterTriangles?: number }
}

export async function cacheModelFile(blob: Blob, fileName: string, format: SavedModel3DSource['format']): Promise<SavedModel3DSource> {
  const asset = await modelResponse(await fetch(`/api/model3d/assets?format=${format.toLowerCase()}`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: blob,
  }))
  return { fileName, format, url: asset.url, byteLength: asset.byteLength }
}

export async function persistModelSource(source: SavedModel3DSource): Promise<SavedModel3DSource> {
  if (!source.url.startsWith('data:') && !source.url.startsWith('blob:')) return source
  const response = await fetch(source.url)
  if (!response.ok) throw new Error('模型资源读取失败')
  return { ...source, ...await cacheModelFile(await response.blob(), source.fileName, source.format) }
}

export async function parseModelBuffer(buffer: ArrayBuffer, format: SavedModel3DSource['format']) {
  if (format === 'OBJ') {
    const { OBJLoader } = await import('three/addons/loaders/OBJLoader.js')
    return new OBJLoader().parse(new TextDecoder().decode(buffer))
  }
  if (format === 'FBX') {
    const { FBXLoader } = await import('three/addons/loaders/FBXLoader.js')
    return new FBXLoader().parse(buffer, '')
  }
  const [{ GLTFLoader }, { DRACOLoader }, { MeshoptDecoder }] = await Promise.all([
    import('three/addons/loaders/GLTFLoader.js'), import('three/addons/loaders/DRACOLoader.js'), import('meshoptimizer'),
  ])
  const decoder = new DRACOLoader().setDecoderPath('/api/model3d/draco/').setWorkerLimit(2)
  try {
    const result = await new GLTFLoader().setDRACOLoader(decoder).setMeshoptDecoder(MeshoptDecoder).parseAsync(buffer, '')
    return result.scene
  } finally { decoder.dispose() }
}

// Bake the current pose into the root's local coordinates. The scene transform and
// material remain separate, so applying/reopening the optimized asset cannot move it.
export function createStaticModelSnapshot(root: THREE.Object3D) {
  root.updateWorldMatrix(true, true)
  const inverse = root.matrixWorld.clone().invert()
  const snapshot = new THREE.Group()
  const material = new THREE.MeshStandardMaterial({ color: '#b8c7d6' })
  let materialInitialized = false
  root.traverseVisible((child) => {
    const mesh = child as THREE.Mesh
    if (!mesh.isMesh || !mesh.geometry.getAttribute('position')) return
    if (!materialInitialized) {
      const current = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial
      if (current.color) material.color.copy(current.color)
      material.side = current.side
      material.roughness = current.roughness ?? 0.58
      material.metalness = current.metalness ?? 0.08
      materialInitialized = true
    }
    const base = mesh.geometry.clone()
    const matrix = inverse.clone().multiply(mesh.matrixWorld)
    if ((mesh as THREE.SkinnedMesh).isSkinnedMesh || mesh.morphTargetInfluences?.some(Boolean)) {
      if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) (mesh as THREE.SkinnedMesh).skeleton.update()
      const position = base.getAttribute('position')
      const baked = new Float32Array(position.count * 3)
      const vertex = new THREE.Vector3()
      for (let index = 0; index < position.count; index++) mesh.getVertexPosition(index, vertex).toArray(baked, index * 3)
      base.setAttribute('position', new THREE.BufferAttribute(baked, 3))
      base.computeVertexNormals()
    }
    for (const attribute of Object.keys(base.attributes)) if (!['position', 'normal'].includes(attribute)) base.deleteAttribute(attribute)
    base.morphAttributes = {}
    base.clearGroups()
    const instanced = mesh as THREE.InstancedMesh
    const count = instanced.isInstancedMesh ? instanced.count : 1
    for (let index = 0; index < count; index++) {
      const geometry = base.clone()
      const transform = matrix.clone()
      if (instanced.isInstancedMesh) {
        const instanceMatrix = new THREE.Matrix4()
        instanced.getMatrixAt(index, instanceMatrix)
        transform.multiply(instanceMatrix)
      }
      geometry.applyMatrix4(transform)
      // Baked negative scales must retain face winding after the transform is removed.
      if (transform.determinant() < 0) {
        if (!geometry.index) geometry.setIndex(Array.from({ length: geometry.getAttribute('position').count }, (_, i) => i))
        const indices = geometry.index!
        for (let i = 0; i + 2 < indices.count; i += 3) {
          const second = indices.getX(i + 1)
          indices.setX(i + 1, indices.getX(i + 2))
          indices.setX(i + 2, second)
        }
      }
      const copy = new THREE.Mesh(geometry, material)
      copy.name = mesh.name
      snapshot.add(copy)
    }
    base.dispose()
  })
  return snapshot
}

export function disposeStaticSnapshot(snapshot: THREE.Object3D) {
  const materials = new Set<THREE.Material>()
  snapshot.traverse((child) => {
    const mesh = child as THREE.Mesh
    if (!mesh.isMesh) return
    mesh.geometry.dispose()
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) materials.add(material)
  })
  materials.forEach((material) => material.dispose())
}

export async function optimizeModelSnapshot(snapshot: THREE.Object3D, source: SavedModel3DSource, ratio: number) {
  const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js')
  const glb = await new GLTFExporter().parseAsync(snapshot, { binary: true, onlyVisible: true })
  if (!(glb instanceof ArrayBuffer)) throw new Error('GLB 导出失败')
  const result = await modelResponse(await fetch(`/api/model3d/optimize?ratio=${ratio}`, {
    method: 'POST', headers: { 'Content-Type': 'model/gltf-binary' }, body: glb,
  }))
  return {
    fileName: source.fileName.replace(/\.[^.]+$/, '') + '-optimized.glb', format: 'GLB', url: result.url,
    byteLength: result.byteLength, localCoordinates: true,
    optimization: { originalBytes: source.byteLength ?? glb.byteLength, originalTriangles: result.beforeTriangles ?? 0,
      triangles: result.afterTriangles ?? 0, originalLoadMs: source.loadMs, ratio },
  } satisfies SavedModel3DSource
}
