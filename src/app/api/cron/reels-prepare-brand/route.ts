export const maxDuration = 300

import * as Sentry from '@sentry/nextjs'
import { NextResponse } from 'next/server'
import { isCronRequest } from '@/lib/api/auth'
import { getAdminClient } from '@/lib/supabase/admin'
import { getVariable, getNumericVariable } from '@/lib/settings/load-settings'
import { generateStoredImage } from '@/lib/ai/openai-image'
import { generateTextWithFallback, aiSentinelCode, AI_SENTINEL } from '@/lib/ai/generate-with-fallback'
import { isBrazilRelevantbrandSource, calculateValidatedEngagement, VALIDATED_VIRAL_ENGAGEMENT } from '@/lib/pipeline/brand-brazil-launch'
import {
  EV_KEYWORDS,
  TESLA_EV_CONTEXT,
  brandImageFallback,
  buildDallePrompt,
  parseSrtToFrames,
  buildbrandAiPrompt,
  sortBrazilFirst,
} from './_shared'
import { hasNegativeEvFraming } from '@/lib/brand/brand-brand-safety'

export { EV_KEYWORDS, isBrazilRelevantbrandSource } // re-export for regression tests

const WORKSPACE_ID = process.env.WORKSPACE_ID?.trim() ?? ''
const REEL_RENDERER_URL = process.env.REEL_RENDERER_URL || ''
const REEL_RENDERER_API_KEY = process.env.REEL_RENDERER_API_KEY || ''

/**
 * PHASE 1 of Brand Reel pipeline (X/Twitter source): Prepare content.
 * Picks up X video tweets about EVs/automotive from Brand curated_content.
 * Downloads video + transcribes + generates EV-themed cover.
 * Saves to generated_content with status='reel_ready' for Brand workspace.
 *
 * YouTube source: /api/cron/reels-prepare-brand-youtube (dedicated cron, 270s budget)
 * Phase 2: /api/cron/reels-publish?workspaceId=742fb5f7-... picks up and publishes.
 */
const QUEUE_CAP = 12
const TIME_BUDGET_MS = 240_000
// Cobre o pior caso de uploadAndGetUrl (60s) + transcribe (90s) + margem — as duas
// etapas que este fix mexeu. Sem essa reserva, um item admitido perto do fim do
// TIME_BUDGET_MS pode estourar o maxDuration=300s (Vercel mata a função sem log limpo).
// LIMITAÇÃO CONHECIDA (fora de escopo deste fix): não cobre o pior caso teórico de
// generateTextWithFallback() (sem timeout próprio) nem da cascata de fallback de
// generateStoredImage() (OpenAI → Gemini 1 → Gemini 2, até ~270s se as 3 travarem).
// Esse risco é pré-existente e independente das mudanças de hoje — eliminá-lo por
// completo exigiria um deadline de wall-clock dentro dessas funções compartilhadas
// (usadas por outros crons também), não só uma reserva na admissão do loop.
const PER_ITEM_WORST_CASE_MS = 160_000

// yt_timeout: set by reels-prepare-brand-youtube when Railway times out on a YouTube item.
// Excluded here so the X cron doesn't waste a DB slot on items the YouTube cron is managing.
const YT_TIMEOUT_SENTINEL = 'yt_timeout'

