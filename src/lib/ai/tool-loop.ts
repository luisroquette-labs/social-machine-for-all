import { generateText, stepCountIs } from 'ai'
import { getModel, getModelViaOpenRouter } from './provider'

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
    messages,
    tools: toolDefs = [],
    maxSteps = 5,
    maxTokens = 4096,
    temperature = 0.7,
  } = options

  // Build tools for AI SDK.
  // CRITICAL: AI SDK reads tool.inputSchema (NOT tool.parameters).
  // Passing Zod v4 schemas directly as inputSchema works because
  // asSchema() detects ~standard interface and converts via z4.toJSONSchema().
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const aiTools: Record<string, any> = {}
  for (const def of toolDefs) {
    aiTools[def.name] = {
      description: def.description,
      inputSchema: def.parameters,
      execute: def.execute,
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
  const runGenerate = (resolvedModel: any, viaOpenRouter: boolean, providerOptions?: Parameters<typeof generateText>[0]['providerOptions']) =>
    generateText({
      model: resolvedModel,
      system: systemPrompt,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      messages: aiMessages as any,
      tools: Object.keys(aiTools).length > 0 ? aiTools : undefined,
      stopWhen: stepCountIs(maxSteps),
      maxOutputTokens: maxTokens,
      temperature,
      // Omitted for the OpenRouter tier — passthrough of Anthropic's
      // cache_control via @openrouter/ai-sdk-provider isn't confirmed, so this
      // is a cost-only tradeoff (no caching discount on that tier), not a
      // correctness one.
      //
      // deepseek.thinking:disabled (21/07/2026): 'deepseek-v4-flash' (o que
      // 'deepseek-chat' virou após a migração de 24/07) entra em modo "thinking"
      // por padrão se esse parâmetro não for passado — verificado ao vivo,
      // gastou o orçamento inteiro de tokens "pensando" e devolveu resposta
      // vazia. Cada provider só lê sua própria chave em providerOptions, então
      // não tem conflito em mandar as duas juntas pra um model reference que
      // não é nem Anthropic nem DeepSeek.
      ...(viaOpenRouter ? { providerOptions } : { providerOptions: {
        anthropic: { cacheControl: { type: 'ephemeral' } },
        deepseek: { thinking: { type: 'disabled' } },
      } }),
    })

  const openRouterModel = getModelViaOpenRouter(model)
  let result: Awaited<ReturnType<typeof runGenerate>>
  if (openRouterModel) {
    try {
      result = await runGenerate(openRouterModel, true)
    } catch (err) {
      console.warn(`[tool-loop] OpenRouter failed for "${model}" — restarting full loop on direct provider:`, err instanceof Error ? err.message : err)
      result = await runGenerate(getModel(model), false)
    }
  } else {
    result = await runGenerate(getModel(model), false)
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
  const runGenerate = (resolvedModel: any, viaOpenRouter: boolean, providerOptions?: Parameters<typeof generateText>[0]['providerOptions']) =>
    generateText({
      model: resolvedModel,
      system: options.systemPrompt,
      messages: [{ role: 'user', content: options.userMessage }],
      maxOutputTokens: options.maxTokens ?? 4096,
      temperature: options.temperature ?? 0.7,
      // deepseek.thinking:disabled (21/07/2026) — ver comentário em executeToolLoop() acima.
      ...(viaOpenRouter ? { providerOptions } : { providerOptions: {
        anthropic: { cacheControl: { type: 'ephemeral' } },
        deepseek: { thinking: { type: 'disabled' } },
      } }),
    })

  const openRouterModel = getModelViaOpenRouter(options.model)
  let result: Awaited<ReturnType<typeof runGenerate>>
  if (openRouterModel) {
    try {
      result = await runGenerate(openRouterModel, true)
    } catch (err) {
      console.warn(`[tool-loop] OpenRouter failed for "${options.model}" — falling back to direct provider:`, err instanceof Error ? err.message : err)
      result = await runGenerate(getModel(options.model), false)
    }
  } else {
    result = await runGenerate(getModel(options.model), false)
  }

  return {
    text: result.text,
    tokensUsed: result.usage.totalTokens ?? 0,
  }
}
