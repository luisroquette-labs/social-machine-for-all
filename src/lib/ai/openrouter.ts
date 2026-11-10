import { OPENROUTER_APP_HEADERS } from './provider'

export const OPENROUTER_IMAGE_MODEL = 'openai/gpt-5-image-mini'

async function hasByokEvidence(
  response: Response,
  data: { id?: unknown; model?: unknown; usage?: { is_byok?: unknown } },
  apiKey: string,
  deadline: number,
): Promise<boolean> {
  if (data.usage?.is_byok === true && data.model === OPENROUTER_IMAGE_MODEL) return true
  const generationId = response.headers.get('x-generation-id') ?? (typeof data.id === 'string' ? data.id : null)
  if (!generationId) return false

  while (Date.now() < deadline) {
    const evidence = await fetch(`https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(generationId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(Math.max(1, Math.min(5_000, deadline - Date.now()))),
    })
    if (evidence.ok) {
      const metadata = await evidence.json().catch(() => null) as {
        data?: { is_byok?: unknown; model?: unknown }
      } | null
      if (metadata?.data?.is_byok === true && metadata.data.model === OPENROUTER_IMAGE_MODEL) return true
    }
    const delay = Math.min(1_000, deadline - Date.now())
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
  }
  return false
}

/** OpenAI image generation through OpenRouter; missing BYOK proof fails closed. */
export async function callOpenRouterImage(
  prompt: string,
  timeoutMs = 90_000,
  aspectRatio: '1:1' | '2:3' | '3:2' = '2:3',
): Promise<Buffer | null> {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) return null
  const deadline = Date.now() + timeoutMs

  try {
    const response = await fetch('https://openrouter.ai/api/v1/images', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...OPENROUTER_APP_HEADERS },
      body: JSON.stringify({
        model: OPENROUTER_IMAGE_MODEL,
        prompt,
        aspect_ratio: aspectRatio,
        n: 1,
        provider: { only: ['openai'], allow_fallbacks: false },
        usage: { include: true },
      }),
      signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    })
    if (!response.ok) {
      console.warn(`[openrouter] image generation failed: ${response.status}`, await response.text().catch(() => ''))
      return null
    }

    const data = await response.json() as {
      id?: unknown
      model?: unknown
      data?: Array<{ b64_json?: string }>
      usage?: { is_byok?: unknown }
    }
    if (!await hasByokEvidence(response, data, apiKey, Math.min(deadline, Date.now() + 30_000))) {
      console.warn('[openrouter] image BYOK/model evidence missing')
      return null
    }
    const encoded = data.data?.[0]?.b64_json
    return encoded ? Buffer.from(encoded, 'base64') : null
  } catch (error) {
    console.warn('[openrouter] image generation exception:', error instanceof Error ? error.message : error)
    return null
  }
}
