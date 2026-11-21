import { describe, it, expect } from 'vitest'

function subtitlesToCapcutAss(subtitles: Array<{text: string, startFrame: number, endFrame: number}>, fps = 30) {
  const WORDS_PER_CHUNK = 4

  let ass = `[Script Info]\nTitle: CapCut Karaoke Subtitles\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\n\n`
  ass += `[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n`
  ass += `Style: Base,Liberation Sans,90,&H00FFFFFF,&H000000FF,&H00000000,&HA0000000,-1,0,0,0,100,100,0,0,1,0,4,2,60,60,120,1\n`
  ass += `Style: Highlight,Liberation Sans,90,&H00FFFFFF,&H000000FF,&H00003CFF,&H00003CFF,-1,0,0,0,100,100,0,0,3,12,0,2,60,60,120,1\n\n`
  ass += `[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`

  for (const sub of subtitles) {
    const words = sub.text.toUpperCase().split(/\s+/).filter(w => w.length > 0)
    if (words.length === 0) continue
    const startSec = sub.startFrame / fps
    const endSec = sub.endFrame / fps
    const totalDuration = endSec - startSec
    const chunks: string[][] = []
    for (let i = 0; i < words.length; i += WORDS_PER_CHUNK) {
      chunks.push(words.slice(i, i + WORDS_PER_CHUNK))
    }
    const chunkDuration = totalDuration / chunks.length
    for (let ci = 0; ci < chunks.length; ci++) {
      const chunk = chunks[ci]
      const cStart = startSec + ci * chunkDuration
      const cEnd = startSec + (ci + 1) * chunkDuration
      const wordDuration = (cEnd - cStart) / chunk.length
      const chunkText = chunk.join(' ')
      ass += `Dialogue: 0,${fmt(cStart)},${fmt(cEnd)},Base,,0,0,0,,{\\fad(70,70)}${chunkText}\n`
      for (let wi = 0; wi < chunk.length; wi++) {
        const wStart = cStart + wi * wordDuration
        const wEnd = cStart + (wi + 1) * wordDuration
        const parts = chunk.map((word, j) => {
          if (j === wi) return `{\\rHighlight}${word}{\\rBase}`
          return `{\\alpha&HFF&}${word}{\\alpha&H00&}`
        })
        ass += `Dialogue: 1,${fmt(wStart)},${fmt(wEnd)},Base,,0,0,0,,${parts.join(' ')}\n`
      }
    }
  }
  return ass
}

function fmt(seconds: number) {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`
}

describe('subtitlesToCapcutAss', () => {
  it('generates valid ASS with Script Info and Styles', () => {
    const subs = [{ text: 'Hello world', startFrame: 0, endFrame: 60 }]
    const ass = subtitlesToCapcutAss(subs, 30)
    expect(ass).toContain('[Script Info]')
    expect(ass).toContain('PlayResX: 1080')
    expect(ass).toContain('PlayResY: 1920')
    expect(ass).toContain('Style: Base,Liberation Sans,90')
    expect(ass).toContain('Style: Highlight,Liberation Sans,90')
    expect(ass).toContain('BorderStyle')
  })

  it('converts text to UPPERCASE', () => {
    const subs = [{ text: 'hello world test', startFrame: 0, endFrame: 90 }]
    const ass = subtitlesToCapcutAss(subs, 30)
    expect(ass).toContain('HELLO WORLD TEST')
    expect(ass).not.toContain('hello')
  })

  it('creates Layer 0 (base) and Layer 1 (highlight) for each chunk', () => {
    const subs = [{ text: 'one two three', startFrame: 0, endFrame: 90 }]
    const ass = subtitlesToCapcutAss(subs, 30)
    const lines = ass.split('\n').filter(l => l.startsWith('Dialogue:'))
    const layer0 = lines.filter(l => l.startsWith('Dialogue: 0,'))
    const layer1 = lines.filter(l => l.startsWith('Dialogue: 1,'))
    expect(layer0.length).toBeGreaterThan(0)
    expect(layer1.length).toBeGreaterThan(0)
  })

  it('highlights one word at a time with rHighlight', () => {
    const subs = [{ text: 'A B C', startFrame: 0, endFrame: 90 }]
    const ass = subtitlesToCapcutAss(subs, 30)
    expect(ass).toContain('{\\rHighlight}A{\\rBase}')
    expect(ass).toContain('{\\rHighlight}B{\\rBase}')
    expect(ass).toContain('{\\rHighlight}C{\\rBase}')
  })

  it('makes non-active words invisible in highlight layer', () => {
    const subs = [{ text: 'A B C', startFrame: 0, endFrame: 90 }]
    const ass = subtitlesToCapcutAss(subs, 30)
    expect(ass).toContain('{\\alpha&HFF&}')
  })

  it('splits into max 4 words per chunk', () => {
    const subs = [{ text: 'one two three four five six seven eight', startFrame: 0, endFrame: 240 }]
    const ass = subtitlesToCapcutAss(subs, 30)
    const baseLines = ass.split('\n').filter(l => l.startsWith('Dialogue: 0,'))
    expect(baseLines.length).toBe(2)
  })

  it('adds fade effect to base layer', () => {
    const subs = [{ text: 'test fade', startFrame: 0, endFrame: 60 }]
    const ass = subtitlesToCapcutAss(subs, 30)
    expect(ass).toContain('{\\fad(70,70)}')
  })

  it('handles empty subtitles', () => {
    const ass = subtitlesToCapcutAss([], 30)
    expect(ass).toContain('[Script Info]')
    expect(ass).not.toContain('Dialogue:')
  })

  it('formats timestamps correctly', () => {
    expect(fmt(0)).toBe('0:00:00.00')
    expect(fmt(65.5)).toBe('0:01:05.50')
    expect(fmt(3661.25)).toBe('1:01:01.25')
  })

  it('positions subtitles at bottom (alignment 2, MarginV 120)', () => {
    const subs = [{ text: 'test', startFrame: 0, endFrame: 30 }]
    const ass = subtitlesToCapcutAss(subs, 30)
    expect(ass).toMatch(/,2,60,60,120,/)
  })
})

describe('constants', () => {
  it('uses orange highlight color #FF3C00 in BGR', () => {
    const subs = [{ text: 'test', startFrame: 0, endFrame: 30 }]
    const ass = subtitlesToCapcutAss(subs, 30)
    expect(ass).toContain('&H00003CFF')
  })
})
