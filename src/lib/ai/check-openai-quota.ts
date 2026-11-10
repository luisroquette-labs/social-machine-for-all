/**
 * Probe barato para detectar quota/billing ESGOTADA da OpenAI.
 *
 * Por que existe (16/06/2026):
 * A quota da OpenAI estourou e derrubou a geração das capas de reel por dias, sem
 * nenhum alerta — o heartbeat checava token IG e créditos do Twitter, mas não a
 * OpenAI. Este probe fecha essa lacuna de monitoramento.
 *
 * Faz uma chamada mínima (GPT-5 Nano via OpenAI BYOK, 1 token) e retorna true
 * SOMENTE em 429 de quota/billing (insufficient_quota). NUNCA retorna true em
 * rate-limit transitório, erro de rede ou 5xx — para não disparar alerta crítico à
 * toa. insufficient_quota é a nível de conta (billing), então o probe de texto
 * detecta corretamente o problema que também trava o gpt-image-1.
 */
import { byokFetch, OPENROUTER_APP_HEADERS } from './provider'

export async function isOpenAiQuotaExceeded(apiKey: string, timeoutMs = 15_000): Promise<boolean> {
  if (!apiKey) return false
  try {
    const res = await byokFetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...OPENROUTER_APP_HEADERS },
      body: JSON.stringify({
        model: 'openai/gpt-5-nano',
        provider: { only: ['openai'], allow_fallbacks: false },
        usage: { include: true },
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })

    if (res.status !== 429) return false

    // 429 pode ser rate-limit (transitório) OU insufficient_quota (billing). Só o
    // segundo é alerta crítico — distinguir pelo corpo do erro.
    const body = await res.text()
    return /insufficient_quota|exceeded your current quota|billing hard limit/i.test(body)
  } catch {
    // timeout / rede / parse → transitório, não alerta
    return false
  }
}
