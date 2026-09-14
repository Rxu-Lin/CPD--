import type { Edge } from '@xyflow/react'

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
