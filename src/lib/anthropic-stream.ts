export type ToolUseAccumulator = {
  id: string
  name: string
  index: number
  input: unknown
  inputJson: string
  hasInputDeltas: boolean
}

type StreamEvent = {
  type?: string
  index?: number
  content_block?: { type?: string; id?: string; name?: string; input?: unknown }
  delta?: { type?: string; partial_json?: string }
}

export function parseToolInputJson(value: string): unknown | undefined {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return undefined
  }
}

export function applyToolUseDelta(
  toolInputs: Map<number, ToolUseAccumulator>,
  event: StreamEvent
): void {
  if (!event || typeof event !== 'object') return
  const index = typeof event.index === 'number' ? event.index : undefined

  if (event.type === 'content_block_start') {
    const block = event.content_block
    if (!block || block.type !== 'tool_use' || index === undefined) return
    toolInputs.set(index, {
      id: block.id as string,
      name: block.name as string,
      index,
      input: block.input,
      inputJson: '',
      hasInputDeltas: false
    })
    return
  }

  if (event.type === 'content_block_delta') {
    const delta = event.delta
    if (!delta || delta.type !== 'input_json_delta' || index === undefined) return
    const accumulator = toolInputs.get(index)
    if (!accumulator) return
    accumulator.inputJson += delta.partial_json ?? ''
    accumulator.hasInputDeltas = true
  }
}

export function finalizeToolUses(
  toolInputs: Map<number, ToolUseAccumulator>
): Array<{ id: string; name: string; input: unknown; index: number }> {
  return Array.from(toolInputs.values())
    .sort((a, b) => a.index - b.index)
    .map(entry => ({
      id: entry.id,
      name: entry.name,
      index: entry.index,
      input: entry.hasInputDeltas
        ? parseToolInputJson(entry.inputJson) ?? entry.inputJson
        : entry.input
    }))
}
