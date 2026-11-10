/**
 * Generate a Brand branded carousel (multi-image post).
 *
 * Pipeline:
 * 1. OpenAI image generation through OpenRouter BYOK × N slides, in parallel
 * 2. /api/og/brand-slide (Satori) → N editorial overlays — also in parallel
 * 3. Each slide uploaded to Supabase storage → array of public URLs returned
 */

import { getAdminClient } from '@/lib/supabase/admin'
import { getBaseUrl } from '@/lib/api/base-url'
import { detectBrand, resolveLogoUrl } from './brand-logos'
import { callOpenRouterImage } from './openrouter'

const BUCKET = 'brand-assets'
async function generateBackground(prompt: string, index: number): Promise<Buffer | null> {
  const image = await callOpenRouterImage(prompt)
  if (!image) console.warn(`[brand-carousel] OpenRouter BYOK failed for slide ${index}`)
  return image
}

export type CarouselSlide = {
  type: 'cover' | 'content' | 'cta'
  headline: string
  body?: string
  context?: string
  kpi?: string
  /** Optional per-slide image prompt. Falls back to base imagePrompt. */
  image_prompt?: string
}

export async function generatebrandCarousel(params: {
  slides: CarouselSlide[]
  imagePrompt: string
  itemId: string
}): Promise<string[] | null> {
  const supabase = getAdminClient()
  const base = getBaseUrl()
  const total = params.slides.length

  // ── Detect brand logo once for the whole carousel (fail-silent) ─────────
  const allTexts = [
    params.imagePrompt,
    ...params.slides.flatMap(s => [s.headline, s.body ?? '', s.context ?? '', s.kpi ?? '']),
  ]
  const brandMatch = detectBrand(allTexts)
  const brandLogo = brandMatch ? await resolveLogoUrl(brandMatch.domain) : null

  // ── Step 1: Generate all backgrounds in parallel ────────────────────────
  // Each slide uses its own prompt (if provided) or the shared base prompt.
  // Gemini Imagen 4.0 produces a different composition even with the same prompt.
  const bgBuffers = await Promise.all(
    params.slides.map((slide, i) =>
      generateBackground(slide.image_prompt ?? params.imagePrompt, i)
    )
  )

  // Upload all backgrounds in parallel
  const bgUrls = await Promise.all(
    bgBuffers.map(async (buf, i) => {
      if (!buf) {
        console.error(`[brand-carousel] No image buffer for slide ${i + 1} (all providers failed)`)
        return null
      }
      const bgPath = `backgrounds/${params.itemId}-${i}.png`
      const { error } = await supabase.storage
        .from(BUCKET)
        .upload(bgPath, buf, { contentType: 'image/png', upsert: true })
      if (error) {
        console.error(`[brand-carousel] Background upload failed for slide ${i + 1}:`, error.message)
        return null
      }
      return supabase.storage.from(BUCKET).getPublicUrl(bgPath).data.publicUrl
    })
  )

  // If no slide has a background at all, abort
  if (bgUrls.every(u => u === null)) {
    console.error('[brand-carousel] All background generations failed — aborting')
    return null
  }

  // ── Step 2: Render all slides via Satori in parallel ────────────────────
  const imageUrls = await Promise.all(
    params.slides.map(async (slide, i) => {
      const slideNum = String(i + 1)
      const bgUrl = bgUrls[i]

      const qs = new URLSearchParams({
        type:         slide.type,
        headline:     slide.headline,
        slide_num:    slideNum,
        total_slides: String(total),
        ...(bgUrl                              ? { bg:      bgUrl           } : {}),
        ...(slide.context                      ? { context: slide.context   } : {}),
        ...(slide.body                         ? { body:    slide.body      } : {}),
        ...(slide.kpi                          ? { kpi:     slide.kpi       } : {}),
        // Brand logo on cover + content slides; omit on CTA (has its own layout)
        ...(brandLogo && slide.type !== 'cta'  ? { logo: brandLogo.logoUrl, brand: brandLogo.name } : {}),
      })

      try {
        const satoriRes = await fetch(`${base}/api/og/brand-slide?${qs.toString()}`, {
          signal: AbortSignal.timeout(20_000),
        })

        if (!satoriRes.ok) {
          console.error(`[brand-carousel] Satori slide ${slideNum} failed:`, satoriRes.status)
          return bgUrl  // fallback to raw background
        }

        const png = new Uint8Array(await satoriRes.arrayBuffer())
        const slidePath = `carousel/${params.itemId}-${i}.png`
        const { error: upErr } = await supabase.storage
          .from(BUCKET)
          .upload(slidePath, png, { contentType: 'image/png', upsert: true })
        if (upErr) {
          console.error(`[brand-carousel] Slide ${slideNum} upload failed:`, upErr.message)
          return bgUrl  // fallback to raw background
        }

        return supabase.storage.from(BUCKET).getPublicUrl(slidePath).data.publicUrl
      } catch (err) {
        console.error(`[brand-carousel] Slide ${slideNum} exception:`, err instanceof Error ? err.message : err)
        return bgUrl  // fallback to raw background
      }
    })
  )

  // Filter nulls and require at least 2 images
  const validUrls = imageUrls.filter((u): u is string => u !== null)
  if (validUrls.length < 2) return null
  return validUrls
}
