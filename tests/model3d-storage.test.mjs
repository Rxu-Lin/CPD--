import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb'

const compile = (source) => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const storeCode = compile(readFileSync(new URL('../src/model3dSceneStore.ts', import.meta.url), 'utf8'))
const legacyKey = 'cpd-model3d-scene-v1'
const plain = (value) => JSON.parse(JSON.stringify(value))
function storageHarness(indexedDB = new IDBFactory()) {
  const data = new Map()
  let writes = 0
  const window = {
    indexedDB,
    localStorage: {
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => {
        writes += 1
        if (value.length > 5 * 1024 * 1024) throw new DOMException('Quota exceeded', 'QuotaExceededError')
        data.set(key, value)
      },
      removeItem: (key) => data.delete(key),
    },
  }
  const reload = () => {
    const context = vm.createContext({ window, exports: {}, Error, DOMException })
    vm.runInContext(storeCode, context)
    return context.exports
  }
  return { data, window, reload, store: reload(), get writes() { return writes } }
}
const scene = (url = 'data:model/obj;base64,dGVzdA==') => ({
  version: 2, savedAt: '2026-09-12T00:00:00.000Z',
  items: [{ kind: 'imported-model', name: '大模型', color: '#FF0000', source: { fileName: 'model.obj', format: 'OBJ', url }, transform: { position: [1, 2, 3], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] } }],
  selectedIndex: 0, viewportId: 'portrait', backgroundColor: '#FFFFFF', focalLength: 120,
  showProjection: false, lightEnabled: true, lightIntensity: 1, lightAzimuth: -55, lightElevation: 38,
  camera: { position: [4, 5, 6], up: [0, 1, 0], target: [1, 1, 1] },
})
function abortNextPut(t) {
  const original = IDBObjectStore.prototype.put
  t.mock.method(IDBObjectStore.prototype, 'put', function (...args) {
    const request = original.apply(this, args)
    request.addEventListener('success', () => this.transaction.abort())
    return request
  }, { times: 1 })
}

test('8 MiB model saves without localStorage writes and survives a fresh module/session', async () => {
  const h = storageHarness()
  const large = scene(`data:model/obj;base64,${'A'.repeat(8 * 1024 * 1024)}`)
  assert.throws(() => h.window.localStorage.setItem('capacity-check', JSON.stringify(large)), { name: 'QuotaExceededError' })
  const before = h.writes
  await h.store.saveModel3DDraft(large)
  assert.equal(h.writes, before)
  assert.deepEqual(plain(await h.reload().readModel3DDraft()), large)
})

test('request success followed by transaction abort never reports saved or discards the old draft', async (t) => {
  const h = storageHarness()
  const original = scene()
  await h.store.saveModel3DDraft(original)
  h.data.set(legacyKey, JSON.stringify(original))
  abortNextPut(t)
  await assert.rejects(h.store.saveModel3DDraft({ ...original, focalLength: 18 }))
  assert.equal(h.data.has(legacyKey), true)
  assert.deepEqual(plain(await h.reload().readModel3DDraft()), original)
})

test('legacy scene migrates once and the committed IndexedDB copy takes precedence', async () => {
  const h = storageHarness()
  h.data.set(legacyKey, JSON.stringify(scene()))
  assert.deepEqual(plain(await h.store.readModel3DDraft()), scene())
  assert.equal(h.data.has(legacyKey), false)
  h.data.set(legacyKey, JSON.stringify({ ...scene(), focalLength: 18 }))
  assert.equal((await h.reload().readModel3DDraft()).focalLength, 120)
})

test('failed migration preserves a readable legacy copy and explicit saving rejects with a useful error', async () => {
  const reason = new DOMException('Storage is blocked', 'SecurityError')
  const h = storageHarness({ open() { throw reason } })
  h.data.set(legacyKey, JSON.stringify(scene()))
  assert.deepEqual(plain(await h.store.readModel3DDraft()), scene())
  assert.equal(h.data.has(legacyKey), true)
  await assert.rejects(h.store.saveModel3DDraft(scene()), { name: 'SecurityError' })
  assert.match(h.store.model3DStorageErrorMessage(reason), /禁止本地存储/)
  h.data.clear()
  await assert.rejects(h.store.readModel3DDraft(), { name: 'SecurityError' })
  assert.match(h.store.model3DStorageErrorMessage(new DOMException('', 'QuotaExceededError')), /空间不足/)
})

