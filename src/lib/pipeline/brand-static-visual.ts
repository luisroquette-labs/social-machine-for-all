import sharp from 'sharp'
import { executeToolLoop } from '@/lib/ai/tool-loop'
import { parseAIJsonSafe } from '@/lib/ai/parse-json'
import type { StaticNewsCandidate } from './brand-static-news'

export type StaticImageVisualAnalysis = {
  url: string
  score: number
  width: number | null
  height: number | null
  aspectRatio: number | null
  edgeDensity: number | null
  ocrChars: number
  watermarkScore: number
  screenshotScore: number
  heroShotScore: number
  multimodal?: StaticImageMultimodalJudgment | null
  reasons: string[]
}

export type StaticImageMultimodalJudgment = {
  vehicle_present: boolean
  text_heavy: boolean
  watermark: boolean
  hero_shot: boolean
  ui_screenshot: boolean
  confidence: number
  reason: string
}

type StaticImageFetchedAsset = {
  buffer: Buffer
  mimeType: string
}

function isValidMultimodalJudgment(value: unknown): value is StaticImageMultimodalJudgment {
  if (!value || typeof value !== 'object') return false
  const data = value as Record<string, unknown>
  return (
    typeof data.vehicle_present === 'boolean' &&
    typeof data.text_heavy === 'boolean' &&
    typeof data.watermark === 'boolean' &&
    typeof data.hero_shot === 'boolean' &&
    typeof data.ui_screenshot === 'boolean' &&
    typeof data.confidence === 'number' &&
    typeof data.reason === 'string'
  )
}

function normalizeText(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
}

function getOcrTexts(metrics: Record<string, unknown> | null, imageCount: number): string[] {
  const candidates = [
    metrics?.image_ocr_texts,
    metrics?.media_ocr_texts,
    metrics?.ocr_texts,
  ]

  for (const value of candidates) {
    if (Array.isArray(value)) {
      return value.map((item) => typeof item === 'string' ? item : '')
    }
  }

  const single = typeof metrics?.ocr_text === 'string' ? metrics.ocr_text : ''
  return Array.from({ length: imageCount }, (_, index) => index === 0 ? single : '')
}

function computeEdgeDensity(buffer: Buffer, width: number, height: number): number {
  let strongEdges = 0
  let comparisons = 0

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x
      const current = buffer[idx]
      if (x > 0) {
        comparisons++
        if (Math.abs(current - buffer[idx - 1]) > 28) strongEdges++
      }
      if (y > 0) {
        comparisons++
        if (Math.abs(current - buffer[idx - width]) > 28) strongEdges++
      }
    }
  }

  return comparisons > 0 ? strongEdges / comparisons : 0
}

export function scoreStaticImageAnalysis(input: {
  url: string
  width: number | null
  height: number | null
  edgeDensity: number | null
  ocrText?: string | null
}): StaticImageVisualAnalysis {
  const normalizedUrl = normalizeText(input.url)
  const normalizedOcr = normalizeText(input.ocrText ?? '')
  const ocrChars = normalizedOcr.replace(/\s+/g, '').length
  const aspectRatio = input.width && input.height ? input.width / input.height : null
  const reasons: string[] = []

  let score = 0
  let watermarkScore = 0
  let screenshotScore = 0
  let heroShotScore = 0

  if (/\b(byd|geely|chery|mg|tesla|volvo|bmw|suv|sedan|ev|phev|hybrid|car|vehicle|interior|cockpit|rear|front|side|hero)\b/.test(normalizedUrl)) {
    score += 14
    heroShotScore += 10
    reasons.push('vehicle_url_hint')
  }

  if (/\b(screenshot|screen|profile|avatar|icon|logo|banner|story|thumb|thumbnail|cover|print)\b/.test(normalizedUrl)) {
    score -= 20
    screenshotScore += 20
    reasons.push('polluted_url_hint')
  }

  if (aspectRatio !== null) {
    if (aspectRatio >= 1.15 && aspectRatio <= 1.95) {
      score += 12
      heroShotScore += 18
      reasons.push('hero_ratio')
    } else if (aspectRatio < 0.9) {
      score -= 16
      screenshotScore += 18
      reasons.push('portrait_ratio')
    } else if (aspectRatio > 2.2) {
      score -= 8
      reasons.push('ultra_wide_ratio')
    }
  }

  if (input.edgeDensity !== null) {
    if (input.edgeDensity <= 0.16) {
      score += 10
      heroShotScore += 12
      reasons.push('clean_frame')
    } else if (input.edgeDensity >= 0.28) {
      score -= 16
      screenshotScore += 22
      reasons.push('dense_edges')
    } else if (input.edgeDensity >= 0.22) {
      score -= 8
      screenshotScore += 10
      reasons.push('busy_frame')
    }
  }

  if (ocrChars >= 180) {
    score -= 28
    watermarkScore += 10
    screenshotScore += 18
    reasons.push('heavy_text')
  } else if (ocrChars >= 80) {
    score -= 14
    screenshotScore += 10
    reasons.push('moderate_text')
  } else if (ocrChars <= 18) {
    score += 6
    heroShotScore += 6
    reasons.push('low_text')
  }

  if (/@|www\.|\.com|seguir|posts|curtir|coment|compartilh|felipef|metropoles|youtube|instagram|x\.com|twitter/i.test(normalizedOcr)) {
    score -= 18
    watermarkScore += 20
    reasons.push('watermark_or_ui_text')
  }

  return {
    url: input.url,
    score,
    width: input.width,
    height: input.height,
    aspectRatio,
    edgeDensity: input.edgeDensity,
    ocrChars,
    watermarkScore,
    screenshotScore,
    heroShotScore,
    multimodal: null,
    reasons,
  }
}

