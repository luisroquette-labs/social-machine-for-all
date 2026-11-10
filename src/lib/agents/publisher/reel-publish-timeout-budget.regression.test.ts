/**
 * REGRESSÃO: orçamento de tempo do publish de Reel nunca pode ultrapassar o
 * maxDuration=300s de /api/agents/[slug]/run (bug 2026-07-14).
 *
 * Causa raiz do incidente: o render (Remotion Lambda, até 240s) rodava em paralelo com a
 * geração de capa, e era seguido — sequencialmente — da criação de container + poll de
 * status do Instagram (até 120s). Os orçamentos internos foram definidos de forma
 * independente, sem checar a SOMA contra o maxDuration da função que os hospeda:
 * 240s (render) + 120s (poll IG) = 360s > 300s (maxDuration). Isso GARANTIA que qualquer
 * execução que legitimamente precisasse perto do teto de ambas as etapas fosse morta pelo
 * Vercel no meio do caminho, deixando o item órfão em status='publishing' — não era uma
 * falha rara, era uma violação estrutural do orçamento.
 *
 * Auditoria adicional (mesma investigação) encontrou 3 chamadas AWS Lambda SEM NENHUM
 * timeout — cobertas apenas pelo laço de deadline externo, que só verifica ENTRE
 * chamadas, não durante uma chamada individual travada:
 *   - renderMediaOnLambda (disparo do render) — podia travar antes mesmo do polling começar
 *   - getRenderProgress (cada poll) — podia travar além do próprio deadline
 *   - renderStillOnLambda (capa AI&Tech) — mesma classe de risco
 * E o TYPE 2 (slideshow) gerava as imagens dos slides em SEQUÊNCIA — um custo aditivo
 * (N × até 90s) em vez de paralelo (bounded pelo mais lento), o que por si só já
 * ultrapassava 300s antes mesmo de somar o render e o publish.
 *
 * Este teste não fixa valores arbitrários — ele fixa a INVARIANTE: a soma do pior caso de
 * cada etapa deve caber com folga dentro do maxDuration. Se alguém aumentar um timeout
 * individual no futuro sem checar a soma, este teste quebra.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const PUBLISHER_SRC = readFileSync(join(process.cwd(), 'src/lib/agents/publisher/index.ts'), 'utf-8')
const IG_CLIENT_SRC = readFileSync(join(process.cwd(), 'src/lib/platforms/instagram/client.ts'), 'utf-8')
const brand_COVER_SRC = readFileSync(join(process.cwd(), 'src/lib/ai/generate-brand-reel-cover.ts'), 'utf-8')
const OPENAI_IMAGE_SRC = readFileSync(join(process.cwd(), 'src/lib/ai/openai-image.ts'), 'utf-8')
const AGENT_RUN_SRC = readFileSync(join(process.cwd(), 'src/app/api/agents/[slug]/run/route.ts'), 'utf-8')

// waitForContainer() is called from multiple publish methods (image, carousel, reel) with
// DIFFERENT timeout budgets each — must scope to publishReel specifically, or extraction
// silently grabs publishImage's unrelated 30_000 instead of publishReel's real value.
const PUBLISH_REEL_SRC = IG_CLIENT_SRC.slice(IG_CLIENT_SRC.indexOf('async publishReel('))

/** Extrai o número que aparece logo ANTES de `, 'label')` — usado pelas chamadas envolvidas em promiseWithTimeout(promise, ms, 'label'). */
function extractTimeoutForLabel(src: string, label: string): number {
  const re = new RegExp(`(\\d[\\d_]*),\\s*'${label}'\\)`)
  const match = src.match(re)
  if (!match) throw new Error(`no timeout found for label: ${label}`)
  return Number(match[1].replace(/_/g, ''))
}

/** Extrai o número atribuído a um parâmetro dentro de uma janela de texto a partir de um marcador de função/objeto. */
function extractParamDefault(src: string, fnMarker: string, paramName: string, windowSize = 400): number {
  const idx = src.indexOf(fnMarker)
  if (idx === -1) throw new Error(`marker not found: ${fnMarker}`)
  const slice = src.slice(idx, idx + windowSize)
  const re = new RegExp(`${paramName}\\s*=\\s*(\\d[\\d_]*)`)
  const match = slice.match(re)
  if (!match) throw new Error(`param not found: ${paramName} near ${fnMarker}`)
  return Number(match[1].replace(/_/g, ''))
}

function extractNumber(src: string, marker: string, windowSize = 200): number {
  const idx = src.indexOf(marker)
  if (idx === -1) throw new Error(`marker not found: ${marker}`)
  const after = src.slice(idx + marker.length, idx + marker.length + windowSize)
  const match = after.match(/(\d[\d_]*)/)
  if (!match) throw new Error(`no number found after marker: ${marker}`)
  return Number(match[1].replace(/_/g, ''))
}

