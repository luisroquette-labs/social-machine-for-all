import { randomUUID } from 'crypto'
import { getAdminClient } from '@/lib/supabase/admin'
import { callOpenRouterImage, OPENROUTER_IMAGE_MODEL } from './openrouter'

const DEFAULT_BUCKET = 'reels'
const OPENROUTER_IMAGE_MODEL_LABEL = OPENROUTER_IMAGE_MODEL
type ImageProvider = 'openrouter'

export interface ImageGenerationAttempt {
  provider: ImageProvider
  model: string
  status: 'success' | 'failed' | 'skipped'
  error: string | null
  startedAt: string
  completedAt: string
}

export interface StoredImageGenerationResult {
  url: string
  provider: ImageProvider
  model: string
  promptOriginal: string
  promptFinal: string
  negativePrompt: string | null
  seed: number | null
  size: '1024x1024' | '1024x1536' | '1536x1024'
  bucket: string
  storagePath: string
  contentType: 'image/png'
  params: Record<string, unknown>
  attempts: ImageGenerationAttempt[]
}

function buildAttempt(params: {
  provider: ImageProvider
  model: string
  status: ImageGenerationAttempt['status']
  startedAt: string
  error?: string | null
}): ImageGenerationAttempt {
  return {
    provider: params.provider,
    model: params.model,
    status: params.status,
    error: params.error ?? null,
    startedAt: params.startedAt,
    completedAt: new Date().toISOString(),
  }
}

async function generateWithFallback(
  prompt: string,
  _size: '1024x1024' | '1024x1536' | '1536x1024',
): Promise<{ buffer: Buffer; provider: ImageProvider; model: string; attempts: ImageGenerationAttempt[] } | null> {
  const startedAt = new Date().toISOString()
  const aspectRatio = _size === '1024x1024' ? '1:1' : _size === '1536x1024' ? '3:2' : '2:3'
  const buffer = await callOpenRouterImage(prompt, 90_000, aspectRatio)
  const attempts = [buildAttempt({
    provider: 'openrouter',
    model: OPENROUTER_IMAGE_MODEL_LABEL,
    status: buffer ? 'success' : 'failed',
    startedAt,
    error: buffer ? null : 'openrouter_byok_failed_or_unverified',
  })]
  return buffer ? { buffer, provider: 'openrouter', model: OPENROUTER_IMAGE_MODEL_LABEL, attempts } : null
}

export async function generateStoredImageWithMetadata(params: {
  prompt: string
  path?: string
  bucket?: string
  size?: '1024x1024' | '1024x1536' | '1536x1024'
  providerChain?: string[] | string
}): Promise<StoredImageGenerationResult | null> {
  const {
    prompt,
    path = `generated/${randomUUID()}.png`,
    bucket = DEFAULT_BUCKET,
    size = '1024x1536',
  } = params

  const supabase = getAdminClient()

  const generated = await generateWithFallback(prompt, size)
  if (!generated) return null

  const { error } = await supabase.storage
    .from(bucket)
    .upload(path, generated.buffer, { contentType: 'image/png', upsert: true })

  if (error) {
    console.error('[openai-image] storage upload failed:', error.message)
    return null
  }

  return {
    url: supabase.storage.from(bucket).getPublicUrl(path).data.publicUrl,
    provider: generated.provider,
    model: generated.model,
    promptOriginal: prompt,
    promptFinal: prompt,
    negativePrompt: null,
    seed: null,
    size,
    bucket,
    storagePath: path,
    contentType: 'image/png',
    attempts: generated.attempts,
    params: {
      size,
      output_format: 'png',
      quality: 'medium',
    },
  }
}

export async function generateStoredImage(params: {
  prompt: string
  path?: string
  bucket?: string
  size?: '1024x1024' | '1024x1536' | '1536x1024'
  providerChain?: string[] | string
}): Promise<string | null> {
  const result = await generateStoredImageWithMetadata(params)
  return result?.url ?? null
}
