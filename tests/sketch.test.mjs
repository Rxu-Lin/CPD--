import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const root = new URL('../', import.meta.url)
const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
const sourceOf = path => readFileSync(new URL(path, root), 'utf8')
const plain = value => JSON.parse(JSON.stringify(value))
const moduleContext = vm.createContext({ exports: {}, crypto, Map })
vm.runInContext(compile(sourceOf('src/sketchDocument.ts')), moduleContext)
const sketch = moduleContext.exports

// Run production helpers with explicit test dependencies; no browser, API, or user data.
function functionsFrom(path, names, dependencies = {}) {
  const source = ts.createSourceFile(path, sourceOf(path), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const functions = []
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) functions.push(node.getText(source))
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.equal(functions.length, names.length)
  const context = vm.createContext({ ...dependencies })
  vm.runInContext(compile(functions.join('\n')), context)
  return context
}

test('layer order is immutable, clamped, and survives serialization', () => {
  const doc = sketch.createSketchDocument('test-model', '2K')
  const model = { ...sketch.createSketchLayer('model', 'model'), sceneId: 'scene-1' }
  doc.layers.unshift(model)
  const moved = sketch.moveSketchLayer(doc, model.id, 10)
  assert.equal(doc.layers[0].id, model.id)
  assert.equal(moved.layers.at(-1).id, model.id)
  assert.equal(moved.layers.at(-1).locked, true)
  assert.deepEqual(plain(sketch.sketchSceneIds(moved)), ['scene-1'])
  assert.deepEqual(plain(moved), plain(JSON.parse(JSON.stringify(moved))))
})

test('negative-direction shapes retain correct hit-test bounds', () => {
  const bounds = sketch.sketchElementBounds({ kind: 'rect', x: 100, y: 80, width: -40, height: -25 })
  assert.deepEqual(plain(bounds), { x: 60, y: 55, width: 40, height: 25 })
})

let canvasModule
try { canvasModule = require(process.env.SKETCH_CANVAS_MODULE || '@napi-rs/canvas') } catch { /* optional pixel-test runtime */ }
test('transparent model, foreground/background order, eraser and opacity compose correctly', { skip: !canvasModule && 'Set SKETCH_CANVAS_MODULE to an installed @napi-rs/canvas module for pixel tests' }, async () => {
  const { createCanvas } = canvasModule
  moduleContext.document = { createElement: () => createCanvas(1, 1) }
  const doc = sketch.createSketchDocument('mock', '1K')
  doc.width = doc.height = 100
  const mark = (color, kind = 'pen', x = 10, y = 50, points = [{ x: 0, y: 0 }, { x: 80, y: 0 }]) => ({ id: crypto.randomUUID(), kind, x, y, width: 0, height: 0, points, color, size: 12, opacity: 1 })
  const modelImage = createCanvas(100, 100)
  const ctx = modelImage.getContext('2d')
  ctx.fillStyle = '#2563eb'
  ctx.fillRect(35, 20, 30, 65)
  const model = { ...sketch.createSketchLayer('model', 'model'), imageUrl: 'test-model', width: 100, height: 100 }
  const drawing = { ...doc.layers[0], elements: [mark('#dc2626')] }
  doc.layers = [drawing, model]
  const images = new Map([['test-model', Promise.resolve(modelImage)]])
  const pixel = (canvas, x = 50, y = 50) => [...canvas.getContext('2d').getImageData(x, y, 1, 1).data]
  assert.deepEqual(pixel(await sketch.renderSketch(doc, images)), [37, 99, 235, 255], 'model covers back drawing')
  assert.deepEqual(pixel(await sketch.renderSketch(doc, images), 15, 50), [220, 38, 38, 255], 'transparent surround reveals back drawing')
  doc.layers = [model, drawing]
  assert.deepEqual(pixel(await sketch.renderSketch(doc, images)), [220, 38, 38, 255], 'front drawing covers model')
  drawing.elements.push(mark('#ffffff', 'eraser', 50, 30, [{ x: 0, y: 0 }, { x: 0, y: 40 }]))
  assert.deepEqual(pixel(await sketch.renderSketch(doc, images)), [37, 99, 235, 255], 'eraser reveals but never removes lower model')
  drawing.elements.pop()
  drawing.visible = false
  assert.deepEqual(pixel(await sketch.renderSketch(doc, images)), [37, 99, 235, 255], 'hidden layers excluded')
  drawing.visible = true
  drawing.opacity = 0.5
  const blended = pixel(await sketch.renderSketch(doc, images))
  assert.ok(blended[0] > 120 && blended[0] < 140 && blended[2] > 125 && blended[2] < 145)
  assert.deepEqual(pixel(await sketch.renderSketch(doc, images), 5, 5), [255, 255, 255, 255])
})

