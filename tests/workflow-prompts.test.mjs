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
const { migrateLegacyPromptNodes, generationPromptText, whiteModelAnimationPrompt } = promptModule.exports
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

function quickWorkflowHarness() {
  const requests = [], fitViews = []
  let sequence = 0
  const context = helpers([
    'addQuickStartWorkflow', 'addWhiteModelAnimationQuickWorkflow', 'addImageToImageQuickWorkflow',
    'addVideoQuickWorkflow', ...inputHelpers, 'generateVideoInNode',
  ], {
    ...inputDependencies, whiteModelAnimationPrompt,
    nodes: [node('existing', 'image', { prompt: '已有画布内容' })], edges: [], history: [],
    apiConfig: { mode: 'apimart', model: 'gpt-image-2', videoModel: 'MiniMax-H3', imageSize: '2K', size: '864x1536' },
    defaultApiConfig: { size: '1024x1024' }, defaultLightDirection: { enabled: false },
    findApiMartVideoModel: id => id === 'seedance-2.5'
      ? { id, label: 'Seedance 2.5', resolutions: ['480p', '720p', '1080p'], defaultResolution: '720p', minDuration: 4, maxDuration: 30, defaultDuration: 5, maxReferenceVideos: 10 }
      : { id: 'MiniMax-H3', label: 'MiniMax H3', resolutions: ['2K'], defaultResolution: '2K', minDuration: 4, maxDuration: 15, defaultDuration: 6, maxReferenceVideos: 0 },
    id: prefix => `${prefix}-${++sequence}`, MarkerType: { ArrowClosed: 'arrow-closed' }, workflowEdgeColor: '#fff',
    window: { innerWidth: 1280, innerHeight: 840, setTimeout: callback => callback() },
    flowInstance: { screenToFlowPosition: () => ({ x: 720, y: 460 }), fitView: settings => { fitViews.push(settings) } },
    setNodes: update => { context.nodes = update(context.nodes) },
    setEdges: update => { context.edges = update(context.edges) },
    setSelectedNodeId: id => { context.selectedNodeId = id },
    setShowQuickWorkflows: value => { context.showQuickWorkflows = value },
    setShowPromptLibrary: value => { context.showPromptLibrary = value },
    markDirty: () => { context.dirty = true },
    setToast: value => { context.toast = value }, setIsGenerating() {},
    updateNodeData: (id, patch) => { context.nodes = context.nodes.map(value => value.id === id ? { ...value, data: { ...value.data, ...patch } } : value) },
    setHistory: update => { context.history = update(context.history) },
    requestGeneratedVideo: async (...args) => { requests.push(args); return '/white-model-animation.mp4' },
  })
  return { context, requests, fitViews }
}

test('white-model animation replaces only the quick-menu image-to-image action', () => {
  const menu = source.slice(source.indexOf('<section id="quick-workflow-panel"'), source.indexOf('<div className="prompt-library-popover"'))
  assert.match(menu, /onClick=\{addWhiteModelAnimationQuickWorkflow\}/)
  assert.match(menu, /<strong>白膜动态生成<\/strong>/)
  assert.doesNotMatch(menu, /图生图|addImageToImageQuickWorkflow/)
  assert.match(source, /className="canvas-quick-start-button" type="button" onClick=\{addImageToImageQuickWorkflow\}/)
})

test('white-model animation creates two correctly wired references and pins Seedance 2.5', () => {
  const { context, fitViews, requests } = quickWorkflowHarness()
  const original = plain(context.nodes)
  context.addWhiteModelAnimationQuickWorkflow()
  assert.deepEqual(plain(context.nodes[0]), { ...original[0], selected: false })
  const created = context.nodes.slice(1)
  assert.deepEqual(plain(created.map(value => value.data.kind)), ['video-reference', 'reference', 'video'])
  const [videoRef, imageRef, output] = created
  assert.match(videoRef.data.title, /白膜.*纯运动/)
  assert.match(imageRef.data.title, /静帧.*唯一视觉外观/)
  assert.equal(imageRef.position.x, videoRef.position.x)
  assert.ok(imageRef.position.y < videoRef.position.y, 'Image is above Video to match the target input order and avoid crossing wires')
  assert.equal(videoRef.position.y - imageRef.position.y, 430)
  assert.equal(output.data.model, 'seedance-2.5', 'global MiniMax selection must not change the preset model')
  assert.equal(output.data.videoResolution, '720p')
  assert.equal(output.data.videoDuration, 5)
  assert.equal(output.data.prompt, whiteModelAnimationPrompt)
  assert.deepEqual(plain(output.data.referenceRequirements), { images: 1, videos: 1 })
  assert.equal(output.selected, true)
  assert.equal(context.selectedNodeId, output.id)
  assert.deepEqual(plain(context.edges.map(value => [value.source, value.target, value.targetHandle, value.sourceHandle])), [
    [imageRef.id, output.id, 'image-1', 'output'], [videoRef.id, output.id, 'video-1', 'output'],
  ])
  assert.deepEqual(plain(fitViews[0].nodes.map(value => value.id)), plain(created.map(value => value.id)))
  assert.equal(context.showQuickWorkflows, false)
  assert.equal(context.showPromptLibrary, false)
  assert.equal(context.dirty, true)
  assert.equal(requests.length, 0, 'creating a workflow must never start paid generation')
  const restored = plain({ nodes: context.nodes, edges: context.edges })
  assert.deepEqual(restored.nodes.at(-1).data.referenceRequirements, { images: 1, videos: 1 })
  context.addWhiteModelAnimationQuickWorkflow()
  assert.equal(new Set(context.nodes.map(value => value.id)).size, context.nodes.length)
  assert.equal(new Set(context.edges.map(value => value.id)).size, context.edges.length)
})