async function fetchStaticImageAsset(url: string): Promise<StaticImageFetchedAsset | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(12_000) })
    if (!res.ok) return null
    const arrayBuffer = await res.arrayBuffer()
    return {
      buffer: Buffer.from(arrayBuffer),
      mimeType: res.headers.get('content-type') || 'image/jpeg',
    }
  } catch {
    return null
  }
}

export async function judgeStaticImageMultimodal(asset: StaticImageFetchedAsset): Promise<StaticImageMultimodalJudgment | null> {
  if (!process.env.OPENROUTER_API_KEY) return null

  try {
    const result = await executeToolLoop({
      model: 'deepseek-chat',
      systemPrompt: [
        'Voce avalia imagens de noticias automotivas para o Instagram da Brand.',
        'Retorne APENAS JSON valido.',
        'Classifique se a imagem mostra claramente um veiculo, se e hero shot, se tem muito texto, watermark ou interface de rede social.',
        'Use confidence de 0 a 1.',
        'JSON esperado:',
        '{"vehicle_present":true,"text_heavy":false,"watermark":false,"hero_shot":true,"ui_screenshot":false,"confidence":0.92,"reason":"..."}',
      ].join('\n'),
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Avalie esta imagem para uso editorial da Brand.' },
          { type: 'image', image: asset.buffer.toString('base64'), mimeType: asset.mimeType },
        ],
      }],
      maxSteps: 1,
      maxTokens: 400,
      temperature: 0,
    })

    return parseAIJsonSafe(result.text, isValidMultimodalJudgment, 'static-image-multimodal')
  } catch {
    return null
  }
}

export function applyMultimodalJudgment(
  analysis: StaticImageVisualAnalysis,
  judgment: StaticImageMultimodalJudgment | null,
): StaticImageVisualAnalysis {
  if (!judgment) return analysis

  let score = analysis.score
  let watermarkScore = analysis.watermarkScore
  let screenshotScore = analysis.screenshotScore
  let heroShotScore = analysis.heroShotScore
  const reasons = [...analysis.reasons]

  if (judgment.vehicle_present) {
    score += 16
    reasons.push('mm_vehicle_present')
  } else {
    score -= 28
    screenshotScore += 12
    reasons.push('mm_vehicle_absent')
  }

  if (judgment.hero_shot) {
    score += 18
    heroShotScore += 18
    reasons.push('mm_hero_shot')
  }

  if (judgment.text_heavy) {
    score -= 18
    screenshotScore += 10
    reasons.push('mm_text_heavy')
  }

  if (judgment.watermark) {
    score -= 16
    watermarkScore += 22
    reasons.push('mm_watermark')
  }

  if (judgment.ui_screenshot) {
    score -= 22
    screenshotScore += 24
    reasons.push('mm_ui_screenshot')
  }

  return {
    ...analysis,
    score,
    watermarkScore,
    screenshotScore,
    heroShotScore,
    multimodal: judgment,
    reasons,
  }
}

export async function analyzeStaticImageUrl(url: string, ocrText?: string | null): Promise<StaticImageVisualAnalysis> {
  const asset = await fetchStaticImageAsset(url)
  if (!asset) {
    return scoreStaticImageAnalysis({ url, width: null, height: null, edgeDensity: null, ocrText })
  }

  try {
    const image = sharp(asset.buffer)
    const resized = await image
      .rotate()
      .greyscale()
      .resize(64, 64, { fit: 'cover' })
      .raw()
      .toBuffer({ resolveWithObject: true })

    const meta = await sharp(asset.buffer).metadata()
    const edgeDensity = computeEdgeDensity(resized.data, resized.info.width, resized.info.height)

    return scoreStaticImageAnalysis({
      url,
      width: meta.width ?? null,
      height: meta.height ?? null,
      edgeDensity,
      ocrText,
    })
  } catch {
    return scoreStaticImageAnalysis({ url, width: null, height: null, edgeDensity: null, ocrText })
  }
}

export async function refineStaticNewsCandidateMedia(candidate: StaticNewsCandidate): Promise<StaticNewsCandidate> {
  if (!candidate.image_urls.length) return candidate

  const ocrTexts = getOcrTexts(candidate.source_metrics, candidate.image_urls.length)
  const heuristicAnalyses = await Promise.all(
    candidate.image_urls.map((url, index) => analyzeStaticImageUrl(url, ocrTexts[index] ?? ''))
  )

  const multimodalCandidates = [...heuristicAnalyses]
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)

  const multimodalMap = new Map<string, StaticImageVisualAnalysis>()
  await Promise.all(
    multimodalCandidates.map(async (analysis) => {
      const asset = await fetchStaticImageAsset(analysis.url)
      if (!asset) {
        multimodalMap.set(analysis.url, analysis)
        return
      }
      const judgment = await judgeStaticImageMultimodal(asset)
      multimodalMap.set(analysis.url, applyMultimodalJudgment(analysis, judgment))
    }),
  )

  const analyses = heuristicAnalyses.map((analysis) => multimodalMap.get(analysis.url) ?? analysis)

  const filtered = analyses
    .filter((item) => item.score > -18)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)

  const imageUrls = filtered.map((item) => item.url)

  return {
    ...candidate,
    media_mode: imageUrls.length > 0 ? 'curated_image' : 'generated_image',
    image_urls: imageUrls,
    primary_image_url: imageUrls[0] ?? null,
    metadata: {
      ...candidate.metadata,
      visual_selection: analyses,
    },
  }
}
