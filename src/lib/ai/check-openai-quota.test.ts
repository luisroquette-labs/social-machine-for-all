/**
 * REGRESSÃO: detecção de quota/billing da OpenAI (lacuna de monitoramento — 16/06/2026)
 *
 * A quota da OpenAI estourou e travou a geração de capas de reel por dias sem alerta.
 * isOpenAiQuotaExceeded só deve disparar (true) em 429 de quota/billing — nunca em
 * rate-limit transitório, erro de rede ou chave ausente — para não gerar alerta
 * crítico à toa no heartbeat.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { isOpenAiQuotaExceeded } from './check-openai-quota'

function res(status: number, body: unknown) {
  return { status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) } as unknown as Response
}

afterEach(() => vi.restoreAllMocks())

describe('isOpenAiQuotaExceeded', () => {
  it('200 OK → false (quota saudável)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(res(200, { choices: [{}] }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await isOpenAiQuotaExceeded('sk-test', 50)).toBe(false)
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(fetchMock.mock.calls[0][0]).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(body.provider).toEqual({ only: ['openai'], allow_fallbacks: false })
    expect(body.usage).toEqual({ include: true })
  })

  it('REGRESSÃO: 429 insufficient_quota → true (billing esgotado)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res(429, {
      error: { type: 'insufficient_quota', message: 'You exceeded your current quota' },
    })))
    expect(await isOpenAiQuotaExceeded('sk-test', 50)).toBe(true)
  })

  it('429 rate_limit_exceeded (transitório) → false (não é billing)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res(429, {
      error: { type: 'rate_limit_exceeded', message: 'Rate limit reached for gpt-4o-mini' },
    })))
    expect(await isOpenAiQuotaExceeded('sk-test', 50)).toBe(false)
  })

  it('timeout/erro de rede → false (não alerta)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(
      Object.assign(new Error('aborted'), { name: 'TimeoutError' }),
    ))
    expect(await isOpenAiQuotaExceeded('sk-test', 50)).toBe(false)
  })

  it('chave ausente → false (não faz request)', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await isOpenAiQuotaExceeded('', 50)).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