test('project export includes nested layer images, 3D sources and editable scene data', async () => {
  const doc = sketch.createSketchDocument('test-model', '2K')
  doc.prompt = '保持构图'
  doc.layers.push({ ...sketch.createSketchLayer('OBJ model', 'model'), sceneId: 'scene-a', imageUrl: '/model-render.png' })
  const scene = { version: 2, camera: { position: [3, 4, 5], target: [0, 0, 0] }, items: [{ kind: 'imported-model', name: 'pyramid', source: { url: '/pyramid.obj', fileName: 'pyramid.obj', format: 'OBJ' }, transform: { position: [1, 2, 3] } }] }
  const context = functionsFrom('src/App.tsx', ['cleanNode', 'cleanEdge', 'buildPackageProject'], {
    sketchSceneIds: sketch.sketchSceneIds,
    addImageToProjectPackage: async (_session, _url, index) => `images/${index}.png`,
    addVideoToProjectPackage: async () => { throw Error('Unexpected video') },
    addModelToProjectPackage: async () => 'models/pyramid.obj',
    readModel3DScenes: async ids => { assert.deepEqual(plain(ids), ['scene-a']); return { 'scene-a': scene } },
  })
  const inputNode = { id: 'ref', type: 'workflow', position: { x: 1, y: 2 }, selected: true, data: { kind: 'reference', imageUrl: '/composite.png', sketch: doc, onEditSketch() {} } }
  const result = await context.buildPackageProject('qa', 'sketch-test', [inputNode], [], [])
  assert.equal(result.nodes[0].data.imageUrl, 'images/1.png')
  assert.equal(result.nodes[0].data.sketch.layers[1].imageUrl, 'images/2.png')
  assert.equal(result.nodes[0].data.sketch.prompt, '保持构图')
  assert.equal(result.nodes[0].data.onEditSketch, undefined)
  assert.equal(result.model3DScenes['scene-a'].items[0].source.url, 'models/pyramid.obj')
  assert.deepEqual(plain(result.model3DScenes['scene-a'].camera), scene.camera)
  assert.equal(doc.layers[1].imageUrl, '/model-render.png', 'live scene not rewritten while packaging')
  assert.equal(scene.items[0].source.url, '/pyramid.obj')

  const importer = functionsFrom('vite.config.ts', ['isJsonRecord', 'transformProjectImageValues', 'transformProjectModelValues'])
  const imported = plain(result)
  await importer.transformProjectImageValues(imported, path => `/cache/qa/${path}`)
  await importer.transformProjectModelValues(imported, path => `/cache/qa/${path}`)
  assert.equal(imported.nodes[0].data.sketch.layers[1].imageUrl, '/cache/qa/images/2.png')
  assert.equal(imported.model3DScenes['scene-a'].items[0].source.url, '/cache/qa/models/pyramid.obj')
  assert.deepEqual(imported.nodes[0].data.sketch.layers[0].elements, [])
})

