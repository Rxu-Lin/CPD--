import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import * as THREE from 'three'
import { Document, NodeIO } from '@gltf-transform/core'
import { KHRDracoMeshCompression } from '@gltf-transform/extensions'
import dracoCodec from 'draco3dgltf'
import { optimizeModelGLB } from '../server/model3dOptimization.ts'
import { cacheModelAsset } from '../server/model3dPlugin.ts'
import { createStaticModelSnapshot, disposeStaticSnapshot } from '../src/model3dAssets.ts'

async function sphereGLB() {
  const geometry = new THREE.SphereGeometry(1, 64, 48)
  const document = new Document()
  const buffer = document.createBuffer()
  const primitive = document.createPrimitive()
  for (const [name, attribute] of [['POSITION', 'position'], ['NORMAL', 'normal']]) {
    primitive.setAttribute(name, document.createAccessor().setType('VEC3').setArray(geometry.attributes[attribute].array).setBuffer(buffer))
  }
  primitive.setIndices(document.createAccessor().setType('SCALAR').setArray(geometry.index.array).setBuffer(buffer))
  document.createScene().addChild(document.createNode().setMesh(document.createMesh().addPrimitive(primitive)))
  geometry.dispose()
  return new NodeIO().writeBinary(document)
}

test('Draco round-trip reduces bytes, preserves face count and bounds; optional simplification reduces faces', async () => {
  const input = await sphereGLB()
  const compressed = await optimizeModelGLB(input)
  assert.equal(compressed.beforeTriangles, compressed.afterTriangles)
  assert.ok(compressed.output.byteLength < input.byteLength / 2)
  const io = new NodeIO().registerExtensions([KHRDracoMeshCompression]).registerDependencies({ 'draco3d.decoder': await dracoCodec.createDecoderModule() })
  const restored = await io.readBinary(compressed.output)
  const position = restored.getRoot().listMeshes()[0].listPrimitives()[0].getAttribute('POSITION')
  assert.ok(position.getMin([]).every((v) => Math.abs(v + 1) < 0.001))
  assert.ok(position.getMax([]).every((v) => Math.abs(v - 1) < 0.001))
  const simplified = await optimizeModelGLB(input, 0.5)
  assert.ok(simplified.afterTriangles > 0 && simplified.afterTriangles < simplified.beforeTriangles)
  await assert.rejects(optimizeModelGLB(input, 0), /减面/)
  await assert.rejects(optimizeModelGLB(new Uint8Array([1, 2, 3])), /GLB/)
})

test('binary assets share a stable content address and survive a new read without Base64', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'model3d-assets-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const input = await sphereGLB()
  const [first, second] = await Promise.all([cacheModelAsset(input, 'glb', root), cacheModelAsset(input, 'glb', root)])
  assert.deepEqual(first, second)
  assert.ok(!first.url.includes('base64'))
  const relative = first.url.replace('/api/projects/assets/', '')
  assert.deepEqual(await readFile(path.join(root, relative)), Buffer.from(input))
  assert.equal((await readdir(path.dirname(path.join(root, relative)))).length, 1)
  await assert.rejects(cacheModelAsset(input, '../../bad', root), /仅支持/)
})

test('static optimization snapshot preserves root-local bounds, mirrored winding, and every instance', () => {
  const root = new THREE.Group()
  root.position.set(10, 20, 30)
  root.rotation.y = 0.7
  root.scale.setScalar(2)
  const instances = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial(), 2)
  instances.setMatrixAt(0, new THREE.Matrix4().makeTranslation(-2, 0, 0))
  instances.setMatrixAt(1, new THREE.Matrix4().makeTranslation(2, 0, 0))
  instances.scale.x = -1
  root.add(instances)
  const snapshot = createStaticModelSnapshot(root)
  assert.equal(snapshot.children.length, 2)
  const bounds = new THREE.Box3().setFromObject(snapshot)
  assert.ok(Math.abs(bounds.min.x + 2.5) < 0.0001)
  assert.ok(Math.abs(bounds.max.x - 2.5) < 0.0001)
  assert.deepEqual(root.position.toArray(), [10, 20, 30])
  for (const mesh of snapshot.children) {
    const index = mesh.geometry.index
    const pos = mesh.geometry.attributes.position
    const normals = mesh.geometry.attributes.normal
    const a = new THREE.Vector3().fromBufferAttribute(pos, index.getX(0))
    const b = new THREE.Vector3().fromBufferAttribute(pos, index.getX(1))
    const c = new THREE.Vector3().fromBufferAttribute(pos, index.getX(2))
    const normal = new THREE.Vector3().fromBufferAttribute(normals, index.getX(0))
    assert.ok(b.sub(a).cross(c.sub(a)).dot(normal) > 0)
  }
  disposeStaticSnapshot(snapshot)
  instances.geometry.dispose()
  instances.material.dispose()
})

const api = process.env.MODEL3D_TEST_API
test('GLB binary API, Draco decoder and ZIP project round-trip preserve scene transforms and model bytes', { skip: !api, timeout: 30000 }, async () => {
  const input = await sphereGLB()
  const upload = await fetch(`${api}/api/model3d/assets?format=glb`, { method: 'POST', body: input })
  assert.equal(upload.status, 200)
  const asset = await upload.json()
  const assetResponse = await fetch(`${api}${asset.url}`)
  assert.match(assetResponse.headers.get('content-type'), /gltf-binary/)
  assert.deepEqual(Buffer.from(await assetResponse.arrayBuffer()), Buffer.from(input))
  const compression = await fetch(`${api}/api/model3d/optimize?ratio=1`, { method: 'POST', body: input })
  assert.equal(compression.status, 200)
  const result = await compression.json()
  assert.ok(result.byteLength < input.byteLength)
  assert.equal((await fetch(`${api}/api/model3d/draco/draco_decoder.wasm`)).status, 200)
  const start = await fetch(`${api}/api/projects/package/start`, { method: 'POST' }).then((r) => r.json())
  assert.ok(start.sessionId)
  const model = await fetch(`${api}/api/projects/package/add-model`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: start.sessionId, sourceUrl: result.url, fileName: 'model.glb', index: 1 }) }).then((r) => r.json())
  assert.ok(model.relativePath)
  const transform = { position: [1, 2, 3], quaternion: [0, 0, 0, 1], scale: [2, 2, 2] }
  const project = { nodes: [], edges: [], model3DScenes: { test: { version: 2, items: [{ kind: 'imported-model', color: '#ff0000', transform, source: { fileName: 'model.glb', format: 'GLB', url: model.relativePath, localCoordinates: true } }] } } }
  const zip = await fetch(`${api}/api/projects/package/finish?sessionId=${start.sessionId}&filename=model3d-test.zip&download=1`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(project) })
  assert.equal(zip.status, 200)
  const imported = await fetch(`${api}/api/projects/import-package`, { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: await zip.arrayBuffer() }).then((r) => r.json())
  const item = imported.project.model3DScenes.test.items[0]
  assert.deepEqual(item.transform, transform)
  assert.equal(item.color, '#ff0000')
  assert.equal(item.source.localCoordinates, true)
  const bytes = await fetch(`${api}${item.source.url}`).then((r) => r.arrayBuffer())
  assert.equal(bytes.byteLength, result.byteLength)
})
