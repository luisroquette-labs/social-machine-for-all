import { afterEach, describe, expect, it, vi } from 'vitest'
import { reviewInstagramVisualQuality } from './instagram-visual-quality'

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.OPENROUTER_API_KEY
})

const image = () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } })

describe('visual reviewer OpenRouter BYOK contract', () => {
  it('sends the ordered OpenAI then Anthropic chain', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key'
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(image())
      .mockResolvedValueOnce(Response.json({
        model: 'openai/gpt-6.1-sol', usage: { is_byok: true },
        choices: [{ message: { content: JSON.stringify({
          scores: { visual_quality: 8, legibility: 8, text_visual_correlation: 8, sequence_coherence: null, context: 8, promise_delivery: null },
          blocking_issues: [], improvements: [], feedback: 'ok',
        }) } }],
      }))
    vi.stubGlobal('fetch', fetchMock)
    await reviewInstagramVisualQuality({ caption: 'c', format: 'image', assets: [{ type: 'image', url: 'https://example.com/a.png' }] })
    const body = JSON.parse(fetchMock.mock.calls[1][1].body)
    expect(body.model).toBe('openai/gpt-6.1-sol')
    expect(body.provider).toEqual({ only: ['openai'], allow_fallbacks: false, require_parameters: true })
    expect(body.usage).toEqual({ include: true })
  })

  it('fails closed when OpenRouter omits BYOK proof', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key'
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(image())
      .mockResolvedValueOnce(Response.json({ model: 'openai/gpt-6.1-sol', usage: {}, choices: [] }))
      .mockResolvedValueOnce(Response.json({ model: 'anthropic/claude-sonnet-5.5', usage: { is_byok: false }, choices: [] })))
    const result = await reviewInstagramVisualQuality({ caption: 'c', format: 'image', assets: [{ type: 'image', url: 'https://example.com/a.png' }] })
    expect(result).toMatchObject({ outcome: 'unavailable', passed: false })
    expect(result.issues[0]).toContain('visual_quality_reviewer_error:403')
  })
})
