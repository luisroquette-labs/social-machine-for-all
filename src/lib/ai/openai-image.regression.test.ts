import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({
    storage: {
      from: () => ({
        upload: vi.fn().mockResolvedValue({ error: null }),
        getPublicUrl: vi.fn().mockReturnValue({ data: { publicUrl: 'https://example.com/img.png' } }),
      }),
    },
  }),
}))

const provedImage = () => Response.json({
  model: 'openai/gpt-5-image-mini',
  usage: { is_byok: true },
  data: [{ b64_json: Buffer.from('png').toString('base64') }],
})

describe('OpenAI image routing is OpenRouter BYOK-only', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    process.env.OPENROUTER_API_KEY = 'test-key'
  })

  afterEach(() => {
    delete process.env.OPENROUTER_API_KEY
  })

  it('persists a proved BYOK image with exact provider metadata', async () => {
    mockFetch.mockResolvedValueOnce(provedImage())
    const { generateStoredImageWithMetadata } = await import('./openai-image')
    const result = await generateStoredImageWithMetadata({ prompt: 'test', path: 'covers/test.png' })
    expect(result).toMatchObject({
      url: 'https://example.com/img.png',
      provider: 'openrouter',
      model: 'openai/gpt-5-image-mini',
      attempts: [expect.objectContaining({ status: 'success' })],
    })
    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.provider).toEqual({ only: ['openai'], allow_fallbacks: false })
    expect(body.usage).toEqual({ include: true })
  })

  it('fails closed without the OpenRouter key', async () => {
    delete process.env.OPENROUTER_API_KEY
    const { generateStoredImage } = await import('./openai-image')
    await expect(generateStoredImage({ prompt: 'test' })).resolves.toBeNull()
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('rejects an image response without BYOK proof', async () => {
    mockFetch.mockResolvedValueOnce(Response.json({
      model: 'openai/gpt-5-image-mini',
      usage: { is_byok: false },
      data: [{ b64_json: Buffer.from('png').toString('base64') }],
    }))
    const { generateStoredImage } = await import('./openai-image')
    await expect(generateStoredImage({ prompt: 'test' })).resolves.toBeNull()
  })
})

// ── Testes do highlight falso positivo ───────────────────────────────────────

// ── Testes do highlight falso positivo ───────────────────────────────────────

describe('REGRESSÃO: highlight falso positivo em preposições curtas', () => {
  it('isHighlighted não destaca "DE" por causa de "DEEPSEEK" na paleta', () => {
    // "DE" (2 chars) não deve ativar h.startsWith("DE") em "DEEPSEEK"
    const routeSource = fs.readFileSync(REEL_ROUTE, 'utf-8')
    // Garante que a guarda de comprimento mínimo está presente
    expect(routeSource).toContain('key.length >= 3')
  })

  it('isHighlighted destaca "GPT" normalmente (3 chars, não afetado pela guarda)', () => {
    const routeSource = fs.readFileSync(REEL_ROUTE, 'utf-8')
    // GPT tem 3 chars — ainda é elegível para h.startsWith("GPT")
    expect(routeSource).toContain('key.length >= 3 && h.startsWith(key)')
  })
})

// ── Testes do gradiente fallback no Satori ───────────────────────────────────

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __testdir = path.dirname(fileURLToPath(import.meta.url))
const REEL_ROUTE = path.resolve(__testdir, '../../app/api/og/reel/route.tsx')
const REELS_PREPARE_ROUTE = path.resolve(__testdir, '../../app/api/cron/reels-prepare/route.ts')
const REELS_PUBLISH_ROUTE = path.resolve(__testdir, '../../app/api/cron/reels-publish/route.ts')

describe('REGRESSÃO: reels-prepare bloqueia reel sem backgroundUrl', () => {
  it('contém gate que bloqueia insert quando backgroundUrl está undefined', () => {
    const src = fs.readFileSync(REELS_PREPARE_ROUTE, 'utf-8')
    // Gate deve existir antes do "Insert reel_ready"
    expect(src).toContain('if (!backgroundUrl)')
    expect(src).toContain('background_gate')
  })

  it('usa level error para TODAS as falhas de imagem (não só billing)', () => {
    const src = fs.readFileSync(REELS_PREPARE_ROUTE, 'utf-8')
    // Não deve haver warning para falhas de background — tudo é error
    expect(src).not.toContain("isBilling ? 'error' : 'warning'")
    expect(src).not.toContain('level: \'warning\'')
  })
})

describe('REGRESSÃO: reels-publish bloqueia publicação sem foto de fundo', () => {
  it('gate primário: checa reelData.backgroundUrl ANTES de qualquer render', () => {
    const src = fs.readFileSync(REELS_PUBLISH_ROUTE, 'utf-8')
    // Gate deve existir ANTES do quality gate de caption
    const bgGateIdx = src.indexOf('if (!reelData.backgroundUrl)')
    const captionGateIdx = src.indexOf('Caption too short')
    expect(bgGateIdx).toBeGreaterThan(-1)
    expect(bgGateIdx).toBeLessThan(captionGateIdx)
    expect(src).toContain('no_background_generated')
  })

  it('generateEditorialCover recebe reelData.backgroundUrl (foto bruta), nunca Remotion output', () => {
    const src = fs.readFileSync(REELS_PUBLISH_ROUTE, 'utf-8')
    // Deve usar a foto bruta da OpenAI como fundo do Satori
    expect(src).toContain('backgroundUrl: reelData.backgroundUrl')
    // NUNCA deve usar o output do Remotion como fundo (título já embutido → duplo)
    expect(src).not.toContain('coverResult.status === \'fulfilled\' && coverResult.value ? coverResult.value')
  })

  it('gate secundário: checa coverUrl após render (defesa em profundidade)', () => {
    const src = fs.readFileSync(REELS_PUBLISH_ROUTE, 'utf-8')
    expect(src).toContain('if (!coverUrl)')
    expect(src).toContain('no_cover_generated')
  })

  it('não usa cover_url condicional — coverUrl garantido pelos gates anteriores', () => {
    const src = fs.readFileSync(REELS_PUBLISH_ROUTE, 'utf-8')
    expect(src).not.toContain('if (coverUrl) containerBody.cover_url')
  })
})

describe('REGRESSÃO: gradiente fallback no /api/og/reel (sem fundo preto)', () => {
  it('rota define paletas de gradiente para marcas conhecidas e gradiente default', () => {
    const src = fs.readFileSync(REEL_ROUTE, 'utf-8')

    // Garante que a paleta existe com marcas-chave
    expect(src).toContain("OPENAI:")
    expect(src).toContain("NVIDIA:")
    expect(src).toContain("ANTHROPIC:")
    expect(src).toContain('DEFAULT_GRADIENT')
    expect(src).toContain('getFallbackGradient')
  })

  it('rota usa gradiente temático quando não há bgUrl (elimina fundo preto puro)', () => {
    const src = fs.readFileSync(REEL_ROUTE, 'utf-8')

    // fallbackGradient calculado quando bgUrl está vazio
    expect(src).toContain('fallbackGradient')
    // Render condicional: imagem OU gradiente (nunca só preto)
    expect(src).toContain('bgUrl ?')
    expect(src).toContain('background: fallbackGradient')
  })
})