function generationHarness({ source, failure = false, cacheFailure = false } = {}) {
  let sequence = 0
  const requests = []
  const context = functionsFrom('src/App.tsx', ['saveSketchToCanvas'], {
    nodes: source ? [source] : [], sketchSession: { nodeId: source?.id || null },
    apiConfig: { mode: 'mock', apiKey: '', model: 'mock', imageSize: '1K' },
    cacheCanvasImage: async image => { if (cacheFailure) throw Error('cache unavailable'); return image.startsWith('data:') ? '/cache/image.png' : image },
    id: prefix => `${prefix}-${++sequence}`, sketchGenerationInstruction: sketch.sketchGenerationInstruction,
    flowInstance: null, window: { innerWidth: 1280, innerHeight: 720, setTimeout: callback => callback() },
    getAbsoluteNodePosition: node => node.position,
    findFreeWorkflowNodePosition: position => position,
    MarkerType: { ArrowClosed: 'arrowclosed' }, workflowEdgeColor: '#fff', imageInputHandlePrefix: 'image-',
    setNodes: update => { context.nodes = update(context.nodes) },
    setEdges: update => { context.edges = update(context.edges) },
    setSketchSession: session => { context.sketchSession = session },
    setSelectedNodeId() {}, markDirty() {}, setToast() {}, setIsGenerating() {},
    updateNodeData: (nodeId, patch) => { context.nodes = context.nodes.map(node => node.id === nodeId ? { ...node, data: { ...node.data, ...patch } } : node) },
    setHistory: update => { context.history = update(context.history) },
    requestGeneratedImage: async (...args) => { requests.push(args); if (failure) throw Error('test generation failure'); return '/mock-result.png' },
  })
  context.edges = []
  context.history = []
  return { context, requests }
}
test('generate creates reference/output with its own prompt, uses the composite and records history', async () => {
  const { context, requests } = generationHarness()
  const doc = sketch.createSketchDocument('mock', '1K')
  doc.prompt = '蓝色圆柱与花朵'
  await context.saveSketchToCanvas({ document: doc, imageUrl: 'data:image/png;base64,test' }, true)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(context.nodes.length, 2)
  assert.equal(context.edges.length, 1)
  assert.equal(context.nodes.some(node => node.data.kind === 'prompt'), false)
  assert.equal(context.nodes.find(node => node.data.kind === 'image').data.prompt, requests[0][0])
  assert.equal(context.sketchSession, null)
  assert.equal(context.nodes.find(node => node.data.kind === 'image').data.status, 'done')
  assert.deepEqual(plain(requests[0][2]), ['/cache/image.png'])
  assert.ok(requests[0][0].includes(doc.prompt))
  assert.equal(context.history[0].status, '成功')
})
test('reopening and saving updates the same reference without creating a generation', async () => {
  const doc = sketch.createSketchDocument('mock', '1K')
  const source = { id: 'existing-ref', type: 'workflow', position: { x: 20, y: 30 }, data: { kind: 'reference', sketch: doc, imageUrl: '/old.png' } }
  const { context, requests } = generationHarness({ source })
  await context.saveSketchToCanvas({ document: { ...doc, background: '#112233' }, imageUrl: '/new.png' }, false)
  assert.equal(context.nodes.length, 1)
  assert.equal(context.nodes[0].id, source.id)
  assert.equal(context.nodes[0].data.sketch.background, '#112233')
  assert.equal(requests.length, 0)
  assert.equal(context.history.length, 0)
})
test('failed generation preserves the editable reference and shows an output error', async () => {
  const { context } = generationHarness({ failure: true })
  await context.saveSketchToCanvas({ document: sketch.createSketchDocument('mock', '1K'), imageUrl: '/sketch.png' }, true)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(context.nodes.find(node => node.data.kind === 'image').data.status, 'error')
  assert.ok(context.nodes.find(node => node.data.kind === 'reference').data.sketch)
  assert.equal(context.history[0].status, '失败')
})
test('failed cache never closes the editor or starts a generation', async () => {
  const { context, requests } = generationHarness({ cacheFailure: true })
  await assert.rejects(context.saveSketchToCanvas({ document: sketch.createSketchDocument('mock', '1K'), imageUrl: '/sketch.png' }, true), /cache unavailable/)
  assert.equal(context.nodes.length, 0)
  assert.ok(context.sketchSession)
  assert.equal(requests.length, 0)
})

