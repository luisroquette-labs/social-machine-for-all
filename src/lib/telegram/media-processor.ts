/**
 * Telegram media processor — downloads and processes photos, voice, and documents.
 */

import { byokFetch, OPENROUTER_APP_HEADERS } from '@/lib/ai/provider'

export interface ProcessedMedia {
  type: 'image' | 'audio' | 'document'
  /** For images: base64 data. For audio/doc: extracted text. */
  data: string
  /** MIME type */
  mimeType: string
  /** Human-readable description of what was received */
  description: string
  /** Original filename if available */
  filename?: string
}

/**
 * Download a file from Telegram servers.
 */
async function downloadTelegramFile(botToken: string, fileId: string): Promise<{ buffer: Buffer; filePath: string }> {
  // Get file path
  const fileRes = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`)
  const fileData = await fileRes.json()
  if (!fileData.ok || !fileData.result?.file_path) {
    throw new Error(`Failed to get file path: ${JSON.stringify(fileData)}`)
  }
  const filePath = fileData.result.file_path as string

  // Download file
  const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`
  const res = await fetch(downloadUrl)
  if (!res.ok) throw new Error(`Failed to download file: ${res.status}`)

  const arrayBuffer = await res.arrayBuffer()
  return { buffer: Buffer.from(arrayBuffer), filePath }
}

/**
 * Process a photo from Telegram.
 * Returns base64-encoded image data for Claude Vision.
 */
export async function processPhoto(
  botToken: string,
  photos: Array<{ file_id: string; file_unique_id: string; width: number; height: number; file_size?: number }>
): Promise<ProcessedMedia> {
  // Pick the largest photo (last in array)
  const largest = photos[photos.length - 1]
  const { buffer, filePath } = await downloadTelegramFile(botToken, largest.file_id)

  const ext = filePath.split('.').pop()?.toLowerCase() ?? 'jpg'
  const mimeType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg'

  return {
    type: 'image',
    data: buffer.toString('base64'),
    mimeType,
    description: `Imagem ${largest.width}x${largest.height}`,
  }
}

/**
 * Process a voice message or audio file from Telegram.
 * Transcribes with OpenAI through OpenRouter BYOK.
 */
export async function processVoice(
  botToken: string,
  fileId: string,
  duration: number
): Promise<ProcessedMedia> {
  const { buffer, filePath } = await downloadTelegramFile(botToken, fileId)

  const ext = filePath.split('.').pop()?.toLowerCase() ?? 'ogg'
  const mimeType = ext === 'mp3' ? 'audio/mpeg' : ext === 'wav' ? 'audio/wav' : 'audio/ogg'

  const apiKey = process.env.OPENROUTER_API_KEY
  if (apiKey) {
    try {
      const model = 'openai/gpt-audio-mini'
      const res = await byokFetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...OPENROUTER_APP_HEADERS },
        body: JSON.stringify({
          model,
          provider: { only: ['openai'], allow_fallbacks: false, require_parameters: true },
          usage: { include: true },
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: 'Transcreva este áudio em português. Retorne somente a transcrição.' },
              { type: 'input_audio', input_audio: { data: buffer.toString('base64'), format: ext === 'oga' ? 'ogg' : ext } },
            ],
          }],
        }),
        signal: AbortSignal.timeout(90_000),
      })

      if (res.ok) {
        const data = await res.json() as { choices?: Array<{ message?: { content?: unknown } }> }
        const text = data.choices?.[0]?.message?.content
        if (typeof text === 'string' && text.trim()) {
          return {
            type: 'audio',
            data: text,
            mimeType,
            description: `Audio transcrito (${duration}s): "${text.slice(0, 100)}${text.length > 100 ? '...' : ''}"`,
          }
        }
      }
    } catch (err) {
      console.error('[media] Whisper transcription failed:', err)
    }
  }

  // Fallback: no transcription available
  return {
    type: 'audio',
    data: '',
    mimeType,
    description: `Audio recebido (${duration}s) — transcricao nao disponivel`,
  }
}

/**
 * Process a document from Telegram.
 * Extracts text from PDFs, passes through text files.
 */
export async function processDocument(
  botToken: string,
  document: { file_id: string; file_name?: string; mime_type?: string; file_size?: number }
): Promise<ProcessedMedia> {
  const { buffer, filePath } = await downloadTelegramFile(botToken, document.file_id)
  const filename = document.file_name ?? filePath.split('/').pop() ?? 'document'
  const mimeType = document.mime_type ?? 'application/octet-stream'

  // PDF extraction
  if (mimeType === 'application/pdf' || filename.endsWith('.pdf')) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pdfParse = require('pdf-parse') as (buf: Buffer) => Promise<{ text: string; numpages: number }>
      const parsed = await pdfParse(buffer)
      const text = parsed.text.slice(0, 5000) // Cap at 5000 chars
      return {
        type: 'document',
        data: text,
        mimeType: 'application/pdf',
        description: `PDF "${filename}" (${parsed.numpages} paginas, ${text.length} chars extraidos)`,
        filename,
      }
    } catch (err) {
      console.error('[media] PDF parse failed:', err)
      return {
        type: 'document',
        data: '',
        mimeType,
        description: `PDF "${filename}" — falha ao extrair texto`,
        filename,
      }
    }
  }

  // Text-based files
  if (mimeType.startsWith('text/') || ['.txt', '.csv', '.json', '.md', '.xml', '.html', '.yml', '.yaml', '.ts', '.js', '.py'].some(ext => filename.endsWith(ext))) {
    const text = buffer.toString('utf-8').slice(0, 5000)
    return {
      type: 'document',
      data: text,
      mimeType,
      description: `Arquivo "${filename}" (${text.length} chars)`,
      filename,
    }
  }

  // Images sent as documents (uncompressed)
  if (mimeType.startsWith('image/')) {
    return {
      type: 'image',
      data: buffer.toString('base64'),
      mimeType,
      description: `Imagem "${filename}"`,
      filename,
    }
  }

  // Unknown file type
  return {
    type: 'document',
    data: '',
    mimeType,
    description: `Arquivo "${filename}" (${mimeType}, ${document.file_size ?? 0} bytes) — tipo nao suportado para extracao`,
    filename,
  }
}
