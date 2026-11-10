import { afterEach, describe, expect, it, vi } from 'vitest'

const mockGenerateText = vi.fn()
const route = vi.fn((id: string, settings?: unknown) => ({ id, settings }))
vi.mock('ai', () => ({ generateText: (...args: unknown[]) => mockGenerateText(...args) }))
vi.mock('@openrouter/ai-sdk-provider', () => ({ createOpenRouter: () => route }))

import { AI_SENTINEL, aiSentinelCode, generateTextWithFallback, isTransientAiError } from './generate-with-fallback'

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
})

describe('generateTextWithFallback BYOK contract', () => {
  it('fails closed without OPENROUTER_API_KEY', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', '')
    await expect(generateTextWithFallback({ system: 'sys', prompt: 'prompt' })).rejects.toThrow('OPENROUTER_API_KEY')
    expect(mockGenerateText).not.toHaveBeenCalled()
  })

  it('always uses the OpenAI then Anthropic fast chain', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key')
    mockGenerateText.mockResolvedValue({ text: '  ok  ' })
    await expect(generateTextWithFallback({ system: 'sys', prompt: 'prompt', primary: 'gemini' })).resolves.toBe('ok')
    expect(mockGenerateText).toHaveBeenCalledTimes(1)
    expect(mockGenerateText.mock.calls[0][0].model).toEqual({
      id: 'openai/gpt-5-nano',
      settings: expect.objectContaining({
        provider: { only: ['openai'], allow_fallbacks: false, require_parameters: true },
      }),
    })
  })

  it('retries with Anthropic when OpenAI fails', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key')
    mockGenerateText.mockRejectedValueOnce(new Error('OpenAI failed')).mockResolvedValueOnce({ text: 'fallback' })
    await expect(generateTextWithFallback({ system: 'sys', prompt: 'prompt' })).resolves.toBe('fallback')
    expect(mockGenerateText.mock.calls.map((call) => call[0].model.id)).toEqual([
      'openai/gpt-5-nano',
      'anthropic/claude-haiku-5.5',
    ])
  })

  it('keeps transient classification and sentinels', () => {
    const rateLimit = Object.assign(new Error('limited'), { statusCode: 429 })
    expect(isTransientAiError(rateLimit)).toBe(true)
    expect(aiSentinelCode(rateLimit)).toBe(AI_SENTINEL.RATE_LIMITED)
    expect(aiSentinelCode(Object.assign(new Error('down'), { statusCode: 503 }))).toBe(AI_SENTINEL.UNAVAILABLE)
    expect(aiSentinelCode(new Error('bad'))).toBe('ai_error')
  })
})
