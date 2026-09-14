import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const code = readFileSync(new URL('../src/canvasMediaClipboard.ts', import.meta.url), 'utf8')
const context = vm.createContext({ exports: {} })
vm.runInContext(ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context)
const { createCanvasMediaClipboard, createDraggedMediaNodes, createPastedMediaNodes, serializeCanvasMediaClipboard, parseCanvasMediaClipboard, mediaDataForCopy } = context.exports
const plain = (value) => JSON.parse(JSON.stringify(value))
const node = (id, kind, values = {}) => ({
  id, type: 'workflow', parentId: 'group', position: { x: 12, y: 24 },
  data: { kind, title: '生成结果', status: 'done', model: 'test-model', size: '1024x1024', ...values },
})

test('image output becomes an independent reference that retains its prompt without generator wiring', () => {
  const original = node('image', 'image', { imageUrl: '/cache/result.png', sourceImageUrl: '/cache/input.png', prompt: 'secret draft', model3DSceneId: 'scene', onGenerate() {} })
  const clipboard = createCanvasMediaClipboard([original])
  original.data.imageUrl = '/cache/regenerated.png'
  const [copy] = createPastedMediaNodes(clipboard, { x: 800, y: 240 }, () => 'new-image', 'now')
  assert.equal(copy.id, 'new-image')
  assert.equal(copy.data.kind, 'reference')
  assert.equal(copy.data.imageUrl, '/cache/result.png')
  assert.equal(copy.data.status, 'done')
  assert.equal(copy.data.model, 'test-model')
  assert.equal(copy.data.prompt, 'secret draft')
  assert.equal(copy.data.generationPrompt, 'secret draft')
  assert.equal(copy.data.createdAt, 'now')
  assert.deepEqual(plain(copy.position), { x: 800, y: 240 })
  for (const key of ['sourceImageUrl', 'onGenerate', 'model3DSceneId', 'sketch']) assert.equal(key in copy.data, false)
  for (const key of ['parentId', 'extent', 'edges', 'measured']) assert.equal(key in copy, false)
  copy.data.imageUrl = '/replacement.png'
  assert.equal(clipboard.items[0].data.imageUrl, '/cache/result.png')
})

test('video output keeps playable media and duration without becoming another generator', () => {
  const clipboard = createCanvasMediaClipboard([node('video', 'video', { videoUrl: 'https://example.com/result.mp4', videoDuration: 5, imageUrl: '/poster.png', generationPrompt: 'move' })])
  const roundTrip = parseCanvasMediaClipboard(serializeCanvasMediaClipboard(clipboard))
  const [copy] = createPastedMediaNodes(roundTrip, { x: 0, y: 0 }, () => 'video-copy', 'now')
  assert.equal(copy.data.kind, 'video-reference')
  assert.equal(copy.data.videoUrl, 'https://example.com/result.mp4')
  assert.equal(copy.data.videoDurationSeconds, 5)
  assert.equal(copy.data.imageUrl, undefined)
  assert.equal(copy.data.prompt, 'move')
  assert.equal(copy.data.generationPrompt, 'move')
  assert.ok(createCanvasMediaClipboard([copy]), 'Pasted media can be copied again')
})

test('mixed selection and repeated pastes create fresh identities while retaining relative layout', () => {
  const image = node('i', 'image', { imageUrl: 'data:image/png;base64,AAAA' })
  const video = { ...node('v', 'video', { videoUrl: '/cache/movie.mp4' }), position: { x: 412, y: 48 } }
  const clipboard = createCanvasMediaClipboard([image, video])
  let id = 0
  const first = createPastedMediaNodes(clipboard, { x: 100, y: 200 }, () => `copy-${++id}`, 'one')
  const second = createPastedMediaNodes(clipboard, { x: 500, y: 600 }, () => `copy-${++id}`, 'two')
  assert.equal(new Set([...first, ...second].map((value) => value.id)).size, 4)
  assert.deepEqual(plain(first.map((value) => value.position)), [{ x: 100, y: 200 }, { x: 500, y: 224 }])
  assert.ok([...first, ...second].every((value) => value.selected))
})

test('Alt-drag copies land at the drag delta while the caller can restore the source nodes', () => {
  const image = node('i', 'image', { imageUrl: '/cache/image.png', prompt: 'still life' })
  const video = { ...node('v', 'video', { videoUrl: '/cache/video.mp4', generationPrompt: 'slow push in' }), position: { x: 412, y: 48 } }
  const clipboard = createCanvasMediaClipboard([image, video])
  let nextId = 0
  const copies = createDraggedMediaNodes(clipboard, { x: 240, y: -80 }, () => `alt-copy-${++nextId}`, 'now')
  assert.deepEqual(plain(copies.map((value) => value.position)), [{ x: 252, y: -56 }, { x: 652, y: -32 }])
  assert.deepEqual(plain(copies.map((value) => value.data.prompt)), ['still life', 'slow push in'])
  assert.ok(copies.every((value) => !value.parentId && value.selected))
})

test('empty, generating and non-media nodes cannot be copied as results', () => {
  assert.equal(createCanvasMediaClipboard([
    node('empty', 'image'), node('busy', 'video', { status: 'generating', videoUrl: '/old.mp4' }),
    node('group', 'group', { imageUrl: '/something.png' }),
  ]), null)
  assert.equal(mediaDataForCopy(node('input-only', 'image', { sourceImageUrl: '/input.png' }).data), null)
})

test('ordinary text and malformed clipboard content remain outside the canvas paste flow', () => {
  for (const value of ['hello', '/image.png', '{"version":1}', 'AI_CANVAS_MEDIA_V1\nnot-json', 'AI_CANVAS_MEDIA_V1\nnull']) {
    assert.equal(parseCanvasMediaClipboard(value), null)
  }
  const clipboard = plain(createCanvasMediaClipboard([node('image', 'image', { imageUrl: '/result.png' })]))
  clipboard.items[0].data.imageUrl = 'javascript:alert(1)'
  assert.equal(parseCanvasMediaClipboard(serializeCanvasMediaClipboard(clipboard)), null)
  clipboard.items[0].data.imageUrl = '/result.png'
  clipboard.items[0].position.x = null
  assert.equal(parseCanvasMediaClipboard(serializeCanvasMediaClipboard(clipboard)), null)
})

test('clipboard round-trip keeps prompt text but strips callbacks and generation settings', () => {
  const clipboard = plain(createCanvasMediaClipboard([node('image', 'image', { imageUrl: '/result.png' })]))
  Object.assign(clipboard.items[0].data, { prompt: 'injected', onGenerate: 'run', status: 'generating', apiMode: 'change2pro' })
  const data = parseCanvasMediaClipboard(serializeCanvasMediaClipboard(clipboard)).items[0].data
  assert.equal(data.prompt, 'injected')
  assert.equal(data.generationPrompt, 'injected')
  for (const key of ['onGenerate', 'status', 'apiMode']) assert.equal(key in data, false)
})
