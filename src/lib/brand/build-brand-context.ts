import { getAdminClient } from '@/lib/supabase/admin'

export interface BrandContext {
  name: string
  sector: string
  tone: string
  language: string
  hashtags: string[]
  rules: string[]
}

export async function buildBrandContext(workspaceId: string): Promise<string> {
  const supabase = getAdminClient()

  const { data: workspace } = await supabase
    .from('workspaces')
    .select('name, brand_config, topic_keywords')
    .eq('id', workspaceId)
    .single()

  if (!workspace) return ''

  const config = (workspace.brand_config ?? {}) as Record<string, unknown>
  const keywords = (workspace.topic_keywords ?? []) as string[]

  const lines: string[] = [
    `# Identidade da Marca: ${workspace.name}`,
    '',
    `**Setor:** ${config.sector ?? 'Tecnologia'}`,
    `**Tom:** ${config.tone ?? 'Técnico, direto, informativo'}`,
    `**Idioma:** ${config.language ?? 'Português brasileiro'}`,
    `**Tópicos:** ${keywords.join(', ')}`,
  ]

  if (config.hashtags) {
    lines.push(`**Hashtags:** ${(config.hashtags as string[]).join(' ')}`)
  }

  if (config.rules) {
    lines.push('', '## Regras de Comunicação:')
    for (const rule of config.rules as string[]) {
      lines.push(`- ${rule}`)
    }
  }

  lines.push(
    '', '## Regras Padrão:',
    '- Nunca use frases genéricas de IA ("como um modelo de linguagem...")',
    '- Seja direto e objetivo',
    '- Use dados e exemplos concretos quando possível',
    '- Não faça promessas ou afirmações absolutas',
    '- Mantenha tom profissional mas acessível',
  )

  return lines.join('\n')
}
