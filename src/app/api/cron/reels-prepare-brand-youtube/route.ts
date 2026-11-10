/**
 * REGRESSÃO: reels-prepare-brand-youtube
 *
 * Bug raiz (Jun/2026): 101 candidatos YouTube passavam EV_KEYWORDS mas NUNCA eram preparados.
 * Causa: o cron X (reels-prepare-brand) tem TIME_BUDGET=240s e timeout Railway=90s.
 * yt-dlp precisa de 30-120s para baixar um vídeo YouTube — timeout de 90s é insuficiente.
 * Resultado: AbortError silencioso, item skipado, nenhum YouTube chegava à fila reel_ready.
 *
 * Fix: cron dedicado com TIME_BUDGET=270s e timeout Railway=180s.
 * Sentinel yt_timeout (6h TTL) evita drenar budget no mesmo item repetidamente.
 *
 * Regression tests: reels-prepare-brand-youtube.regression.test.ts
 */

export const maxDuration = 300

import * as Sentry from '@sentry/nextjs'
import { NextResponse } from 'next/server'
import { isCronRequest } from '@/lib/api/auth'
import { getAdminClient } from '@/lib/supabase/admin'
import { getVariable, getNumericVariable } from '@/lib/settings/load-settings'
import { generateStoredImage } from '@/lib/ai/openai-image'
import { generateTextWithFallback, aiSentinelCode, AI_SENTINEL } from '@/lib/ai/generate-with-fallback'
import { isBrazilRelevantbrandSource } from '@/lib/pipeline/brand-brazil-launch'
import {
  EV_KEYWORDS,
  TESLA_EV_CONTEXT,
  brandImageFallback,
  buildDallePrompt,
  parseSrtToFrames,
  buildbrandAiPrompt,
} from '../reels-prepare-brand/_shared'
import { hasNegativeEvFraming } from '@/lib/brand/brand-brand-safety'

export { EV_KEYWORDS, isBrazilRelevantbrandSource } // re-export for regression tests

const WORKSPACE_ID = process.env.WORKSPACE_ID?.trim() ?? ''
const REEL_RENDERER_URL = process.env.REEL_RENDERER_URL || ''
const REEL_RENDERER_API_KEY = process.env.REEL_RENDERER_API_KEY || ''

const QUEUE_CAP = 12
// 270s budget — leaves 30s for Vercel overhead within maxDuration=300s
const TIME_BUDGET_MS = 270_000
// 180s Railway timeout — gives yt-dlp its full 120s + Whisper transcription + Supabase upload
const YT_RAILWAY_TIMEOUT_MS = 180_000
// Overhead budget needed AFTER Railway returns: AI generation + DALL-E image + DB insert
const POST_RAILWAY_OVERHEAD_MS = 60_000
// Sentinel: skip item for 6h after Railway timeout — prevents repeated budget drain
export const YT_TIMEOUT_SENTINEL = 'yt_timeout'
const YT_TIMEOUT_TTL_HOURS = 6

