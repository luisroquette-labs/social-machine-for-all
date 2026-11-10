/**
 * REGRESSÃO: grade do Instagram do @brand desalinhada (07/07/2026).
 *
 * A grade do perfil do Instagram exibe thumbnails em 3:4 desde 2025. Os posts
 * do brand saíam em 1:1 (feed IA + assets de marketing), 4:5 (carrossel) e
 * 9:16 (capa de reel) — a grade cortava laterais dos quadrados e topo/rodapé
 * das capas (pill do logo e watermark decepados). Reclamação do usuário com
 * screenshot da grade.
 *
 * Verificado empiricamente em 07/07/2026: a Graph API ACEITA containers de
 * imagem e carrossel em 3:4 (1080x1440) — status FINISHED.
 *
 * Padrão blindado:
 *  - Feed IA (brand-post) e carrossel (brand-slide): canvas 1080x1440 (3:4).
 *  - Background do feed IA: OpenAI vertical 2:3; overlay final recorta em 3:4.
 *  - Capa de reel: canvas continua 1080x1920 (exigência dos Reels), mas pills e
 *    watermark ficam DENTRO da zona central 3:4 (GRID_CROP=240px cortados de
 *    cada lado na grade).
 *  - Assets de marketing pré-feitos (1:1): publicados via moldura 3:4
 *    (/api/og/brand-asset-frame) que centraliza o asset no canvas 1080x1440.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8')

describe('REGRESSÃO: canvas 3:4 nos formatos de feed', () => {
  it('brand-post (feed IA) é 1080x1440', () => {
    const src = read('src/app/api/og/brand-post/route.tsx')
    expect(src).toMatch(/WIDTH\s*=\s*1080/)
    expect(src).toMatch(/HEIGHT\s*=\s*1440/)
    expect(src).not.toMatch(/HEIGHT\s*=\s*1080/)
  })

  it('brand-slide (carrossel) é 1080x1440', () => {
    const src = read('src/app/api/og/brand-slide/route.tsx')
    expect(src).toMatch(/WIDTH\s*=\s*1080/)
    expect(src).toMatch(/HEIGHT\s*=\s*1440/)
    expect(src).not.toMatch(/HEIGHT\s*=\s*1350/)
  })

  it('background do feed IA usa a rota OpenRouter com composição vertical', () => {
    const src = read('src/lib/ai/generate-brand-post-image.ts')
    const openRouterSrc = read('src/lib/ai/openrouter.ts')
    expect(src).toContain('callOpenRouterImage(prompt)')
    expect(openRouterSrc).toMatch(/aspectRatio: '1:1' \| '2:3' \| '3:2' = '2:3'/)
  })
})

describe('REGRESSÃO: capa de reel respeita a zona central 3:4 da grade', () => {
  // Grade corta 240px do topo e 240px do rodapé de um 1080x1920.
  const src = read('src/app/api/og/brand-reel-cover/route.tsx')

  it('define GRID_CROP = 240', () => {
    expect(src).toMatch(/GRID_CROP\s*=\s*240/)
  })

  it('brand pill e category pill ficam abaixo do corte superior', () => {
    const matches = src.match(/top:\s*GRID_CROP\s*\+/g) ?? []
    expect(matches.length, 'os 2 pills do topo devem usar GRID_CROP').toBeGreaterThanOrEqual(2)
    // nenhum pill pode voltar para top: PAD (posição cortada pela grade)
    expect(src).not.toMatch(/position:\s*'absolute',\s*top:\s*PAD,/)
  })

  it('watermark @brand fica acima do corte inferior', () => {
    expect(src).toMatch(/bottom:\s*GRID_CROP\s*\+/)
    expect(src).not.toMatch(/bottom:\s*42,/)
  })
})

describe('REGRESSÃO: assets de marketing 1:1 publicam via moldura 3:4', () => {
  it('a rota brand-asset-frame existe com canvas 1080x1440', () => {
    const src = read('src/app/api/og/brand-asset-frame/route.tsx')
    expect(src).toMatch(/WIDTH\s*=\s*1080/)
    expect(src).toMatch(/HEIGHT\s*=\s*1440/)
  })

  it('publishNextMarketingAsset publica a moldura (persistida no Storage), não o asset cru', () => {
    const src = read('src/lib/pipeline/brand-marketing-assets.ts')
    expect(src).toContain('brand-asset-frame')
    expect(src).toMatch(/publishImage\(cleanCaption,\s*frameToPublish/)
    expect(src).not.toMatch(/publishImage\(cleanCaption,\s*asset\.public_url/)
  })
})