describe('REGRESSÃO: orçamento de timeout do publish de Reel cabe no maxDuration (bug 2026-07-14)', () => {
  it('/api/agents/[slug]/run declara maxDuration explícito', () => {
    expect(AGENT_RUN_SRC).toContain('export const maxDuration = 300')
  })

  it('toda chamada AWS Lambda (Remotion) e todo fetch crítico do publish tem timeout — nenhum pode travar indefinidamente', () => {
    // Antes do fix: renderMediaOnLambda, getRenderProgress e renderStillOnLambda rodavam
    // sem NENHUM timeout — cobertos só pelo laço de deadline, que não limita uma chamada
    // individual travada.
    expect(PUBLISHER_SRC).toContain('await promiseWithTimeout(renderMediaOnLambda(')
    expect(PUBLISHER_SRC).toContain('await promiseWithTimeout(getRenderProgress(')
    expect(PUBLISHER_SRC).toContain('await promiseWithTimeout(renderStillOnLambda(')

    // Fetches que não tinham NENHUM timeout: criação de container IG, media_publish,
    // fetchPermalink e a capa via Railway em generateReelCover.
    const igMediaPost = IG_CLIENT_SRC.slice(IG_CLIENT_SRC.indexOf("media_type: 'REELS'"))
    expect(igMediaPost.slice(0, 550)).toContain('AbortSignal.timeout')

    const waitForContainerFn = IG_CLIENT_SRC.slice(IG_CLIENT_SRC.indexOf('private async waitForContainer'))
    expect(waitForContainerFn.slice(0, 600)).toContain('AbortSignal.timeout')

    const fetchPermalinkFn = IG_CLIENT_SRC.slice(IG_CLIENT_SRC.indexOf('private async fetchPermalink'))
    expect(fetchPermalinkFn.slice(0, 400)).toContain('AbortSignal.timeout')

    const railwayCoverFetch = PUBLISHER_SRC.slice(PUBLISHER_SRC.indexOf("fetch(`${RENDER_API_URL}/cover`"))
    expect(railwayCoverFetch.slice(0, 700)).toContain('AbortSignal.timeout')
  })

  it('geração de imagens dos slides (TYPE 2) roda em PARALELO, não em sequência', () => {
    // Sequencial escalava com o número de slides (N × até 90s cada); paralelo é limitado
    // pela chamada mais lenta, independente de N.
    const slideshowBlock = PUBLISHER_SRC.slice(
      PUBLISHER_SRC.indexOf('TYPE 2: Slideshow'),
      PUBLISHER_SRC.indexOf("renderWithRemotion('SlideshowReel'"),
    )
    expect(slideshowBlock).toContain('await Promise.all(reelData.slides.map(')
    expect(slideshowBlock).not.toMatch(/for\s*\(let i = 0; i < reelData\.slides\.length/)
  })

  it('soma do pior caso do pipeline Brand (TYPE 1: render/capa em paralelo + Instagram sequencial) cabe com folga em 300s', () => {
    // Etapa paralela: render do vídeo (Remotion) vs. geração de capa — vale o mais lento dos dois.
    const remotionMaxWaitDefaultMs = extractParamDefault(PUBLISHER_SRC, 'async function renderWithRemotion(', 'maxWaitMs')
    const remotionKickoffTimeoutMs = extractTimeoutForLabel(PUBLISHER_SRC, 'renderMediaOnLambda kickoff')
    const remotionPollTimeoutMs = extractTimeoutForLabel(PUBLISHER_SRC, 'getRenderProgress poll')
    const remotionPollIntervalMs = extractNumber(PUBLISHER_SRC, 'setTimeout(r, ')
    // Pior caso: disparo + (deadline de polling + 1 intervalo + 1 timeout de poll na última iteração)
    const remotionWorstCaseMs = remotionKickoffTimeoutMs + remotionMaxWaitDefaultMs + remotionPollIntervalMs + remotionPollTimeoutMs

    const imageTimeoutMs = extractNumber(brand_COVER_SRC, 'callOpenRouterImage(prompt, ')
    const satoriSectionSrc = brand_COVER_SRC.slice(brand_COVER_SRC.indexOf('Render editorial overlay via Satori'))
    const satoriTimeoutMs = extractNumber(satoriSectionSrc, 'signal: AbortSignal.timeout(')
    const brandCoverWorstCaseMs = imageTimeoutMs + satoriTimeoutMs

    const parallelStepWorstCaseMs = Math.max(remotionWorstCaseMs, brandCoverWorstCaseMs)

    // Etapa sequencial: criação de container IG + poll de status + media_publish + fetchPermalink.
    const containerCreateTimeoutMs = extractNumber(IG_CLIENT_SRC, "body: JSON.stringify(containerBody),\n      signal: AbortSignal.timeout(")
    const igPollTimeoutMs = extractNumber(PUBLISH_REEL_SRC, 'const ready = await this.waitForContainer(creationId, accessToken, ')
    const mediaPublishTimeoutMs = extractNumber(IG_CLIENT_SRC, "headers: this.jsonHeaders(),\n      signal: AbortSignal.timeout(")
    const fetchPermalinkTimeoutMs = extractNumber(IG_CLIENT_SRC, 'private async fetchPermalink', 400)

    const sequentialStepWorstCaseMs = containerCreateTimeoutMs + igPollTimeoutMs + mediaPublishTimeoutMs + fetchPermalinkTimeoutMs

    const totalWorstCaseMs = parallelStepWorstCaseMs + sequentialStepWorstCaseMs
    const maxDurationMs = extractNumber(AGENT_RUN_SRC, 'export const maxDuration = ') * 1000

    // Exige pelo menos 30s de folga para overhead não coberto pelos timeouts explícitos
    // (fetch de credenciais, queries no Supabase, parsing).
    const MIN_SAFETY_MARGIN_MS = 30_000
    expect(totalWorstCaseMs).toBeLessThan(maxDurationMs - MIN_SAFETY_MARGIN_MS)
  })

  it('soma do pior caso do pipeline Slideshow (TYPE 2: slides em paralelo + render + Instagram, tudo sequencial entre si) cabe com folga em 300s', () => {
    // TYPE 2 não tem etapa paralela entre geração de conteúdo e render — a geração de
    // slides roda ANTES do render, então os custos são ADITIVOS, não bounded pelo maior.
    const slideImageWorstCaseMs = extractNumber(OPENAI_IMAGE_SRC, 'callOpenRouterImage(prompt, ')

    const slideshowMaxWaitMs = (() => {
      const callSite = PUBLISHER_SRC.slice(PUBLISHER_SRC.indexOf("renderWithRemotion('SlideshowReel'"))
      const match = callSite.slice(0, 200).match(/maxRendersPerDay,\s*(\d[\d_]*)\)/)
      if (!match) throw new Error('SlideshowReel call site does not pass an explicit maxWaitMs')
      return Number(match[1].replace(/_/g, ''))
    })()
    const remotionKickoffTimeoutMs = extractTimeoutForLabel(PUBLISHER_SRC, 'renderMediaOnLambda kickoff')
    const remotionPollTimeoutMs = extractTimeoutForLabel(PUBLISHER_SRC, 'getRenderProgress poll')
    const remotionPollIntervalMs = extractNumber(PUBLISHER_SRC, 'setTimeout(r, ')
    const slideshowRemotionWorstCaseMs = remotionKickoffTimeoutMs + slideshowMaxWaitMs + remotionPollIntervalMs + remotionPollTimeoutMs

    const containerCreateTimeoutMs = extractNumber(IG_CLIENT_SRC, "body: JSON.stringify(containerBody),\n      signal: AbortSignal.timeout(")
    const igPollTimeoutMs = extractNumber(PUBLISH_REEL_SRC, 'const ready = await this.waitForContainer(creationId, accessToken, ')
    const mediaPublishTimeoutMs = extractNumber(IG_CLIENT_SRC, "headers: this.jsonHeaders(),\n      signal: AbortSignal.timeout(")
    const fetchPermalinkTimeoutMs = extractNumber(IG_CLIENT_SRC, 'private async fetchPermalink', 400)
    const sequentialStepWorstCaseMs = containerCreateTimeoutMs + igPollTimeoutMs + mediaPublishTimeoutMs + fetchPermalinkTimeoutMs

    const totalWorstCaseMs = slideImageWorstCaseMs + slideshowRemotionWorstCaseMs + sequentialStepWorstCaseMs
    const maxDurationMs = extractNumber(AGENT_RUN_SRC, 'export const maxDuration = ') * 1000

    const MIN_SAFETY_MARGIN_MS = 20_000 // TYPE 2 é aditivo por natureza — folga menor é aceitável, mas não zero
    expect(totalWorstCaseMs).toBeLessThan(maxDurationMs - MIN_SAFETY_MARGIN_MS)
  })

  it('render do Remotion (default) não pode voltar ao cap antigo de 240s — era a causa raiz do estouro', () => {
    const remotionMaxWaitDefaultMs = extractParamDefault(PUBLISHER_SRC, 'async function renderWithRemotion(', 'maxWaitMs')
    expect(remotionMaxWaitDefaultMs).toBeLessThanOrEqual(120_000)
  })

  it('poll de status do container do Instagram no publishReel não pode voltar ao cap antigo de 120s', () => {
    const igPollTimeoutMs = extractNumber(PUBLISH_REEL_SRC, 'const ready = await this.waitForContainer(creationId, accessToken, ')
    expect(igPollTimeoutMs).toBeLessThanOrEqual(90_000)
  })
})
