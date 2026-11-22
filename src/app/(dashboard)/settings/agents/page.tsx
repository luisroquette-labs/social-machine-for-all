'use client'

import { useEffect, useState, useCallback } from 'react'
import { useWorkspace } from '@/components/workspace-provider'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'


const MODEL_OPTIONS = [
  { value: 'claude-sonnet', label: 'Claude Sonnet' },
  { value: 'claude-haiku', label: 'Claude Haiku' },
  { value: 'deepseek-chat', label: 'DeepSeek Chat' },
  { value: 'deepseek-reasoner', label: 'DeepSeek Reasoner' },
]

interface AgentConfig {
  slug: string
  name: string
  model: string | null
  schedule_cron: string
  schedule_enabled: boolean
  active: boolean
  max_actions_per_hour: number
  quiet_hours_start: number
  quiet_hours_end: number
  temperature: number
  system_prompt: string
  telegram_bot_token: string
  telegram_bot_username: string
}

interface AgentStatus {
  [slug: string]: 'idle' | 'saving' | 'success' | 'error'
}

export default function AgentsSettingsPage() {
  const workspaceId = useWorkspace()
  const [agents, setAgents] = useState<AgentConfig[]>([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [statuses, setStatuses] = useState<AgentStatus>({})

  const fetchAgents = useCallback(async () => {
    try {
      const res = await fetch(`/api/dashboard?workspaceId=${workspaceId}`)
      const json = await res.json()
      const agentList = json.agents ?? []
      const configs = await Promise.all(
        agentList.map(async (a: { slug: string }) => {
          const r = await fetch(`/api/settings/agents/${a.slug}`)
          return r.json()
        })
      )
      setAgents(configs)
    } catch {
    } finally {
      setLoading(false)
    }
  }, [workspaceId])

  useEffect(() => {
    fetchAgents()
  }, [fetchAgents])

  function toggleExpand(slug: string) {
    setExpanded((prev) => ({ ...prev, [slug]: !prev[slug] }))
  }

  function updateAgent(slug: string, partial: Partial<AgentConfig>) {
    setAgents((prev) =>
      prev.map((a) => (a.slug === slug ? { ...a, ...partial } : a))
    )
  }

  async function saveAgent(agent: AgentConfig) {
    setStatuses((prev) => ({ ...prev, [agent.slug]: 'saving' }))
    try {
      const res = await fetch(`/api/settings/agents/${agent.slug}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(agent),
      })
      if (!res.ok) throw new Error('Failed')
      setStatuses((prev) => ({ ...prev, [agent.slug]: 'success' }))
    } catch {
      setStatuses((prev) => ({ ...prev, [agent.slug]: 'error' }))
    }
    setTimeout(() => {
      setStatuses((prev) => ({ ...prev, [agent.slug]: 'idle' }))
    }, 3000)
  }

  if (loading) return <p className="text-muted-foreground">Carregando agentes...</p>
  if (agents.length === 0) return <p className="text-muted-foreground">Nenhum agente encontrado.</p>

  return (
    <div className="space-y-4">
      {agents.map((agent) => (
        <Card key={agent.slug}>
          <CardHeader
            className="cursor-pointer"
            onClick={() => toggleExpand(agent.slug)}
          >
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg">{agent.name ?? agent.slug}</CardTitle>
              <div className="flex items-center gap-2">
                {agent.active && <Badge variant="default">Ativo</Badge>}
                {!agent.active && <Badge variant="secondary">Inativo</Badge>}
                <span className="text-muted-foreground text-sm">
                  {expanded[agent.slug] ? '▲' : '▼'}
                </span>
              </div>
            </div>
          </CardHeader>

          {expanded[agent.slug] && (
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Modelo</Label>
                  <Select
                    value={agent.model ?? ''}
                    onValueChange={(v) => updateAgent(agent.slug, { model: v })}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Selecione o modelo" />
                    </SelectTrigger>
                    <SelectContent>
                      {MODEL_OPTIONS.map((m) => (
                        <SelectItem key={m.value} value={m.value}>
                          {m.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor={`cron-${agent.slug}`}>Schedule Cron</Label>
                  <Input
                    id={`cron-${agent.slug}`}
                    value={agent.schedule_cron ?? ''}
                    onChange={(e) => updateAgent(agent.slug, { schedule_cron: e.target.value })}
                  />
                </div>

                <div className="flex items-center gap-3">
                  <Switch
                    id={`sched-${agent.slug}`}
                    checked={agent.schedule_enabled ?? false}
                    onCheckedChange={(v) => updateAgent(agent.slug, { schedule_enabled: v })}
                  />
                  <Label htmlFor={`sched-${agent.slug}`}>Schedule habilitado</Label>
                </div>

                <div className="flex items-center gap-3">
                  <Switch
                    id={`active-${agent.slug}`}
                    checked={agent.active ?? false}
                    onCheckedChange={(v) => updateAgent(agent.slug, { active: v })}
                  />
                  <Label htmlFor={`active-${agent.slug}`}>Ativo</Label>
                </div>

                <div className="space-y-2">
                  <Label htmlFor={`maxact-${agent.slug}`}>Max acoes/hora</Label>
                  <Input
                    id={`maxact-${agent.slug}`}
                    type="number"
                    value={agent.max_actions_per_hour ?? 0}
                    onChange={(e) => updateAgent(agent.slug, { max_actions_per_hour: Number(e.target.value) })}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor={`temp-${agent.slug}`}>Temperatura</Label>
                  <Input
                    id={`temp-${agent.slug}`}
                    type="number"
                    step={0.1}
                    min={0}
                    max={2}
                    value={agent.temperature ?? 0.7}
                    onChange={(e) => updateAgent(agent.slug, { temperature: Number(e.target.value) })}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor={`qstart-${agent.slug}`}>Quiet hours inicio</Label>
                  <Input
                    id={`qstart-${agent.slug}`}
                    type="number"
                    min={0}
                    max={23}
                    value={agent.quiet_hours_start ?? 0}
                    onChange={(e) => updateAgent(agent.slug, { quiet_hours_start: Number(e.target.value) })}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor={`qend-${agent.slug}`}>Quiet hours fim</Label>
                  <Input
                    id={`qend-${agent.slug}`}
                    type="number"
                    min={0}
                    max={23}
                    value={agent.quiet_hours_end ?? 0}
                    onChange={(e) => updateAgent(agent.slug, { quiet_hours_end: Number(e.target.value) })}
                  />
                </div>
              </div>

              <Separator />

              <div className="space-y-2">
                <Label htmlFor={`prompt-${agent.slug}`}>System Prompt</Label>
                <Textarea
                  id={`prompt-${agent.slug}`}
                  value={agent.system_prompt ?? ''}
                  onChange={(e) => updateAgent(agent.slug, { system_prompt: e.target.value })}
                  rows={8}
                  className="font-mono text-sm"
                />
              </div>

              <Separator />

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor={`tgtoken-${agent.slug}`}>Telegram Bot Token</Label>
                  <Input
                    id={`tgtoken-${agent.slug}`}
                    value={agent.telegram_bot_token ?? ''}
                    onChange={(e) => updateAgent(agent.slug, { telegram_bot_token: e.target.value })}
                    type="password"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor={`tguser-${agent.slug}`}>Telegram Bot Username</Label>
                  <Input
                    id={`tguser-${agent.slug}`}
                    value={agent.telegram_bot_username ?? ''}
                    onChange={(e) => updateAgent(agent.slug, { telegram_bot_username: e.target.value })}
                  />
                </div>
              </div>

              <div className="flex items-center gap-4 pt-2">
                <Button
                  onClick={() => saveAgent(agent)}
                  disabled={statuses[agent.slug] === 'saving'}
                >
                  {statuses[agent.slug] === 'saving' ? 'Salvando...' : 'Salvar'}
                </Button>
                {statuses[agent.slug] === 'success' && (
                  <Badge variant="default" className="bg-green-600">Salvo</Badge>
                )}
                {statuses[agent.slug] === 'error' && (
                  <Badge variant="destructive">Erro ao salvar</Badge>
                )}
              </div>
            </CardContent>
          )}
        </Card>
      ))}
    </div>
  )
}
