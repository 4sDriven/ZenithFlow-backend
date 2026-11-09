import mammoth from 'mammoth'

export async function extractFileText(
  buffer: Buffer,
  fileName: string,
  mimeType: string,
): Promise<string> {
  const lower = fileName.toLowerCase()

  if (mimeType === 'application/pdf' || lower.endsWith('.pdf')) {
    const { PDFParse } = await import('pdf-parse')
    const parser = new PDFParse({ data: new Uint8Array(buffer) })
    try {
      const result = await parser.getText()
      return result.text
    } finally {
      await parser.destroy()
    }
  }

  if (lower.endsWith('.docx') || mimeType.includes('wordprocessingml')) {
    const result = await mammoth.extractRawText({ buffer })
    return result.value
  }

  if (
    lower.endsWith('.md') ||
    lower.endsWith('.markdown') ||
    lower.endsWith('.txt') ||
    lower.endsWith('.csv') ||
    mimeType.startsWith('text/')
  ) {
    return buffer.toString('utf8')
  }

  throw new Error('不支持的文件类型（支持 PDF / DOCX / MD / TXT / CSV）')
}
