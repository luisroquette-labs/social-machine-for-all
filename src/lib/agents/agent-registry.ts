import type { AgentConfig, AgentSlug } from './agent-types'
import type { BaseAgent } from './base-agent'

const AGENT_SLUGS: AgentSlug[] = [
  'editor-in-chief',
  'monitor',
  'curator',
  'writer',
  'reviewer',
  'publisher',
  'engagement-own',
  'engagement-external',
  'seo-strategist',
  'ads-strategist',
  'social-strategist',
]

class AgentRegistry {
  private agents: Map<AgentSlug, BaseAgent> = new Map()
  private loaded = false

  async loadAll(): Promise<void> {
    if (this.loaded) return

    for (const slug of AGENT_SLUGS) {
      try {
        const mod = await import(`./${slug}/index`)
        if (mod.agent && typeof mod.agent.execute === 'function') {
          this.agents.set(slug, mod.agent)
        }
      } catch (error) {
        console.warn(`[registry] Agent '${slug}' not found or failed to load:`, error)
      }
    }

    console.log(`[registry] Loaded ${this.agents.size} agents: ${[...this.agents.keys()].join(', ')}`)
    this.loaded = true
  }

  private ensureLoaded(): void {
    if (!this.loaded) {
      throw new Error('[registry] Agents not loaded. Call loadAll() first.')
    }
  }

  get(slug: AgentSlug): BaseAgent | undefined {
    this.ensureLoaded()
    return this.agents.get(slug)
  }

  list(): AgentConfig[] {
    this.ensureLoaded()
    return [...this.agents.values()]
      .map(a => a.config)
      .sort((a, b) => (a.pipelineStage ?? 99) - (b.pipelineStage ?? 99))
  }

  getByPipelineStage(stage: number): BaseAgent | undefined {
    this.ensureLoaded()
    return [...this.agents.values()].find(a => a.config.pipelineStage === stage)
  }

  getPipelineOrder(): BaseAgent[] {
    this.ensureLoaded()
    return [...this.agents.values()]
      .filter(a => a.config.pipelineStage !== undefined)
      .sort((a, b) => (a.config.pipelineStage ?? 99) - (b.config.pipelineStage ?? 99))
  }

  has(slug: AgentSlug): boolean {
    this.ensureLoaded()
    return this.agents.has(slug)
  }

  get size(): number {
    return this.agents.size
  }
}

export const registry = new AgentRegistry()
