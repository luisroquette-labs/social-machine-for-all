import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const files = [
  'generate-brand-reel-cover.ts',
  'generate-brand-post-image.ts',
  'generate-brand-carousel.ts',
].map((file) => path.resolve(dir, file))

describe('Brand images use only OpenAI through OpenRouter BYOK', () => {
  it.each(files)('%s has no direct paid-provider endpoint', (file) => {
    const source = fs.readFileSync(file, 'utf8')
    expect(source).toContain('callOpenRouterImage')
    expect(source).not.toMatch(/api\.openai\.com|generativelanguage\.googleapis\.com|GEMINI_API_KEY|OPENAI_API_KEY/)
  })
})
