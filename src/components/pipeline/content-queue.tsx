'use client'

import { useRef, useState, useTransition } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { rejectContent, publishContent } from '@/app/actions/content-queue'

const PLATFORM_ICONS: Record<string, string> = { x: '🐦', instagram: '📸', linkedin: '💼' }

interface ContentItem {
  id: string
  target_platform: string
  target_format: string
  content: string
  retry_count: number | null
  created_at: string | null
}

export function ContentQueue({ items }: { items: ContentItem[] }) {
  const [list, setList] = useState(items)
  const [pending, startTransition] = useTransition()
  const [actionId, setActionId] = useState<string | null>(null)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const dialogRef = useRef<HTMLDialogElement>(null)

  function askReject(id: string) {
    setConfirmId(id)
    dialogRef.current?.showModal()
  }

  function closeDialog() {
    dialogRef.current?.close()
    setConfirmId(null)
  }

  function confirmReject() {
    if (!confirmId) return
    const id = confirmId
    closeDialog()
    setActionId(id)
    startTransition(async () => {
      const result = await rejectContent(id)
      if (result.ok) setList(prev => prev.filter(i => i.id !== id))
      setActionId(null)
    })
  }

  function handlePublish(id: string) {
    setActionId(id)
    startTransition(async () => {
      const result = await publishContent(id)
      if (result.ok) setList(prev => prev.filter(i => i.id !== id))
      setActionId(null)
    })
  }

  if (!list.length) {
    return <p className="text-sm text-muted-foreground py-4">Nenhum item aprovado aguardando publicação.</p>
  }

  const confirmItem = list.find(i => i.id === confirmId)

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-12">Plat.</TableHead>
            <TableHead>Conteúdo</TableHead>
            <TableHead className="w-20 text-center">Retries</TableHead>
            <TableHead className="w-36 text-right">Ações</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {list.map((item) => (
            <TableRow key={item.id}>
              <TableCell>
                <span title={item.target_platform}>
                  {PLATFORM_ICONS[item.target_platform] ?? '📤'}
                </span>
              </TableCell>
              <TableCell
                className="font-mono text-xs max-w-md cursor-pointer select-none"
                onClick={() => setExpandedId(expandedId === item.id ? null : item.id)}
              >
                {expandedId === item.id ? (
                  <span className="whitespace-pre-wrap break-words">{item.content}</span>
                ) : (
                  <span className="truncate block">
                    {item.content.slice(0, 120)}{item.content.length > 120 ? <span className="text-muted-foreground"> …ver mais</span> : ''}
                  </span>
                )}
              </TableCell>
              <TableCell className="text-center">
                <Badge variant={item.retry_count && item.retry_count > 1 ? 'destructive' : 'outline'}>
                  {item.retry_count ?? 0}
                </Badge>
              </TableCell>
              <TableCell className="text-right space-x-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending && actionId === item.id}
                  onClick={() => askReject(item.id)}
                >
                  Rejeitar
                </Button>
                <Button
                  size="sm"
                  disabled={pending && actionId === item.id}
                  onClick={() => handlePublish(item.id)}
                >
                  Publicar
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <dialog
        ref={dialogRef}
        className="rounded-lg border border-border bg-background p-6 shadow-lg backdrop:bg-black/50 w-full max-w-sm"
        onClose={closeDialog}
      >
        <h3 className="font-semibold text-sm mb-2">Rejeitar conteúdo?</h3>
        {confirmItem && (
          <p className="text-xs text-muted-foreground font-mono mb-4 line-clamp-3">
            {confirmItem.content.slice(0, 160)}{confirmItem.content.length > 160 ? '…' : ''}
          </p>
        )}
        <p className="text-xs text-muted-foreground mb-5">Esta ação é irreversível.</p>
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="outline" onClick={closeDialog}>
            Cancelar
          </Button>
          <Button size="sm" variant="destructive" onClick={confirmReject}>
            Rejeitar
          </Button>
        </div>
      </dialog>
    </>
  )
}
