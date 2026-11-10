import { generateText, stepCountIs } from 'ai'
import { getModel } from './provider'

export interface ToolDefinition {
  name: string
  description: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  parameters: any
  execute: (params: any) => Promise<unknown>
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; image: string; mimeType?: string }

export type ChatMessage =
  | { role: 'user' | 'assistant'; content: string }
  | { role: 'user'; content: ContentPart[] }

export interface ToolLoopOptions {
  model: string
  systemPrompt: string
  messages: ChatMessage[]
  tools?: ToolDefinition[]
  maxSteps?: number
  maxTokens?: number
  temperature?: number
}

export interface ToolLoopResult {
  text: string
  tokensUsed: number
  stepsCompleted: number
  toolCalls: Array<{ name: string; args: unknown; result: unknown }>
}

/**
 * Execute a tool-use loop using Vercel AI SDK's generateText.
 *
 * Port of super-advogado's _loop_tool_use pattern.
 * The AI SDK handles the tool-use loop internally via maxSteps.
 */
export async function executeToolLoop(options: ToolLoopOptions): Promise<ToolLoopResult> {
  const {
    model,
    systemPrompt,
    tools: toolDefs = [],
    maxSteps = 5,
    maxTokens = 4096,
  } = options

  // Build tools for AI SDK.
  // CRITICAL: AI SDK reads tool.inputSchema (NOT tool.parameters).
  // Passing Zod v4 schemas directly as inputSchema works because
  // asSchema() detects ~standard interface and converts via z4.toJSONSchema().
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const aiTools: Record<string, any> = {}
  let toolExecutionStarted = false
  for (const def of toolDefs) {
    aiTools[def.name] = {
      description: def.description,
      inputSchema: def.parameters,
      execute: async (params: unknown) => {
        toolExecutionStarted = true
        return def.execute(params)
      },
    }
  }

  // Convert our message format to AI SDK format
  const aiMessages = options.messages.map((msg) => {
    if (typeof msg.content === 'string') {
      return msg
    }
    // Multimodal message — convert content parts
    return {
      role: msg.role,
      content: msg.content.map((part) => {
        if (part.type === 'text') return part
        // Image part — convert base64 to data URL for AI SDK
        return {
          type: 'image' as const,
          image: new URL(`data:${part.mimeType ?? 'image/jpeg'};base64,${part.image}`),
        }
      }),
    }
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const runGenerate = (resolvedModel: any) =>
    generateText({
      model: resolvedModel,
      system: systemPrompt,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      messages: aiMessages as any,
      tools: Object.keys(aiTools).length > 0 ? aiTools : undefined,
      stopWhen: stepCountIs(maxSteps),
      maxOutputTokens: maxTokens,
    })

  let result: Awaited<ReturnType<typeof runGenerate>>
  try {
    result = await runGenerate(getModel(model, 'openai'))
  } catch (error) {
    if (toolExecutionStarted) throw error
    console.warn(`[tool-loop] OpenAI BYOK failed for "${model}"; retrying with Anthropic BYOK`, error)
    result = await runGenerate(getModel(model, 'anthropic'))
  }

  // Collect tool calls from all steps
  const toolCalls: Array<{ name: string; args: unknown; result: unknown }> = []
  for (const step of result.steps) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const tc of step.toolCalls as any[]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const matchingResult = (step.toolResults as any[]).find(
        (tr) => tr.toolCallId === tc.toolCallId
      )
      toolCalls.push({
        name: tc.toolName,
        args: tc.args,
        result: matchingResult?.result,
      })
    }
  }

  return {
    text: result.text,
    tokensUsed: result.usage.totalTokens ?? 0,
    stepsCompleted: result.steps.length,
    toolCalls,
  }
}

/**
 * Simple text generation without tools.
 */
export async function generateSimpleText(options: {
  model: string
  systemPrompt: string
  userMessage: string
  maxTokens?: number
  temperature?: number
}): Promise<{ text: string; tokensUsed: number }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const runGenerate = (resolvedModel: any) =>
    generateText({
      model: resolvedModel,
      system: options.systemPrompt,
      messages: [{ role: 'user', content: options.userMessage }],
      maxOutputTokens: options.maxTokens ?? 4096,
    })

  let result: Awaited<ReturnType<typeof runGenerate>>
  try {
    result = await runGenerate(getModel(options.model, 'openai'))
  } catch (error) {
    console.warn(`[tool-loop] OpenAI BYOK failed for "${options.model}"; retrying with Anthropic BYOK`, error)
    result = await runGenerate(getModel(options.model, 'anthropic'))
  }

  return {
    text: result.text,
    tokensUsed: result.usage.totalTokens ?? 0,
  }
}