test('the complete preset preserves motion, appearance, consistency and limitation instructions', () => {
  assert.equal(whiteModelAnimationPrompt.split('\n').length, 5)
  for (const instruction of [
    '以我上传的白膜视频作为**纯运动参考**，以静帧参考图作为**唯一视觉外观依据**。严格区分两类素材的作用：',
    '**运动遵循白膜视频：**准确匹配镜头移动路径、运镜方向、速度变化、推拉摇移、旋转、镜头时序',
    '不继承白膜视频中的物体形状、几何轮廓、比例、模型结构、表面细节、颜色、材质、灯光及背景外观',
    '不因匹配运动而将参考图中的物体变形成白膜模型。',
    '**画面严格遵循静帧参考图：**以参考图确定主体造型、比例、结构、场景设计',
    '将参考图中的主体与场景按照白膜视频的运动逻辑进行动画化，而非将白膜模型重新贴图。',
    '参考图未展示的区域，应依据其既有结构、材质与风格合理延展，不引入白膜模型的外观特征。',
    '**全程保持时序一致性：**主体身份、形状、比例、材质与纹理稳定',
    '避免造型漂移、物体变形、纹理游移、画面闪烁、曝光跳变、无依据的物体增减与额外运镜。',
    '**参考图中的画面，按照白膜视频的镜头运动和物体运动节奏自然动起来。**',
    '注：提示词能明确参考分工，但无法保证模型完全隔离白膜几何；若生成界面支持，建议将白膜设为运动参考、静帧设为外观参考。',
  ]) assert.ok(whiteModelAnimationPrompt.includes(instruction), instruction)
})

test('white-model animation blocks missing or disconnected inputs before any generation request', async () => {
  for (const state of ['empty', 'image-only', 'video-only', 'disconnected-image', 'disconnected-video']) {
    const { context, requests } = quickWorkflowHarness()
    context.addWhiteModelAnimationQuickWorkflow()
    const [videoRef, imageRef, output] = context.nodes.slice(1)
    if (state !== 'empty' && state !== 'video-only') imageRef.data.imageUrl = '/appearance.png'
    if (state !== 'empty' && state !== 'image-only') videoRef.data.videoUrl = '/motion.mp4'
    if (state.startsWith('disconnected')) context.edges = context.edges.filter(value => value.source !== (state === 'disconnected-image' ? imageRef.id : videoRef.id))
    await context.generateVideoInNode(output.id)
    assert.equal(requests.length, 0, state)
    assert.match(context.nodes.find(value => value.id === output.id).data.error, /白膜参考视频和静帧参考图/)
    assert.equal(context.history.length, 0)
  }
})

test('white-model Run sends the stored prompt and separates image/video reference arrays', async () => {
  const { context, requests } = quickWorkflowHarness()
  context.addWhiteModelAnimationQuickWorkflow()
  const [videoRef, imageRef, output] = context.nodes.slice(1)
  videoRef.data.videoUrl = '/motion.mp4'
  videoRef.data.videoDurationSeconds = 5
  imageRef.data.imageUrl = '/appearance.png'
  await context.generateVideoInNode(output.id)
  assert.equal(requests.length, 1)
  assert.ok(requests[0][0].startsWith(whiteModelAnimationPrompt))
  assert.equal(requests[0][1].videoModel, 'seedance-2.5')
  assert.deepEqual(plain(requests[0][2]), ['/appearance.png'])
  assert.deepEqual(plain(requests[0][3]), ['/motion.mp4'])
  assert.equal(context.nodes.find(value => value.id === output.id).data.status, 'done')
  assert.equal(context.history[0].prompt, whiteModelAnimationPrompt)
  assert.equal(context.history[0].model, 'seedance-2.5')
})

test('ordinary image and video quick-start workflows retain their previous defaults', () => {
  for (const kind of ['image', 'video']) {
    const { context } = quickWorkflowHarness()
    context[kind === 'image' ? 'addImageToImageQuickWorkflow' : 'addVideoQuickWorkflow']()
    const created = context.nodes.slice(1)
    assert.deepEqual(plain(created.map(value => value.data.kind)), ['reference', kind])
    assert.equal(created[1].data.prompt, '')
    assert.equal(created[1].data.model, kind === 'image' ? 'gpt-image-2' : 'MiniMax-H3')
    assert.equal(created[1].data.referenceRequirements, undefined)
    assert.equal(context.edges.length, 1)
    assert.equal(context.edges[0].targetHandle, 'image-1')
  }
})

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
    assert.match(panel, /generation-submit-run/)
    assert.match(panel, />Run<\/button>/)
    assert.doesNotMatch(panel, />生成视频<\/button>/)
    if (kind === 'image') {
      assert.match(panel, /image-generation-toolbar/)
    }
    if (kind === 'video') assert.match(panel, /视频生成时长/)
    const busyHtml = renderToStaticMarkup(React.createElement(context.WorkflowCard, { ...props, data: { ...props.data, status: 'generating' } }))
    const busyButton = busyHtml.match(/<button class="generation-submit generation-submit-run"[^>]*>[\s\S]*?<\/button>/)?.[0]
    assert.ok(busyButton, 'generating keeps the same square Run button')
    assert.match(busyButton, /disabled=""/)
    assert.match(busyButton, /aria-label="正在生成"/)
    assert.match(busyButton, /export-spinner/)
    assert.doesNotMatch(busyButton, />生成中…|>Run<\/button>/)
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
