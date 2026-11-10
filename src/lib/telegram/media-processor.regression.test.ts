import { afterEach, describe, expect, it, vi } from 'vitest'

import { processVoice } from './media-processor'

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.OPENROUTER_API_KEY
})

describe('Telegram transcription uses OpenAI BYOK', () => {
  it('routes audio only through OpenRouter and requires proof', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key'
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: true, result: { file_path: 'voice.ogg' } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])))
      .mockResolvedValueOnce(Response.json({
        model: 'openai/gpt-audio-mini',
        usage: { is_byok: true },
        choices: [{ message: { content: 'transcrição' } }],
      }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(processVoice('bot', 'file', 3)).resolves.toMatchObject({ data: 'transcrição' })
    const request = fetchMock.mock.calls[2]
    expect(request[0]).toBe('https://openrouter.ai/api/v1/chat/completions')
    const body = JSON.parse(request[1].body)
    expect(body.provider).toEqual({ only: ['openai'], allow_fallbacks: false, require_parameters: true })
    expect(body.usage).toEqual({ include: true })
  })
})
