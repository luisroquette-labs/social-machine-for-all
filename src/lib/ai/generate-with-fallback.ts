/**
 * AI text generation with multi-provider fallback and transient retry.
 *
 * Primary: DeepSeek (deepseek-v4-flash), direto — nunca via OpenRouter.
 * Fallback: Google Gemini (gemini-2.5-flash), via OpenRouter.
 *
 * Handles transient errors (429, 5xx, timeout, ECONNRESET) with exponential
 * backoff before falling back to the secondary provider.
 */

import { generateText } from 'ai'
import { deepseek } from '@ai-sdk/deepseek'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'

const MAX_RETRIES = 3
const RETRY_DELAYS_MS = [1_000, 3_000, 7_000]

/** Sentinel codes set on curated_content.skip_reason for transient AI errors and publish failures. */
export const AI_SENTINEL = {
  RATE_LIMITED: 'ai_rate_limited',   // 429 — reset after 4h
  UNAVAILABLE: 'ai_unavailable',     // 5xx / timeout — reset after 2h
  PUBLISH_FAILED: 'publish_failed',  // Instagram rejected the video — reset after 24h
} as const

/** Returns true if the error is transient and should be retried. */
export function isTransientAiError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const e = err as unknown as Record<string, unknown>
  if (typeof e.statusCode === 'number' && [429, 500, 502, 503, 504, 529].includes(e.statusCode as number)) return true
  if (e.isRetryable === true) return true
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return true
  if (e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT') return true
  return false
}

/**
 * Returns the sentinel code for a failed AI call.
 * Used to set skip_reason on curated_content items.
 */
export function aiSentinelCode(err: unknown): string {
  const e = err as Record<string, unknown>
  if (typeof e.statusCode === 'number' && e.statusCode === 429) return AI_SENTINEL.RATE_LIMITED
  if (isTransientAiError(err)) return AI_SENTINEL.UNAVAILABLE
  return 'ai_error'
}

async function retryOnTransient<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (!isTransientAiError(err)) throw err
      const delay = RETRY_DELAYS_MS[i] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]
      console.warn(`[ai-fallback] ${label} attempt ${i + 1} transient — retry in ${delay}ms`)
      await new Promise(r => setTimeout(r, delay))
    }
  }
  throw lastErr
}

/**
 * Generate text with fallback between DeepSeek and Gemini.
 * Default: DeepSeek primary → Gemini fallback.
 * Pass primary='gemini' to invert: Gemini Flash primary → DeepSeek fallback.
 * Retries transient errors on each provider before switching.
 * Throws if BOTH providers fail — caller should set skip_reason sentinel.
 */
export async function generateTextWithFallback(options: {
  system: string
  prompt: string
  temperature?: number
  maxOutputTokens?: number
  /** Primary provider. Default 'deepseek'. Pass 'gemini' to use Gemini 2.5 Flash first. */
  primary?: 'deepseek' | 'gemini'
}): Promise<string> {
  const useGeminiFirst = options.primary === 'gemini'

  const callDeepSeek = () => retryOnTransient(
    () => generateText({
      model: deepseek('deepseek-v4-flash'),
      system: options.system,
      prompt: options.prompt,
      temperature: options.temperature,
      maxOutputTokens: options.maxOutputTokens,
      providerOptions: { deepseek: { thinking: { type: 'disabled' } } },
    }),
    'deepseek',
  ).then(r => r.text.trim())

  // Gemini SEMPRE via OpenRouter, nunca @ai-sdk/google direto (achado 22/07/2026:
  // GOOGLE_GENERATIVE_AI_API_KEY estava vazia em produção — bug do `vercel env add`
  // sem `--value`, silenciosamente quebrava o fallback inteiro. OpenRouter já é
  // usado nesse projeto pra Gemini sem o problema de roteamento que o DeepSeek
  // tem — ver OPENROUTER_MODELS em src/lib/ai/provider.ts).
  const callGemini = () => {
    const openRouterApiKey = process.env.OPENROUTER_API_KEY
    if (!openRouterApiKey) {
      return Promise.reject(new Error('OPENROUTER_API_KEY not configured — Gemini fallback unavailable'))
    }
    const openrouter = createOpenRouter({ apiKey: openRouterApiKey })
    return retryOnTransient(
      () => generateText({
        model: openrouter('google/gemini-2.5-flash'),
        system: options.system,
        prompt: options.prompt,
        temperature: options.temperature,
        maxOutputTokens: options.maxOutputTokens,
      }),
      'gemini',
    ).then(r => r.text.trim())
  }

  const [primary, secondary, primaryLabel, secondaryLabel] = useGeminiFirst
    ? [callGemini, callDeepSeek, 'Gemini', 'DeepSeek']
    : [callDeepSeek, callGemini, 'DeepSeek', 'Gemini']

  try {
    return await primary()
  } catch (primaryErr: unknown) {
    const code = (primaryErr as Record<string, unknown>)?.statusCode
    console.warn(`[ai-fallback] ${primaryLabel} indisponível (${code}) — tentando ${secondaryLabel}`, { error: String(primaryErr) })
    return await secondary()
  }
}
