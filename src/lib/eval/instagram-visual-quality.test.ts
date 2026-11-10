import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reviewInstagramVisualQuality } from './instagram-visual-quality'

describe('reviewInstagramVisualQuality', () => {
  beforeEach(() => {
    delete process.env.OPENROUTER_API_KEY
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.OPENROUTER_API_KEY
  })

  it('fails closed when the reviewer is unavailable', async () => {
    const result = await reviewInstagramVisualQuality({
      caption: 'Legenda contextual',
      format: 'image',
      assets: [{ type: 'image', url: 'https://example.com/post.png' }],
    })
    expect(result.passed).toBe(false)
    expect(result.outcome).toBe('unavailable')
    expect(result.issues[0]).toContain('missing_openrouter_key')
  })

  it('blocks a clear failure below the dimension hard floor', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key'
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === 'https://example.com/post.png') {
        return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } })
      }
      return Response.json({ model: 'openai/gpt-6.1-sol', usage: { is_byok: true }, choices: [{ message: { content: JSON.stringify({
        scores: { visual_quality: 9, legibility: 9, text_visual_correlation: 5, sequence_coherence: null, context: 8, promise_delivery: null },
        blocking_issues: [],
        improvements: [],
        feedback: 'Imagem não comprova o que a legenda afirma.',
      }) } }] })
    }))

    const result = await reviewInstagramVisualQuality({
      caption: 'Legenda contextual que promete uma demonstração concreta.',
      format: 'image',
      assets: [{ type: 'image', url: 'https://example.com/post.png' }],
    })

    expect(result.passed).toBe(false)
    expect(result.outcome).toBe('rejected')
    expect(result.issues).toContain('text_visual_correlation:5/10')
  })

  it('approves good work and preserves optional improvements', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key'
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === 'https://example.com/post.png') {
        return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } })
      }
      return Response.json({ model: 'openai/gpt-6.1-sol', usage: { is_byok: true }, choices: [{ message: { content: JSON.stringify({
        scores: { visual_quality: 9, legibility: 9, text_visual_correlation: 8, sequence_coherence: null, context: 8, promise_delivery: null },
        blocking_issues: [],
        improvements: ['Aumentar discretamente o contraste seria opcional.'],
        feedback: 'Aprovado.',
      }) } }] })
    }))

    const result = await reviewInstagramVisualQuality({
      caption: 'Legenda contextual e coerente com a imagem.',
      format: 'image',
      assets: [{ type: 'image', url: 'https://example.com/post.png' }],
    })

    expect(result.passed).toBe(true)
    expect(result.outcome).toBe('approved')
    expect(result.score).toBe(8.5)
    expect(result.improvements).toHaveLength(1)
  })

  it('can approve a consistent piece with scores between 7 and 8', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key'
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === 'https://example.com/post.png') {
        return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } })
      }
      return Response.json({ model: 'openai/gpt-6.1-sol', usage: { is_byok: true }, choices: [{ message: { content: JSON.stringify({
        scores: { visual_quality: 7.4, legibility: 7.2, text_visual_correlation: 7.5, sequence_coherence: null, context: 7.3, promise_delivery: null },
        blocking_issues: [],
        improvements: ['Refinar o contraste no próximo ciclo.'],
        feedback: 'Publicável, com refinamento opcional.',
      }) } }] })
    }))

    const result = await reviewInstagramVisualQuality({
      caption: 'Legenda clara e coerente com a imagem.',
      format: 'image',
      assets: [{ type: 'image', url: 'https://example.com/post.png' }],
    })

    expect(result.passed).toBe(true)
    expect(result.score).toBeGreaterThanOrEqual(7.2)
    expect(result.improvements).toHaveLength(1)
  })

  it('does not require sequence scores for a reel cover', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key'
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === 'https://example.com/cover.png') {
        return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } })
      }
      return Response.json({ model: 'openai/gpt-6.1-sol', usage: { is_byok: true }, choices: [{ message: { content: JSON.stringify({
        scores: { visual_quality: 8, legibility: 8, text_visual_correlation: 8, sequence_coherence: null, context: 8, promise_delivery: null },
        blocking_issues: [],
        improvements: [],
        feedback: 'Capa adequada.',
      }) } }] })
    }))

    const result = await reviewInstagramVisualQuality({
      caption: 'Legenda contextual.',
      format: 'reel',
      assets: [{ type: 'video', url: 'https://example.com/video.mp4' }, { type: 'image', url: 'https://example.com/cover.png' }],
    })

    expect(result.passed).toBe(true)
    expect(result.scores.sequence_coherence).toBeNull()
    expect(result.scores.promise_delivery).toBeNull()
  })
})
