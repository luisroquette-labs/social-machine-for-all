'use client'

import { useEffect, useState, useCallback } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

interface QualitySetting {
  key: string
  value: string | number
  label: string
  description: string
  min: number
  max: number
  step: number
}

const QUALITY_FIELDS: Omit<QualitySetting, 'value'>[] = [
  {
    key: 'reviewer_approval_threshold',
    label: 'Threshold de aprovacao do reviewer',
    description: 'Score minimo (0-10) para aprovacao automatica pelo reviewer.',
    min: 0,
    max: 10,
    step: 0.1,
  },
  {
    key: 'quality_gate_pass_score',
    label: 'Score de passagem do quality gate',
    description: 'Score minimo (0-10) para passar no quality gate.',
    min: 0,
    max: 10,
    step: 1,
  },
  {
    key: 'quality_gate_max_issues',
    label: 'Max issues no quality gate',
    description: 'Numero maximo de issues permitidas antes de reprovar.',
    min: 0,
    max: 5,
    step: 1,
  },
  {
    key: 'dedup_similarity_threshold',
    label: 'Threshold de similaridade (dedup)',
    description: 'Similaridade minima (0-1) para considerar conteudo duplicado.',
    min: 0,
    max: 1,
    step: 0.1,
  },
  {
    key: 'dedup_window_hours',
    label: 'Janela de dedup (horas)',
    description: 'Periodo em horas para verificar duplicatas.',
    min: 1,
    max: 720,
    step: 1,
  },
  {
    key: 'max_hashtags',
    label: 'Max hashtags',
    description: 'Numero maximo de hashtags por post.',
    min: 0,
    max: 30,
    step: 1,
  },
  {
    key: 'max_emojis',
    label: 'Max emojis',
    description: 'Numero maximo de emojis por post.',
    min: 0,
    max: 20,
    step: 1,
  },
]

export default function QualitySettingsPage() {
  const [values, setValues] = useState<Record<string, number>>({})
  const [forbiddenPatterns, setForbiddenPatterns] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<'idle' | 'success' | 'error'>('idle')

  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch('/api/settings')
      const json = await res.json()
      const qualityArr = json.quality ?? []
      const mapped: Record<string, number> = {}
      for (const field of QUALITY_FIELDS) {
        const found = qualityArr.find((s: { key: string }) => s.key === field.key)
        mapped[field.key] = found ? Number(found.value) : 0
      }
      setValues(mapped)
      const patternsEntry = qualityArr.find((s: { key: string }) => s.key === 'forbidden_patterns')
      if (patternsEntry) {
        setForbiddenPatterns(patternsEntry.value.split('|').join('\n'))
      }
    } catch {
      setStatus('error')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchSettings()
  }, [fetchSettings])

  async function handleSaveAll() {
    setSaving(true)
    setStatus('idle')
    try {
      const updates = QUALITY_FIELDS.map((field) =>
        fetch('/api/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ category: 'quality', key: field.key, value: values[field.key] }),
        })
      )
      updates.push(
        fetch('/api/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            category: 'quality',
            key: 'forbidden_patterns',
            value: forbiddenPatterns.split('\n').map(p => p.trim()).filter(Boolean).join('|'),
          }),
        })
      )
      const results = await Promise.all(updates)
      if (results.some((r) => !r.ok)) throw new Error('Some settings failed to save')
      setStatus('success')
    } catch {
      setStatus('error')
    } finally {
      setSaving(false)
      setTimeout(() => setStatus('idle'), 3000)
    }
  }

  if (loading) return <p className="text-muted-foreground">Carregando...</p>

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Qualidade</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {QUALITY_FIELDS.map((field) => (
            <div key={field.key} className="space-y-1">
              <Label htmlFor={field.key}>{field.label}</Label>
              <Input
                id={field.key}
                type="number"
                min={field.min}
                max={field.max}
                step={field.step}
                value={values[field.key] ?? 0}
                onChange={(e) =>
                  setValues((prev) => ({ ...prev, [field.key]: Number(e.target.value) }))
                }
              />
              <p className="text-xs text-muted-foreground">{field.description}</p>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Frases Proibidas (Guardrails)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Label htmlFor="forbidden_patterns">Uma frase por linha. O sistema remove automaticamente do conteudo gerado.</Label>
          <Textarea
            id="forbidden_patterns"
            value={forbiddenPatterns}
            onChange={(e) => setForbiddenPatterns(e.target.value)}
            rows={12}
            placeholder="acabei de ler&#10;é impressionante&#10;o futuro é"
            className="font-mono text-sm"
          />
          <p className="text-xs text-muted-foreground">
            {forbiddenPatterns.split('\n').filter(Boolean).length} padroes configurados
          </p>
        </CardContent>
      </Card>

      <div className="flex items-center gap-4">
        <Button onClick={handleSaveAll} disabled={saving}>
          {saving ? 'Salvando...' : 'Salvar tudo'}
        </Button>
        {status === 'success' && <Badge variant="default" className="bg-green-600">Salvo com sucesso</Badge>}
        {status === 'error' && <Badge variant="destructive">Erro ao salvar</Badge>}
      </div>
    </div>
  )
}
