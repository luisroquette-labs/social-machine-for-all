import { createOpenRouter } from '@openrouter/ai-sdk-provider'

export const OPENROUTER_APP_HEADERS: Record<string, string> = {
  'HTTP-Referer': 'https://luisroquette-labs.github.io/social-machine-for-all/',
  'X-Title': 'Social Machine for All',
}

type ByokCapability = 'fast' | 'quality' | 'critical'

const BYOK_CHAINS: Record<ByokCapability, readonly [string, string]> = {
  fast: ['openai/gpt-5-nano', 'anthropic/claude-haiku-5.5'],
  quality: ['openai/gpt-6.1-sol', 'anthropic/claude-sonnet-5.5'],
  critical: ['openai/gpt-6-astra', 'anthropic/claude-opus-5.5'],
}

const MODEL_CAPABILITIES: Record<string, ByokCapability> = {
  'claude-sonnet': 'quality',
  'claude-haiku': 'fast',
  'deepseek-chat': 'quality',
  'deepseek-reasoner': 'critical',
}

const MODEL_ID_ALIASES: Record<string, string> = {
  'claude-sonnet-4-6': 'claude-sonnet',
  'claude-haiku-4-5-20251001': 'claude-haiku',
  'deepseek-v4-flash': 'deepseek-chat',
}

function resolveModelName(modelName: string): string {
  return MODEL_CAPABILITIES[modelName] ? modelName : (MODEL_ID_ALIASES[modelName] ?? modelName)
}

export async function byokFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const response = await fetchImpl(input, init)
  if (!response.ok) return response

  const data = await response.clone().json().catch(() => null) as {
    model?: unknown
    usage?: { is_byok?: unknown }
  } | null
  const request = typeof init?.body === 'string'
    ? JSON.parse(init.body) as { model?: unknown; models?: unknown }
    : {}
  const models = Array.isArray(request.models)
    ? request.models.filter((model): model is string => typeof model === 'string')
    : typeof request.model === 'string' ? [request.model] : []

  if (data?.usage?.is_byok !== true) {
    await response.body?.cancel().catch(() => undefined)
    return Response.json({ error: data?.usage?.is_byok === false ? 'BYOK_POLICY_VIOLATION' : 'BYOK_UNVERIFIED' }, { status: 403 })
  }
  if (typeof data.model !== 'string' || !models.includes(data.model)) {
    await response.body?.cancel().catch(() => undefined)
    return Response.json({ error: 'BYOK_MODEL_MISMATCH' }, { status: 403 })
  }
  return response
}

export function getModel(modelName: string, provider: 'openai' | 'anthropic' = 'openai') {
  const capability = MODEL_CAPABILITIES[resolveModelName(modelName)]
  if (!capability) {
    throw new Error(`Unknown model: ${modelName}. Available: ${Object.keys(MODEL_CAPABILITIES).join(', ')}`)
  }

  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) throw new Error('OPENROUTER_API_KEY not configured')

  const model = BYOK_CHAINS[capability][provider === 'openai' ? 0 : 1]
  return createOpenRouter({ apiKey, headers: OPENROUTER_APP_HEADERS, fetch: byokFetch })(model, {
    provider: {
      only: [provider],
      allow_fallbacks: false,
      require_parameters: true,
    },
    usage: { include: true },
  })
}

export function listModels(): string[] {
  return Object.keys(MODEL_CAPABILITIES)
}
