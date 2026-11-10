import { afterEach, describe, expect, it, vi } from 'vitest'

const route = vi.fn((id: string, settings?: unknown) => ({ id, settings }))
vi.mock('@openrouter/ai-sdk-provider', () => ({ createOpenRouter: () => route }))

import { byokFetch, getModel, listModels } from './provider'

describe('OpenRouter BYOK provider policy', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('fails closed without the project OpenRouter key', () => {
    vi.stubEnv('OPENROUTER_API_KEY', '')
    expect(() => getModel('deepseek-chat')).toThrow('OPENROUTER_API_KEY')
  })

  it.each([
    ['claude-haiku', ['openai/gpt-5-nano', 'anthropic/claude-haiku-5.5']],
    ['claude-sonnet', ['openai/gpt-6.1-sol', 'anthropic/claude-sonnet-5.5']],
    ['deepseek-chat', ['openai/gpt-6.1-sol', 'anthropic/claude-sonnet-5.5']],
    ['deepseek-reasoner', ['openai/gpt-6-astra', 'anthropic/claude-opus-5.5']],
  ])('maps %s to one ordered fail-closed chain', (name, models) => {
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key')
    expect(getModel(name)).toEqual({
      id: models[0],
      settings: {
        provider: { only: ['openai'], allow_fallbacks: false, require_parameters: true },
        usage: { include: true },
      },
    })
  })

  it('selects the matching Anthropic fallback explicitly', () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key')
    expect(getModel('claude-haiku', 'anthropic')).toEqual({
      id: 'anthropic/claude-haiku-5.5',
      settings: {
        provider: { only: ['anthropic'], allow_fallbacks: false, require_parameters: true },
        usage: { include: true },
      },
    })
  })

  it('preserves stored raw model aliases', () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key')
    expect(getModel('deepseek-v4-flash')).toEqual(expect.objectContaining({ id: 'openai/gpt-6.1-sol' }))
    expect(getModel('claude-sonnet-4-6')).toEqual(expect.objectContaining({ id: 'openai/gpt-6.1-sol' }))
  })

  it('lists only supported stored model names', () => {
    expect(listModels()).toEqual(['claude-sonnet', 'claude-haiku', 'deepseek-chat', 'deepseek-reasoner'])
  })

  it.each([
    [{ model: 'openai/gpt-5-nano', usage: {} }, 'BYOK_UNVERIFIED'],
    [{ model: 'openai/gpt-5-nano', usage: { is_byok: false } }, 'BYOK_POLICY_VIOLATION'],
    [{ model: 'openai/other', usage: { is_byok: true } }, 'BYOK_MODEL_MISMATCH'],
  ])('rejects unproved or mismatched responses', async (body, error) => {
    const response = await byokFetch(
      'https://openrouter.ai/api/v1/chat/completions',
      { method: 'POST', body: JSON.stringify({ models: ['openai/gpt-5-nano', 'anthropic/claude-haiku-5.5'] }) },
      vi.fn().mockResolvedValue(Response.json(body)),
    )
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error })
  })

  it('accepts exact model plus usage.is_byok=true', async () => {
    const response = await byokFetch(
      'https://openrouter.ai/api/v1/chat/completions',
      { method: 'POST', body: JSON.stringify({ model: 'openai/gpt-5-nano' }) },
      vi.fn().mockResolvedValue(Response.json({ model: 'openai/gpt-5-nano', usage: { is_byok: true } })),
    )
    expect(response.status).toBe(200)
  })
})
