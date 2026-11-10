import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'fs'

const mockGenerateText = vi.fn()
const route = vi.fn((id: string, settings?: unknown) => ({ id, settings }))
vi.mock('ai', () => ({
  generateText: (...args: unknown[]) => mockGenerateText(...args),
  stepCountIs: vi.fn(() => 'stop'),
}))
vi.mock('@openrouter/ai-sdk-provider', () => ({ createOpenRouter: () => route }))

import { executeToolLoop, generateSimpleText } from './tool-loop'

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
})

describe('tool-loop routes only through OpenRouter BYOK', () => {
  it('keeps externally controlled model names out of log format strings', () => {
    const source = readFileSync(new URL('./tool-loop.ts', import.meta.url), 'utf8')
    expect(source).not.toContain('failed for "${')
  })

  it('fails closed without OPENROUTER_API_KEY', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', '')
    await expect(generateSimpleText({ model: 'claude-haiku', systemPrompt: 'sys', userMessage: 'hi' }))
      .rejects.toThrow('OPENROUTER_API_KEY')
    expect(mockGenerateText).not.toHaveBeenCalled()
  })

  it('simple text uses the ordered fast chain once', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key')
    mockGenerateText.mockResolvedValue({ text: 'ok', usage: { totalTokens: 4 } })
    await expect(generateSimpleText({ model: 'claude-haiku', systemPrompt: 'sys', userMessage: 'hi' }))
      .resolves.toEqual({ text: 'ok', tokensUsed: 4 })
    expect(mockGenerateText).toHaveBeenCalledTimes(1)
    expect(mockGenerateText.mock.calls[0][0].model.id).toBe('openai/gpt-5-nano')
  })

  it('tool execution uses the ordered quality chain once', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key')
    mockGenerateText.mockResolvedValue({ text: 'ok', usage: { totalTokens: 8 }, steps: [] })
    await expect(executeToolLoop({ model: 'claude-sonnet', systemPrompt: 'sys', messages: [{ role: 'user', content: 'hi' }] }))
      .resolves.toMatchObject({ text: 'ok', tokensUsed: 8 })
    expect(mockGenerateText).toHaveBeenCalledTimes(1)
    expect(mockGenerateText.mock.calls[0][0].model.id).toBe('openai/gpt-6.1-sol')
  })

  it('does not retry after a tool starts executing', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key')
    const execute = vi.fn().mockResolvedValue('published')
    mockGenerateText.mockImplementationOnce(async ({ tools }) => {
      await tools.publish.execute({ id: 'post-1' })
      throw new Error('OpenAI failed after tool execution')
    })

    await expect(executeToolLoop({
      model: 'claude-sonnet',
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'publish' }],
      tools: [{ name: 'publish', description: 'Publish a post', parameters: {}, execute }],
    })).rejects.toThrow('OpenAI failed after tool execution')

    expect(execute).toHaveBeenCalledTimes(1)
    expect(mockGenerateText).toHaveBeenCalledTimes(1)
  })

  it('restarts on Anthropic BYOK after an OpenAI failure', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key')
    mockGenerateText
      .mockRejectedValueOnce(new Error('OpenAI failed'))
      .mockResolvedValueOnce({ text: 'fallback', usage: { totalTokens: 5 } })
    await expect(generateSimpleText({ model: 'claude-haiku', systemPrompt: 'sys', userMessage: 'hi' }))
      .resolves.toEqual({ text: 'fallback', tokensUsed: 5 })
    expect(mockGenerateText.mock.calls.map((call) => call[0].model.id)).toEqual([
      'openai/gpt-5-nano',
      'anthropic/claude-haiku-5.5',
    ])
  })
})