test('unavailable IndexedDB cannot be mistaken for a persistent save', async () => {
  const h = storageHarness()
  delete h.window.indexedDB
  await assert.rejects(h.store.saveModel3DDraft(scene()), /INDEXED_DB_UNAVAILABLE/)
  assert.match(h.store.model3DStorageErrorMessage(new Error('INDEXED_DB_UNAVAILABLE')), /禁止本地存储/)
})

test('reset removes only the draft, preserving canvas scenes', async () => {
  const h = storageHarness()
  await h.store.saveModel3DDraft(scene())
  await h.store.saveModel3DScene('canvas-scene', scene())
  h.data.set(legacyKey, JSON.stringify(scene()))
  await h.store.deleteModel3DDraft()
  const reopened = h.reload()
  assert.equal(await reopened.readModel3DDraft(), null)
  assert.equal(h.data.has(legacyKey), false)
  assert.deepEqual(plain(await reopened.readModel3DScene('canvas-scene')), scene())
})

const componentSource = readFileSync(new URL('../src/Model3DStudio.tsx', import.meta.url), 'utf8')
function componentFunction(name, dependencies) {
  const ast = ts.createSourceFile('Model3DStudio.tsx', componentSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let declaration
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) declaration = node.getText(ast)
    ts.forEachChild(node, visit)
  }
  visit(ast)
  assert.ok(declaration)
  const context = vm.createContext({ Error, ...dependencies })
  vm.runInContext(compile(declaration), context)
  return context[name]
}

test('save button stays pending until commit and reports the real failure on rejection', async () => {
  const statuses = [], errors = []
  let finish
  const deferred = new Promise((resolve) => { finish = resolve })
  const dependencies = {
    loading: false, saveStatus: 'idle', captureSavedScene: scene,
    setSaveStatus: (status) => statuses.push(status), setError: (error) => errors.push(error),
    saveModel3DDraft: () => deferred,
    window: { setTimeout() {} }, model3DStorageErrorMessage: storageHarness().store.model3DStorageErrorMessage,
  }
  const save = componentFunction('saveSceneLocally', dependencies)
  const pending = save()
  assert.deepEqual(statuses, ['saving'])
  finish()
  await pending
  assert.deepEqual(statuses, ['saving', 'saved'])
  const failingSave = componentFunction('saveSceneLocally', { ...dependencies, saveModel3DDraft: async () => { throw new DOMException('', 'QuotaExceededError') } })
  await failingSave()
  assert.equal(statuses.at(-1), 'error')
  assert.match(errors.at(-1), /空间不足/)
})

test('closing or resetting during asynchronous model restoration disposes the stale model', async () => {
  let finish
  const object = { name: 'decoded model' }
  const deferred = new Promise((resolve) => { finish = resolve })
  const sequence = { current: 1 }
  const disposed = []
  const dependencies = {
    loadSequenceRef: sequence, viewportPresets: [], defaultBackgroundColor: '#111820',
    defaultLightIntensity: 1, defaultLightAzimuth: -55, defaultLightElevation: 38,
    parseSavedModelSource: () => deferred,
    addSceneObject() { assert.fail('Cancelled restore must not add a model') },
    disposeModel: (value) => disposed.push(value),
  }
  for (const name of ['setViewportId', 'setBackgroundColor', 'setFocalLength', 'setShowProjection', 'setLightEnabled', 'setLightIntensity', 'setLightAzimuth', 'setLightElevation']) dependencies[name] = () => {}
  const restore = componentFunction('restoreSavedScene', dependencies)
  const pending = restore(scene())
  sequence.current += 1
  finish(object)
  await pending
  assert.deepEqual(disposed, [object])
})
