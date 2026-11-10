import { parseAIJson } from '@/lib/ai/parse-json'
import { byokFetch, OPENROUTER_APP_HEADERS } from '@/lib/ai/provider'

export interface InstagramVisualQualityScores {
  visual_quality: number
  legibility: number
  text_visual_correlation: number
  sequence_coherence: number | null
  context: number
  promise_delivery: number | null
}

export interface InstagramVisualQualityResult {
  outcome: 'approved' | 'rejected' | 'unavailable'
  passed: boolean
  score: number
  scores: InstagramVisualQualityScores
  issues: string[]
  improvements: string[]
  feedback: string
}

interface VisualAsset {
  type: 'image' | 'video'
  url: string
}

type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }

const MIN_OVERALL_SCORE = 7.2
const MAX_TOTAL_IMAGE_BYTES = 18 * 1024 * 1024
const EMPTY_SCORES: InstagramVisualQualityScores = {
  visual_quality: 0,
  legibility: 0,
  text_visual_correlation: 0,
  sequence_coherence: null,
  context: 0,
  promise_delivery: null,
}

type ScoreDimension = keyof InstagramVisualQualityScores

const FORMAT_WEIGHTS: Record<'image' | 'carousel' | 'reel', Partial<Record<ScoreDimension, number>>> = {
  image: { visual_quality: 0.25, legibility: 0.25, text_visual_correlation: 0.3, context: 0.2 },
  carousel: { visual_quality: 0.15, legibility: 0.2, text_visual_correlation: 0.2, sequence_coherence: 0.15, context: 0.15, promise_delivery: 0.15 },
  reel: { visual_quality: 0.25, legibility: 0.25, text_visual_correlation: 0.3, context: 0.2 },
}

const HARD_MINIMUMS: Record<ScoreDimension, number> = {
  visual_quality: 6,
  legibility: 7,
  text_visual_correlation: 6,
  sequence_coherence: 6,
  context: 6,
  promise_delivery: 6,
}