export async function GET(request: Request) {
  if (!isCronRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!WORKSPACE_ID) {
    return NextResponse.json({ error: 'WORKSPACE_ID is not configured' }, { status: 503 })
  }

  const [instagramHandle, minRelevanceScore, lookbackHours, candidateLimit, reelPrepModel, reelPrepMaxTokens] = await Promise.all([
    getVariable(WORKSPACE_ID, 'instagram_handle'),
    getNumericVariable(WORKSPACE_ID, 'reel_min_relevance_score'),
    getNumericVariable(WORKSPACE_ID, 'reel_lookback_hours'),
    getNumericVariable(WORKSPACE_ID, 'reel_candidate_limit'),
    getVariable(WORKSPACE_ID, 'reel_prep_model'),
    getNumericVariable(WORKSPACE_ID, 'reel_prep_max_tokens'),
  ])

  const supabase = getAdminClient()
  const lookbackCutoff = new Date(Date.now() - (lookbackHours || 48) * 60 * 60 * 1000).toISOString()

  // ── Reset expired sentinels (including yt_timeout which this cron sets) ──
  await supabase
    .from('curated_content')
    .update({ skip_reason: null, skip_until: null })
    .eq('workspace_id', WORKSPACE_ID)
    .in('skip_reason', [AI_SENTINEL.RATE_LIMITED, AI_SENTINEL.UNAVAILABLE, AI_SENTINEL.PUBLISH_FAILED, YT_TIMEOUT_SENTINEL])
    .lt('skip_until', new Date().toISOString())

  const limit = candidateLimit || 20
  const minScore = minRelevanceScore || 20
  const sentinelFilter = `skip_reason.is.null,skip_reason.not.in.(${AI_SENTINEL.RATE_LIMITED},${AI_SENTINEL.UNAVAILABLE},${AI_SENTINEL.PUBLISH_FAILED},${YT_TIMEOUT_SENTINEL})`

  const { data: ytCandidates } = await supabase
    .from('curated_content')
    .select('id, source_url, source_content, source_author, relevance_score, source_metrics, source_platform')
    .eq('workspace_id', WORKSPACE_ID)
    .eq('source_platform', 'youtube')
    .in('status', ['curated', 'written'])
    .not('source_url', 'is', null)
    .gte('created_at', lookbackCutoff)
    .gte('relevance_score', minScore)
    .or(sentinelFilter)
    .order('relevance_score', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(limit)

  if (!ytCandidates?.length) {
    return NextResponse.json({ ok: true, skipped: 'no_youtube_candidates' })
  }

  const videoItems = ytCandidates.filter(c => {
    const text = c.source_content || ''
    // Brand safety: EV associado a perigo nunca vira reel — este cron insere
    // DIRETO como reel_ready, sem reviewer. Ver src/lib/brand/brand-brand-safety.ts.
    if (hasNegativeEvFraming(text)) return false
    if (!EV_KEYWORDS.test(text) && !TESLA_EV_CONTEXT.test(text)) return false
    const cleanText = text.replace(/https?:\/\/\S+/g, '').replace(/@\w+/g, '').trim()
    if (cleanText.length < 40) return false
    if (!isBrazilRelevantbrandSource(text)) return false
    return true
  })

  if (!videoItems.length) {
    return NextResponse.json({ ok: true, skipped: 'no_ev_youtube_content', total: ytCandidates.length })
  }

  // ── Check existing reel queue (shared with X cron) ──
  const { count: existingReady, error: qErr1 } = await supabase
    .from('generated_content')
    .select('*', { count: 'exact', head: true })
    .eq('workspace_id', WORKSPACE_ID)
    .eq('target_format', 'reel')
    .eq('status', 'reel_ready')
  if (qErr1) {
    // Guard 42703: erro de query não lança no supabase-js — surfar no Sentry, nunca engolir
    Sentry.captureException(new Error(`reels-prepare-brand-youtube generated_content.reel_ready: ${qErr1.message}`), { tags: { cron: 'reels-prepare-brand-youtube', step: 'db_query_guard' } })
  }

  const slotsToFill = Math.max(0, QUEUE_CAP - (existingReady ?? 0))
  if (slotsToFill === 0) {
    return NextResponse.json({ ok: true, skipped: 'queue_full', existingReady })
  }

  // ── Railway warmup — YouTube requires Railway (yt-dlp), no fallback ──
  let railwayReady = false
  try {
    const warmRes = await fetch(`${REEL_RENDERER_URL}/health`, {
      headers: { Authorization: `Bearer ${REEL_RENDERER_API_KEY}` },
      signal: AbortSignal.timeout(15_000),
    })
    railwayReady = warmRes.ok
    if (!railwayReady) {
      await new Promise(r => setTimeout(r, 10_000))
      const retry = await fetch(`${REEL_RENDERER_URL}/health`, {
        headers: { Authorization: `Bearer ${REEL_RENDERER_API_KEY}` },
        signal: AbortSignal.timeout(20_000),
      })
      railwayReady = retry.ok
    }
  } catch { /* will be caught below */ }

  if (!railwayReady) {
    // YouTube processing requires Railway yt-dlp — cannot proceed without it
    console.warn('[reels-prepare-brand-youtube] Railway unavailable — skipping YouTube run')
    return NextResponse.json({ ok: true, skipped: 'railway_unavailable', candidates: videoItems.length })
  }

  // ── Pre-flight: image provider availability ──
  const hasOpenRouter = !!process.env.OPENROUTER_API_KEY
  console.log(`[reels-prepare-brand-youtube] OpenRouter BYOK image provider: ${hasOpenRouter}`)
  if (!hasOpenRouter) {
    Sentry.captureMessage('reels-prepare-brand-youtube: OPENROUTER_API_KEY missing', { level: 'error' })
  }

  const prepared: string[] = []
  const skippedReasons: Record<string, number> = {}
  const usedIds = new Set<string>()
  const runStart = Date.now()

  for (const v of videoItems) {
    if (prepared.length >= slotsToFill) break

    // ── Time budget guard: need enough time for Railway + AI + image generation ──
    const remainingBudget = TIME_BUDGET_MS - (Date.now() - runStart)
    if (remainingBudget < YT_RAILWAY_TIMEOUT_MS + POST_RAILWAY_OVERHEAD_MS) break

    if (usedIds.has(v.id)) continue

    const { count, error: qErr2 } = await supabase
      .from('generated_content')
      .select('*', { count: 'exact', head: true })
      .eq('curated_content_id', v.id)
      .eq('target_format', 'reel')
      .not('status', 'in', '("failed","rejected")')
  if (qErr2) {
    // Guard 42703: erro de query não lança no supabase-js — surfar no Sentry, nunca engolir
    Sentry.captureException(new Error(`reels-prepare-brand-youtube generated_content.recent_by_source: ${qErr2.message}`), { tags: { cron: 'reels-prepare-brand-youtube', step: 'db_query_guard' } })
  }
    if ((count ?? 0) > 0) { skippedReasons.dedup = (skippedReasons.dedup ?? 0) + 1; continue }

    // ── YouTube: Railway downloads via yt-dlp + transcribes + returns Supabase video URL ──
    let videoUrl = ''
    let srtText = ''
    let fullText = v.source_content || ''

    try {
      const trRes = await fetch(`${REEL_RENDERER_URL}/transcribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${REEL_RENDERER_API_KEY}` },
        body: JSON.stringify({ video_url: v.source_url, return_video_url: true }),
        signal: AbortSignal.timeout(YT_RAILWAY_TIMEOUT_MS),
      })

      if (!trRes.ok) {
        let errBody = ''
        try { errBody = await trRes.text() } catch { /* ignore */ }
        console.error(`[reels-prepare-brand-youtube] Railway failed status=${trRes.status} url=${v.source_url}`)
        if (!skippedReasons.yt_railway_error) {
          Sentry.captureMessage(
            `reels-prepare-brand-youtube: Railway yt-dlp failing — ${trRes.status}: ${errBody.slice(0, 100)}`,
            { level: 'error', tags: { cron: 'reels-prepare-brand-youtube', step: 'yt_railway' } },
          )
        }
        skippedReasons.yt_railway_error = (skippedReasons.yt_railway_error ?? 0) + 1
        continue
      }

      const tr = JSON.parse(await trRes.text()) as { srt?: string; text?: string; video_url?: string }
      if (!tr.video_url) {
        console.log(`[reels-prepare-brand-youtube] Railway sem video_url para: ${v.source_url}`)
        skippedReasons.yt_no_video_url = (skippedReasons.yt_no_video_url ?? 0) + 1
        continue
      }
      videoUrl = tr.video_url
      const hasRealSpeech = (tr.text?.length ?? 0) > 30 && !/^[♪🎶\s]+$/.test(tr.text ?? '')
      if (hasRealSpeech) { srtText = tr.srt || ''; fullText = tr.text || fullText }
    } catch (err) {
      const isTimeout = err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')
      if (isTimeout) {
        // Mark item with yt_timeout sentinel — Railway timed out, don't retry for YT_TIMEOUT_TTL_HOURS
        const skipUntil = new Date(Date.now() + YT_TIMEOUT_TTL_HOURS * 60 * 60 * 1000).toISOString()
        await supabase.from('curated_content')
          .update({ skip_reason: YT_TIMEOUT_SENTINEL, skip_until: skipUntil })
          .eq('id', v.id)
        console.warn(`[reels-prepare-brand-youtube] Railway timeout for ${v.source_url} — skip for ${YT_TIMEOUT_TTL_HOURS}h`)
        skippedReasons.yt_timeout = (skippedReasons.yt_timeout ?? 0) + 1
      } else {
        console.error(`[reels-prepare-brand-youtube] Railway error: ${err instanceof Error ? err.message : err}`)
        skippedReasons.yt_railway_error = (skippedReasons.yt_railway_error ?? 0) + 1
      }
      continue
    }

    try {
      // ── AI: EV-themed hook + caption ──
      const aiText = await generateTextWithFallback({
        primary: (reelPrepModel ?? '').startsWith('gemini') ? 'gemini' : 'deepseek',
        system: `Você é uma API JSON. Retorne SOMENTE JSON válido, sem markdown, sem explicações, sem texto fora do JSON. Você é o copywriter sênior do ${instagramHandle} — perfil de Instagram B2B sobre mobilidade elétrica, eletropostos e infraestrutura EV no Brasil.`,
        prompt: buildbrandAiPrompt({ srtText, instagramHandle, sourceContent: v.source_content || '', fullText }),
        maxOutputTokens: reelPrepMaxTokens || 2000,
      })

      const jsonStart = aiText.indexOf('{')
      const jsonEnd = aiText.lastIndexOf('}')
      if (jsonStart === -1 || jsonEnd <= jsonStart) {
        console.error(`[reels-prepare-brand-youtube] No JSON braces for ${v.id} — raw: ${JSON.stringify(aiText.slice(0, 300))}`)
        skippedReasons.ai_no_json = (skippedReasons.ai_no_json ?? 0) + 1
        continue
      }
      const jsonStr = aiText.slice(jsonStart, jsonEnd + 1)

      let meta: { srt_ptbr: string; hookTitle: string; highlightWords: string[]; subtitle: string; caption: string; imagePrompt?: string; kpi?: string }
      try { meta = JSON.parse(jsonStr) } catch (parseErr) {
        console.error(`[reels-prepare-brand-youtube] Malformed JSON for ${v.id}:`, parseErr instanceof Error ? parseErr.message : parseErr)
        skippedReasons.ai_bad_json = (skippedReasons.ai_bad_json ?? 0) + 1
        continue
      }

      // ── Cover background (DALL-E / Gemini image) ──
      let backgroundUrl: string | undefined
      const imagePrompt = typeof meta.imagePrompt === 'string' && meta.imagePrompt.length >= 20
        ? meta.imagePrompt
        : brandImageFallback(v.source_content || '')
      try {
        const url = await generateStoredImage({
          prompt: buildDallePrompt(imagePrompt, v.source_content || '').slice(0, 3800),
          path: `covers/brand-bg-${v.id}.png`,
        })
        if (url) backgroundUrl = url
      } catch (err) {
        Sentry.captureMessage(
          `reels-prepare-brand-youtube: OpenAI background failed — ${err instanceof Error ? err.message.slice(0, 120) : err}`,
          { level: 'error' },
        )
      }

      // Gate: NEVER queue without cinematic background (Cláusula Pétrea §2)
      if (!backgroundUrl) {
        Sentry.captureMessage(
          `reels-prepare-brand-youtube: background_gate blocked ${v.id} — all image providers failed`,
          { level: 'error', tags: { cron: 'reels-prepare-brand-youtube', step: 'background_gate', author: v.source_author ?? v.id } },
        )
        console.error(`[reels-prepare-brand-youtube] Blocked ${v.id} — no backgroundUrl`)
        skippedReasons.background_gate = (skippedReasons.background_gate ?? 0) + 1
        continue
      }

      // ── Insert reel_ready ──
      const subtitles = parseSrtToFrames(meta.srt_ptbr || '', 30)
      const { error: insertError } = await supabase.from('generated_content').insert({
        workspace_id: WORKSPACE_ID,
        curated_content_id: v.id,
        target_platform: 'instagram',
        target_format: 'reel',
        content: JSON.stringify({
          videoUrl,
          backgroundUrl,
          subtitles,
          hookTitle: meta.hookTitle,
          highlightWords: meta.highlightWords,
          subtitle: meta.subtitle,
          kpi: meta.kpi,
          caption: meta.caption,
          sourceAuthor: v.source_author,
          imagePrompt: meta.imagePrompt,
        }),
        status: 'reel_ready',
        model_used: reelPrepModel || 'gemini-2.5-flash',
      })

      if (insertError) {
        Sentry.captureException(new Error(insertError.message), { tags: { cron: 'reels-prepare-brand-youtube' } })
        console.error('[reels-prepare-brand-youtube] Insert failed:', insertError.message)
        continue
      }

      await supabase.from('curated_content').update({ status: 'written' }).eq('id', v.id)
      usedIds.add(v.id)
      prepared.push(v.source_author ?? v.id)
      console.log(`[reels-prepare-brand-youtube] ✓ Prepared ${prepared.length}/${slotsToFill}: @${v.source_author}`)
    } catch (loopErr) {
      const sentinel = aiSentinelCode(loopErr)
      if (sentinel === AI_SENTINEL.RATE_LIMITED || sentinel === AI_SENTINEL.UNAVAILABLE) {
        const resetHours = sentinel === AI_SENTINEL.RATE_LIMITED ? 4 : 2
        const skipUntil = new Date(Date.now() + resetHours * 60 * 60 * 1000).toISOString()
        console.warn(`[reels-prepare-brand-youtube] AI ${sentinel} for @${v.source_author} — skip for ${resetHours}h`)
        await supabase.from('curated_content').update({ skip_reason: sentinel, skip_until: skipUntil }).eq('id', v.id)
        skippedReasons[sentinel] = (skippedReasons[sentinel] ?? 0) + 1
      } else {
        Sentry.captureException(loopErr, { tags: { cron: 'reels-prepare-brand-youtube', step: 'item_loop', author: v.source_author ?? v.id } })
        console.error(`[reels-prepare-brand-youtube] Uncaught error for @${v.source_author}:`, loopErr instanceof Error ? loopErr.message : loopErr)
        skippedReasons.uncaught_error = (skippedReasons.uncaught_error ?? 0) + 1
      }
    }
  }

  return NextResponse.json({
    ok: true,
    prepared: prepared.length,
    authors: prepared,
    slotsToFill,
    skippedReasons,
    elapsedMs: Date.now() - runStart,
    debug: { candidates: ytCandidates.length, videoItems: videoItems.length },
  })
}
