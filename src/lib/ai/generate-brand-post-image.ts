/**
 * Generate a Brand branded feed image.
 *
 * Pipeline:
 * 1. OpenAI image generation through OpenRouter BYOK
 * 2. /api/og/brand-post (Satori) → editorial overlay (headline + KPI + branding)
 * 3. Result uploaded to Supabase storage → public URL returned
 */

import { getAdminClient } from '@/lib/supabase/admin'
import { getBaseUrl } from '@/lib/api/base-url'
import { detectBrand, resolveLogoUrl } from './brand-logos'
import { callOpenRouterImage } from './openrouter'

const BUCKET = 'brand-assets'
async function generateBackground(prompt: string): Promise<Buffer | null> {
  return callOpenRouterImage(prompt)
}

export async function generatebrandPostImage(params: {
  headline: string
  context: string
  kpi?: string
  imagePrompt: string
  itemId: string
}): Promise<string | null> {
  const supabase = getAdminClient()
  const base = getBaseUrl()

  // ── Step 1: Generate photorealistic background (Gemini → gpt-image-1 fallback) ──────
  const bgBuffer = await generateBackground(params.imagePrompt)
  if (!bgBuffer) {
    console.error('[brand-image] All image providers failed — aborting')
    return null
  }

  let bgUrl: string | null = null

  const bgPath = `backgrounds/${params.itemId}.png`
  const { error: bgErr } = await supabase.storage
    .from(BUCKET)
    .upload(bgPath, bgBuffer, { contentType: 'image/png', upsert: true })
  if (bgErr) {
    console.error('[brand-image] Background upload failed:', bgErr.message)
    return null
  }
  bgUrl = supabase.storage.from(BUCKET).getPublicUrl(bgPath).data.publicUrl

  // ── Step 2: Detect brand logo (fail-silent — badge is cosmetic) ────────
  const brandMatch = detectBrand([params.headline, params.context, params.kpi ?? '', params.imagePrompt])
  const brandLogo = brandMatch ? await resolveLogoUrl(brandMatch.domain) : null

  // ── Step 3: Render editorial overlay via Satori ─────────────────────────
  const qs = new URLSearchParams({
    headline: params.headline,
    context: params.context,
    ...(params.kpi        ? { kpi:   params.kpi }      : {}),
    ...(bgUrl             ? { bg:    bgUrl }            : {}),
    ...(brandLogo         ? { logo:  brandLogo.logoUrl, brand: brandLogo.name } : {}),
  })

  let finalUrl: string | null = bgUrl  // fallback: raw background if Satori fails

  try {
    const satoriRes = await fetch(`${base}/api/og/brand-post?${qs.toString()}`, {
      signal: AbortSignal.timeout(20_000),
    })

    if (!satoriRes.ok) {
      console.error('[brand-image] Satori render failed:', satoriRes.status)
    } else {
      const finalPng = new Uint8Array(await satoriRes.arrayBuffer())
      const finalPath = `posts/${params.itemId}.png`
      const { error: upErr } = await supabase.storage
        .from(BUCKET)
        .upload(finalPath, finalPng, { contentType: 'image/png', upsert: true })
      if (upErr) {
        console.error('[brand-image] Final upload failed:', upErr.message)
      } else {
        finalUrl = supabase.storage.from(BUCKET).getPublicUrl(finalPath).data.publicUrl
      }
    }
  } catch (err) {
    console.error('[brand-image] Satori exception:', err instanceof Error ? err.message : err)
  }

  return finalUrl
}