async function loadImageParts(assets: VisualAsset[]): Promise<Array<{ position: number; part: GeminiPart }>> {
  const imageAssets = assets
    .map((asset, index) => ({ asset, position: index + 1 }))
    .filter(({ asset }) => asset.type === 'image' && asset.url)
  const parts: Array<{ position: number; part: GeminiPart }> = []
  let totalBytes = 0

  for (const { asset, position } of imageAssets) {
    const response = await fetch(asset.url, { signal: AbortSignal.timeout(20_000) })
    if (!response.ok) throw new Error(`asset_fetch_failed:${response.status}`)
    const mimeType = response.headers.get('content-type')?.split(';')[0] ?? 'image/jpeg'
    if (!mimeType.startsWith('image/')) throw new Error(`invalid_visual_asset_type:${mimeType}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    totalBytes += bytes.length
    if (totalBytes > MAX_TOTAL_IMAGE_BYTES) throw new Error('visual_assets_too_large')
    parts.push({ position, part: { inlineData: { mimeType, data: bytes.toString('base64') } } })
  }

  return parts
}

function unavailableResult(issue: string): InstagramVisualQualityResult {
  return { outcome: 'unavailable', passed: false, score: 0, scores: EMPTY_SCORES, issues: [issue], improvements: [], feedback: issue }
}

export async function reviewInstagramVisualQuality(input: {
  caption: string
  format: 'image' | 'carousel' | 'reel'
  assets: VisualAsset[]
}): Promise<InstagramVisualQualityResult> {
  const apiKey = (process.env.OPENROUTER_API_KEY ?? '').trim()
  if (!apiKey) return unavailableResult('visual_quality_reviewer_unavailable:missing_openrouter_key')

  try {
    const imageParts = await loadImageParts(input.assets)
    if (imageParts.length === 0) return unavailableResult('visual_quality_reviewer_unavailable:no_reviewable_image')

    const models = ['openai/gpt-6.1-sol', 'anthropic/claude-sonnet-5.5']
    const containsVideo = input.assets.some((asset) => asset.type === 'video')
    const canJudgeSequence = input.format === 'carousel' && !containsVideo
    const prompt = [
      'Voce e o gate final, rigoroso e bloqueante, de qualidade de posts do Instagram.',
      `Formato: ${input.format}. Imagens anexadas: ${imageParts.length}.`,
      `Assets totais: ${input.assets.map((asset, index) => `${index + 1}:${asset.type}`).join(', ')}.`,
      `Sequencia completa observavel: ${canJudgeSequence ? 'sim' : 'nao'}.`,
      '',
      'Legenda:',
      input.caption,
      '',
      'Avalie cada dimensao de 0 a 10:',
      '- visual_quality: composicao, acabamento, consistencia de marca e ausencia de artefatos.',
      '- legibility: texto legivel no celular, sem corte, sobreposicao ou excesso.',
      '- text_visual_correlation: imagem e texto falam concretamente do mesmo assunto.',
      '- sequence_coherence: somente para carrossel composto apenas por imagens; caso contrario, null.',
      '- context: leitor entende quem, o que e por que importa sem contexto externo.',
      '- promise_delivery: somente quando a sequencia completa estiver observavel; caso contrario, null.',
      '',
      'blocking_issues deve conter SOMENTE defeitos que tornam a publicacao inaceitavel: texto ilegivel/cortado, artefato grave, contradicao clara, sequencia quebrada ou promessa comprovadamente nao entregue.',
      'improvements deve conter ajustes desejaveis que nao impedem a publicacao. Nao transforme preferencia estetica em bloqueio.',
      'Retorne somente JSON valido:',
      `{"scores":{"visual_quality":0,"legibility":0,"text_visual_correlation":0,"sequence_coherence":${canJudgeSequence ? '0' : 'null'},"context":0,"promise_delivery":${canJudgeSequence ? '0' : 'null'}},"blocking_issues":[],"improvements":[],"feedback":"frase objetiva"}`,
    ].join('\n')

    const contentParts: GeminiPart[] = [{ text: prompt }]
    for (const image of imageParts) {
      contentParts.push({ text: `Imagem na posicao ${image.position} da publicacao:` }, image.part)
    }

    let response: Response | null = null
    for (const [index, model] of models.entries()) {
      const provider = index === 0 ? 'openai' : 'anthropic'
      response = await byokFetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...OPENROUTER_APP_HEADERS },
        body: JSON.stringify({
          model,
          provider: { only: [provider], allow_fallbacks: false, require_parameters: true },
          usage: { include: true },
          max_tokens: 900,
          messages: [{
            role: 'user',
            content: contentParts.map((part) => 'text' in part
              ? { type: 'text', text: part.text }
              : { type: 'image_url', image_url: { url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}` } }),
          }],
        }),
        signal: AbortSignal.timeout(60_000),
      })
      if (response.ok) break
    }

    if (!response?.ok) return unavailableResult(`visual_quality_reviewer_error:${response?.status ?? 'unavailable'}`)
    const data = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> }
    const content = data.choices?.[0]?.message?.content
    const text = typeof content === 'string' ? content.trim() : ''
    if (!text) return unavailableResult('visual_quality_reviewer_error:empty_response')

    const parsed = parseAIJson<{
      scores: Partial<Record<ScoreDimension, number | null>>
      blocking_issues?: string[]
      improvements?: string[]
      feedback?: string
    }>(text, 'instagram visual quality review')
    const weights = { ...FORMAT_WEIGHTS[input.format] }
    if (!canJudgeSequence) {
      delete weights.sequence_coherence
      delete weights.promise_delivery
    }
    const applicable = Object.keys(weights) as ScoreDimension[]
    const scores = { ...EMPTY_SCORES }
    for (const dimension of applicable) {
      const value = Number(parsed.scores?.[dimension])
      scores[dimension] = Number.isFinite(value) ? Math.max(0, Math.min(10, value)) : 0
    }
    const hardFailures = applicable
      .filter((dimension) => (scores[dimension] ?? 0) < HARD_MINIMUMS[dimension])
      .map((dimension) => `${dimension}:${scores[dimension]}/10`)
    const weightTotal = applicable.reduce((sum, dimension) => sum + (weights[dimension] ?? 0), 0)
    const score = applicable.reduce(
      (sum, dimension) => sum + (scores[dimension] ?? 0) * (weights[dimension] ?? 0),
      0,
    ) / weightTotal
    const blockingIssues = Array.isArray(parsed.blocking_issues) ? parsed.blocking_issues : []
    const issues = [...blockingIssues, ...hardFailures]
    if (score < MIN_OVERALL_SCORE) issues.push(`overall_visual_quality:${score.toFixed(1)}/10`)
    const improvements = Array.isArray(parsed.improvements) ? parsed.improvements : []

    return {
      outcome: issues.length === 0 ? 'approved' : 'rejected',
      passed: issues.length === 0,
      score: Number(score.toFixed(1)),
      scores,
      issues,
      improvements,
      feedback: parsed.feedback?.trim() || (issues.length ? issues.join('; ') : 'Aprovado pelo gate visual'),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return unavailableResult(`visual_quality_reviewer_error:${message}`)
  }
}
