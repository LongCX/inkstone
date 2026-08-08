const OPTIMIZE_MIN_BYTES = 1 * 1024 * 1024
const OPTIMIZE_MAX_BYTES = 2 * 1024 * 1024
const OPTIMIZE_MAX_DIMENSION = 2048
const JPEG_QUALITY = 0.82


export function imageNeedsOptimization(mime: string, size: number, width: number, height: number): boolean {
  if (!mime.startsWith('image/')) return false
  if (mime === 'image/gif' || mime === 'image/svg+xml') return false
  if (size <= OPTIMIZE_MIN_BYTES) return false
  if (size > OPTIMIZE_MAX_BYTES) return true
  return Math.max(width, height) > OPTIMIZE_MAX_DIMENSION
}


export async function optimizeImageFile(file: File): Promise<File> {
  let source: DecodedImageSource | null = null
  try {
    source = await decodeImageSource(file)
    if (!source) return file
    if (!imageNeedsOptimization(file.type, file.size, source.width, source.height)) return file
    const scale = Math.min(1, OPTIMIZE_MAX_DIMENSION / Math.max(source.width, source.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(source.width * scale))
    canvas.height = Math.max(1, Math.round(source.height * scale))
    const context = canvas.getContext('2d')
    if (!context) return file
    context.clearRect(0, 0, canvas.width, canvas.height)
    context.drawImage(source.bitmap, 0, 0, canvas.width, canvas.height)
    const keepPng = file.type === 'image/png'
    const blob = await canvasToBlob(canvas, keepPng ? 'image/png' : 'image/jpeg', keepPng ? undefined : JPEG_QUALITY)
    if (!blob || blob.size >= file.size) return file
    const extension = keepPng ? 'png' : 'jpg'
    const optimized = new File([blob], withExtension(file.name, extension), {
      type: keepPng ? 'image/png' : 'image/jpeg',
    })
    return optimized
  } catch {
    return file
  } finally {
    try {
      source?.bitmap.close()
    } catch {
    }
  }
}

interface DecodedImageSource {
  bitmap: ImageBitmap
  width: number
  height: number
}


async function decodeImageSource(file: File): Promise<DecodedImageSource | null> {
  if (typeof createImageBitmap !== 'function') return null
  try {
    const bitmap = await createImageBitmap(file)
    return { bitmap, width: bitmap.width, height: bitmap.height }
  } catch {
    return null
  }
}


function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), type, quality)
  })
}


function withExtension(name: string, extension: string): string {
  return /\.[A-Za-z0-9]+$/.test(name) ? name.replace(/\.[A-Za-z0-9]+$/, `.${extension}`) : `${name}.${extension}`
}
