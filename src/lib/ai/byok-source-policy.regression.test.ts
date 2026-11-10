import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'

function productionSources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(dir, entry.name)
    if (entry.isDirectory()) return productionSources(target)
    if (!/\.tsx?$/.test(entry.name) || /(?:\.test|\.regression\.test)\.tsx?$/.test(entry.name)) return []
    return [target]
  })
}

describe('paid AI source policy', () => {
  it('contains no direct OpenAI, Anthropic, Gemini or DeepSeek route', () => {
    const violations = productionSources(path.resolve(process.cwd(), 'src')).flatMap((file) => {
      const source = fs.readFileSync(file, 'utf8')
      return /api\.openai\.com|api\.anthropic\.com|api\.deepseek\.com|generativelanguage\.googleapis\.com|@ai-sdk\/(?:anthropic|deepseek|google|openai)|(?:OPENAI|ANTHROPIC|GEMINI|DEEPSEEK)_API_KEY/.test(source)
        ? [path.relative(process.cwd(), file)]
        : []
    })
    expect(violations).toEqual([])
  })
})
