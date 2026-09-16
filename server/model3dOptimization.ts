import { createRequire } from 'node:module'
import { NodeIO, PropertyType } from '@gltf-transform/core'
import { KHRDracoMeshCompression } from '@gltf-transform/extensions'
import { dedup, draco, prune, simplify, weld } from '@gltf-transform/functions'
import { MeshoptSimplifier } from 'meshoptimizer'

const require = createRequire(import.meta.url)
const dracoCodec = require('draco3dgltf')
let ioPromise: Promise<NodeIO> | undefined

function getIO() {
  return ioPromise ??= Promise.all([dracoCodec.createEncoderModule(), dracoCodec.createDecoderModule()])
    .then(([encoder, decoder]) => new NodeIO().registerExtensions([KHRDracoMeshCompression]).registerDependencies({
      'draco3d.encoder': encoder, 'draco3d.decoder': decoder,
    }))
}

export async function optimizeModelGLB(input: Uint8Array, ratio = 1) {
  if (![1, 0.75, 0.5].includes(ratio)) throw new Error('不支持的减面档位')
  const header = new DataView(input.buffer, input.byteOffset, input.byteLength)
  if (input.byteLength < 20 || header.getUint32(0, true) !== 0x46546c67 || header.getUint32(4, true) !== 2 || header.getUint32(12, true) + 20 > input.byteLength) throw new Error('不是有效的 GLB 文件')
  const manifest = JSON.parse(new TextDecoder().decode(input.subarray(20, 20 + header.getUint32(12, true))))
  if ([...(manifest.buffers || []), ...(manifest.images || [])].some((resource: { uri?: string }) => resource.uri && !resource.uri.startsWith('data:'))) throw new Error('请使用资源内嵌的 GLB 文件')
  const io = await getIO()
  const document = await io.readBinary(input)
  const triangles = () => document.getRoot().listMeshes().reduce((sum, mesh) => sum + mesh.listPrimitives().reduce((count, primitive) => {
    if (primitive.getMode() !== 4) return count
    return count + (primitive.getIndices()?.getCount() ?? primitive.getAttribute('POSITION')?.getCount() ?? 0) / 3
  }, 0), 0)
  const beforeTriangles = triangles()
  if (!beforeTriangles) throw new Error('模型中没有可优化的三角面')
  // Keep POSITION/NORMAL accessors distinct, even when their arrays happen to match
  // (e.g. a unit sphere); Draco quantizes these attributes differently.
  await document.transform(dedup({ propertyTypes: [PropertyType.MATERIAL, PropertyType.MESH] }), weld())
  if (ratio < 1) {
    await MeshoptSimplifier.ready
    await document.transform(simplify({ simplifier: MeshoptSimplifier, ratio, error: 0.001, lockBorder: true }))
  }
  await document.transform(prune(), draco({ method: 'edgebreaker', encodeSpeed: 5, decodeSpeed: 5, quantizePosition: 16, quantizeNormal: 12 }))
  const afterTriangles = triangles()
  const output = await io.writeBinary(document)
  return { output, beforeTriangles, afterTriangles }
}