test('local server packages and imports a real ZIP containing all sketch and OBJ assets', { skip: !(process.env.SKETCH_TEST_API && canvasModule), timeout: 20000 }, async () => {
  const base = new URL(process.env.SKETCH_TEST_API)
  assert.ok(['localhost', '127.0.0.1'].includes(base.hostname), 'Integration test only runs against a local server')
  const localFetch = (url, options) => fetch(new URL(url, base), options)
  const doc = sketch.createSketchDocument('local-simulated', '1K')
  const modelImage = canvasModule.createCanvas(1024, 1024)
  const ctx = modelImage.getContext('2d')
  ctx.fillStyle = '#bcc7d6'
  ctx.beginPath(); ctx.moveTo(512, 260); ctx.lineTo(300, 730); ctx.lineTo(720, 730); ctx.closePath(); ctx.fill()
  const model = { ...sketch.createSketchLayer('测试 OBJ', 'model'), sceneId: 'sketch-qa-scene', imageUrl: modelImage.toDataURL('image/png') }
  doc.layers.unshift(model)
  doc.layers[1].elements.push({ id: 'test-stroke', kind: 'pen', x: 200, y: 512, points: [{ x: 0, y: 0 }, { x: 624, y: 0 }], color: '#dc2626', size: 35, opacity: 1, width: 0, height: 0 })
  doc.prompt = '保持模型角度，将红色草稿线条生成丝带。'
  const objBytes = readFileSync(new URL('tests/fixtures/sketch-pyramid.obj', root))
  const scene = { version: 2, savedAt: new Date().toISOString(), selectedIndex: 0, viewportId: 'square', backgroundColor: '#111820', focalLength: 50, showProjection: false, lightEnabled: true, lightIntensity: 1, lightAzimuth: -55, lightElevation: 38,
    camera: { position: [5.6, 3.5, 6.4], up: [0, 1, 0], target: [0, 1, 0] },
    items: [{ kind: 'imported-model', name: 'sketch-pyramid.obj', color: '#bcc7d6', transform: { position: [0, 0, 0], quaternion: [0, 0.3007057995, 0, 0.9537169507], scale: [1, 1, 1] }, source: { fileName: 'sketch-pyramid.obj', format: 'OBJ', url: `data:application/octet-stream;base64,${objBytes.toString('base64')}` } }] }
  const context = functionsFrom('src/App.tsx', ['readPackageResponse', 'startProjectPackage', 'addImageToProjectPackage', 'addVideoToProjectPackage', 'addModelToProjectPackage', 'cleanNode', 'cleanEdge', 'buildPackageProject'], {
    fetch: localFetch, sketchSceneIds: sketch.sketchSceneIds, readModel3DScenes: async () => ({ 'sketch-qa-scene': scene }),
  })
  moduleContext.document = { createElement: () => canvasModule.createCanvas(1, 1) }
  const composite = await sketch.renderSketch(doc, new Map([[model.imageUrl, Promise.resolve(modelImage)]]))
  const sessionId = await context.startProjectPackage()
  const project = await context.buildPackageProject(sessionId, '手绘图层回归测试', [{ id: 'sketch-qa-ref', type: 'workflow', position: { x: 0, y: 0 }, data: { kind: 'reference', title: '手绘回归测试', status: 'done', size: '1024x1024', imageUrl: composite.toDataURL('image/png'), sketch: doc } }], [], [])
  const zipResponse = await localFetch(`/api/projects/package/finish?sessionId=${sessionId}&filename=sketch-qa.zip&download=1`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(project) })
  assert.equal(zipResponse.status, 200, await (zipResponse.status === 200 ? Promise.resolve('') : zipResponse.text()))
  assert.match(zipResponse.headers.get('content-type'), /application\/zip/)
  const zip = Buffer.from(await zipResponse.arrayBuffer())
  const archive = await require('unzipper').Open.buffer(zip)
  assert.ok(archive.files.some(file => file.path.endsWith('.obj')))
  assert.equal(archive.files.filter(file => file.path.endsWith('.png')).length, 2)
  const importedResponse = await localFetch('/api/projects/import-package', { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: zip })
  const payload = await importedResponse.json()
  assert.equal(importedResponse.status, 200, payload.error)
  const imported = payload.project
  assert.equal(imported.nodes[0].data.sketch.layers[1].elements[0].id, 'test-stroke')
  assert.deepEqual(imported.model3DScenes['sketch-qa-scene'].camera, scene.camera)
  for (const asset of [imported.nodes[0].data.imageUrl, imported.nodes[0].data.sketch.layers[0].imageUrl]) {
    assert.match(asset, /^\/api\/projects\/assets\//)
    const response = await localFetch(asset)
    assert.equal(response.status, 200)
    assert.ok((await response.arrayBuffer()).byteLength > 100)
  }
  const restoredModel = await localFetch(imported.model3DScenes['sketch-qa-scene'].items[0].source.url)
  assert.equal(await restoredModel.text(), objBytes.toString('utf8'))
  const outputDirectory = await mkdtemp(path.join(tmpdir(), 'sketch-qa-'))
  const archivePath = path.join(outputDirectory, 'sketch-qa.aicanvas.zip')
  await writeFile(archivePath, zip)
  console.log(`Round-trip QA archive: ${archivePath}`)
})