export async function GET(request: Request) {
  if (!isCronRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!WORKSPACE_ID) {
    return NextResponse.json({ error: 'WORKSPACE_ID is not configured' }, { status: 503 })
  }

  // A3 (pause week) foi REMOVIDO em 04/07/2026 — ver comentário em
  // reels-prepare/route.ts. Tripwire nos regression tests impede reintrodução.

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

  // ── Reset expired sentinels (TTLs: 4h rate_limited, 2h unavailable, 6h yt_timeout) ──
  await supabase
    .from('curated_content')
    .update({ skip_reason: null, skip_until: null })
    .eq('workspace_id', WORKSPACE_ID)
    .in('skip_reason', [AI_SENTINEL.RATE_LIMITED, AI_SENTINEL.UNAVAILABLE, AI_SENTINEL.PUBLISH_FAILED, YT_TIMEOUT_SENTINEL])
    .lt('skip_until', new Date().toISOString())

  // ── Find EV video content: X Twitter videos + YouTube videos in parallel ──
  const limit = candidateLimit || 20
  const minScore = minRelevanceScore || 20
  // yt_timeout excluded: items timed out at Railway are managed by reels-prepare-brand-youtube
  const sentinelFilter = `skip_reason.is.null,skip_reason.not.in.(${AI_SENTINEL.RATE_LIMITED},${AI_SENTINEL.UNAVAILABLE},${AI_SENTINEL.PUBLISH_FAILED},${YT_TIMEOUT_SENTINEL})`

  const [{ data: xCandidates }, { data: ytCandidates }, { data: xRescueCandidates }] = await Promise.all([
    supabase
      .from('curated_content')
      .select('id, source_url, source_content, source_author, relevance_score, source_metrics, source_platform, score_breakdown')
      .eq('workspace_id', WORKSPACE_ID)
      .eq('source_platform', 'x')
      .in('status', ['curated', 'written'])
      .not('source_url', 'is', null)
      .gte('created_at', lookbackCutoff)
      .contains('source_metrics', { media_types: ['video'] })
      .gte('relevance_score', minScore)
      .or(sentinelFilter)
      .order('created_at', { ascending: false })
      .order('relevance_score', { ascending: false })
      .limit(limit),
    supabase
      .from('curated_content')
      .select('id, source_url, source_content, source_author, relevance_score, source_metrics, source_platform, score_breakdown')
      .eq('workspace_id', WORKSPACE_ID)
      .eq('source_platform', 'youtube')
      .in('status', ['curated', 'written'])
      .not('source_url', 'is', null)
      .gte('created_at', lookbackCutoff)
      .gte('relevance_score', minScore)
      .or(sentinelFilter)
      .order('created_at', { ascending: false })
      .order('relevance_score', { ascending: false })
      .limit(limit),
    // Resgate: relevance_score é score PREDITIVO (decay/velocity/autoridade) e
    // pode ficar abaixo de minScore para conteúdo que já tem engajamento real
    // alto (achado 2026-07-11: post com 807 curtidas/72 RT tinha score 58).
    // Busca sem o gate de score — o filtro real (engajamento já validado) roda
    // em isBrazilRelevantbrandSource, abaixo. lt(minScore) evita duplicar o que
    // a query principal já trouxe.
    supabase
      .from('curated_content')
      .select('id, source_url, source_content, source_author, relevance_score, source_metrics, source_platform, score_breakdown')
      .eq('workspace_id', WORKSPACE_ID)
      .eq('source_platform', 'x')
      .in('status', ['curated', 'written'])
      .not('source_url', 'is', null)
      .gte('created_at', lookbackCutoff)
      .contains('source_metrics', { media_types: ['video'] })
      .lt('relevance_score', minScore)
      .or(sentinelFilter)
      .order('created_at', { ascending: false })
      .limit(100),
  ])

  const rescued = (xRescueCandidates ?? []).filter(c => {
    const metrics = c.source_metrics as { likes?: number; retweets?: number; replies?: number } | null
    return calculateValidatedEngagement(metrics ?? undefined) >= VALIDATED_VIRAL_ENGAGEMENT
  })

  // X items are scarce — never let YouTube candidates crowd them out of the list.
  // Process both separately: X sorted by score, YouTube sorted by score.
  // Interleave so at least some X items are attempted before exhausting YouTube.
  const xSorted = [...(xCandidates ?? []), ...rescued].sort((a, b) => (b.relevance_score ?? 0) - (a.relevance_score ?? 0))
  const ytSorted = (ytCandidates ?? []).sort((a, b) => (b.relevance_score ?? 0) - (a.relevance_score ?? 0))
  // Put ALL X candidates first, then YouTube (X is the only viable source while Railway is down)
  const candidates = [...xSorted, ...ytSorted]

  if (!candidates.length) {
    return NextResponse.json({ ok: true, skipped: 'no_video_content' })
  }

  type C = typeof candidates[0]
  const evVideoItems = candidates.filter((c: C) => {
    const text = c.source_content || ''
    // Brand safety: EV associado a perigo (incêndio, acidente, recall) nunca vira
    // reel — este cron insere DIRETO como reel_ready, sem passar pelo reviewer.
    // See src/lib/brand/brand-brand-safety.ts.
    if (hasNegativeEvFraming(text)) return false
    if (!EV_KEYWORDS.test(text) && !TESLA_EV_CONTEXT.test(text)) return false
    const cleanText = text.replace(/https?:\/\/\S+/g, '').replace(/@\w+/g, '').trim()
    if (cleanText.length < 40) return false
    const metrics = c.source_metrics as { likes?: number; retweets?: number; replies?: number } | null
    if (!isBrazilRelevantbrandSource(text, metrics ?? undefined)) return false
    return true
  })

  if (!evVideoItems.length) {
    return NextResponse.json({ ok: true, skipped: 'no_ev_video', total: candidates.length })
  }

  // Prioriza conteúdo Brasil-scoped (score_breakdown.brazil_scoped) — conteúdo
  // global (ex: mercado indiano) só é tentado como fallback, se sobrar slot
  // depois do BR se esgotar. (bug Telangana 2026-07-06)
  const videoItems = sortBrazilFirst(evVideoItems)

  // ── Railway warmup ──
  let railwayReady = false
  try {
    const warmRes = await fetch(`${REEL_RENDERER_URL}/health`, {
      headers: { Authorization: `Bearer ${REEL_RENDERER_API_KEY}` },
      signal: AbortSignal.timeout(15_000),
    })
    railwayReady = warmRes.ok
    if (!warmRes.ok) {
      await new Promise(r => setTimeout(r, 10_000))
      const retry = await fetch(`${REEL_RENDERER_URL}/health`, {
        headers: { Authorization: `Bearer ${REEL_RENDERER_API_KEY}` },
        signal: AbortSignal.timeout(20_000),
      })
      railwayReady = retry.ok
    }
  } catch { /* will still try direct URLs */ }

  // ── Upload video to Supabase Storage ──
  // Returns Supabase public URL on success, '' on any failure.
  // NEVER returns rawUrl: Instagram cannot download video.twimg.com URLs (Cláusula Pétrea §7).
  const uploadAndGetUrl = async (rawUrl: string, itemId: string): Promise<string> => {
    try {
      const vidRes = await fetch(rawUrl, { signal: AbortSignal.timeout(60_000) })
      if (vidRes.ok) {
        // Guard §6 (CLAUDE.md Cláusula Pétrea): never bufferize >50MB — V8 OOM bypasses all catch
        const contentLength = parseInt(vidRes.headers.get('content-length') || '0')
        if (contentLength > 50 * 1024 * 1024) {
          console.warn(`[reels-prepare-brand] Video ${Math.round(contentLength / 1024 / 1024)}MB > 50MB, skipping item`)
          return ''
        }
        const buf = Buffer.from(await vidRes.arrayBuffer())
        const path = `downloads/brand-${itemId}.mp4`
        const { error } = await supabase.storage.from('reels').upload(path, buf, { contentType: 'video/mp4', upsert: true })
        if (!error) {
          const { data } = supabase.storage.from('reels').getPublicUrl(path)
          return data.publicUrl
        }
        console.error('[reels-prepare-brand] Upload failed:', error.message)
      }
    } catch (err) {
      console.error('[reels-prepare-brand] Video storage error:', err instanceof Error ? err.message : err)
    }
    // Never fall back to raw Twitter URL — Instagram cannot download video.twimg.com (§7)
    return ''
  }

  // ── Check existing queue ──
  const { count: existingReady, error: qErr1 } = await supabase
    .from('generated_content')
    .select('*', { count: 'exact', head: true })
    .eq('workspace_id', WORKSPACE_ID)
    .eq('target_format', 'reel')
    .eq('status', 'reel_ready')
  if (qErr1) {
    // Guard 42703: erro de query não lança no supabase-js — surfar no Sentry, nunca engolir
    Sentry.captureException(new Error(`reels-prepare-brand generated_content.reel_ready: ${qErr1.message}`), { tags: { cron: 'reels-prepare-brand', step: 'db_query_guard' } })
  }

  const slotsToFill = Math.max(0, QUEUE_CAP - (existingReady ?? 0))
  if (slotsToFill === 0) {
    return NextResponse.json({ ok: true, skipped: 'queue_full', existingReady })
  }

  // ── Pre-flight: image provider availability ──
  const hasOpenRouter = !!process.env.OPENROUTER_API_KEY
  console.log(`[reels-prepare-brand] OpenRouter BYOK image provider: ${hasOpenRouter}`)
  if (!hasOpenRouter) {
    Sentry.captureMessage('reels-prepare-brand: OPENROUTER_API_KEY missing', { level: 'error' })
  }

  const prepared: string[] = []
  const skippedReasons: Record<string, number> = {}
  const usedIds = new Set<string>()
  const runStart = Date.now()

  for (const v of videoItems) {
    if (prepared.length >= slotsToFill) break
    // Só admite novo item se sobrar runway pro pior caso (upload+transcribe+IA) terminar
    // dentro do maxDuration=300s — não apenas dentro do TIME_BUDGET_MS bruto.
    if (Date.now() - runStart > TIME_BUDGET_MS - PER_ITEM_WORST_CASE_MS) break

    if (usedIds.has(v.id)) continue
    const { count, error: qErr2 } = await supabase
      .from('generated_content')
      .select('*', { count: 'exact', head: true })
      .eq('curated_content_id', v.id)
      .eq('target_format', 'reel')
      .not('status', 'in', '("failed","rejected")') // allow retrying failed/rejected items
  if (qErr2) {
    // Guard 42703: erro de query não lança no supabase-js — surfar no Sentry, nunca engolir
    Sentry.captureException(new Error(`reels-prepare-brand generated_content.recent_by_source: ${qErr2.message}`), { tags: { cron: 'reels-prepare-brand', step: 'db_query_guard' } })
  }
    if ((count ?? 0) > 0) { skippedReasons.dedup = (skippedReasons.dedup ?? 0) + 1; continue }

    // ── Download video + Transcribe (branched by platform) ──
    const metrics = v.source_metrics as Record<string, unknown> | null
    const isYoutube = (v as Record<string, unknown>).source_platform === 'youtube'

    let videoUrl = ''
    let srtText = ''
    let fullText = v.source_content || ''

    if (isYoutube) {
      // YouTube: Railway transcribes + returns video URL in one call (requires yt-dlp on Railway)
      if (!v.source_url) continue
      try {
        const trRes = await fetch(`${REEL_RENDERER_URL}/transcribe`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${REEL_RENDERER_API_KEY}` },
          body: JSON.stringify({ video_url: v.source_url, return_video_url: true }),
          signal: AbortSignal.timeout(90_000),
        })
        if (!trRes.ok) {
          let errBody = ''
          try { errBody = await trRes.text() } catch { /* ignore */ }
          console.error(`[reels-prepare-brand] Railway transcribe failed YouTube status=${trRes.status} body=${errBody.slice(0, 200)} url=${v.source_url}`)
          if (skippedReasons.yt_railway_error === undefined) {
            Sentry.captureMessage(`reels-prepare-brand: Railway yt-dlp failing — status ${trRes.status}: ${errBody.slice(0, 100)}`, { level: 'error', tags: { cron: 'reels-prepare-brand', step: 'yt_railway' } })
          }
          skippedReasons.yt_railway_error = (skippedReasons.yt_railway_error ?? 0) + 1
          continue
        }
        const tr = JSON.parse(await trRes.text()) as { srt?: string; text?: string; video_url?: string }
        if (!tr.video_url) {
          console.log(`[reels-prepare-brand] Railway sem suporte YouTube (no video_url): ${v.source_url}`)
          skippedReasons.yt_no_video_url = (skippedReasons.yt_no_video_url ?? 0) + 1
          continue
        }
        videoUrl = tr.video_url
        const hasRealSpeech = (tr.text?.length ?? 0) > 30 && !/^[♪🎶\s]+$/.test(tr.text ?? '')
        if (hasRealSpeech) { srtText = tr.srt || ''; fullText = tr.text || fullText }
      } catch (err) {
        console.log(`[reels-prepare-brand] YouTube transcribe error: ${err instanceof Error ? err.message : err}`)
        continue
      }
    } else {
      // X Twitter: download to Supabase + separate transcription
      const directVideoUrl = typeof metrics?.video_url === 'string' ? metrics.video_url : null
      if (!directVideoUrl) { skippedReasons.no_video_url = (skippedReasons.no_video_url ?? 0) + 1; continue }
      videoUrl = await uploadAndGetUrl(directVideoUrl, v.id)
      if (!videoUrl) continue

      // Transcrição é OBRIGATÓRIA para vídeos do X, não best-effort: sem ela não há
      // como saber se o áudio/texto original está em inglês (ou outro idioma) e
      // precisa de legenda PT-BR (regra do usuário, bug 2026-07-06 — reel Telangana
      // foi ao ar com áudio e texto queimado em inglês porque a transcrição falhava
      // silenciosamente com timeout de 15s, quando a Railway leva ~60s nesses vídeos).
      let transcriptionOk = false
      try {
        const trRes = await fetch(`${REEL_RENDERER_URL}/transcribe`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${REEL_RENDERER_API_KEY}` },
          body: JSON.stringify({ video_url: videoUrl }),
          signal: AbortSignal.timeout(90_000), // Railway leva ~60s em vídeos do X — 15s garantia falha
        })
        if (trRes.ok) {
          // Parse ANTES de marcar sucesso: um 200 com corpo malformado/truncado não
          // conta como transcrição válida — o idioma continua desconhecido nesse caso.
          const tr = JSON.parse(await trRes.text()) as { srt: string; text: string }
          transcriptionOk = true
          const hasRealSpeech = tr.text?.length > 30 && !/^[♪🎶\s]+$/.test(tr.text)
          if (hasRealSpeech) { srtText = tr.srt || ''; fullText = tr.text }
        }
      } catch { /* transcriptionOk fica false */ }

      if (!transcriptionOk) {
        // Sem transcrição não sabemos se o áudio precisa de legenda PT-BR — nunca
        // publicar um vídeo de idioma desconhecido sem legenda.
        skippedReasons.transcription_failed = (skippedReasons.transcription_failed ?? 0) + 1
        continue
      }
    }

    // ── Anti-shadowban: conta CTAs "comenta" publicados nos últimos 7 dias (≤2x/semana) ──
    // Non-critical — if query fails (e.g. DB unavailable), default to 0 (throttle inactive).
    let comentaCTACount = 0
    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
      const { count: comentaCount } = await supabase
        .from('generated_content')
        .select('*', { count: 'exact', head: true })
        .eq('workspace_id', WORKSPACE_ID)
        .eq('status', 'published')
        .gte('published_at', sevenDaysAgo)
        .ilike('content', '%comenta%')
      comentaCTACount = comentaCount ?? 0
    } catch { /* non-critical: comenta count unavailable, throttle stays inactive */ }

    try {

    // ── AI: EV-themed hook + caption for Brand ──
    const aiText = await generateTextWithFallback({
      primary: (reelPrepModel ?? '').startsWith('gemini') ? 'gemini' : 'deepseek',
      system: `Você é uma API JSON. Retorne SOMENTE JSON válido, sem markdown, sem explicações, sem texto fora do JSON. Você é o copywriter sênior do ${instagramHandle} — perfil de Instagram B2B sobre mobilidade elétrica, eletropostos e infraestrutura EV no Brasil.`,
      prompt: buildbrandAiPrompt({ srtText, instagramHandle, sourceContent: v.source_content || '', fullText, comentaCTACount }),
      maxOutputTokens: Math.round((reelPrepMaxTokens || 2000) * (0.85 + Math.random() * 0.30)), // B3: ±15% variation
    })

    // Extract JSON: find first '{' and last '}' — handles preamble, code blocks, trailing text
    const jsonStart = aiText.indexOf('{')
    const jsonEnd = aiText.lastIndexOf('}')
    if (jsonStart === -1 || jsonEnd <= jsonStart) {
      console.error(`[reels-prepare-brand] No JSON braces for ${v.id} — raw: ${JSON.stringify(aiText.slice(0, 300))}`)
      skippedReasons.ai_no_json = (skippedReasons.ai_no_json ?? 0) + 1
      continue
    }
    const jsonStr = aiText.slice(jsonStart, jsonEnd + 1)

    let meta: { srt_ptbr: string; hookTitle: string; highlightWords: string[]; subtitle: string; caption: string; imagePrompt?: string; kpi?: string }
    try { meta = JSON.parse(jsonStr) } catch (parseErr) { console.error(`[reels-prepare-brand] Malformed JSON for ${v.id}:`, parseErr instanceof Error ? parseErr.message : parseErr, '— jsonStr:', jsonStr.slice(0, 200)); skippedReasons.ai_bad_json = (skippedReasons.ai_bad_json ?? 0) + 1; continue }

    // ── Cover background ──
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
      Sentry.captureMessage(`reels-prepare-brand: OpenAI background failed — ${err instanceof Error ? err.message.slice(0, 120) : err}`, { level: 'error' })
    }

    // Gate: NEVER queue without cinematic background (CLAUDE.md cláusula pétrea §2)
    // background_gate
    if (!backgroundUrl) {
      // generateStoredImage returns null on all-provider failure (never throws).
      // Sentry here is the only signal that image generation is broken.
      Sentry.captureMessage(
        `reels-prepare-brand: background_gate blocked ${v.id} (@${v.source_author}) — all image providers failed`,
        { level: 'error', tags: { cron: 'reels-prepare-brand', step: 'background_gate', author: v.source_author ?? v.id } },
      )
      console.error(`[reels-prepare-brand] Blocked ${v.id} — no backgroundUrl generated`)
      skippedReasons.background_gate = (skippedReasons.background_gate ?? 0) + 1
      continue
    }

    // ── Insert reel_ready for Brand ──
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
      idioma: 'pt',
    })

    if (insertError) {
      Sentry.captureException(new Error(insertError.message), { tags: { cron: 'reels-prepare-brand' } })
      console.error('[reels-prepare-brand] Insert failed:', insertError.message)
      continue
    }

    await supabase.from('curated_content').update({ status: 'written' }).eq('id', v.id)
    usedIds.add(v.id)
    prepared.push(v.source_author ?? v.id)
    console.log(`[reels-prepare-brand] ✓ Prepared ${prepared.length}/${slotsToFill}: @${v.source_author}`)
    } catch (loopErr) {
      const sentinel = aiSentinelCode(loopErr)
      if (sentinel === AI_SENTINEL.RATE_LIMITED || sentinel === AI_SENTINEL.UNAVAILABLE) {
        const resetHours = sentinel === AI_SENTINEL.RATE_LIMITED ? 4 : 2
        const skipUntil = new Date(Date.now() + resetHours * 60 * 60 * 1000).toISOString()
        console.warn(`[reels-prepare-brand] AI ${sentinel} for @${v.source_author} — skip for ${resetHours}h`)
        await supabase.from('curated_content').update({ skip_reason: sentinel, skip_until: skipUntil }).eq('id', v.id)
        skippedReasons[sentinel] = (skippedReasons[sentinel] ?? 0) + 1
      } else {
        Sentry.captureException(loopErr, { tags: { cron: 'reels-prepare-brand', step: 'item_loop', author: v.source_author ?? v.id } })
        console.error(`[reels-prepare-brand] Uncaught error for @${v.source_author}:`, loopErr instanceof Error ? loopErr.message : loopErr)
        skippedReasons.uncaught_error = (skippedReasons.uncaught_error ?? 0) + 1
      }
    }
  }

  return NextResponse.json({ ok: true, prepared: prepared.length, authors: prepared, slotsToFill, skippedReasons, elapsedMs: Date.now() - runStart, debug: { candidates: candidates.length, videoItems: videoItems.length } })
}
