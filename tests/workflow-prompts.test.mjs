import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import ts from 'typescript'

const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const require = createRequire(import.meta.url)
const compile = (value) => ts.transpileModule(value, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
const promptModule = vm.createContext({ exports: {} })
vm.runInContext(compile(readFileSync(new URL('../src/workflowPrompts.ts', import.meta.url), 'utf8')), promptModule)
const { migrateLegacyPromptNodes, generationPromptText } = promptModule.exports
const mediaModule = vm.createContext({ exports: {} })
vm.runInContext(compile(readFileSync(new URL('../src/canvasMediaClipboard.ts', import.meta.url), 'utf8')), mediaModule)
const plain = (value) => JSON.parse(JSON.stringify(value))
const node = (id, kind, data = {}) => ({ id, type: 'workflow', position: { x: 10, y: 20 }, data: { kind, status: 'idle', ...data } })
const edge = (id, source, target, targetHandle) => ({ id, source, target, targetHandle, sourceHandle: 'output' })

function helpers(names, dependencies = {}) {
  const ast = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const functions = []
  function visit(value) {
    if (ts.isFunctionDeclaration(value) && names.includes(value.name?.text)) functions.push(value.getText(ast))
    ts.forEachChild(value, visit)
  }
  visit(ast)
  assert.equal(functions.length, names.length)
  const context = vm.createContext({ require, exports: {}, generationPromptText, ...dependencies })
  vm.runInContext(compile(functions.join('\n')), context)
  return context
}

test('shared legacy prompt migrates into image and video without changing saved source data', () => {
  const mention = { token: '@Image1', nodeId: 'ref', kind: 'image', label: '产品' }
  const nodes = [node('p', 'prompt', { prompt: '润色 @Image1', promptMentions: [mention] }), node('i', 'image'), node('v', 'video'), node('ref', 'reference')]
  const edges = [edge('pi', 'p', 'i', 'prompt'), edge('pv', 'p', 'v', 'prompt'), edge('ri', 'ref', 'i', 'image-1')]
  const before = JSON.stringify({ nodes, edges })
  const result = migrateLegacyPromptNodes(nodes, edges)
  assert.deepEqual(plain(result.nodes.map(value => value.id)), ['i', 'v', 'ref'])
  for (const id of ['i', 'v']) {
    const data = result.nodes.find(value => value.id === id).data
    assert.equal(data.prompt, '润色 @Image1')
    assert.deepEqual(plain(data.promptMentions), [mention])
  }
  assert.deepEqual(plain(result.edges), [edges[2]])
  assert.equal(JSON.stringify({ nodes, edges }), before)
  const restored = plain(result)
  const again = migrateLegacyPromptNodes(restored.nodes, restored.edges)
  assert.equal(again.nodes, restored.nodes)
  assert.equal(again.edges, restored.edges)
})

test('unconnected drafts become image nodes and inherited reference links survive migration', () => {
  const nodes = [node('draft', 'prompt', { prompt: '未使用草稿' }), node('p', 'prompt', { prompt: '主体' }), node('i', 'image', { prompt: '额外要求' }), node('ref', 'reference')]
  const edges = [edge('rp', 'ref', 'p', 'image'), edge('pi', 'p', 'i', 'prompt')]
  const result = migrateLegacyPromptNodes(nodes, edges)
  const draft = result.nodes.find(value => value.id === 'draft')
  assert.equal(draft.data.kind, 'image')
  assert.equal(draft.data.prompt, '未使用草稿')
  assert.deepEqual(plain(draft.position), { x: 10, y: 20 })
  assert.equal(result.nodes.find(value => value.id === 'i').data.prompt, '主体\n\n额外要求')
  assert.equal(result.edges.length, 1)
  assert.equal(result.edges[0].source, 'ref')
  assert.equal(result.edges[0].target, 'i')
  assert.equal(result.edges[0].targetHandle, 'image-1')
})

test('previous hidden generation text becomes editable and clearing it stays empty', () => {
  const old = [node('i', 'image', { prompt: '', generationPrompt: '旧灯光提示词' })]
  const result = migrateLegacyPromptNodes(old, [])
  assert.equal(result.nodes[0].data.prompt, '旧灯光提示词')
  const cleared = [{ ...result.nodes[0], data: { ...result.nodes[0].data, prompt: '', generationPrompt: '' } }]
  assert.equal(migrateLegacyPromptNodes(cleared, []).nodes, cleared)
  assert.equal(generationPromptText({ prompt: '', generationPrompt: 'previous' }), '')
})

const inputHelpers = ['imageInputHandleIndex', 'isImageInputHandle', 'videoInputHandleIndex', 'isVideoInputHandle', 'promptMentionOptionsForNode', 'promptContainsMentionToken', 'activePromptMentions', 'compilePromptMentions', 'promptWithReferenceImageOrder', 'promptWithReferenceVideoOrder']
const inputDependencies = { imageInputHandlePrefix: 'image-', videoInputHandlePrefix: 'video-' }

test('@ references belong to the current generation node and follow port order', () => {
  const context = helpers(inputHelpers, inputDependencies)
  const nodes = [node('i', 'image'), node('v', 'video'), node('a', 'reference', { imageUrl: '/a.png' }), node('b', 'reference', { imageUrl: '/b.png' }), node('clip', 'video-reference', { videoUrl: '/clip.mp4' })]
  const edges = [edge('bi', 'b', 'i', 'image-2'), edge('ai', 'a', 'i', 'image-1'), edge('cv', 'clip', 'v', 'video-1')]
  assert.deepEqual(plain(context.promptMentionOptionsForNode('i', nodes, edges).map(value => [value.token, value.nodeId])), [['@Image1', 'a'], ['@Image2', 'b']])
  assert.deepEqual(plain(context.promptMentionOptionsForNode('v', nodes, edges).map(value => [value.token, value.nodeId])), [['@Video1', 'clip']])
})

function generationHarness(kind, prompt) {
  const requests = []
  const context = helpers([...inputHelpers, 'generateImageInNode', 'generateVideoInNode'], {
    ...inputDependencies,
    nodes: [node('output', kind, { prompt, size: '1024x1024' })], edges: [], history: [],
    apiConfig: { mode: kind === 'video' ? 'apimart' : 'mock', model: 'mock-image', videoModel: 'test-video', imageSize: '1K', size: '1024x1024' },
    defaultApiConfig: { size: '1024x1024' },
    findApiMartVideoModel: () => ({ id: 'test-video', label: 'Video', resolutions: ['720p'], defaultResolution: '720p', minDuration: 1, maxDuration: 10, defaultDuration: 5, maxReferenceVideos: 2 }),
    normalizeLightDirection: () => ({ enabled: false }), promptWithLightDirection: value => value,
    setToast: message => { context.toast = message }, setIsGenerating() {},
    updateNodeData: (id, patch) => { context.nodes = context.nodes.map(value => value.id === id ? { ...value, data: { ...value.data, ...patch } } : value) },
    setHistory: update => { context.history = update(context.history) },
    requestGeneratedImage: async (...args) => { requests.push(args); return '/result.png' },
    requestGeneratedVideo: async (...args) => { requests.push(args); return '/result.mp4' },
  })
  return { context, requests }
}

for (const kind of ['image', 'video']) {
  test(`${kind} generation reads its attached prompt without any prompt edge`, async () => {
    const { context, requests } = generationHarness(kind, '生成一片森林')
    await context[kind === 'image' ? 'generateImageInNode' : 'generateVideoInNode']('output')
    assert.equal(requests.length, 1)
    assert.equal(requests[0][0], '生成一片森林')
    assert.equal(context.nodes[0].data.status, 'done')
    assert.equal(context.history[0].prompt, '生成一片森林')
  })
  test(`${kind} with empty or disconnected references makes no API call`, async () => {
    const { context, requests } = generationHarness(kind, '')
    const generate = context[kind === 'image' ? 'generateImageInNode' : 'generateVideoInNode']
    await generate('output')
    assert.equal(requests.length, 0)
    context.nodes[0].data.prompt = '处理 @Image1'
    context.nodes[0].data.promptMentions = [{ token: '@Image1', nodeId: 'removed-ref', kind: 'image', label: 'missing' }]
    await generate('output')
    assert.equal(requests.length, 0)
    assert.equal(context.nodes[0].data.status, 'error')
    assert.match(context.nodes[0].data.error, /未连接/)
  })
}

test('image and video show all generation controls in the active floating panel only', async () => {
  const React = await import('react')
  const icons = await import('lucide-react')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const model = { id: 'test', label: 'test', resolutions: ['1K'], defaultResolution: '1K', minDuration: 1, maxDuration: 10, defaultDuration: 5, maxReferenceVideos: 1 }
  const aspectRatio = { value: '1:1', label: '1:1', size: '1024x1024', cssRatio: '1 / 1' }
  const context = helpers(['WorkflowCard', 'promptContainsMentionToken', 'activePromptMentions', 'parseImageSize'], {
    ...React, ...icons, ImageIcon: icons.Image, mediaDataForCopy: mediaModule.exports.mediaDataForCopy,
    ...inputDependencies,
    useUpdateNodeInternals: () => () => {},
    // React Flow supplies this context in the browser; render inert handles for the card test.
    Handle: ({ id, type }) => React.createElement('span', { 'data-handle': id, 'data-type': type }),
    UnifiedRange: ({ value, 'aria-label': label }) => React.createElement('input', { type: 'range', value, 'aria-label': label, readOnly: true }),
    Position: { Left: 'left', Right: 'right' },
    getAspectRatioOption: () => aspectRatio, aspectRatioOptions: [aspectRatio],
    defaultApiConfig: { size: '1024x1024' },
    defaultOutpaintInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
    findApiMartModel: () => model, findApiMartVideoModel: () => model,
    apiMartModels: [model], apiMartVideoModels: [model], apiModelDisplayName: () => 'Test Model',
  })
  for (const kind of ['image', 'video']) {
    const props = {
      id: kind, selected: true,
      data: { kind, title: kind, status: 'idle', apiMode: 'mock', prompt: '当前节点的提示词' },
    }
    const hidden = renderToStaticMarkup(React.createElement(context.WorkflowCard, { ...props, selected: false }))
    assert.doesNotMatch(hidden, /<textarea|generation-panel|运行生成|运行视频生成|图像生成模型|视频生成模型/)
    const html = renderToStaticMarkup(React.createElement(context.WorkflowCard, props))
    assert.equal((html.match(/<textarea/g) || []).length, 1)
    assert.match(html, /floating-prompt-control.*nodrag nopan nowheel/)
    assert.match(html, new RegExp(`aria-label="${kind === 'image' ? '图像' : '视频'}生成提示词"`))
    assert.ok(html.indexOf('floating-prompt-control') > html.indexOf('data-handle="output"'))
    assert.match(html, /data-handle="image-1"/)
    assert.doesNotMatch(html, /data-handle="prompt"|Prompt 输入|Prompt 输出/)
    assert.match(html, /当前节点的提示词/)
    const panelStart = html.indexOf('<section class="generation-panel')
    const card = html.slice(0, panelStart)
    const panel = html.slice(panelStart)
    assert.doesNotMatch(card, /<select|<textarea|node-model-picker|node-run-button|aspect-ratio-control/)
    assert.match(panel, new RegExp(`aria-label="${kind === 'image' ? '图像' : '视频'}生成模型"`))
    assert.match(panel, /画面比例/)
    assert.match(panel, /清晰度/)
    assert.match(panel, /generation-submit/)
    if (kind === 'image') {
      assert.match(panel, /image-generation-toolbar/)
      assert.match(panel, /generation-submit-run/)
      assert.match(panel, />Run<\/button>/)
    }
    if (kind === 'video') assert.match(panel, /视频生成时长/)
    const inactiveSelection = renderToStaticMarkup(React.createElement(context.WorkflowCard, { ...props, data: { ...props.data, generationPanelOpen: false } }))
    assert.doesNotMatch(inactiveSelection, /generation-panel|<textarea/)
  }
})

test('multi-angle generation uses the model selected in the editor', async () => {
  let sequence = 0
  const executions = []
  const context = helpers(['submitMultiAngle'], {
    multiAngleSession: { nodeId: 'source', sourceImageUrl: '/source.png' },
    nodes: [node('source', 'reference', { imageUrl: '/source.png', title: 'Source' })],
    edges: [],
    apiConfig: { mode: 'apimart', model: 'model-a', imageSize: '1K' },
    imageGenerationModelOptions: [
      { id: 'model-a', label: 'Model A' },
      { id: 'model-b', label: 'Model B' },
    ],
    findApiMartModel: id => ({ id, resolutions: ['2K'], defaultResolution: '2K' }),
    getAbsoluteNodePosition: value => value.position,
    findFreeWorkflowNodePosition: value => value,
    id: prefix => `${prefix}-${++sequence}`,
    defaultLightDirection: { x: 0, y: 0, enabled: false },
    MarkerType: { ArrowClosed: 'arrow-closed' },
    workflowEdgeColor: '#fff',
    imageInputHandlePrefix: 'image-',
    normalizeImageInputEdges: values => values,
    setNodes: update => { context.nodes = update(context.nodes) },
    setEdges: update => { context.edges = update(context.edges) },
    setSelectedNodeId: value => { context.selectedNodeId = value },
    setMultiAngleSession: value => { context.multiAngleSession = value },
    markDirty: () => { context.dirty = true },
    setToast: value => { context.toast = value },
    window: { setTimeout: callback => callback() },
    flowInstance: null,
    executeMultiAngleGeneration: (...args) => { executions.push(args) },
  })
  const result = {
    presetId: 'custom', presetLabel: '自定义', horizontal: 0, vertical: 0,
    framing: 'medium', lens: 'standard', roll: 0,
    modelId: 'model-b', modelLabel: 'Model B', prompt: 'new angle',
    sourceWidth: 1200, sourceHeight: 800,
  }

  await context.submitMultiAngle(result)

  const output = context.nodes.find(value => value.id.startsWith('multi-angle-result-'))
  assert.equal(output.data.model, 'model-b')
  assert.equal(output.data.imageSize, '2K')
  assert.equal(context.edges[0].source, 'source')
  assert.equal(context.edges[0].target, output.id)
  assert.equal(executions[0][0], output)
  assert.equal(executions[0][2], result)
  assert.match(context.toast, /Model B/)
})
