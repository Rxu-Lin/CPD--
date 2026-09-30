import type { Edge } from '@xyflow/react'

export const whiteModelAnimationPrompt = `以我上传的白膜视频作为**纯运动参考**，以静帧参考图作为**唯一视觉外观依据**。严格区分两类素材的作用：
**运动遵循白膜视频：**准确匹配镜头移动路径、运镜方向、速度变化、推拉摇移、旋转、镜头时序，以及对应物体的移动方向、运动轨迹、动作节奏、启停时间与相对运动关系。仅提取运动信息，不继承白膜视频中的物体形状、几何轮廓、比例、模型结构、表面细节、颜色、材质、灯光及背景外观；不因匹配运动而将参考图中的物体变形成白膜模型。
**画面严格遵循静帧参考图：**以参考图确定主体造型、比例、结构、场景设计、颜色、材质、纹理、灯光方向、光影层次、曝光、色调和整体风格。将参考图中的主体与场景按照白膜视频的运动逻辑进行动画化，而非将白膜模型重新贴图。运镜过程中保持参考图的视觉设定一致，根据视角变化自然呈现透视、遮挡、反射与阴影；参考图未展示的区域，应依据其既有结构、材质与风格合理延展，不引入白膜模型的外观特征。
**全程保持时序一致性：**主体身份、形状、比例、材质与纹理稳定，场景空间关系连贯，色调、灯光设定及材质表现一致。避免造型漂移、物体变形、纹理游移、画面闪烁、曝光跳变、无依据的物体增减与额外运镜。最终效果为：**参考图中的画面，按照白膜视频的镜头运动和物体运动节奏自然动起来。**
注：提示词能明确参考分工，但无法保证模型完全隔离白膜几何；若生成界面支持，建议将白膜设为运动参考、静帧设为外观参考。`

type PromptData = {
  kind: string
  prompt?: string
  generationPrompt?: string
  promptMentions?: unknown[]
  [key: string]: unknown
}

type PromptNode = { id: string; data: PromptData }

export function generationPromptText(data: Pick<PromptData, 'prompt' | 'generationPrompt'>) {
  // An explicitly cleared editor must not silently reuse a previous prompt.
  return (data.prompt ?? data.generationPrompt ?? '').trim()
}

/** Move old prompt nodes into their destinations without losing saved text or references. */
export function migrateLegacyPromptNodes<T extends PromptNode>(nodes: T[], edges: Edge[]) {
  const restoredNodes = nodes.map((node) =>
    ['image', 'video'].includes(node.data.kind) && !node.data.prompt && node.data.generationPrompt
      ? { ...node, data: { ...node.data, prompt: node.data.generationPrompt } }
      : node,
  )
  if (restoredNodes.some((node, index) => node !== nodes[index])) nodes = restoredNodes
  const legacyNodes = nodes.filter((node) => node.data.kind === 'prompt')
  if (!legacyNodes.length) return { nodes, edges }

  const legacyIds = new Set(legacyNodes.map((node) => node.id))
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  const migratedData = new Map<string, PromptData>()
  const removedIds = new Set<string>()
  const forwardedEdges: Edge[] = []

  for (const promptNode of legacyNodes) {
    const targets = [...new Set(edges.filter((edge) =>
      edge.source === promptNode.id &&
      (!edge.targetHandle || edge.targetHandle === 'prompt') &&
      ['image', 'video', 'repaint', 'outpaint'].includes(nodeById.get(edge.target)?.data.kind || ''),
    ).map((edge) => edge.target))]

    if (!targets.length) {
      // Keep unconnected drafts as ordinary image generation nodes at the same position.
      migratedData.set(promptNode.id, { ...promptNode.data, kind: 'image', title: 'AI 生成图像' })
      continue
    }
    removedIds.add(promptNode.id)
    for (const targetId of targets) {
      const target = nodeById.get(targetId)!
      const data = migratedData.get(targetId) || target.data
      const incomingPrompt = promptNode.data.prompt || ''
      const previousPrompt = generationPromptText(data)
      const prompt = incomingPrompt.trim() && incomingPrompt.trim() !== previousPrompt
        ? [incomingPrompt, previousPrompt].filter(Boolean).join('\n\n')
        : previousPrompt
      const mentions = [...(promptNode.data.promptMentions || []), ...(data.promptMentions || [])]
      migratedData.set(targetId, { ...data, prompt, promptMentions: mentions })

      // Older projects can route reference images through a prompt node.
      for (const edge of edges.filter((item) => item.target === promptNode.id && !legacyIds.has(item.source))) {
        if (edges.some((item) => item.source === edge.source && item.target === targetId) ||
            forwardedEdges.some((item) => item.source === edge.source && item.target === targetId)) continue
        const kind = nodeById.get(edge.source)?.data.kind
        forwardedEdges.push({
          ...edge,
          id: `${edge.id}-migrated-${targetId}`,
          target: targetId,
          targetHandle: kind === 'video-reference' || kind === 'video' ? 'video-1' : 'image-1',
        })
      }
    }
  }

  return {
    nodes: nodes.filter((node) => !removedIds.has(node.id)).map((node) => {
      const data = migratedData.get(node.id)
      return data ? { ...node, data: { ...node.data, ...data } } : node
    }),
    edges: [...edges.filter((edge) =>
      !removedIds.has(edge.source) && !removedIds.has(edge.target) && edge.targetHandle !== 'prompt',
    ), ...forwardedEdges],
  }
}
