/**
 * Generate a Brand branded Reel cover image (9:16).
 *
 * Pipeline:
 * 1. OpenAI image generation through OpenRouter BYOK
 * 2. /api/og/brand-reel-cover (Satori) → editorial overlay (hookTitle + highlight + branding)
 * 3. Result uploaded to Supabase storage → public URL returned
 */

import { getAdminClient } from '@/lib/supabase/admin'
import { getBaseUrl } from '@/lib/api/base-url'
import { callOpenRouterImage } from './openrouter'

const BUCKET = 'brand-assets'
async function generateBackground(prompt: string): Promise<Buffer | null> {
  return callOpenRouterImage(prompt, 45_000)
}

export async function generatebrandReelCover(params: {
  hookTitle: string
  highlightName: string
  imagePrompt: string
  itemId: string
  kpi?: string
}): Promise<string | null> {
  const supabase = getAdminClient()
  const base = getBaseUrl()

  // ── Step 1: Generate photorealistic 9:16 background (Gemini → gpt-image-1 fallback) ───
  const bgBuffer = await generateBackground(params.imagePrompt)
  if (!bgBuffer) {
    console.warn('[brand-reel-cover] All providers failed — Satori-only cover (no bg photo)')
  }

  let bgUrl = ''
  if (bgBuffer) {
    const bgPath = `reel-covers/bg-${params.itemId}.png`
    const { error: bgErr } = await supabase.storage
      .from(BUCKET)
      .upload(bgPath, bgBuffer, { contentType: 'image/png', upsert: true })
    if (bgErr) {
      console.warn('[brand-reel-cover] Background upload failed:', bgErr.message, '— continuing without bg')
    } else {
      bgUrl = supabase.storage.from(BUCKET).getPublicUrl(bgPath).data.publicUrl
    }
  }

  // ── Step 2: Render editorial overlay via Satori (works with or without bg) ─────────
  const qs = new URLSearchParams({
    hookTitle:     params.hookTitle,
    highlightName: params.highlightName,
    ...(bgUrl ? { bg: bgUrl } : {}),
    ...(params.kpi ? { kpi: params.kpi } : {}),
  })

  try {
    const satoriRes = await fetch(`${base}/api/og/brand-reel-cover?${qs.toString()}`, {
      signal: AbortSignal.timeout(20_000),
    })

    if (!satoriRes.ok) {
      console.error('[brand-reel-cover] Satori render failed:', satoriRes.status)
      return bgUrl  // fallback: raw background
    }

    const finalPng = new Uint8Array(await satoriRes.arrayBuffer())
    const finalPath = `reel-covers/${params.itemId}.png`
    const { error: upErr } = await supabase.storage
      .from(BUCKET)
      .upload(finalPath, finalPng, { contentType: 'image/png', upsert: true })
    if (upErr) {
      console.error('[brand-reel-cover] Final upload failed:', upErr.message)
      return bgUrl  // fallback: raw background
    }

    return supabase.storage.from(BUCKET).getPublicUrl(finalPath).data.publicUrl
  } catch (err) {
    console.error('[brand-reel-cover] Satori exception:', err instanceof Error ? err.message : err)
    return bgUrl  // fallback: raw background
  }
}
