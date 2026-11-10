/** Text generation through the fixed OpenAI -> Anthropic OpenRouter BYOK chain. */

import { generateText } from 'ai'
import { getModel } from './provider'

const MAX_RETRIES = 3
const RETRY_DELAYS_MS = [1_000, 3_000, 7_000]

export const AI_SENTINEL = {
  RATE_LIMITED: 'ai_rate_limited',
  UNAVAILABLE: 'ai_unavailable',
  PUBLISH_FAILED: 'publish_failed',
} as const

export function isTransientAiError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const e = err as unknown as Record<string, unknown>
  if (typeof e.statusCode === 'number' && [429, 500, 502, 503, 504, 529].includes(e.statusCode as number)) return true
  if (e.isRetryable === true) return true
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return true
  if (e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT') return true
  return false
}

export function aiSentinelCode(err: unknown): string {
  const e = err as Record<string, unknown>
  if (typeof e.statusCode === 'number' && e.statusCode === 429) return AI_SENTINEL.RATE_LIMITED
  if (isTransientAiError(err)) return AI_SENTINEL.UNAVAILABLE
  return 'ai_error'
}

async function retryOnTransient<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (!isTransientAiError(err)) throw err
      const delay = RETRY_DELAYS_MS[i] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]
      console.warn(`[ai-fallback] BYOK attempt ${i + 1} transient — retry in ${delay}ms`)
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
  throw lastErr
}

export async function generateTextWithFallback(options: {
  system: string
  prompt: string
  temperature?: number
  maxOutputTokens?: number
  /** Kept only for stored configuration compatibility; it cannot change provider order. */
  primary?: 'deepseek' | 'gemini' | 'openai'
}): Promise<string> {
  const generate = (provider: 'openai' | 'anthropic') => retryOnTransient(() => generateText({
    model: getModel('claude-haiku', provider),
    system: options.system,
    prompt: options.prompt,
    maxOutputTokens: options.maxOutputTokens,
    maxRetries: 0,
  }))
  let result: Awaited<ReturnType<typeof generate>>
  try {
    result = await generate('openai')
  } catch (error) {
    console.warn('[ai-fallback] OpenAI BYOK failed; retrying with Anthropic BYOK', error)
    result = await generate('anthropic')
  }
  return result.text.trim()
}
